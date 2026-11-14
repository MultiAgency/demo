import { afterEach, expect, test } from "bun:test";
import { buildApp, createRuntime, type Runtime } from "../src/server/app";
import type { Auth } from "../src/server/auth";
import { loadConfig } from "../src/server/config";
import { MarketApi } from "../src/server/market/api";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { isMarketSettled, MARKET_PAYMENT_TERMS, parseTerms, payeeOf } from "../src/shared/terms";
import { signTerms, START, type Ctx } from "./support/harness";
import { StubPlatform } from "./support/stub-platform";

/** Scripted public Market reads only: no hosted calls, awards, acceptances or payments. */
const MARKET = "https://market.invalid";
const JOB = "f4a00000-0000-4000-8000-000000000077";
const job = (status: string) => ({
  jobId: JOB, creatorAccountId: "cfb00000-0000-4000-8000-000000000001", title: "CSV export", description: "Export reports as CSV.",
  tags: [], budgetAmount: "300.000000000000", budgetToken: "USDC", requiresVerifiable: false, jobKind: "standard", status,
  maxSlots: 1, currentMaxSlots: 0, isPrivate: false, acceptanceWindowDays: 3, minBuilderVerification: "none", isTestRun: false,
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
});
function market(status = "in_progress") {
  const state = { status };
  const send = (async () => Response.json(job(state.status))) as unknown as typeof fetch;
  return { state, api: new MarketApi(MARKET, "aat_fixture", send) };
}

const { payee: _payee, asset: _asset, ...shared } = JOB_DEMO_TERMS as Record<string, unknown>;
const settled = { ...shared, market_source: { job_id: JOB }, payment_terms: MARKET_PAYMENT_TERMS };
const submission = (n: number) => ({
  client_request_id: `market-settled-${n}`, report: "CSV export and tests are ready for review.",
  evidence: [{ deliverable_id: "d1", label: "Tests", url: "https://evidence.invalid/tests" }],
  invoice: { number: `MKT-${n}`, amount_usd: "300" },
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
async function fixture(status = "in_progress") {
  const m = market(status);
  const stub = new StubPlatform(() => new Date(START));
  const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules" }), { clockStart: START, kit: stub.kit(), boardApi: m.api });
  closers.push(() => rt.close());
  const { id, contractorToken } = rt.engine.createContract(settled);
  const ctx: Ctx = { rt, stub, id, token: contractorToken, logs: [] };
  await signTerms(ctx);
  return { ...ctx, m };
}
const payoutRows = (rt: Runtime) => rt.db.query("SELECT COUNT(*) AS n FROM payout_attempts").get() as { n: number };
const builder = (JOB_DEMO_TERMS.contractor as { near_account: string }).near_account;

test("Market-settled terms carry no NEAR payee or asset and require the signed Market job", () => {
  const terms = parseTerms(settled);
  expect(isMarketSettled(terms)).toBe(true);
  expect(payeeOf(terms)).toBeNull();
  expect(terms).not.toHaveProperty("payee");
  expect(() => parseTerms({ ...settled, market_source: undefined })).toThrow();
  expect(() => parseTerms({ ...settled, payee: { chain: "near", address: "maria.demo" } })).toThrow();
  expect(isMarketSettled(parseTerms(JOB_DEMO_TERMS))).toBe(false);
});

test("a Market-settled job never reaches platform setup, funding or payout code", async () => {
  const ctx = await fixture();
  const view = await ctx.rt.engine.viewContract(ctx.id);
  expect(view.stage).toBe("active");
  expect(view.platform.agent_id).toBeNull();
  for (const call of [() => ctx.rt.engine.next(ctx.id), () => ctx.rt.engine.deposit(ctx.id), () => ctx.rt.engine.run(ctx.id)])
    await expect(call()).rejects.toThrow("settles on the Agent Market");
  const verify = await ctx.rt.engine.verify(ctx.id);
  expect(verify).toMatchObject({ overall: "green", expected: null });
  expect(verify.checks.map((c) => c.id)).toEqual(["terms", "sig-representative", "sig-contractor", "market"]);
});

test("the agent assesses without proposing payment; changes, then Market completion, close the review", async () => {
  const ctx = await fixture();
  const engine = ctx.rt.engine;
  const first = await engine.submitJob(ctx.id, submission(1), builder);
  const assessed = await engine.proposeJob(first.id);
  expect(assessed.submissions[0]).toMatchObject({ id: first.id, state: "proposed", proposed_usd: "0" });
  expect(assessed.judgment?.outcome).toBe("nothing");
  expect(assessed.open_judgment).toBeNull();
  await engine.followUpAll();
  expect(payoutRows(ctx.rt).n).toBe(0);
  expect(ctx.stub.calls.requestPayout).toBe(0);

  const changed = await engine.requestJobChanges(first.id, "Add the export column headers.");
  expect(changed.submissions[0]?.state).toBe("changes_requested");
  const second = await engine.submitJob(ctx.id, submission(2), builder);
  await engine.proposeJob(second.id);

  await expect(engine.confirmMarketAcceptance(second.id)).rejects.toThrow("not completed");
  ctx.m.state.status = "completed";
  const accepted = await engine.confirmMarketAcceptance(second.id);
  expect(accepted.submissions.find((s) => s.id === second.id)?.state).toBe("market_accepted");
  await expect(engine.submitJob(ctx.id, submission(3), builder)).rejects.toThrow("covers the whole job");
  expect(engine.jobsFor(builder)[0]?.attention).toMatchObject({ state: "completed", reason_code: "market_accepted" });
  expect(payoutRows(ctx.rt).n).toBe(0);
  expect(ctx.stub.transfers).toEqual([]);
});

test("the agency's refreshing read of a Market-settled job reports no setup failure", async () => {
  const ctx = await fixture();
  const read = await ctx.rt.engine.getContract(ctx.id);
  expect(read.stage).toBe("active");
  expect(read.next_step).toBeNull();
});

test("offers cannot settle on a finished Market job, and Market acceptance is party-only", async () => {
  const ctx = await fixture();
  ctx.m.state.status = "completed";
  const create = await ctx.rt.app.request("/api/contracts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...settled, company: "Another agency" }) });
  expect(create.status).toBe(409);
  expect(await create.json()).toMatchObject({ error: expect.stringContaining("cannot settle this job") });

  ctx.m.state.status = "in_progress";
  const s = await ctx.rt.engine.submitJob(ctx.id, submission(1), builder);
  await ctx.rt.engine.proposeJob(s.id);
  const as = (account: string | null) => {
    const auth = { handler: async () => new Response(), api: { getSession: async () => account ? { user: { id: account } } : null }, nearAccountFor: (id: string) => id } as unknown as Auth;
    return buildApp({ ...ctx.rt, auth, config: { ...ctx.rt.config, auth: { ...ctx.rt.config.auth, required: true } } });
  };
  expect((await as(null).request(`/api/submissions/${s.id}/market-acceptance`, { method: "POST" })).status).toBe(401);
  expect((await as("attacker.demo").request(`/api/submissions/${s.id}/market-acceptance`, { method: "POST" })).status).toBe(403);

  // The agent's assessment stays with the agency until it decides: no judgment or recommendation in the builder's reads.
  const agency = (JOB_DEMO_TERMS.representative as { near_account: string }).near_account;
  const read = async (account: string) => (await as(account).request(`/api/contracts/${ctx.id}`)).json() as Promise<{ judgment: unknown; events: { text: string }[] }>;
  expect((await read(agency)).judgment).not.toBeNull();
  const builderRead = await read(builder);
  expect(builderRead.judgment).toBeNull();
  expect(JSON.stringify(builderRead.events)).not.toMatch(/recommends|Rule-based/);
  ctx.m.state.status = "completed";
  const reply = await as(builder).request(`/api/submissions/${s.id}/market-acceptance`, { method: "POST" });
  expect(reply.status).toBe(200);
  expect(((await reply.json()) as { judgment: unknown }).judgment).toBeNull();
});
