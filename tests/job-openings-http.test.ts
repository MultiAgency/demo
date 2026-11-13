import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { buildApp, createRuntime, type Runtime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { MultiAgencyOpenings } from "../src/server/jobs/openings";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { StubPlatform } from "./support/stub-platform";

const DESK = "https://desk.paperwork.test";
const OLD_JOBS = "https://jobs.paperwork.test";
const SETTINGS = "https://multiagency.ai/api/settings";
const LISTINGS = "https://nearn.io/api/listings/sponsor/";
const NOW = "2026-11-11T12:00:00.000Z";
type Send = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const urlOf = (input: string | URL | Request) => typeof input === "string" || input instanceof URL ? String(input) : input.url;
const opening = () => ({ slug: "public-export", title: "Build a public export", type: "project", status: "OPEN", isPublished: true,
  isPrivate: false, rewardAmount: 125.5, token: "USDC", deadline: null, sponsor: { slug: "multiagency" },
  internalNotes: "PRIVATE-SOURCE-FIELD", applicantEmail: "private@example.invalid" });
async function fixture(send: Send) {
  const platform = new StubPlatform(() => new Date(NOW));
  const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules", REQUIRE_AUTH: "true",
    PUBLIC_URL: DESK }), { kit: platform.kit(), boardApi: null,
    openings: new MultiAgencyOpenings(send as typeof fetch, () => new Date(NOW)) });
  return { rt, platform, async close() {
    await (await rt.auth.$context).checkSchema?.();
    (rt.engine as unknown as { d: { db: Database } }).d.db.close();
  } };
}
const request = (rt: Runtime, host: string, query = "", extra: Record<string, string> = {}) =>
  rt.app.request(`${host}/api/jobs/openings${query}`, { headers: { origin: host, ...extra } });

test("anonymous openings reads in independent Desk tabs use only credential-free public settings and the sponsor catalog", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const ctx = await fixture(async (input, init = {}) => {
    const url = urlOf(input); calls.push({ url, init });
    if (url === SETTINGS) return Response.json({ nearnAccountId: "multiagency", orgAccountId: "NOT-A-CATALOG-SELECTOR" });
    if (url === LISTINGS) return Response.json({ bounties: [opening(),
      { isPrivate: true, slug: "../private", title: { secret: "PRIVATE-BRIEF" } },
      { isPublished: false, slug: "../draft", title: { secret: "PRIVATE-DRAFT" } },
      { status: "CLOSED", slug: "../closed", title: { secret: "PRIVATE-CLOSED" } },
    ] });
    throw new Error(`Unexpected source request ${url}`);
  });
  try {
    expect(ctx.rt.config.auth.required).toBe(true);
    expect(ctx.rt.market).toBeNull();
    expect(ctx.rt.kit.market ?? null).toBeNull();
    const results = [];
    for (const tab of [ctx.rt, { ...ctx.rt, app: buildApp(ctx.rt) }]) {
      const response = await request(tab, DESK, "", { authorization: "Bearer CLIENT-SECRET", cookie: "client-private=COOKIE-SECRET" });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json(); results.push(body);
      expect(body).toEqual({ agency: "MultiAgency", sponsor_slug: "multiagency", source_url: "https://nearn.io/multiagency", checked_at: NOW,
        openings: [{ id: "nearn:multiagency:public-export", source: "nearn", slug: "public-export", title: "Build a public export", kind: "project",
          budget_amount: "125.5", budget_token: "USDC", deadline: null, url: "https://nearn.io/listing/public-export" }] });
      expect(JSON.stringify(body)).not.toMatch(/PRIVATE-|private@example|CLIENT-SECRET|COOKIE-SECRET|NOT-A-CATALOG-SELECTOR/);
    }
    expect(results[0]).toEqual(results[1]);
    expect(calls).toHaveLength(4);
    for (let i = 0; i < calls.length; i++) {
      const { url, init } = calls[i]!;
      expect(url).toBe(i % 2 === 0 ? SETTINGS : LISTINGS);
      expect(init.method).toBe(i % 2 === 0 ? "GET" : "POST");
      expect(init.credentials).toBe("omit");
      expect(init.redirect).toBe("error");
      const headers = new Headers(init.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("cookie")).toBe(false);
      if (init.method === "POST") expect(JSON.parse(String(init.body))).toEqual({ sponsor: "multiagency", type: { in: ["bounty", "project", "hackathon", "sponsorship"] } });
      expect(url).not.toContain("/api/projects");
    }
    expect(ctx.platform.calls.requestPayout).toBe(0);
    expect(ctx.platform.transfers).toEqual([]);
  } finally { await ctx.close(); }
});

test("unconfigured hosts and origins fail before an openings source is queried", async () => {
  let calls = 0;
  const ctx = await fixture(async (input) => { calls++; return Response.json(urlOf(input) === SETTINGS ? { nearnAccountId: "multiagency" } : { bounties: [] }); });
  try {
    for (const host of [OLD_JOBS, "https://outside.paperwork.test"])
      expect((await request(ctx.rt, host, "", { origin: DESK, "x-forwarded-host": new URL(DESK).host })).status).toBe(421);
    for (const origin of [OLD_JOBS, "https://outside.paperwork.test", "http://desk.paperwork.test", "https://desk.paperwork.test:444"])
      expect((await request(ctx.rt, DESK, "", { origin })).status).toBe(403);
    expect(calls).toBe(0);
    expect((await request(ctx.rt, DESK, "", { origin: DESK })).status).toBe(200);
    expect(calls).toBe(2);
  } finally { await ctx.close(); }
});

test("a caller account query cannot select private Paperwork records or change the public sponsor", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const ctx = await fixture(async (input, init) => {
    const url = urlOf(input); calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === SETTINGS) return Response.json({ nearnAccountId: "multiagency" });
    if (url === LISTINGS) return Response.json({ bounties: [opening()] });
    throw new Error("No private or activity source may be fetched");
  });
  try {
    const privateJob = ctx.rt.engine.createContract({ ...JOB_DEMO_TERMS, company: "PRIVATE-PAPERWORK-AGENCY" });
    ctx.rt.engine.jobsFor = () => { throw new Error("Public openings must never read an account's private jobs"); };
    const first = await request(ctx.rt, DESK, "?account=acme.demo&sponsor=another-agency");
    const second = await request({ ...ctx.rt, app: buildApp(ctx.rt) }, DESK, "?account=maria.demo");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const body = await first.json();
    expect(await second.json()).toEqual(body);
    expect(JSON.stringify(body)).not.toContain(privateJob.id);
    expect(JSON.stringify(body)).not.toContain("PRIVATE-PAPERWORK-AGENCY");
    expect(JSON.stringify(body)).not.toContain(privateJob.contractorToken);
    expect(body.sponsor_slug).toBe("multiagency");
    expect(calls.map((call) => call.url)).toEqual([SETTINGS, LISTINGS, SETTINGS, LISTINGS]);
    for (const call of calls.filter((call) => call.url === LISTINGS)) expect(call.body).toMatchObject({ sponsor: "multiagency" });
    const mine = await ctx.rt.app.request(`${DESK}/api/jobs/mine?account=acme.demo`);
    expect(mine.status).toBe(401);
    expect(ctx.platform.calls.requestPayout).toBe(0);
  } finally { await ctx.close(); }
});

test("source failures return generic 502 errors, while a valid empty feed remains a distinct success", async () => {
  let failure: "settings" | "listings" | "schema" | "empty" = "settings";
  const ctx = await fixture(async (input) => {
    if (urlOf(input) === SETTINGS) {
      if (failure === "settings") throw new Error("PRIVATE-TRANSPORT-DETAIL");
      return Response.json({ nearnAccountId: "multiagency" });
    }
    if (urlOf(input) !== LISTINGS) throw new Error("Unexpected source");
    if (failure === "listings") return new Response("PRIVATE-UPSTREAM-BODY", { status: 503 });
    if (failure === "schema") return Response.json({ bounties: [{ ...opening(), rewardAmount: "PRIVATE-INVALID-AMOUNT" }] });
    return Response.json({ bounties: [] });
  });
  try {
    for (failure of ["settings", "listings", "schema"] as const) {
      const response = await request(ctx.rt, DESK);
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body).toEqual({ error: "Published MultiAgency openings could not be read. Try again or check MultiAgency's listings directly.", code: "upstream_unavailable" });
      expect(body.openings).toBeUndefined();
      expect(body.checked_at).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("PRIVATE-");
    }
    failure = "empty";
    const empty = await request(ctx.rt, DESK);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ openings: [], checked_at: NOW, agency: "MultiAgency" });
    expect(ctx.platform.calls.requestPayout).toBe(0);
  } finally { await ctx.close(); }
});
