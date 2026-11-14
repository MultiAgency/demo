import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRuntime, type Runtime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { openDb } from "../src/server/db";
import { evidenceDigest } from "../src/server/recovery/collect";
import { restoreCommitment, RestorationError } from "../src/server/recovery/restore";
import { isCommitted, isOpen, isPaid } from "../src/server/payouts";
import { START } from "./support/harness";
import {
  addRestorationConflictConstraint, changeRestorationEvidence, closeRestorationRuntime, RESTORATION_NOW, restorationEvidence,
  restorationLedger, restorationRows, seedUnrelatedRestorationJob, type RestorationFixture,
} from "./support/restoration-ledger";

const fixtures: RestorationFixture[] = [], runtimes = new Set<Runtime>();
afterEach(async () => {
  for (const rt of runtimes) await closeRestorationRuntime(rt);
  runtimes.clear();
  for (const f of fixtures.splice(0)) rmSync(f.directory, { recursive: true, force: true });
});
async function fixture(version: 2 | 3 = 3, options: { partial?: boolean } = {}) {
  const f = await restorationLedger(version, options); fixtures.push(f); return f;
}
const now = () => RESTORATION_NOW;
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
type Input = Parameters<typeof restoreCommitment>[1];
function apply(f: RestorationFixture, input: Input = f.input) { return restoreCommitment(f.path, input, { now }); }
function output(f: RestorationFixture, bytes: Uint8Array, name = "corrected.sqlite") {
  const path = join(f.directory, name); writeFileSync(path, bytes); return path;
}
function refusal(f: RestorationFixture, input: Input = f.input, codes?: string[]) {
  const bytes = readFileSync(f.path), files = readdirSync(f.directory).sort(), rows = restorationRows(f.path);
  let failure: unknown, result: unknown;
  try { result = apply(f, input); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(RestorationError);
  expect(result).toBeUndefined();
  if (codes) expect(codes).toContain((failure as RestorationError).code);
  expect(readFileSync(f.path)).toEqual(bytes);
  expect(readdirSync(f.directory).sort()).toEqual(files);
  expect(restorationRows(f.path)).toEqual(rows);
  expect(String(failure)).not.toContain("PRIVATE-");
}
async function mutate(f: RestorationFixture, change: (db: Database) => void) {
  const db = new Database(f.path, { strict: true });
  try { change(db); } finally { db.close(true); }
  const fresh = await restorationEvidence(f.path, f.ctx.id);
  f.inspection = fresh.inspection; f.input = fresh.input;
}
function insertRow(db: Database, table: "payout_attempts" | "judgments" | "contracts", row: Record<string, unknown>) {
  const columns = Object.keys(row);
  db.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .run(...Object.values(row) as (string | number | null)[]);
}
async function reopen(f: RestorationFixture, path: string) {
  const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules", DB_PATH: path }),
    { clockStart: START, kit: f.ctx.rt.kit });
  runtimes.add(rt); return rt;
}

describe("restoration-only correction on signed disposable app ledgers", () => {
  for (const { table, column, policy } of [
    { table: "events", column: "kind", policy: "REPLACE" },
    { table: "events", column: "kind", policy: "IGNORE" },
    { table: "payout_attempts", column: "resolution", policy: "REPLACE" },
    { table: "judgments", column: "outcome", policy: "REPLACE" },
    { table: "job_submissions", column: "state", policy: "REPLACE" },
  ] as const) test(`${table} ${policy} cannot delete or skip unrelated history during a correction`, async () => {
    const f = await fixture();
    await mutate(f, db => {
      // Make this synthetic event constraint independent of repeated ordinary workflow event kinds.
      if (table === "events") db.exec("UPDATE events SET kind = 'fixture_history_' || id");
      seedUnrelatedRestorationJob(db, f);
      addRestorationConflictConstraint(db, table, column, policy);
    });
    const before = restorationRows(f.path);
    expect(before.contracts).toHaveLength(2);
    expect(before.payout_attempts!.filter(row => row.contract_id === f.ctx.id)).toHaveLength(1);
    expect(before.judgments!.filter(row => row.contract_id === f.ctx.id)).toHaveLength(1);
    expect(before.job_submissions!.filter(row => row.contract_id === f.ctx.id)).toHaveLength(1);
    expect(f.inspection.findings.filter(row => row.code === "invalid_record")).toEqual([]);
    refusal(f, f.input, ["unsupported_case"]);
    expect(restorationRows(f.path)).not.toHaveProperty("recovery_corrections");
    expect(f.ctx.stub.calls.requestPayout).toBe(1);
    expect(f.ctx.stub.transfers).toHaveLength(0);
  });

  for (const version of [2, 3] as const) test(`v${version}: a nonconflicting REPLACE event constraint preserves unrelated rows and exact replay`, async () => {
    const f = await fixture(version);
    await mutate(f, db => {
      db.exec("UPDATE events SET kind = 'fixture_history_' || id");
      seedUnrelatedRestorationJob(db, f, "fixture_unrelated_history");
      addRestorationConflictConstraint(db, "events", "kind", "REPLACE");
    });
    const beforeBytes = readFileSync(f.path), beforeFiles = readdirSync(f.directory).sort(), before = restorationRows(f.path);
    const result = apply(f);
    expect(readFileSync(f.path)).toEqual(beforeBytes);
    expect(readdirSync(f.directory).sort()).toEqual(beforeFiles);
    const path = output(f, result.snapshot_bytes), after = restorationRows(path);
    expect(after.payout_attempts).toEqual(before.payout_attempts!.map(row => row.request_id === f.requestId ? { ...row, resolution: "disputed" } : row));
    expect(after.judgments).toEqual(before.judgments!.map(row => row.id === f.judgmentId ? { ...row, outcome: "disputed", closed_at: RESTORATION_NOW.toISOString() } : row));
    expect(after.job_submissions).toEqual(before.job_submissions!.map(row => row.id === f.submissionId ? { ...row, state: "disputed" } : row));
    for (const table of Object.keys(before).filter(name => !["payout_attempts", "judgments", "job_submissions", "events"].includes(name)))
      expect(after[table]).toEqual(before[table]);
    expect(after.events!.slice(0, before.events!.length)).toEqual(before.events!);
    expect(after.events).toHaveLength(before.events!.length + 1);
    expect(after.events!.filter(row => row.kind === "recovery_correction")).toHaveLength(1);
    expect(after.recovery_corrections).toHaveLength(1);
    const replay = restoreCommitment(path, f.input, { now: () => new Date(RESTORATION_NOW.getTime() + 3_600_000) });
    expect(replay.receipt).toMatchObject({ result: "already_applied", clearance: "none" });
    expect(replay.snapshot_bytes).toEqual(result.snapshot_bytes);
    expect(readFileSync(path)).toEqual(Buffer.from(result.snapshot_bytes));
    expect(f.ctx.stub.calls.requestPayout).toBe(1);
    expect(f.ctx.stub.transfers).toHaveLength(0);
  });

  for (const version of [2, 3] as const) {
    test(`v${version}: original commitment and dispute are restored atomically without altering the source or fabricating evidence`, async () => {
      const f = await fixture(version), beforeBytes = readFileSync(f.path), before = restorationRows(f.path), sourceFiles = readdirSync(f.directory).sort();
      expect(() => openDb(f.path)).toThrow(/non-execution proof/);
      expect(readFileSync(f.path)).toEqual(beforeBytes);
      const result = apply(f), afterPath = output(f, result.snapshot_bytes), after = restorationRows(afterPath);
      const at = RESTORATION_NOW.toISOString();
      expect(result.receipt).toMatchObject({ result: "applied", clearance: "none", correction_id: f.input.correction_id, request_id: f.requestId,
        source_snapshot_sha256: sha(beforeBytes), output_snapshot_sha256: sha(result.snapshot_bytes), binding_sha256: evidenceDigest(f.input.binding),
        collection_sha256: f.input.collection_sha256, committed_before_atomic: "0", committed_after_atomic: "300000000",
        paid_before_atomic: "0", paid_after_atomic: "0", applied_at: at });
      expect(after.payout_attempts).toEqual([{ ...before.payout_attempts![0], resolution: "disputed" }]);
      expect(after.judgments).toEqual([{ ...before.judgments![0], outcome: "disputed", closed_at: at }]);
      expect(after.job_submissions).toEqual(version === 3 ? [{ ...before.job_submissions![0], state: "disputed" }] : []);
      for (const table of Object.keys(before).filter(name => !["payout_attempts", "judgments", "job_submissions", "events"].includes(name)))
        expect(after[table]).toEqual(before[table]);
      expect(after.events!.slice(0, before.events!.length)).toEqual(before.events!);
      expect(after.events!.filter(event => event.kind === "recovery_correction")).toHaveLength(1);
      expect(after.events).toHaveLength(before.events!.length + 1);
      expect(after.recovery_corrections).toHaveLength(1);
      expect(after.recovery_corrections![0]).toMatchObject({ correction_id: f.input.correction_id, operation: "restore_commitment_v1", request_id: f.requestId });
      expect(JSON.stringify(after.recovery_corrections)).toContain("reowe");
      expect(JSON.stringify(after.recovery_corrections)).toContain("disputed");
      const receiptText = JSON.stringify(result.receipt);
      for (const field of ["terms", "rep_sig", "contractor_sig", "contractor_link_hash"]) expect(receiptText).not.toContain(String(before.contracts![0]![field]));
      expect(receiptText).not.toContain("PRIVATE-");
      expect(readFileSync(f.path)).toEqual(beforeBytes);
      expect(readdirSync(f.directory).sort()).toEqual([...sourceFiles, "corrected.sqlite"].sort());
      expect(f.ctx.stub.calls.requestPayout).toBe(1);
      expect(f.ctx.stub.transfers).toHaveLength(0);
    });

    test(`v${version}: exact audited replay returns the same bytes and cannot add a correction or event`, async () => {
      const f = await fixture(version), first = apply(f), path = output(f, first.snapshot_bytes), before = readFileSync(path);
      const replay = restoreCommitment(path, f.input, { now });
      expect(replay.receipt).toMatchObject({ result: "already_applied", clearance: "none", correction_id: f.input.correction_id,
        committed_before_atomic: "0", committed_after_atomic: "300000000", paid_before_atomic: "0", paid_after_atomic: "0", applied_at: first.receipt.applied_at });
      expect(replay.snapshot_bytes).toEqual(first.snapshot_bytes);
      expect(readFileSync(path)).toEqual(before);
      expect(restorationRows(path).recovery_corrections).toHaveLength(1);
      expect(restorationRows(path).events!.filter(event => event.kind === "recovery_correction")).toHaveLength(1);
      const lateReplay = restoreCommitment(path, f.input, { now: () => new Date(RESTORATION_NOW.getTime() + 3_600_000) });
      expect(lateReplay.receipt).toMatchObject({ result: "already_applied", applied_at: first.receipt.applied_at, clearance: "none" });
      expect(lateReplay.snapshot_bytes).toEqual(first.snapshot_bytes);
    });

    test(`v${version}: reopened corrected state holds unknown outcomes and positive proof, then settles only the original identity`, async () => {
      const f = await fixture(version), corrected = apply(f), rt = await reopen(f, output(f, corrected.snapshot_bytes));
      const original = rt.engine.attempt(f.requestId), old = f.ctx.stub.payouts.get(f.requestId)!;
      expect(isCommitted(original)).toBe(true); expect(isOpen(original)).toBe(true); expect(isPaid(original)).toBe(false);
      Object.assign(old, { state: "unknown", status: "UNKNOWN" });
      const uncertain = await rt.engine.getContract(f.ctx.id);
      expect(uncertain.committed_usd).toBe("300"); expect(uncertain.paid_usd).toBe("0");
      expect(uncertain.payouts).toHaveLength(1);
      Object.assign(old, { state: "failed", status: "FAILED", failureCode: "rejected_by_owner" });
      const proved = await rt.engine.getContract(f.ctx.id);
      expect(proved.payouts[0]).toMatchObject({ request_id: f.requestId, state: "disputed", resolution: "disputed", never_executed: true });
      expect(proved.committed_usd).toBe("300"); expect(proved.paid_usd).toBe("0");
      Object.assign(old, { state: "processing", status: "PROCESSING", failureCode: null });
      f.ctx.stub.settle(original.correlation_id!);
      const settled = await rt.engine.getContract(f.ctx.id);
      expect(settled.payouts).toHaveLength(1);
      expect(settled.payouts[0]).toMatchObject({ request_id: f.requestId, state: "paid", payment_correlation_id: original.correlation_id });
      expect(settled.paid_usd).toBe("300");
      expect(f.ctx.stub.calls.requestPayout).toBe(1); expect(f.ctx.stub.transfers).toHaveLength(1);
      if (version === 3) expect(settled.submissions[0]).toMatchObject({ id: f.submissionId, judgment_id: f.judgmentId, state: "settled" });
    });
  }

  test("a corrected partial v3 proposal stays disputed after late partial settlement without requesting its remainder", async () => {
    const f = await fixture(3, { partial: true }), corrected = apply(f);
    expect(corrected.receipt.committed_after_atomic).toBe("150000000");
    const rt = await reopen(f, output(f, corrected.snapshot_bytes)), original = rt.engine.attempt(f.requestId), old = f.ctx.stub.payouts.get(f.requestId)!;
    Object.assign(old, { state: "processing", status: "PROCESSING", failureCode: null });
    f.ctx.stub.settle(original.correlation_id!);
    const view = await rt.engine.getContract(f.ctx.id);
    expect(view.submissions[0]).toMatchObject({ id: f.submissionId, state: "disputed", proposed_usd: "300", paid_usd: "150" });
    expect(view.open_judgment).toBeNull(); expect(view.payouts).toHaveLength(1);
    expect(f.ctx.stub.calls.requestPayout).toBe(1); expect(f.ctx.stub.transfers).toHaveLength(1);
  });

  test("the five-minute initial freshness boundary is accepted without creating a later proof claim", async () => {
    const f = await fixture();
    const result = restoreCommitment(f.path, f.input, { now: () => new Date(RESTORATION_NOW.getTime() + 300_000) });
    expect(result.receipt.result).toBe("applied");
    expect(result.receipt.clearance).toBe("none");
    expect(result.receipt.applied_at).toBe(new Date(RESTORATION_NOW.getTime() + 300_000).toISOString());
    expect(restorationRows(output(f, result.snapshot_bytes)).payout_attempts![0]!.never_executed).toBe(0);
  });

  test("correction audit rejects update/delete tampering and remains replayable", async () => {
    const f = await fixture(), result = apply(f), path = output(f, result.snapshot_bytes), before = restorationRows(path);
    const db = new Database(path, { strict: true });
    try {
      expect(() => db.exec("UPDATE recovery_corrections SET operation = 'tampered'")).toThrow(/append-only correction/);
      expect(() => db.exec("DELETE FROM recovery_corrections")).toThrow(/append-only correction/);
    } finally { db.close(true); }
    expect(restorationRows(path)).toEqual(before);
    expect(restoreCommitment(path, f.input, { now }).receipt.result).toBe("already_applied");
  });

  for (const field of ["tx_hash", "destination_tx_hash", "refund_tx_hash", "refunded_amount"] as const)
    test(`new observed ${field} cannot be ignored while restoring a legacy release`, async () => {
      const f = await fixture();
      const input = changeRestorationEvidence(f.input, collection => {
        const result = collection.payments[0]!.result;
        if (!result.ok) throw new Error("Fixture payment unavailable");
        result.value[field] = field === "refunded_amount" ? "0" : "new-observed-evidence";
      });
      refusal(f, input, ["invalid_evidence", "unsupported_case"]);
    });

  test("stored request_conflict blocks collection and rejects even a rebound advisory", async () => {
    const f = await fixture(), db = new Database(f.path, { strict: true });
    try { db.query("UPDATE payout_attempts SET code = 'request_conflict' WHERE request_id = ?").run(f.requestId); }
    finally { db.close(true); }
    await expect(restorationEvidence(f.path)).rejects.toMatchObject({ code: "unsupported_ledger" });
    // A caller cannot bypass the stored conflict by simply rebinding earlier observations to the new byte digest.
    const bytes = readFileSync(f.path), input = structuredClone(f.input);
    input.binding.snapshot_sha256 = sha(bytes);
    input.collection.binding = structuredClone(input.binding);
    input.collection.binding_sha256 = evidenceDigest(input.binding);
    input.collection.snapshot = { sha256: sha(bytes), bytes: bytes.length };
    input.collection_sha256 = evidenceDigest(input.collection);
    refusal(f, input, ["invalid_evidence", "unsupported_case"]);
  });

  for (const version of [2, 3] as const) for (const retained of ["", '{"state":"failed","correlation_id":"PRIVATE-other-terms-payment"}'])
    test(`v${version}: retained conflict ${retained ? "record" : "empty record"} cannot be ignored when code is null`, async () => {
      const f = await fixture(version);
      await mutate(f, db => db.query("UPDATE payout_attempts SET code = NULL, platform_record = ? WHERE request_id = ?").run(retained, f.requestId));
      expect(restorationRows(f.path).payout_attempts![0]).toMatchObject({ code: null, platform_record: retained });
      refusal(f, f.input, ["unsupported_case", "invalid_evidence"]);
    });

  test("stored transaction/refund evidence survives restoration, proof observations and database reopen", async () => {
    const f = await fixture();
    await mutate(f, db => db.query("UPDATE payout_attempts SET tx_hash = ?, refund_tx_hash = ?, refunded_amount = ? WHERE request_id = ?")
      .run("retained-original-tx", "retained-original-refund", "300000000", f.requestId));
    const corrected = apply(f), path = output(f, corrected.snapshot_bytes);
    expect(restorationRows(path).payout_attempts![0]).toMatchObject({ tx_hash: "retained-original-tx", refund_tx_hash: "retained-original-refund", refunded_amount: "300000000", never_executed: 0 });
    const rt = await reopen(f, path), old = f.ctx.stub.payouts.get(f.requestId)!;
    Object.assign(old, { state: "failed", status: "FAILED", failureCode: "rejected_by_owner", txHash: null, refundTxHash: null, refundedAmount: null });
    await rt.engine.getContract(f.ctx.id);
    expect(rt.engine.attempt(f.requestId)).toMatchObject({ resolution: "disputed", tx_hash: "retained-original-tx", refund_tx_hash: "retained-original-refund", refunded_amount: "300000000", never_executed: 0 });
    for (const resolution of ["reowe", "rejected"] as const) await expect(rt.engine.resolve(f.requestId, resolution)).rejects.toThrow(/remains committed/);
    expect(f.ctx.stub.calls.requestPayout).toBe(1);
  });

  for (const mode of ["stale", "future", "wrong snapshot", "wrong binding", "wrong evidence digest", "success"] as const)
    test(`${mode} input refuses without output or any source write`, async () => {
      const f = await fixture();
      const input = structuredClone(f.input);
      if (mode === "stale" || mode === "future") {
        const stamp = new Date(RESTORATION_NOW.getTime() + (mode === "stale" ? -300_001 : 1)).toISOString();
        input.collection.started_at = stamp; input.collection.completed_at = stamp;
        for (const row of [...input.collection.payouts, ...input.collection.payments, ...input.collection.owners, input.collection.held]) row.started_at = row.completed_at = stamp;
      }
      if (mode === "wrong snapshot") input.binding.snapshot_sha256 = "f".repeat(64);
      if (mode === "wrong binding") input.binding.agent_id = "PRIVATE-WRONG-BINDING";
      if (mode === "success") {
        const payout = input.collection.payouts[0]!.result;
        if (payout.ok) Object.assign(payout.value, { state: "succeeded", status: "SUCCESS", never_executed: false });
      }
      input.collection_sha256 = mode === "wrong evidence digest" ? "f".repeat(64) : evidenceDigest(input.collection);
      refusal(f, input);
    });

  for (const mode of ["rejected judgment", "proved release", "invalid recipient", "invalid terms", "invalid signature", "changed signing recipient", "invalid submission", "invalid allocations", "replacement", "extra judgment", "unsupported index", "case-folded index literal", "trimmed index literal", "missing required column", "related-write trigger"] as const)
    test(`${mode} is outside the first correction contract and leaves every source record unchanged`, async () => {
      const f = await fixture();
      await mutate(f, db => {
        if (mode === "rejected judgment") db.query("UPDATE judgments SET outcome = 'rejected', closed_at = ? WHERE id = ?").run(RESTORATION_NOW.toISOString(), f.judgmentId);
        if (mode === "proved release") db.query("UPDATE payout_attempts SET never_executed = 1 WHERE request_id = ?").run(f.requestId);
        if (mode === "invalid recipient") db.query("UPDATE payout_attempts SET recipient = 'wrong-recipient.demo' WHERE request_id = ?").run(f.requestId);
        if (mode === "invalid terms") db.query("UPDATE contracts SET hash = ? WHERE id = ?").run("f".repeat(64), f.ctx.id);
        if (mode === "invalid signature") {
          const contract = db.query("SELECT rep_sig FROM contracts WHERE id = ?").get(f.ctx.id) as { rep_sig: string };
          const signature = JSON.parse(contract.rep_sig);
          signature.signature = Buffer.alloc(64, 3).toString("base64");
          db.query("UPDATE contracts SET rep_sig = ? WHERE id = ?").run(JSON.stringify(signature), f.ctx.id);
        }
        if (mode === "changed signing recipient") db.query("UPDATE contracts SET signing_recipient = 'covenant' WHERE id = ?").run(f.ctx.id);
        if (mode === "invalid submission") db.query("UPDATE job_submissions SET report = 'PRIVATE-altered-immutable-report' WHERE id = ?").run(f.submissionId!);
        if (mode === "invalid allocations") db.query("UPDATE payout_lines SET deliverable_id = 'not-in-signed-scope' WHERE request_id = ?").run(f.requestId);
        if (mode === "replacement") {
          const row = db.query("SELECT * FROM payout_attempts WHERE request_id = ?").get(f.requestId) as Record<string, unknown>;
          insertRow(db, "payout_attempts", { ...row, request_id: `${f.requestId}-replacement`, attempt: 2, correlation_id: "different-original-payment", approval_id: "different-approval", vote_correlation_id: null });
          db.query("INSERT INTO payout_lines SELECT ?, deliverable_id, amount_atomic FROM payout_lines WHERE request_id = ?").run(`${f.requestId}-replacement`, f.requestId);
        }
        if (mode === "extra judgment") {
          const row = db.query("SELECT * FROM judgments WHERE id = ?").get(f.judgmentId) as Record<string, unknown>;
          insertRow(db, "judgments", { ...row, id: "other-historical-judgment", outcome: "approved", closed_at: RESTORATION_NOW.toISOString() });
        }
        if (mode === "unsupported index") db.exec("DROP INDEX one_open_payout");
        if (mode === "case-folded index literal" || mode === "trimmed index literal") {
          const { sql } = db.query("SELECT sql FROM sqlite_schema WHERE name = 'one_open_payout'").get() as { sql: string };
          db.exec("DROP INDEX one_open_payout");
          db.exec(mode === "case-folded index literal" ? sql.replace("'payout'", "'PAYOUT'") : sql.replace("'disputed'", "'disputed '"));
        }
        if (mode === "missing required column") db.exec("ALTER TABLE payout_attempts DROP COLUMN refunded_amount");
        if (mode === "related-write trigger") db.exec("CREATE TRIGGER fixture_related_write_failure BEFORE UPDATE OF state ON job_submissions WHEN NEW.state = 'disputed' BEGIN SELECT RAISE(ABORT,'PRIVATE-related-write-fault'); END");
      });
      refusal(f);
    });

  test("reusing a correction ID or editing any corrected context cannot silently apply a second correction", async () => {
    const f = await fixture(), first = apply(f), path = output(f, first.snapshot_bytes), originalPath = f.path;
    f.path = path;
    const differentInput = { ...f.input, request_id: "different-request" };
    refusal(f, differentInput, ["correction_conflict", "divergent_state"]);
    const db = new Database(path, { strict: true });
    db.query("UPDATE contracts SET created_at = '2026-11-19T00:00:00.000Z' WHERE id = ?").run(f.ctx.id);
    db.close(true);
    refusal(f, f.input, ["divergent_state"]);
    f.path = originalPath;
  });

  test("replay refuses an owner-step rowid-only change even when every exposed column is identical", async () => {
    const f = await fixture(), result = apply(f), path = output(f, result.snapshot_bytes);
    const db = new Database(path, { strict: true });
    try {
      const rows = db.query("SELECT * FROM owner_steps ORDER BY correlation_id").all();
      const first = db.query("SELECT correlation_id FROM owner_steps ORDER BY rowid LIMIT 1").get() as { correlation_id: string };
      db.query("UPDATE owner_steps SET rowid = rowid + 10000 WHERE correlation_id = ?").run(first.correlation_id);
      expect(db.query("SELECT * FROM owner_steps ORDER BY correlation_id").all()).toEqual(rows);
    } finally { db.close(true); }
    f.path = path;
    refusal(f, f.input, ["divergent_state"]);
  });

  test("the same event columns and records without an INTEGER PRIMARY KEY cannot produce an unlinked correction audit", async () => {
    const f = await fixture(), events = restorationRows(f.path).events;
    await mutate(f, db => db.exec(`
      CREATE TABLE fixture_events (id INTEGER, contract_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
      INSERT INTO fixture_events SELECT id, contract_id, at, kind, text FROM events;
      DROP TABLE events;
      ALTER TABLE fixture_events RENAME TO events;
    `));
    expect(restorationRows(f.path).events).toEqual(events!);
    refusal(f, f.input, ["unsupported_schema"]);
  });

  test("event identity exhaustion after target updates cannot publish a partial correction", async () => {
    const f = await fixture();
    await mutate(f, db => db.query(`INSERT INTO events (id, contract_id, at, kind, text)
      VALUES (9223372036854775807, ?, ?, 'fixture_history', 'Retained maximum original event identity')`)
      .run(f.ctx.id, RESTORATION_NOW.toISOString()));
    // The supported AUTOINCREMENT schema cannot allocate another identity. This fails the actual event write,
    // after the in-memory payout/judgment/submission updates, without adding a production fault-injection option.
    refusal(f, f.input, ["unsupported_case"]);
    expect(restorationRows(f.path).payout_attempts![0]!.resolution).toBe("reowe");
    expect(restorationRows(f.path)).not.toHaveProperty("recovery_corrections");
  });

  for (const eventCount of [9999, 10000] as const) test(`a source with ${eventCount} events cannot emit an unreplayable correction`, async () => {
    const f = await fixture();
    await mutate(f, db => {
      const count = (db.query("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count;
      db.query(`WITH RECURSIVE additions(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM additions WHERE n < ?)
        INSERT INTO events (contract_id, at, kind, text) SELECT ?, ?, 'fixture_history', 'Retained original fixture event' FROM additions`)
        .run(eventCount - count, f.ctx.id, RESTORATION_NOW.toISOString());
    });
    expect(restorationRows(f.path).events).toHaveLength(eventCount);
    if (eventCount === 10000) refusal(f, f.input, ["unsupported_schema"]);
    else {
      const result = apply(f), path = output(f, result.snapshot_bytes);
      expect(restorationRows(path).events).toHaveLength(10000);
      const replay = restoreCommitment(path, f.input, { now });
      expect(replay.receipt.result).toBe("already_applied");
      expect(replay.snapshot_bytes).toEqual(result.snapshot_bytes);
    }
  });

  test("one correction does not clear an unrelated unsafe historical job for application startup", async () => {
    const f = await fixture();
    await mutate(f, db => {
      const contract = db.query("SELECT * FROM contracts WHERE id = ?").get(f.ctx.id) as Record<string, unknown>;
      insertRow(db, "contracts", { ...contract, id: "unrelated-unsafe-job", hash: "c".repeat(64), organization: "unrelated-organization" });
      const judgment = db.query("SELECT * FROM judgments WHERE id = ?").get(f.judgmentId) as Record<string, unknown>;
      insertRow(db, "judgments", { ...judgment, id: "unrelated-unsafe-judgment", contract_id: "unrelated-unsafe-job" });
      const attempt = db.query("SELECT * FROM payout_attempts WHERE request_id = ?").get(f.requestId) as Record<string, unknown>;
      insertRow(db, "payout_attempts", { ...attempt, request_id: "unrelated-unsafe-request", contract_id: "unrelated-unsafe-job", run_id: "unrelated-unsafe-judgment",
        correlation_id: null, approval_id: null, vote_correlation_id: null });
      db.query("INSERT INTO payout_lines SELECT 'unrelated-unsafe-request', deliverable_id, amount_atomic FROM payout_lines WHERE request_id = ?").run(f.requestId);
    });
    const result = apply(f), path = output(f, result.snapshot_bytes);
    expect(result.receipt.clearance).toBe("none");
    expect(() => openDb(path)).toThrow(/unrelated-unsafe-request/);
    expect(restorationRows(path).payout_attempts!.find(row => row.request_id === "unrelated-unsafe-request")).toMatchObject({ state: "failed", resolution: "reowe", never_executed: 0 });
  });
});
