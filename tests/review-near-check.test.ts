import { describe, expect, test } from "bun:test";
import type { AttestationVerificationResult, VerifiedCompletionResult, VerifiedModelAttestation } from "@nearai/inference-sdk/node";
import {
  checkNearReview, nearLiveConfig, NearLiveCheckError, safeNearCheckFailure, SYNTHETIC_NEAR_REVIEW_CONTEXT,
} from "../scripts/check-review-near";
import { hashCanonical } from "../src/shared/canonical";
import type { ReviewResult } from "../src/shared/review";
import { NearReviewError, type NearReviewClientFactory } from "../src/server/review/near";
import type { NearChatRequest } from "../src/server/review/near-client";
import { DEFAULT_REVIEW_MODEL, NEAR_AI_BASE_URL } from "../src/server/review/types";

const KEY = "offline-synthetic-review-fixture-key";
const ENV = { PAPERWORK_REVIEW_NEARAI_API_KEY: KEY };
const ID = "chatcmpl-synthetic-offline-1";
const PUBLIC_KEY = "ab".repeat(32), HASH = "cd".repeat(32);
const SIGNER = { signingAlgo: "ed25519" as const, signingAddress: PUBLIC_KEY };
const RESULT: ReviewResult = {
  summary: "The synthetic report does not confirm the required amount column.",
  findings: [{ deliverable_id: "synthetic-csv", status: "needs_clarification",
    comment: "Please confirm the missing amount column.", report_quotes: ["The CSV export contains date and project."], evidence_indices: [] }],
  feedback: "Please confirm that the export also contains amount.",
};

function modelAttestation(): VerifiedModelAttestation {
  return {
    signer: { ...SIGNER }, tcbStatus: "UpToDate", advisoryIds: [], gpuEvidence: "verified", signingPublicKey: PUBLIC_KEY,
    deployment: { appCompose: "offline measured deployment", runtimeMeasurements: { composeHash: HASH } },
    deploymentProvenance: "not_checked", report: {} as VerifiedModelAttestation["report"],
  };
}
function fixture(options: { result?: ReviewResult; failAt?: "attestation" | "inference" | "verification"; key?: string } = {}) {
  const config = nearLiveConfig({ ...ENV, PAPERWORK_REVIEW_NEARAI_API_KEY: options.key ?? KEY });
  const calls: string[] = [], requests: NearChatRequest[] = [];
  let disposed = 0;
  const fault = () => new Error(`private upstream diagnostic ${config.apiKey}`);
  const createClient: NearReviewClientFactory = () => ({
    verify: async () => {
      calls.push("attestation");
      if (options.failAt === "attestation") throw fault();
      return {
        verifiedAt: Date.now(), models: [modelAttestation()],
        gateway: { signer: { ...SIGNER }, tcbStatus: "UpToDate", advisoryIds: [],
          deployment: { appCompose: "offline gateway deployment", runtimeMeasurements: { composeHash: HASH } },
          deploymentProvenance: "not_checked", tlsBinding: { kind: "attested", spkiFingerprint: HASH },
          report: {} as AttestationVerificationResult["gateway"]["report"] },
      };
    },
    complete: async request => {
      calls.push("inference"); requests.push(request);
      if (options.failAt === "inference") throw fault();
      return { id: ID, object: "chat.completion", model: config.model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(options.result ?? RESULT) } }] };
    },
    verifyResponse: async id => {
      calls.push(`verification:${id}`);
      if (options.failAt === "verification") throw fault();
      const attestation = modelAttestation();
      return { id, completionId: id, signatureKind: "provider_tee",
        signature: { kind: "provider_tee", signer: { ...SIGNER }, signedText: `${config.model}:${HASH}:${HASH}`, signature: "ef".repeat(64) },
        attestations: [attestation], attestation } satisfies VerifiedCompletionResult;
    },
    dispose: () => { disposed++; },
  });
  return { config, createClient, calls, requests, get disposed() { return disposed; } };
}
async function failure(operation: Promise<unknown>): Promise<unknown> {
  try { await operation; } catch (error) { return error; }
  throw new Error("Expected the offline synthetic check to fail.");
}

describe("manual direct NEAR check (offline fixtures only)", () => {
  test("the CLI requires explicit confirmation before reading configuration or starting inference", async () => {
    // No confirmation flag is ever passed by this suite; this process cannot run a model.
    const command = [process.execPath, "--no-env-file", "scripts/check-review-near.ts"];
    const proc = Bun.spawn(command, { cwd: new URL("..", import.meta.url).pathname,
      env: {}, stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toEqual({ outcome: "fail", code: "confirmation_required",
      message: "Use --confirm-hosted to authorize one synthetic NEAR review." });
  });

  test("uses a separate review credential and fixed gateway while defaulting the model", () => {
    expect(nearLiveConfig(ENV)).toEqual({ backend: "near", url: NEAR_AI_BASE_URL, apiKey: KEY,
      model: DEFAULT_REVIEW_MODEL, provider: "near", timeoutMs: 120_000 });
    expect(nearLiveConfig({ ...ENV, PAPERWORK_REVIEW_MODEL: "vendor/synthetic-model", PAPERWORK_REVIEW_TIMEOUT_MS: "2500",
      PAPERWORK_HERMES_URL: "https://attacker.invalid", NEARAI_BASE_URL: "https://attacker.invalid" }))
      .toMatchObject({ url: NEAR_AI_BASE_URL, model: "vendor/synthetic-model", timeoutMs: 2500 });
    for (const env of [{}, { NEARAI_API_KEY: KEY }, { PAPERWORK_HERMES_API_KEY: KEY }])
      expect(() => nearLiveConfig(env)).toThrow(NearLiveCheckError);
  });

  test("invalid key, model and timeout values produce only safe configuration errors", () => {
    for (const patch of [
      { PAPERWORK_REVIEW_NEARAI_API_KEY: "private\r\nheader" },
      { PAPERWORK_REVIEW_MODEL: "https://private.invalid/?secret=value" },
      { PAPERWORK_REVIEW_TIMEOUT_MS: "NaN" }, { PAPERWORK_REVIEW_TIMEOUT_MS: "0" },
      { PAPERWORK_REVIEW_TIMEOUT_MS: "999" }, { PAPERWORK_REVIEW_TIMEOUT_MS: "300001" },
    ]) {
      let error: unknown;
      try { nearLiveConfig({ ...ENV, ...patch }); } catch (caught) { error = caught; }
      expect(safeNearCheckFailure(error)).toMatchObject({ outcome: "fail", code: "invalid_configuration" });
      expect(JSON.stringify(safeNearCheckFailure(error))).not.toContain(KEY);
      expect(JSON.stringify(safeNearCheckFailure(error))).not.toContain("private.invalid");
    }
  });

  test("submits the fixed unpaid synthetic amount-column task once and returns linked verification", async () => {
    const original = structuredClone(SYNTHETIC_NEAR_REVIEW_CONTEXT);
    const f = fixture();
    const receipt = await checkNearReview(f.config, f.createClient);
    expect(receipt).toMatchObject({ outcome: "pass", synthetic: true, inference_attempts: 1, review: RESULT,
      verification: { backend: "near", model: DEFAULT_REVIEW_MODEL, signature_kind: "provider_tee", encrypted: true, gateway_tls_bound: true } });
    expect(f.calls).toEqual(["attestation", "inference", `verification:${ID}`]);
    expect(f.requests).toHaveLength(1);
    const context = JSON.parse(f.requests[0]!.messages[1]!.content);
    expect(context).toEqual(SYNTHETIC_NEAR_REVIEW_CONTEXT);
    expect(context.invoice).toEqual({ number: "SYNTHETIC-NOT-PAYABLE", amount_usd: "0" });
    expect(context.scope[0].criteria).toContain("date, project, and amount");
    expect(context.report).not.toContain("amount");
    expect(context.evidence).toEqual([]);
    expect(f.requests[0]!.messages[0]!.content).toContain("no authority");
    expect(receipt.verification.record_sha256).toBe(hashCanonical(receipt.record));
    expect(JSON.stringify(receipt)).not.toContain(KEY);
    expect(f.disposed).toBe(1);
    expect(SYNTHETIC_NEAR_REVIEW_CONTEXT).toEqual(original);
  });

  test("accepts missing-evidence findings when they identify amount and quote the actual report", async () => {
    const result = structuredClone(RESULT); result.findings[0]!.status = "missing_evidence";
    const f = fixture({ result });
    expect((await checkNearReview(f.config, f.createClient)).review).toEqual(result);
    expect(f.requests).toHaveLength(1);
  });

  test.each(["claims support", "no quote", "no amount finding"])("refuses a verified but insufficient synthetic answer: %s", async reason => {
    const result = structuredClone(RESULT);
    if (reason === "claims support") result.findings[0]!.status = "supported";
    if (reason === "no quote") result.findings[0]!.report_quotes = [];
    if (reason === "no amount finding") {
      result.summary = "Further details are needed.";
      result.findings[0]!.comment = "Please clarify the export.";
      result.feedback = "Please clarify the export.";
    }
    const f = fixture({ result });
    const error = await failure(checkNearReview(f.config, f.createClient));
    expect(safeNearCheckFailure(error)).toMatchObject({ outcome: "fail", code: "synthetic_expectation_failed" });
    expect(f.requests).toHaveLength(1);
    expect(f.calls).toEqual(["attestation", "inference", `verification:${ID}`]);
    expect(f.disposed).toBe(1);
  });

  test("an invented quote cannot satisfy the synthetic quality check", async () => {
    const result = structuredClone(RESULT);
    result.findings[0]!.report_quotes = ["The amount column was omitted."];
    const f = fixture({ result });
    expect(safeNearCheckFailure(await failure(checkNearReview(f.config, f.createClient))))
      .toMatchObject({ outcome: "fail", code: "review_invalid", diagnostics: { signature_verified: true } });
    expect(f.requests).toHaveLength(1);
    expect(f.disposed).toBe(1);
  });

  test.each(["attestation", "inference", "verification"] as const)("never retries %s failures and prints no raw provider diagnostics", async failAt => {
    const f = fixture({ failAt });
    const output = safeNearCheckFailure(await failure(checkNearReview(f.config, f.createClient)));
    expect(output).toMatchObject({ outcome: "fail", diagnostics: { signature_verified: false,
      attempts: { completions: failAt === "attestation" ? 0 : 1 } } });
    expect(JSON.stringify(output)).not.toContain(KEY);
    expect(JSON.stringify(output)).not.toContain("private upstream diagnostic");
    expect(JSON.stringify(output)).not.toContain(RESULT.feedback);
    expect(f.requests.length).toBe(failAt === "attestation" ? 0 : 1);
    expect(f.disposed).toBe(1);
  });

  test("unknown exceptions and values map to a fixed printable failure", () => {
    const expected = { outcome: "fail", code: "check_failed", message: "The synthetic NEAR review did not pass. No retry was attempted." } as const;
    for (const error of [new Error(`private ${KEY}`), { message: KEY, diagnostics: KEY }, KEY, null])
      expect(safeNearCheckFailure(error)).toEqual(expected);
    const known = new NearReviewError("verification_failed", { stage: "verification",
      attempts: { deployment_verifications: 1, completions: 1, response_verifications: 1 }, completion_observed: true, signature_verified: false });
    expect(safeNearCheckFailure(known)).toEqual({ outcome: "fail", code: "verification_failed", message: known.message, diagnostics: known.diagnostics });
  });

  test("JSON escaping cannot conceal a credential echoed in the verified answer", async () => {
    for (const punctuation of ['"', "\\", '"\\']) {
      const key = `offline-synthetic${punctuation}not-a-live-key`;
      const result = { ...RESULT, summary: `The missing amount column needs clarification. ${key}` };
      const f = fixture({ result, key });
      const error = await failure(checkNearReview(f.config, f.createClient));
      expect(safeNearCheckFailure(error)).toMatchObject({ outcome: "fail", code: "output_refused" });
      expect(JSON.stringify(safeNearCheckFailure(error))).not.toContain(key);
      expect(f.requests).toHaveLength(1);
      expect(f.disposed).toBe(1);
    }
  });
});
