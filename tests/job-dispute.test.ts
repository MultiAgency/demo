import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildApp, createRuntime, type Runtime } from "../src/server/app";
import type { Auth } from "../src/server/auth";
import { loadConfig } from "../src/server/config";
import { isCommitted, isOpen, isPaid } from "../src/server/payouts";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { AgencyJobWorkflow } from "../src/web/components/JobWorkflow";
import { activate, castVote, START } from "./support/harness";

async function close(rt: Runtime) {
  await rt.close();
}
function asAccount(rt: Runtime, account: string | null) {
  const auth = { handler: async () => new Response("fixture"), api: { getSession: async () => account ? { user: { id: account } } : null }, nearAccountFor: (id: string) => id } as unknown as Auth;
  return buildApp({ ...rt, auth, config: { ...rt.config, auth: { ...rt.config.auth, required: true } } });
}
async function failedJob(overrides: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const ctx = await activate("300", { ...JOB_DEMO_TERMS, ...overrides }, env);
  const c = ctx.rt.engine;
  const view = await c.viewContract(ctx.id);
  const body = { client_request_id: "disputed-original-submission", report: "The agreed CSV export and acceptance evidence are ready for review.",
    evidence: view.terms.scope.map(d => ({ deliverable_id: d.id, label: `${d.id} acceptance tests`, url: `https://evidence.invalid/${d.id}` })), invoice: { number: "DISPUTE-001", amount_usd: "300" } };
  const submission = await c.submitJob(ctx.id, body, JOB_DEMO_TERMS.contractor.near_account);
  const proposed = await c.proposeJob(submission.id);
  const payout = proposed.payouts[0]!;
  await castVote(ctx, payout.request_id, "approve");
  const provider = ctx.stub.payouts.get(payout.request_id)!;
  Object.assign(provider, { state: "failed", status: "FAILED", failureCode: "delivery_outcome_unknown", txHash: null });
  await c.getContract(ctx.id);
  return { ctx, c, body, submission, payout, provider, accepted: view.terms, hash: view.hash };
}

describe("disputed review closure — simulated platform and fixture sessions", () => {
  test("agency closes disputed without claiming payment, releasing budget or replacing any identity", async () => {
    const { ctx, c, submission, payout, body, hash, accepted } = await failedJob();
    const app = asAccount(ctx.rt, "acme.demo");
    const result = await app.request(`/api/payouts/${payout.request_id}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outcome: "disputed", reason: "The provider has not established where the payment went." }) });
    expect(result.status).toBe(200);
    const view = await c.viewContract(ctx.id);
    expect(view.submissions[0]).toMatchObject({ id: submission.id, invoice: submission.invoice, judgment_id: view.submissions[0]!.judgment_id, state: "disputed", paid_usd: "0", payout_request_ids: [payout.request_id] });
    expect(view.judgment).toMatchObject({ outcome: "disputed" });
    expect(view.open_judgment).toBeNull();
    expect(view.payouts[0]).toMatchObject({ request_id: payout.request_id, payment_correlation_id: payout.payment_correlation_id, state: "disputed", resolution: "disputed" });
    expect(view.paid_usd).toBe("0");
    expect(view.committed_usd).toBe("300");
    expect(view.hash).toBe(hash);
    expect(view.terms).toEqual(accepted);
    const raw = c.attempt(payout.request_id);
    expect(isCommitted(raw)).toBe(true);
    expect(isOpen(raw)).toBe(true);
    expect(isPaid(raw)).toBe(false);
    expect(c.followUpIds()).toContain(ctx.id);
    await expect(c.submitJob(ctx.id, { ...body, client_request_id: "disputed-replacement-attempt", invoice: { ...body.invoice, number: "DISPUTE-002" } }, "maria.demo")).rejects.toThrow(/disputed/);
    await expect(c.retry(ctx.id)).rejects.toThrow();
    await c.resolve(payout.request_id, "disputed"); // Idempotent review cannot duplicate an event or payment.
    await c.getContract(ctx.id);
    expect(ctx.stub.calls.requestPayout).toBe(1);
    expect(ctx.stub.transfers).toEqual([]);
    expect(view.events.some(e => e.text.includes("not counted as paid"))).toBe(true);
    const config = await (await ctx.rt.app.request("/api/config")).json();
    const html = renderToStaticMarkup(createElement(AgencyJobWorkflow, { c: view, config, act: async () => {} }));
    expect(html).toContain("Disputed · awaiting evidence");
    expect(html).toContain("not counted as paid");
    expect(html).not.toContain("Confirmed settlement");
    expect(html).not.toContain("Payment complete");
  });

  test("the SQLite monetary slot remains held by a failed disputed payout", async () => {
    const { ctx, c, payout } = await failedJob();
    await c.resolve(payout.request_id, "disputed");
    const db = ctx.rt.db;
    expect(() => db.query(`INSERT INTO payout_attempts
      (request_id, contract_id, seq, attempt, recipient, amount_atomic, state, created_at, updated_at)
      VALUES ('must-not-replace-dispute', ?, 999, 1, 'maria.demo', '300000000', 'pending', '2026-11-20', '2026-11-20')`).run(ctx.id)).toThrow(/UNIQUE/);
    expect(db.query("SELECT request_id FROM payout_attempts WHERE contract_id = ?").all(ctx.id)).toEqual([{ request_id: payout.request_id }]);
  });

  test("only the agency may close disputed; unauthenticated and builder requests do not mutate the payment", async () => {
    const { ctx, c, payout } = await failedJob();
    for (const [account, expected] of [[null, 401], ["maria.demo", 403], ["attacker.demo", 403]] as const) {
      const result = await asAccount(ctx.rt, account).request(`/api/payouts/${payout.request_id}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outcome: "disputed" }) });
      expect(result.status).toBe(expected);
      expect(c.attempt(payout.request_id).resolution).toBeNull();
      expect(c.jobSubmissions(ctx.id)[0]!.state).toBe("proposed");
    }
    expect(ctx.stub.calls.requestPayout).toBe(1);
  });

  test("dispute closure rolls back atomically if the linked submission write fails", async () => {
    const { ctx, c, payout } = await failedJob();
    const db = ctx.rt.db;
    db.exec("CREATE TRIGGER fixture_dispute_fault BEFORE UPDATE OF state ON job_submissions WHEN NEW.state = 'disputed' BEGIN SELECT RAISE(ABORT, 'fixture dispute write failed'); END");
    await expect(c.resolve(payout.request_id, "disputed")).rejects.toThrow("fixture dispute write failed");
    expect(c.attempt(payout.request_id).resolution).toBeNull();
    expect(c.jobSubmissions(ctx.id)[0]!.state).toBe("proposed");
    expect((await c.viewContract(ctx.id)).open_judgment?.outcome).toBe("pending");
    db.exec("DROP TRIGGER fixture_dispute_fault");
    expect((await c.resolve(payout.request_id, "disputed")).submissions[0]!.state).toBe("disputed");
    expect(ctx.stub.calls.requestPayout).toBe(1);
  });

  test("a disputed job survives database reopen and late full settlement is confirmed under its original request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paperwork-dispute-"));
    let current: Runtime | null = null;
    try {
      const path = join(directory, "job.sqlite");
      const { ctx, c, submission, payout, provider, hash } = await failedJob({}, { DB_PATH: path });
      current = ctx.rt;
      await c.resolve(payout.request_id, "disputed");
      // Reproduce the pre-dispute schema index before reopening; the additive upgrade must preserve all records and
      // enforce the monetary hold even though the old partial index omitted failed rows with a non-null resolution.
      current.db.exec("DROP INDEX one_open_payout; CREATE UNIQUE INDEX one_open_payout ON payout_attempts(contract_id) WHERE kind = 'payout' AND (state IN ('pending','blocked','waiting','unknown','held','processing') OR (state = 'failed' AND resolution IS NULL))");
      await close(current);
      current = null;
      const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules", DB_PATH: path }), { clockStart: START, kit: ctx.rt.kit });
      current = rt;
      expect(() => rt.db.query(`INSERT INTO payout_attempts
        (request_id, contract_id, seq, attempt, recipient, amount_atomic, state, created_at, updated_at)
        VALUES ('must-not-replace-after-reopen', ?, 999, 1, 'maria.demo', '300000000', 'pending', '2026-11-20', '2026-11-20')`).run(ctx.id)).toThrow(/UNIQUE/);
      expect(rt.engine.followUpIds()).toContain(ctx.id);
      expect((await rt.engine.getContract(ctx.id)).submissions[0]!.state).toBe("disputed");
      Object.assign(provider, { state: "processing", status: "PROCESSING", failureCode: null });
      ctx.stub.settle(payout.payment_correlation_id!);
      const settled = await rt.engine.getContract(ctx.id);
      expect(settled.submissions[0]).toMatchObject({ id: submission.id, invoice: submission.invoice, state: "settled", paid_usd: "300", payout_request_ids: [payout.request_id] });
      expect(settled.payouts[0]).toMatchObject({ request_id: payout.request_id, payment_correlation_id: payout.payment_correlation_id, state: "paid" });
      expect(settled.hash).toBe(hash);
      expect(settled.paid_usd).toBe("300");
      expect(ctx.stub.calls.requestPayout).toBe(1);
      expect(ctx.stub.transfers).toHaveLength(1);
    } finally {
      if (current) await close(current);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("late partial success cannot issue the unpaid remainder or falsely settle the disputed proposal", async () => {
    const { ctx, c, payout, provider } = await failedJob({ scope: [
      { ...JOB_DEMO_TERMS.scope[0]!, value_usd: "150" },
      { ...JOB_DEMO_TERMS.scope[0]!, id: "d2", title: "CSV documentation", value_usd: "150" },
    ] });
    expect(payout.amount_usd).toBe("150");
    await c.resolve(payout.request_id, "disputed");
    Object.assign(provider, { state: "processing", status: "PROCESSING", failureCode: null });
    ctx.stub.settle(payout.payment_correlation_id!);
    const partial = await c.getContract(ctx.id);
    expect(partial.submissions[0]).toMatchObject({ state: "disputed", proposed_usd: "300", paid_usd: "150", payout_request_ids: [payout.request_id] });
    expect(partial.paid_usd).toBe("150");
    expect(partial.payouts).toHaveLength(1);
    expect(partial.open_judgment).toBeNull();
    expect(ctx.stub.calls.requestPayout).toBe(1);
  });

  test("positive non-execution evidence can be explicitly reviewed without silently freeing a disputed amount", async () => {
    const { ctx, c, payout, provider } = await failedJob();
    await c.resolve(payout.request_id, "disputed");
    Object.assign(provider, { failureCode: "rejected_by_owner" });
    const proved = await c.getContract(ctx.id);
    expect(proved.payouts[0]).toMatchObject({ state: "disputed", never_executed: true });
    expect(proved.committed_usd).toBe("300");
    expect(proved.paid_usd).toBe("0");
    const closed = await c.resolve(payout.request_id, "rejected");
    expect(closed.submissions[0]!.state).toBe("closed");
    expect(closed.committed_usd).toBe("0");
    expect(ctx.stub.calls.requestPayout).toBe(1);
  });

  test("legacy merged-work jobs can close disputed without authorizing a replacement run", async () => {
    const ctx = await activate();
    const result = await ctx.rt.engine.run(ctx.id);
    const payout = result.payouts[0]!;
    Object.assign(ctx.stub.payouts.get(payout.request_id)!, { state: "failed", status: "FAILED", failureCode: "outcome_unknown", txHash: null });
    await ctx.rt.engine.getContract(ctx.id);
    const disputed = await ctx.rt.engine.resolve(payout.request_id, "disputed");
    expect(disputed.payouts[0]).toMatchObject({ resolution: "disputed", state: "disputed" });
    expect(disputed.paid_usd).toBe("0");
    expect((await ctx.rt.engine.run(ctx.id)).outcome).toBe("deferred");
    expect(ctx.stub.calls.requestPayout).toBe(1);
    // A late success can resolve this payment without completing the larger original proposal. The merge watcher
    // must not bypass the still-disputed business review by opening another judgment for the remaining amount.
    Object.assign(ctx.stub.payouts.get(payout.request_id)!, { state: "processing", status: "PROCESSING", failureCode: null });
    ctx.stub.settle(payout.payment_correlation_id!);
    const partial = await ctx.rt.engine.getContract(ctx.id);
    expect(partial.paid_usd).toBe("500");
    expect(partial.judgment).toMatchObject({ outcome: "disputed" });
    expect((await ctx.rt.engine.run(ctx.id)).outcome).toBe("deferred");
    expect(ctx.stub.calls.requestPayout).toBe(1);
  });
});
