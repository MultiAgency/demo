import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, type Runtime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { activate, play, setup, signTerms, START, type Ctx } from "./support/harness";

const dbOf = (rt: Runtime) => (rt.covenant as unknown as { d: { db: Database } }).d.db;
async function close(rt: Runtime) {
  await (await rt.auth.$context).checkSchema?.();
  dbOf(rt).close();
}
async function held(ctx: Ctx) {
  const c = ctx.rt.covenant;
  const submission = await c.submitJob(ctx.id, {
    client_request_id: "signing-recovery-submission", report: "The CSV export and tests are ready for agency review.",
    evidence: [{ deliverable_id: "d1", label: "CSV acceptance tests", url: "https://evidence.invalid/tests" }],
    invoice: { number: "SIGNING-001", amount_usd: "300" },
  }, JOB_DEMO_TERMS.contractor.near_account);
  const proposed = await c.proposeJob(submission.id);
  return { submission, payout: proposed.payouts[0]! };
}

describe("owner signing identity — local fixtures, no hosted wallet", () => {
  test("a lost app prepare response reuses the same stored vote, including after a database reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "covenant-signing-"));
    let rt: Runtime | null = null;
    try {
      const path = join(dir, "fixture.sqlite");
      const ctx = await activate("300", JOB_DEMO_TERMS, { DB_PATH: path });
      rt = ctx.rt;
      const { payout } = await held(ctx);
      const original = ctx.stub.agent.bind(ctx.stub);
      let prepares = 0;
      ctx.stub.agent = (org, agent) => {
        const handle = original(org, agent);
        return { ...handle, ownerPrepare: async (action) => { prepares++; return handle.ownerPrepare(action); } };
      };
      const first = await rt.covenant.vote(payout.request_id, "approve"); // Caller loses this app response.
      expect(await rt.covenant.vote(payout.request_id, "approve")).toEqual(first);
      await close(rt);
      rt = null;
      rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules", DB_PATH: path }), { clockStart: START, kit: ctx.stub.kit(), log: () => {} });
      const recovered = await rt.covenant.vote(payout.request_id, "approve");
      expect(recovered).toEqual(first);
      expect(prepares).toBe(1);
      expect(rt.covenant.attempt(payout.request_id).vote_correlation_id).toBe(first.correlation_id);
      expect(ctx.stub.calls.requestPayout).toBe(1);
    } finally {
      if (rt) await close(rt);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("only unsubmitted preparations may be superseded; a stale opposite wallet prompt cannot submit", async () => {
    const ctx = await activate("300", JOB_DEMO_TERMS);
    const { submission, payout } = await held(ctx);
    const c = ctx.rt.covenant;
    const approve = await c.vote(payout.request_id, "approve");
    await c.requestJobChanges(submission.id, "Attach reproducible acceptance-test output.");
    const reject = await c.vote(payout.request_id, "reject");
    expect(reject.correlation_id).not.toBe(approve.correlation_id);
    expect(c.onboarding.step(approve.correlation_id).state).toBe("expired");
    expect(await c.vote(payout.request_id, "reject")).toEqual(reject);
    await expect(c.submitOwnerStep(approve.correlation_id, ctx.stub.sign(approve.sign!))).rejects.toThrow();
    expect(ctx.stub.transfers).toEqual([]);
  });

  test("an expired preparation gets a new intent; the old signed intent cannot be submitted", async () => {
    const ctx = await activate("300", JOB_DEMO_TERMS);
    const { payout } = await held(ctx);
    const c = ctx.rt.covenant;
    const first = await c.vote(payout.request_id, "approve");
    ctx.rt.clock.advance(16 * 60_000);
    const second = await c.vote(payout.request_id, "approve");
    expect(second.correlation_id).not.toBe(first.correlation_id);
    expect(c.onboarding.step(first.correlation_id).state).toBe("expired");
    await expect(c.submitOwnerStep(first.correlation_id, ctx.stub.sign(first.sign!))).rejects.toThrow("already");
    expect(ctx.stub.calls.requestPayout).toBe(1);
  });

  test("a confirm-only preparation is reused without inferring a vote or superseding an external confirmation", async () => {
    const ctx = await activate("300", JOB_DEMO_TERMS);
    const { payout } = await held(ctx);
    const c = ctx.rt.covenant;
    const original = ctx.stub.agent.bind(ctx.stub);
    let prepares = 0;
    ctx.stub.agent = (org, agent) => {
      const handle = original(org, agent);
      return { ...handle, ownerPrepare: async (action) => {
        prepares++;
        const result = await handle.ownerPrepare(action);
        return result.ok ? { ok: true, value: { ...result.value, intent: undefined,
          confirm: { url: "https://platform.invalid/confirm/fixture", expiresAt: result.value.expiresAt },
        } } : result;
      } };
    };
    const confirmation = await c.vote(payout.request_id, "approve");
    expect(confirmation.sign).toBeNull();
    expect(confirmation.confirm?.url).toBe("https://platform.invalid/confirm/fixture");
    expect(await c.vote(payout.request_id, "approve")).toEqual(confirmation);
    await expect(c.vote(payout.request_id, "reject")).rejects.toThrow("confirmation may already have been signed");
    await expect(c.submitOwnerStep(confirmation.correlation_id, { publicKey: "fixture", signature: "fixture" })).rejects.toThrow("platform's page");
    expect(c.attempt(payout.request_id).vote).toBeNull();
    expect(c.attempt(payout.request_id).state).toBe("held");
    expect(prepares).toBe(1);
  });

  test("a thrown submit records the original vote before I/O and blocks duplicate or opposite preparation", async () => {
    const ctx = await activate("300", JOB_DEMO_TERMS);
    const { submission, payout } = await held(ctx);
    const c = ctx.rt.covenant;
    const vote = await c.vote(payout.request_id, "approve");
    const original = ctx.stub.agent.bind(ctx.stub);
    let submits = 0;
    ctx.stub.agent = (org, agent) => {
      const handle = original(org, agent);
      return { ...handle, ownerSubmit: async () => {
        submits++;
        expect(c.onboarding.step(vote.correlation_id).state).toBe("unknown");
        expect(c.attempt(payout.request_id).vote).toBe("approve");
        expect(c.attempt(payout.request_id).vote_correlation_id).toBe(vote.correlation_id);
        throw new Error("fixture connection lost before outcome was known");
      } };
    };
    expect((await c.submitOwnerStep(vote.correlation_id, ctx.stub.sign(vote.sign!))).state).toBe("unknown");
    for (const verdict of ["approve", "reject"] as const) await expect(c.vote(payout.request_id, verdict)).rejects.toThrow("already submitted or uncertain");
    await expect(c.submitOwnerStep(vote.correlation_id, ctx.stub.sign(vote.sign!))).rejects.toThrow("already");
    await expect(c.requestJobChanges(submission.id, "Request changes while approval is uncertain.")).rejects.toThrow("may have moved");
    expect(submits).toBe(1);
    expect(c.attempt(payout.request_id).request_id).toBe(payout.request_id);
    expect((await c.viewContract(ctx.id)).committed_usd).toBe("300");
    expect(ctx.stub.transfers).toEqual([]);
  });

  test("a definite owner-submit refusal retains a conservative decision marker without claiming approval or replaying", async () => {
    const ctx = await activate("300", JOB_DEMO_TERMS);
    const { submission, payout } = await held(ctx);
    const c = ctx.rt.covenant;
    const vote = await c.vote(payout.request_id, "approve");
    const original = ctx.stub.agent.bind(ctx.stub);
    let submits = 0;
    ctx.stub.agent = (org, agent) => {
      const handle = original(org, agent);
      return { ...handle, ownerSubmit: async () => {
        submits++;
        return { ok: false, kind: "refused", code: "signature_invalid" };
      } };
    };
    await expect(c.submitOwnerStep(vote.correlation_id, ctx.stub.sign(vote.sign!))).rejects.toThrow("signature_invalid");
    expect(c.onboarding.step(vote.correlation_id).state).toBe("failed");
    expect(c.attempt(payout.request_id).vote).toBe("approve"); // Attempted decision; not a confirmed approval.
    const view = await c.viewContract(ctx.id);
    expect(view.payouts[0]!.state).toBe("held");
    expect(view.paid_usd).toBe("0");
    expect(view.committed_usd).toBe("300");
    expect(view.events.some((e) => e.kind === "vote")).toBe(false);
    await expect(c.submitOwnerStep(vote.correlation_id, ctx.stub.sign(vote.sign!))).rejects.toThrow("already failed");
    await expect(c.requestJobChanges(submission.id, "Revise after the signature refusal.")).rejects.toThrow("may have moved");
    const retry = await c.vote(payout.request_id, "approve");
    expect(retry.correlation_id).not.toBe(vote.correlation_id);
    expect(submits).toBe(1);
    expect(ctx.stub.calls.requestPayout).toBe(1);
  });

  test("a crash boundary after provider acceptance leaves the durable vote unrepeatable after reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "covenant-owner-crash-"));
    let rt: Runtime | null = null;
    try {
      const path = join(dir, "fixture.sqlite");
      const ctx = await activate("300", JOB_DEMO_TERMS, { DB_PATH: path });
      rt = ctx.rt;
      const { payout } = await held(ctx);
      const vote = await rt.covenant.vote(payout.request_id, "approve");
      // Model a process loss between external acceptance and the app's result write; no OS crash is claimed.
      dbOf(rt).exec(`CREATE TEMP TRIGGER fail_submit_result BEFORE UPDATE OF state ON owner_steps
        WHEN NEW.state = 'submitted' BEGIN SELECT RAISE(ABORT, 'fixture crash after provider acceptance'); END`);
      await expect(rt.covenant.submitOwnerStep(vote.correlation_id, ctx.stub.sign(vote.sign!))).rejects.toThrow("fixture crash");
      expect(rt.covenant.onboarding.step(vote.correlation_id).state).toBe("unknown");
      expect(rt.covenant.attempt(payout.request_id).vote).toBe("approve");
      const correlation = rt.covenant.attempt(payout.request_id).correlation_id!;
      await close(rt); // The temporary trigger also disappears with this connection.
      rt = null;
      rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules", DB_PATH: path }), { clockStart: START, kit: ctx.stub.kit(), log: () => {} });
      const recovered = await rt.covenant.getContract(ctx.id);
      expect(recovered.payouts[0]!.state).toBe("processing");
      expect(rt.covenant.attempt(payout.request_id).vote_correlation_id).toBe(vote.correlation_id);
      expect(rt.covenant.attempt(payout.request_id).correlation_id).toBe(correlation);
      await expect(rt.covenant.submitOwnerStep(vote.correlation_id, ctx.stub.sign(vote.sign!))).rejects.toThrow("already");
      ctx.stub.settle(correlation);
      const paid = await rt.covenant.getContract(ctx.id);
      expect(paid.submissions[0]!.state).toBe("settled");
      expect(ctx.stub.calls.requestPayout).toBe(1);
      expect(ctx.stub.transfers).toHaveLength(1);
    } finally {
      if (rt) await close(rt);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a thrown non-payment owner submit is recovered by status without another signature", async () => {
    const ctx = await setup(JOB_DEMO_TERMS);
    await signTerms(ctx);
    const c = ctx.rt.covenant;
    const creation = await play(ctx, await c.next(ctx.id));
    if (creation.kind !== "owner_step") throw new Error("Expected agent creation.");
    const original = ctx.stub.agent.bind(ctx.stub);
    let submits = 0;
    ctx.stub.agent = (org, agent) => {
      const handle = original(org, agent);
      return { ...handle, ownerSubmit: async (...args) => {
        submits++;
        await handle.ownerSubmit(...args);
        throw new Error("fixture reply lost after agent creation");
      } };
    };
    expect((await c.submitOwnerStep(creation.correlation_id, ctx.stub.sign(creation.sign!))).state).toBe("unknown");
    expect(await c.next(ctx.id)).toMatchObject({ kind: "sign", step: "consent_payout" });
    expect(c.onboarding.step(creation.correlation_id).state).toBe("success");
    expect(submits).toBe(1);
  });

  test("setup and consent wallet prompts retain their exact nonce/body across next-step reloads", async () => {
    const ctx = await setup(JOB_DEMO_TERMS);
    await signTerms(ctx);
    const c = ctx.rt.covenant;
    const setupRequest = await c.next(ctx.id);
    if (setupRequest.kind !== "sign") throw new Error("Expected setup signature.");
    ctx.rt.clock.advance(1000);
    expect(await c.next(ctx.id)).toEqual(setupRequest);
    const creation = await play(ctx, setupRequest); // The original wallet answer still matches.
    const consent = await play(ctx, creation);
    if (consent.kind !== "sign") throw new Error("Expected consent signature.");
    ctx.rt.clock.advance(1000);
    expect(await c.next(ctx.id)).toEqual(consent);
    expect(await play(ctx, consent)).toMatchObject({ kind: "sign", step: "consent_owner" });
  });

  test("an expired setup wallet prompt is renewed and its stale nonce is refused", async () => {
    const ctx = await setup(JOB_DEMO_TERMS);
    await signTerms(ctx);
    const c = ctx.rt.covenant;
    const first = await c.next(ctx.id);
    if (first.kind !== "sign") throw new Error("Expected setup signature.");
    ctx.rt.clock.advance(31 * 60_000);
    const second = await c.next(ctx.id);
    if (second.kind !== "sign") throw new Error("Expected renewed setup signature.");
    expect(second.sign.nonce).not.toBe(first.sign.nonce);
    expect(second.sign.message).not.toBe(first.sign.message);
    await expect(play(ctx, first)).rejects.toThrow("current step");
    expect(ctx.stub.agents.size).toBe(0);
  });
});
