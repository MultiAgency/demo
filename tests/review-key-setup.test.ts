import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../scripts/configure-review-key.browser.js", import.meta.url), "utf8");
const ORIGIN = "https://multi-7009.agents.nousresearch.com";
const API_URL = `${ORIGIN}/api/env?profile=paperwork-review`;
const FIXTURE_KEY = "a7".repeat(32);

interface Options {
  origin?: string;
  existing?: boolean;
  unknown?: boolean;
  input?: string | null;
  readStatus?: number;
  putStatus?: number;
  acknowledgement?: boolean;
  failPut?: boolean;
  baseURI?: string;
  setDuringPrompt?: boolean;
  recheckUnknown?: boolean;
  recheckStatus?: number;
  failRecheck?: boolean;
}

async function fixture(options: Options = {}) {
  const calls: { url: string; resolved_url: string; init: RequestInit }[] = [];
  const logs: Record<string, unknown>[] = [];
  let prompts = 0, reads = 0, becameSet = false;
  const send = async (url: string, init: RequestInit) => {
    calls.push({ url, resolved_url: new URL(url, options.baseURI ?? ORIGIN).href, init });
    if (init.method === "PUT") {
      if (options.failPut) throw new Error(`Untrusted fixture diagnostic ${FIXTURE_KEY}`);
      const status = options.putStatus ?? 200;
      return { ok: status < 300, status, json: async () => ({ ok: options.acknowledgement ?? true, diagnostic: FIXTURE_KEY }) };
    }
    const recheck = ++reads > 1;
    if (recheck && options.failRecheck) throw new Error(`Untrusted fixture diagnostic ${FIXTURE_KEY}`);
    const status = recheck ? options.recheckStatus ?? 200 : options.readStatus ?? 200;
    return { ok: status < 300, status, json: async () => options.unknown || (recheck && options.recheckUnknown) ? {}
      : { API_SERVER_KEY: { is_set: (options.existing ?? false) || becameSet } } };
  };
  await runInNewContext(source, {
    location: { origin: options.origin ?? ORIGIN },
    prompt: () => {
      prompts++;
      if (options.setDuringPrompt) becameSet = true;
      return Object.hasOwn(options, "input") ? options.input : `${FIXTURE_KEY}\n`;
    },
    fetch: send,
    console: { log: (value: Record<string, unknown>) => logs.push(value) },
    AbortSignal: { timeout: () => ({ fixtureOnly: true }) },
  });
  expect(JSON.stringify(logs)).not.toContain(FIXTURE_KEY);
  return { calls, logs, prompts };
}

describe("manual review-key browser setup (offline fixtures only)", () => {
  test("writes only the explicit review profile's env key, without listener changes or credential output", async () => {
    const result = await fixture();
    expect(result.calls).toHaveLength(3);
    expect(result.calls.every((call) => call.url === API_URL && call.resolved_url === API_URL)).toBe(true);
    expect(result.calls.every((call) => call.init.credentials === "same-origin" && call.init.redirect === "error")).toBe(true);
    expect(result.calls.slice(0, 2).every(call => call.init.cache === "no-store")).toBe(true);
    const write = result.calls[2]!;
    expect(write.init.method).toBe("PUT");
    expect(JSON.parse(String(write.init.body))).toEqual({ profile: "paperwork-review", key: "API_SERVER_KEY", value: FIXTURE_KEY });
    expect(result.logs).toEqual([{ profile: "paperwork-review", status: 200, outcome: "saved" }]);
  });

  test("the API remains pinned to the checked origin even with a different document base URL", async () => {
    const result = await fixture({ baseURI: "https://other.example.invalid/untrusted-base/" });
    expect(result.calls.every(call => call.url === API_URL && call.resolved_url === API_URL)).toBe(true);
    expect(result.calls.filter(call => call.init.method === "PUT")).toHaveLength(1);
  });

  test("a key set while the prompt is open refuses the write after a fresh no-cache recheck", async () => {
    const result = await fixture({ setDuringPrompt: true });
    expect(result.calls).toHaveLength(2); expect(result.prompts).toBe(1);
    expect(result.calls.filter(call => call.init.method === "PUT")).toHaveLength(0);
    expect(result.calls.every(call => call.init.cache === "no-store")).toBe(true);
    expect(result.logs[0]).toMatchObject({ profile: "paperwork-review", outcome: "refused", stage: "recheck" });
  });

  test("unknown metadata after the prompt cannot authorize a key write", async () => {
    const result = await fixture({ recheckUnknown: true });
    expect(result.calls).toHaveLength(2);
    expect(result.calls.filter(call => call.init.method === "PUT")).toHaveLength(0);
    expect(result.logs[0]).toMatchObject({ outcome: "refused", stage: "recheck" });
  });

  for (const recheckStatus of [401, 503]) test(`a ${recheckStatus} recheck refuses without a credential write or retry`, async () => {
    const result = await fixture({ recheckStatus });
    expect(result.calls).toHaveLength(2);
    expect(result.calls.filter(call => call.init.method === "PUT")).toHaveLength(0);
    expect(result.logs[0]).toMatchObject({ outcome: "refused", stage: "recheck", status: recheckStatus });
  });

  test("a failed recheck exposes no diagnostics and makes no credential write or retry", async () => {
    const result = await fixture({ failRecheck: true });
    expect(result.calls).toHaveLength(2);
    expect(result.calls.filter(call => call.init.method === "PUT")).toHaveLength(0);
    expect(result.logs[0]).toMatchObject({ outcome: "refused", stage: "recheck" });
  });

  test("refuses another site before making a request or asking for a key", async () => {
    const result = await fixture({ origin: "https://other.example.invalid" });
    expect(result.calls).toHaveLength(0);
    expect(result.prompts).toBe(0);
    expect(result.logs[0]?.outcome).toBe("refused");
  });

  test("refuses to overwrite an existing key", async () => {
    const result = await fixture({ existing: true });
    expect(result.calls).toHaveLength(1);
    expect(result.prompts).toBe(0);
    expect(result.logs[0]?.outcome).toBe("unchanged");
  });

  test("does not treat missing metadata as an unset key", async () => {
    const result = await fixture({ unknown: true });
    expect(result.calls).toHaveLength(1);
    expect(result.prompts).toBe(0);
    expect(result.logs[0]?.outcome).toBe("unchanged");
  });

  test("cancelled input makes no credential write", async () => {
    const result = await fixture({ input: null });
    expect(result.calls).toHaveLength(1);
    expect(result.logs[0]?.outcome).toBe("cancelled");
  });

  test("refuses the wrong key format without printing it or writing", async () => {
    const result = await fixture({ input: "not-the-generated-review-key" });
    expect(result.calls).toHaveLength(1);
    expect(result.logs[0]?.outcome).toBe("refused");
    expect(JSON.stringify(result.logs)).not.toContain("not-the-generated-review-key");
  });

  test("an unauthenticated read never asks for the key or writes", async () => {
    const result = await fixture({ readStatus: 401 });
    expect(result.calls).toHaveLength(1);
    expect(result.prompts).toBe(0);
    expect(result.logs[0]?.status).toBe(401);
  });

  test("a failed save is unverified and is not retried", async () => {
    const result = await fixture({ putStatus: 403 });
    expect(result.calls).toHaveLength(3);
    expect(result.logs[0]).toEqual({ profile: "paperwork-review", status: 403, outcome: "unverified" });
  });

  test("requires the server acknowledgement rather than only HTTP 200", async () => {
    const result = await fixture({ acknowledgement: false });
    expect(result.logs[0]?.outcome).toBe("unverified");
  });

  test("a lost save response stays unverified without leaking diagnostics or retrying", async () => {
    const result = await fixture({ failPut: true });
    expect(result.calls).toHaveLength(3);
    expect(result.logs[0]?.outcome).toBe("unverified");
    expect(result.logs[0]?.stage).toBe("save");
  });
});
