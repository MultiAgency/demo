import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRuntime, type Runtime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { exportRestorationBundle } from "../src/server/recovery/export";
import { isCommitted, isOpen, isPaid } from "../src/server/payouts";
import { scopeTotal } from "../src/shared/terms";
import { START } from "./support/harness";
import {
  closeRestorationRuntime, RESTORATION_NOW, restorationEvidence, restorationLedger, restorationRows, type RestorationFixture,
} from "./support/restoration-ledger";

// In-process stand-in rehearsal only. The provider kit is intentionally retained in memory across runtime replacement;
// these cases do not claim independent SDK transport, operating-system process recovery or permission to resume production.
const fixtures: RestorationFixture[] = [], runtimes = new Set<Runtime>();
const now = () => RESTORATION_NOW;
afterEach(async () => {
  for (const rt of [...runtimes]) await close(rt);
  for (const f of fixtures.splice(0)) rmSync(f.directory, { recursive: true, force: true });
});
async function fixture(version: 2 | 3, partial = false) {
  const f = await restorationLedger(version, { partial }); fixtures.push(f); return f;
}
async function close(rt: Runtime) {
  if (runtimes.delete(rt)) await closeRestorationRuntime(rt);
}
async function start(f: RestorationFixture, path: string) {
  const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules", DB_PATH: path }),
    { clockStart: START, kit: f.ctx.rt.kit });
  runtimes.add(rt); return rt;
}
function preservedArtifacts(f: RestorationFixture, bundle: string) {
  return [f.path, ...readdirSync(bundle).sort().map(name => join(bundle, name))].map(path => {
    const stat = lstatSync(path);
    return { path, bytes: readFileSync(path), inode: stat.ino, mtime_ms: stat.mtimeMs };
  });
}
function identity(row: Record<string, unknown>) {
  return Object.fromEntries(["request_id", "contract_id", "run_id", "correlation_id", "approval_id", "vote_correlation_id", "seq", "attempt", "recipient", "amount_atomic"]
    .map(key => [key, row[key]]));
}
function rawAttempt(rt: Runtime, f: RestorationFixture) {
  return rt.db.query("SELECT * FROM payout_attempts WHERE request_id = ?").get(f.requestId) as Record<string, unknown>;
}
function putRow(db: Database, table: "contracts" | "judgments" | "payout_attempts", row: Record<string, unknown>) {
  const keys = Object.keys(row);
  db.query(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row) as (string | number | null)[]);
}

describe("exported recovery handoff — disposable stand-in runtimes only", () => {
  for (const version of [2, 3] as const) for (const partial of [false, true]) {
    test(`v${version} ${partial ? "partial" : "full"}: a separate working copy retains UNKNOWN, blocks replacements and follows only the original late settlement`, async () => {
      const f = await fixture(version, partial), bundle = join(f.directory, "exported"), published = exportRestorationBundle(f.path, f.input, bundle, { now });
      expect(published.manifest.clearance).toBe("none");
      const before = preservedArtifacts(f, bundle), original = restorationRows(join(bundle, "snapshot.sqlite"));
      const directory = join(f.directory, "working"); mkdirSync(directory, { mode: 0o700 });
      const path = join(directory, "paperwork.sqlite"); cpSync(join(bundle, "snapshot.sqlite"), path);
      let rt = await start(f, path), provider = f.ctx.stub.payouts.get(f.requestId)!;
      const originalIdentity = identity(original.payout_attempts![0]!);
      const amount = version === 2 && partial ? "500" : partial ? "150" : "300";
      expect(rt.engine.followUpIds()).toContain(f.ctx.id);
      expect(identity(rawAttempt(rt, f))).toEqual(originalIdentity);
      expect(isCommitted(rt.engine.attempt(f.requestId))).toBe(true);
      expect(isOpen(rt.engine.attempt(f.requestId))).toBe(true);
      expect(isPaid(rt.engine.attempt(f.requestId))).toBe(false);

      Object.assign(provider, { state: "unknown", status: "UNKNOWN", failureCode: null });
      const unknown = await rt.engine.getContract(f.ctx.id);
      expect(unknown).toMatchObject({ paid_usd: "0", committed_usd: amount });
      expect(unknown.payouts).toHaveLength(1);
      expect(unknown.payouts[0]).toMatchObject({ request_id: f.requestId, state: "disputed", resolution: "disputed", never_executed: false });
      expect(unknown.judgment).toMatchObject({ id: f.judgmentId, outcome: "disputed" });
      expect(unknown.open_judgment).toBeNull();
      await expect(rt.engine.retry(f.ctx.id)).rejects.toThrow();
      await expect(rt.engine.drop(f.ctx.id)).rejects.toThrow();
      await expect(rt.engine.vote(f.requestId, "approve")).rejects.toThrow();
      for (const resolution of ["reowe", "rejected"] as const) await expect(rt.engine.resolve(f.requestId, resolution)).rejects.toThrow(/remains committed/);
      if (version === 2) expect((await rt.engine.run(f.ctx.id)).outcome).toBe("deferred");
      else {
        await expect(rt.engine.requestJobChanges(f.submissionId!, "Do not replace a disputed payment.")).rejects.toThrow(/closed/);
        await expect(rt.engine.submitJob(f.ctx.id, { client_request_id: "must-not-replace-dispute", report: "A new report cannot silently replace the uncertain original payment.",
          evidence: [{ deliverable_id: f.terms.scope[0]!.id, label: "Rehearsal evidence", url: "https://evidence.invalid/new-report" }],
          invoice: { number: "HANDOFF-MUST-NOT-REPLACE", amount_usd: scopeTotal(f.terms) } }, f.terms.contractor.near_account)).rejects.toThrow(/disputed/);
        const same = await rt.engine.proposeJob(f.submissionId!);
        expect(same.payouts).toHaveLength(1); expect(same.submissions[0]!.judgment_id).toBe(f.judgmentId);
      }
      expect(identity(rawAttempt(rt, f))).toEqual(originalIdentity);
      expect(f.ctx.stub.calls.requestPayout).toBe(1); expect(f.ctx.stub.transfers).toHaveLength(0);

      // Replace the runtime on the same working database; the stand-in provider map is deliberately shared.
      await close(rt); rt = await start(f, path);
      const recovered = await rt.engine.getContract(f.ctx.id);
      expect(recovered).toMatchObject({ committed_usd: amount, paid_usd: "0" });
      expect(identity(rawAttempt(rt, f))).toEqual(originalIdentity);
      Object.assign(provider, { state: "processing", status: "PROCESSING", failureCode: null });
      f.ctx.stub.settle(rt.engine.attempt(f.requestId).correlation_id!);
      const settled = await rt.engine.getContract(f.ctx.id);
      expect(settled.payouts).toHaveLength(1);
      expect(settled.payouts[0]).toMatchObject({ request_id: f.requestId, state: "paid", payment_correlation_id: originalIdentity.correlation_id });
      expect(settled.paid_usd).toBe(amount); expect(identity(rawAttempt(rt, f))).toEqual(originalIdentity);
      expect(settled.judgment).toMatchObject({ outcome: partial ? "disputed" : "approved" });
      if (version === 3) expect(settled.submissions[0]).toMatchObject({ id: f.submissionId, judgment_id: f.judgmentId,
        state: partial ? "disputed" : "settled", proposed_usd: "300", paid_usd: amount });
      if (partial) {
        expect(settled.open_judgment).toBeNull();
        if (version === 2) expect((await rt.engine.run(f.ctx.id)).outcome).toBe("deferred");
        else await expect(rt.engine.submitJob(f.ctx.id, { client_request_id: "must-not-request-remainder", report: "Partial late settlement does not authorize a remainder payment.",
          evidence: [{ deliverable_id: f.terms.scope[0]!.id, label: "Rehearsal evidence", url: "https://evidence.invalid/remainder" }],
          invoice: { number: "HANDOFF-NO-REMAINDER", amount_usd: "150" } }, f.terms.contractor.near_account)).rejects.toThrow(/disputed/);
      }
      expect(f.ctx.stub.calls.requestPayout).toBe(1); expect(f.ctx.stub.transfers).toHaveLength(1);
      expect(rt.db.query("SELECT request_id, seq, attempt FROM payout_attempts WHERE contract_id = ?").all(f.ctx.id))
        .toEqual([{ request_id: f.requestId, seq: 1, attempt: 1 }]);
      expect(rt.db.query("SELECT * FROM recovery_corrections").all()).toHaveLength(1);
      expect(rt.db.query("SELECT * FROM job_invoices ORDER BY rowid").all()).toEqual(original.job_invoices!);
      expect(preservedArtifacts(f, bundle)).toEqual(before);
      const reuse = exportRestorationBundle(f.path, f.input, bundle, { now: () => new Date(RESTORATION_NOW.getTime() + 3_600_000) });
      expect(reuse.result).toBe("already_exported"); expect(reuse.manifest_sha256).toBe(published.manifest_sha256);
      expect(preservedArtifacts(f, bundle)).toEqual(before);
    });
  }

  for (const version of [2, 3] as const) test(`v${version}: another unsafe historical job refuses actual runtime startup before platform calls or migration`, async () => {
    const f = await fixture(version), db = new Database(f.path, { strict: true });
    try {
      const contract = db.query("SELECT * FROM contracts WHERE id = ?").get(f.ctx.id) as Record<string, unknown>;
      putRow(db, "contracts", { ...contract, id: "z_unrelated_unsafe_job", hash: "c".repeat(64), organization: "z_unrelated_organization" });
      const judgment = db.query("SELECT * FROM judgments WHERE id = ?").get(f.judgmentId) as Record<string, unknown>;
      putRow(db, "judgments", { ...judgment, id: "z_unrelated_judgment", contract_id: "z_unrelated_unsafe_job" });
      const attempt = db.query("SELECT * FROM payout_attempts WHERE request_id = ?").get(f.requestId) as Record<string, unknown>;
      putRow(db, "payout_attempts", { ...attempt, request_id: "z_unrelated_unsafe_request", contract_id: "z_unrelated_unsafe_job", run_id: "z_unrelated_judgment",
        correlation_id: null, approval_id: null, vote_correlation_id: null });
      db.query("INSERT INTO payout_lines SELECT 'z_unrelated_unsafe_request', deliverable_id, amount_atomic FROM payout_lines WHERE request_id = ?").run(f.requestId);
    } finally { db.close(true); }
    const fresh = await restorationEvidence(f.path); f.input = fresh.input;
    const bundle = join(f.directory, "exported"), result = exportRestorationBundle(f.path, f.input, bundle, { now });
    expect(result.manifest.clearance).toBe("none");
    const before = preservedArtifacts(f, bundle), working = join(f.directory, "blocked-working"); mkdirSync(working, { mode: 0o700 });
    const path = join(working, "paperwork.sqlite"); cpSync(join(bundle, "snapshot.sqlite"), path);
    const bytes = readFileSync(path), rows = restorationRows(path), files = readdirSync(working).sort(), calls = structuredClone(f.ctx.stub.calls);
    const originalAgent = f.ctx.stub.agent.bind(f.ctx.stub); let platformCalls = 0;
    f.ctx.stub.agent = (organization, agent) => { platformCalls++; return originalAgent(organization, agent); };
    await expect(start(f, path)).rejects.toThrow(/z_unrelated_unsafe_request/);
    expect(platformCalls).toBe(0); expect(f.ctx.stub.calls).toEqual(calls);
    expect(readFileSync(path)).toEqual(bytes); expect(restorationRows(path)).toEqual(rows);
    expect(readdirSync(working).sort()).toEqual(files); expect(preservedArtifacts(f, bundle)).toEqual(before);
  });
});
