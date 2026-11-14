import { expect, test } from "bun:test";
import { activate } from "./support/harness";
const instructions = { address: "ab".repeat(32), memo: null, minAmount: "999", expiresAt: "2026-12-01T00:00:00Z" };
function instrument(ctx: Awaited<ReturnType<typeof activate>>, result: () => Promise<any>) {
  const original = ctx.stub.agent.bind(ctx.stub);
  ctx.stub.agent = (org, agent) => ({ ...original(org, agent), deposit: result });
}
test("refresh and concurrent funding preflight reuse the same original deposit instructions", async () => {
  const ctx = await activate("0"); let calls = 0;
  instrument(ctx, async () => { calls++; return { ok: true, value: { ...instructions, address: calls === 1 ? instructions.address : "changed.near" } }; });
  const values = await Promise.all([ctx.rt.engine.deposit(ctx.id), ctx.rt.engine.deposit(ctx.id), ctx.rt.engine.deposit(ctx.id)]);
  expect(calls).toBe(1); expect(values).toEqual([instructions, instructions, instructions]);
  expect((await ctx.rt.engine.getContract(ctx.id)).platform.deposit).toEqual(instructions);
  expect(ctx.stub.calls.requestPayout).toBe(0);
});
test("a valid legacy saved address is reused without contacting an unavailable allocator", async () => {
  const ctx = await activate("0");
  ctx.rt.engine.onboarding.setAgent(ctx.id, { deposit: JSON.stringify(instructions) });
  instrument(ctx, async () => { throw Error("Must not allocate"); });
  expect(await ctx.rt.engine.deposit(ctx.id)).toEqual(instructions);
});
for (const failure of ["unknown", "throw", "invalid"] as const) test(`${failure} allocation remains durably blocked instead of creating another address`, async () => {
  const ctx = await activate("0"); let calls = 0;
  instrument(ctx, async () => { calls++; if (failure === "throw") throw Error("lost reply"); return failure === "unknown" ? { ok: false, kind: "unknown" } : { ok: true, value: { ...instructions, address: "" } }; });
  await expect(ctx.rt.engine.deposit(ctx.id)).rejects.toThrow();
  const db = ctx.rt.db;
  expect(db.query("SELECT kind FROM events WHERE contract_id=? AND kind='deposit_pending'").all(ctx.id)).toHaveLength(1);
  // Even a fresh caller with a working transport must not re-enter allocation.
  instrument(ctx, async () => { calls++; return { ok: true, value: instructions }; });
  await expect(ctx.rt.engine.deposit(ctx.id)).rejects.toThrow("original deposit-address allocation");
  expect(calls).toBe(1);
  expect((await ctx.rt.engine.viewContract(ctx.id)).platform.deposit).toBeNull();
});
test("expired cached instructions fail closed without a replacement allocation", async () => {
  const ctx = await activate("0");
  ctx.rt.engine.onboarding.setAgent(ctx.id, { deposit: JSON.stringify({ ...instructions, expiresAt: "2026-11-01T00:00:00Z" }) });
  instrument(ctx, async () => { throw Error("Must not allocate"); });
  await expect(ctx.rt.engine.deposit(ctx.id)).rejects.toThrow("expired");
});

test("an unknown address allocation survives database reopen without a replacement request", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createRuntime } = await import("../src/server/app");
  const { loadConfig } = await import("../src/server/config");
  const { closeRestorationRuntime } = await import("./support/restoration-ledger");
  const dir = mkdtempSync(join(tmpdir(), "paperwork-deposit-reopen-")), path = join(dir, "job.sqlite");
  const ctx = await activate("0", {}, { DB_PATH: path }); let calls = 0;
  instrument(ctx, async () => { calls++; return { ok: false, kind: "unknown" }; });
  await expect(ctx.rt.engine.deposit(ctx.id)).rejects.toThrow();
  await closeRestorationRuntime(ctx.rt);
  const resumed = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules", DB_PATH: path }), { clockStart: ctx.rt.clock.now().getTime(), kit: ctx.stub.kit() });
  try {
    await expect(resumed.engine.deposit(ctx.id)).rejects.toThrow("original deposit-address allocation");
    expect(calls).toBe(1);
  } finally { await closeRestorationRuntime(resumed); rmSync(dir, { recursive: true, force: true }); }
});

test("wallet funding preflight accepts the displayed original address without relaxing comparison", async () => {
  const { FundingWallet, fundingRequest, assertFundingVerification } = await import("../src/web/funding");
  const ctx = await activate("0"); let allocations = 0, sends = 0;
  instrument(ctx, async () => ({ ok: true, value: { ...instructions, address: ++allocations === 1 ? instructions.address : "replacement.near" } }));
  const displayed = await ctx.rt.engine.getContract(ctx.id); displayed.platform.mode = "remote";
  const original = fundingRequest(displayed, await ctx.rt.engine.deposit(ctx.id));
  const store = new Map<string, string>();
  const wallet = new FundingWallet({
    network: "mainnet", session: () => ({ account: original.sender, loading: false, version: 1 }), connect: async () => true,
    readAccount: async () => original.sender, wallet: () => ({ account: original.sender, network: "mainnet", connected: true }),
    fresh: async () => {
      const c = await ctx.rt.engine.getContract(ctx.id); c.platform.mode = "remote";
      const q = fundingRequest(c, await ctx.rt.engine.deposit(ctx.id));
      assertFundingVerification(q, await ctx.rt.engine.verify(ctx.id)); return q;
    },
    storage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } },
    exclusive: async (_key, work) => work(),
    send: async q => { sends++; expect(q).toEqual(original); },
  });
  await wallet.fund(original);
  expect(allocations).toBe(1); expect(sends).toBe(1);
  expect(ctx.stub.calls.requestPayout).toBe(0);
});
