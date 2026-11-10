// Regression tests for the review of #6, on the FakePlatform harness.
import { expect, test } from "bun:test";
import { createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import type { FakeControls } from "../src/server/platform/fake";
import { DEMO_TERMS } from "../src/shared/demo";
import { fakeActivate, fakeApproveAndSettle, fakeVote } from "./support/fake-harness";
import { START } from "./support/harness";

const payouts = async (ctx: any) => (await ctx.rt.covenant.getContract(ctx.id)).payouts.filter((p: any) => p.kind === "payout");

test("a FAILED policy edit stops with an error for the owner instead of looping", async () => {
  const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules" }), { clockStart: START, log: () => {} });
  const { id, contractorToken } = rt.covenant.createContract({ ...DEMO_TERMS });
  const sign = (p: any) => rt.kit.devSigner!.sign413(p);
  for (const role of ["representative", "contractor"] as const) {
    const req = rt.covenant.signingRequest(id, role);
    const s = await sign(req);
    await rt.covenant.addSignature(id, role, { account_id: req.account_id, public_key: s.publicKey, signature: s.signature, nonce: req.nonce }, contractorToken);
  }
  const controls = rt.kit.controls as FakeControls;
  // A hang here would also starve this guard's timer, so count calls instead of racing a timeout.
  let calls = 0;
  const realNext = rt.covenant.onboarding.next.bind(rt.covenant.onboarding);
  rt.covenant.onboarding.next = (cid: string) => {
    if (++calls > 50) throw new Error("onboarding.next() recursed more than 50 times");
    return realNext(cid);
  };
  let next: any = await rt.covenant.next(id);
  for (let i = 0; i < 20; i++) {
    if (next.kind === "sign") {
      const s = await sign(next.sign);
      next = await rt.covenant.signed(id, { step: next.step, nonce: next.sign.nonce, publicKey: s.publicKey, signature: s.signature });
    } else if (next.kind === "owner_step") {
      const step = rt.covenant.onboarding.step(next.correlation_id);
      await rt.covenant.submitOwnerStep(next.correlation_id, await sign(next.sign!));
      if (step.kind === "policy_update") {
        controls.setPolicyStatus(rt.covenant.onboarding.agentRow(id)!.agent_id!, "FAILED", false);
        calls = 0;
        await expect(rt.covenant.next(id)).rejects.toThrow("FAILED");
        expect(rt.covenant.onboarding.step(step.correlation_id).state).toBe("failed");
        await expect(rt.covenant.next(id)).rejects.toThrow("FAILED"); // stable: asked again, the same answer
        expect(rt.covenant.onboarding.agentRow(id)!.stage).toBe("policy_pending"); // no new edit prepared
        return;
      }
      next = await rt.covenant.next(id);
    } else next = await rt.covenant.next(id);
  }
  throw new Error("never reached the policy step");
});

test("a payout blocked before sending can be dropped, and frees its amount", async () => {
  const ctx = await fakeActivate();
  const p1 = (await ctx.rt.covenant.run(ctx.id)).payouts[0]!.request_id;
  ctx.rt.clock.set(new Date("2026-11-30T23:55:00Z"));
  await fakeVote(ctx, p1, "approve");
  await ctx.controls.settle(ctx.rt.covenant.attempt(p1).correlation_id!);
  const [p2] = await payouts(ctx);
  expect(`${p2.state} ${p2.code}`).toBe("blocked contract_ending");
  const c = await ctx.rt.covenant.drop(ctx.id);
  const after = c.payouts.find((p: any) => p.request_id === p2.request_id)!;
  expect(after.state).toBe("dropped");
  // Only p1's amount is still committed: the dropped p2 freed its own.
  const committed = c.scope.reduce((n: number, d: any) => n + Number(d.committed_usd), 0);
  expect(committed).toBe(Number(c.payouts.find((p: any) => p.request_id === p1)!.amount_usd));
});

test("a payout blocked recipient_not_found can be dropped", async () => {
  const ctx = await fakeActivate();
  (ctx.rt.kit.chain as any).setMissing(DEMO_TERMS.payee.address, true);
  await ctx.rt.covenant.run(ctx.id);
  const [p] = await payouts(ctx);
  expect(`${p.state} ${p.code}`).toBe("blocked recipient_not_found");
  await ctx.rt.covenant.drop(ctx.id);
  expect((await payouts(ctx))[0].state).toBe("dropped");
});

test("an anonymous contract read sends nothing when sign-in is required", async () => {
  const ctx = await fakeActivate();
  const p1 = (await ctx.rt.covenant.run(ctx.id)).payouts[0]!.request_id;
  const v = await ctx.rt.covenant.vote(p1, "approve");
  await ctx.rt.covenant.submitOwnerStep(v.correlation_id, await ctx.sign(v.sign!));
  (ctx.rt.config as any).auth.required = true;
  const before = ctx.controls.requests().length;
  const res = await ctx.rt.app.request(`/api/contracts/${ctx.id}`);
  expect(res.status).toBe(200);
  expect(ctx.controls.requests().length).toBe(before);
  await ctx.rt.covenant.getContract(ctx.id); // the representative's read still moves it along
  expect(ctx.controls.requests().length).toBe(before + 1);
});

test("a frozen agent blocks payouts as frozen", async () => {
  const ctx = await fakeActivate();
  const a = ctx.rt.covenant.onboarding.agentRow(ctx.id)!;
  const prepared = await ctx.rt.covenant.onboarding.handle(a).ownerPrepare({ type: "agent_freeze" } as any);
  if (!prepared.ok || !prepared.value.confirm) throw new Error("freeze not prepared");
  await ctx.controls.completeConfirm(prepared.value.confirm.url);
  await ctx.rt.covenant.run(ctx.id).catch(() => {});
  const att = (ctx.rt.covenant as any).attempts(ctx.id).find((x: any) => x.kind === "payout");
  if (att) expect(`${att.state} ${att.code}`).toBe("blocked frozen");
  expect((ctx.rt.covenant as any).row(ctx.id).frozen).toBe(1);
});

test("an APPLIED policy at or below the revision the edit was prepared against does not end the wait", async () => {
  const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules" }), { clockStart: START, log: () => {} });
  const { id, contractorToken } = rt.covenant.createContract({ ...DEMO_TERMS });
  const sign = (p: any) => rt.kit.devSigner!.sign413(p);
  for (const role of ["representative", "contractor"] as const) {
    const req = rt.covenant.signingRequest(id, role);
    const s = await sign(req);
    await rt.covenant.addSignature(id, role, { account_id: req.account_id, public_key: s.publicKey, signature: s.signature, nonce: req.nonce }, contractorToken);
  }
  let next: any = await rt.covenant.next(id);
  for (let i = 0; i < 20; i++) {
    if (next.kind === "sign") {
      const s = await sign(next.sign);
      next = await rt.covenant.signed(id, { step: next.step, nonce: next.sign.nonce, publicKey: s.publicKey, signature: s.signature });
    } else if (next.kind === "owner_step") {
      const step = rt.covenant.onboarding.step(next.correlation_id);
      await rt.covenant.submitOwnerStep(next.correlation_id, await sign(next.sign!));
      if (step.kind === "policy_update") {
        const agentId = rt.covenant.onboarding.agentRow(id)!.agent_id!;
        const agent = [...(rt.kit.controls as any).p.state.agents.values()].find((x: any) => x.agentId === agentId);
        const preparedAt = JSON.parse(step.action).expectedPolicy.revision;
        const landed = agent.revision;
        agent.revision = preparedAt; // the provider still reports the earlier revision as in force
        next = await rt.covenant.next(id);
        expect(next.kind).toBe("wait");
        expect(rt.covenant.onboarding.agentRow(id)!.stage).toBe("policy_pending");
        agent.revision = landed;
        expect((await rt.covenant.next(id)).kind).toBe("done");
        return;
      }
      next = await rt.covenant.next(id);
    } else next = await rt.covenant.next(id);
  }
  throw new Error("never reached the policy step");
});

// ---------------------------------------------------------------- the whole live policy, before every request

const agentIdOf = (ctx: any): string => ctx.rt.covenant.onboarding.agentRow(ctx.id)!.agent_id!;
const allAttempts = (ctx: any): any[] => (ctx.rt.covenant as any).attempts(ctx.id);
const events = async (ctx: any): Promise<any[]> => (await ctx.rt.covenant.viewContract(ctx.id)).events;

test("a live policy that differs from the signed terms anywhere blocks the request as policy_mismatch, alerts, and turns Verify red", async () => {
  const ctx = await fakeActivate();
  const agentId = agentIdOf(ctx);
  ctx.controls.editPolicy(agentId, (p) => {
    p.assets = "any";
    delete p.limits.monthly;
    p.budget.monthly_usd = null;
  });
  const before = ctx.controls.requests().length;
  await ctx.rt.covenant.run(ctx.id);
  expect(ctx.controls.requests().length).toBe(before); // nothing was asked of the platform
  const att = allAttempts(ctx).find((a) => a.kind === "payout");
  expect(`${att.state} ${att.code}`).toBe("blocked policy_mismatch");
  expect((await events(ctx)).filter((e) => e.kind === "alert" && e.text.includes("differs from the signed terms")).length).toBe(1);
  const v = await ctx.rt.covenant.verify(ctx.id);
  expect(v.overall).toBe("red");
  expect(v.checks.find((c) => c.id === "signed")!.ok).toBe(false);
  // Re-checked on the timer: still blocked, still nothing sent, and the alert is not repeated.
  ctx.rt.clock.advance(120_000);
  await ctx.rt.covenant.getContract(ctx.id);
  expect(ctx.controls.requests().length).toBe(before);
  expect((await events(ctx)).filter((e) => e.kind === "alert").length).toBe(1);
});

test("each signed field counts: daily limit, budget, actions", async () => {
  for (const edit of [
    (p: any) => (p.limits.daily = { [DEMO_TERMS.asset]: "1" }),
    (p: any) => (p.budget.daily_usd = "1000000"),
    (p: any) => p.actions.push("transfer"),
  ]) {
    const ctx = await fakeActivate();
    ctx.controls.editPolicy(agentIdOf(ctx), edit);
    await ctx.rt.covenant.run(ctx.id);
    expect(allAttempts(ctx).find((a) => a.kind === "payout").code).toBe("policy_mismatch");
    expect(ctx.controls.requests().length).toBe(0);
  }
});

test("a revision bump whose policy still matches is fine, and becomes the stored reviewed revision", async () => {
  const ctx = await fakeActivate();
  const stored = ctx.rt.covenant.onboarding.agentRow(ctx.id)!.policy_revision!;
  ctx.controls.editPolicy(agentIdOf(ctx), () => {}); // e.g. a freeze and unfreeze: same policy, new revision
  const r = await ctx.rt.covenant.run(ctx.id);
  expect(r.payouts[0]!.state).toBe("held");
  const row = ctx.rt.covenant.onboarding.agentRow(ctx.id)!;
  expect(row.policy_revision).toBe(stored + 1);
  expect((ctx.controls.requests()[0] as any).expectedPolicy.revision).toBe(stored + 1);
  expect((await ctx.rt.covenant.verify(ctx.id)).overall).toBe("green");
});

test("a mismatched policy put back to the signed terms lets the same request id go out", async () => {
  const ctx = await fakeActivate();
  const agentId = agentIdOf(ctx);
  const original = ctx.controls.policyOf(agentId)!;
  ctx.controls.editPolicy(agentId, (p) => (p.owner_approval = false));
  await ctx.rt.covenant.run(ctx.id);
  const att = allAttempts(ctx).find((a) => a.kind === "payout");
  expect(att.code).toBe("policy_mismatch");
  ctx.controls.editPolicy(agentId, (p) => Object.assign(p, original));
  ctx.rt.clock.advance(120_000);
  await ctx.rt.covenant.getContract(ctx.id);
  expect(ctx.rt.covenant.attempt(att.request_id).state).toBe("held");
  expect((ctx.controls.requests()[0] as any).requestId).toBe(att.request_id);
});

// ---------------------------------------------------------------- a freeze is reversible

async function freeze(ctx: any) {
  const a = ctx.rt.covenant.onboarding.agentRow(ctx.id)!;
  const prepared = await ctx.rt.covenant.onboarding.handle(a).ownerPrepare({ type: "agent_freeze" });
  if (!prepared.ok || !prepared.value.confirm) throw new Error("freeze not prepared");
  await ctx.controls.completeConfirm(prepared.value.confirm.url);
}

test("frozen: the contract shows frozen and nothing is requested; unfrozen: the flag clears and payouts continue", async () => {
  const ctx = await fakeActivate();
  const p1 = (await ctx.rt.covenant.run(ctx.id)).payouts[0]!.request_id;
  await fakeApproveAndSettle(ctx, p1); // p2 is requested after p1 settles
  const p2 = allAttempts(ctx).find((a) => a.kind === "payout" && a.request_id !== p1);
  await fakeVote(ctx, p2.request_id, "reject"); // close that judgment, so a new run has something to judge
  await freeze(ctx);
  const frozen = await ctx.rt.covenant.getContract(ctx.id);
  expect(frozen.stage).toBe("frozen");
  const before = ctx.controls.requests().length;
  await expect(ctx.rt.covenant.run(ctx.id)).rejects.toThrow("until they unfreeze");
  expect(ctx.controls.requests().length).toBe(before);
  expect(ctx.rt.covenant.activeContractIds()).toContain(ctx.id); // the merge watcher keeps checking it
  ctx.controls.editPolicy(agentIdOf(ctx), (p) => (p.frozen = false)); // the owner unfreezes on the platform
  const back = await ctx.rt.covenant.getContract(ctx.id);
  expect(back.stage).not.toBe("frozen");
  expect((ctx.rt.covenant as any).row(ctx.id).frozen).toBe(0);
  expect(back.events.some((e: any) => e.kind === "freeze" && e.text.includes("unfroze"))).toBe(true);
  const r = await ctx.rt.covenant.run(ctx.id);
  expect(r.outcome).not.toBe("deferred");
});

test("a payout blocked as frozen goes out under the same id once the owner unfreezes", async () => {
  const ctx = await fakeActivate();
  const chain = ctx.rt.kit.chain as any;
  chain.setMissing(DEMO_TERMS.payee.address, true);
  await ctx.rt.covenant.run(ctx.id); // blocked before recording: recipient_not_found
  const p1 = allAttempts(ctx).find((a) => a.kind === "payout");
  await freeze(ctx);
  chain.setMissing(DEMO_TERMS.payee.address, false);
  ctx.rt.clock.advance(120_000);
  await ctx.rt.covenant.followUpAll();
  expect(`${ctx.rt.covenant.attempt(p1.request_id).state} ${ctx.rt.covenant.attempt(p1.request_id).code}`).toBe("blocked frozen");
  const sent = ctx.controls.requests().length;
  ctx.controls.editPolicy(agentIdOf(ctx), (p) => (p.frozen = false));
  ctx.rt.clock.advance(120_000);
  await ctx.rt.covenant.followUpAll();
  expect(ctx.rt.covenant.attempt(p1.request_id).state).toBe("held");
  expect((ctx.controls.requests()[sent] as any).requestId).toBe(p1.request_id);
  expect((ctx.rt.covenant as any).row(ctx.id).frozen).toBe(0);
});

// ---------------------------------------------------------------- the payout grant lasts 30 days, contracts up to 365

test("an expired payout grant blocks the request as grant_expired and sends the representative back to grant_issue", async () => {
  const ctx = await fakeActivate("1000", { end: "2027-06-30" });
  // Within the margin of the platform's 30-day grant.
  ctx.rt.clock.advance(30 * 86_400_000 - 3_600_000);
  const before = ctx.controls.requests().length;
  await ctx.rt.covenant.run(ctx.id);
  expect(ctx.controls.requests().length).toBe(before);
  const att = allAttempts(ctx).find((a) => a.kind === "payout");
  expect(`${att.state} ${att.code}`).toBe("blocked grant_expired");
  expect(ctx.rt.covenant.onboarding.agentRow(ctx.id)!.stage).toBe("needs_grant");
  expect((await ctx.rt.covenant.viewContract(ctx.id)).stage).toBe("needs_grant");
  await expect(ctx.rt.covenant.run(ctx.id)).rejects.toThrow("grant has expired");
  // NextStep shows the grant step; once it is signed the contract is ready again, without a new policy edit.
  const next: any = await ctx.rt.covenant.next(ctx.id);
  expect(next.kind).toBe("owner_step");
  expect(next.action).toBe("grant_issue");
  await ctx.rt.covenant.submitOwnerStep(next.correlation_id, await ctx.sign(next.sign!));
  expect((await ctx.rt.covenant.next(ctx.id)).kind).toBe("done");
  expect(ctx.rt.covenant.onboarding.agentRow(ctx.id)!.stage).toBe("ready");
  // The blocked payout goes out under the same id.
  ctx.rt.clock.advance(120_000);
  await ctx.rt.covenant.getContract(ctx.id);
  expect(ctx.rt.covenant.attempt(att.request_id).state).toBe("held");
  expect((ctx.controls.requests()[before] as any).requestId).toBe(att.request_id);
});
