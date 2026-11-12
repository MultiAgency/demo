import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, VerificationError, type AttestationVerificationResult, type InferenceClientOptions, type VerifiedCompletionResult } from "@nearai/inference-sdk/node";
import { createNearReviewClient, NearNetworkScope, type NearChatRequest, type NearClientDependencies } from "../src/server/review/near-client";
import { NEAR_AI_BASE_URL } from "../src/server/review/types";

const KEY = "offline-near-fixture-key";
const REQUEST: NearChatRequest = { model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: "SYNTHETIC fixture" }],
  reasoning_effort: "low", max_tokens: 128, stream: false };
const PROOF = { signatureKind: "provider_tee", id: "fixture-completion" } as VerifiedCompletionResult;
const VERIFIED = { models: [], verifiedAt: 1 } as unknown as AttestationVerificationResult;
const defer = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

function fake(overrides: Partial<{ verify: () => Promise<AttestationVerificationResult>; complete: () => Promise<unknown>; verifyResponse: () => Promise<VerifiedCompletionResult> }> = {}) {
  let settings: InferenceClientOptions | undefined;
  const calls = { verify: 0, complete: 0, signatures: 0, cleared: 0 };
  const requests: NearChatRequest[] = [];
  const dependencies: NearClientDependencies = { createSdk: options => {
    settings = options;
    return {
      verify: async () => { calls.verify++; return overrides.verify ? overrides.verify() : VERIFIED; },
      complete: async request => { calls.complete++; requests.push(request); return overrides.complete ? overrides.complete() : { id: "fixture-completion" }; },
      verifyResponse: async () => { calls.signatures++; return overrides.verifyResponse ? overrides.verifyResponse() : PROOF; },
      clearResponseCache: () => { calls.cleared++; },
    };
  } };
  return { dependencies, calls, requests, settings: () => settings };
}

describe("direct NEAR SDK client lifecycle (offline only)", () => {
  test("pins verification/encryption policy and delegates one review through the official client surface", async () => {
    const fixture = fake();
    const controller = new AbortController();
    const client = createNearReviewClient({ apiKey: KEY, timeoutMs: 1000 }, controller.signal, fixture.dependencies);
    try {
      expect(fixture.settings()).toMatchObject({ baseUrl: NEAR_AI_BASE_URL, apiKey: KEY, e2ee: true, ohttp: false, signingAlgo: "ed25519",
        gatewayVerification: { includeSpkiFingerprint: true, policy: { acceptedTcbStatuses: ["UpToDate"] } },
        modelVerification: { policy: { acceptedTcbStatuses: ["UpToDate"], gpuEvidence: "required" } },
        attestationCacheTimeToLiveMs: 1000, responseCacheTimeToLiveMs: 1000 });
      expect(await client.verify(REQUEST.model)).toBe(VERIFIED);
      expect(await client.complete(REQUEST)).toEqual({ id: "fixture-completion" });
      expect(await client.verifyResponse("fixture-completion")).toBe(PROOF);
      expect(fixture.calls).toMatchObject({ verify: 1, complete: 1, signatures: 1 });
    } finally { client.dispose(); }
    client.dispose();
    expect(fixture.calls.cleared).toBe(1);
    expect(() => client.verify(REQUEST.model)).toThrow();
  });

  test("projects only the no-tools review request and refuses a second completion after a lost result", async () => {
    const fixture = fake({ complete: async () => { throw new Error("synthetic lost response"); } });
    const client = createNearReviewClient({ apiKey: KEY, timeoutMs: 1000 }, new AbortController().signal, fixture.dependencies);
    try {
      const extra = { ...REQUEST, tools: [{ function: { name: "terminal" } }], reasoning_effort: "high", stream: true };
      await expect(client.complete(extra as unknown as NearChatRequest)).rejects.toThrow("synthetic lost response");
      await expect(client.complete(REQUEST)).rejects.toThrow("already attempted");
      expect(fixture.calls.complete).toBe(1);
      expect(fixture.requests[0]).toEqual(REQUEST);
    } finally { client.dispose(); }
  });

  test("an already canceled review never constructs the SDK or sends a request", () => {
    const fixture = fake();
    const controller = new AbortController(); controller.abort();
    expect(() => createNearReviewClient({ apiKey: KEY, timeoutMs: 1000 }, controller.signal, fixture.dependencies)).toThrow();
    expect(fixture.settings()).toBeUndefined();
    expect(fixture.calls.complete).toBe(0);
  });

  for (const operation of ["verify", "complete", "verifyResponse"] as const) test(`cancellation bounds a noncooperating SDK ${operation} and prevents late use`, async () => {
    const late = defer<never>();
    const fixture = fake({ [operation]: () => late.promise });
    const controller = new AbortController();
    const client = createNearReviewClient({ apiKey: KEY, timeoutMs: 1000 }, controller.signal, fixture.dependencies);
    try {
      const pending = operation === "complete" ? client.complete(REQUEST) : operation === "verify" ? client.verify(REQUEST.model) : client.verifyResponse("fixture-completion");
      controller.abort(new DOMException("fixture stopped", "AbortError"));
      await expect(pending).rejects.toHaveProperty("name", "AbortError");
      client.dispose();
      late.resolve(undefined as never);
      await Promise.resolve();
      expect(fixture.calls.cleared).toBe(1);
      expect(fixture.calls.complete).toBe(operation === "complete" ? 1 : 0);
    } finally { client.dispose(); }
  });

  test("the whole-review deadline bounds a stalled SDK call", async () => {
    const fixture = fake({ verify: () => new Promise(() => {}) });
    const client = createNearReviewClient({ apiKey: KEY, timeoutMs: 15 }, new AbortController().signal, fixture.dependencies);
    try { await expect(client.verify(REQUEST.model)).rejects.toHaveProperty("name", "TimeoutError"); }
    finally { client.dispose(); }
  });

  test("invalid connection configuration cannot construct a client", () => {
    for (const options of [{ apiKey: "", timeoutMs: 1000 }, { apiKey: "invalid key", timeoutMs: 1000 },
      { apiKey: KEY, timeoutMs: 0 }, { apiKey: KEY, timeoutMs: 300001 }]) {
      const fixture = fake();
      expect(() => createNearReviewClient(options, new AbortController().signal, fixture.dependencies)).toThrow();
      expect(fixture.settings()).toBeUndefined();
    }
  });

  test("retries only the same temporarily unavailable receipt without repeating inference", async () => {
    let attempts = 0;
    const fixture = fake({ verifyResponse: async () => {
      if (++attempts < 3) throw new ApiError({ code: "api.completion_signature_unavailable",
        details: { providerErrorCode: "fixture_pending", providerMessage: "fixture only" } });
      return PROOF;
    } });
    const client = createNearReviewClient({ apiKey: KEY, timeoutMs: 2000 }, new AbortController().signal, fixture.dependencies);
    try {
      await client.verify(REQUEST.model); await client.complete(REQUEST);
      expect(await client.verifyResponse("fixture-completion")).toBe(PROOF);
      expect(fixture.calls).toEqual({ verify: 1, complete: 1, signatures: 3, cleared: 1 });
    } finally { client.dispose(); }
    expect(fixture.calls.cleared).toBe(1);
  });

  test("retries only allowed HTTP receipt statuses and transient receipt transport errors", async () => {
    const failures = [404, 408, 429, 500, 502, 503, 504].map(status => new ApiError({ code: "api.http_status",
      details: { resource: "completion_signature", status }, retryable: false }));
    failures.push(new ApiError({ code: "api.transport_failed", details: { resource: "completion_signature", reason: "request" }, retryable: true }));
    for (const failure of failures) {
      let attempts = 0;
      const fixture = fake({ verifyResponse: async () => { if (++attempts === 1) throw failure; return PROOF; } });
      const client = createNearReviewClient({ apiKey: KEY, timeoutMs: 1500 }, new AbortController().signal, fixture.dependencies);
      try { expect(await client.verifyResponse("fixture-completion")).toBe(PROOF); expect(fixture.calls.signatures).toBe(2); }
      finally { client.dispose(); }
    }
  }, 5000);

  test("receipt verification stops after three failed lookups and releases captured responses", async () => {
    const failure = new ApiError({ code: "api.http_status", details: { resource: "completion_signature", status: 404 }, retryable: true });
    const fixture = fake({ verifyResponse: async () => { throw failure; } });
    const client = createNearReviewClient({ apiKey: KEY, timeoutMs: 2000 }, new AbortController().signal, fixture.dependencies);
    try {
      await expect(client.verifyResponse("fixture-completion")).rejects.toBe(failure);
      expect(fixture.calls).toEqual({ verify: 0, complete: 0, signatures: 3, cleared: 1 });
    } finally { client.dispose(); }
  });

  test("never retries invalid signatures, authorization refusal, other API resources or unclassified failures", async () => {
    for (const failure of [
      new VerificationError({ code: "signature.signer_mismatch" }),
      new ApiError({ code: "api.http_status", details: { resource: "completion_signature", status: 401 }, retryable: true }),
      new ApiError({ code: "api.http_status", details: { resource: "completion_signature", status: 403 }, retryable: true }),
      new ApiError({ code: "api.http_status", details: { resource: "completion", status: 503 }, retryable: true }),
      new ApiError({ code: "api.transport_failed", details: { resource: "completion_signature", reason: "request" }, retryable: false }),
      new ApiError({ code: "api.completion_not_found" }), new Error("unclassified fixture failure"),
    ]) {
      const fixture = fake({ verifyResponse: async () => { throw failure; } });
      const client = createNearReviewClient({ apiKey: KEY, timeoutMs: 1000 }, new AbortController().signal, fixture.dependencies);
      try {
        await expect(client.verifyResponse("fixture-completion")).rejects.toBe(failure);
        expect(fixture.calls).toEqual({ verify: 0, complete: 0, signatures: 1, cleared: 1 });
      } finally { client.dispose(); }
    }
  });

  test("cancellation during a receipt retry wait prevents the next lookup", async () => {
    const fixture = fake({ verifyResponse: async () => {
      throw new ApiError({ code: "api.http_status", details: { resource: "completion_signature", status: 404 }, retryable: true });
    } });
    const controller = new AbortController();
    const client = createNearReviewClient({ apiKey: KEY, timeoutMs: 2000 }, controller.signal, fixture.dependencies);
    try {
      const pending = client.verifyResponse("fixture-completion");
      await Bun.sleep(20); controller.abort();
      await expect(pending).rejects.toHaveProperty("name", "AbortError");
      await Bun.sleep(220);
      expect(fixture.calls).toEqual({ verify: 0, complete: 0, signatures: 1, cleared: 1 });
    } finally { client.dispose(); }
  });
});

describe("bounded NEAR Node transport (offline injected fetch)", () => {
  test("rejects another origin or version prefix before dispatch", async () => {
    const scope = new NearNetworkScope(1000, new AbortController().signal);
    let calls = 0;
    const send = scope.wrap(async () => { calls++; return new Response("unused"); });
    try {
      for (const url of ["https://other.example.invalid/v1/model/x", "https://cloud-api.near.ai/v1-other/model/x"])
        await expect(send(url)).rejects.toThrow("unexpected destination");
      expect(calls).toBe(0);
    } finally { scope.stop(); }
  });

  test("limits the signed completion body before the SDK can accumulate it", async () => {
    const scope = new NearNetworkScope(1000, new AbortController().signal);
    const send = scope.wrap(async () => new Response(new Uint8Array(512 * 1024 + 1)));
    try {
      const response = await send(NEAR_AI_BASE_URL + "/chat/completions", { method: "POST", body: "{}" });
      await expect(response.arrayBuffer()).rejects.toThrow("exceeded");
    } finally { scope.stop(); }
  });

  test("limits attestation bodies and preserves their raw bytes", async () => {
    const scope = new NearNetworkScope(1000, new AbortController().signal);
    try {
      const raw = new Uint8Array([0, 239, 255, 12]);
      const valid = scope.wrap(async () => new Response(raw, { headers: { "content-type": "application/json" } }));
      expect(new Uint8Array(await (await valid(NEAR_AI_BASE_URL + "/attestation/report")).arrayBuffer())).toEqual(raw);
      const oversized = scope.wrap(async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)));
      await expect((await oversized(NEAR_AI_BASE_URL + "/attestation/report")).arrayBuffer()).rejects.toThrow("exceeded");
    } finally { scope.stop(); }
  });

  test("a model POST is attempted once while signature GETs remain retryable", async () => {
    const scope = new NearNetworkScope(1000, new AbortController().signal);
    let calls = 0;
    const send = scope.wrap(async () => { calls++; return new Response("fixture"); });
    try {
      await (await send(NEAR_AI_BASE_URL + "/chat/completions", { method: "POST", body: "{}" })).text();
      await expect(send(NEAR_AI_BASE_URL + "/chat/completions", { method: "POST", body: "{}" })).rejects.toThrow("already attempted");
      await (await send(NEAR_AI_BASE_URL + "/signature/fixture-completion")).text();
      await (await send(NEAR_AI_BASE_URL + "/signature/fixture-completion")).text();
      expect(calls).toBe(3);
    } finally { scope.stop(); }
  });

  test("canceling a stalled response stops its reader", async () => {
    const controller = new AbortController();
    const scope = new NearNetworkScope(1000, controller.signal);
    let canceled = false;
    const send = scope.wrap(async () => new Response(new ReadableStream({ cancel() { canceled = true; } })));
    try {
      const body = (await send(NEAR_AI_BASE_URL + "/signature/fixture")).text();
      controller.abort();
      await expect(body).rejects.toHaveProperty("name", "AbortError");
      expect(canceled).toBe(true);
    } finally { scope.stop(); }
  });

  test("a late response after cancellation is discarded and its body canceled", async () => {
    const controller = new AbortController();
    const scope = new NearNetworkScope(1000, controller.signal);
    const late = defer<Response>();
    let canceled = false;
    try {
      const pending = scope.wrap(() => late.promise)(NEAR_AI_BASE_URL + "/model/fixture");
      controller.abort();
      await expect(pending).rejects.toHaveProperty("name", "AbortError");
      late.resolve(new Response(new ReadableStream({ cancel() { canceled = true; } })));
      await Promise.resolve(); await Promise.resolve();
      expect(canceled).toBe(true);
    } finally { scope.stop(); }
  });
});

test("official Node SDK TLS pinning accepts a trusted matching peer and rejects a mismatched pin under Bun", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paperwork-near-tls-"));
  try {
    const key = join(directory, "fixture-key.pem"), cert = join(directory, "fixture-cert.pem");
    const generated = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert],
    { stdout: "ignore", stderr: "pipe" });
    expect(generated.exitCode).toBe(0);
    // The fixture's CA is trusted only by this isolated child; production TLS settings stay intact.
    const sdk = new URL("../node_modules/@nearai/inference-sdk/dist/node.js", import.meta.url).href;
    const code = `
      import {createHash,X509Certificate} from 'node:crypto';
      import {readFileSync} from 'node:fs';
      import {createPinnedTlsFetch} from ${JSON.stringify(sdk)};
      const cert=readFileSync(${JSON.stringify(cert)});
      const pin=createHash('sha256').update(new X509Certificate(cert).publicKey.export({type:'spki',format:'der'})).digest('hex');
      const server=Bun.serve({hostname:'127.0.0.1',port:0,tls:{key:readFileSync(${JSON.stringify(key)}),cert},fetch:()=>new Response('offline fixture')});
      try {
        const url='https://127.0.0.1:'+server.port+'/';
        const result=await createPinnedTlsFetch(pin)(url,{signal:AbortSignal.timeout(5000)});
        if(await result.text()!=='offline fixture') throw new Error('match failed');
        let rejected=false;
        try{await createPinnedTlsFetch('00'.repeat(32))(url,{signal:AbortSignal.timeout(5000)});}catch{rejected=true;}
        if(!rejected) throw new Error('mismatched TLS pin accepted');
        console.log(JSON.stringify({match:true,mismatch_rejected:true}));
      } finally {server.stop(true);}
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", code], {
      env: { NODE_EXTRA_CA_CERTS: cert }, stdout: "pipe", stderr: "pipe",
    });
    const killTimer = setTimeout(() => child.kill(), 10000);
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    clearTimeout(killTimer);
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ match: true, mismatch_rejected: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15000);
