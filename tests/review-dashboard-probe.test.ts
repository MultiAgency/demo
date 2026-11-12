import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../scripts/probe-review-dashboard.browser.js", import.meta.url), "utf8");
const ORIGIN = "https://multi-7009.agents.nousresearch.com";
const TICKET = "fixture_private_ticket_" + "x".repeat(32);
const PRIVATE = "private upstream text, reasoning, key and session contents";

interface Options {
  origin?: string; status?: number; invalidTicket?: boolean; authority?: boolean; rpcError?: boolean;
  runtime?: Record<string, unknown>; snapshot?: Record<string, unknown>; disconnect?: boolean;
  oversized?: boolean; repeat?: boolean; stalledCreate?: boolean;
  rpcErrorData?: Record<string, unknown>;
  authorityMissing?: boolean; negotiatedProtocol?: string; readyJsonrpc?: string; pingFailure?: boolean; invalidPing?: boolean;
}

async function fixture(options: Options = {}) {
  const fetches: { url: string; init: RequestInit }[] = [];
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const sockets: { url: string; protocols: string[] }[] = [];
  const logs: Record<string, unknown>[] = [];
  let closed = false;
  class FakeSocket {
    protocol = options.negotiatedProtocol ?? "hermes-gateway-v1";
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string, protocols: string[]) {
      sockets.push({ url, protocols });
      queueMicrotask(() => options.disconnect ? this.onclose?.() : this.emit({ jsonrpc: options.readyJsonrpc ?? "2.0", method: "event",
        params: { type: "gateway.ready", payload: {
          ...(!options.authorityMissing && { session_authority: options.authority ?? true }), private: PRIVATE
        } } }));
    }
    emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
    send(text: string) {
      const req = JSON.parse(text);
      requests.push({ method: req.method, params: req.params });
      queueMicrotask(() => {
        if (req.method === "gateway.ping") return this.emit({ jsonrpc: options.invalidPing ? PRIVATE : "2.0", id: req.id,
          ...(options.pingFailure ? { error: { message: PRIVATE } } : { result: { ok: true } }) });
        if (options.rpcError) return this.emit({ jsonrpc: "2.0", id: req.id,
          error: { message: PRIVATE, code: 4001, data: options.rpcErrorData ?? { reason: PRIVATE, field: PRIVATE } } });
        if (req.method === "runtime.describe") return this.emit({ jsonrpc: "2.0", id: req.id, result: {
          capabilities: ["durable-admission-v1", "local-cli-create-v1"], session_create: {
            sources: ["oneshot"], parameters: ["model", "provider", "toolsets", "max_turns"]
          }, ...options.runtime
        } });
        if (req.method !== "session.create") throw new Error("Unapproved fixture method " + req.method);
        if (options.stalledCreate) return;
        this.emit({ jsonrpc: "2.0", method: "event", params: { type: "message.delta", session_id: "foreign", payload: { text: PRIVATE } } });
        if (options.oversized) return this.onmessage?.({ data: "x".repeat(65537) });
        this.emit({ jsonrpc: "2.0", id: req.id, result: {
          session_id: "fixture-private-session", messages: [], message_count: 0, running: false, pending: [], prompts: [],
          info: { profile_name: "paperwork-review", profile_id: "private-profile-id", source: "oneshot",
            model: "z-ai/glm-5.3-flash", desktop_protocol: "hermes-gateway-v1", tool_count: 0 },
          private: PRIVATE, ...options.snapshot
        } });
      });
    }
    close() { closed = true; }
  }
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const context = {
    location: { origin: options.origin ?? ORIGIN }, WebSocket: FakeSocket,
    crypto: { randomUUID: () => "fixture-unique-create-id" },
    fetch: async (url: string, init: RequestInit) => {
      fetches.push({ url, init });
      const status = options.status ?? 200;
      return { ok: status === 200, status,
        text: async () => JSON.stringify({ ticket: options.invalidTicket ? PRIVATE : TICKET, ttl_seconds: 30 }) };
    },
    console: { log: (value: Record<string, unknown>) => logs.push(value) },
    AbortSignal: { timeout: () => ({ fixtureOnly: true }) },
    setTimeout: (fn: () => void) => { const timer = setTimeout(fn, options.stalledCreate ? 15 : 1000); timers.add(timer); return timer; },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer); timers.delete(timer); },
  };
  try {
    await runInNewContext(source, context);
    if (options.repeat) await runInNewContext(source, context);
  } finally { for (const timer of timers) clearTimeout(timer); }
  const printed = JSON.stringify(logs);
  for (const secret of [TICKET, PRIVATE, "fixture-private-session", "fixture-unique-create-id", "private-profile-id"])
    expect(printed).not.toContain(secret);
  expect(requests.some((request) => request.method === "prompt.submit")).toBe(false);
  return { fetches, requests, sockets, logs, closed };
}

describe("manual hosted dashboard connection probe (offline fixtures only)", () => {
  test("uses current browser auth, keeps tickets out of URLs and checks a fresh named session without inference", async () => {
    const result = await fixture();
    expect(result.fetches).toHaveLength(1);
    expect(result.fetches[0]).toMatchObject({ url: ORIGIN + "/api/auth/ws-ticket", init: {
      method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store"
    } });
    expect(result.fetches[0]!.init.body).toBeUndefined();
    expect(result.sockets).toEqual([{ url: "wss://multi-7009.agents.nousresearch.com/api/ws",
      protocols: ["hermes-gateway-v1", "hermes-gateway-ticket." + TICKET] }]);
    expect(result.requests.map((request) => request.method)).toEqual(["runtime.describe", "session.create"]);
    expect(result.requests[0]!.params).toEqual({});
    const create = result.requests[1]!.params;
    expect(create).toMatchObject({ profile: "paperwork-review", request_id: "fixture-unique-create-id", source: "oneshot",
      model: "z-ai/glm-5.3-flash", provider: "custom:near", toolsets: ["no_mcp"], max_turns: 2, follow_profile_config: false });
    expect(create.title).toBeUndefined();
    expect(result.logs[0]).toMatchObject({ outcome: "pass", check: "dashboard_connection_only", inference_tested: false,
      app_connected: false, attempts: { ticket: 1, ping: 0, runtime: 1, session_create: 1, prompts: 0 },
      handshake: { ready_received: true, negotiated_protocol: "expected", session_authority: "true", refusal: null } });
    expect(result.closed).toBe(true);
  });

  test("refuses the wrong site before auth or WebSocket requests", async () => {
    const result = await fixture({ origin: "https://other.example.invalid" });
    expect(result.fetches).toHaveLength(0); expect(result.sockets).toHaveLength(0);
    expect(result.logs[0]).toMatchObject({ code: "wrong_origin" });
  });

  for (const status of [401, 302, 503]) test(`refuses ticket HTTP ${status} before any socket or session`, async () => {
    const result = await fixture({ status });
    expect(result.sockets).toHaveLength(0); expect(result.requests).toHaveLength(0);
    expect(result.logs[0]).toMatchObject({ outcome: "blocked", stage: "ticket", code: "ticket_refused", ticket_http_status: status });
  });

  test("refuses invalid tickets without printing them", async () => {
    const result = await fixture({ invalidTicket: true });
    expect(result.sockets).toHaveLength(0); expect(result.logs[0]).toMatchObject({ code: "ticket_invalid" });
  });

  test("pings a noncanonical connection but never sends session or model requests", async () => {
    const result = await fixture({ authority: false });
    expect(result.requests.map((request) => request.method)).toEqual(["gateway.ping"]); expect(result.closed).toBe(true);
    expect(result.logs[0]).toMatchObject({ code: "protocol_unavailable", attempts: { ping: 1, runtime: 0, session_create: 0 },
      handshake: { negotiated_protocol: "expected", session_authority: "false", ping_acknowledged: true,
        refusal: "canonical_authority_unavailable" } });
  });

  test("distinguishes a valid legacy ready frame from a failed WebSocket connection", async () => {
    const result = await fixture({ authorityMissing: true });
    expect(result.requests.map((request) => request.method)).toEqual(["gateway.ping"]);
    expect(result.logs[0]).toMatchObject({ handshake: {
      negotiated_protocol: "expected", jsonrpc: "expected", ready_received: true,
      session_authority: "missing", ping_acknowledged: true, refusal: "canonical_authority_unavailable"
    } });
  });

  for (const negotiatedProtocol of ["", PRIVATE]) test("classifies a subprotocol mismatch without printing it or creating a session", async () => {
    const result = await fixture({ negotiatedProtocol });
    expect(result.requests.map((request) => request.method)).toEqual(["gateway.ping"]);
    expect(result.logs[0]).toMatchObject({ handshake: {
      negotiated_protocol: negotiatedProtocol ? "other" : "none", ping_acknowledged: true, refusal: "subprotocol_mismatch"
    } });
  });

  test("a failed legacy ping cannot erase the handshake diagnosis or authorize another call", async () => {
    const result = await fixture({ authorityMissing: true, pingFailure: true });
    expect(result.requests.map((request) => request.method)).toEqual(["gateway.ping"]);
    expect(result.logs[0]).toMatchObject({ handshake: { session_authority: "missing", ping_acknowledged: false,
      refusal: "canonical_authority_unavailable" } });
  });

  test("classifies unexpected JSON-RPC versions without printing them or sending an RPC", async () => {
    const result = await fixture({ readyJsonrpc: PRIVATE });
    expect(result.requests).toHaveLength(0);
    expect(result.logs[0]).toMatchObject({ handshake: { jsonrpc: "other", ready_received: false, refusal: "invalid_jsonrpc" } });
  });

  test("a malformed ping reply cannot replace the original ready-frame observation", async () => {
    const result = await fixture({ authorityMissing: true, invalidPing: true });
    expect(result.requests.map((request) => request.method)).toEqual(["gateway.ping"]);
    expect(result.logs[0]).toMatchObject({ handshake: { jsonrpc: "expected", session_authority: "missing",
      refusal: "canonical_authority_unavailable", ping_acknowledged: false } });
  });

  for (const runtime of [{ capabilities: [] }, { capabilities: ["durable-admission-v1"] },
    { capabilities: "durable-admission-v1 local-cli-create-v1" },
    { session_create: { sources: ["oneshot"], parameters: ["model"] } }])
    test("refuses missing or malformed runtime capabilities before creating a session", async () => {
      const result = await fixture({ runtime });
      expect(result.requests).toHaveLength(1); expect(result.logs[0]).toMatchObject({ code: "runtime_incompatible" });
    });

  for (const snapshot of [
    { info: { profile_name: "default" } }, { info: { profile_name: "paperwork-review", model: "other-model" } },
    { info: { profile_name: "paperwork-review", model: "z-ai/glm-5.3-flash", desktop_protocol: "hermes-gateway-v1", tool_count: 1 } },
    { messages: [{ content: PRIVATE }] }, { message_count: 1 }, { running: true },
    { pending: [{}] }, { prompts: [{}] }, { session_id: null }
  ]) test("refuses mismatched, nonempty or busy session metadata", async () => {
    const result = await fixture({ snapshot });
    expect(result.logs[0]).toMatchObject({ outcome: "blocked", stage: "metadata", code: "session_unverified" });
    expect(result.requests).toHaveLength(2);
  });

  test("rejects RPC errors without printing upstream diagnostics", async () => {
    const result = await fixture({ rpcError: true });
    expect(result.logs[0]).toMatchObject({ code: "rpc_refused", rpc_refusal: {
      method: "runtime.describe", code: 4001, reason: "other", field: "other"
    } });
    expect(result.requests).toHaveLength(1);
  });

  test("reports only known RPC refusal reasons and fields", async () => {
    const result = await fixture({ rpcError: true, rpcErrorData: { reason: "runtime_draining", field: "profile", detail: PRIVATE } });
    expect(result.logs[0]).toMatchObject({ rpc_refusal: {
      method: "runtime.describe", code: 4001, reason: "runtime_draining", field: "profile"
    } });
  });

  test("handles transport closure without retry", async () => {
    const result = await fixture({ disconnect: true });
    expect(result.requests).toHaveLength(0); expect(result.logs[0]).toMatchObject({ code: "transport_failed" });
  });

  test("bounds incoming frames and discards their content", async () => {
    const result = await fixture({ oversized: true });
    expect(result.logs[0]).toMatchObject({ code: "response_too_large" });
    expect(result.closed).toBe(true);
  });

  test("a lost create response stays unverified and creates no replacement session", async () => {
    const result = await fixture({ stalledCreate: true });
    expect(result.requests.filter((request) => request.method === "session.create")).toHaveLength(1);
    expect(result.logs[0]).toMatchObject({ outcome: "blocked", code: "transport_timeout", session_observed: false,
      attempts: { session_create: 1, prompts: 0 } });
  });

  test("a second invocation in the same page makes no new ticket or session", async () => {
    const result = await fixture({ repeat: true });
    expect(result.fetches).toHaveLength(1); expect(result.requests).toHaveLength(2);
    expect(result.logs[1]).toMatchObject({ outcome: "blocked", code: "already_attempted" });
  });
});
