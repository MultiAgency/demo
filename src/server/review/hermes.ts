import { z } from "zod";
import type { ReviewContext, ReviewProgress } from "../../shared/review";
import { ReviewError as HermesReviewError, REVIEW_INSTRUCTIONS, validateReviewResult } from "./common";
export { ReviewError as HermesReviewError, validateReviewResult } from "./common";

export interface HermesReviewConfig {
  url: string;
  apiKey: string;
  timeoutMs: number;
  model: string;
  provider: string;
}

export type ReviewFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_INPUT_BYTES = 192 * 1024;
const STOP_TIMEOUT_MS = 1500;

function interrupted(signal: AbortSignal): HermesReviewError {
  return new HermesReviewError(signal.reason instanceof Error && signal.reason.name === "TimeoutError"
    ? "The review timed out. No feedback draft was applied."
    : "The review was stopped. No feedback draft was applied.");
}

/** Abort bounds remain effective even when an HTTP client or body reader ignores its signal. */
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(interrupted(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(interrupted(signal));
    signal.addEventListener("abort", abort, { once: true });
    operation.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

async function readText(response: Response, signal: AbortSignal, limit = MAX_RESPONSE_BYTES): Promise<string> {
  if (!response.body) throw new HermesReviewError("Hermes returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await bounded(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new HermesReviewError("Hermes returned more review data than supported.");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    // Do not await cancellation: a broken upstream may also ignore cancellation.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function jsonResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok) throw new HermesReviewError("Hermes could not complete the review. Check the review service configuration.");
  try {
    return JSON.parse(await readText(response, signal));
  } catch (error) {
    if (error instanceof HermesReviewError) throw error;
    throw new HermesReviewError("Hermes returned an unreadable response.");
  }
}

const capabilitiesSchema = z.object({
  auth: z.object({ required: z.literal(true) }),
  features: z.object({ run_submission: z.literal(true), run_events_sse: z.literal(true), run_stop: z.literal(true) }),
});
const toolsetsSchema = z.object({
  object: z.literal("list"),
  platform: z.literal("api_server"),
  data: z.array(z.object({ name: z.string(), enabled: z.boolean(), tools: z.array(z.string()) })).max(500),
});
const runSchema = z.object({ run_id: z.string().regex(/^run_[A-Za-z0-9_-]{1,160}$/), status: z.enum(["started", "queued", "running", "completed"]) });

/** Discovery is a compatibility check, not attestation of plugins, MCP or memory isolation. */
async function requireReadOnlyProfile(request: (path: string, init?: RequestInit) => Promise<Response>, signal: AbortSignal): Promise<void> {
  const capabilities = capabilitiesSchema.safeParse(await jsonResponse(await request("/v1/capabilities"), signal));
  if (!capabilities.success) throw new HermesReviewError("The Hermes review profile does not support authenticated review streaming and cancellation.");
  const toolsets = toolsetsSchema.safeParse(await jsonResponse(await request("/v1/toolsets"), signal));
  if (!toolsets.success || toolsets.data.data.some((toolset) => toolset.enabled))
    throw new HermesReviewError("Use a dedicated Hermes review profile with all API toolsets disabled.");
}

interface HermesEvent {
  event: string;
  run_id: string;
  [key: string]: unknown;
}

/** Hermes frames are data-only SSE with event names inside JSON, unlike AG-UI events. */
async function* runEvents(response: Response, signal: AbortSignal): AsyncGenerator<HermesEvent> {
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") || !response.body)
    throw new HermesReviewError("Hermes did not open a review event stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let buffer = "";
  try {
    while (true) {
      const chunk = await bounded(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new HermesReviewError("Hermes returned more review data than supported.");
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue; // keepalives, ids and named-event fields carry no review output
        let event: unknown;
        try { event = JSON.parse(data); }
        catch { throw new HermesReviewError("Hermes returned an unreadable review event."); }
        if (!event || typeof event !== "object" || typeof (event as HermesEvent).event !== "string" || typeof (event as HermesEvent).run_id !== "string")
          throw new HermesReviewError("Hermes returned an unsupported review event.");
        yield event as HermesEvent;
      }
    }
    decoder.decode();
    if (buffer.trim() && !buffer.trim().startsWith(":")) throw new HermesReviewError("The review stream ended before its last event was complete.");
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Stateless, read-only review: each admission has fresh opaque session and request identities. */
export async function* reviewWithHermes(config: HermesReviewConfig, context: ReviewContext, signal: AbortSignal, send: ReviewFetch = fetch): AsyncGenerator<ReviewProgress> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(() => controller.abort(new DOMException("Review deadline exceeded", "TimeoutError")), config.timeoutMs);
  let runId: string | null = null;
  let completed = false;
  const base = config.url.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", accept: "application/json" };
  const request = (path: string, init: RequestInit = {}) => bounded(send(`${base}${path}`, {
    ...init, headers: { ...headers, ...init.headers }, redirect: "error", signal: controller.signal,
  }), controller.signal);
  try {
    if (controller.signal.aborted) throw interrupted(controller.signal);
    yield { type: "status", stage: "connecting" };
    const input = JSON.stringify(context);
    if (new TextEncoder().encode(input).byteLength > MAX_INPUT_BYTES) throw new HermesReviewError("This submission is too large for a review draft.");
    await requireReadOnlyProfile(request, controller.signal);
    const session = `paperwork-review-${crypto.randomUUID()}`;
    const admission = runSchema.safeParse(await jsonResponse(await request("/v1/runs", {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID(), "X-Hermes-Session-Key": session },
      body: JSON.stringify({ input, instructions: REVIEW_INSTRUCTIONS, session_id: session, provider: config.provider, model: config.model }),
    }), controller.signal));
    if (!admission.success) throw new HermesReviewError("Hermes did not return a supported review run.");
    runId = admission.data.run_id;
    yield { type: "status", stage: "reviewing" };
    const response = await request(`/v1/runs/${encodeURIComponent(runId)}/events`, { headers: { accept: "text/event-stream" } });
    for await (const event of runEvents(response, controller.signal)) {
      if (event.run_id !== runId) throw new HermesReviewError("Hermes returned an event for a different review.");
      if (event.event.startsWith("tool.") || event.event.startsWith("approval.") || event.event.startsWith("clarify.") || event.event.startsWith("subagent."))
        throw new HermesReviewError("The review profile attempted a tool or approval action. Disable its tools before trying again.");
      if (["run.failed", "run.cancelled", "run.interrupted", "run.unknown", "replay.truncated"].includes(event.event))
        throw new HermesReviewError("Hermes did not finish this review. No feedback draft was applied.");
      if (event.event !== "run.completed") continue; // no unvalidated model commentary or reasoning leaves the server
      if (event.completed !== true || event.partial !== false || event.interrupted !== false || typeof event.output !== "string" || new TextEncoder().encode(event.output).byteLength > MAX_OUTPUT_BYTES)
        throw new HermesReviewError("Hermes did not return a complete review draft.");
      yield { type: "status", stage: "validating" };
      let value: unknown;
      try { value = JSON.parse(event.output); }
      catch { throw new HermesReviewError("The review did not return a JSON feedback draft."); }
      const review = validateReviewResult(value, context);
      if (controller.signal.aborted) throw interrupted(controller.signal);
      completed = true;
      yield { type: "complete", review };
      return;
    }
    throw new HermesReviewError("Hermes disconnected before completing the review. No feedback draft was applied.");
  } catch (error) {
    if (controller.signal.aborted) throw interrupted(controller.signal);
    if (error instanceof HermesReviewError) throw error;
    throw new HermesReviewError("The Hermes review service is unavailable. No feedback draft was applied.");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    controller.abort();
    if (runId && !completed) {
      // Stop only this admitted run. A stop request is best effort and makes no execution claim.
      const stopSignal = AbortSignal.timeout(STOP_TIMEOUT_MS);
      await bounded(send(`${base}/v1/runs/${encodeURIComponent(runId)}/stop`, {
        method: "POST", headers, body: "{}", redirect: "error", signal: stopSignal,
      }), stopSignal).catch(() => {});
    }
  }
}
