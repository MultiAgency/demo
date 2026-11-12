// The same representative helpers as harness.ts, on the FakePlatform (makePlatform({mode:"fake"})).
import { createRuntime, type Runtime } from "../../src/server/app";
import { loadConfig } from "../../src/server/config";
import type { FakeControls } from "../../src/server/platform/fake";
import { DEMO_TERMS } from "../../src/shared/demo";
import { toAtomic } from "../../src/shared/money";
import { START } from "./harness";

export interface FCtx {
  rt: Runtime;
  id: string;
  controls: FakeControls;
  sign: (p: { message: string; recipient: string; nonce: string }) => Promise<{ publicKey: string; signature: string }>;
}

export async function fakeActivate(fund = "1000", overrides: Record<string, unknown> = {}): Promise<FCtx> {
  const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules" }), { clockStart: START, log: () => {} });
  const { id, contractorToken } = rt.engine.createContract({ ...DEMO_TERMS, ...overrides });
  const sign = (p: { message: string; recipient: string; nonce: string }) => rt.kit.devSigner!.sign413(p);
  for (const role of ["representative", "contractor"] as const) {
    const req = rt.engine.signingRequest(id, role);
    const s = await sign(req);
    await rt.engine.addSignature(id, role, { account_id: req.account_id, public_key: s.publicKey, signature: s.signature, nonce: req.nonce }, contractorToken);
  }
  let next = await rt.engine.next(id);
  for (let i = 0; i < 20 && next.kind !== "done"; i++) {
    if (next.kind === "sign") {
      const s = await sign(next.sign);
      next = await rt.engine.signed(id, { step: next.step, nonce: next.sign.nonce, publicKey: s.publicKey, signature: s.signature });
    } else if (next.kind === "owner_step") {
      await rt.engine.submitOwnerStep(next.correlation_id, await sign(next.sign!));
      next = await rt.engine.next(id);
    } else next = await rt.engine.next(id);
  }
  if (next.kind !== "done") throw new Error(`onboarding stuck: ${JSON.stringify(next)}`);
  const controls = rt.kit.controls as FakeControls;
  if (fund !== "0") await controls.fund(rt.engine.onboarding.agentRow(id)!.agent_id!, toAtomic(fund, 6).toString());
  return { rt, id, controls, sign };
}

export async function fakeVote(ctx: FCtx, rid: string, verdict: "approve" | "reject") {
  const v = await ctx.rt.engine.vote(rid, verdict);
  await ctx.rt.engine.submitOwnerStep(v.correlation_id, await ctx.sign(v.sign!));
  return ctx.rt.engine.getContract(ctx.id);
}

export async function fakeApproveAndSettle(ctx: FCtx, rid: string) {
  await fakeVote(ctx, rid, "approve");
  await ctx.controls.settle(ctx.rt.engine.attempt(rid).correlation_id!);
  return ctx.rt.engine.getContract(ctx.id);
}
