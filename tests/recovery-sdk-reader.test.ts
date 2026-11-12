import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { contractPackage } from "@multiagency/sdk";
import type { RecoveryBinding } from "../src/server/recovery/evidence";
import { createRecoveryReader } from "../src/server/recovery/sdk-reader";

// Every HTTP response is injected. No hosted transport, environment credential or application runtime is used.
const credential = "tap_fixture_recovery_reader_secret";
const binding: RecoveryBinding = {
  schema_version: 1, snapshot_sha256: "a".repeat(64), provenance_sha256: "b".repeat(64),
  platform_origin: "https://platform.invalid", deployment: "fixture-deployment", contract_id: "c_fixture",
  terms_hash: "c".repeat(64), organization: "original-organization", agent: "original-agent", agent_id: "original-provider-id",
};
const withdrawal = { recipient: "builder.demo", asset: "nep141:fixture-usdc.near", amount: "300000000", chain: "near", confidential: true };
const payout = { requestId: "original-request", state: "failed", status: "FAILED", correlationId: "original-payment", code: null, failureCode: "delivery_failed" };
const payment = {
  status: "FAILED", failureCode: null, createdAt: null, updatedAt: null, request: withdrawal,
  approvalId: "original-approval", expiresAt: null, detailError: null,
  evidence: { txHash: null, destinationTxHash: null, refundTxHash: null, refundTo: null, refundedAmount: null },
};
const held = { at: "2026-11-11T12:00:00Z", kind: "payout", request: withdrawal, correlationId: "original-payment", approvalId: "original-approval" };
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const encoded = (value: unknown) => JSON.stringify({ json: value });
const rpc = (value: unknown) => new Response(encoded(value), { headers: { "content-type": "application/json" } });
type Call = { url: string; init: RequestInit };

function fixture(reply: (call: Call) => Response | Promise<Response>, timeoutMs = 1000) {
  const calls: Call[] = [];
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: input instanceof Request ? input.url : String(input), init: init ?? {} };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return { calls, reader: createRecoveryReader({ origin: binding.platform_origin, deployment: binding.deployment, credential, fetch: send, timeoutMs }) };
}

describe("recovery SDK reader — bounded HTTP fixtures", () => {
  test("uses only the four exact SDK read paths with original IDs and zero payment wait", async () => {
    const values = [payout, payment, [held], { stage: "unknown", phase: "open" }];
    let index = 0;
    const { reader, calls } = fixture(() => rpc(values[index++]));
    const results = [
      await reader.payoutStatus(binding, "original-request"),
      await reader.paymentStatus(binding, "original-payment"),
      await reader.held(binding),
      await reader.ownerStatus(binding, "original-owner-step"),
    ];
    expect(reader.sdk_version).toBe(contractPackage.version);
    expect(Object.keys(reader).sort()).toEqual(["deployment", "held", "origin", "ownerStatus", "paymentStatus", "payoutStatus", "sdk_version"]);
    expect(results.map(result => result.ok)).toEqual([true, true, true, true]);
    expect(calls.map(call => call.url)).toEqual(["payouts/status", "paymentStatus", "held", "owner/status"].map(path =>
      `${binding.platform_origin}/apps/v1/o/${binding.organization}/a/${binding.agent}/rpc/${path}`));
    expect(calls.map(call => call.init.body)).toEqual([
      encoded({ requestId: "original-request" }), encoded({ correlationId: "original-payment", waitMs: 0 }), undefined, encoded({ correlationId: "original-owner-step" }),
    ]);
    for (const call of calls) {
      expect(call.init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", cache: "no-store" });
      expect(new Headers(call.init.headers).get("authorization")).toBe(`Bearer ${credential}`);
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(results.map(result => result.response_sha256)).toEqual(values.map(value => hash(encoded(value))));
  });

  for (const proof of [undefined, false, true]) {
    test(`preserves ${proof === undefined ? "absent" : String(proof)} non-execution proof without inferring it from the failure code`, async () => {
      const value = { ...payout, ...(proof === undefined ? {} : { neverExecuted: proof }) };
      const { reader, calls } = fixture(() => rpc(value));
      expect(await reader.payoutStatus(binding, "original-request")).toEqual({ ok: true, value: {
        request_id: "original-request", state: "failed", status: "FAILED", correlation_id: "original-payment", never_executed: proof ?? null,
      }, response_sha256: hash(encoded(value)) });
      expect(calls).toHaveLength(1);
    });
  }

  test("projects evidence while excluding private fields, raw errors, sign payloads and confirmation links", async () => {
    const privateText = "PRIVATE_REPORT_AND_CONFIRM_URL";
    const paymentValue = { ...payment, detailError: credential, private: privateText,
      request: { ...withdrawal, memo: privateText, report: privateText, credential },
      evidence: { ...payment.evidence, txHash: "original-tx", destinationTxHash: "destination-tx", refundTxHash: "refund-tx", refundedAmount: "300000000", refundTo: privateText } };
    const { reader } = fixture(call => call.url.endsWith("paymentStatus") ? rpc(paymentValue)
      : call.url.endsWith("held") ? rpc([{ ...held, request: { ...withdrawal, private: privateText }, confirm: { url: privateText } }])
        : rpc({ stage: "submitted", phase: "settled", status: "SUCCESS", error: credential, intent: { payload: privateText }, confirm: { url: privateText } }));
    const result = await reader.paymentStatus(binding, "original-payment");
    expect(result).toMatchObject({ ok: true, value: {
      status: "FAILED", approval_id: "original-approval", tx_hash: "original-tx", destination_tx_hash: "destination-tx",
      refund_tx_hash: "refund-tx", refunded_amount: "300000000", request: { ...withdrawal, has_memo: true },
    } });
    const heldResult = await reader.held(binding);
    const ownerResult = await reader.ownerStatus(binding, "original-owner-step");
    expect(ownerResult).toMatchObject({ ok: true, value: { stage: "submitted", phase: "settled", status: "SUCCESS" } });
    const output = JSON.stringify([result, heldResult, ownerResult]);
    expect(output).not.toContain(privateText);
    expect(output).not.toContain(credential);
    expect(output).not.toContain("failureCode");
    expect(output).not.toContain("confirm");
    expect(output).not.toContain("intent");
  });

  for (const request of [null, {}, { ...withdrawal, chain: undefined, delivery: { chain: "near" } }, { ...withdrawal, amount: 300 }, { ...withdrawal, memo: {} }]) {
    test(`unsupported request metadata remains null (${JSON.stringify(request)})`, async () => {
      const { reader } = fixture(() => rpc({ ...payment, request }));
      expect(await reader.paymentStatus(binding, "original-payment")).toMatchObject({ ok: true, value: { request: null } });
    });
  }

  test("owner phase and status stay unknown when absent", async () => {
    const { reader } = fixture(() => rpc({ stage: "unknown" }));
    expect(await reader.ownerStatus(binding, "original-owner-step")).toMatchObject({ ok: true, value: { stage: "unknown", phase: null, status: null } });
  });

  for (const value of [{ ...payout, neverExecuted: "true" }, { ...payout, state: "paid" }, { ...payout, requestId: "foreign-request", neverExecuted: true }]) {
    test(`malformed or foreign payout response cannot become usable evidence (${JSON.stringify(value)})`, async () => {
      const { reader, calls } = fixture(() => rpc(value));
      expect(await reader.payoutStatus(binding, "original-request")).toMatchObject({ ok: false });
      expect(calls).toHaveLength(1);
    });
  }

  test("credential reflection in a projected field produces only a fixed failure", async () => {
    const { reader } = fixture(() => rpc({ ...payment, evidence: { ...payment.evidence, txHash: credential } }));
    const result = await reader.paymentStatus(binding, "original-payment");
    expect(result).toMatchObject({ ok: false, kind: "invalid_response" });
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  for (const token of [
    // Public platform minting format is tap_<UUID>.<base64url secret>; all bytes below are synthetic.
    `tap_00000000-0000-4000-8000-000000000000.${"f".repeat(43)}`,
    "opaque-contract-credential.v2~with+base64/characters=",
    "x".repeat(8 * 1024),
  ]) test(`opaque credential of ${token.length} bytes reaches only the fixed read authorization header`, async () => {
    const calls: Call[] = [];
    const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return rpc([]);
    }) as typeof fetch;
    const reader = createRecoveryReader({ origin: binding.platform_origin, deployment: binding.deployment, credential: token, fetch: send });
    const result = await reader.held(binding);
    expect(result).toMatchObject({ ok: true, value: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${binding.platform_origin}/apps/v1/o/${binding.organization}/a/${binding.agent}/rpc/held`);
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  test("invalid credential header values fail with a fixed diagnostic before any HTTP request", () => {
    const calls: Call[] = [];
    const send = (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(input), init: init ?? {} }); return rpc([]); }) as typeof fetch;
    for (const token of ["", " ", " fixture", "fixture ", "fixture secret", "fixture\r\nAuthorization: injected", "fixture\nsecret", "fixture\tsecret", "fixture\0secret", "fixture\x7fsecret", "fixture-\u00e9", "x".repeat(8 * 1024 + 1), null, 123]) {
      let error: unknown;
      try { createRecoveryReader({ origin: binding.platform_origin, deployment: binding.deployment, credential: token as string, fetch: send }); }
      catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Recovery reads require a valid deployment and server app credential.");
    }
    expect(calls).toHaveLength(0);
  });

  for (const [httpStatus, kind] of [[401, "session"], [403, "forbidden"], [429, "rate_limited"], [503, "unavailable"]] as const) {
    test(`HTTP ${httpStatus} is sanitized without retry or raw provider text`, async () => {
      const { reader, calls } = fixture(() => new Response(JSON.stringify({ error: credential, code: "private_failure_code" }), { status: httpStatus, headers: { "content-type": "application/json", "retry-after": "1" } }));
      const result = await reader.payoutStatus(binding, "original-request");
      expect(result).toMatchObject({ ok: false, kind });
      expect(JSON.stringify(result)).not.toContain(credential);
      expect(JSON.stringify(result)).not.toContain("private_failure_code");
      expect(calls).toHaveLength(1);
    });
  }

  for (const changed of [
    { platform_origin: "https://different.invalid" }, { deployment: "different-deployment" }, { organization: "." }, { agent: ".." },
    { organization: "a/b" }, { agent: "a\\b" }, { agent: "%2e%2e" }, { agent_id: "../provider" },
  ]) {
    test(`invalid or mismatched binding is refused before HTTP (${JSON.stringify(changed)})`, async () => {
      const { reader, calls } = fixture(() => { throw new Error("No fixture should be read."); });
      expect(await reader.payoutStatus({ ...binding, ...changed }, "original-request")).toEqual({ ok: false, kind: "invalid_response", response_sha256: null });
      expect(calls).toHaveLength(0);
    });
  }

  test("invalid target identities cannot escape their read endpoint or trigger a request", async () => {
    const { reader, calls } = fixture(() => rpc(payout));
    for (const target of [".", "..", "../owner/submit", "request/other", "%2f", "x".repeat(257)]) {
      expect(await reader.payoutStatus(binding, target)).toMatchObject({ ok: false, kind: "invalid_response" });
      expect(await reader.paymentStatus(binding, target)).toMatchObject({ ok: false, kind: "invalid_response" });
      expect(await reader.ownerStatus(binding, target)).toMatchObject({ ok: false, kind: "invalid_response" });
    }
    expect(await reader.payoutStatus(binding, 123 as unknown as string)).toMatchObject({ ok: false, kind: "invalid_response" });
    expect(calls).toHaveLength(0);
  });

  test("caller mutation cannot change an already admitted binding or request", async () => {
    let release: (response: Response) => void = () => {};
    const mutable = { ...binding };
    const { reader, calls } = fixture(() => new Promise<Response>(resolve => { release = resolve; }));
    const pending = reader.payoutStatus(mutable, "original-request");
    await Bun.sleep(0);
    mutable.organization = "different-organization";
    mutable.agent = "different-agent";
    release(rpc(payout));
    expect(await pending).toMatchObject({ ok: true });
    expect(calls[0]!.url).toContain(`/o/${binding.organization}/a/${binding.agent}/`);
  });

  test("redirects are rejected and credentials never follow the Location URL", async () => {
    const { reader, calls } = fixture(() => new Response(null, { status: 302, headers: { location: `https://other.invalid/${credential}` } }));
    expect(await reader.payoutStatus(binding, "original-request")).toEqual({ ok: false, kind: "invalid_response", response_sha256: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe("error");
  });

  test("an injected transport reporting a followed redirect is rejected", async () => {
    const response = rpc(payout);
    Object.defineProperty(response, "redirected", { value: true });
    Object.defineProperty(response, "url", { value: "https://other.invalid/response" });
    const { reader, calls } = fixture(() => response);
    expect(await reader.payoutStatus(binding, "original-request")).toMatchObject({ ok: false, kind: "invalid_response" });
    expect(calls).toHaveLength(1);
  });

  test("oversized Content-Length is refused without buffering the body", async () => {
    const { reader, calls } = fixture(() => new Response("{}", { headers: { "content-type": "application/json", "content-length": String(1024 * 1024 + 1) } }));
    expect(await reader.payoutStatus(binding, "original-request")).toEqual({ ok: false, kind: "oversized_response", response_sha256: null });
    expect(calls).toHaveLength(1);
  });

  test("streamed response bytes are bounded even without Content-Length", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); controller.enqueue(new Uint8Array(1)); },
      cancel() { cancelled = true; },
    });
    const { reader, calls } = fixture(() => new Response(body, { headers: { "content-type": "application/json" } }));
    expect(await reader.payoutStatus(binding, "original-request")).toEqual({ ok: false, kind: "oversized_response", response_sha256: null });
    expect(cancelled).toBe(true);
    expect(calls).toHaveLength(1);
  });

  for (const phase of ["headers", "body"] as const) {
    test(`timeout covers stalled ${phase}, including an uncooperative injected transport`, async () => {
      const { reader, calls } = fixture(() => phase === "headers" ? new Promise<Response>(() => {})
        : new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{\"json\":")); } }), { headers: { "content-type": "application/json" } }), 20);
      expect(await reader.payoutStatus(binding, "original-request")).toEqual({ ok: false, kind: "timeout", response_sha256: null });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.init.signal?.aborted).toBe(true);
    });
  }

  test("caller cancellation aborts the pending read without retry", async () => {
    const controller = new AbortController();
    const { reader, calls } = fixture(() => new Promise<Response>(() => {}));
    const pending = reader.payoutStatus(binding, "original-request", controller.signal);
    await Bun.sleep(0);
    controller.abort(new Error(credential));
    const result = await pending;
    expect(result).toEqual({ ok: false, kind: "unavailable", response_sha256: null });
    expect(calls[0]!.init.signal?.aborted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(await reader.held(binding, controller.signal)).toMatchObject({ ok: false, kind: "unavailable" });
    expect(calls).toHaveLength(1);
  });

  test("network errors and malformed JSON expose no error text", async () => {
    const network = fixture(() => { throw new Error(credential); });
    expect(await network.reader.payoutStatus(binding, "original-request")).toEqual({ ok: false, kind: "unavailable", response_sha256: null });
    const malformed = fixture(() => new Response(`not-json-${credential}`, { headers: { "content-type": "application/json" } }));
    const result = await malformed.reader.payoutStatus(binding, "original-request");
    expect(result).toEqual({ ok: false, kind: "unavailable", response_sha256: hash(`not-json-${credential}`) });
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  test("non-JSON and event-stream responses cannot open another protocol", async () => {
    for (const contentType of ["text/html", "text/event-stream"]) {
      const { reader, calls } = fixture(() => new Response("data: private", { headers: { "content-type": contentType } }));
      expect(await reader.payoutStatus(binding, "original-request")).toMatchObject({ ok: false, kind: "invalid_response" });
      expect(calls).toHaveLength(1);
    }
  });

  test("held output is limited to 500 entries", async () => {
    for (const count of [500, 501]) {
      const { reader } = fixture(() => rpc(Array.from({ length: count }, (_, i) => ({ ...held, correlationId: `payment-${i}`, approvalId: `approval-${i}` }))));
      const result = await reader.held(binding);
      if (count === 500) {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value).toHaveLength(500);
      } else expect(result).toMatchObject({ ok: false, kind: "oversized_response" });
    }
  });

  test("configuration refuses unsafe origins, identities and excessive timeouts", () => {
    const options = { origin: binding.platform_origin, deployment: binding.deployment, credential };
    for (const origin of ["http://remote.invalid", "https://*.platform.invalid", "https://user:secret@platform.invalid", "https://platform.invalid/path", "https://platform.invalid/", "https://platform.invalid?x=1", "https://platform.invalid#x"])
      expect(() => createRecoveryReader({ ...options, origin })).toThrow();
    for (const deployment of [".", "..", "a/b", "a\\b", ""])
      expect(() => createRecoveryReader({ ...options, deployment })).toThrow();
    for (const timeoutMs of [0, -1, 0.5, 10_001, Infinity])
      expect(() => createRecoveryReader({ ...options, timeoutMs })).toThrow();
    expect(() => createRecoveryReader({ ...options, origin: "http://127.0.0.1:12345" })).not.toThrow();
  });
});
