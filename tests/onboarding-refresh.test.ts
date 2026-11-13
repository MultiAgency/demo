import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { NextStep } from "../src/shared/views";
import { activate, play, setup, signTerms } from "./support/harness";

// Simulate a platform confirmation completing outside Paperwork, while its saved action is still pending.
async function outsideConfirmation(ctx: Awaited<ReturnType<typeof setup>>, step: NextStep) {
  if (step.kind !== "owner_step" || !step.sign) throw new Error("Expected prepared owner action");
  const row = ctx.rt.engine.onboarding.step(step.correlation_id);
  const signed = ctx.stub.sign(step.sign);
  const result = await ctx.stub.agent(row.organization, ctx.rt.engine.onboarding.agentRow(row.organization)!.agent!)
    .ownerSubmit(step.correlation_id, { standard: "nep413", payload: { message: step.sign.message, recipient: step.sign.recipient, nonce: step.sign.nonce } }, signed);
  expect(result.ok).toBe(true);
  (ctx.rt.engine as unknown as { d: { db: Database } }).d.db.query("UPDATE owner_steps SET confirm_url = ? WHERE correlation_id = ?").run("https://platform.invalid/confirm/fixture", step.correlation_id);
}

test("normal refresh reconciles external creation, grant and policy without preparing another action", async () => {
  const ctx = await setup();
  await signTerms(ctx);
  const c = ctx.rt.engine;
  let step = await play(ctx, await c.next(ctx.id));
  for (const [kind, stage] of [["agent_create", "needs_consent"], ["grant_issue", "needs_policy"], ["policy_update", "needs_funding"]] as const) {
    if (kind === "grant_issue") {
      step = await c.next(ctx.id);
      step = await play(ctx, step); // payout consent
      step = await play(ctx, step); // owner/read consent
    } else if (kind === "policy_update") step = await c.next(ctx.id);
    expect(step).toMatchObject({ kind: "owner_step", action: kind });
    await outsideConfirmation(ctx, step);
    const count = ctx.stub.steps.size;
    const consentCount = ctx.stub.consents.length;
    const first = await c.getContract(ctx.id);
    expect(first.stage).toBe(stage);
    expect(first.next_step).toBeNull();
    expect(ctx.stub.steps.size).toBe(count);
    expect(ctx.stub.consents.length).toBe(consentCount);
    expect((await c.getContract(ctx.id)).stage).toBe(stage);
    expect(ctx.stub.steps.size).toBe(count);
  }
  expect((await c.getContract(ctx.id)).platform.policy).toMatchObject({ revision: 2, applied: true });
  expect(ctx.stub.calls.requestPayout).toBe(0);
});

test("refresh retains unsigned setup and distinct consent requests without changing their nonce", async () => {
  const ctx = await setup();
  await signTerms(ctx);
  const c = ctx.rt.engine;
  let step = await c.next(ctx.id);
  for (const expected of ["setup", "consent_payout", "consent_owner"]) {
    if (expected === "consent_payout") step = await play(ctx, step); // creation
    expect(step).toMatchObject({ kind: "sign", step: expected });
    if (step.kind !== "sign") throw new Error("Expected signature");
    const read = (await c.getContract(ctx.id)).next_step;
    expect(read).toMatchObject({ kind: "sign", step: expected, sign: step.sign });
    expect((await c.getContract(ctx.id)).next_step).toEqual(read);
    step = await play(ctx, step);
  }
});

test("an unsigned external confirmation stays pending on refresh; unavailable status never replaces it", async () => {
  const ctx = await setup(); await signTerms(ctx);
  const c = ctx.rt.engine;
  const step = await play(ctx, await c.next(ctx.id));
  if (step.kind !== "owner_step") throw new Error("Expected creation");
  (ctx.rt.engine as unknown as { d: { db: Database } }).d.db.query("UPDATE owner_steps SET confirm_url = ? WHERE correlation_id = ?").run("https://platform.invalid/confirm/fixture", step.correlation_id);
  const original = ctx.stub.agent.bind(ctx.stub);
  ctx.stub.agent = (org, agent) => ({ ...original(org, agent), ownerStatus: async () => ({ ok: false, kind: "unavailable" }) });
  const view = await c.getContract(ctx.id);
  expect(view.stage).toBe("needs_create");
  expect(view.next_step).toMatchObject({ correlation_id: step.correlation_id });
  expect(ctx.stub.steps.size).toBe(1);
  expect(ctx.stub.agents.get(c.onboarding.agentRow(ctx.id)!.agent!)!.agentId).toBeNull();
});

test("funding refresh advances from needs_funding using observed balance without a new owner action", async () => {
  const ctx = await activate("0");
  const count = ctx.stub.steps.size;
  expect((await ctx.rt.engine.getContract(ctx.id)).stage).toBe("needs_funding");
  await ctx.rt.kit.controls!.fund(ctx.rt.engine.onboarding.agentRow(ctx.id)!.agent_id!, "1000000000");
  expect((await ctx.rt.engine.getContract(ctx.id)).stage).toBe("active");
  expect(ctx.stub.steps.size).toBe(count);
  expect(ctx.stub.calls.requestPayout).toBe(0);
});

test("the stored job list follows the last observed balance without a platform read of its own", async () => {
  const ctx = await activate("0");
  const mine = () => ctx.rt.engine.jobsFor("acme.demo")[0]!;
  // Never observed: the list keeps its cautious readiness state.
  expect(mine().attention.reason_code).not.toBe("funding_required");
  await ctx.rt.engine.getContract(ctx.id);
  expect(mine()).toMatchObject({ stage: "needs_funding", attention: { reason_code: "funding_required", state: "needs_action", actions: [{ role: "agency", label: "Fund the job" }] } });
  await ctx.rt.kit.controls!.fund(ctx.rt.engine.onboarding.agentRow(ctx.id)!.agent_id!, "1000000000");
  // The deposit is invisible to the list until a job read observes it.
  expect(mine().stage).toBe("needs_funding");
  await ctx.rt.engine.getContract(ctx.id);
  expect(mine().stage).toBe("active");
  expect(mine().attention.reason_code).not.toBe("funding_required");
});

test("refresh observes an existing DAO vote without filing the next proposal", async () => {
  const { JOB_DEMO_TERMS } = await import("../src/shared/demo");
  const ctx = await setup({ ...JOB_DEMO_TERMS, agency_owner: { type: "dao", account_id: "agency.sputnik-dao.near" } });
  await signTerms(ctx);
  const request = { id: "original-vote", hash: "ab".repeat(32), description: "Offline setup vote", votingUntil: Date.parse("2026-11-20T13:00:00Z"), proposal: null, proposalAndVote: null };
  let completed = false, filed = 0, unavailable = false;
  Object.assign(ctx.stub, {
    daoSetup: {
      file: async () => { filed++; return { ok: true, value: request }; },
      state: async () => { if (unavailable) throw new Error("fixture transport failure"); return ({ ok: true, value: completed ? { state: "complete", agent: "fixture-agent", consent: { id: "setup-consent" } } : { state: "pending" } }); },
    },
    daoConsent: { file: async () => { throw new Error("Refresh must not file a consent"); }, state: async () => { throw new Error("No consent exists"); } },
  });
  expect(await ctx.rt.engine.next(ctx.id)).toMatchObject({ kind: "dao_vote" });
  expect((await ctx.rt.engine.getContract(ctx.id)).next_step).toMatchObject({ kind: "dao_vote", request });
  unavailable = true;
  const stale = await ctx.rt.engine.getContract(ctx.id);
  expect(stale.stage).toBe("needs_setup");
  expect(stale.next_step).toMatchObject({ kind: "wait", error: "The platform status check failed. Refresh status to try again." });
  expect(stale.signatures.representative).not.toBeNull();
  expect(filed).toBe(1);
  unavailable = false;
  completed = true;
  expect((await ctx.rt.engine.getContract(ctx.id)).stage).toBe("needs_create");
  expect(filed).toBe(1);
  expect(ctx.stub.steps.size).toBe(0);
});
