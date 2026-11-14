import { describe, expect, test } from "bun:test";
import { createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { DEMO_TERMS } from "../src/shared/demo";

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("sign in with NEAR (better-near-auth)", () => {
  test("Better-Auth is mounted at /api/auth; nobody is signed in by default", async () => {
    const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake" }));
    const res = await rt.app.request("/api/auth/ok");
    expect(res.status).toBe(200);
    const me = await (await rt.app.request("/api/me")).json();
    expect(me.session).toBeNull();
  });

  test("config exposes the auth settings the client needs", async () => {
    const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake" }));
    const cfg = await (await rt.app.request("/api/config")).json();
    expect(cfg.auth).toEqual({ required: false, recipient: "multiagentic.near", network: "mainnet" });
  });
});

describe("access rules when sign-in is required", () => {
  test("creating a contract needs the representative signed in", async () => {
    const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", REQUIRE_AUTH: "true" }));
    const res = await rt.app.request("/api/contracts", json(DEMO_TERMS));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toContain("Sign in with NEAR");
  });

  test("company actions on a contract need the representative", async () => {
    const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", REQUIRE_AUTH: "true" }));
    const { id } = rt.engine.createContract(DEMO_TERMS);
    for (const [path, body] of [
      [`/api/contracts/${id}/onboarding/next`, {}],
      [`/api/contracts/${id}/run`, {}],
      [`/api/contracts/${id}/attacks/overpay`, {}],
      [`/api/contracts/${id}/signatures`, { role: "contractor", signed: {} }],
    ] as const) {
      expect((await rt.app.request(path, json(body))).status).toBe(401);
    }
  });

  test("the list only shows contracts you're a party to; verify stays public", async () => {
    const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", REQUIRE_AUTH: "true" }));
    const { id } = rt.engine.createContract(DEMO_TERMS);
    expect(await (await rt.app.request("/api/contracts")).json()).toEqual([]);
    expect((await rt.app.request(`/api/contracts/${id}/verify/public`)).status).toBe(200);
  });

  test("the keyless demo stays open when sign-in is not required", async () => {
    const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake" }));
    expect((await rt.app.request("/api/contracts", json(DEMO_TERMS))).status).toBe(201);
  });
});

describe("API errors are machine-readable", () => {
  test("a JSON body that is not an object is the caller's mistake on every route that reads its fields", async () => {
    const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake" }));
    const { id } = await (await rt.app.request("/api/contracts", json(DEMO_TERMS))).json();
    for (const path of [`/api/contracts/${id}/signatures`, `/api/contracts/${id}/submissions`, "/api/contracts"])
      for (const body of [null, [], "text", 7]) {
        const res = await rt.app.request(path, json(body));
        expect([path, body, res.status]).toEqual([path, body, 400]);
        expect((await res.json()).code).toBe("invalid_request");
      }
  });

  test("malformed bodies are 400, unknown routes are JSON 404s, and each error carries a code", async () => {
    const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", REQUIRE_AUTH: "true" }));
    for (const body of ["not json", ""]) {
      const res = await rt.app.request("/api/contracts", { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "The request body must be valid JSON.", code: "invalid_request" });
    }
    const missing = await rt.app.request("/api/no-such-route");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/json");
    expect(await missing.json()).toEqual({ error: "No such API route.", code: "not_found" });
    const signedOut = await rt.app.request("/api/contracts", json(DEMO_TERMS));
    expect(await signedOut.json()).toMatchObject({ code: "sign_in_required" });
  });
});
