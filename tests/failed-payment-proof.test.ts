import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, createRuntime, type Runtime } from "../src/server/app";
import type { Auth } from "../src/server/auth";
import { loadConfig } from "../src/server/config";
import { DEMO_TERMS, JOB_DEMO_TERMS } from "../src/shared/demo";
import { activate, castVote, START, type Ctx } from "./support/harness";

const runtimes = new Set<Runtime>();
const directories: string[] = [];
const dbOf = (rt: Runtime) => (rt.engine as unknown as { d: { db: Database } }).d.db;

async function close(rt: Runtime) {
  if (!runtimes.delete(rt)) return;
  await (await rt.auth.$context).checkSchema?.();
  dbOf(rt).close();
}

afterEach(async () => {
  for (const rt of [...runtimes]) await close(rt);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Enforce the HTTP role boundary with an explicit fixture session, never a hosted sign-in. */
function representativeApp(rt: Runtime) {
  const account = DEMO_TERMS.representative.near_account;
  const auth = {
    handler: async () => new Response("offline fixture auth"),
    api: { getSession: async () => ({ user: { id: account } }) },
    nearAccountFor: () => account,
  } as unknown as Auth;
  return buildApp({ ...rt, auth, config: { ...rt.config, auth: { ...rt.config.auth, required: true } } });
}

function ledger(rt: Runtime) {
  return Object.fromEntries([
    "contracts", "judgments", "payout_attempts", "payout_lines", "owner_steps", "job_submissions", "job_invoices", "events",
  ].map((table) => [table, dbOf(rt).query(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

async function requestedJob(version: 2 | 3, options: { path?: string; loseReply?: boolean } = {}) {
  // One deliverable makes each version's obligation one 300 USDC payment, without a later sequence obscuring counts.
  const terms = version === 2 ? { ...DEMO_TERMS, scope: [DEMO_TERMS.scope[0]!] } : JOB_DEMO_TERMS;
  const ctx = await activate("300", terms, options.path ? { DB_PATH: options.path } : {});
  runtimes.add(ctx.rt);
  let submissionId: string | null = null;
  if (version === 3) {
    const submission = await ctx.rt.engine.submitJob(ctx.id, {
      client_request_id: "proof-regression-submission", report: "The CSV export and acceptance tests are ready for review.",
      evidence: [{ deliverable_id: "d1", label: "CSV export test results", url: "https://evidence.invalid/csv-tests" }],
      invoice: { number: "PROOF-REGRESSION", amount_usd: "300" },
    }, JOB_DEMO_TERMS.contractor.near_account);
    submissionId = submission.id;
  }
  ctx.stub.script.dropNextReply = options.loseReply === true;
  const proposed = submissionId ? await ctx.rt.engine.proposeJob(submissionId) : await ctx.rt.engine.run(ctx.id);
  const payout = proposed.payouts[0]!;
  expect(payout.amount_usd).toBe("300");
  const judgmentId = ctx.rt.engine.attempt(payout.request_id).run_id!;
  return { ctx, payout, judgmentId, submissionId };
}

interface FailureEvidence {
  label: string;
  failureCode: string;
  proof?: boolean;
  txHash?: string;
  refundTxHash?: string;
  refundedAmount?: string;
  paymentStatus?: string;
  storedEmptyField?: "tx_hash" | "refund_tx_hash";
  storedRefundedAmount?: string;
}

/**
 * Model terminal platform observations explicitly. The stub's failure-code inference is stripped, so neither a
 * rejection-looking code nor the absence of a transaction supplies the proof these regressions require.
 */
function installFailureEvidence(ctx: Ctx, requestId: string, evidence: FailureEvidence) {
  const payout = ctx.stub.payouts.get(requestId)!;
  const originalAgent = ctx.stub.agent.bind(ctx.stub);
  ctx.stub.agent = (organization, agent) => {
    const handle = originalAgent(organization, agent);
    return {
      ...handle,
      payoutStatus: async (rid) => {
        const result = await handle.payoutStatus(rid);
        if (!result.ok || rid !== requestId) return result;
        const { neverExecuted: _inferredProof, ...recorded } = result.value;
        return { ok: true, value: { ...recorded, failureCode: evidence.failureCode,
          ...(evidence.proof !== undefined && { neverExecuted: evidence.proof }) } };
      },
      paymentStatus: async (correlation) => {
        const result = await handle.paymentStatus(correlation);
        if (!result.ok || correlation !== payout.correlationId) return result;
        return { ok: true, value: { ...result.value, status: evidence.paymentStatus ?? "FAILED", failureCode: evidence.failureCode,
          evidence: { ...result.value.evidence, txHash: evidence.txHash ?? null, refundTxHash: evidence.refundTxHash ?? null,
            refundedAmount: evidence.refundedAmount ?? null } } };
      },
    };
  };
}

async function observeFailure(ctx: Ctx, requestId: string, evidence: FailureEvidence) {
  Object.assign(ctx.stub.payouts.get(requestId)!, { state: "failed", status: "FAILED", failureCode: evidence.failureCode, txHash: null });
  installFailureEvidence(ctx, requestId, evidence);
  await ctx.rt.engine.getContract(ctx.id);
  if (evidence.storedEmptyField) {
    // A historical malformed stored hash is contradictory information, not an absent nullable field.
    dbOf(ctx.rt).query(`UPDATE payout_attempts SET ${evidence.storedEmptyField} = '' WHERE request_id = ?`).run(requestId);
  }
  if (evidence.storedRefundedAmount !== undefined) {
    dbOf(ctx.rt).query("UPDATE payout_attempts SET refunded_amount = ? WHERE request_id = ?").run(evidence.storedRefundedAmount, requestId);
  }
}

const insufficient: FailureEvidence[] = [
  { label: "rejection code without a proof field", failureCode: "rejected_by_owner" },
  { label: "delivery code and absent transaction without proof", failureCode: "delivery_failed" },
  { label: "explicitly uncertain outcome", failureCode: "delivery_outcome_unknown", proof: false },
  { label: "proof contradicted by transaction", failureCode: "fixture_terminal_failure", proof: true, txHash: "fixture-payment-tx" },
  { label: "proof contradicted by refund", failureCode: "fixture_terminal_failure", proof: true, refundTxHash: "fixture-refund-tx" },
  { label: "proof contradicted by refunded amount", failureCode: "fixture_terminal_failure", proof: true, refundedAmount: "300000000" },
  { label: "proof contradicted by processing status", failureCode: "fixture_terminal_failure", proof: true, paymentStatus: "PROCESSING" },
  { label: "empty stored transaction hash", failureCode: "fixture_explicit_non_execution", proof: true, storedEmptyField: "tx_hash" },
  { label: "empty stored refund hash", failureCode: "fixture_explicit_non_execution", proof: true, storedEmptyField: "refund_tx_hash" },
  { label: "persisted refunded amount despite otherwise positive proof", failureCode: "fixture_explicit_non_execution", proof: true, storedRefundedAmount: "300000000" },
];

for (const version of [2, 3] as const) {
  describe(`v${version} failed-payment proof at engine and authenticated HTTP boundaries`, () => {
    for (const outcome of ["reowe", "rejected"] as const) {
      for (const evidence of insufficient) {
        test(`${outcome} refuses ${evidence.label} without changing money, review records or identities`, async () => {
          const { ctx, payout, judgmentId } = await requestedJob(version);
          await observeFailure(ctx, payout.request_id, evidence);
          const before = ledger(ctx.rt);
          const attempt = ctx.rt.engine.attempt(payout.request_id);
          const requests = ctx.stub.calls.requestPayout;
          await expect(ctx.rt.engine.resolve(payout.request_id, outcome)).rejects.toThrow("platform proves it never executed");
          const response = await representativeApp(ctx.rt).request(`/api/payouts/${payout.request_id}/resolve`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outcome }),
          });
          expect(response.status).toBe(409);
          expect((await response.json()).error).toContain("platform proves it never executed");
          expect(ledger(ctx.rt)).toEqual(before);
          expect(ctx.rt.engine.attempt(payout.request_id)).toEqual(attempt);
          const view = await ctx.rt.engine.viewContract(ctx.id);
          expect(view.open_judgment?.id).toBe(judgmentId);
          expect(view.committed_usd).toBe("300");
          expect(view.paid_usd).toBe("0");
          expect(view.payouts).toHaveLength(1);
          expect(ctx.stub.calls.requestPayout).toBe(requests);
          expect(ctx.stub.transfers).toEqual([]);
        });
      }

      test(`explicit terminal non-execution permits the representative's ${outcome} decision`, async () => {
        const { ctx, payout, judgmentId } = await requestedJob(version);
        await observeFailure(ctx, payout.request_id, { label: "positive proof", failureCode: "fixture_explicit_non_execution", proof: true });
        const original = ctx.rt.engine.attempt(payout.request_id);
        expect(original).toMatchObject({ state: "failed", never_executed: 1, tx_hash: null, refund_tx_hash: null });
        const resolved = await ctx.rt.engine.resolve(payout.request_id, outcome);
        expect(ctx.rt.engine.attempt(payout.request_id)).toMatchObject({ request_id: original.request_id, correlation_id: original.correlation_id,
          run_id: judgmentId, seq: original.seq, attempt: original.attempt, resolution: outcome });
        expect(resolved.paid_usd).toBe("0");
        expect(ctx.stub.transfers).toEqual([]);
        if (outcome === "reowe") {
          const replacement = resolved.payouts.find((row) => row.request_id !== original.request_id)!;
          const next = ctx.rt.engine.attempt(replacement.request_id);
          expect(next).toMatchObject({ run_id: judgmentId, seq: original.seq, attempt: original.attempt + 1, amount_atomic: original.amount_atomic, state: "held" });
          expect(next.request_id).not.toBe(original.request_id);
          expect(resolved.committed_usd).toBe("300");
          expect(ctx.stub.calls.requestPayout).toBe(2);
          await expect(ctx.rt.engine.resolve(payout.request_id, outcome)).rejects.toThrow();
          await ctx.rt.engine.getContract(ctx.id);
          expect(ctx.stub.calls.requestPayout).toBe(2);
        } else {
          expect(resolved.payouts).toHaveLength(1);
          expect(resolved.committed_usd).toBe("0");
          expect(resolved.open_judgment).toBeNull();
          expect(dbOf(ctx.rt).query("SELECT outcome FROM judgments WHERE id = ?").get(judgmentId)).toEqual({ outcome: "rejected" });
          expect(ctx.stub.calls.requestPayout).toBe(1);
        }
      });
    }

    for (const outcome of ["arrived", "disputed"] as const) {
      test(`manual ${outcome} keeps the original amount committed and retains its distinct evidence label`, async () => {
        const { ctx, payout } = await requestedJob(version);
        await observeFailure(ctx, payout.request_id, { label: "unknown money outcome", failureCode: "delivery_outcome_unknown", proof: false });
        const original = ctx.rt.engine.attempt(payout.request_id);
        const resolved = await ctx.rt.engine.resolve(payout.request_id, outcome, "Representative recorded a fixture review, not platform settlement.");
        expect(ctx.rt.engine.attempt(payout.request_id)).toMatchObject({ request_id: original.request_id, correlation_id: original.correlation_id,
          run_id: original.run_id, state: "failed", resolution: outcome });
        expect(resolved.payouts[0]).toMatchObject({ state: outcome === "arrived" ? "resolved" : "disputed", resolution: outcome });
        expect(resolved.committed_usd).toBe("300");
        expect(resolved.paid_usd).toBe(outcome === "arrived" ? "300" : "0");
        expect(ctx.rt.engine.jobsFor(DEMO_TERMS.contractor.near_account)[0]!.attention?.state).not.toBe("completed");
        expect(ctx.stub.calls.requestPayout).toBe(1);
        expect(ctx.stub.transfers).toEqual([]);
      });
    }

    for (const field of ["txHash", "refundTxHash"] as const) {
      test(`a signed rejection with proof and empty ${field} remains failed and committed`, async () => {
        const { ctx, payout, judgmentId } = await requestedJob(version);
        const decision = await ctx.rt.engine.vote(payout.request_id, "reject");
        installFailureEvidence(ctx, payout.request_id, {
          label: "malformed non-execution evidence", failureCode: "fixture_explicit_non_execution", proof: true, [field]: "",
        });
        await ctx.rt.engine.submitOwnerStep(decision.correlation_id, ctx.stub.sign(decision.sign!));
        const observed = await ctx.rt.engine.getContract(ctx.id);
        expect(ctx.rt.engine.attempt(payout.request_id)).toMatchObject({ state: "failed", vote: "reject", never_executed: 0,
          resolution: null, run_id: judgmentId });
        expect(observed.committed_usd).toBe("300");
        expect(observed.paid_usd).toBe("0");
        expect(observed.payouts).toHaveLength(1);
        expect(observed.open_judgment?.id).toBe(judgmentId);
        for (const outcome of ["reowe", "rejected"] as const)
          await expect(ctx.rt.engine.resolve(payout.request_id, outcome)).rejects.toThrow("platform proves it never executed");
        expect(ctx.stub.calls.requestPayout).toBe(1);
        expect(ctx.stub.transfers).toEqual([]);
      });
    }

    test("stored refund counterevidence survives database reopen when later observations omit it", async () => {
      const directory = mkdtempSync(join(tmpdir(), `paperwork-v${version}-refund-reopen-`));
      directories.push(directory);
      const path = join(directory, "job.sqlite");
      const { ctx, payout, judgmentId, submissionId } = await requestedJob(version, { path });
      await observeFailure(ctx, payout.request_id, {
        label: "refund contradicts proof", failureCode: "fixture_terminal_failure", proof: true, refundedAmount: "300000000",
      });
      const original = ctx.rt.engine.attempt(payout.request_id);
      expect(original).toMatchObject({ state: "failed", resolution: null, never_executed: 0, refunded_amount: "300000000" });
      const stored = await ctx.rt.engine.viewContract(ctx.id);
      await close(ctx.rt);
      // Reopen SQLite while retaining the independent scripted provider. This is not a real SDK process restart.
      ctx.rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules", DB_PATH: path }), {
        clockStart: START, kit: ctx.stub.kit(), log: () => {},
      });
      runtimes.add(ctx.rt);
      expect(ctx.rt.engine.attempt(payout.request_id)).toEqual(original);
      installFailureEvidence(ctx, payout.request_id, {
        label: "later read omits refund", failureCode: "fixture_explicit_non_execution", proof: true,
      });
      await ctx.rt.engine.followUpAll();
      const followed = await ctx.rt.engine.getContract(ctx.id);
      expect(ctx.rt.engine.attempt(payout.request_id)).toMatchObject({ request_id: original.request_id,
        correlation_id: original.correlation_id, run_id: judgmentId, state: "failed", resolution: null,
        never_executed: 0, refunded_amount: "300000000", amount_atomic: original.amount_atomic });
      expect(followed.hash).toBe(stored.hash);
      expect(followed.payouts).toHaveLength(1);
      expect(followed.committed_usd).toBe("300");
      expect(followed.paid_usd).toBe("0");
      if (submissionId) expect(followed.submissions[0]).toMatchObject({ id: submissionId, judgment_id: judgmentId,
        invoice: { id: stored.submissions[0]!.invoice.id } });
      const before = ledger(ctx.rt);
      for (const outcome of ["reowe", "rejected"] as const) {
        await expect(ctx.rt.engine.resolve(payout.request_id, outcome)).rejects.toThrow("platform proves it never executed");
        const response = await representativeApp(ctx.rt).request(`/api/payouts/${payout.request_id}/resolve`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outcome }),
        });
        expect(response.status).toBe(409);
      }
      expect(ledger(ctx.rt)).toEqual(before);
      expect(ctx.stub.calls.requestPayout).toBe(1);
      expect(ctx.stub.transfers).toEqual([]);
    });

    test("an unknown request survives database reopen and observation under its original identity", async () => {
      const directory = mkdtempSync(join(tmpdir(), `paperwork-v${version}-failure-proof-`));
      directories.push(directory);
      const path = join(directory, "job.sqlite");
      const { ctx, payout, judgmentId, submissionId } = await requestedJob(version, { path, loseReply: true });
      const original = ctx.rt.engine.attempt(payout.request_id);
      expect(original.state).toBe("unknown");
      const stored = await ctx.rt.engine.viewContract(ctx.id);
      await close(ctx.rt);
      ctx.rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules", DB_PATH: path }), {
        clockStart: START, kit: ctx.stub.kit(), log: () => {},
      });
      runtimes.add(ctx.rt);
      expect(ctx.rt.engine.attempt(payout.request_id)).toEqual(original);
      ctx.stub.script.unavailable = true;
      const waiting = await ctx.rt.engine.getContract(ctx.id);
      expect(waiting.payouts).toHaveLength(1);
      expect(waiting.committed_usd).toBe("300");
      expect(ctx.stub.calls.requestPayout).toBe(1);
      const before = ledger(ctx.rt);
      for (const outcome of ["reowe", "rejected"] as const) await expect(ctx.rt.engine.resolve(payout.request_id, outcome)).rejects.toThrow();
      expect(ledger(ctx.rt)).toEqual(before);
      ctx.stub.script.unavailable = false;
      const recovered = await ctx.rt.engine.getContract(ctx.id);
      expect(recovered.hash).toBe(stored.hash);
      expect(recovered.payouts[0]).toMatchObject({ request_id: original.request_id, state: "held" });
      expect(ctx.rt.engine.attempt(payout.request_id).run_id).toBe(judgmentId);
      if (submissionId) expect(recovered.submissions[0]).toMatchObject({ id: submissionId, judgment_id: judgmentId, invoice: { id: stored.submissions[0]!.invoice.id } });
      expect(ctx.stub.calls.requestPayout).toBe(1);
      await castVote(ctx, payout.request_id, "approve");
      const correlation = ctx.rt.engine.attempt(payout.request_id).correlation_id!;
      ctx.stub.settle(correlation);
      const settled = await ctx.rt.engine.getContract(ctx.id);
      expect(settled.payouts[0]).toMatchObject({ request_id: original.request_id, state: "paid" });
      expect(settled.paid_usd).toBe("300");
      expect(ctx.rt.engine.attempt(payout.request_id).correlation_id).toBe(correlation);
      expect(ctx.stub.calls.requestPayout).toBe(1);
      expect(ctx.stub.transfers.filter((transfer) => transfer.status === "SUCCESS")).toHaveLength(1);
    });
  });
}
