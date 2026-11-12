import { appClient, contractPackage } from "@multiagency/sdk";
import { createHash } from "node:crypto";
import {
  recoveryBindingSchema, type HeldEvidence, type OwnerEvidence, type PaymentEvidence, type PayoutEvidence,
  type ReadFailure, type ReadResult, type RecoveryBinding, type RecoveryReader, type RequestEvidence,
} from "./evidence";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_HELD = 500;
const MAX_CREDENTIAL_BYTES = 8 * 1024;
const FAILURES = new Set<ReadFailure>(["session", "forbidden", "refused", "unresolved", "busy", "rate_limited", "unavailable", "unknown", "provider"]);
const PAYOUT_STATES = new Set(["succeeded", "failed", "held", "processing", "refused", "unknown", "not_found"]);
const OWNER_STAGES = new Set(["submitted", "submitting", "expired", "failed", "voting", "unknown"]);
const OWNER_PHASES = new Set(["open", "submitted", "settled", "expired"]);
type Procedure = "payouts/status" | "paymentStatus" | "held" | "owner/status";

class ReadError extends Error {
  constructor(readonly kind: ReadFailure) { super("The recovery read could not be completed."); }
}

function originOf(value: string): string {
  try {
    const url = new URL(value);
    if (url.origin === value && !url.username && !url.password && !url.hostname.includes("*") &&
        (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) return value;
  } catch { /* Use a fixed diagnostic, never caller-supplied origins or credentials. */ }
  throw new Error("Recovery reads require one HTTPS origin or an explicit loopback HTTP origin.");
}

function id(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && /^[A-Za-z0-9._:@-]+$/.test(value) && value !== "." && value !== "..";
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReadError("invalid_response");
  return value as Record<string, unknown>;
}

/** Only the known withdrawal-request fields are retained; extra provider fields are never serialized. */
function requestEvidence(value: unknown): RequestEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.recipient !== "string" || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(row.recipient) ||
      typeof row.asset !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(row.asset) ||
      typeof row.amount !== "string" || !/^[1-9][0-9]{0,39}$/.test(row.amount) ||
      typeof row.chain !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(row.chain) || typeof row.confidential !== "boolean" ||
      (row.memo !== undefined && row.memo !== null && typeof row.memo !== "string")) return null;
  return { recipient: row.recipient, asset: row.asset, amount: row.amount, chain: row.chain, confidential: row.confidential, has_memo: row.memo !== undefined && row.memo !== null };
}

function status(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) throw new ReadError("invalid_response");
  return value;
}

function nullableId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!id(value)) throw new ReadError("invalid_response");
  return value;
}

function payoutEvidence(value: unknown, requestId: string): PayoutEvidence {
  const row = object(value);
  if (row.requestId !== requestId || !PAYOUT_STATES.has(String(row.state)) ||
      (row.neverExecuted !== undefined && typeof row.neverExecuted !== "boolean")) throw new ReadError("invalid_response");
  return {
    request_id: requestId, state: row.state as PayoutEvidence["state"],
    status: row.status === null ? null : status(row.status), correlation_id: nullableId(row.correlationId),
    never_executed: row.neverExecuted === undefined ? null : row.neverExecuted as boolean,
  };
}

function paymentEvidence(value: unknown): PaymentEvidence {
  const row = object(value), evidence = object(row.evidence);
  const refunded = evidence.refundedAmount;
  if (refunded !== null && (typeof refunded !== "string" || !/^\d{1,256}$/.test(refunded))) throw new ReadError("invalid_response");
  return {
    status: status(row.status), approval_id: nullableId(row.approvalId), tx_hash: nullableId(evidence.txHash),
    destination_tx_hash: nullableId(evidence.destinationTxHash), refund_tx_hash: nullableId(evidence.refundTxHash),
    refunded_amount: refunded as string | null, request: requestEvidence(row.request),
  };
}

function heldEvidence(value: unknown): HeldEvidence[] {
  if (!Array.isArray(value)) throw new ReadError("invalid_response");
  if (value.length > MAX_HELD) throw new ReadError("oversized_response");
  return value.map(item => {
    const row = object(item);
    if (!id(row.correlationId) || !id(row.approvalId)) throw new ReadError("invalid_response");
    return { correlation_id: row.correlationId, approval_id: row.approvalId, request: requestEvidence(row.request) };
  });
}

function ownerEvidence(value: unknown): OwnerEvidence {
  const row = object(value);
  if (!OWNER_STAGES.has(String(row.stage)) || (row.phase !== undefined && !OWNER_PHASES.has(String(row.phase)))) throw new ReadError("invalid_response");
  return { stage: row.stage as string, phase: row.phase === undefined ? null : row.phase as OwnerEvidence["phase"], status: row.status === undefined ? null : status(row.status) };
}

/** Four SDK reads with a per-call transport boundary; no application runtime, database or mutation methods. */
export function createRecoveryReader(options: {
  origin: string;
  deployment: string;
  credential: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): RecoveryReader {
  const origin = originOf(options.origin), deployment = options.deployment, credential = options.credential;
  // The SDK accepts an opaque credential. Bound the header value; its private token format belongs to the platform.
  if (!id(deployment) || typeof credential !== "string" || credential.length > MAX_CREDENTIAL_BYTES || !/^[\x21-\x7e]+$/.test(credential))
    throw new Error("Recovery reads require a valid deployment and server app credential.");
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
    throw new Error("Recovery read timeout must be an integer between 1 and 10000 milliseconds.");
  const send = options.fetch ?? globalThis.fetch;

  async function read<T>(binding: RecoveryBinding, procedure: Procedure, input: { requestId: string } | { correlationId: string; waitMs?: number } | undefined,
    project: (value: unknown) => T, signal?: AbortSignal): Promise<ReadResult<T>> {
    let responseHash: string | null = null;
    let transportFailure: ReadFailure | null = null;
    const failed = (kind: ReadFailure): ReadResult<T> => ({ ok: false, kind, response_sha256: responseHash });
    const parsed = recoveryBindingSchema.safeParse(binding);
    if (!parsed.success || parsed.data.platform_origin !== origin || parsed.data.deployment !== deployment ||
        ![parsed.data.deployment, parsed.data.contract_id, parsed.data.organization, parsed.data.agent, parsed.data.agent_id].every(id) ||
        (input && "requestId" in input && (typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId))) ||
        (input && "correlationId" in input && !id(input.correlationId))) return failed("invalid_response");
    if (signal?.aborted) return failed("unavailable");
    const selected = parsed.data;
    const url = `${origin}/apps/v1/o/${encodeURIComponent(selected.organization)}/a/${encodeURIComponent(selected.agent)}/rpc/${procedure}`;
    const body = input === undefined ? undefined : JSON.stringify({ json: input });
    const controller = new AbortController();
    let rejectCancelled: (error: ReadError) => void = () => {};
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    const cancel = (kind: ReadFailure) => {
      transportFailure ??= kind;
      controller.abort();
      rejectCancelled(new ReadError(kind));
    };
    const externalAbort = () => cancel("unavailable");
    signal?.addEventListener("abort", externalAbort, { once: true });
    const timer = setTimeout(() => cancel("timeout"), timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let fetches = 0;
    const boundedFetch = (async (target: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      try {
        const targetUrl = target instanceof Request ? target.url : String(target);
        if (++fetches !== 1 || targetUrl !== url || init?.method !== "POST" || init.body !== body ||
            new Headers(init.headers).get("authorization") !== `Bearer ${credential}`) throw new ReadError("invalid_response");
        if (controller.signal.aborted) throw new ReadError(transportFailure ?? "unavailable");
        const response = await send(target, { method: "POST", body, redirect: "error", credentials: "omit", cache: "no-store",
          headers: { authorization: `Bearer ${credential}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) }, signal: controller.signal });
        if (controller.signal.aborted) throw new ReadError(transportFailure ?? "unavailable");
        if (response.redirected || (response.url && response.url !== url)) throw new ReadError("invalid_response");
        if (response.status >= 300 && response.status < 400) throw new ReadError("invalid_response");
        const length = response.headers.get("content-length");
        if (length !== null && /^\d+$/.test(length) && BigInt(length) > BigInt(MAX_BODY_BYTES)) throw new ReadError("oversized_response");
        if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new ReadError("invalid_response");
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        reader = response.body?.getReader();
        if (reader) for (;;) {
          const chunk = await reader.read();
          if (controller.signal.aborted) throw new ReadError(transportFailure ?? "unavailable");
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_BODY_BYTES) throw new ReadError("oversized_response");
          chunks.push(chunk.value);
        }
        const raw = Buffer.concat(chunks, bytes);
        responseHash = createHash("sha256").update(raw).digest("hex");
        return new Response(raw.length ? raw : null, { status: response.status, headers: { "content-type": "application/json" } });
      } catch (error) {
        transportFailure ??= error instanceof ReadError ? error.kind : "unavailable";
        throw new ReadError(transportFailure);
      }
    }) as typeof fetch;

    try {
      const client = appClient({ base: origin as `https://${string}` | `http://${string}`, credential, fetch: boundedFetch }).agent(selected.organization, selected.agent);
      const result = await Promise.race([client.call(procedure, input, { signal: controller.signal }), cancelled]);
      if (transportFailure) return failed(transportFailure);
      if (!result.ok) return failed(FAILURES.has(result.kind) ? result.kind : "unavailable");
      const value = project(result.value);
      if (JSON.stringify(value).includes(credential)) return failed("invalid_response");
      return { ok: true, value, response_sha256: responseHash };
    } catch (error) {
      return failed(transportFailure ?? (error instanceof ReadError ? error.kind : "invalid_response"));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", externalAbort);
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
  }

  return {
    origin, deployment, sdk_version: contractPackage.version,
    payoutStatus: (binding, requestId, signal) => read(binding, "payouts/status", { requestId }, value => payoutEvidence(value, requestId), signal),
    paymentStatus: (binding, correlationId, signal) => read(binding, "paymentStatus", { correlationId, waitMs: 0 }, paymentEvidence, signal),
    held: (binding, signal) => read(binding, "held", undefined, heldEvidence, signal),
    ownerStatus: (binding, correlationId, signal) => read(binding, "owner/status", { correlationId }, ownerEvidence, signal),
  };
}
