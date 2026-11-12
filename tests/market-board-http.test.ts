import { describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { buildApp, createRuntime, type Runtime } from "../src/server/app";
import type { Auth } from "../src/server/auth";
import { loadConfig } from "../src/server/config";
import { Market } from "../src/server/market";
import { MarketApi } from "../src/server/market/api";
import type { OpenJobsPage } from "../src/shared/market-board";
import { StubMarket, registeredChain } from "./support/market-stub";
import { StubPlatform } from "./support/stub-platform";

const DESK = "https://desk.paperwork.test";
const OLD_JOBS = "https://jobs.paperwork.test";
const MARKET = "https://market.invalid";
const TOKEN = "aat_board_fixture_secret";
const WORKER_TOKEN = "aat_worker_fixture_secret";
const NOW = "2026-11-11T12:00:00.000Z";
type Send = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const urlOf = (input: string | URL | Request) => new URL(typeof input === "string" || input instanceof URL ? input : input.url);
const jobId = (n: number) => `f4a00000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Official flat JobView shape, with a whole-currency decimal budget, not atomic USDC. */
const publicJob = (n: number, extra: Record<string, unknown> = {}) => ({
  jobId: jobId(n), creatorAccountId: "cfb00000-0000-4000-8000-000000000001", title: `Open job ${n}`, description: `Public brief ${n}`,
  tags: ["csv"], budgetAmount: "300.000000000000", budgetToken: "USDC", requiresVerifiable: false,
  jobKind: "standard", status: "open", maxSlots: 3, currentMaxSlots: 2, isPrivate: false,
  acceptanceWindowDays: 3, minBuilderVerification: "none", isTestRun: false, createdAt: NOW, updatedAt: NOW,
  entriesCloseAt: null, submittedAt: null, origin: null,
  creator: { accountId: "cfb00000-0000-4000-8000-000000000001", displayName: "Public agency", avatarUrl: null },
  ...extra,
});

const env = { PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules", REQUIRE_AUTH: "true", PUBLIC_URL: DESK,
  MARKET_URL: MARKET, PAPERWORK_MARKET_BOARD_TOKEN: TOKEN };
const dbOf = (rt: Runtime) => (rt.engine as unknown as { d: { db: Database } }).d.db;
async function fixture(send: Send | null) {
  const platform = new StubPlatform(() => new Date(NOW));
  const logs: string[] = [];
  const rt = await createRuntime(loadConfig(env), { kit: platform.kit(), clockStart: Date.parse(NOW), log: (line) => logs.push(line),
    boardApi: send ? new MarketApi(MARKET, TOKEN, send as typeof fetch) : null });
  return { rt, platform, logs, async close() { await (await rt.auth.$context).checkSchema?.(); dbOf(rt).close(); } };
}

function request(app: ReturnType<typeof buildApp>, host: string, query = "", headers: Record<string, string> = {}) {
  return app.request(`${host}/api/market/jobs${query}`, { headers: { origin: host, ...headers } });
}
async function page(response: Response): Promise<OpenJobsPage> {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(["checked_at", "jobs", "next_offset", "offset"]);
  expect(new Date(body.checked_at).toISOString()).toBe(body.checked_at);
  return body;
}

describe("public Market board in Desk", () => {
  test("board-only configuration needs no worker triple and keeps explicit/fallback credentials separate", async () => {
    const boardOnly = loadConfig({ ...env, PAPERWORK_MARKET_BOARD_TOKEN: "aat_fixture" });
    expect(boardOnly.market.boardToken).toBe("aat_fixture");
    expect(boardOnly.market.worker).toBeNull();
    expect(() => loadConfig({ ...env, PAPERWORK_MARKET_BOARD_TOKEN: "not-an-agent-token" })).toThrow(/PAPERWORK_MARKET_BOARD_TOKEN/);
    const workerEnv = { MARKET_AGENT_TOKEN: WORKER_TOKEN, MARKET_WEBHOOK_SECRET: "fixture-webhook-secret", MARKET_WORKER_AGENCY: "agency-fixture" };
    const explicit = loadConfig({ ...env, ...workerEnv });
    expect(explicit.market.boardToken).toBe(TOKEN);
    expect(explicit.market.worker?.token).toBe(WORKER_TOKEN);
    const fallback = loadConfig({ ...env, PAPERWORK_MARKET_BOARD_TOKEN: undefined, ...workerEnv });
    expect(fallback.market.worker?.token).toBe(WORKER_TOKEN);
    const rt = await createRuntime(fallback, { kit: new StubPlatform(() => new Date(NOW)).kit() });
    try {
      // Runtime constructs a board reader from the existing worker credential even without an SDK Market kit.
      // No default client's request is invoked: credential selection is not tested by monkeypatching global fetch.
      expect(rt.market).toBeNull();
      expect(rt.boardApi).toBeInstanceOf(MarketApi);
      expect(rt.config.market.worker?.token).toBe(WORKER_TOKEN);
    } finally { await (await rt.auth.$context).checkSchema?.(); dbOf(rt).close(); }
  });

  test("anonymous Desk tabs expose only whitelisted public open/filling jobs without an SDK Market", async () => {
    const calls: { url: URL; method: string; authorization: string | null; cookie: string | null }[] = [];
    const ctx = await fixture(async (input, init) => {
      const url = urlOf(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, method: init?.method ?? "GET", authorization: headers.get("authorization"), cookie: headers.get("cookie") });
      return Response.json({ jobs: [
        publicJob(1, { credential: TOKEN, adminSecret: "server-only-marker", creator: { displayName: "Public agency", accountId: jobId(900), slug: "private-login", email: "private@example.invalid" } }),
        publicJob(2, { status: "filling", budgetAmount: null }),
        publicJob(3, { isPrivate: true, description: "PRIVATE-BRIEF-MUST-NOT-ESCAPE" }),
        publicJob(4, { status: "closed" }), publicJob(5, { isTestRun: true }),
      ], providerInternal: TOKEN });
    });
    try {
      expect(ctx.rt.market).toBeNull();
      expect(ctx.rt.kit.market ?? null).toBeNull();
      expect(ctx.rt.config.auth.required).toBe(true);
      const pages = [];
      for (const tab of [ctx.rt.app, buildApp(ctx.rt)]) {
        const response = await request(tab, DESK, "", { authorization: "Bearer client-must-not-be-forwarded", cookie: "not-an-auth-cookie=fixture" });
        const body = await page(response);
        pages.push(body.jobs);
        expect(body).toMatchObject({ offset: 0, next_offset: null });
        expect(body.jobs.map((job) => [job.job_id, job.status])).toEqual([[jobId(1), "open"], [jobId(2), "filling"]]);
        expect(body.jobs[0]).toEqual({ job_id: jobId(1), title: "Open job 1", description: "Public brief 1", budget_amount: "300.000000000000", budget_token: "USDC",
          kind: "standard", status: "open", tags: ["csv"], posted_at: NOW, creator_name: "Public agency", slots_available: 2, max_slots: 3,
          acceptance_window_days: 3, minimum_verification: "none", entries_close_at: null });
        const serialized = JSON.stringify(body);
        for (const secret of [TOKEN, "server-only-marker", "private-login", "private@example.invalid", "PRIVATE-BRIEF-MUST-NOT-ESCAPE"])
          expect(serialized).not.toContain(secret);
        const config = await (await tab.request(`${DESK}/api/config`)).text();
        expect(config).not.toContain(TOKEN);
        expect(config).not.toContain("boardToken");
      }
      expect(pages[0]).toEqual(pages[1]);
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.url.origin + call.url.pathname).toBe(`${MARKET}/v1/jobs/board`);
        expect(call.url.searchParams.get("limit")).toBe("51");
        expect(call.method).toBe("GET");
        expect(call.authorization).toBe(`Bearer ${TOKEN}`);
        expect(call.cookie).toBeNull();
      }
      expect(ctx.platform.calls.requestPayout).toBe(0);
      expect(ctx.platform.transfers).toEqual([]);
      expect(ctx.logs.join("\n")).not.toContain(TOKEN);
    } finally { await ctx.close(); }
  });

  test("foreign hosts and origins are rejected before any board transport is used", async () => {
    let calls = 0;
    const ctx = await fixture(async () => { calls++; return Response.json({ jobs: [] }); });
    try {
      for (const host of [OLD_JOBS, "https://evil.paperwork.test"])
        expect((await request(ctx.rt.app, host, "", { "x-forwarded-host": new URL(DESK).host, origin: DESK })).status).toBe(421);
      for (const origin of [OLD_JOBS, "https://evil.paperwork.test", "http://desk.paperwork.test", "https://desk.paperwork.test:444"])
        expect((await request(ctx.rt.app, DESK, "", { origin })).status).toBe(403);
      expect(calls).toBe(0);
      expect((await request(ctx.rt.app, DESK, "", { origin: DESK })).status).toBe(200);
      expect(calls).toBe(1);
    } finally { await ctx.close(); }
  });

  test("only valid board filters reach the fixed upstream GET, with encoded search and offset preserved", async () => {
    const urls: URL[] = [];
    const ctx = await fixture(async (input, init) => { expect(init?.method).toBe("GET"); urls.push(urlOf(input)); return Response.json({ jobs: [] }); });
    try {
      for (const query of ["?kind=other", "?sort=rank", "?offset=-1", "?offset=0.5", "?offset=no", "?offset=Infinity", "?offset=9007199254740992", `?q=${"x".repeat(201)}`])
        expect((await request(ctx.rt.app, DESK, query)).status).toBe(400);
      expect(urls).toEqual([]);
      const q = "payroll & export? #1 ☕";
      const body = await page(await request(ctx.rt.app, DESK, `?${new URLSearchParams({ q, kind: "competition", sort: "budget", offset: "100" })}`));
      expect(body.offset).toBe(100);
      expect(urls).toHaveLength(1);
      expect(urls[0]!.pathname).toBe("/v1/jobs/board");
      expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({ q, kind: "competition", sort: "budget", limit: "51", offset: "100" });
      expect(ctx.platform.calls.requestPayout).toBe(0);
    } finally { await ctx.close(); }
  });

  for (const total of [100, 201]) test(`HTTP pagination reaches all ${total} public jobs without a hidden first-page cap`, async () => {
    const jobs = Array.from({ length: total }, (_, i) => publicJob(i + 1));
    const offsets: number[] = [];
    const ctx = await fixture(async (input, init) => {
      expect(init?.method).toBe("GET");
      const url = urlOf(input);
      expect(url.searchParams.get("limit")).toBe("51");
      const offset = Number(url.searchParams.get("offset")); offsets.push(offset);
      return Response.json({ jobs: jobs.slice(offset, offset + 51) });
    });
    try {
      const found: string[] = [];
      let offset: number | null = 0;
      for (let count = 0; offset !== null && count < 10; count++) {
        const body = await page(await request(ctx.rt.app, DESK, `?offset=${offset}`));
        found.push(...body.jobs.map((job) => job.job_id));
        offset = body.next_offset;
      }
      expect(offset).toBeNull();
      expect(found).toEqual(jobs.map((job) => job.jobId));
      expect(new Set(found).size).toBe(total);
      expect(offsets).toEqual(total === 100 ? [0, 50] : [0, 50, 100, 150, 200]);
    } finally { await ctx.close(); }
  });

  test("a missing board connection is unavailable, not a successful empty market", async () => {
    const ctx = await fixture(null);
    try {
      for (const tab of [ctx.rt.app, buildApp(ctx.rt)]) {
        const response = await request(tab, DESK);
        expect(response.status).toBe(503);
        const body = await response.json();
        expect(body.error).toContain("not connected");
        expect(body.jobs).toBeUndefined();
        expect(body.next_offset).toBeUndefined();
      }
    } finally { await ctx.close(); }
  });

  test("upstream credential/outage failures stay board failures without exposing credentials, provider bodies or false page completion", async () => {
    let failure = 401;
    let calls = 0;
    const ctx = await fixture(async (input, init) => {
      calls++;
      expect(init?.method).toBe("GET");
      if (urlOf(input).searchParams.get("offset") === "0")
        return Response.json({ jobs: Array.from({ length: 51 }, (_, i) => publicJob(i + 1)) });
      if (!failure) throw new Error(`transport contains ${TOKEN}`);
      return new Response(JSON.stringify({ error: TOKEN, providerSecret: "PRIVATE-PROVIDER-BODY" }), { status: failure });
    });
    const logs: string[] = [];
    const error = spyOn(console, "error").mockImplementation((...args) => { logs.push(args.map(String).join(" ")); });
    const warn = spyOn(console, "warn").mockImplementation((...args) => { logs.push(args.map(String).join(" ")); });
    try {
      const first = await page(await request(ctx.rt.app, DESK, "?offset=0"));
      expect(first.next_offset).toBe(50);
      for (failure of [401, 403, 429, 503, 0]) {
        const response = await request(ctx.rt.app, DESK, "?offset=50");
        expect([502, 503]).toContain(response.status);
        const body = await response.json();
        expect(body.error).toBeString();
        expect(body.jobs).toBeUndefined();
        expect(body.next_offset).toBeUndefined();
        expect(JSON.stringify(body)).not.toContain(TOKEN);
        expect(JSON.stringify(body)).not.toContain("PRIVATE-PROVIDER-BODY");
      }
      expect(calls).toBe(6);
      expect(first.jobs).toHaveLength(50);
      expect([...ctx.logs, ...logs].join("\n")).not.toContain(TOKEN);
      expect([...ctx.logs, ...logs].join("\n")).not.toContain("PRIVATE-PROVIDER-BODY");
      expect(ctx.platform.calls.requestPayout).toBe(0);
    } finally { error.mockRestore(); warn.mockRestore(); await ctx.close(); }
  });

  test("the public board does not relax private worker reads or submission authorization in independent Desk tabs", async () => {
    const boardCalls: string[] = [];
    const ctx = await fixture(async (input, init) => { boardCalls.push(init?.method ?? "GET"); expect(urlOf(input).pathname).toBe("/v1/jobs/board"); return Response.json({ jobs: [publicJob(1)] }); });
    const marketStub = new StubMarket();
    let workerPosts = 0;
    const worker = { token: WORKER_TOKEN, secret: "private-webhook-secret", agencyId: "pending" };
    const workerSend: Send = async (input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${WORKER_TOKEN}`);
      if (init?.method === "POST") workerPosts++;
      expect(urlOf(input).pathname).toBe("/v1/agents/me/assignments");
      return Response.json({ assignments: [{ assignment: { assignmentId: jobId(800), jobId: jobId(801), status: "in_progress" }, job: { title: "PRIVATE-WORKER-TITLE", description: "PRIVATE-WORKER-BRIEF" } }] });
    };
    const market = new Market({ db: dbOf(ctx.rt), market: marketStub, controls: null, chain: registeredChain,
      api: new MarketApi(MARKET, WORKER_TOKEN, workerSend as typeof fetch), worker, daoPolicy: async () => null, now: () => new Date(NOW) });
    const agency = market.agencies.create({ name: "Private agency", owner: "owner.near", signer: "wallet" });
    worker.agencyId = agency.id;
    let privateViews = 0;
    const view = market.worker.view.bind(market.worker);
    market.worker.view = async () => { privateViews++; return view(); };
    const auth = { handler: async () => new Response("fixture auth"), api: { getSession: async ({ headers }: { headers: Headers }) => {
      const who = headers.get("x-fixture-account"); return who ? { user: { id: who } } : null;
    } }, nearAccountFor: (id: string) => id } as unknown as Auth;
    const app = buildApp({ ...ctx.rt, market, auth });
    try {
      await market.worker.poll();
      for (const tab of [app, buildApp({ ...ctx.rt, market, auth })]) for (const [account, status] of [[null, 401], ["outsider.near", 403]] as const) {
        const headers: Record<string, string> = account ? { "x-fixture-account": account } : {};
        const board = await page(await request(tab, DESK, "", headers));
        expect(board.jobs.map((job) => job.title)).toEqual(["Open job 1"]);
        expect(JSON.stringify(board)).not.toContain("PRIVATE-WORKER");
        expect((await tab.request(`${DESK}/api/market/worker`, { headers: { origin: DESK, ...headers } })).status).toBe(status);
        expect((await tab.request(`${DESK}/api/market/worker/jobs/${jobId(800)}/submit`, { method: "POST", headers: { origin: DESK, "content-type": "application/json", ...headers }, body: JSON.stringify({ markdown: "must not submit" }) })).status).toBe(status);
      }
      expect(privateViews).toBe(0);
      expect(workerPosts).toBe(0);
      const owner = await app.request(`${DESK}/api/market/worker`, { headers: { origin: DESK, "x-fixture-account": "owner.near" } });
      expect(owner.status).toBe(200);
      expect((await owner.json()).assignments[0].title).toBe("PRIVATE-WORKER-TITLE");
      expect(privateViews).toBe(1);
      expect(boardCalls).toEqual(["GET", "GET", "GET", "GET"]);
      expect(marketStub.calls.filter(([name]) => name === "hire" || name === "quote")).toEqual([]);
      expect(ctx.platform.calls.requestPayout).toBe(0);
    } finally { await ctx.close(); }
  });
});
