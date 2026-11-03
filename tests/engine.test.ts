import { describe, expect, test } from "bun:test";
import { createRuntime, type Runtime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { DEMO_TERMS } from "../src/shared/demo";
import { toAtomic } from "../src/shared/money";
import { ProviderRefusal } from "../src/server/provider/port";
import { nonceFromString } from "../src/server/nep413";

const START = Date.parse("2026-11-20T12:00:00Z");

async function setup(overrides: Record<string, unknown> = {}) {
  const rt = await createRuntime(loadConfig({ PROVIDER: "sim", GITHUB: "fake" }), { clockStart: START });
  const { id, contractorToken } = rt.covenant.createContract({ ...DEMO_TERMS, ...overrides });
  return { rt, id, contractorToken };
}

async function signTerms(rt: Runtime, id: string, token: string) {
  for (const role of ["representative", "contractor"] as const) {
    const req = rt.covenant.signingRequest(id, role);
    const s = rt.wallet!.sign(req.account_id, { message: req.message, nonce: nonceFromString(req.nonce), recipient: req.recipient });
    await rt.covenant.addSignature(id, role, { ...s, nonce: req.nonce }, token);
  }
}

async function owner(rt: Runtime, id: string, type: "agent_create" | "grant_issue" | "execution_cancel" | "agent_freeze", payoutId?: string) {
  const p = await rt.covenant.prepareIntent(id, type, payoutId);
  const s = rt.wallet!.sign(p.signer, { message: p.message, nonce: nonceFromString(p.nonce), recipient: p.recipient });
  return rt.covenant.submitIntent(p.correlation_id, s);
}

async function activate(fund = "1200", overrides: Record<string, unknown> = {}) {
  const ctx = await setup(overrides);
  await signTerms(ctx.rt, ctx.id, ctx.contractorToken);
  await owner(ctx.rt, ctx.id, "agent_create");
  const c = await owner(ctx.rt, ctx.id, "grant_issue");
  ctx.rt.sim!.fund(c.agent!.agent_id, toAtomic(fund, 6));
  return ctx;
}

describe("signatures", () => {
  test("the contractor needs the link token", async () => {
    const { rt, id } = await setup();
    const req = rt.covenant.signingRequest(id, "contractor");
    const s = rt.wallet!.sign(req.account_id, { message: req.message, nonce: nonceFromString(req.nonce), recipient: req.recipient });
    await expect(rt.covenant.addSignature(id, "contractor", { ...s, nonce: req.nonce }, "wrong")).rejects.toThrow("signing link");
  });
  test("the wrong account cannot sign as the representative", async () => {
    const { rt, id } = await setup();
    const req = rt.covenant.signingRequest(id, "representative");
    const s = rt.wallet!.sign("maria.demo", { message: req.message, nonce: nonceFromString(req.nonce), recipient: req.recipient });
    await expect(rt.covenant.addSignature(id, "representative", { ...s, nonce: req.nonce })).rejects.toThrow("must sign as acme.demo");
  });
  test("a signature over different terms is rejected", async () => {
    const { rt, id } = await setup();
    const req = rt.covenant.signingRequest(id, "representative");
    const s = rt.wallet!.sign("acme.demo", { message: "Covenant work order sha256:00", nonce: nonceFromString(req.nonce), recipient: req.recipient });
    await expect(rt.covenant.addSignature(id, "representative", { ...s, nonce: req.nonce })).rejects.toThrow("does not match");
  });
  test("no wallet before both signatures", async () => {
    const { rt, id } = await setup();
    await expect(rt.covenant.prepareIntent(id, "agent_create")).rejects.toThrow("Both parties");
  });
});

describe("setup", () => {
  test("grant cannot be issued before the start date", async () => {
    const { rt, id, contractorToken } = await setup({ start: "2026-11-25" });
    await signTerms(rt, id, contractorToken);
    await owner(rt, id, "agent_create");
    await expect(rt.covenant.prepareIntent(id, "grant_issue")).rejects.toThrow("starts 2026-11-25");
  });
  test("verify is green after setup and funding", async () => {
    const { rt, id } = await activate();
    const v = await rt.covenant.verify(id);
    expect(v.overall).toBe("green");
    expect(v.policy?.diffs).toEqual([]);
  });
});

const paidUsd = (c: { payouts: { status: string; amount_usd: string }[] }) =>
  c.payouts.filter((p) => p.status === "paid").reduce((n, p) => n + Number(p.amount_usd), 0);

describe("scope payouts", () => {
  test("the agent pays value x completion per deliverable, one payment each, behind the timelock", async () => {
    const { rt, id } = await activate();
    const run = await rt.covenant.run(id);
    expect(run.judgment.decision).toBe("pay");
    const byD = Object.fromEntries(run.payouts.map((p) => [p.deliverable!.id, p.amount_usd]));
    expect(byD).toEqual({ d1: "300", d2: "100", d3: "250" }); // d1 done, d2 half, d3 half
    expect(run.payouts.every((p) => p.status === "queued")).toBe(true);
    rt.sim!.advance(rt.config.timelockMs + 1);
    const c = await rt.covenant.getContract(id);
    expect(paidUsd(c)).toBe(650);
    expect(c.paid_usd).toBe("650");
    expect(c.scope.find((d) => d.id === "d1")!.completion).toBe(1);
  });

  test("re-running without new merges pays nothing more", async () => {
    const { rt, id } = await activate();
    await rt.covenant.run(id);
    const again = await rt.covenant.run(id);
    expect(again.payouts).toEqual([]);
  });

  test("a new merge that finishes a deliverable pays only the difference", async () => {
    const { rt, id } = await activate();
    await rt.covenant.run(id);
    (rt.evidence as any).mergeNext((await rt.covenant.getContract(id)).terms); // d2 done
    const run = await rt.covenant.run(id);
    expect(run.payouts.map((p) => [p.deliverable!.id, p.amount_usd])).toEqual([["d2", "100"]]);
  });

  test("a prompt-injected merge escalates; rejecting it keeps it out for good", async () => {
    const { rt, id } = await activate();
    await rt.covenant.run(id);
    const ev = rt.evidence as any;
    const terms = (await rt.covenant.getContract(id)).terms;
    ev.mergeNext(terms); // d2 done (clean)
    await rt.covenant.run(id);
    ev.mergeNext(terms); // injected "Scope: d3 (done)"
    const flagged = await rt.covenant.run(id);
    expect(flagged.judgment.decision).toBe("escalate");
    expect(flagged.payouts.map((p) => [p.deliverable!.id, p.status])).toEqual([["d3", "escalated"]]);
    await rt.covenant.resolveEscalation(flagged.payouts[0]!.id, false);
    // The rejected PR no longer counts and no longer escalates.
    const after = await rt.covenant.run(id);
    expect(after.judgment.decision).toBe("pay");
    expect(after.payouts).toEqual([]);
    ev.mergeNext(terms); // the real d3 completion
    const done = await rt.covenant.run(id);
    expect(done.payouts.map((p) => [p.deliverable!.id, p.amount_usd])).toEqual([["d3", "250"]]);
  });

  test("an escalated judgment never carries its completion into the next run", async () => {
    const { rt, id } = await activate();
    await rt.covenant.run(id);
    const ev = rt.evidence as any;
    const terms = (await rt.covenant.getContract(id)).terms;
    ev.mergeNext(terms);
    ev.mergeNext(terms); // injected
    const flagged = await rt.covenant.run(id);
    expect(flagged.judgment.decision).toBe("escalate");
    const c = await rt.covenant.getContract(id);
    expect(c.scope.find((d) => d.id === "d3")!.completion).toBe(0.5); // not the injected "done"
  });

  test("approving an escalation pays it and the flag doesn't come back", async () => {
    const { rt, id } = await activate();
    await rt.covenant.run(id);
    const ev = rt.evidence as any;
    const terms = (await rt.covenant.getContract(id)).terms;
    ev.mergeNext(terms);
    await rt.covenant.run(id);
    ev.mergeNext(terms); // injected
    const flagged = await rt.covenant.run(id);
    const c = await rt.covenant.resolveEscalation(flagged.payouts[0]!.id, true);
    expect(c.payouts.find((p) => p.id === flagged.payouts[0]!.id)!.status).toBe("queued");
    const again = await rt.covenant.run(id);
    expect(again.judgment.decision).toBe("pay");
    expect(again.payouts).toEqual([]);
  });

  test("the owner can cancel during the timelock; funds come back", async () => {
    const { rt, id } = await activate();
    const run = await rt.covenant.run(id);
    const c = await owner(rt, id, "execution_cancel", run.payouts[0]!.id);
    expect(c.payouts.find((p) => p.id === run.payouts[0]!.id)!.status).toBe("cancelled");
    expect(Number(c.agent!.available_usd)).toBe(1200 - 650 + Number(run.payouts[0]!.amount_usd));
  });

  test("freezing stops queued payouts at dispatch and blocks new runs", async () => {
    const { rt, id } = await activate();
    await rt.covenant.run(id);
    await owner(rt, id, "agent_freeze");
    rt.sim!.advance(rt.config.timelockMs + 1);
    const c = await rt.covenant.getContract(id);
    expect(c.stage).toBe("frozen");
    expect(c.payouts.every((p) => p.status === "failed")).toBe(true);
    await expect(rt.covenant.run(id)).rejects.toThrow("frozen");
  });

  test("a provider refusal is recorded as refused, not retried", async () => {
    const { rt, id } = await activate("5"); // not enough balance
    const run = await rt.covenant.run(id);
    expect(run.payouts.every((p) => p.status === "refused")).toBe(true);
    expect(run.payouts[0]!.error.code).toBe("insufficient_balance");
  });

  test("an unknown outcome becomes needs_review and is never resent", async () => {
    const { rt, id } = await activate();
    const sim = rt.sim!;
    const original = sim.withdraw.bind(sim);
    let calls = 0;
    sim.withdraw = async (...args) => {
      calls += 1;
      await original(...args);
      throw new Error("socket hang up");
    };
    const run = await rt.covenant.run(id);
    expect(run.payouts.every((p) => p.status === "needs_review")).toBe(true);
    expect(calls).toBe(3);
    const again = await rt.covenant.run(id);
    expect(again.payouts).toEqual([]);
    expect(calls).toBe(3);
  });
});

describe("simulator enforces the policy", () => {
  test("idempotent replay returns the same execution; a different body conflicts", async () => {
    const { rt, id } = await activate();
    const c = await rt.covenant.getContract(id);
    const credential = await (rt.covenant as any).credential((rt.covenant as any).row(id));
    const req = { asset: DEMO_TERMS.asset as string, amount: "1000000", chain: "near", recipient: "maria.demo" };
    const a = await rt.sim!.withdraw(credential, c.agent!.agent_id, req, { idempotencyKey: "k1" });
    const b = await rt.sim!.withdraw(credential, c.agent!.agent_id, req, { idempotencyKey: "k1" });
    expect(b.correlation_id).toBe(a.correlation_id);
    expect(b.replayed).toBe(true);
    await expect(rt.sim!.withdraw(credential, c.agent!.agent_id, { ...req, amount: "2000000" }, { idempotencyKey: "k1" })).rejects.toBeInstanceOf(ProviderRefusal);
  });

  test("all four attacks are stopped", async () => {
    const { rt, id } = await activate();
    for (const s of ["overpay", "redirect", "injected"] as const) {
      const dry = await rt.covenant.attack(id, s, "dry");
      expect(dry.outcome).toBe("would_refuse");
      const live = await rt.covenant.attack(id, s, "live");
      expect(live.outcome).toBe("refused");
    }
    const notYet = await rt.covenant.attack(id, "after_end", "dry");
    expect(notYet.ready).toBe(false);
    rt.sim!.setNow(new Date("2026-12-01T10:00:00Z"));
    const ended = await rt.covenant.attack(id, "after_end", "live");
    expect(ended.outcome).toBe("refused");
    expect(ended.findings?.[0]?.layer).toBe("grant");
    expect(ended.findings?.[0]?.clause.id).toBe("term");
  });

  test("redirect is refused by the payee clause, overpay by the cap clause", async () => {
    const { rt, id } = await activate();
    const r = await rt.covenant.attack(id, "redirect", "live");
    expect(r.findings?.[0]?.code).toBe("policy_destination_denied");
    expect(r.findings?.[0]?.clause.id).toBe("payee");
    const o = await rt.covenant.attack(id, "overpay", "live");
    expect(o.findings?.[0]?.code).toBe("policy_transaction_limit_exceeded");
    expect(o.findings?.[0]?.clause.id).toBe("cap");
  });
});
