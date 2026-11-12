import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { collectRecoveryEvidence, evidenceDigest, RecoveryCollectionError } from "../src/server/recovery/collect";
import type { HeldEvidence, ReadResult, RecoveryReader } from "../src/server/recovery/evidence";
import { inspectLedger } from "../src/server/recovery/inspect";
import { recoveryLedger } from "./support/recovery-ledger";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(version: 2 | 3 = 3) { const f = recoveryLedger(version); directories.push(f.directory); return f; }
const good = <T>(value: T): ReadResult<T> => ({ ok: true, value, response_sha256: "c".repeat(64) });

function reader() {
  const calls: string[] = [];
  const result: RecoveryReader = {
    origin: "https://platform.invalid", deployment: "fixture-deployment", sdk_version: "0.5.7",
    async payoutStatus(_, id) { calls.push(`payout:${id}`); return good({ request_id: id, state: "failed", status: "FAILED", correlation_id: "fixture-payment", never_executed: true }); },
    async paymentStatus(_, id) { calls.push(`payment:${id}`); return good({ status: "FAILED", approval_id: "fixture-approval", tx_hash: null, destination_tx_hash: null, refund_tx_hash: null, refunded_amount: null, request: null }); },
    async ownerStatus(_, id) { calls.push(`owner:${id}`); return good({ stage: "expired", phase: "expired", status: null }); },
    async held() { calls.push("held"); return good([]); },
  };
  return { reader: result, calls };
}

describe("one-job recovery collection — synthetic standalone snapshots and read-only fixtures", () => {
  for (const version of [2, 3] as const) test(`v${version} collects only original allowlisted identities without changing the snapshot`, async () => {
    const f = fixture(version), r = reader(), bytes = readFileSync(f.path), files = readdirSync(f.directory);
    const now = () => new Date("2026-11-11T12:00:00Z");
    const report = await collectRecoveryEvidence(f.inspection, f.binding, r.reader, { now });
    expect(r.calls).toEqual(["payout:fixture-request", "payment:fixture-payment", "owner:fixture-owner", "held"]);
    expect(report).toMatchObject({ clearance: "none", complete: true, snapshot: f.inspection.snapshot, binding: f.binding,
      binding_sha256: evidenceDigest(f.binding), sdk_version: "0.5.7", unmatched_held_count: 0, started_at: now().toISOString(), completed_at: now().toISOString() });
    expect(report.payouts[0]!.result).toMatchObject({ ok: true, value: { never_executed: true } });
    expect(report.owners[0]!.target_id).toBe("fixture-owner");
    expect(readFileSync(f.path)).toEqual(bytes);
    expect(readdirSync(f.directory)).toEqual(files);
  });

  for (const field of ["snapshot_sha256", "deployment", "contract_id", "terms_hash", "organization", "agent", "agent_id"] as const)
    test(`wrong ${field} makes zero external calls`, async () => {
      const f = fixture(), r = reader();
      const changed = { ...f.binding, [field]: field.includes("sha256") || field === "terms_hash" ? "d".repeat(64) : "wrong-binding" };
      await expect(collectRecoveryEvidence(f.inspection, changed, r.reader)).rejects.toBeInstanceOf(RecoveryCollectionError);
      expect(r.calls).toEqual([]);
    });

  for (const platform_origin of ["http://remote.invalid", "https://user:private@platform.invalid", "https://platform.invalid/path", "https://platform.invalid?private=value", "https://platform.invalid#private", "file:///tmp/private"])
    test(`unsupported origin ${platform_origin} makes zero external calls`, async () => {
      const f = fixture(), r = reader();
      await expect(collectRecoveryEvidence(f.inspection, { ...f.binding, platform_origin }, r.reader)).rejects.toBeInstanceOf(RecoveryCollectionError);
      expect(r.calls).toEqual([]);
    });

  test("missing provenance and extra binding fields are rejected without reads or private diagnostics", async () => {
    const f = fixture(), r = reader();
    const { provenance_sha256: _, ...missing } = f.binding;
    for (const input of [missing, { ...f.binding, credential: "PRIVATE-CREDENTIAL" }]) {
      try { await collectRecoveryEvidence(f.inspection, input, r.reader); throw new Error("expected rejection"); }
      catch (error) { expect(error).toBeInstanceOf(RecoveryCollectionError); expect(String(error)).not.toContain("PRIVATE-CREDENTIAL"); }
    }
    expect(r.calls).toEqual([]);
  });

  for (const mode of ["unsafe-id", "duplicate-correlation", "malformed-record", "wrong-reader", "unknown-version"] as const)
    test(`${mode} cannot make an outbound request`, async () => {
      const f = fixture(), r = reader(), inspection = structuredClone(f.inspection);
      if (mode === "unsafe-id") inspection.attempts[0]!.request_id = "../private";
      if (mode === "duplicate-correlation") inspection.attempts.push({ ...inspection.attempts[0]!, request_id: "replacement" });
      if (mode === "malformed-record") inspection.findings.push({ code: "invalid_record", contract_id: f.binding.contract_id, message: "fixture" });
      if (mode === "wrong-reader") Object.assign(r.reader, { origin: "https://wrong.invalid" });
      if (mode === "unknown-version") inspection.jobs[0]!.terms_version = 4;
      await expect(collectRecoveryEvidence(inspection, f.binding, r.reader)).rejects.toBeInstanceOf(RecoveryCollectionError);
      expect(r.calls).toEqual([]);
    });

  test("all retained same-job replacement attempts are observed; unrelated held records are never exposed or adopted", async () => {
    const f = fixture(), r = reader();
    const db = new Database(f.path);
    db.exec(`INSERT INTO payout_attempts SELECT 'replacement-request',kind,contract_id,seq,2,run_id,recipient,amount_atomic,'unknown',NULL,
      'replacement-payment','replacement-approval',NULL,0,NULL,NULL,NULL,NULL FROM payout_attempts;
      INSERT INTO payout_lines VALUES('replacement-request','d1','300000000');`);
    db.close();
    const inspection = inspectLedger(f.path), binding = { ...f.binding, snapshot_sha256: inspection.snapshot.sha256 };
    r.reader.held = async () => { r.calls.push("held"); return good([
      { correlation_id: "fixture-payment", approval_id: "fixture-approval", request: null },
      { correlation_id: "PRIVATE-UNRELATED-PAYMENT", approval_id: "PRIVATE-UNRELATED-APPROVAL", request: null },
    ]); };
    const report = await collectRecoveryEvidence(inspection, binding, r.reader);
    expect(r.calls).toEqual(["payout:fixture-request", "payout:replacement-request", "payment:fixture-payment", "payment:replacement-payment", "owner:fixture-owner", "held"]);
    expect(report.unmatched_held_count).toBe(1);
    expect(report.held.result).toEqual(good([{ correlation_id: "fixture-payment", approval_id: "fixture-approval", request: null }]));
    expect(JSON.stringify(report)).not.toContain("PRIVATE-UNRELATED");
  });

  for (const foreign of ["request", "correlation"] as const) test(`a foreign ${foreign} is retained as a contradiction and never followed`, async () => {
    const f = fixture(), r = reader();
    r.reader.payoutStatus = async () => { r.calls.push("payout:fixture-request"); return good({ request_id: foreign === "request" ? "foreign-request" : "fixture-request", state: "failed", status: "FAILED", correlation_id: "foreign-payment", never_executed: true }); };
    const report = await collectRecoveryEvidence(f.inspection, f.binding, r.reader);
    expect(report.payouts[0]!.result).toMatchObject({ ok: true, value: { correlation_id: "foreign-payment" } });
    expect(r.calls).toContain("payment:fixture-payment");
    expect(r.calls).not.toContain("payment:foreign-payment");
  });

  test("a missing stored correlation can be observed only from its original echoed request, never by amount matching", async () => {
    const f = fixture(), r = reader(), inspection = structuredClone(f.inspection);
    inspection.attempts[0]!.payout_correlation_id = null;
    const report = await collectRecoveryEvidence(inspection, f.binding, r.reader);
    expect(report.payments.map(item => item.target_id)).toEqual(["fixture-payment"]);
    expect(report.clearance).toBe("none");
  });

  test("missing proof remains unknown and failed reads never leak SDK details", async () => {
    const f = fixture(), r = reader();
    r.reader.payoutStatus = async () => good({ request_id: "fixture-request", state: "failed", status: "FAILED", correlation_id: "fixture-payment", never_executed: null });
    r.reader.paymentStatus = async () => { throw new Error("PRIVATE-AUTH PRIVATE-REPORT PRIVATE-CONFIRM-URL"); };
    const report = await collectRecoveryEvidence(f.inspection, f.binding, r.reader);
    expect(report.complete).toBe(false);
    expect(report.payouts[0]!.result).toMatchObject({ ok: true, value: { never_executed: null } });
    expect(report.payments[0]!.result).toEqual({ ok: false, kind: "unavailable", response_sha256: null });
    expect(JSON.stringify(report)).not.toContain("PRIVATE-");
  });

  test("unexpected private projection fields are discarded as invalid evidence", async () => {
    const f = fixture(), r = reader();
    r.reader.held = async () => good([{ correlation_id: "fixture-payment", approval_id: "fixture-approval", request: null, confirmation_url: "PRIVATE-CONFIRMATION" }]) as unknown as ReadResult<HeldEvidence[]>;
    const report = await collectRecoveryEvidence(f.inspection, f.binding, r.reader);
    expect(report.held.result).toMatchObject({ ok: false, kind: "invalid_response" });
    expect(JSON.stringify(report)).not.toContain("PRIVATE-CONFIRMATION");
  });

  test("a hung read is bounded and remaining work becomes explicitly incomplete", async () => {
    const f = fixture(), r = reader(), start = performance.now();
    r.reader.payoutStatus = async () => { r.calls.push("hung-original-read"); return new Promise(() => {}); };
    const report = await collectRecoveryEvidence(f.inspection, f.binding, r.reader, { maxDurationMs: 50, readTimeoutMs: 50 });
    expect(performance.now() - start).toBeLessThan(1000);
    expect(report.complete).toBe(false);
    expect(report.payouts[0]!.result).toMatchObject({ ok: false, kind: "timeout" });
    expect(report.payments[0]!.result).toMatchObject({ ok: false, kind: "collection_budget" });
    expect(r.calls).toEqual(["hung-original-read"]);
  });
});
