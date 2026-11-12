#!/usr/bin/env -S bun --no-env-file
/**
 * One explicitly authorized, synthetic hosted review; no app runtime or dotenv imports.
 * Run: bun --no-env-file scripts/check-review-live.ts --confirm-hosted
 * Supply all four PAPERWORK_HERMES_{URL,API_KEY,PROVIDER,MODEL} variables explicitly.
 */
import { reviewWithHermes, type HermesReviewConfig, type ReviewFetch } from "../src/server/review/hermes";
import type { ReviewContext, ReviewResult } from "../src/shared/review";

const REVIEW_TIMEOUT_MS = 90_000;
const STATUS_TIMEOUT_MS = 3_000;
const MAX_STATUS_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 16 * 1024;
const SYNTHETIC_REPORT = "SYNTHETIC: The CSV export includes date, project, and amount columns.";

export const SYNTHETIC_REVIEW_CONTEXT: ReviewContext = {
  submission_id: "synthetic-hosted-review-not-a-job",
  terms_hash: "synthetic-no-signed-terms",
  revision: 1,
  scope: [{ id: "synthetic-csv", title: "Synthetic CSV report", criteria: "Describe a CSV export with date, project, and amount columns." }],
  report: SYNTHETIC_REPORT,
  evidence: [{ deliverable_id: "synthetic-csv", url: "https://evidence.invalid/synthetic-review-only", label: "Synthetic unverified reference; no real file" }],
  invoice: { number: "SYNTHETIC-NOT-PAYABLE", amount_usd: "0" },
};

type CheckCode = "confirmation_required" | "invalid_configuration" | "review_failed" | "quote_missing" | "runtime_unverified" | "output_refused";
export class HostedReviewCheckError extends Error {
  constructor(readonly code: CheckCode, readonly diagnostics?: HostedReviewDiagnostics) {
    super(`Hosted synthetic review did not pass (${code}). No retry was attempted.`);
    this.name = "HostedReviewCheckError";
  }
}

/** This deliberately does not load server config, .env files, auth, platform clients or a DB. */
export function hostedReviewConfig(env: Record<string, string | undefined>): HermesReviewConfig {
  const { PAPERWORK_HERMES_URL: endpoint, PAPERWORK_HERMES_API_KEY: apiKey,
    PAPERWORK_HERMES_PROVIDER: provider, PAPERWORK_HERMES_MODEL: model } = env;
  const url = endpoint && URL.canParse(endpoint) ? new URL(endpoint) : null;
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.hostname.includes("*") ||
      (url.pathname !== "/" && !/^\/p\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/?$/.test(url.pathname)) ||
      !apiKey || apiKey.length < 16 || apiKey.length > 4096 || /[\s\x00-\x1f\x7f]/.test(apiKey) ||
      provider !== "custom:near" || !model || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/.test(model) || model.includes("://"))
    throw new HostedReviewCheckError("invalid_configuration");
  return { url: `${url.origin}${url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")}`,
    apiKey, provider, model, timeoutMs: REVIEW_TIMEOUT_MS };
}

interface Calls {
  capabilities: number;
  toolsets: number;
  run_submissions: number;
  event_streams: number;
  run_status_reads: number;
  stop_requests: number;
}

type ReviewOperation = "capabilities" | "toolsets" | "run_submission" | "events" | "run_status";
type ResponseFormat = "json" | "html" | "sse" | "other" | "missing";
interface RequestObservation {
  operation: ReviewOperation;
  http_status?: number;
  response_format?: ResponseFormat;
}

export interface HostedReviewDiagnostics {
  last_request: RequestObservation | null;
  // Attempts are client observations, not proof that the server received a call.
  request_attempts: Calls;
  run_id_observed: boolean;
}

function responseFormat(response: Response): ResponseFormat {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mediaType) return "missing";
  if (mediaType === "application/json" || mediaType.endsWith("+json")) return "json";
  if (mediaType === "text/html") return "html";
  if (mediaType === "text/event-stream") return "sse";
  return "other";
}

interface ServedRuntime {
  provider: "custom";
  model: string;
  route_source: "raw_request";
  requested: { provider: "custom:near"; model: string };
}

export interface HostedReviewReceipt {
  outcome: "pass";
  synthetic: true;
  runtime: ServedRuntime;
  calls: Calls;
  review: ReviewResult;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Bound status fetch and body reads even when a client ignores its AbortSignal. */
async function statusJson(send: ReviewFetch, url: string, apiKey: string): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new HostedReviewCheckError("runtime_unverified")); }, STATUS_TIMEOUT_MS);
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const read = async () => {
    const response = await send(url, { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }, redirect: "error", signal: controller.signal });
    if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new HostedReviewCheckError("runtime_unverified"); }
    if (!response.ok || !response.body) throw new HostedReviewCheckError("runtime_unverified");
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    while (true) {
      const chunk = await reader.read();
      if (controller.signal.aborted) throw new HostedReviewCheckError("runtime_unverified");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STATUS_BYTES) throw new HostedReviewCheckError("runtime_unverified");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  };
  try { return await Promise.race([read(), deadline]); }
  finally {
    clearTimeout(timer!);
    controller.abort();
    // A stalled body must not extend the three-second observation deadline.
    if (reader) void reader.cancel().catch(() => {});
  }
}

/**
 * The v0.23.1 Runs API records the actual served pair in runtime, while top-level
 * model only echoes the request. Named custom providers normalize to "custom".
 * runtime.requested identifies the requested NEAR route; this is not endpoint/TEE
 * attestation. The operator must separately verify that provider's NEAR endpoint.
 * Source: gateway/platforms/api_server_runs.py and api_server.py at v0.23.1.
 */
function verifiedRuntime(value: unknown, runId: string, config: HermesReviewConfig): ServedRuntime {
  const status = record(value);
  const runtime = record(status?.runtime);
  const requested = record(runtime?.requested);
  // Durable status projections may omit completion flags; any flags they do
  // provide must agree with the complete SSE outcome already validated.
  if (status?.run_id !== runId || status.status !== "completed" ||
      (status.completed !== undefined && status.completed !== true) ||
      (status.partial !== undefined && status.partial !== false) ||
      (status.interrupted !== undefined && status.interrupted !== false) ||
      runtime?.provider !== "custom" || runtime.model !== config.model || runtime.route_source !== "raw_request" ||
      requested?.provider !== "custom:near" || requested.model !== config.model)
    throw new HostedReviewCheckError("runtime_unverified");
  return { provider: "custom", model: config.model, route_source: "raw_request", requested: { provider: "custom:near", model: config.model } };
}

/** One admission only. Nothing from upstream errors, token events or transcripts is logged. */
export async function checkHostedReview(config: HermesReviewConfig, send: ReviewFetch = fetch): Promise<HostedReviewReceipt> {
  // Revalidate injected config too, so callers cannot accidentally select another route.
  config = hostedReviewConfig({ PAPERWORK_HERMES_URL: config.url, PAPERWORK_HERMES_API_KEY: config.apiKey,
    PAPERWORK_HERMES_PROVIDER: config.provider, PAPERWORK_HERMES_MODEL: config.model });
  const calls: Calls = { capabilities: 0, toolsets: 0, run_submissions: 0, event_streams: 0, run_status_reads: 0, stop_requests: 0 };
  const base = config.url;
  let runId: string | undefined;
  let lastRequest: RequestObservation | null = null;
  const observedSend: ReviewFetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    let operation: ReviewOperation | null = null;
    if (url === `${base}/v1/capabilities` && method === "GET") { calls.capabilities++; operation = "capabilities"; }
    else if (url === `${base}/v1/toolsets` && method === "GET") { calls.toolsets++; operation = "toolsets"; }
    else if (url === `${base}/v1/runs` && method === "POST") {
      if (++calls.run_submissions > 1) throw new HostedReviewCheckError("review_failed");
      operation = "run_submission";
    } else {
      const suffix = url.startsWith(`${base}/v1/runs/`) ? url.slice(`${base}/v1/runs/`.length) : "";
      const eventRun = /^(run_[A-Za-z0-9_-]{1,160})\/events$/.exec(suffix)?.[1];
      if (eventRun && method === "GET" && !runId) { runId = eventRun; calls.event_streams++; operation = "events"; }
      else if (runId && suffix === runId && method === "GET") { calls.run_status_reads++; operation = "run_status"; }
      else if (/^run_[A-Za-z0-9_-]{1,160}\/stop$/.test(suffix) && method === "POST") calls.stop_requests++;
      else throw new HostedReviewCheckError("review_failed");
    }
    // Cleanup must not replace evidence about the request that failed.
    const observation: RequestObservation | null = operation ? { operation } : null;
    if (observation) lastRequest = observation;
    // Observe a preflight redirect as an HTTP refusal instead of losing its
    // status to fetch's redirect error. Never follow it or forward the key.
    // Run admission, streams, status and cleanup retain redirect: "error".
    const response = await send(input, operation === "capabilities" || operation === "toolsets"
      ? { ...init, redirect: "manual" } : init);
    if (observation) {
      if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599)
        observation.http_status = response.status;
      observation.response_format = responseFormat(response);
    }
    return response;
  };
  let review: ReviewResult | undefined;
  try {
    for await (const progress of reviewWithHermes(config, structuredClone(SYNTHETIC_REVIEW_CONTEXT), new AbortController().signal, observedSend))
      if (progress.type === "complete") review = progress.review;
    if (!review || !runId) throw new HostedReviewCheckError("review_failed");
    // Existing transport already checks every quote as an exact report substring.
    if (!review.findings.some((finding) => finding.report_quotes.length > 0))
      throw new HostedReviewCheckError("quote_missing");
    const runtime = verifiedRuntime(await statusJson(observedSend, `${base}/v1/runs/${runId}`, config.apiKey), runId, config);
    const receipt: HostedReviewReceipt = { outcome: "pass", synthetic: true, runtime, calls, review };
    const output = JSON.stringify(receipt);
    // Compare JSON representations so quotes/backslashes cannot hide an echoed credential.
    const serializedKey = JSON.stringify(config.apiKey).slice(1, -1);
    if (new TextEncoder().encode(output).byteLength > MAX_RECEIPT_BYTES || output.includes(serializedKey) || output.includes(config.url))
      throw new HostedReviewCheckError("output_refused");
    return receipt;
  } catch (error) {
    const diagnostics: HostedReviewDiagnostics = {
      last_request: structuredClone(lastRequest),
      request_attempts: { ...calls }, run_id_observed: !!runId,
    };
    throw new HostedReviewCheckError(error instanceof HostedReviewCheckError ? error.code : "review_failed", diagnostics);
  } finally { runId = undefined; }
}

if (import.meta.main) {
  try {
    if (process.argv.slice(2).length !== 1 || process.argv[2] !== "--confirm-hosted") throw new HostedReviewCheckError("confirmation_required");
    console.log(JSON.stringify(await checkHostedReview(hostedReviewConfig(process.env)), null, 2));
  } catch (error) {
    // Never stringify arbitrary errors: HTTP libraries may put credentials in them.
    const safe = error instanceof HostedReviewCheckError ? error : new HostedReviewCheckError("review_failed");
    console.error(JSON.stringify({ outcome: "fail", code: safe.code, message: safe.message,
      ...(safe.diagnostics ? { diagnostics: safe.diagnostics } : {}) }));
    process.exitCode = 1;
  }
}
