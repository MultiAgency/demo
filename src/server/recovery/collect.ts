import { createHash } from "node:crypto";
import type { z } from "zod";
import { canonicalJson } from "../../shared/canonical";
import type { LedgerInspection } from "./inspect";
import {
  recoveryBindingSchema, recoveryIdSchema as id, payoutEvidenceSchema as payout, paymentEvidenceSchema as payment,
  heldEvidenceSchema as held, ownerEvidenceSchema as owner, readResultSchema,
  type EvidenceCollection, type Observation, type ReadResult, type RecoveryBinding, type RecoveryReader,
} from "./evidence";

export class RecoveryCollectionError extends Error {
  constructor(readonly code: "invalid_binding" | "unsupported_ledger" | "invalid_options") {
    super("Recovery collection could not proceed; no repair or payment was authorized.");
    this.name = "RecoveryCollectionError";
  }
}

export const evidenceDigest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
function safeResult<T>(raw: unknown, value: z.ZodType<T>): ReadResult<T> {
  const parsed = readResultSchema(value).safeParse(raw);
  return parsed.success ? parsed.data as ReadResult<T> : { ok: false, kind: "invalid_response", response_sha256: null };
}

/** Validate the entire selected scope before constructing a reader or making any external request. */
export function parseRecoveryBinding(inspection: LedgerInspection, input: unknown): RecoveryBinding {
  const parsed = recoveryBindingSchema.safeParse(input);
  if (!parsed.success) throw new RecoveryCollectionError("invalid_binding");
  const b = parsed.data;
  const jobs = inspection.jobs.filter(job => job.id === b.contract_id);
  const job = jobs[0];
  if (jobs.length !== 1 || !job || inspection.snapshot.sha256 !== b.snapshot_sha256 || inspection.deployment !== b.deployment ||
      job.terms_hash !== b.terms_hash || job.organization !== b.organization || job.agent?.name !== b.agent || job.agent.id !== b.agent_id ||
      ![2, 3].includes(job.terms_version ?? 0)) throw new RecoveryCollectionError("invalid_binding");
  const attempts = inspection.attempts.filter(attempt => attempt.contract_id === b.contract_id && attempt.kind === "payout");
  const requests = new Set(attempts.map(attempt => attempt.request_id));
  const correlations = attempts.flatMap(attempt => attempt.payout_correlation_id === null ? [] : [attempt.payout_correlation_id]);
  const owners = inspection.owner_steps.filter(step => step.contract_id === b.contract_id || (step.contract_id === null && step.organization === b.organization));
  if (!attempts.length || attempts.length > 200 || owners.length > 200 || requests.size !== attempts.length || new Set(correlations).size !== correlations.length ||
      attempts.some(attempt => !/^[A-Za-z0-9_-]{1,64}$/.test(attempt.request_id) ||
        (attempt.payout_correlation_id !== null && !id.safeParse(attempt.payout_correlation_id).success) ||
        (attempt.approval_id !== null && !id.safeParse(attempt.approval_id).success)) ||
      owners.some(step => !id.safeParse(step.correlation_id).success || step.organization !== b.organization) ||
      inspection.findings.some(finding => ["deployment_unbound", "request_conflict", "invalid_record"].includes(finding.code) &&
        (!finding.contract_id || finding.contract_id === b.contract_id || (finding.request_id !== undefined && requests.has(finding.request_id)))))
    throw new RecoveryCollectionError("unsupported_ledger");
  return b;
}

/** One bounded observational pass. No runtime, migration, retry, signing or money submission is reachable here. */
export async function collectRecoveryEvidence(
  inspection: LedgerInspection, input: unknown, reader: RecoveryReader,
  options: { now?: () => Date; maxDurationMs?: number; readTimeoutMs?: number } = {},
): Promise<EvidenceCollection> {
  const binding = parseRecoveryBinding(inspection, input);
  if (reader.origin !== binding.platform_origin || reader.deployment !== binding.deployment ||
      !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(reader.sdk_version)) throw new RecoveryCollectionError("invalid_binding");
  const duration = options.maxDurationMs ?? 30_000, readTimeout = options.readTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 120_000 || !Number.isSafeInteger(readTimeout) || readTimeout < 1 || readTimeout > 10_000)
    throw new RecoveryCollectionError("invalid_options");
  const now = options.now ?? (() => new Date());
  const started_at = now().toISOString(), deadline = performance.now() + duration;
  async function observe<T>(target_id: string | null, schema: z.ZodType<T>, read: (signal: AbortSignal) => Promise<ReadResult<T>>): Promise<Observation<T>> {
    const started_at = now().toISOString();
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { target_id, started_at, completed_at: now().toISOString(), result: { ok: false, kind: "collection_budget", response_sha256: null } };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const limit = Math.max(1, Math.min(readTimeout, Math.ceil(remaining)));
      const timeout = new Promise<ReadResult<T>>(resolve => { timer = setTimeout(() => {
        controller.abort(); resolve({ ok: false, kind: "timeout", response_sha256: null });
      }, limit); });
      const result = safeResult(await Promise.race([Promise.resolve().then(() => read(controller.signal)), timeout]), schema);
      return { target_id, started_at, completed_at: now().toISOString(), result };
    } catch {
      return { target_id, started_at, completed_at: now().toISOString(), result: { ok: false, kind: "unavailable", response_sha256: null } };
    } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  }
  const attempts = inspection.attempts.filter(attempt => attempt.contract_id === binding.contract_id && attempt.kind === "payout");
  const payouts: EvidenceCollection["payouts"] = [];
  const paymentIds = new Set(attempts.flatMap(attempt => attempt.payout_correlation_id === null ? [] : [attempt.payout_correlation_id]));
  for (const attempt of attempts) {
    const observation = await observe(attempt.request_id, payout, signal => reader.payoutStatus(binding, attempt.request_id, signal));
    payouts.push(observation);
    if (observation.result.ok && observation.result.value.request_id === attempt.request_id && attempt.payout_correlation_id === null && observation.result.value.correlation_id !== null)
      paymentIds.add(observation.result.value.correlation_id);
  }
  const payments: EvidenceCollection["payments"] = [];
  for (const correlation of paymentIds) payments.push(await observe(correlation, payment, signal => reader.paymentStatus(binding, correlation, signal)));
  const owners: EvidenceCollection["owners"] = [];
  for (const step of inspection.owner_steps.filter(step => step.contract_id === binding.contract_id || (step.contract_id === null && step.organization === binding.organization)))
    owners.push(await observe(step.correlation_id, owner, signal => reader.ownerStatus(binding, step.correlation_id, signal)));
  const allHeld = await observe(null, held, signal => reader.held(binding, signal));
  const matchedHeld = allHeld.result.ok ? allHeld.result.value.filter(item => paymentIds.has(item.correlation_id)) : [];
  const heldObservation = allHeld.result.ok ? { ...allHeld, result: { ...allHeld.result, value: matchedHeld } } : allHeld;
  return {
    schema_version: 1, binding, binding_sha256: evidenceDigest(binding), snapshot: { ...inspection.snapshot }, sdk_version: reader.sdk_version,
    started_at, completed_at: now().toISOString(), payouts, payments, owners, held: heldObservation,
    unmatched_held_count: allHeld.result.ok ? allHeld.result.value.length - matchedHeld.length : null,
    complete: [...payouts, ...payments, ...owners, heldObservation].every(observation => observation.result.ok), clearance: "none",
    limitations: [
      "One observational pass; no repair, payment, signing or permission to resume is produced.",
      "The original origin, deployment and agent binding are operator-declared provenance, not independently attested by these reads.",
      "Response SHA-256 values identify received HTTP bytes, not platform signatures or snapshot freshness.",
      "Only allowlisted original-request fields are retained; signed terms and signatures require separate verification.",
      "Unmatched held records are counted without exposing them or inferring a payment association.",
    ],
  };
}
