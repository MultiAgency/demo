import type { AttestationVerificationResult, VerifiedCompletionResult } from "@nearai/inference-sdk/node";
import { z } from "zod";
import { canonicalJson, hashCanonical, sha256Hex } from "../../shared/canonical";
import type { ReviewContext, ReviewProgress, ReviewResult, ReviewVerification } from "../../shared/review";
import { ReviewError, REVIEW_INSTRUCTIONS, containsReviewSecret, reviewAwait, validateReviewResult } from "./common";
import { createNearReviewClient, type NearReviewClient } from "./near-client";
import { NEAR_AI_BASE_URL, type NearReviewConfig } from "./types";

const MAX_INPUT_BYTES = 192 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_RECORD_BYTES = 32 * 1024;
const hex = (length: number) => z.string().regex(new RegExp("^(?:0x)?[a-fA-F0-9]{" + length + "}$"))
  .transform(value => value.replace(/^0x/i, "").toLowerCase());
const signerSchema = z.object({ signingAlgo: z.literal("ed25519"), signingAddress: hex(64) });
const signatureSchema = z.object({ kind: z.literal("provider_tee"), signer: signerSchema,
  signedText: z.string().min(1).max(1000), signature: hex(128) });
const completionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/), object: z.literal("chat.completion"),
  model: z.string().min(1).max(200),
  choices: z.array(z.object({ index: z.literal(0), finish_reason: z.literal("stop"), message: z.object({
    role: z.literal("assistant"), content: z.string().min(1), refusal: z.null().optional(),
    tool_calls: z.array(z.never()).max(0).optional(), function_call: z.null().optional(),
  }) })).length(1),
});

type NearCode = "invalid_configuration" | "input_too_large" | "attestation_failed" | "completion_failed" |
  "completion_invalid" | "verification_failed" | "review_invalid" | "output_refused" | "cancelled" | "timeout";
type NearStage = "configuration" | "input" | "attestation" | "inference" | "verification" | "validation" | "record" | "complete";
const MESSAGES: Record<NearCode, string> = {
  invalid_configuration: "The NEAR review service configuration is invalid.",
  input_too_large: "This submission is too large for a review draft.",
  attestation_failed: "NEAR deployment verification did not pass. No review prompt was sent.",
  completion_failed: "The NEAR review request did not finish. No automatic retry was attempted.",
  completion_invalid: "NEAR did not return a complete review response. No draft was applied.",
  verification_failed: "The model response signature could not be verified. No draft was applied.",
  review_invalid: "The review did not pass its format and source checks. No draft was applied.",
  output_refused: "The review output could not be released. No draft was applied.",
  cancelled: "The review was stopped. No feedback draft was applied.",
  timeout: "The review timed out. No feedback draft was applied.",
};
export interface NearReviewDiagnostics {
  stage: NearStage;
  /** Attempts are client observations; a lost inference response does not establish nonexecution. */
  attempts: { deployment_verifications: number; completions: number; response_verifications: number };
  completion_observed: boolean;
  signature_verified: boolean;
}
export class NearReviewError extends ReviewError {
  constructor(readonly code: NearCode, readonly diagnostics?: NearReviewDiagnostics) {
    super(MESSAGES[code]); this.name = "NearReviewError";
  }
}
export type NearReviewClientFactory = (options: { apiKey: string; timeoutMs: number }, signal: AbortSignal) => NearReviewClient;

/** A bounded record of SDK verification, not an independently portable attestation bundle. */
export interface NearReviewRecord {
  schema: "paperwork.near-review-verification/v1";
  sdk: { name: "@nearai/inference-sdk"; version: "0.3.0" };
  model: string;
  completion_id: string;
  context_sha256: string;
  instructions_sha256: string;
  gateway: { tcb_status: "UpToDate"; tls_spki_fingerprint: string };
  models: { signer: z.infer<typeof signerSchema>; tcb_status: "UpToDate"; gpu_evidence: "verified"; compose_sha256: string }[];
  signature: z.infer<typeof signatureSchema>;
  claims: { context_hash_source: "application"; image_provenance: "not_checked"; application_host_attested: false };
}
export type NearReviewProgress = Exclude<ReviewProgress, { type: "complete" }> |
  { type: "complete"; review: ReviewResult; verification: ReviewVerification; record: NearReviewRecord };

export function validateNearReviewConfig(config: NearReviewConfig): NearReviewConfig {
  if (config.backend !== "near" || config.url !== NEAR_AI_BASE_URL || config.provider !== "near" ||
      typeof config.apiKey !== "string" || config.apiKey.length < 16 || config.apiKey.length > 4096 || /[\s\x00-\x1f\x7f]/.test(config.apiKey) ||
      typeof config.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/.test(config.model) || config.model.includes("://") ||
      !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 300_000)
    throw new NearReviewError("invalid_configuration");
  return config;
}

function checkDeployment(value: AttestationVerificationResult): void {
  if (value?.gateway?.tlsBinding?.kind !== "attested" || value.gateway.tcbStatus !== "UpToDate" ||
      !hex(64).safeParse(value.gateway.tlsBinding.spkiFingerprint).success ||
      !Array.isArray(value.models) || !value.models.length || value.models.length > 32 ||
      value.models.some(model => model.tcbStatus !== "UpToDate" || model.gpuEvidence !== "verified" || !signerSchema.safeParse(model.signer).success))
    throw new NearReviewError("attestation_failed");
}

function verificationRecord(preflight: AttestationVerificationResult, proof: VerifiedCompletionResult,
  id: string, model: string, input: string): NearReviewRecord {
  if (proof.signatureKind !== "provider_tee" || proof.id !== id || !Array.isArray(proof.attestations) || !proof.attestations.length)
    throw new NearReviewError("verification_failed");
  const signature = signatureSchema.safeParse(proof.signature);
  if (!signature.success || !preflight.models.some(candidate => {
    const signer = signerSchema.safeParse(candidate.signer);
    return signer.success && signer.data.signingAddress === signature.data.signer.signingAddress;
  })) throw new NearReviewError("verification_failed");
  const models = proof.attestations.map(candidate => {
    const signer = signerSchema.safeParse(candidate.signer);
    if (!signer.success || signer.data.signingAddress !== signature.data.signer.signingAddress ||
        candidate.tcbStatus !== "UpToDate" || candidate.gpuEvidence !== "verified" || typeof candidate.deployment?.appCompose !== "string")
      throw new NearReviewError("verification_failed");
    return { signer: signer.data, tcb_status: "UpToDate" as const, gpu_evidence: "verified" as const,
      compose_sha256: sha256Hex(candidate.deployment.appCompose) };
  });
  if (models.length > 32 || preflight.gateway.tlsBinding.kind !== "attested") throw new NearReviewError("verification_failed");
  const fingerprint = hex(64).safeParse(preflight.gateway.tlsBinding.spkiFingerprint);
  if (!fingerprint.success) throw new NearReviewError("verification_failed");
  return {
    schema: "paperwork.near-review-verification/v1", sdk: { name: "@nearai/inference-sdk", version: "0.3.0" },
    model, completion_id: id, context_sha256: sha256Hex(input), instructions_sha256: sha256Hex(REVIEW_INSTRUCTIONS),
    gateway: { tcb_status: "UpToDate", tls_spki_fingerprint: fingerprint.data }, models, signature: signature.data,
    claims: { context_hash_source: "application", image_provenance: "not_checked", application_host_attested: false },
  };
}

/** One isolated, tool-free E2EE Chat request. Nothing from the model is released before SDK signature verification. */
export async function* reviewWithNear(config: NearReviewConfig, context: ReviewContext, signal: AbortSignal,
  createClient: NearReviewClientFactory = createNearReviewClient): AsyncGenerator<NearReviewProgress> {
  validateNearReviewConfig(config);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => controller.abort(new DOMException("Review deadline exceeded", "TimeoutError")), config.timeoutMs);
  const attempts = { deployment_verifications: 0, completions: 0, response_verifications: 0 };
  let stage: NearStage = "input", client: NearReviewClient | undefined, completionObserved = false, signatureVerified = false;
  try {
    if (controller.signal.aborted) throw new NearReviewError("cancelled");
    const input = canonicalJson(context);
    if (new TextEncoder().encode(input).byteLength > MAX_INPUT_BYTES) throw new NearReviewError("input_too_large");
    yield { type: "status", stage: "connecting" };
    if (controller.signal.aborted) throw new NearReviewError("cancelled");
    client = createClient({ apiKey: config.apiKey, timeoutMs: config.timeoutMs }, controller.signal);
    const activeClient = client;
    stage = "attestation";
    const preflight = await reviewAwait(() => { attempts.deployment_verifications++; return activeClient.verify(config.model); }, controller.signal);
    checkDeployment(preflight);
    yield { type: "status", stage: "reviewing" };
    stage = "inference";
    const value = await reviewAwait(() => {
      attempts.completions++;
      return activeClient.complete({ model: config.model, stream: false, max_tokens: 4096, reasoning_effort: "low",
        messages: [{ role: "system", content: REVIEW_INSTRUCTIONS }, { role: "user", content: input }] });
    }, controller.signal);
    const parsed = completionSchema.safeParse(value);
    if (!parsed.success || parsed.data.model !== config.model) throw new NearReviewError("completion_invalid");
    completionObserved = true;
    const completion = parsed.data;
    const text = completion.choices[0]!.message.content;
    if (new TextEncoder().encode(text).byteLength > MAX_OUTPUT_BYTES) throw new NearReviewError("completion_invalid");
    stage = "verification";
    const proof = await reviewAwait(() => { attempts.response_verifications++; return activeClient.verifyResponse(completion.id); }, controller.signal);
    if (proof.signatureKind !== "provider_tee" || proof.id !== completion.id) throw new NearReviewError("verification_failed");
    const record = verificationRecord(preflight, proof, completion.id, config.model, input);
    signatureVerified = true;
    yield { type: "status", stage: "validating" };
    stage = "validation";
    let result: unknown;
    try { result = JSON.parse(text); }
    catch { throw new NearReviewError("review_invalid"); }
    let review: ReviewResult;
    try { review = validateReviewResult(result, context); }
    catch { throw new NearReviewError("review_invalid"); }
    stage = "record";
    if (new TextEncoder().encode(canonicalJson(record)).byteLength > MAX_RECORD_BYTES || containsReviewSecret({ review, record }, config.apiKey))
      throw new NearReviewError("output_refused");
    const verification: ReviewVerification = { backend: "near", model: config.model, signature_kind: "provider_tee",
      encrypted: true, gateway_tls_bound: true, record_sha256: hashCanonical(record) };
    if (controller.signal.aborted) throw new NearReviewError("cancelled");
    stage = "complete";
    yield { type: "complete", review, verification, record };
  } catch (error) {
    const code: NearCode = controller.signal.aborted
      ? controller.signal.reason instanceof Error && controller.signal.reason.name === "TimeoutError" ? "timeout" : "cancelled"
      : error instanceof NearReviewError ? error.code
      : stage === "attestation" ? "attestation_failed" : stage === "verification" ? "verification_failed"
      : stage === "inference" ? "completion_failed" : stage === "validation" ? "review_invalid" : "output_refused";
    throw new NearReviewError(code, { stage, attempts: { ...attempts }, completion_observed: completionObserved, signature_verified: signatureVerified });
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort();
    try { client?.dispose(); } catch { /* Cleanup cannot expose an upstream exception or replace the primary result. */ }
  }
}
