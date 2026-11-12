import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { serializeSignedCookie } from "better-call";
import { createAuth, sessionFrom, type Auth } from "../src/server/auth";

// Disposable installed Better-Auth sessions only; no wallet, hosted authentication or NEAR calls.
const secret = "paperwork-single-origin-fixture-secret-not-for-hosting";
const desk = "https://desk.multiagency.test";
const retired = "https://jobs.multiagency.test";
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

async function fixture(origin = desk) {
  const db = new Database(":memory:", { strict: true });
  databases.push(db);
  const auth = await createAuth({ db, secret, baseURL: origin, recipient: "multiagentic.near", trustedOrigins: [origin] });
  return { db, auth };
}

async function accountSession(auth: Auth, accountId: string) {
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
  const cookie = await serializeSignedCookie(context.authCookies.sessionToken.name, session.token, secret, context.authCookies.sessionToken.attributes);
  return { userId: user.id, accountId, cookie: cookie.split(";")[0]! };
}

function request(path = "/api/auth/get-session", cookie?: string, init: RequestInit = {}, origin = desk) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  return new Request(`${origin}${path}`, { ...init, headers });
}

test("one static auth origin reads concurrent sessions without mutating its configured URL", async () => {
  const { auth } = await fixture();
  const agency = await accountSession(auth, "agency.near");
  const worker = await accountSession(auth, "worker.near");
  const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => {
    const session = index % 2 ? agency : worker;
    const req = request(undefined, session.cookie);
    return sessionFrom(auth, req.headers, req);
  }));
  expect(responses).toEqual(Array.from({ length: 12 }, (_, index) => index % 2
    ? { userId: agency.userId, accountId: agency.accountId }
    : { userId: worker.userId, accountId: worker.accountId }));
  const signedOut = request();
  expect(await sessionFrom(auth, signedOut.headers, signedOut)).toBeNull();
  expect((await auth.$context).baseURL).toBe(`${desk}/api/auth`);
});

test("Request-aware and legacy headers-only session reads remain supported on the static origin", async () => {
  const { auth } = await fixture();
  const agency = await accountSession(auth, "agency.near");
  const req = request(undefined, agency.cookie);
  expect(req.headers.has("host")).toBe(false);
  const expected = { userId: agency.userId, accountId: agency.accountId };
  expect(await sessionFrom(auth, req.headers, req)).toEqual(expected);
  expect(await sessionFrom(auth, req.headers)).toEqual(expected);
});

test("retired and unrelated origins cannot sign out an existing session, including with forged proxy headers", async () => {
  const { auth } = await fixture();
  const worker = await accountSession(auth, "worker.near");
  for (const origin of [retired, "https://untrusted.invalid", "null"]) {
    const rejected = await auth.handler(request("/api/auth/sign-out", worker.cookie, {
      method: "POST", headers: { origin, "content-type": "application/json", "x-forwarded-host": new URL(desk).host, "x-forwarded-proto": "https" }, body: "{}",
    }));
    expect(rejected.status).toBe(403);
  }
  const req = request(undefined, worker.cookie);
  expect(await sessionFrom(auth, req.headers, req)).toEqual({ userId: worker.userId, accountId: worker.accountId });
  expect((await auth.$context).baseURL).toBe(`${desk}/api/auth`);
});

test("HTTPS cookies stay Secure and host-only; sign-out revokes only its current session", async () => {
  const { auth } = await fixture();
  const agency = await accountSession(auth, "agency.near");
  const worker = await accountSession(auth, "worker.near");
  const response = await auth.handler(request("/api/auth/sign-out", worker.cookie, {
    method: "POST", headers: { origin: desk, "content-type": "application/json", "x-forwarded-host": "untrusted.invalid", "x-forwarded-proto": "http" }, body: "{}",
  }));
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie();
  expect(cookies.length).toBeGreaterThan(0);
  for (const cookie of cookies) {
    expect(cookie).toContain("Secure"); expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toMatch(/;\s*Domain=/i);
  }
  const workerRequest = request(undefined, worker.cookie);
  expect(await sessionFrom(auth, workerRequest.headers, workerRequest)).toBeNull();
  const agencyRequest = request(undefined, agency.cookie);
  expect(await sessionFrom(auth, agencyRequest.headers, agencyRequest)).toEqual({ userId: agency.userId, accountId: agency.accountId });
});

test("the explicit local HTTP origin retains non-Secure host-only cookies", async () => {
  const origin = "http://localhost:4101";
  const { auth } = await fixture(origin);
  const worker = await accountSession(auth, "worker.near");
  const req = request(undefined, worker.cookie, {}, origin);
  expect(await sessionFrom(auth, req.headers, req)).toEqual({ userId: worker.userId, accountId: worker.accountId });
  const cookie = (await auth.$context).authCookies.sessionToken;
  expect(cookie.attributes.secure).toBe(false); expect(cookie.attributes.domain).toBeUndefined();
});
