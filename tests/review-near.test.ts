import { describe, expect, test } from "bun:test";
import type {
  AttestationVerificationResult, VerifiedCompletionResult, VerifiedModelAttestation,
} from "@nearai/inference-sdk/node";
import type { ReviewContext, ReviewResult } from "../src/shared/review";
import { hashCanonical, sha256Hex } from "../src/shared/canonical";
import type { NearChatRequest, NearReviewClient } from "../src/server/review/near-client";
import { reviewWithNear, validateNearReviewConfig, type NearReviewProgress } from "../src/server/review/near";
import { NEAR_AI_BASE_URL, type NearReviewConfig } from "../src/server/review/types";

const CONFIG: NearReviewConfig = {
  backend: "near", url: NEAR_AI_BASE_URL, provider: "near",
  apiKey: "offline-review-only-fixture-key", model: "z-ai/glm-5.3-flash", timeoutMs: 1000,
};
const CONTEXT: ReviewContext = {
  submission_id: "submission-private-1", terms_hash: "terms-private-1", revision: 1,
  scope: [
    { id: "export", title: "CSV export", criteria: "Export date, project and amount." },
    { id: "tests", title: "Acceptance tests", criteria: "Cover empty and populated tables." },
  ],
  report: "The CSV export contains date and project. Empty-table tests still need an example.",
  evidence: [{ deliverable_id: "export", url: "https://evidence.invalid/export", label: "Unverified export demonstration" }],
  invoice: { number: "INV-PRIVATE-1", amount_usd: "100" },
};
const RESULT: ReviewResult = {
  summary: "The report does not confirm the required amount column or the acceptance-test evidence.",
  findings: [
    { deliverable_id: "export", status: "needs_clarification", comment: "Please confirm that the export includes amount.", report_quotes: ["The CSV export contains date and project."], evidence_indices: [0] },
    { deliverable_id: "tests", status: "missing_evidence", comment: "Please supply acceptance-test evidence.", report_quotes: ["Empty-table tests still need an example."], evidence_indices: [] },
  ],
  feedback: "Please confirm the amount column and add evidence covering empty and populated tables.",
};
const ID = "chatcmpl-offline-fixture-1";
const PUBLIC_KEY = "ab".repeat(32);
const HASH = "cd".repeat(32);
const SIGNATURE = "ef".repeat(64);
const SIGNER = { signingAlgo: "ed25519" as const, signingAddress: PUBLIC_KEY };

// These are the already-verified SDK return types, not forged raw quote fixtures.
// This suite exercises the app's trust boundary; near-client.test.ts owns the transport.
function modelAttestation(): VerifiedModelAttestation {
  return {
    signer: { ...SIGNER }, tcbStatus: "UpToDate", advisoryIds: [],
    deployment: { appCompose: "private deployment configuration", runtimeMeasurements: { composeHash: HASH } },
    deploymentProvenance: "not_checked", gpuEvidence: "verified", signingPublicKey: PUBLIC_KEY,
    report: {} as VerifiedModelAttestation["report"],
  };
}
function preflight(): AttestationVerificationResult {
  return {
    verifiedAt: Date.now(), models: [modelAttestation()],
    gateway: {
      signer: { ...SIGNER }, tcbStatus: "UpToDate", advisoryIds: [],
      deployment: { appCompose: "private gateway configuration", runtimeMeasurements: { composeHash: HASH } },
      deploymentProvenance: "not_checked", report: {} as AttestationVerificationResult["gateway"]["report"],
      tlsBinding: { kind: "attested", spkiFingerprint: HASH },
    },
  };
}
function proof(): VerifiedCompletionResult {
  const attestation = modelAttestation();
  return {
    id: ID, completionId: ID, signatureKind: "provider_tee",
    signature: { kind: "provider_tee", signer: { ...SIGNER }, signedText: `${CONFIG.model}:${HASH}:${HASH}`, signature: SIGNATURE },
    attestations: [attestation], attestation,
  };
}
function completion(content: unknown = RESULT): unknown {
  return {
    id: ID, object: "chat.completion", created: 1, model: CONFIG.model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) } }],
  };
}
type Factory = NonNullable<Parameters<typeof reviewWithNear>[3]>;
type Progress = NearReviewProgress;
type Overrides = Partial<Pick<NearReviewClient, "verify" | "complete" | "verifyResponse" | "dispose">>;
function fixture(overrides: Overrides = {}) {
  const calls: string[] = [];
  const requests: NearChatRequest[] = [];
  const configurations: { apiKey: string; timeoutMs: number }[] = [];
  const signals: AbortSignal[] = [];
  let disposed = 0;
  const createClient: Factory = (options, signal) => {
    calls.push("create"); configurations.push(options); signals.push(signal);
    return {
      verify: async model => { calls.push(`verify:${model}`); return overrides.verify ? overrides.verify(model) : preflight(); },
      complete: async request => { calls.push("complete"); requests.push(request); return overrides.complete ? overrides.complete(request) : completion(); },
      verifyResponse: async id => { calls.push(`proof:${id}`); return overrides.verifyResponse ? overrides.verifyResponse(id) : proof(); },
      dispose: () => { calls.push("dispose"); disposed++; overrides.dispose?.(); },
    };
  };
  return { calls, requests, configurations, signals, createClient, get disposed() { return disposed; } };
}
async function collect(
  f: ReturnType<typeof fixture>, options: { config?: NearReviewConfig; context?: ReviewContext; signal?: AbortSignal; seen?: Progress[] } = {},
): Promise<Progress[]> {
  const events = options.seen ?? [];
  for await (const event of reviewWithNear(options.config ?? CONFIG, options.context ?? CONTEXT, options.signal ?? new AbortController().signal, f.createClient)) events.push(event);
  return events;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}
async function failure(operation: Promise<unknown>): Promise<unknown> {
  try { await operation; } catch (error) { return error; }
  throw new Error("Expected the offline review to fail.");
}

describe("Direct NEAR report review (offline verified-SDK fixtures)", () => {
  test("verifies before one scoped inference call and releases only a validated draft", async () => {
    const original = structuredClone(CONTEXT);
    const f = fixture();
    const events = await collect(f);
    expect(events.slice(0, 3)).toEqual([
      { type: "status", stage: "connecting" }, { type: "status", stage: "reviewing" }, { type: "status", stage: "validating" },
    ]);
    expect(events).toHaveLength(4);
    expect(events[3]).toMatchObject({ type: "complete", review: RESULT });
    expect(f.calls).toEqual(["create", `verify:${CONFIG.model}`, "complete", `proof:${ID}`, "dispose"]);
    expect(f.disposed).toBe(1);
    expect(f.configurations).toEqual([{ apiKey: CONFIG.apiKey, timeoutMs: CONFIG.timeoutMs }]);
    expect(f.requests).toHaveLength(1);
    const request = f.requests[0]!;
    expect(request).toMatchObject({ model: CONFIG.model, reasoning_effort: "low", stream: false });
    expect(request.max_tokens).toBeGreaterThan(0);
    expect(request.messages.map(message => message.role)).toEqual(["system", "user"]);
    expect(request.messages[0]!.content).toContain("untrusted data");
    expect(request.messages[0]!.content).toContain("Do not use tools");
    expect(JSON.parse(request.messages[1]!.content)).toEqual(CONTEXT);
    expect(Object.keys(request).sort()).toEqual(["max_tokens", "messages", "model", "reasoning_effort", "stream"]);
    expect(CONTEXT).toEqual(original);
    expect(f.signals[0]!.aborted).toBe(true);
  });

  test("keeps unverified model text private while response verification is pending", async () => {
    const receipt = deferred<VerifiedCompletionResult>();
    const f = fixture({ verifyResponse: () => receipt.promise });
    const seen: Progress[] = [];
    const pending = collect(f, { seen });
    await until(() => f.calls.includes(`proof:${ID}`));
    expect(seen).toEqual([
      { type: "status", stage: "connecting" }, { type: "status", stage: "reviewing" },
    ]);
    expect(JSON.stringify(seen)).not.toContain(RESULT.feedback);
    receipt.resolve(proof());
    expect((await pending).at(-1)).toMatchObject({ type: "complete", review: RESULT });
  });

  test("keeps receipts bounded and excludes source plaintext, credentials and raw deployment configuration", async () => {
    const f = fixture();
    const last = (await collect(f)).at(-1);
    expect(last?.type).toBe("complete");
    if (last?.type !== "complete") throw new Error("No completed fixture review.");
    const serial = JSON.stringify({ verification: last.verification, record: last.record });
    expect(last.record).toMatchObject({
      sdk: { name: "@nearai/inference-sdk", version: "0.3.0" },
      context_sha256: sha256Hex(f.requests[0]!.messages[1]!.content),
      instructions_sha256: sha256Hex(f.requests[0]!.messages[0]!.content),
      claims: { context_hash_source: "application", image_provenance: "not_checked", application_host_attested: false },
    });
    expect(last.verification).toEqual({ backend: "near", model: CONFIG.model, signature_kind: "provider_tee",
      encrypted: true, gateway_tls_bound: true, record_sha256: hashCanonical(last.record) });
    expect(serial).toContain("provider_tee");
    expect(serial.length).toBeLessThan(32 * 1024);
    for (const secret of [CONFIG.apiKey, CONTEXT.report, CONTEXT.submission_id, CONTEXT.invoice.number,
      CONTEXT.scope[0]!.criteria, "private deployment configuration", "private gateway configuration"])
      expect(serial).not.toContain(secret);
  });

  test("creates a fresh review client for each review", async () => {
    const f = fixture();
    await collect(f); await collect(f);
    expect(f.calls.filter(call => call === "create")).toHaveLength(2);
    expect(f.requests).toHaveLength(2);
    expect(f.signals[0]).not.toBe(f.signals[1]);
    expect(f.disposed).toBe(2);
  });

  test("accepts all verified model reports sharing the selected signer", async () => {
    const attestation = preflight();
    const second = modelAttestation();
    Object.assign(second, { deployment: { ...second.deployment, appCompose: "second measured deployment" } });
    Object.assign(attestation, { models: [...attestation.models, second] });
    const receipt = proof();
    if (receipt.signatureKind !== "provider_tee") throw new Error("Invalid fixture.");
    Object.assign(receipt, { attestations: [...receipt.attestations, second] });
    const f = fixture({ verify: async () => attestation, verifyResponse: async () => receipt });
    const last = (await collect(f)).at(-1);
    expect(last?.type).toBe("complete");
    if (last?.type !== "complete") throw new Error("No completed fixture review.");
    expect(last.record.models).toHaveLength(2);
    expect(last.record.models.map(model => model.signer.signingAddress)).toEqual([PUBLIC_KEY, PUBLIC_KEY]);
  });

  test("a factory exception is sanitized before any review request", async () => {
    const seen: Progress[] = [];
    const error = await failure((async () => {
      for await (const event of reviewWithNear(CONFIG, CONTEXT, new AbortController().signal, () => {
        throw new Error(`private factory diagnostic ${CONFIG.apiKey}`);
      })) seen.push(event);
    })());
    expect(String(error)).not.toContain(CONFIG.apiKey);
    expect(String(error)).not.toContain("private factory diagnostic");
    expect(seen).toEqual([{ type: "status", stage: "connecting" }]);
  });

  test.each(["verify", "complete", "verifyResponse"] as const)("fails safely without retries when %s rejects", async stage => {
    const f = fixture({ [stage]: async () => { throw new Error(`private upstream diagnostic ${CONFIG.apiKey} ${CONTEXT.report}`); } });
    const seen: Progress[] = [];
    const error = await failure(collect(f, { seen }));
    const printable = `${String(error)} ${JSON.stringify(error)}`;
    expect(printable).not.toContain(CONFIG.apiKey);
    expect(printable).not.toContain(CONTEXT.report);
    expect(printable).not.toContain("private upstream diagnostic");
    expect(error).toMatchObject({ diagnostics: { signature_verified: false,
      completion_observed: stage === "verifyResponse" } });
    expect(seen.some(event => event?.type === "complete")).toBe(false);
    expect(f.requests.length).toBe(stage === "verify" ? 0 : 1);
    expect(f.disposed).toBe(1);
  });

  test("cleanup diagnostics cannot replace a safe failure or expose unverified plaintext", async () => {
    const f = fixture({
      verifyResponse: async () => { throw new Error(`unverified private response ${CONTEXT.report}`); },
      dispose: () => { throw new Error(`private cleanup diagnostic ${CONFIG.apiKey}`); },
    });
    const seen: Progress[] = [];
    const error = await failure(collect(f, { seen }));
    expect(error).toMatchObject({ code: "verification_failed", diagnostics: { signature_verified: false } });
    const printable = `${String(error)} ${JSON.stringify(error)} ${JSON.stringify(seen)}`;
    expect(printable).not.toContain(CONFIG.apiKey);
    expect(printable).not.toContain(CONTEXT.report);
    expect(printable).not.toContain(RESULT.feedback);
    expect(seen).toEqual([{ type: "status", stage: "connecting" }, { type: "status", stage: "reviewing" }]);
    expect(f.disposed).toBe(1);
  });

  test.each(["gateway TLS binding", "gateway TLS fingerprint", "gateway TCB", "model TCB", "model GPU", "missing model", "invalid model signer"])("rejects unsafe preflight: %s", async reason => {
    const attestation = preflight();
    if (reason === "gateway TLS binding") Object.assign(attestation.gateway, { tlsBinding: { kind: "none" } });
    if (reason === "gateway TLS fingerprint") Object.assign(attestation.gateway, { tlsBinding: { kind: "attested", spkiFingerprint: "not-a-fingerprint" } });
    if (reason === "gateway TCB") Object.assign(attestation.gateway, { tcbStatus: "OutOfDate" });
    if (reason === "model TCB") Object.assign(attestation.models[0]!, { tcbStatus: "OutOfDate" });
    if (reason === "model GPU") Object.assign(attestation.models[0]!, { gpuEvidence: "not_provided" });
    if (reason === "missing model") Object.assign(attestation, { models: [] });
    if (reason === "invalid model signer") Object.assign(attestation.models[0]!, { signer: { ...SIGNER, signingAddress: "not-a-key" } });
    const f = fixture({ verify: async () => attestation });
    await expect(collect(f)).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
    expect(f.disposed).toBe(1);
  });

  test.each(["wrong id", "gateway signature", "wrong signature kind", "different signer", "outdated TCB", "unverified GPU", "no matching evidence", "unsafe second report"])("rejects inadequate response proof: %s", async reason => {
    const receipt = proof();
    if (receipt.signatureKind !== "provider_tee") throw new Error("Invalid fixture.");
    if (reason === "wrong id") Object.assign(receipt, { id: "chatcmpl-other" });
    if (reason === "gateway signature") Object.assign(receipt, { signatureKind: "gateway", signature: { ...receipt.signature, kind: "gateway" } });
    if (reason === "wrong signature kind") Object.assign(receipt.signature, { kind: "gateway" });
    if (reason === "different signer") Object.assign(receipt.signature, { signer: { ...SIGNER, signingAddress: "12".repeat(32) } });
    if (reason === "outdated TCB") Object.assign(receipt.attestations[0]!, { tcbStatus: "OutOfDate" });
    if (reason === "unverified GPU") Object.assign(receipt.attestations[0]!, { gpuEvidence: "not_provided" });
    if (reason === "no matching evidence") Object.assign(receipt, { attestations: [] });
    if (reason === "unsafe second report") Object.assign(receipt, { attestations: [...receipt.attestations, { ...modelAttestation(), gpuEvidence: "not_provided" }] });
    const f = fixture({ verifyResponse: async () => receipt });
    const seen: Progress[] = [];
    await expect(collect(f, { seen })).rejects.toThrow();
    expect(seen.some(event => event?.type === "complete")).toBe(false);
    expect(f.requests).toHaveLength(1);
    expect(f.disposed).toBe(1);
  });

  test.each(["model changed", "truncated", "tool call", "legacy function call", "refusal", "multiple choices", "wrong role", "no content"])("rejects incomplete or expanded model output: %s", async reason => {
    const output = completion() as { model: string; choices: { finish_reason: string; message: Record<string, unknown> }[] };
    if (reason === "model changed") output.model = "another/model";
    if (reason === "truncated") output.choices[0]!.finish_reason = "length";
    if (reason === "tool call") output.choices[0]!.message.tool_calls = [{ id: "tool-1", type: "function", function: { name: "send_payment", arguments: "{}" } }];
    if (reason === "legacy function call") output.choices[0]!.message.function_call = { name: "send_payment", arguments: "{}" };
    if (reason === "refusal") output.choices[0]!.message.refusal = "private model refusal";
    if (reason === "multiple choices") output.choices.push(structuredClone(output.choices[0]!));
    if (reason === "wrong role") output.choices[0]!.message.role = "tool";
    if (reason === "no content") output.choices[0]!.message.content = null;
    const f = fixture({ complete: async () => output });
    await expect(collect(f)).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
    expect(f.disposed).toBe(1);
  });

  test.each(["not JSON", "Markdown", "unknown key", "invented quote", "foreign evidence", "duplicate evidence", "missing deliverable", "duplicate deliverable", "unsupported claim"])("rejects invalid review content: %s", async reason => {
    const result = structuredClone(RESULT);
    if (reason === "unknown key") Object.assign(result, { approve_payment: true });
    if (reason === "invented quote") result.findings[0]!.report_quotes = ["The amount column is definitely included."];
    if (reason === "foreign evidence") result.findings[1]!.evidence_indices = [0];
    if (reason === "duplicate evidence") result.findings[0]!.evidence_indices = [0, 0];
    if (reason === "missing deliverable") result.findings.pop();
    if (reason === "duplicate deliverable") result.findings[1]!.deliverable_id = "export";
    if (reason === "unsupported claim") Object.assign(result.findings[0]!, { status: "supported", report_quotes: [], evidence_indices: [] });
    const content = reason === "not JSON" ? "raw private model text" : reason === "Markdown" ? `\`\`\`json\n${JSON.stringify(result)}\n\`\`\`` : result;
    const f = fixture({ complete: async () => completion(content) });
    const seen: Progress[] = [];
    await expect(collect(f, { seen })).rejects.toThrow();
    expect(seen.some(event => event?.type === "complete")).toBe(false);
    expect(f.disposed).toBe(1);
  });

  test("refuses a UTF-8 context above 192 KiB before disclosure", async () => {
    const f = fixture();
    const context = { ...CONTEXT, report: "é".repeat(96 * 1024) };
    await expect(collect(f, { context })).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
    expect(f.calls.some(call => call.startsWith("verify:"))).toBe(false);
  });

  test("discards UTF-8 model content above 32 KiB", async () => {
    const f = fixture({ complete: async () => completion("é".repeat(16 * 1024 + 1)) });
    const seen: Progress[] = [];
    await expect(collect(f, { seen })).rejects.toThrow();
    expect(seen.some(event => event?.type === "complete")).toBe(false);
    expect(f.disposed).toBe(1);
  });

  test("refuses to release a credential echoed in otherwise valid review output", async () => {
    const result = { ...RESULT, summary: CONFIG.apiKey };
    const f = fixture({ complete: async () => completion(result) });
    const seen: Progress[] = [];
    const error = await failure(collect(f, { seen }));
    expect(String(error)).not.toContain(CONFIG.apiKey);
    expect(JSON.stringify(seen)).not.toContain(CONFIG.apiKey);
    expect(seen.some(event => event.type === "complete")).toBe(false);
    expect(f.disposed).toBe(1);
  });

  test.each(["verify", "complete", "verifyResponse"] as const)("bounds %s even when it ignores cancellation", async stage => {
    const f = fixture({ [stage]: () => new Promise<never>(() => {}) });
    const started = Date.now();
    const seen: Progress[] = [];
    await expect(collect(f, { config: { ...CONFIG, timeoutMs: 25 }, seen })).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(500);
    expect(seen.some(event => event?.type === "complete")).toBe(false);
    expect(f.disposed).toBe(1);
    expect(f.requests.length).toBe(stage === "verify" ? 0 : 1);
  });

  test("a late preflight result cannot send private context after timeout", async () => {
    const attestation = deferred<AttestationVerificationResult>();
    const f = fixture({ verify: () => attestation.promise });
    await expect(collect(f, { config: { ...CONFIG, timeoutMs: 25 } })).rejects.toThrow("timed out");
    attestation.resolve(preflight());
    await Bun.sleep(5);
    expect(f.requests).toHaveLength(0);
    expect(f.disposed).toBe(1);
  });

  test("a late response proof cannot release a draft after timeout", async () => {
    const receipt = deferred<VerifiedCompletionResult>();
    const f = fixture({ verifyResponse: () => receipt.promise });
    const seen: Progress[] = [];
    await expect(collect(f, { config: { ...CONFIG, timeoutMs: 25 }, seen })).rejects.toThrow("timed out");
    receipt.resolve(proof());
    await Bun.sleep(5);
    expect(seen.some(event => event.type === "complete")).toBe(false);
    expect(f.requests).toHaveLength(1);
    expect(f.disposed).toBe(1);
  });

  test.each(["verify", "complete", "verifyResponse"] as const)("external cancellation during %s discards its draft and closes the client", async stage => {
    const controller = new AbortController();
    const f = fixture({ [stage]: async () => {
      queueMicrotask(() => controller.abort(new Error(`private cancellation reason ${CONFIG.apiKey}`)));
      return new Promise<never>(() => {});
    } });
    const seen: Progress[] = [];
    const error = await failure(collect(f, { signal: controller.signal, seen }));
    expect(String(error)).toContain("was stopped");
    expect(String(error)).not.toContain(CONFIG.apiKey);
    expect(seen.some(event => event?.type === "complete")).toBe(false);
    expect(f.disposed).toBe(1);
    expect(f.requests.length).toBe(stage === "verify" ? 0 : 1);
  });

  test("an already cancelled review never reaches the model", async () => {
    const controller = new AbortController(); controller.abort();
    const f = fixture();
    await expect(collect(f, { signal: controller.signal })).rejects.toThrow("was stopped");
    expect(f.requests).toHaveLength(0);
    expect(f.calls.some(call => call.startsWith("verify:"))).toBe(false);
  });

  test("consumer closure after preflight disposes the client without inference", async () => {
    const f = fixture();
    const iterator = reviewWithNear(CONFIG, CONTEXT, new AbortController().signal, f.createClient);
    expect((await iterator.next()).value).toEqual({ type: "status", stage: "connecting" });
    expect((await iterator.next()).value).toEqual({ type: "status", stage: "reviewing" });
    await iterator.return(undefined);
    expect(f.requests).toHaveLength(0);
    expect(f.disposed).toBe(1);
  });
});

describe("NEAR review configuration boundary", () => {
  test("accepts the standard gateway and a scoped model configuration", () => {
    expect(() => validateNearReviewConfig(CONFIG)).not.toThrow();
  });

  test.each([
    { backend: "hermes" }, { provider: "other" },
    { url: "http://cloud-api.near.ai/v1" }, { url: "https://attacker.invalid/v1" },
    { url: `${NEAR_AI_BASE_URL}?key=secret` }, { url: "https://user@cloud-api.near.ai/v1" },
    { apiKey: "" }, { apiKey: "short" }, { apiKey: "key with spaces" }, { apiKey: "private\r\nheader" }, { apiKey: "k".repeat(4097) },
    { model: "" }, { model: "model with spaces" }, { model: "../private" }, { model: "model?key=secret" },
    { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: Number.NaN }, { timeoutMs: Number.POSITIVE_INFINITY }, { timeoutMs: 300_001 },
  ].map((patch, i) => ({ label: `${Object.keys(patch)[0]} case ${i + 1}`, patch })))
  ("rejects unsafe configuration without disclosing values: $label", ({ patch }) => {
    const config = { ...CONFIG, ...patch } as NearReviewConfig;
    let error: unknown;
    try { validateNearReviewConfig(config); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(CONFIG.apiKey);
    if ("apiKey" in patch && patch.apiKey) expect(String(error)).not.toContain(patch.apiKey);
  });
});
