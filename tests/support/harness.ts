// Shared test setup: a Covenant runtime on track B's StubPlatform, plus helpers that play the representative.
import { createRuntime, type Runtime } from "../../src/server/app";
import { loadConfig } from "../../src/server/config";
import { DEMO_TERMS } from "../../src/shared/demo";
import { toAtomic } from "../../src/shared/money";
import type { NextStep } from "../../src/shared/views";
import { StubPlatform } from "./stub-platform";

export const START = Date.parse("2026-11-20T12:00:00Z");

export interface Ctx {
  rt: Runtime;
  stub: StubPlatform;
  id: string;
  token: string;
  logs: string[];
}

export async function setup(overrides: Record<string, unknown> = {}, env: Record<string, string> = {}): Promise<Ctx> {
  let now: () => Date = () => new Date(START);
  const stub = new StubPlatform(() => now());
  const logs: string[] = [];
  const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules", ...env }), { clockStart: START, kit: stub.kit(), log: (m) => logs.push(m) });
  now = rt.clock.now;
  const { id, contractorToken } = rt.covenant.createContract({ ...DEMO_TERMS, ...overrides });
  return { rt, stub, id, token: contractorToken, logs };
}

export async function signTerms(ctx: Ctx) {
  for (const role of ["representative", "contractor"] as const) {
    const req = ctx.rt.covenant.signingRequest(ctx.id, role);
    const s = ctx.stub.sign(req);
    await ctx.rt.covenant.addSignature(ctx.id, role, { account_id: req.account_id, public_key: s.publicKey, signature: s.signature, nonce: req.nonce }, ctx.token);
  }
}

/** Play one NextStep as the representative's wallet. */
export async function play(ctx: Ctx, next: NextStep): Promise<NextStep> {
  const c = ctx.rt.covenant;
  if (next.kind === "sign") {
    const s = ctx.stub.sign(next.sign);
    return c.signed(ctx.id, { step: next.step, nonce: next.sign.nonce, publicKey: s.publicKey, signature: s.signature });
  }
  if (next.kind === "owner_step") {
    const s = ctx.stub.sign(next.sign!);
    await c.submitOwnerStep(next.correlation_id, s);
    return c.next(ctx.id);
  }
  return c.next(ctx.id);
}

export async function onboard(ctx: Ctx) {
  let next = await ctx.rt.covenant.next(ctx.id);
  for (let i = 0; i < 20 && next.kind !== "done"; i++) next = await play(ctx, next);
  if (next.kind !== "done") throw new Error(`onboarding stuck at ${JSON.stringify(next)}`);
}

/** Signed, set up and funded (default: exactly the scope total). */
export async function activate(fund = "1000", overrides: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const ctx = await setup(overrides, env);
  await signTerms(ctx);
  await onboard(ctx);
  if (fund !== "0") await ctx.rt.kit.controls!.fund(agentId(ctx), toAtomic(fund, 6).toString());
  return ctx;
}

export function agentId(ctx: Ctx): string {
  return ctx.rt.covenant.onboarding.agentRow(ctx.id)!.agent_id!;
}

export async function castVote(ctx: Ctx, rid: string, verdict: "approve" | "reject") {
  const v = await ctx.rt.covenant.vote(rid, verdict);
  const s = ctx.stub.sign(v.sign!);
  await ctx.rt.covenant.submitOwnerStep(v.correlation_id, s);
  return ctx.rt.covenant.getContract(ctx.id);
}

export async function approveAndSettle(ctx: Ctx, rid: string) {
  await castVote(ctx, rid, "approve");
  ctx.stub.settle(ctx.rt.covenant.attempt(rid).correlation_id!);
  return ctx.rt.covenant.getContract(ctx.id);
}

export function attemptOf(ctx: Ctx, rid: string) {
  return ctx.rt.covenant.attempt(rid);
}

export async function livePayout(ctx: Ctx) {
  const c = await ctx.rt.covenant.getContract(ctx.id);
  return c.payouts.find((p) => p.kind === "payout" && ["pending", "blocked", "waiting", "unknown", "held", "processing", "failed"].includes(p.state)) ?? null;
}

export function evidence(ctx: Ctx) {
  return ctx.rt.evidence as unknown as { mergeNext(t: unknown): unknown };
}
