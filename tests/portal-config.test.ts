import { expect, test } from "bun:test";
import { serializeSignedCookie } from "better-call";
import { createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import type { Auth } from "../src/server/auth";
import { DEMO_TERMS } from "../src/shared/demo";

const PUBLIC_URL = "https://desk.example.test";
const secret = "paperwork-single-origin-config-fixture-not-for-hosting";

async function cookieFor(auth: Auth, accountId: string) {
  const context = await auth.$context;
  const user = await context.adapter.create<{ id: string }>({ model: "user", data: {
    name: accountId, email: `${accountId}@fixture.invalid`, emailVerified: false,
    createdAt: new Date(), updatedAt: new Date(),
  } });
  await context.adapter.create({ model: "nearAccount", data: {
    userId: user.id, accountId, network: "mainnet", publicKey: "offline-fixture-key",
    isPrimary: true, createdAt: new Date(),
  } });
  const session = await context.internalAdapter.createSession(user.id);
  return (await serializeSignedCookie(context.authCookies.sessionToken.name, session.token, secret, context.authCookies.sessionToken.attributes)).split(";")[0]!;
}

test("one normalized public origin replaces the retired second-host setting", () => {
  expect(loadConfig({}).auth).toMatchObject({ publicUrl: "http://localhost:3000", enforcePublicHost: false });
  expect(loadConfig({ PUBLIC_URL: `${PUBLIC_URL}/` }).auth).toMatchObject({ publicUrl: PUBLIC_URL, enforcePublicHost: true });
  expect(loadConfig({ NODE_ENV: "production", PLATFORM: "fake", PUBLIC_URL: "https://paperwork-staging.up.railway.app" }).auth).toMatchObject({ enforcePublicHost: true, required: false });
  for (const origin of [undefined, PUBLIC_URL, "https://desk.multiagency.ai", "http://paperwork-staging.up.railway.app", "https://up.railway.app.desk.multiagency.ai"])
    expect(() => loadConfig({ NODE_ENV: "production", PLATFORM: "fake", PUBLIC_URL: origin })).toThrow("keyless stand-in runs in production only");
  // The keyless deployment has no sign-in: a paid model key, review key or Market worker variable refuses startup.
  const keyless = { NODE_ENV: "production", PLATFORM: "fake", PUBLIC_URL: "https://paperwork-staging.up.railway.app" };
  for (const secret of [{ NEARAI_API_KEY: "paid-judge-key" }, { NEARAI_API_KEY: "paid-judge-key", JUDGE: "rules" }, { PAPERWORK_REVIEW_NEARAI_API_KEY: "paid-review-key-0123456789" },
    { PLATFORM_CREDENTIAL: "app-credential-fixture" }, { PAPERWORK_MARKET_BOARD_TOKEN: "aat_board_fixture" }, { MARKET_AGENT_TOKEN: "aat_fixture" }, { MARKET_WEBHOOK_SECRET: "fixture-secret" }, { MARKET_WORKER_AGENCY: "agency-1" }])
    expect(() => loadConfig({ ...keyless, ...secret })).toThrow("keyless stand-in has no sign-in");
  expect(loadConfig({ PLATFORM: "fake", NEARAI_API_KEY: "local-key" }).judge.kind).toBe("near-ai");
  // A board token is held only by explicit acknowledgement, and the acknowledgement relaxes nothing else.
  const board = { ...keyless, PAPERWORK_MARKET_BOARD_TOKEN: "aat_board_fixture" };
  for (const ack of [undefined, "", "true", "throwaway"]) expect(() => loadConfig({ ...board, PAPERWORK_KEYLESS_MARKET_BOARD: ack })).toThrow("keyless stand-in has no sign-in");
  const acknowledged = { ...board, PAPERWORK_KEYLESS_MARKET_BOARD: "throwaway-agent" };
  expect(loadConfig(acknowledged).market.boardToken).toBe("aat_board_fixture");
  for (const secret of [{ NEARAI_API_KEY: "paid-judge-key" }, { PAPERWORK_REVIEW_NEARAI_API_KEY: "paid-review-key-0123456789" }, { PLATFORM_CREDENTIAL: "app-credential-fixture" }, { MARKET_AGENT_TOKEN: "aat_fixture" }])
    expect(() => loadConfig({ ...acknowledged, ...secret })).toThrow("keyless stand-in has no sign-in");
  expect(loadConfig({ PAPERWORK_JOBS_PUBLIC_URL: "" }).auth).not.toHaveProperty("jobsPublicUrl");
  for (const value of ["https://jobs.example.test", PUBLIC_URL, "not a url", " "]) {
    expect(() => loadConfig({ PUBLIC_URL, PAPERWORK_JOBS_PUBLIC_URL: value })).toThrow("Remove PAPERWORK_JOBS_PUBLIC_URL; use PUBLIC_URL");
  }
  for (const value of ["not a url", `${PUBLIC_URL}/path`, "https://user:pass@desk.example.test", "https://*.example.test", `${PUBLIC_URL}?q=1`, `${PUBLIC_URL}/#/`, "file:///tmp/desk"]) {
    expect(() => loadConfig({ PUBLIC_URL: value })).toThrow("PUBLIC_URL");
  }
});

test("only the configured host and exact origin reach APIs or auth; health remains an internal probe", async () => {
  const rt = await createRuntime(loadConfig({ PUBLIC_URL, REQUIRE_AUTH: "true" }));
  try {
    const response = await rt.app.request(`${PUBLIC_URL}/api/config`);
    expect(response.status).toBe(200);
    const view = await response.json();
    for (const retired of ["entry", "desk_url", "jobs_url"]) expect(view).not.toHaveProperty(retired);
    expect((await rt.app.request(`${PUBLIC_URL}/api/auth/ok`)).status).toBe(200);
    expect(await (await rt.app.request(`${PUBLIC_URL}/api/contracts`)).json()).toEqual([]);
    for (const host of ["https://jobs.example.test", "https://untrusted.example.test", "https://desk.example.test:8443"]) {
      for (const path of ["config", "auth/ok", "me", "contracts", "jobs/mine", "market/worker"]) {
        const refused = await rt.app.request(`${host}/api/${path}`, { headers: {
          "x-forwarded-host": "desk.example.test", "x-forwarded-proto": "https", host: "desk.example.test",
        } });
        expect(refused.status).toBe(421);
      }
    }
    for (const origin of ["https://jobs.example.test", "https://untrusted.example.test", "http://desk.example.test", "null", `${PUBLIC_URL}/`]) {
      expect((await rt.app.request(`${PUBLIC_URL}/api/me`, { headers: { origin } })).status).toBe(403);
    }
    expect((await rt.app.request(`${PUBLIC_URL}/api/me`, { headers: {
      origin: PUBLIC_URL, "x-forwarded-host": "untrusted.example.test", "x-forwarded-proto": "http",
    } })).status).toBe(200);
    expect((await rt.app.request("http://internal-health/api/health")).status).toBe(200);
  } finally { (rt.auth.options.database as import("bun:sqlite").Database).close(); }
});

test("implicit local configuration retains ephemeral fixture requests; explicit HTTP origin still enforces its host", async () => {
  for (const explicit of [false, true]) {
    const rt = await createRuntime(loadConfig(explicit ? { PUBLIC_URL: "http://localhost:4201" } : {}));
    try {
      expect((await rt.app.request("http://localhost:4201/api/config")).status).toBe(200);
      expect((await rt.app.request("http://ephemeral.localhost:59123/api/config")).status).toBe(explicit ? 421 : 200);
    } finally { (rt.auth.options.database as import("bun:sqlite").Database).close(); }
  }
});

test("agency discovery narrows exact session-bound representatives without changing the ordinary party list", async () => {
  const rt = await createRuntime(loadConfig({ PUBLIC_URL, REQUIRE_AUTH: "true", BETTER_AUTH_SECRET: secret }));
  try {
    const agency = rt.engine.createContract(DEMO_TERMS);
    const builderOnly = rt.engine.createContract({ ...DEMO_TERMS, company: "Builder role only", representative: { near_account: "other.demo" },
      contractor: { ...DEMO_TERMS.contractor, near_account: "acme.demo" } });
    const both = rt.engine.createContract({ ...DEMO_TERMS, company: "Both roles", contractor: { ...DEMO_TERMS.contractor, near_account: "acme.demo" } });
    const unrelated = rt.engine.createContract({ ...DEMO_TERMS, company: "Payee is not the agency", representative: { near_account: "other.demo" },
      contractor: { ...DEMO_TERMS.contractor, near_account: "elsewhere.demo" }, payee: { chain: "near", address: "acme.demo" } });
    const cookie = await cookieFor(rt.auth, "acme.demo");
    const headers = { cookie };
    const ids = async (query: string, signed = true) => (await (await rt.app.request(`${PUBLIC_URL}/api/contracts${query}`, signed ? { headers } : {})).json()).map((row: { id: string }) => row.id).sort();
    expect(await ids("?role=agency")).toEqual([agency.id, both.id].sort());
    expect(await ids("?role=agency&account=other.demo")).toEqual([agency.id, both.id].sort());
    expect(await ids("")).toEqual([agency.id, both.id, builderOnly.id].sort());
    expect(await ids("?role=agency", false)).toEqual([]);
    expect(await ids("", false)).toEqual([]);
    expect(await ids("?role=agency")).not.toContain(unrelated.id);
  } finally { (rt.auth.options.database as import("bun:sqlite").Database).close(); }
});

test("keyless agency discovery uses its fixed representative, while the default demo list remains unchanged", async () => {
  const rt = await createRuntime(loadConfig({ PUBLIC_URL, BETTER_AUTH_SECRET: secret }));
  try {
    const acme = rt.engine.createContract(DEMO_TERMS);
    const other = rt.engine.createContract({ ...DEMO_TERMS, representative: { near_account: "other.demo" } });
    const list = async (query: string, cookie?: string) => (await (await rt.app.request(`${PUBLIC_URL}/api/contracts${query}`, cookie ? { headers: { cookie } } : {})).json()).map((row: { id: string }) => row.id).sort();
    expect(await list("?role=agency&account=other.demo")).toEqual([acme.id]);
    expect(await list("")).toEqual([acme.id, other.id].sort());
    expect(await list("?role=agency", await cookieFor(rt.auth, "other.demo"))).toEqual([other.id]);
  } finally { (rt.auth.options.database as import("bun:sqlite").Database).close(); }
});
