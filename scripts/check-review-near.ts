#!/usr/bin/env -S bun --no-env-file
/**
 * Manual synthetic-only check of direct NEAR inference. No app, dotenv, DB,
 * platform client or real submission is imported. Exactly one model attempt.
 * Run: bun --no-env-file scripts/check-review-near.ts --confirm-hosted
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, hashCanonical } from "../src/shared/canonical";
import type { ReviewContext, ReviewResult, ReviewVerification } from "../src/shared/review";
import { NearReviewError, reviewWithNear, validateNearReviewConfig,
  type NearReviewClientFactory, type NearReviewDiagnostics, type NearReviewRecord } from "../src/server/review/near";
import { DEFAULT_REVIEW_MODEL, NEAR_AI_BASE_URL, type NearReviewConfig } from "../src/server/review/types";
import { containsReviewSecret } from "../src/server/review/common";

export const SYNTHETIC_NEAR_REVIEW_CONTEXT: ReviewContext = {
  submission_id: "synthetic-near-review-not-a-job", terms_hash: "synthetic-no-signed-terms", revision: 1,
  scope: [{ id: "synthetic-csv", title: "Synthetic CSV export", criteria: "The CSV export must contain date, project, and amount columns." }],
  report: "SYNTHETIC: The CSV export contains date and project.", evidence: [],
  invoice: { number: "SYNTHETIC-NOT-PAYABLE", amount_usd: "0" },
};
type LiveCode = "confirmation_required" | "invalid_configuration" | "synthetic_expectation_failed" | "check_failed";
const LIVE_MESSAGES: Record<LiveCode, string> = {
  confirmation_required: "Use --confirm-hosted to authorize one synthetic NEAR review.",
  invalid_configuration: "Set PAPERWORK_REVIEW_NEARAI_API_KEY securely; the model must be a canonical NEAR model ID.",
  synthetic_expectation_failed: "The verified model response did not identify the missing amount column with an exact report quote. No retry was attempted.",
  check_failed: "The synthetic NEAR review did not pass. No retry was attempted.",
};
export class NearLiveCheckError extends Error {
  constructor(readonly code: LiveCode) { super(LIVE_MESSAGES[code]); this.name = "NearLiveCheckError"; }
}

export function nearLiveConfig(env: Record<string, string | undefined>): NearReviewConfig {
  try {
    const config = validateNearReviewConfig({ backend: "near", url: NEAR_AI_BASE_URL, provider: "near",
      apiKey: env.PAPERWORK_REVIEW_NEARAI_API_KEY ?? "", model: env.PAPERWORK_REVIEW_MODEL || DEFAULT_REVIEW_MODEL,
      timeoutMs: Number(env.PAPERWORK_REVIEW_TIMEOUT_MS ?? 120_000) });
    if (config.timeoutMs < 1000) throw new NearLiveCheckError("invalid_configuration");
    return config;
  } catch { throw new NearLiveCheckError("invalid_configuration"); }
}

export interface NearLiveReceipt {
  outcome: "pass";
  synthetic: true;
  inference_attempts: 1;
  verification: ReviewVerification;
  review: ReviewResult;
  record: NearReviewRecord;
}

/** Offline tests inject a fake client; the default performs the one explicitly authorized model call. */
export async function checkNearReview(config: NearReviewConfig, createClient?: NearReviewClientFactory): Promise<NearLiveReceipt> {
  let result: NearLiveReceipt | undefined;
  for await (const progress of reviewWithNear(config, structuredClone(SYNTHETIC_NEAR_REVIEW_CONTEXT), new AbortController().signal, createClient)) {
    if (progress.type !== "complete") continue;
    const finding = progress.review.findings[0];
    if (!finding || finding.status === "supported" || !finding.report_quotes.length ||
        !/\bamount\b/i.test([progress.review.summary, finding.comment, progress.review.feedback].join(" ")))
      throw new NearLiveCheckError("synthetic_expectation_failed");
    result = { outcome: "pass", synthetic: true, inference_attempts: 1,
      verification: progress.verification, review: progress.review, record: progress.record };
  }
  if (!result) throw new NearLiveCheckError("check_failed");
  const serialized = JSON.stringify(result);
  if (new TextEncoder().encode(serialized).byteLength > 64 * 1024 || containsReviewSecret(result, config.apiKey) ||
      hashCanonical(result.record) !== result.verification.record_sha256)
    throw new NearLiveCheckError("check_failed");
  return result;
}

export function safeNearCheckFailure(error: unknown): {
  outcome: "fail"; code: string; message: string; diagnostics?: NearReviewDiagnostics;
} {
  if (error instanceof NearReviewError) return { outcome: "fail", code: error.code, message: error.message,
    ...(error.diagnostics && { diagnostics: error.diagnostics }) };
  const safe = error instanceof NearLiveCheckError ? error : new NearLiveCheckError("check_failed");
  return { outcome: "fail", code: safe.code, message: safe.message };
}

if (import.meta.main) {
  try {
    if (process.argv.slice(2).length !== 1 || process.argv[2] !== "--confirm-hosted") throw new NearLiveCheckError("confirmation_required");
    const result = await checkNearReview(nearLiveConfig(process.env));
    const artifacts = await mkdtemp(join(tmpdir(), "paperwork-near-review-"));
    const recordPath = join(artifacts, "verification-record.json");
    await writeFile(recordPath, canonicalJson(result.record) + "\n", { mode: 0o600 });
    // The record is a summary of SDK checks, not a portable quote-verification bundle.
    console.log(JSON.stringify({ ...result, record: undefined, verification_record: recordPath }, null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeNearCheckFailure(error)));
    process.exitCode = 1;
  }
}
