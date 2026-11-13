import { expect, test } from "bun:test";
import { RpcChain } from "../src/server/platform/chain";
import { validateRegistration } from "../src/web/registration";
import { nearAmount } from "../src/shared/registration";
import { USDC_NEAR } from "../src/shared/terms";
import { buildApp } from "../src/server/app";
import type { Auth } from "../src/server/auth";
import { setup } from "./support/harness";

function rpc(balance: unknown = null, minimum: unknown = "1250000000000000000000") {
  const calls: any[] = [];
  const send = (async (_url: unknown, options: RequestInit) => {
    const q = JSON.parse(options.body as string); calls.push(q);
    const result = q.method === "gas_price" ? { gas_price: "100000000" } : { result: [...Buffer.from(JSON.stringify(q.params.method_name === "storage_balance_of" ? balance : { min: minimum, max: null }))] };
    return Response.json({ result });
  }) as typeof fetch;
  return { chain: new RpcChain("http://offline.invalid", send), calls };
}

test("quote uses finalized token storage minimum and only read RPC methods", async () => {
  const { chain, calls } = rpc();
  const q = await chain.registrationQuote(USDC_NEAR, "buildr.near");
  expect(q.deposit_yocto).toBe("1250000000000000000000");
  expect(q.gas_estimate_yocto).toBe("3000000000000000000000");
  expect(q.registered).toBe(false);
  validateRegistration(q, "buildr.near");
  expect(calls.map(x => x.method)).toEqual(["query", "query", "gas_price"]);
  expect(calls[0].params.finality).toBe("final");
  expect(calls[1].params.account_id).toBe(USDC_NEAR.slice(7));
  expect(nearAmount(q.deposit_yocto)).toBe("0.00125");
});

test("already registered quotes attach no deposit and cannot be submitted", async () => {
  const { chain } = rpc({ total: "1", available: "0" });
  const q = await chain.registrationQuote(USDC_NEAR, "buildr.near");
  expect(q.registered).toBe(true);
  expect(q.deposit_yocto).toBe("0");
  expect(() => validateRegistration(q, "buildr.near")).toThrow();
});

test("malformed storage state, invalid minima and RPC outages fail closed", async () => {
  for (const minimum of ["0", "-1", "1e20", 12, null])
    await expect(rpc(null, minimum).chain.registrationQuote(USDC_NEAR, "buildr.near")).rejects.toThrow();
  await expect(rpc({}).chain.registrationQuote(USDC_NEAR, "buildr.near")).rejects.toThrow();
  const chain = new RpcChain("http://offline.invalid", (async () => { throw Error("offline"); }) as unknown as typeof fetch);
  await expect(chain.registrationQuote(USDC_NEAR, "buildr.near")).rejects.toThrow();
});

test("wallet quote refuses changed recipient, contract, gas and expiration", async () => {
  const q = await rpc().chain.registrationQuote(USDC_NEAR, "buildr.near");
  for (const change of [{ account: "attacker.near" }, { token: "attacker.near" }, { gas: "1" }, { expires_at: "bad" }, { expires_at: new Date(0).toISOString() }, { deposit_yocto: "-1" }])
    expect(() => validateRegistration({ ...q, ...change }, "buildr.near")).toThrow();
});

test("private quote refuses anonymous and unrelated accounts before chain work; parties get live status", async () => {
  const ctx = await setup();
  let calls = 0;
  ctx.rt.kit.chain.registrationQuote = async (token, account) => { calls++; return rpc().chain.registrationQuote(token, account); };
  for (const [account, status] of [[null, 401], ["attacker.demo", 403], ["maria.demo", 200], ["acme.demo", 200]] as const) {
    const auth = { handler: async () => new Response(), api: { getSession: async () => account ? { user: { id: account } } : null }, nearAccountFor: (id: string) => id } as unknown as Auth;
    const app = buildApp({ ...ctx.rt, auth, config: { ...ctx.rt.config, auth: { ...ctx.rt.config.auth, required: true } } });
    const response = await app.request(`/api/contracts/${ctx.id}/registration`);
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    if (status === 200) expect((await response.json()).account).toBe("maria.demo");
    else expect(calls).toBe(0);
  }
  expect(calls).toBe(2);
  expect((await ctx.rt.engine.viewContract(ctx.id)).platform.agent).toBeNull();
});

import { RegistrationWallet } from "../src/web/registration";
function walletHarness() {
  const session = { account: "buildr.near" as string | null, version: 1, loading: false };
  const wallet = { account: "buildr.near" as string | null, network: "mainnet", connected: true };
  const sent: any[] = [];
  const deps = { network: "mainnet", session: () => ({ ...session }), wallet: () => ({ ...wallet }), readAccount: async () => session.account, connect: async () => true, send: async (q: any) => { sent.push(q); } };
  return { session, wallet, sent, deps };
}

test("registration sends exactly one original quoted storage deposit", async () => {
  const h = walletHarness();
  const q = await rpc().chain.registrationQuote(USDC_NEAR, "buildr.near");
  await new RegistrationWallet(h.deps).register(q);
  expect(h.sent).toEqual([q]);
});

test("wrong account, network, changed session and cancellation never send", async () => {
  const q = await rpc().chain.registrationQuote(USDC_NEAR, "buildr.near");
  for (const mode of ["wrong-wallet", "wrong-network", "changed-session", "cancelled", "server-mismatch", "loading"]) {
    const h = walletHarness();
    if (mode === "wrong-wallet") h.wallet.account = "attacker.near";
    if (mode === "wrong-network") h.wallet.network = "testnet";
    if (mode === "loading") h.session.loading = true;
    if (mode === "changed-session") h.deps.connect = async () => { h.session.version++; return true; };
    if (mode === "cancelled") h.deps.connect = async () => false;
    if (mode === "server-mismatch") h.deps.readAccount = async () => "attacker.near";
    await expect(new RegistrationWallet(h.deps).register(q)).rejects.toThrow();
    expect(h.sent).toHaveLength(0);
  }
});

test("concurrent requests refuse; a lost wallet reply is not automatically retried", async () => {
  const h = walletHarness();
  const q = await rpc().chain.registrationQuote(USDC_NEAR, "buildr.near");
  let finish!: () => void;
  h.deps.send = async v => { h.sent.push(v); await new Promise<void>(resolve => { finish = resolve; }); throw Error("lost reply"); };
  const w = new RegistrationWallet(h.deps);
  const first = w.register(q);
  await new Promise(resolve => setTimeout(resolve, 0));
  await expect(w.register(q)).rejects.toThrow("already open");
  finish();
  await expect(first).rejects.toThrow("lost reply");
  expect(h.sent).toHaveLength(1);
});
