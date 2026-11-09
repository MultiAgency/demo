import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db";
import { DEMO_TERMS } from "../src/shared/demo";
import type { Judgment } from "../src/server/judge";
import { type FCtx, fakeActivate, fakeApproveAndSettle, fakeVote } from "./support/fake-harness";
import { type Ctx, activate, agentId, approveAndSettle, attemptOf, castVote, evidence, livePayout, setup, signTerms } from "./support/harness";

const M = (usd: number) => (BigInt(usd) * 1_000_000n).toString();

/** Swap the judge for one that returns fixed completion levels. */
function fixedJudge(ctx: Ctx, completion: Record<string, number>) {
  (ctx.rt.covenant as unknown as { d: { judge: unknown } }).d.judge = {
    kind: "rules",
    judge: async (terms: { scope: { id: string }[] }): Promise<Judgment> => ({
      judge: "rules",
      decision: "pay",
      summary: "fixed",
      prs: [],
      deliverables: terms.scope.map((d) => ({ id: d.id, completion: (completion[d.id] ?? 0) as 0, prs: [], reason: "fixed" })),
    }),
  };
}
const run = (ctx: Ctx) => ctx.rt.covenant.run(ctx.id);
const view = (ctx: Ctx) => ctx.rt.covenant.getContract(ctx.id);
const tick = (ctx: Ctx, ms = 61_000) => ctx.rt.clock.advance(ms);
const stubAgent = (ctx: Ctx) => ctx.stub.agents.get(`agt_${ctx.id}`)!;

describe("term signatures", () => {
  test("the contractor needs the link token", async () => {
    const ctx = await setup();
    const req = ctx.rt.covenant.signingRequest(ctx.id, "contractor");
    const s = ctx.stub.sign(req);
    await expect(ctx.rt.covenant.addSignature(ctx.id, "contractor", { account_id: req.account_id, public_key: s.publicKey, signature: s.signature, nonce: req.nonce }, "wrong")).rejects.toThrow("signing link");
  });
  test("the wrong account cannot sign as the representative", async () => {
    const ctx = await setup();
    const req = ctx.rt.covenant.signingRequest(ctx.id, "representative");
    const s = ctx.stub.sign(req);
    await expect(ctx.rt.covenant.addSignature(ctx.id, "representative", { account_id: "maria.demo", public_key: s.publicKey, signature: s.signature, nonce: req.nonce })).rejects.toThrow("must sign as acme.demo");
  });
  test("a signature over different terms is rejected", async () => {
    const ctx = await setup();
    const req = ctx.rt.covenant.signingRequest(ctx.id, "representative");
    const s = ctx.stub.sign({ ...req, message: "Covenant work order sha256:00" });
    await expect(ctx.rt.covenant.addSignature(ctx.id, "representative", { account_id: "acme.demo", public_key: s.publicKey, signature: s.signature, nonce: req.nonce })).rejects.toThrow("does not match");
  });
  test("an unregistered payee is flagged at signing", async () => {
    const ctx = await setup();
    ctx.stub.script.unregistered.add("maria.demo");
    await signTerms(ctx);
    const c = await view(ctx);
    expect(c.payee_registered).toBe(false);
    expect(c.events.some((e) => e.kind === "warning")).toBe(true);
  });
});

describe("judged payouts, held for approval", () => {
  test("the run requests min(owed, largest deliverable), held, with no memo in the request (bug 1)", async () => {
    const ctx = await activate();
    const r = await run(ctx);
    expect(r.outcome).toBe("requested");
    const p = r.payouts[0]!;
    expect([p.state, p.amount_usd, p.seq, p.attempt]).toEqual(["held", "500", 1, 1]);
    expect(p.lines.map((l) => [l.deliverable_id, l.amount_usd])).toEqual([["d1", "300"], ["d2", "100"], ["d3", "100"]]);
    expect(p.approval?.approval_id).toBeTruthy();
    const body = ctx.stub.calls.bodies[0]!;
    expect(Object.keys(body).sort()).toEqual(["amount", "expectedPolicy", "recipient", "requestId"]);
    expect(body).not.toHaveProperty("memo");
  });

  test("approve → paid → next seq on the same judgment → approved → completion carries forward", async () => {
    const ctx = await activate();
    const r = await run(ctx);
    let c = await approveAndSettle(ctx, r.payouts[0]!.request_id);
    const first = c.payouts.find((p) => p.request_id === r.payouts[0]!.request_id)!;
    expect(first.state).toBe("paid");
    expect(first.tx_hash).toMatch(/^SIMTX/);
    const next = c.payouts.find((p) => p.state === "held")!;
    expect([next.seq, next.amount_usd, c.open_judgment?.id]).toEqual([2, "150", r.judgment!.id]);
    c = await approveAndSettle(ctx, next.request_id);
    expect(c.paid_usd).toBe("650");
    expect(c.open_judgment).toBeNull();
    expect((c.judgment as { outcome: string }).outcome).toBe("approved");
    expect(c.scope.find((d) => d.id === "d1")!.completion).toBe(1);
    expect((await run(ctx)).outcome).toBe("nothing");
  });

  test("a run while a judgment is open is deferred and makes no call", async () => {
    const ctx = await activate();
    await run(ctx);
    const calls = ctx.stub.calls.requestPayout;
    const again = await run(ctx);
    expect(again.outcome).toBe("deferred");
    expect(ctx.stub.calls.requestPayout).toBe(calls + 0 * 1); // only follow-up status reads, no request
    expect((await view(ctx)).events[0]!.kind).toBe("deferred");
  });

  test("reject → the run's new PRs are excluded and the next run requests nothing (#2)", async () => {
    const ctx = await activate();
    await approveAndSettle(ctx, (await run(ctx)).payouts[0]!.request_id);
    await approveAndSettle(ctx, (await livePayout(ctx))!.request_id);
    const terms = (await view(ctx)).terms;
    evidence(ctx).mergeNext(terms); // d2 done
    await approveAndSettle(ctx, (await run(ctx)).payouts[0]!.request_id);
    evidence(ctx).mergeNext(terms); // injected "Scope: d3 (done)"
    const flagged = await run(ctx);
    const p = flagged.payouts[0]!;
    expect(p.prs.some((x) => x.flags.includes("possible_prompt_injection"))).toBe(true);
    const c = await castVote(ctx, p.request_id, "reject");
    expect(c.payouts.find((x) => x.request_id === p.request_id)!.state).toBe("rejected");
    expect((c.judgment as { outcome: string }).outcome).toBe("rejected");
    expect(c.committed_usd).toBe("750");
    const after = await run(ctx);
    expect(after.outcome).toBe("nothing");
    expect(after.judgment!.prs.some((x) => x.number === 108)).toBe(false);
    evidence(ctx).mergeNext(terms); // the real d3 completion
    expect((await run(ctx)).payouts[0]!.amount_usd).toBe("250");
  });

  test("seq 1 approved + seq 2 rejected → judgment rejected, no re-request, $500 stays paid", async () => {
    const ctx = await activate();
    await approveAndSettle(ctx, (await run(ctx)).payouts[0]!.request_id);
    const seq2 = (await livePayout(ctx))!;
    const c = await castVote(ctx, seq2.request_id, "reject");
    expect(c.open_judgment).toBeNull();
    expect(c.paid_usd).toBe("500");
    const calls = ctx.stub.calls.requestPayout;
    expect((await run(ctx)).outcome).toBe("nothing");
    expect(ctx.stub.calls.requestPayout).toBe(calls);
  });

  test("d1+d3 = $800 with a $500 cap → $500, then $300 on the same judgment", async () => {
    const ctx = await activate();
    fixedJudge(ctx, { d1: 1, d3: 1 });
    const r = await run(ctx);
    expect(r.payouts[0]!.amount_usd).toBe("500");
    const c = await approveAndSettle(ctx, r.payouts[0]!.request_id);
    const second = c.payouts.find((p) => p.state === "held")!;
    expect([second.amount_usd, second.seq, second.lines.map((l) => `${l.deliverable_id}:${l.amount_usd}`).join(",")]).toEqual(["300", 2, "d3:300"]);
    expect(c.open_judgment?.id).toBe(r.judgment!.id);
  });

  test("an escalated (flagged) judgment is still requested; the platform holds it", async () => {
    const ctx = await activate();
    await approveAndSettle(ctx, (await run(ctx)).payouts[0]!.request_id);
    await approveAndSettle(ctx, (await livePayout(ctx))!.request_id);
    const terms = (await view(ctx)).terms;
    evidence(ctx).mergeNext(terms);
    evidence(ctx).mergeNext(terms); // injected
    const r = await run(ctx);
    expect(r.judgment!.decision).toBe("escalate");
    expect(r.payouts[0]!.state).toBe("held");
  });
});

describe("state machine rows, end to end", () => {
  test("recorded reviewed_policy_changed → exactly one automatic attempt+1", async () => {
    const ctx = await activate();
    ctx.stub.script.recordedRefusals.push("reviewed_policy_changed");
    const r = await run(ctx);
    const c = await view(ctx);
    const mine = c.payouts.filter((p) => p.kind === "payout");
    expect(mine.map((p) => `${p.seq}-${p.attempt}:${p.state}`).sort()).toEqual(["1-1:refused", "1-2:held"]);
    expect(r.outcome).toBe("requested");
    expect(ctx.stub.calls.requestPayout).toBe(2);
  });

  test("a second reviewed_policy_changed is left to the representative", async () => {
    const ctx = await activate();
    ctx.stub.script.recordedRefusals.push("reviewed_policy_changed", "reviewed_policy_changed");
    await run(ctx);
    const c = await view(ctx);
    expect(c.payouts.filter((p) => p.kind === "payout").length).toBe(2);
    expect(ctx.stub.calls.requestPayout).toBe(2);
    expect(c.open_judgment).not.toBeNull();
  });

  test("insufficient_balance → refused (freed), judgment stays open; Retry after funding", async () => {
    const ctx = await activate("100");
    const r = await run(ctx);
    expect([r.payouts[0]!.state, r.payouts[0]!.code]).toEqual(["refused", "insufficient_balance"]);
    let c = await view(ctx);
    expect(c.committed_usd).toBe("0");
    expect(c.open_judgment).not.toBeNull();
    await ctx.rt.kit.controls!.fund(agentId(ctx), M(900));
    c = await ctx.rt.covenant.retry(ctx.id);
    const p = c.payouts.find((x) => x.state === "held")!;
    expect([p.seq, p.attempt, p.amount_usd]).toEqual([1, 2, "500"]);
  });

  test("Drop closes the judgment; the next run judges the same PRs again", async () => {
    const ctx = await activate("100");
    await run(ctx);
    await ctx.rt.covenant.drop(ctx.id);
    const c = await view(ctx);
    expect(c.open_judgment).toBeNull();
    expect((c.judgment as { outcome: string }).outcome).toBe("dropped");
    await ctx.rt.kit.controls!.fund(agentId(ctx), M(900));
    expect((await run(ctx)).payouts[0]!.state).toBe("held");
  });

  test("Drop is refused while a payout is live", async () => {
    const ctx = await activate();
    await run(ctx);
    await expect(ctx.rt.covenant.drop(ctx.id)).rejects.toThrow("still live");
  });

  test("unavailable → unknown → status not_found → the same id is re-asked → exactly one transfer (bug 2)", async () => {
    const ctx = await activate();
    ctx.stub.script.requestFails.push({ ok: false, kind: "unavailable" });
    const r = await run(ctx);
    const rid = r.payouts[0]!.request_id;
    expect(r.payouts[0]!.state).toBe("unknown");
    expect((await view(ctx)).committed_usd).toBe("500"); // never freed
    const c = await view(ctx); // follow-up: not_found → same id
    expect(c.payouts.find((p) => p.request_id === rid)!.state).toBe("held");
    expect(c.payouts.filter((p) => p.kind === "payout").length).toBe(1);
    await approveAndSettle(ctx, rid);
    expect(ctx.stub.transfers.filter((t) => t.status === "SUCCESS").length).toBe(1);
  });

  test("a lost reply on a recorded request is found by status, not sent again", async () => {
    const ctx = await activate();
    ctx.stub.script.dropNextReply = true;
    const r = await run(ctx);
    expect(r.payouts[0]!.state).toBe("unknown");
    const c = await view(ctx);
    expect(c.payouts[0]!.state).toBe("held");
    expect(ctx.stub.calls.requestPayout).toBe(1);
  });

  test("failed after approval stays committed until the representative resolves reowe (bug 3)", async () => {
    const ctx = await activate();
    const rid = (await run(ctx)).payouts[0]!.request_id;
    await castVote(ctx, rid, "approve");
    ctx.stub.script.failAfterApproval = "delivery_failed";
    ctx.stub.settle(attemptOf(ctx, rid).correlation_id!);
    let c = await view(ctx);
    expect(c.payouts.find((p) => p.request_id === rid)!.state).toBe("failed");
    expect(c.committed_usd).toBe("500");
    expect((await run(ctx)).outcome).toBe("deferred");
    c = await ctx.rt.covenant.resolve(rid, "reowe");
    expect(c.payouts.find((p) => p.request_id === rid)!.state).toBe("resolved");
    const again = c.payouts.find((p) => p.state === "held")!;
    expect([again.seq, again.attempt, again.amount_usd]).toEqual([1, 2, "500"]);
    expect(c.committed_usd).toBe("500");
  });

  test("failed resolved arrived stays paid and the judgment moves on", async () => {
    const ctx = await activate();
    const rid = (await run(ctx)).payouts[0]!.request_id;
    await castVote(ctx, rid, "approve");
    ctx.stub.script.failAfterApproval = "delivery_failed";
    ctx.stub.settle(attemptOf(ctx, rid).correlation_id!);
    await view(ctx);
    const c = await ctx.rt.covenant.resolve(rid, "arrived");
    expect(c.paid_usd).toBe("500");
    expect(c.payouts.find((p) => p.state === "held")!.seq).toBe(2);
  });

  test("failed resolved rejected frees it and rejects the judgment", async () => {
    const ctx = await activate();
    const rid = (await run(ctx)).payouts[0]!.request_id;
    await castVote(ctx, rid, "approve");
    ctx.stub.script.failAfterApproval = "delivery_failed";
    ctx.stub.settle(attemptOf(ctx, rid).correlation_id!);
    await view(ctx);
    const c = await ctx.rt.covenant.resolve(rid, "rejected");
    expect([c.committed_usd, c.open_judgment]).toEqual(["0", null]);
    expect((c.judgment as { outcome: string }).outcome).toBe("rejected");
  });

  test("thrown recipient_not_registered → blocked; the same id succeeds after registration (bug 4)", async () => {
    const ctx = await activate();
    ctx.stub.script.unregistered.add("maria.demo");
    const r = await run(ctx);
    const rid = r.payouts[0]!.request_id;
    expect([r.payouts[0]!.state, r.payouts[0]!.code]).toEqual(["blocked", "recipient_not_registered"]);
    ctx.stub.script.unregistered.delete("maria.demo");
    await view(ctx); // before retry_at: nothing re-asked
    expect(attemptOf(ctx, rid).state).toBe("blocked");
    tick(ctx);
    const c = await view(ctx);
    expect(c.payouts.find((p) => p.request_id === rid)!.state).toBe("held");
    expect(c.payouts.filter((p) => p.kind === "payout").length).toBe(1);
  });

  test("thrown request_conflict → blocked with an alert, never retried", async () => {
    const ctx = await activate();
    ctx.stub.script.requestFails.push({ ok: false, kind: "refused", code: "request_conflict" });
    await run(ctx);
    tick(ctx, 3_600_000);
    const c = await view(ctx);
    expect(c.payouts[0]!.state).toBe("blocked");
    expect(ctx.stub.calls.requestPayout).toBe(1);
    expect(c.events.some((e) => e.kind === "alert" && e.text.includes("request_conflict"))).toBe(true);
    await expect(ctx.rt.covenant.retry(ctx.id)).rejects.toThrow("nothing to retry");
  });

  test("unresolved → waiting; the same id is re-asked only after the wait", async () => {
    const ctx = await activate();
    ctx.stub.script.requestFails.push({ ok: false, kind: "unresolved" });
    const rid = (await run(ctx)).payouts[0]!.request_id;
    expect(attemptOf(ctx, rid).state).toBe("waiting");
    await view(ctx);
    expect(ctx.stub.calls.requestPayout).toBe(1);
    tick(ctx);
    await view(ctx);
    expect([ctx.stub.calls.requestPayout, attemptOf(ctx, rid).state]).toEqual([2, "held"]);
  });

  test("rate_limited waits retryAfterSeconds", async () => {
    const ctx = await activate();
    ctx.stub.script.requestFails.push({ ok: false, kind: "rate_limited", retryAfterSeconds: 300 });
    const rid = (await run(ctx)).payouts[0]!.request_id;
    tick(ctx, 120_000);
    await view(ctx);
    expect(attemptOf(ctx, rid).state).toBe("waiting");
    tick(ctx, 200_000);
    await view(ctx);
    expect(attemptOf(ctx, rid).state).toBe("held");
  });

  test("forbidden and session → blocked with their codes; session alerts the operator", async () => {
    const ctx = await activate();
    ctx.stub.script.requestFails.push({ ok: false, kind: "session" });
    const rid = (await run(ctx)).payouts[0]!.request_id;
    expect([attemptOf(ctx, rid).state, attemptOf(ctx, rid).code, attemptOf(ctx, rid).fail_kind]).toEqual(["blocked", "credential", "session"]);
    expect(ctx.logs.some((l) => l.includes("ALERT"))).toBe(true);
    const ctx2 = await activate();
    ctx2.stub.script.requestFails.push({ ok: false, kind: "forbidden", code: "consent_revoked" });
    const rid2 = (await run(ctx2)).payouts[0]!.request_id;
    expect([attemptOf(ctx2, rid2).state, attemptOf(ctx2, rid2).code]).toEqual(["blocked", "consent_revoked"]);
  });

  test("processing is polled and stays committed until it settles", async () => {
    const ctx = await activate();
    const rid = (await run(ctx)).payouts[0]!.request_id;
    await castVote(ctx, rid, "approve");
    expect(attemptOf(ctx, rid).state).toBe("processing");
    await view(ctx);
    expect(attemptOf(ctx, rid).state).toBe("processing");
    ctx.stub.settle(attemptOf(ctx, rid).correlation_id!);
    await view(ctx);
    expect(attemptOf(ctx, rid).state).toBe("paid");
  });

  test("reject vote → failed with no tx → rejected (freed)", async () => {
    const ctx = await activate();
    const rid = (await run(ctx)).payouts[0]!.request_id;
    const c = await castVote(ctx, rid, "reject");
    const p = c.payouts.find((x) => x.request_id === rid)!;
    expect([p.state, p.vote, p.tx_hash]).toEqual(["rejected", "reject", null]);
    expect(c.committed_usd).toBe("0");
  });

  test("an approval whose proven terms don't match the payout is refused", async () => {
    const ctx = await activate();
    const rid = (await run(ctx)).payouts[0]!.request_id;
    ctx.stub.script.tamperVoteTerms = true;
    await expect(ctx.rt.covenant.vote(rid, "approve")).rejects.toThrow("don't match");
    const c = await view(ctx);
    expect(c.events.some((e) => e.kind === "alert")).toBe(true);
    expect(attemptOf(ctx, rid).vote).toBeNull();
  });

  test("the timer and a run racing make one platform request", async () => {
    const ctx = await activate();
    await Promise.all([run(ctx), ctx.rt.covenant.followUpAll(), run(ctx), view(ctx)]);
    expect(ctx.stub.calls.requestPayout).toBe(1);
    const pending = ctx.rt.covenant.followUpIds();
    expect(pending).toEqual([ctx.id]);
  });
});

describe("approval in place of the cancel window (#2)", () => {
  test("no request unless the platform shows owner approval on", async () => {
    const ctx = await activate();
    stubAgent(ctx).policy.owner_approval = false;
    const r = await run(ctx);
    expect([r.payouts[0]!.state, r.payouts[0]!.code]).toEqual(["blocked", "policy_mismatch"]);
    expect(ctx.stub.calls.requestPayout).toBe(0);
  });

  test("no request when withdrawals or the cap differ from the terms", async () => {
    const ctx = await activate();
    stubAgent(ctx).policy.withdrawals.push("attacker.demo");
    await run(ctx);
    expect(ctx.stub.calls.requestPayout).toBe(0);
  });

  test("no new request in the last 10 minutes of the contract", async () => {
    const ctx = await activate();
    ctx.rt.clock.set(new Date("2026-11-30T23:55:00Z"));
    const r = await run(ctx);
    expect(r.payouts[0]!.code).toBe("contract_ending");
    expect(ctx.stub.calls.requestPayout).toBe(0);
  });

  test("after the end the payout consent is gone (forbidden scope) but a vote still works within grace", async () => {
    const ctx = await activate();
    const rid = (await run(ctx)).payouts[0]!.request_id;
    ctx.rt.clock.set(new Date("2026-12-02T10:00:00Z"));
    await expect(run(ctx)).rejects.toThrow("ended");
    const atk = await ctx.rt.covenant.attack(ctx.id, "after_end");
    expect([atk.outcome, atk.code]).toEqual(["forbidden", "scope"]);
    const c = await castVote(ctx, rid, "reject"); // [owner, read] consent lives until end + grace
    expect(c.payouts.find((p) => p.request_id === rid)!.state).toBe("rejected");
    expect(c.stage).toBe("ended");
  });

  test("no code path in the engine mentions a timelock or cancel window", async () => {
    const src = await Bun.file(new URL("../src/server/engine.ts", import.meta.url)).text();
    expect(/timelock|cancel window|execution_cancel/i.test(src)).toBe(false);
  });
});

describe("attacks (compromised server)", () => {
  test("redirect and overpay are refused by the policy; in-cap injected is held, then rejected", async () => {
    const ctx = await activate();
    const redirect = await ctx.rt.covenant.attack(ctx.id, "redirect");
    expect([redirect.outcome, redirect.code, redirect.request?.recipient]).toEqual(["refused", "payee_not_agreed", "attacker.demo"]);
    const overpay = await ctx.rt.covenant.attack(ctx.id, "overpay");
    expect([overpay.outcome, overpay.code, overpay.request?.amount_usd]).toEqual(["refused", "per_transaction_exceeded", "501"]);
    const injected = await ctx.rt.covenant.attack(ctx.id, "injected");
    expect(injected.outcome).toBe("held");
    expect(injected.note).toContain("NOT STOPPED by policy");
    expect(injected.payout!.request_id).toMatch(/^atk-injected-/);
    const c = await castVote(ctx, injected.payout!.request_id, "reject");
    expect(c.payouts.find((p) => p.request_id === injected.payout!.request_id)!.state).toBe("rejected");
    expect([c.committed_usd, c.open_judgment]).toEqual(["0", null]);
    const notYet = await ctx.rt.covenant.attack(ctx.id, "after_end");
    expect(notYet.ready).toBe(false);
  });

  test("attacks are refused against a real deployment", async () => {
    const ctx = await activate();
    (ctx.stub as unknown as { mode: string }).mode = "remote";
    await expect(ctx.rt.covenant.attack(ctx.id, "redirect")).rejects.toThrow("never a real deployment");
  });
});

describe("Verify", () => {
  test("incomplete before setup, green after, red when the platform's policy drifts", async () => {
    const ctx = await setup();
    expect((await ctx.rt.covenant.verify(ctx.id)).overall).toBe("incomplete");
    const live = await activate();
    const v = await live.rt.covenant.verify(live.id);
    expect(v.overall).toBe("green");
    expect(v.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual([]);
    expect(v.expected.per_transaction).toBe(M(500));
    stubAgent(live).policy.withdrawals.push("attacker.demo");
    const red = await live.rt.covenant.verify(live.id);
    expect(red.overall).toBe("red");
    expect(red.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(["payee"]);
  });

  test("a payout consent longer than the contract turns Verify red", async () => {
    const live = await activate();
    for (const c of live.stub.consents) if (c.scopes.includes("payout")) c.expiresAt = "2027-01-31T00:00:00.000Z";
    expect((await live.rt.covenant.verify(live.id)).checks.find((c) => c.id === "consent")!.ok).toBe(false);
  });

  test("paid + balance ≤ total is information, never red", async () => {
    const live = await activate("5000");
    const v = await live.rt.covenant.verify(live.id);
    expect(v.overall).toBe("green");
    expect(v.checks.find((c) => c.id === "funded")).toMatchObject({ ok: false, info: true });
  });
});

describe("secrets and storage", () => {
  test("the platform credential never appears in /api/config, events or logs", async () => {
    const secret = "tap_SECRET_never_print_me_123";
    const lines: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      const ctx = await activate("1000", {}, { PLATFORM: "remote", PLATFORM_STACK_DIR: "/nonexistent-stack", PLATFORM_CREDENTIAL: secret });
      expect(ctx.rt.config.credential).toBe(secret);
      ctx.stub.script.requestFails.push({ ok: false, kind: "session" });
      await run(ctx);
      const cfg = await (await ctx.rt.app.request("/api/config")).text();
      const contract = await (await ctx.rt.app.request(`/api/contracts/${ctx.id}`)).text();
      const verify = await (await ctx.rt.app.request(`/api/contracts/${ctx.id}/verify`)).text();
      for (const text of [cfg, contract, verify, ...ctx.logs, ...lines]) expect(text.includes(secret)).toBe(false);
      expect(JSON.parse(cfg)).toMatchObject({ platform: "fake", stack: true, demo_controls: true, org_mode: "contract" });
    } finally {
      Object.assign(console, orig);
    }
  });

  test("an old provider-era database is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "cov-"));
    const path = join(dir, "old.sqlite");
    const old = new Database(path);
    old.exec("CREATE TABLE contracts (id TEXT PRIMARY KEY, credential_enc TEXT)");
    old.close();
    expect(() => openDb(path)).toThrow("Delete data/covenant.sqlite");
  });

  test("one open payout per contract is enforced by the database", async () => {
    const ctx = await activate();
    await run(ctx);
    const db = (ctx.rt.covenant as unknown as { d: { db: Database } }).d.db;
    expect(() =>
      db
        .query("INSERT INTO payout_attempts (request_id, kind, contract_id, seq, attempt, recipient, amount_atomic, state, created_at, updated_at) VALUES ('x', 'payout', ?, 9, 1, 'maria.demo', '1', 'held', 'now', 'now')")
        .run(ctx.id),
    ).toThrow();
  });

  test("terms are stored canonically and the contract id is the organization", async () => {
    const ctx = await setup();
    expect((await view(ctx)).organization).toBe(ctx.id);
    expect(ctx.id).toMatch(/^c_[0-9a-f]{12}$/);
    expect(() => ctx.rt.covenant.createContract(DEMO_TERMS)).toThrow("already exists");
  });
});

// ----------------------------------------------------------------------------------------------------------------
// The same rules on track A's FakePlatform (the platform's authorize rules, consent scopes and requestId semantics).
describe("on the FakePlatform", () => {
  const live = async (ctx: FCtx) => (await ctx.rt.covenant.getContract(ctx.id)).payouts.find((p) => p.kind === "payout" && ["held", "processing", "unknown", "blocked", "waiting", "failed"].includes(p.state)) ?? null;

  test("held → approved → settled; the remainder is seq 2 on the same judgment; then approved and carried forward", async () => {
    const ctx = await fakeActivate();
    const r = await ctx.rt.covenant.run(ctx.id);
    expect([r.payouts[0]!.state, r.payouts[0]!.amount_usd]).toEqual(["held", "500"]);
    let c = await fakeApproveAndSettle(ctx, r.payouts[0]!.request_id);
    const seq2 = (await live(ctx))!;
    expect([seq2.seq, seq2.amount_usd, seq2.state]).toEqual([2, "150", "held"]);
    c = await fakeApproveAndSettle(ctx, seq2.request_id);
    expect([c.paid_usd, c.open_judgment, (c.judgment as { outcome: string }).outcome]).toEqual(["650", null, "approved"]);
    expect(c.scope.find((d) => d.id === "d1")!.completion).toBe(1);
    const reqs = ctx.controls.requests();
    expect(reqs.every((b) => !("memo" in b))).toBe(true);
  });

  test("reject → judgment rejected, its PRs excluded, the next run requests nothing", async () => {
    const ctx = await fakeActivate();
    await fakeApproveAndSettle(ctx, (await ctx.rt.covenant.run(ctx.id)).payouts[0]!.request_id);
    const c = await fakeVote(ctx, (await live(ctx))!.request_id, "reject");
    expect([c.paid_usd, c.committed_usd, c.open_judgment]).toEqual(["500", "500", null]);
    expect((await ctx.rt.covenant.run(ctx.id)).outcome).toBe("nothing");
  });

  test("a run while a payout is held is deferred: no request", async () => {
    const ctx = await fakeActivate();
    await ctx.rt.covenant.run(ctx.id);
    const n = ctx.controls.requests().length;
    expect((await ctx.rt.covenant.run(ctx.id)).outcome).toBe("deferred");
    expect(ctx.controls.requests().length).toBe(n);
  });

  test("insufficient_balance is refused by the platform; Retry after funding gets attempt 2 held", async () => {
    const ctx = await fakeActivate("100");
    const r = await ctx.rt.covenant.run(ctx.id);
    expect([r.payouts[0]!.state, r.payouts[0]!.code]).toEqual(["refused", "insufficient_balance"]);
    await ctx.controls.fund(ctx.rt.covenant.onboarding.agentRow(ctx.id)!.agent_id!, M(900));
    const c = await ctx.rt.covenant.retry(ctx.id);
    expect(c.payouts.find((p) => p.state === "held")!.attempt).toBe(2);
  });

  test("outage: the overview check fails first, so nothing is sent; the same id goes through after → one transfer", async () => {
    const ctx = await fakeActivate();
    ctx.controls.setUnavailable(true);
    const rid = (await ctx.rt.covenant.run(ctx.id)).payouts[0]!.request_id;
    expect([ctx.rt.covenant.attempt(rid).state, ctx.controls.requests().length]).toEqual(["waiting", 0]);
    ctx.controls.setUnavailable(false);
    ctx.rt.clock.advance(61_000);
    const c = await ctx.rt.covenant.getContract(ctx.id);
    expect(c.payouts.find((p) => p.request_id === rid)!.state).toBe("held");
    await fakeApproveAndSettle(ctx, rid);
    expect((await ctx.controls.transfers()).filter((t) => t.status === "SUCCESS").length).toBe(1);
  });

  test("a lost reply is followed by status, never sent under a new id", async () => {
    const ctx = await fakeActivate();
    ctx.controls.dropNextReply();
    const rid = (await ctx.rt.covenant.run(ctx.id)).payouts[0]!.request_id;
    await ctx.rt.covenant.getContract(ctx.id);
    expect(ctx.rt.covenant.attempt(rid).state).toBe("held");
    expect(new Set(ctx.controls.requests().map((b) => b.requestId)).size).toBe(1);
  });

  test("failed after approval stays committed until reowe, then attempt 2 on the same seq", async () => {
    const ctx = await fakeActivate();
    const rid = (await ctx.rt.covenant.run(ctx.id)).payouts[0]!.request_id;
    ctx.controls.failAfterApproval("delivery_failed");
    await fakeApproveAndSettle(ctx, rid);
    let c = await ctx.rt.covenant.getContract(ctx.id);
    expect([c.payouts.find((p) => p.request_id === rid)!.state, c.committed_usd]).toEqual(["failed", "500"]);
    c = await ctx.rt.covenant.resolve(rid, "reowe");
    const again = c.payouts.find((p) => p.state === "held")!;
    expect([again.seq, again.attempt]).toEqual([1, 2]);
  });

  test("recipient_not_registered blocks; the same id goes through once the payee registers", async () => {
    const ctx = await fakeActivate();
    ctx.controls.chain.setRegistered("maria.demo", false);
    const r = await ctx.rt.covenant.run(ctx.id);
    const rid = r.payouts[0]!.request_id;
    expect([r.payouts[0]!.state, r.payouts[0]!.code]).toEqual(["blocked", "recipient_not_registered"]);
    ctx.controls.chain.setRegistered("maria.demo", true);
    ctx.rt.clock.advance(61_000);
    await ctx.rt.covenant.getContract(ctx.id);
    expect(ctx.rt.covenant.attempt(rid).state).toBe("held");
  });

  test("Verify is green after onboarding and funding", async () => {
    const ctx = await fakeActivate();
    const v = await ctx.rt.covenant.verify(ctx.id);
    expect(v.checks.filter((c) => !c.ok && !c.info).map((c) => c.id)).toEqual([]);
    expect(v.overall).toBe("green");
  });

  test("attacks: redirect and overpay refused, injected held then rejected; after the end forbidden, vote still works", async () => {
    const ctx = await fakeActivate();
    expect((await ctx.rt.covenant.attack(ctx.id, "redirect")).code).toBe("payee_not_agreed");
    expect((await ctx.rt.covenant.attack(ctx.id, "overpay")).code).toBe("per_transaction_exceeded");
    const inj = await ctx.rt.covenant.attack(ctx.id, "injected");
    expect(inj.outcome).toBe("held");
    const c0 = await fakeVote(ctx, inj.payout!.request_id, "reject");
    expect(c0.payouts.find((p) => p.request_id === inj.payout!.request_id)!.state).toBe("rejected");
    const rid = (await ctx.rt.covenant.run(ctx.id)).payouts[0]!.request_id;
    ctx.rt.clock.set(new Date("2026-12-02T00:00:00Z"));
    const atk = await ctx.rt.covenant.attack(ctx.id, "after_end");
    expect([atk.outcome, atk.code]).toEqual(["forbidden", "scope"]);
    const c = await fakeVote(ctx, rid, "reject");
    expect(c.payouts.find((p) => p.request_id === rid)!.state).toBe("rejected");
  });
});
