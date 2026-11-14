import { afterEach, expect, test } from "bun:test";
import { createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { MarketApi, MarketHttpError } from "../src/server/market/api";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { parseTerms, termsHash } from "../src/shared/terms";
import { onboard, signTerms, START, type Ctx } from "./support/harness";
import { StubPlatform } from "./support/stub-platform";

/** Scripted public Market reads only: no hosted calls, bids, awards or payments. */
const MARKET = "https://market.invalid";
const JOB = "f4a00000-0000-4000-8000-000000000042";
const job = (extra: Record<string, unknown> = {}) => ({
  jobId: JOB, creatorAccountId: "cfb00000-0000-4000-8000-000000000001", title: "CSV export for monthly reports", description: "Export reports as CSV with tests.",
  tags: [], budgetAmount: "300.000000000000", budgetToken: "USDC", requiresVerifiable: false, jobKind: "standard", status: "open",
  maxSlots: 1, currentMaxSlots: 1, isPrivate: false, acceptanceWindowDays: 3, minBuilderVerification: "none", isTestRun: false,
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", ...extra,
});

function market(initial: Record<string, unknown> | "down" = job()) {
  const state = { record: initial, reads: 0 };
  const send = (async (input: string | URL | Request, init?: RequestInit) => {
    state.reads++;
    expect(String(input)).toBe(`${MARKET}/v1/jobs/${JOB}`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer aat_fixture");
    if (state.record === "down") throw new TypeError("offline");
    return Response.json(state.record);
  }) as typeof fetch;
  return { state, api: new MarketApi(MARKET, "aat_fixture", send) };
}

const sourced = { ...JOB_DEMO_TERMS, market_source: { job_id: JOB } };
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

async function runtime(boardApi: MarketApi | null, terms: Record<string, unknown> = sourced) {
  const stub = new StubPlatform(() => new Date(START));
  const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules" }), { clockStart: START, kit: stub.kit(), boardApi });
  closers.push(() => rt.close());
  const { id, contractorToken } = rt.engine.createContract(terms);
  const ctx: Ctx = { rt, stub, id, token: contractorToken, logs: [] };
  await signTerms(ctx);
  return ctx;
}

test("a Market source is an optional signed v3 clause that leaves unsourced terms and hashes unchanged", () => {
  const terms = parseTerms(sourced);
  expect(terms.v === 3 ? terms.market_source : null).toEqual({ job_id: JOB });
  expect(termsHash(parseTerms(sourced))).not.toBe(termsHash(parseTerms(JOB_DEMO_TERMS)));
  expect(parseTerms(JOB_DEMO_TERMS)).not.toHaveProperty("market_source");
  expect(() => parseTerms({ ...sourced, market_source: { job_id: "not-a-uuid" } })).toThrow();
  expect(() => parseTerms({ ...sourced, market_source: { job_id: JOB, award: "x" } })).toThrow();
});

test("a public Market job is read at any status; private, test and mismatched records are refused", async () => {
  const m = market(job({ status: "closed" }));
  expect(await m.api.job(JOB)).toMatchObject({ job_id: JOB, status: "closed", budget_amount: "300.000000000000", budget_token: "USDC", acceptance_window_days: 3 });
  for (const record of [job({ isPrivate: true }), job({ isTestRun: true }), job({ jobId: "f4a00000-0000-4000-8000-000000000043" }), job({ status: "awarded" })]) {
    m.state.record = record;
    await expect(m.api.job(JOB)).rejects.toBeInstanceOf(MarketHttpError);
  }
  await expect(m.api.job("../v1/me")).rejects.toThrow("UUID");
});

test("platform setup and funding wait until the source Market job is closed, and unreadable sources refuse", async () => {
  const m = market();
  const ctx = await runtime(m.api);
  for (const status of ["open", "filling", "in_progress", "completed"]) {
    m.state.record = job({ status });
    await expect(ctx.rt.engine.next(ctx.id)).rejects.toThrow("Close it on the Market");
    await expect(ctx.rt.engine.deposit(ctx.id)).rejects.toThrow("Close it on the Market");
  }
  m.state.record = "down";
  await expect(ctx.rt.engine.next(ctx.id)).rejects.toThrow("could not read the source Agent Market job");
  expect(ctx.stub.calls.requestPayout).toBe(0);
  expect((await ctx.rt.engine.viewContract(ctx.id)).platform.agent_id).toBeNull();

  m.state.record = job({ status: "closed" });
  await onboard(ctx);
  expect((await ctx.rt.engine.viewContract(ctx.id)).platform.agent_id).not.toBeNull();
});

test("without a Market connection a sourced job refuses setup, and unsourced jobs never read the Market", async () => {
  const sourcedCtx = await runtime(null);
  await expect(sourcedCtx.rt.engine.next(sourcedCtx.id)).rejects.toThrow("Market connection is not configured");
  const m = market();
  const plain = await runtime(m.api, JOB_DEMO_TERMS);
  await onboard(plain);
  expect(m.state.reads).toBe(0);
});

test("offers import a public Market job and refuse an unreadable source before anyone signs", async () => {
  const m = market();
  const ctx = await runtime(m.api);
  const imported = await ctx.rt.app.request(`/api/market/jobs/${JOB}`);
  expect(imported.status).toBe(200);
  expect(await imported.json()).toMatchObject({ job_id: JOB, title: "CSV export for monthly reports", status: "open" });
  m.state.record = job({ isPrivate: true });
  expect((await ctx.rt.app.request(`/api/market/jobs/${JOB}`)).status).toBe(404);
  const second = JSON.stringify({ ...sourced, company: "Second agency" });
  const created = await ctx.rt.app.request("/api/contracts", { method: "POST", headers: { "content-type": "application/json" }, body: second });
  expect(created.status).toBe(409);
  expect(await created.json()).toMatchObject({ code: "conflict", error: expect.stringContaining("source Market job could not be read") });
  m.state.record = job();
  const accepted = await ctx.rt.app.request("/api/contracts", { method: "POST", headers: { "content-type": "application/json" }, body: second });
  expect(accepted.status).toBe(201);
  expect(await accepted.json()).toMatchObject({ contractor_token: expect.any(String) });
});
