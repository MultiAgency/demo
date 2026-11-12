import { describe, expect, test } from "bun:test";
import type { DaoPolicy } from "@multiagency/sdk";
import { buildApp, createRuntime } from "../src/server/app";
import type { Auth } from "../src/server/auth";
import { loadConfig } from "../src/server/config";
import { Market } from "../src/server/market";
import { MarketApi } from "../src/server/market/api";
import { StubMarket } from "./support/market-stub";
import { StubPlatform } from "./support/stub-platform";

const DESK = "https://desk.paperwork.test";
const OLD_JOBS = "https://jobs.paperwork.test";
const MARKET = "https://market.invalid";
const NOW = Date.parse("2026-11-11T12:00:00Z");
const ASSIGNMENT = "c112438b-6542-4d45-998f-4f9b46473e77";
const JOB = "a7463f8b-839f-43f8-8e12-a13af954bbd9";
const REPORT = "The agreed export and its acceptance tests are ready for review.";
type Send = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const item = (status = "in_progress") => ({
  assignment: { assignmentId: ASSIGNMENT, jobId: JOB, status, escrowAmount: "0.5", escrowToken: "USDC", slaDeadlineAt: null },
  job: { title: "A private market job", description: "Private brief for the configured agency's listed agent." },
});
const pathOf = (input: string | URL | Request) => new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

/** Real app middleware and Market/Worker records; only sessions and outbound Market/provider answers are fixtures. */
async function fixture(send: Send, signer: "wallet" | "dao" = "wallet", explicitOrigin = true) {
  const config = loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules", REQUIRE_AUTH: "true",
    ...(explicitOrigin && { PUBLIC_URL: DESK }) });
  const worker = { token: "aat_offline_jobs_fixture", secret: "offline-webhook-secret", agencyId: "pending-agency" };
  config.market.worker = worker;
  const platform = new StubPlatform(() => new Date(NOW));
  const market = new StubMarket();
  const rt = await createRuntime(config, { clockStart: NOW, kit: { ...platform.kit(), market: {
    platform: market, controls: null, url: MARKET, rpcUrl: "https://rpc.invalid", owner: null, dao: null,
  } } });
  // Worker captures its API dependency during construction; inject the transport into both shared Market views.
  const m = new Market({ ...rt.market!.d, api: new MarketApi(MARKET, worker.token, send as typeof fetch) });
  rt.market = m;
  const agency = m.agencies.create({ name: "One shared agency", owner: signer === "dao" ? "council.sputnik-dao.near" : "acme.near", signer });
  worker.agencyId = agency.id;
  m.d.db.query("UPDATE market_agencies SET stage = 'ready', agent = 'own-1', agent_id = 'agent-id' WHERE id = ?").run(agency.id);
  let sessionReads = 0;
  const auth = {
    handler: async () => new Response("fixture auth"),
    api: { getSession: async ({ headers, request }: { headers: Headers; request?: Request }) => {
      sessionReads++;
      // A bad host must be refused by the real app middleware before it can ask for a private session.
      if (!request || new URL(request.url).origin !== config.auth.publicUrl)
        throw new Error("An unconfigured request reached the fixture session reader.");
      const account = headers.get("x-fixture-account");
      return account ? { user: { id: account } } : null;
    } },
    nearAccountFor: (id: string) => id,
  } as unknown as Auth;
  const app = () => buildApp({ ...rt, auth });
  return { rt, m, agency, market, platform, worker, app, sessionReads: () => sessionReads,
    async close() {
      await (await rt.auth.$context).checkSchema?.();
      m.d.db.close();
    } };
}

function request(app: ReturnType<typeof buildApp>, origin: string, path: string, account: string | null = "acme.near", body?: unknown, extra: Record<string, string> = {}) {
  return app.request(`${origin}/api${path}`, { method: body === undefined ? "GET" : "POST", headers: {
    origin, ...(account && { "x-fixture-account": account }), ...(body !== undefined && { "content-type": "application/json" }), ...extra,
  }, ...(body !== undefined && { body: JSON.stringify(body) }) });
}
const inbox = async (app: ReturnType<typeof buildApp>, host: string, account = "acme.near") => {
  const response = await request(app, host, "/market/worker", account);
  expect(response.status).toBe(200);
  return response.json();
};

describe("Desk tabs share the existing market authority", () => {
  test("only the canonical Desk host and origin reach private reads, regardless of forwarded headers", async () => {
    const ctx = await fixture(async () => Response.json({ assignments: [item()] }));
    try {
      await ctx.m.worker.poll();
      const app = ctx.app();
      const response = await request(app, DESK, "/config");
      expect(response.status).toBe(200);
      const config = await response.json();
      expect(config.market).toMatchObject({ enabled: true, worker: true });
      for (const key of ["entry", "desk_url", "jobs_url"]) expect(config).not.toHaveProperty(key);
      const forwarded = await request(app, DESK, "/config", null, undefined, { "x-forwarded-host": new URL(OLD_JOBS).host, "x-forwarded-proto": "https" });
      // The app's clock advances between reads; compare the origin/authority configuration independently.
      const { now: _firstReadTime, ...publicConfig } = config;
      const { now: _forwardedReadTime, ...forwardedConfig } = await forwarded.json();
      expect(forwardedConfig).toEqual(publicConfig);
      let views = 0;
      const view = ctx.m.worker.view.bind(ctx.m.worker);
      ctx.m.worker.view = async () => { views++; return view(); };
      const before = ctx.sessionReads();
      for (const host of [OLD_JOBS, "https://outside.paperwork.test"])
        expect((await request(app, host, "/market/worker", "acme.near", undefined, { "x-forwarded-host": new URL(DESK).host, origin: DESK })).status).toBe(421);
      expect((await request(app, DESK, "/market/worker", "acme.near", undefined, { origin: OLD_JOBS })).status).toBe(403);
      expect((await request(app, DESK, "/market/worker", "acme.near", undefined, { origin: "https://outside.paperwork.test" })).status).toBe(403);
      expect((await request(app, DESK, "/market/worker", "acme.near", undefined, { origin: "https://jobs.paperwork.test:444" })).status).toBe(403);
      expect(ctx.sessionReads()).toBe(before);
      expect(views).toBe(0);
      const allowed = await request(app, DESK, "/market/worker");
      expect(allowed.status).toBe(200);
      expect((await allowed.json()).assignments[0].assignment_id).toBe(ASSIGNMENT);
      expect(views).toBe(1);
    } finally { await ctx.close(); }
  });

  test("the retired second origin is rejected at startup while implicit local fixtures keep their ephemeral host behavior", async () => {
    expect(() => loadConfig({ PLATFORM: "fake", PUBLIC_URL: DESK, PAPERWORK_JOBS_PUBLIC_URL: OLD_JOBS })).toThrow(/PAPERWORK_JOBS_PUBLIC_URL/);
    const ctx = await fixture(async () => Response.json({ assignments: [] }), "wallet", false);
    try {
      expect(ctx.rt.config.auth.enforcePublicHost).toBe(false);
      const response = await request(ctx.app(), ctx.rt.config.auth.publicUrl, "/config");
      expect(response.status).toBe(200);
      const config = await response.json();
      for (const key of ["entry", "desk_url", "jobs_url"]) expect(config).not.toHaveProperty(key);
    } finally { await ctx.close(); }
  });

  test("a lost delivery reply remains the same unknown attempt in a reloaded Desk tab, then recovers by matching version only", async () => {
    let posts = 0;
    let proven = false;
    let posted: unknown;
    const ctx = await fixture(async (input, init) => {
      const path = pathOf(input);
      if (path === "/v1/agents/me/assignments") return Response.json({ assignments: [item(proven ? "submitted" : "in_progress")] });
      if (path.endsWith("/deliverable/versions")) {
        if (!posts) return Response.json({ versions: [] });
        return proven ? Response.json({ versions: [{ version: 1, submittedAt: new Date(NOW + 1000).toISOString(), files: [] }] }) : new Response("unavailable", { status: 503 });
      }
      if (path.endsWith("/deliverable/versions/1/raw")) return new Response(REPORT);
      if (path.endsWith("/submit") && init?.method === "POST") {
        posts++;
        posted = JSON.parse(String(init.body));
        throw new TypeError("Market stored the deliverable, but its response was lost");
      }
      throw new Error(`Unexpected offline request ${path}`);
    });
    try {
      await ctx.m.worker.poll();
      const response = await request(ctx.app(), DESK, `/market/worker/jobs/${ASSIGNMENT}/submit`, "acme.near", { markdown: REPORT });
      expect(response.status).toBe(200);
      expect((await response.json()).assignments[0].submit_state).toBe("unknown");
      const original = ctx.m.worker.row(ASSIGNMENT);
      expect(original.submit_attempt_id).toBeTruthy();
      expect(original).toMatchObject({ assignment_id: ASSIGNMENT, agency_id: ctx.agency.id, deliverable: REPORT, submit_state: "unknown", submit_phase: "posting", submit_baseline: "[]" });
      expect(posted).toEqual({ deliverableMarkdown: REPORT });
      // Rebuild the HTTP app as a fresh view; it still uses the same Market/Worker and durable SQLite records.
      const reopenedTab = ctx.app();
      expect((await inbox(reopenedTab, DESK)).assignments[0]).toMatchObject({ assignment_id: ASSIGNMENT, submit_state: "unknown", deliverable: REPORT });
      expect(ctx.m.worker.row(ASSIGNMENT)).toEqual(original);
      expect((await request(reopenedTab, DESK, `/market/worker/jobs/${ASSIGNMENT}/submit`, "acme.near", { markdown: REPORT })).status).toBe(409);
      expect((await request(reopenedTab, DESK, "/market/worker/poll", "acme.near", {})).status).toBe(502);
      expect(ctx.m.worker.row(ASSIGNMENT).submit_attempt_id).toBe(original.submit_attempt_id);
      expect(ctx.m.worker.row(ASSIGNMENT).submit_state).toBe("unknown");
      proven = true;
      expect((await request(reopenedTab, DESK, "/market/worker/poll", "acme.near", {})).status).toBe(200);
      expect((await inbox(reopenedTab, DESK)).assignments[0]).toMatchObject({ assignment_id: ASSIGNMENT, status: "submitted", submit_state: "submitted" });
      expect(ctx.m.worker.row(ASSIGNMENT).submit_attempt_id).toBe(original.submit_attempt_id);
      expect(posts).toBe(1);
      expect(ctx.m.d.db.query("SELECT count(*) AS n FROM market_assignments").get()).toEqual({ n: 1 });
      expect(ctx.market.calls.filter(([name]) => name === "hire" || name === "quote")).toEqual([]);
      expect(ctx.platform.calls.requestPayout).toBe(0);
    } finally { await ctx.close(); }
  });

  test("concurrent Desk tabs share one write-ahead submission attempt and one outbound POST", async () => {
    const entered = deferred<void>();
    const reply = deferred<Response>();
    let posts = 0;
    const ctx = await fixture(async (input, init) => {
      const path = pathOf(input);
      if (path.endsWith("/assignments")) return Response.json({ assignments: [item()] });
      if (path.endsWith("/deliverable/versions")) return Response.json({ versions: [] });
      if (path.endsWith("/submit") && init?.method === "POST") { posts++; entered.resolve(); return reply.promise; }
      throw new Error(`Unexpected offline request ${path}`);
    });
    let first: Promise<Response> | undefined;
    try {
      await ctx.m.worker.poll();
      const app = ctx.app();
      const secondTab = ctx.app();
      const pending = Promise.resolve(request(app, DESK, `/market/worker/jobs/${ASSIGNMENT}/submit`, "acme.near", { markdown: REPORT }));
      first = pending;
      await entered.promise;
      const attempt = ctx.m.worker.row(ASSIGNMENT);
      expect(attempt.submit_state).toBe("submitting");
      expect(attempt.submit_phase).toBe("posting");
      expect(attempt.submit_attempt_id).toBeTruthy();
      expect((await request(secondTab, DESK, `/market/worker/jobs/${ASSIGNMENT}/submit`, "acme.near", { markdown: "A raced replacement must not send" })).status).toBe(409);
      expect(ctx.m.worker.row(ASSIGNMENT)).toEqual(attempt);
      expect(posts).toBe(1);
      reply.resolve(Response.json({ assignmentId: ASSIGNMENT, status: "submitted" }));
      expect((await pending).status).toBe(200);
      expect((await inbox(secondTab, DESK)).assignments[0]).toMatchObject({ assignment_id: ASSIGNMENT, submit_state: "submitted", deliverable: REPORT });
      expect(ctx.m.worker.row(ASSIGNMENT).submit_attempt_id).toBe(attempt.submit_attempt_id);
      expect(posts).toBe(1);
    } finally {
      reply.resolve(Response.json({ assignmentId: ASSIGNMENT, status: "submitted" }));
      await first;
      await ctx.close();
    }
  });

  test("independent Desk sessions never admit an anonymous or unrelated wallet to the agency's private work", async () => {
    let requests = 0;
    const ctx = await fixture(async () => { requests++; return Response.json({ assignments: [item()] }); });
    try {
      await ctx.m.worker.poll();
      const original = ctx.m.worker.row(ASSIGNMENT);
      const before = requests;
      let views = 0;
      const view = ctx.m.worker.view.bind(ctx.m.worker);
      ctx.m.worker.view = async () => { views++; return view(); };
      const app = ctx.app();
      for (const tab of [app, ctx.app()]) for (const [account, status] of [[null, 401], ["unrelated.near", 403]] as const) {
        const denied = await request(tab, DESK, "/market/worker", account);
        expect(denied.status).toBe(status);
        expect(await denied.text()).not.toContain("Private brief");
        expect((await request(tab, DESK, "/market/worker/poll", account, {})).status).toBe(status);
        expect((await request(tab, DESK, `/market/worker/jobs/${ASSIGNMENT}/submit`, account, { markdown: REPORT })).status).toBe(status);
      }
      expect(requests).toBe(before);
      expect(views).toBe(0);
      expect(ctx.m.worker.row(ASSIGNMENT)).toEqual(original);
      const allowed = await inbox(app, DESK);
      expect(allowed.assignments).toHaveLength(1);
      expect(views).toBe(1);
      expect(JSON.stringify(allowed)).not.toContain(ctx.worker.token);
      expect(JSON.stringify(allowed)).not.toContain(ctx.worker.secret);
    } finally { await ctx.close(); }
  });

  test("a DAO reader can read in Desk tabs but only an existing proposer role may poll or submit", async () => {
    let posts = 0;
    const ctx = await fixture(async (input, init) => {
      const path = pathOf(input);
      if (path.endsWith("/assignments")) return Response.json({ assignments: [item()] });
      if (path.endsWith("/deliverable/versions")) return Response.json({ versions: [] });
      if (path.endsWith("/submit") && init?.method === "POST") { posts++; return Response.json({ assignmentId: ASSIGNMENT, status: "submitted" }); }
      throw new Error(`Unexpected offline request ${path}`);
    }, "dao");
    try {
      const policy: DaoPolicy = { proposal_bond: "1", default_vote_policy: { threshold: [1, 2] }, roles: [
        { name: "Readers", kind: { Group: ["reader.near"] }, permissions: [], vote_policy: {} },
        { name: "Proposers", kind: { Group: ["proposer.near"] }, permissions: ["call:AddProposal"], vote_policy: {} },
      ] };
      ctx.m.d.daoPolicy = async () => policy;
      await ctx.m.worker.poll();
      const app = ctx.app();
      for (const tab of [app, ctx.app()]) {
        expect((await inbox(tab, DESK, "reader.near")).assignments).toHaveLength(1);
        expect((await request(tab, DESK, "/market/worker", "outsider.near")).status).toBe(403);
        expect((await request(tab, DESK, "/market/worker/poll", "reader.near", {})).status).toBe(403);
        expect((await request(tab, DESK, `/market/worker/jobs/${ASSIGNMENT}/submit`, "reader.near", { markdown: REPORT })).status).toBe(403);
      }
      expect(posts).toBe(0);
      expect(ctx.m.worker.row(ASSIGNMENT).submit_state).toBe("none");
      expect((await request(app, DESK, `/market/worker/jobs/${ASSIGNMENT}/submit`, "proposer.near", { markdown: REPORT })).status).toBe(200);
      expect(posts).toBe(1);
      expect((await inbox(app, DESK, "reader.near")).assignments[0].submit_state).toBe("submitted");
    } finally { await ctx.close(); }
  });
});
