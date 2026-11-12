import { describe, expect, test } from "bun:test";
import type { OwnerAction } from "../src/server/platform/port";
import { USDC_NEAR } from "../src/shared/terms";
import { activate, onboard, play, setup, signTerms } from "./support/harness";

describe("onboarding: setup → create → two consents → grant → one policy edit", () => {
  test("no platform step before both parties signed", async () => {
    const ctx = await setup();
    await expect(ctx.rt.engine.next(ctx.id)).rejects.toThrow("Both parties");
  });

  test("the steps come in order and end with the policy in force", async () => {
    const ctx = await setup();
    await signTerms(ctx);
    const seen: string[] = [];
    let next = await ctx.rt.engine.next(ctx.id);
    for (let i = 0; i < 20 && next.kind !== "done"; i++) {
      seen.push(next.kind === "sign" ? next.step : next.kind === "owner_step" ? next.action : next.kind);
      next = await play(ctx, next);
    }
    expect(seen).toEqual(["setup", "agent_create", "consent_payout", "consent_owner", "grant_issue", "policy_update"]);
    const c = await ctx.rt.engine.getContract(ctx.id);
    expect(c.stage).toBe("needs_funding");
    expect(c.platform.policy).toEqual({ revision: 2, digest: "dg-2", applied: true });
    expect(c.organization).toBe(ctx.id);
  });

  test("setup is signed for the platform host and names the organization and owner", async () => {
    const ctx = await setup();
    await signTerms(ctx);
    const next = await ctx.rt.engine.next(ctx.id);
    if (next.kind !== "sign") throw new Error("expected a sign step");
    expect(next.sign.recipient).toBe(ctx.stub.host);
    expect(next.sign.account_id).toBe("acme.demo");
    expect(JSON.parse(next.sign.message.split("\n")[1]!)).toMatchObject({ organization: ctx.id, owner: "acme.demo", area: "payables" });
  });

  test("consents: [payout] until the contract end; [owner, read] until end + grace", async () => {
    const ctx = await setup({}, { CONSENT_GRACE_DAYS: "10" });
    await signTerms(ctx);
    await onboard(ctx);
    const cs = ctx.stub.consents.filter((c) => c.agentId);
    expect(cs.map((c) => [c.scopes.join(","), c.expiresAt])).toEqual([
      ["payout", "2026-11-30T23:59:59.000Z"],
      ["owner,read", "2026-12-10T23:59:59.000Z"],
    ]);
  });

  test("the one policy edit carries withdrawals, owner approval, three limits and the budget, against the reviewed policy", async () => {
    const ctx = await setup();
    await signTerms(ctx);
    await onboard(ctx);
    const edit = [...ctx.stub.steps.values()].map((s) => s.action).find((a): a is Extract<OwnerAction, { type: "policy_update" }> => a.type === "policy_update")!;
    expect(edit.expectedPolicy).toEqual({ revision: 1, digest: "dg-1" });
    expect(edit.changes).toEqual({
      withdrawals: [{ address: "maria.demo" }],
      owner_approval: true,
      limits: { per_transaction: { [USDC_NEAR]: "500000000" }, daily: { [USDC_NEAR]: "1000000000" }, monthly: { [USDC_NEAR]: "1000000000" } },
      budget: { daily_usd: "1050", weekly_usd: null, monthly_usd: "1050" },
    });
  });

  test("agent_create names the key that signed the setup", async () => {
    const ctx = await setup();
    await signTerms(ctx);
    await onboard(ctx);
    const create = [...ctx.stub.steps.values()].map((s) => s.action).find((a) => a.type === "agent_create")!;
    expect(create).toEqual({ type: "agent_create", owner: { type: "near", account_id: "acme.demo", public_key: ctx.stub.publicKey }, role: "payout" });
  });

  test("a signature for a stale step is refused", async () => {
    const ctx = await setup();
    await signTerms(ctx);
    const next = await ctx.rt.engine.next(ctx.id);
    if (next.kind !== "sign") throw new Error("expected a sign step");
    const s = ctx.stub.sign(next.sign);
    await expect(ctx.rt.engine.signed(ctx.id, { step: "consent_payout", nonce: next.sign.nonce, publicKey: s.publicKey, signature: s.signature })).rejects.toThrow("current step");
  });

  test("a lost owner/submit reply is answered by reading the status, never by signing again", async () => {
    const ctx = await setup();
    await signTerms(ctx);
    let next = await play(ctx, await ctx.rt.engine.next(ctx.id)); // setup done → agent_create
    if (next.kind !== "owner_step") throw new Error("expected agent_create");
    const h = ctx.stub.agent(ctx.id, `agt_${ctx.id}`);
    const realAgent = ctx.stub.agent.bind(ctx.stub);
    let lost = true;
    ctx.stub.agent = (org, agent) => {
      const handle = realAgent(org, agent);
      return {
        ...handle,
        ownerSubmit: async (...args) => {
          const r = await handle.ownerSubmit(...args);
          if (lost) {
            lost = false;
            return { ok: false, kind: "unavailable" };
          }
          return r;
        },
      };
    };
    const step = await ctx.rt.engine.submitOwnerStep(next.correlation_id, ctx.stub.sign(next.sign!));
    expect(step.state).toBe("unknown");
    expect(h).toBeDefined();
    next = await ctx.rt.engine.next(ctx.id); // polls owner/status, sees SUCCESS, moves on
    expect(next).toMatchObject({ kind: "sign", step: "consent_payout" });
    await expect(ctx.rt.engine.submitOwnerStep(step.correlation_id, ctx.stub.sign({ message: "x", recipient: "y", nonce: next.kind === "sign" ? next.sign.nonce : "" }))).rejects.toThrow("already");
  });

  test("a contract ending within two minutes can't get consents", async () => {
    const ctx = await setup({ start: "2026-11-01", end: "2026-11-20" });
    ctx.rt.clock.set(new Date("2026-11-20T23:58:30Z"));
    await signTerms(ctx);
    let next = await ctx.rt.engine.next(ctx.id);
    next = await play(ctx, next);
    await expect(play(ctx, next)).rejects.toThrow("ends too soon");
  });

  test("deposit returns the platform's address and is stored on the contract", async () => {
    const ctx = await activate("0");
    const dep = await ctx.rt.engine.deposit(ctx.id);
    expect(dep.address).toContain("deposit.");
    expect((await ctx.rt.engine.getContract(ctx.id)).platform.deposit).toEqual(dep);
  });

  test("funding exactly the total makes the contract active", async () => {
    const ctx = await activate("1000");
    const c = await ctx.rt.engine.getContract(ctx.id);
    expect([c.stage, c.platform.balance_usd]).toEqual(["active", "1000"]);
  });
});
