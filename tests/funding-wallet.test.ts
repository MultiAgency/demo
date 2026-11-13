import { expect, test } from "bun:test";
import { FundingWallet, fundingKey, fundingRequest, fundingTransactionFor, assertFundingVerification, validateFunding, type FundingRequest } from "../src/web/funding";
import { USDC_NEAR } from "../src/shared/terms";
import { activate } from "./support/harness";

const request = (): FundingRequest => ({ job: "job", hash: "terms", agent: "agent", sender: "multiagentic.near", token: USDC_NEAR.slice(7), amount: "1000000", address: "ab".repeat(32), memo: null, minimum: "1000", expires: new Date(Date.now() + 60_000).toISOString() });
function harness() {
  const session = { account: "multiagentic.near" as string | null, loading: false, version: 1 };
  const wallet = { account: "multiagentic.near" as string | null, network: "mainnet", connected: true };
  const stored = new Map<string, string>(), sends: FundingRequest[] = [];
  const q = request();
  const deps = { network: "mainnet", session: () => ({ ...session }), wallet: () => ({ ...wallet }), connect: async () => true,
    readAccount: async () => session.account, fresh: async () => ({ ...q }), exclusive: async <T,>(_key: string, work: () => Promise<T>) => work(),
    storage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } },
    send: async (v: FundingRequest) => { expect(stored.has(fundingKey(v))).toBe(true); sends.push(v); } };
  return { q, deps, session, wallet, stored, sends };
}
test("funding uses the exact signed scope in atomic USDC and refuses unready, funded and DAO jobs", async () => {
  const ctx = await activate("0");
  const c = await ctx.rt.engine.getContract(ctx.id); c.platform.mode = "remote";
  const d = { address: "ab".repeat(32), memo: null, minAmount: "1000", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  expect(fundingRequest(c, d)).toMatchObject({ amount: "1000000000", token: USDC_NEAR.slice(7), sender: "acme.demo", address: d.address });
  expect(fundingRequest({ ...c, total_usd: "1" }, d).amount).toBe("1000000000");
  for (const change of [{ platform: { ...c.platform, mode: "fake" as const } }, { terms: { ...c.terms, v: 3 as const, agency_owner: { type: "dao" as const, account_id: "agency.sputnik-dao.near" } } }, { stage: "active" as const }, { platform: { ...c.platform, policy: null } }, { terms: { ...c.terms, asset: "nep141:wrong.near" } }])
    expect(() => fundingRequest({ ...c, ...change } as typeof c, d)).toThrow();
});
test("invalid token, sender, amount, recipient, memo, minimum and expiry refuse", () => {
  for (const change of [{ memo: "unreviewed-tag" }, { token: "wrong.near" }, { sender: "attacker.near" }, { amount: "1.5" }, { amount: "0" }, { address: "0xwrong".repeat(20) }, { minimum: "1000001" }, { minimum: "-1" }, { expires: "bad" }, { expires: new Date(0).toISOString() }])
    expect(() => validateFunding({ ...request(), ...change }, "multiagentic.near")).toThrow();
});
test("a funding request is persisted before a single send and survives wallet failure/reload", async () => {
  const h = harness();
  h.deps.send = async q => { expect(h.stored.has(fundingKey(q))).toBe(true); h.sends.push(q); throw Error("lost wallet reply"); };
  await expect(new FundingWallet(h.deps).fund(h.q)).rejects.toThrow("lost wallet reply");
  await expect(new FundingWallet(h.deps).fund(h.q)).rejects.toThrow("prior funding request");
  expect(h.sends).toEqual([h.q]);
});
test("identity, network, session, changed instructions and unavailable storage refuse before sending", async () => {
  for (const mode of ["wallet", "network", "session", "server", "cancel", "recipient", "amount", "expiry", "storage", "other-tab"]) {
    const h = harness();
    if (mode === "wallet") h.wallet.account = "buildr.near";
    if (mode === "network") h.wallet.network = "testnet";
    if (mode === "session") h.deps.connect = async () => { h.session.version++; return true; };
    if (mode === "server") h.deps.readAccount = async () => "buildr.near";
    if (mode === "cancel") h.deps.connect = async () => false;
    if (mode === "recipient") h.deps.fresh = async () => ({ ...h.q, address: "attacker.near" });
    if (mode === "amount") h.deps.fresh = async () => ({ ...h.q, amount: "2000000" });
    if (mode === "expiry") h.deps.fresh = async () => ({ ...h.q, expires: new Date(0).toISOString() });
    if (mode === "storage") h.deps.storage.setItem = () => { throw Error("storage unavailable"); };
    if (mode === "other-tab") h.deps.exclusive = async () => { throw Error("other tab"); };
    await expect(new FundingWallet(h.deps).fund(h.q)).rejects.toThrow(); expect(h.sends).toHaveLength(0);
  }
});
test("concurrent clicks cannot open a second wallet request", async () => {
  const h = harness(); let finish!: () => void;
  h.deps.send = async q => { h.sends.push(q); await new Promise<void>(resolve => { finish = resolve; }); };
  const w = new FundingWallet(h.deps), first = w.fund(h.q);
  await new Promise(resolve => setTimeout(resolve, 0));
  await expect(w.fund(h.q)).rejects.toThrow("already open"); finish(); await first; expect(h.sends).toHaveLength(1);
});

test("pinned SDK funding registers the deposit address and sends exact atomic USDC in one transaction", () => {
  const q = request(), tx = fundingTransactionFor(q);
  expect(tx.receiverId).toBe(q.token);
  expect(tx.actions.map(a => a.params)).toEqual([
    { methodName: "storage_deposit", args: { account_id: q.address, registration_only: true }, gas: "30000000000000", deposit: "1250000000000000000000" },
    { methodName: "ft_transfer", args: { receiver_id: q.address, amount: "1000000" }, gas: "30000000000000", deposit: "1" },
  ]);
});

test("funding requires fresh signed-policy/authority verification and refuses an already credited balance", async () => {
  const ctx = await activate("0"), c = await ctx.rt.engine.getContract(ctx.id); c.platform.mode = "remote";
  const q = fundingRequest(c, { address: "ab".repeat(32), memo: null, minAmount: null, expiresAt: null });
  const v = await ctx.rt.engine.verify(ctx.id);
  assertFundingVerification(q, v);
  for (const change of [{ overall: "red" as const }, { observed: { ...v.observed!, usdc: "1" } }, { observed: { ...v.observed!, agentId: "foreign" } }, { checks: v.checks.filter(c => c.id !== "signed") }])
    expect(() => assertFundingVerification(q, { ...v, ...change })).toThrow();
});
