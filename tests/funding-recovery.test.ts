import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildApp } from "../src/server/app";
import type { Auth } from "../src/server/auth";
import type { Deps } from "../src/server/engine";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { fundingPlanHash, type FundingReconciliation, type FundingRecoveryBinding } from "../src/shared/funding-recovery";
import { USDC_NEAR } from "../src/shared/terms";
import { assertFundingVerification, FundingWallet, fundingKey, fundingRecoveryRequest, fundingTransactionFor, refreshRecoveryFunding } from "../src/web/funding";
import { activate, agentId, type Ctx } from "./support/harness";

const depsOf = (ctx: Ctx) => (ctx.rt.engine as unknown as { d: Deps }).d;
async function close(ctx: Ctx) { await (await ctx.rt.auth.$context).checkSchema?.(); depsOf(ctx).db.close(); }
function clearedRecovery(binding: FundingRecoveryBinding, now: number): FundingReconciliation {
  return { ...binding, schema_version: 1, reconciliation_id: "recovery-original-1", asset: USDC_NEAR, chain: "near", network: "mainnet",
    observed_at: new Date(now).toISOString(), expires_at: new Date(now + 120_000).toISOString(),
    original_allocation: { state: "resolved", resolution: "provider_recovery_procedure", evidence_reference: "provider-reviewed-legacy-case" },
    route_ready: true, credited_atomic: "10000", available_atomic: "10000", expected_credit_atomic: "990000", fee_atomic: "1000", transfer_atomic: "991000",
    destination: { address: "ab".repeat(32), allocation_request_id: "allocation-original-request", correlation_id: "allocation-original-correlation",
      can_receive_this_transfer: true, minimum_atomic: "1000", expires_at: new Date(now + 600_000).toISOString(), memo: null } };
}
async function fixture() {
  const ctx = await activate("0.01", { ...JOB_DEMO_TERMS, scope: [{ ...JOB_DEMO_TERMS.scope[0]!, value_usd: "1" }] });
  const deps = depsOf(ctx);
  let binding!: FundingRecoveryBinding;
  const issuedAt = ctx.rt.clock.now().getTime();
  deps.platform.fundingRecovery = async input => { binding = { ...input }; return clearedRecovery(binding, issuedAt); };
  return { ctx, deps, binding: () => binding };
}

test("recovery reads trusted clearance without allocating, rewriting cached instructions, or dropping markers", async () => {
  const { ctx, deps } = await fixture();
  try {
    const c = await ctx.rt.engine.viewContract(ctx.id);
    c.platform.mode = "remote";
    deps.db.query("INSERT INTO events(contract_id,at,kind,text) VALUES (?,?,'deposit_pending','Original unknown allocation')").run(ctx.id, ctx.rt.clock.now().toISOString());
    const agentBefore = deps.db.query("SELECT * FROM platform_agents").all();
    const eventsBefore = deps.db.query("SELECT * FROM events").all();
    deps.db.exec("PRAGMA query_only = ON");
    const reviewed = await ctx.rt.engine.fundingRecovery(ctx.id);
    expect(reviewed.state).toBe("ready");
    if (reviewed.state !== "ready") throw Error(JSON.stringify(reviewed));
    expect(reviewed.plan.transfer_atomic).toBe("991000");
    expect(deps.db.query("SELECT * FROM platform_agents").all()).toEqual(agentBefore);
    expect(deps.db.query("SELECT * FROM events").all()).toEqual(eventsBefore);
    expect(deps.db.query("SELECT * FROM funding_recovery_attempts").all()).toEqual([]);
    const q = fundingRecoveryRequest(c, reviewed, ctx.rt.clock.now().getTime());
    expect(q.amount).toBe("991000");
    expect(q.recovery?.credited_atomic).toBe("10000");
  } finally { deps.db.exec("PRAGMA query_only = OFF"); await close(ctx); }
});

test("missing provider contract, unresolved reports, wrong bindings, stale evidence and bad amounts fail closed", async () => {
  const { ctx, deps, binding } = await fixture();
  try {
    const read = deps.platform.fundingRecovery!;
    delete deps.platform.fundingRecovery;
    expect(await ctx.rt.engine.fundingRecovery(ctx.id)).toMatchObject({ state: "blocked", code: "platform_recovery_unavailable" });
    deps.platform.fundingRecovery = read;
    const good = await ctx.rt.engine.fundingRecovery(ctx.id);
    expect(good.state).toBe("ready");
    const now = ctx.rt.clock.now().getTime(), base = clearedRecovery(binding(), now);
    const variants = [
      { ...base, original_allocation: { ...base.original_allocation, state: "unknown" } },
      { ...base, route_ready: false }, { ...base, job_id: "foreign-job" }, { ...base, owner: "other.demo" },
      { ...base, agent_id: "other-agent" }, { ...base, terms_hash: "f".repeat(64) }, { ...base, deployment: "other-deployment" },
      { ...base, app_origin: "https://evil.invalid" }, { ...base, platform_host: "other.invalid" },
      { ...base, observed_at: new Date(now - 600_000).toISOString() }, { ...base, expires_at: new Date(now - 1).toISOString() },
      { ...base, available_atomic: "9000" }, { ...base, target_atomic: "2000000" }, { ...base, transfer_atomic: "1000000" },
      { ...base, destination: { ...base.destination, can_receive_this_transfer: false } },
      { ...base, destination: { ...base.destination, minimum_atomic: "1000000" } },
      { ...base, credited_atomic: "1000000", available_atomic: "1000000" },
    ];
    for (const plan of variants) {
      deps.platform.fundingRecovery = async () => plan;
      expect((await ctx.rt.engine.fundingRecovery(ctx.id)).state).toBe("blocked");
    }
    deps.platform.fundingRecovery = async () => { throw Error("offline"); };
    expect(await ctx.rt.engine.fundingRecovery(ctx.id)).toMatchObject({ state: "blocked", code: "reconciliation_unavailable" });
    expect(deps.db.query("SELECT * FROM funding_recovery_attempts").all()).toEqual([]);
    expect(ctx.stub.calls.requestPayout).toBe(0);
    deps.platform.fundingRecovery = async () => ({ ...base, credited_atomic: "20000", available_atomic: "20000", expected_credit_atomic: "980000", transfer_atomic: "981000" });
    expect(await ctx.rt.engine.fundingRecovery(ctx.id)).toMatchObject({ state: "blocked", code: "policy_unverified" });
  } finally { await close(ctx); }
});

test("recovery is representative-only; copied receipts cannot be uploaded as authority", async () => {
  const { ctx, deps } = await fixture();
  let account: string | null = null;
  const auth = { handler: async () => new Response("fixture"), api: { getSession: async () => account ? { user: { id: account } } : null }, nearAccountFor: (id: string) => id } as unknown as Auth;
  const app = buildApp({ ...ctx.rt, auth, config: { ...ctx.rt.config, auth: { ...ctx.rt.config.auth, required: true } } });
  const origin = deps.config.auth.publicUrl;
  try {
    for (const actor of [null, "maria.demo", "foreign.demo"]) {
      account = actor;
      for (const [path, init] of [[`/api/contracts/${ctx.id}/funding-recovery`, {}], [`/api/contracts/${ctx.id}/funding-recovery/prepare`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }]] as const)
        expect((await app.request(origin + path, init)).status).toBe(actor ? 403 : 401);
    }
    account = "acme.demo";
    const reviewed = await (await app.request(`${origin}/api/contracts/${ctx.id}/funding-recovery`)).json();
    expect(reviewed.state).toBe("ready");
    const response = await app.request(`${origin}/api/contracts/${ctx.id}/funding-recovery/prepare`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reconciliation_id: reviewed.plan.reconciliation_id, plan_hash: reviewed.plan.plan_hash, plan: reviewed.plan }) });
    expect(response.status).toBe(400);
    expect(deps.db.query("SELECT * FROM funding_recovery_attempts").all()).toEqual([]);
  } finally { await close(ctx); }
});

test("a lost prepare response and concurrent clients cannot claim or send a second recovery", async () => {
  const { ctx, deps } = await fixture();
  try {
    const review = await ctx.rt.engine.fundingRecovery(ctx.id);
    if (review.state !== "ready") throw Error(JSON.stringify(review));
    const { Engine } = await import("../src/server/engine");
    const calls = await Promise.allSettled([ctx.rt.engine, new Engine(deps)].map(engine => engine.prepareFundingRecovery(ctx.id, review.plan.reconciliation_id, review.plan.plan_hash)));
    expect(calls.filter(c => c.status === "fulfilled")).toHaveLength(1);
    expect(calls.filter(c => c.status === "rejected")).toHaveLength(1);
    expect(deps.db.query("SELECT id,state FROM funding_recovery_attempts").all()).toEqual([{ id: `fr_${review.plan.plan_hash}`, state: "wallet_outcome_unknown" }]);
    const reopened = Database.deserialize(deps.db.serialize());
    try {
      const restarted = new Engine({ ...deps, db: reopened });
      expect(await restarted.fundingRecovery(ctx.id)).toMatchObject({ state: "blocked", code: "wallet_outcome_unknown" });
      await expect(restarted.prepareFundingRecovery(ctx.id, review.plan.reconciliation_id, review.plan.plan_hash)).rejects.toThrow();
      await expect(restarted.deposit(ctx.id)).rejects.toThrow("Recovery funding may already");
    } finally { reopened.close(); }
    expect(ctx.stub.calls.requestPayout).toBe(0);
  } finally { await close(ctx); }
});

test("recovery wallet transfers exact reconciled amount and preserves an interrupted send marker", async () => {
  const { ctx } = await fixture();
  const stored = new Map<string, string>();
  let sends = 0;
  try {
    const reviewed = await ctx.rt.engine.fundingRecovery(ctx.id);
    const c = await ctx.rt.engine.viewContract(ctx.id); c.platform.mode = "remote";
    // Wallet guard uses real browser time; use a current, internally consistent fixture observation here.
    if (reviewed.state !== "ready") throw Error(JSON.stringify(reviewed));
    const plan = { ...reviewed.plan, observed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 120_000).toISOString(),
      destination: { ...reviewed.plan.destination, expires_at: new Date(Date.now() + 600_000).toISOString() } };
    const { plan_hash: _old, ...body } = plan;
    const view = { ...reviewed, plan: { ...body, plan_hash: fundingPlanHash(body) } };
    const q = fundingRecoveryRequest(c, view);
    const tx = fundingTransactionFor(q);
    expect(tx.actions[1]!.params.args).toMatchObject({ amount: "991000", receiver_id: q.address });
    const verify = await ctx.rt.engine.verify(ctx.id);
    expect(() => assertFundingVerification(q, verify)).not.toThrow();
    const paths: string[] = [];
    const prepared = await refreshRecoveryFunding(q, async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
      paths.push(`${method} ${path}`);
      if (method === "GET" && path.endsWith("/funding-recovery")) return view as T;
      if (method === "GET" && path.endsWith("/verify")) return verify as T;
      if (method === "POST" && path.endsWith("/funding-recovery/prepare")) {
        expect(body).toEqual({ reconciliation_id: q.recovery!.reconciliation_id, plan_hash: q.recovery!.plan_hash });
        return { attempt_id: "fixture-claimed" } as T;
      }
      throw Error("Recovery must not allocate or run the ordinary contract reconciliation route");
    });
    expect(prepared).toEqual(q);
    expect(paths).toEqual([`GET /contracts/${ctx.id}/funding-recovery`, `GET /contracts/${ctx.id}/verify`, `POST /contracts/${ctx.id}/funding-recovery/prepare`]);
    const wallet = new FundingWallet({ network: "mainnet", session: () => ({ account: q.sender, loading: false, version: 1 }),
      connect: async () => true, readAccount: async () => q.sender, wallet: () => ({ account: q.sender, network: "mainnet", connected: true }),
      fresh: async () => q, exclusive: async (_key, work) => work(), storage: { getItem: k => stored.get(k) ?? null, setItem: (k, v) => { stored.set(k, v); } },
      send: async () => { sends++; expect(stored.has(fundingKey(q))).toBe(true); throw Error("response lost"); } });
    await expect(wallet.fund(q)).rejects.toThrow("response lost");
    await expect(wallet.fund(q)).rejects.toThrow("prior funding request");
    expect(sends).toBe(1);
    // An old ordinary-flow marker also blocks recovery; no automatic reset or alternate storage key.
    expect(fundingKey(q)).toBe(fundingKey({ ...q, recovery: undefined }));
  } finally { await close(ctx); }
});

async function preparedAttempt() {
  const f = await fixture();
  const review = await f.ctx.rt.engine.fundingRecovery(f.ctx.id);
  if (review.state !== "ready") throw Error(JSON.stringify(review));
  await f.ctx.rt.engine.prepareFundingRecovery(f.ctx.id, review.plan.reconciliation_id, review.plan.plan_hash);
  return { ...f, plan: review.plan };
}
const notReceived = (plan: { destination: { correlation_id: string; allocation_request_id: string } }, at: number, extra: Record<string, unknown> = {}) => ({
  schema_version: 1, correlation_id: plan.destination.correlation_id, allocation_request_id: plan.destination.allocation_request_id,
  state: "not_received", destination_expired: true, received_atomic: "0", observed_at: new Date(at).toISOString(), ...extra,
});

test("an open recovery attempt keeps blocking funding until evidence; a cancelled wallet, errors and silence resolve nothing", async () => {
  const { ctx, deps, plan } = await preparedAttempt();
  try {
    const engine = ctx.rt.engine;
    expect(await engine.observeFundingRecovery(ctx.id)).toMatchObject({ outcome: null });
    deps.platform.fundingRecoveryOutcome = async () => { throw Error("provider offline"); };
    expect(await engine.observeFundingRecovery(ctx.id)).toMatchObject({ outcome: null });
    // A claim before the destination has expired, a foreign destination or a stale report is not evidence.
    deps.platform.fundingRecoveryOutcome = async () => notReceived(plan, ctx.rt.clock.now().getTime());
    expect(await engine.observeFundingRecovery(ctx.id)).toMatchObject({ outcome: null });
    ctx.rt.clock.advance(601_000);
    deps.platform.fundingRecoveryOutcome = async () => notReceived(plan, ctx.rt.clock.now().getTime(), { correlation_id: "another-allocation" });
    expect(await engine.observeFundingRecovery(ctx.id)).toMatchObject({ outcome: null });
    deps.platform.fundingRecoveryOutcome = async () => notReceived(plan, ctx.rt.clock.now().getTime() - 301_000);
    expect(await engine.observeFundingRecovery(ctx.id)).toMatchObject({ outcome: null });
    expect(await engine.fundingRecovery(ctx.id)).toMatchObject({ state: "blocked", code: "wallet_outcome_unknown" });
    await expect(engine.deposit(ctx.id)).rejects.toThrow("Recovery funding may already");
    expect(deps.db.query("SELECT outcome FROM funding_recovery_attempts").all()).toEqual([{ outcome: null }]);
  } finally { await close(ctx); }
});

test("a verified balance at the signed total resolves the attempt as funded", async () => {
  const { ctx, deps } = await preparedAttempt();
  try {
    await ctx.rt.kit.controls!.fund(agentId(ctx), "990000");
    expect(await ctx.rt.engine.observeFundingRecovery(ctx.id)).toMatchObject({ outcome: "funded" });
    expect(deps.db.query("SELECT outcome FROM funding_recovery_attempts").all()).toEqual([{ outcome: "funded" }]);
    expect(await ctx.rt.engine.fundingRecovery(ctx.id)).not.toMatchObject({ code: "wallet_outcome_unknown" });
    await expect(ctx.rt.engine.observeFundingRecovery(ctx.id)).rejects.toThrow("no unresolved");
  } finally { await close(ctx); }
});

test("only a confirmed empty expired destination with an unchanged balance ends an attempt as not received; then one new attempt", async () => {
  const { ctx, deps, plan } = await preparedAttempt();
  try {
    const engine = ctx.rt.engine;
    ctx.rt.clock.advance(601_000);
    deps.platform.fundingRecoveryOutcome = async () => notReceived(plan, ctx.rt.clock.now().getTime());
    // A changed balance below the target is unexplained money movement, not proof that nothing arrived.
    await ctx.rt.kit.controls!.fund(agentId(ctx), "5000");
    expect(await engine.observeFundingRecovery(ctx.id)).toMatchObject({ outcome: null });
    const stub = ctx.stub as unknown as { agents: Map<string, { agentId: string; balance: bigint }> };
    for (const a of stub.agents.values()) if (a.agentId === agentId(ctx)) a.balance -= 5000n;
    expect(await engine.observeFundingRecovery(ctx.id)).toMatchObject({ outcome: "not_received" });
    const reissued = ctx.rt.clock.now().getTime();
    deps.platform.fundingRecovery = async (input) => ({ ...clearedRecovery({ ...input }, reissued), reconciliation_id: "recovery-original-2" });
    const fresh = await engine.fundingRecovery(ctx.id);
    if (fresh.state !== "ready") throw Error(JSON.stringify(fresh));
    await engine.prepareFundingRecovery(ctx.id, fresh.plan.reconciliation_id, fresh.plan.plan_hash);
    expect(deps.db.query("SELECT outcome FROM funding_recovery_attempts ORDER BY created_at, rowid").all()).toEqual([{ outcome: "not_received" }, { outcome: null }]);
    await expect(engine.prepareFundingRecovery(ctx.id, fresh.plan.reconciliation_id, fresh.plan.plan_hash)).rejects.toThrow();
    expect(ctx.stub.calls.requestPayout).toBe(0);
  } finally { await close(ctx); }
});

test("the first recovery schema is rebuilt once, preserving every attempt as unresolved; an uncopyable row refuses", async () => {
  const { openDb } = await import("../src/server/db");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { ctx, deps } = await fixture();
  try {
    const legacy = (contract: string) => {
      const path = `${mkdtempSync(`${tmpdir()}/recovery-migration-`)}/db.sqlite`;
      writeFileSync(path, deps.db.serialize());
      const db = new Database(path);
      db.exec("DROP INDEX one_open_funding_recovery");
      db.exec("DROP TABLE funding_recovery_attempts");
      db.exec(`CREATE TABLE funding_recovery_attempts (id TEXT PRIMARY KEY, contract_id TEXT NOT NULL UNIQUE REFERENCES contracts(id), reconciliation_id TEXT NOT NULL,
        plan_hash TEXT NOT NULL, plan TEXT NOT NULL, state TEXT NOT NULL CHECK (state = 'wallet_outcome_unknown'), created_at TEXT NOT NULL)`);
      db.query("INSERT INTO funding_recovery_attempts VALUES ('fr_original', ?, 'rec-1', ?, '{}', 'wallet_outcome_unknown', '2026-11-13T00:00:00.000Z')").run(contract, "a".repeat(64));
      db.close();
      return path;
    };
    const path = legacy(ctx.id);
    for (let i = 0; i < 2; i++) {
      const db = openDb(path);
      expect(db.query("SELECT id, contract_id, outcome FROM funding_recovery_attempts").all()).toEqual([{ id: "fr_original", contract_id: ctx.id, outcome: null }]);
      expect((db.query("SELECT sql FROM sqlite_master WHERE name = 'funding_recovery_attempts'").get() as { sql: string }).sql).not.toMatch(/NOT NULL UNIQUE/);
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'one_open_funding_recovery'").get()).toBeTruthy();
      db.close();
    }
    // A row that cannot be copied (here: its job is missing) stops startup and leaves the original table and row in place.
    const orphan = legacy("c_missing_job");
    expect(() => openDb(orphan)).toThrow();
    const kept = new Database(orphan, { readonly: true });
    expect(kept.query("SELECT id FROM funding_recovery_attempts").all()).toEqual([{ id: "fr_original" }]);
    expect((kept.query("SELECT sql FROM sqlite_master WHERE name = 'funding_recovery_attempts'").get() as { sql: string }).sql).toMatch(/NOT NULL UNIQUE/);
    kept.close();
  } finally { await close(ctx); }
});
