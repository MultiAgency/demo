import { z } from "zod";
import { hashCanonical } from "../../shared/canonical";
import { USDC_NEAR } from "../../shared/terms";
import { parseRecoveryBinding } from "./collect";
import { digestSchema, heldEvidenceSchema, observationSchema, ownerEvidenceSchema, paymentEvidenceSchema, payoutEvidenceSchema, recoveryBindingSchema,
  type EvidenceCollection, type HeldEvidence, type Observation, type OwnerEvidence, type PaymentEvidence, type PayoutEvidence, type ReadResult, type RequestEvidence } from "./evidence";
import type { LedgerInspection } from "./inspect";

export class RecoveryPreviewError extends Error {
  readonly code = "invalid_evidence";
  constructor() {
    super("Recovery evidence does not match the selected snapshot and read scope; no correction was authorized.");
    this.name = "RecoveryPreviewError";
  }
}

export type RecoveryCategory = "non_execution_reported" | "payment_reported" | "retain_commitment" | "contradictory" | "possible_duplicate";
type Attempt = LedgerInspection["attempts"][number];
type Finding = LedgerInspection["findings"][number];

export interface RecoveryPreview {
  schema_version: 1;
  snapshot_sha256: string;
  binding_sha256: string;
  collection_sha256: string;
  contract_id: string;
  clearance: "none";
  requires_review: true;
  requires_fresh_evidence: true;
  items: {
    request_id: string;
    category: RecoveryCategory;
    reason_codes: string[];
    review_note: string;
    stored: Pick<Attempt, "state" | "resolution" | "never_executed" | "recipient" | "amount_atomic" | "payout_correlation_id" | "approval_id" | "tx_hash" | "refund_tx_hash" | "refunded_amount">;
    reported: { payout: ReadResult<PayoutEvidence>; payment: ReadResult<PaymentEvidence> | null };
    same_obligation_request_ids: string[];
    other_same_job_request_ids: string[];
  }[];
  owner_observations: Observation<OwnerEvidence>[];
  held_observation: Observation<HeldEvidence[]>;
  unmatched_held_count: number | null;
  ledger_findings: Finding[];
  accounting: {
    /** Selected request targets with any payout/payment success claim, including excluded reports. */
    all_reported_success_request_ids: string[];
    payment_reported_request_ids: string[];
    excluded_success_request_ids: string[];
    /** Local amounts for matched status reports only; neither net settlement nor a complete paid total. */
    matched_status_report_subtotal_atomic: string;
    possible_duplicate_groups: string[][];
    historically_released_request_ids: string[];
  };
  limitations: string[];
}

const collectionSchema = z.strictObject({
  schema_version: z.literal(1), binding: recoveryBindingSchema, binding_sha256: digestSchema,
  snapshot: z.strictObject({ sha256: digestSchema, bytes: z.number().int().positive().max(64 * 1024 * 1024) }),
  sdk_version: z.string().max(128).regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
  started_at: z.iso.datetime(), completed_at: z.iso.datetime(),
  payouts: z.array(observationSchema(payoutEvidenceSchema)).max(200), payments: z.array(observationSchema(paymentEvidenceSchema)).max(400),
  owners: z.array(observationSchema(ownerEvidenceSchema)).max(200), held: observationSchema(heldEvidenceSchema),
  unmatched_held_count: z.number().int().nonnegative().max(500).nullable(), complete: z.boolean(), clearance: z.literal("none"),
  limitations: z.array(z.string().max(1024)).max(50),
});

function exactCoverage<T>(rows: Observation<T>[], expected: Set<string>): Map<string, Observation<T>> {
  const map = new Map<string, Observation<T>>();
  for (const row of rows) {
    if (row.target_id === null || !expected.has(row.target_id) || map.has(row.target_id)) throw new RecoveryPreviewError();
    map.set(row.target_id, row);
  }
  if (map.size !== expected.size) throw new RecoveryPreviewError();
  return map;
}
const valueOf = <T>(result: ReadResult<T> | undefined): T | null => result?.ok ? result.value : null;
const uncertainProviderStatus = (status: string | null) => status === null || ["UNKNOWN", "UNCERTAIN", "NEEDS_REVIEW"].includes(status);
const refundEvidence = (row: { refund_tx_hash: string | null; refunded_amount: string | null }) =>
  row.refund_tx_hash !== null || row.refunded_amount !== null;
const counterevidence = (row: { tx_hash: string | null; refund_tx_hash: string | null; refunded_amount: string | null }) =>
  row.tx_hash !== null || refundEvidence(row);
function requestMatches(attempt: Attempt, request: RequestEvidence): boolean {
  return request.recipient === attempt.recipient && request.amount === attempt.amount_atomic && request.asset === USDC_NEAR &&
    request.chain === "near" && request.confidential === true && request.has_memo === false;
}
const ownerSettled = (value: OwnerEvidence | null) => value !== null &&
  ((value.phase === "settled" && ((value.stage === "submitted" && value.status === "SUCCESS") ||
    (value.stage === "failed" && ["FAILED", "REFUNDED"].includes(value.status ?? "")))) ||
    (value.phase === "expired" && value.stage === "expired" && value.status === null));
const historicalRelease = (attempt: Attempt) => attempt.state === "rejected" || (attempt.state === "failed" && ["reowe", "rejected"].includes(attempt.resolution ?? ""));

/** A pure, review-only comparison. A report is never a release decision or an import payload. */
export function previewRecovery(inspection: LedgerInspection, input: EvidenceCollection): RecoveryPreview {
  try { return preview(inspection, input); }
  catch { throw new RecoveryPreviewError(); }
}

function preview(inspection: LedgerInspection, input: EvidenceCollection): RecoveryPreview {
  // Parsing also strips no fields: unknown fields are refused rather than echoed into the report.
  const collection = collectionSchema.parse(input) as EvidenceCollection;
  const binding = parseRecoveryBinding(inspection, collection.binding);
  if (inspection.schema_version !== 1 || collection.binding_sha256 !== hashCanonical(binding) ||
      collection.snapshot.sha256 !== inspection.snapshot.sha256 || collection.snapshot.bytes !== inspection.snapshot.bytes ||
      collection.snapshot.sha256 !== binding.snapshot_sha256 || collection.held.target_id !== null) throw new RecoveryPreviewError();
  const allObservations = [...collection.payouts, ...collection.payments, ...collection.owners, collection.held];
  if (collection.complete !== allObservations.every(row => row.result.ok) ||
      (collection.held.result.ok ? collection.unmatched_held_count === null : collection.unmatched_held_count !== null) ||
      Date.parse(collection.started_at) > Date.parse(collection.completed_at) || allObservations.some(row =>
        Date.parse(row.started_at) > Date.parse(row.completed_at) || Date.parse(row.started_at) < Date.parse(collection.started_at) ||
        Date.parse(row.completed_at) > Date.parse(collection.completed_at))) throw new RecoveryPreviewError();
  const attempts = inspection.attempts.filter(attempt => attempt.contract_id === binding.contract_id && attempt.kind === "payout");
  const payoutReads = exactCoverage(collection.payouts, new Set(attempts.map(attempt => attempt.request_id)));
  const paymentIds = new Set(attempts.flatMap(attempt => attempt.payout_correlation_id === null ? [] : [attempt.payout_correlation_id]));
  for (const attempt of attempts) {
    const payout = valueOf(payoutReads.get(attempt.request_id)?.result);
    if (attempt.payout_correlation_id === null && payout?.request_id === attempt.request_id && payout.correlation_id !== null) paymentIds.add(payout.correlation_id);
  }
  const effectiveCorrelations = attempts.map(attempt => {
    const payout = valueOf(payoutReads.get(attempt.request_id)?.result);
    return attempt.payout_correlation_id ?? (payout?.request_id === attempt.request_id ? payout.correlation_id : null);
  }).filter((correlation): correlation is string => correlation !== null);
  if (new Set(effectiveCorrelations).size !== effectiveCorrelations.length) throw new RecoveryPreviewError();
  const paymentReads = exactCoverage(collection.payments, paymentIds);
  const relevantOwners = inspection.owner_steps.filter(step => step.contract_id === binding.contract_id || (step.contract_id === null && step.organization === binding.organization));
  exactCoverage(collection.owners, new Set(relevantOwners.map(step => step.correlation_id)));
  const held = valueOf(collection.held.result) ?? [];
  if (held.some(row => !paymentIds.has(row.correlation_id)) || new Set(held.map(row => row.correlation_id)).size !== held.length) throw new RecoveryPreviewError();
  const requestIds = new Set(attempts.map(attempt => attempt.request_id));
  const findings = inspection.findings.filter(finding => !finding.contract_id || finding.contract_id === binding.contract_id || (finding.request_id !== undefined && requestIds.has(finding.request_id)));
  const structuralFindings = findings.some(finding => !["unproven_budget_release", "recorded_release_requires_verification", "contradictory_non_execution"].includes(finding.code));
  const globalBlockers: string[] = [];
  if (!collection.complete) globalBlockers.push("incomplete_observation");
  if (structuralFindings) globalBlockers.push("ledger_fields_require_verification");
  if (!collection.held.result.ok) globalBlockers.push("held_read_unavailable");
  if (collection.unmatched_held_count !== 0) globalBlockers.push("unmatched_held_records");
  if (relevantOwners.some(step => step.contract_id === null)) globalBlockers.push("unbound_owner_step_requires_review");
  if (collection.owners.some(row => !ownerSettled(valueOf(row.result)))) globalBlockers.push("owner_outcome_unresolved");

  const facts = attempts.map(attempt => {
    const payoutResult = payoutReads.get(attempt.request_id)!.result;
    const payout = valueOf(payoutResult);
    const correlation = attempt.payout_correlation_id ?? (payout?.request_id === attempt.request_id ? payout.correlation_id : null);
    const paymentResult = correlation === null ? null : paymentReads.get(correlation)?.result ?? null;
    const payment = valueOf(paymentResult ?? undefined);
    const reasons: string[] = [];
    if (!payout) reasons.push("payout_read_unavailable");
    if (!payment) reasons.push("payment_read_unavailable");
    if (payout && payout.request_id !== attempt.request_id) reasons.push("foreign_request_id");
    if (payout && attempt.payout_correlation_id !== null && payout.correlation_id !== attempt.payout_correlation_id) reasons.push("changed_payment_correlation");
    if (payment && attempt.approval_id !== null && payment.approval_id !== attempt.approval_id) reasons.push("changed_approval_id");
    if (payment && payment.request === null) reasons.push("original_request_unsupported");
    if (payment?.request && !requestMatches(attempt, payment.request)) reasons.push("original_request_mismatch");
    const heldForAttempt = held.filter(row => row.correlation_id === correlation);
    if (heldForAttempt.length) reasons.push("held_payment_reported");
    if (heldForAttempt.some(row => row.approval_id !== attempt.approval_id || (row.request !== null && !requestMatches(attempt, row.request)))) reasons.push("held_request_mismatch");
    const storedCounter = counterevidence(attempt) || attempt.state === "paid" || attempt.resolution === "arrived";
    const liveCounter = payment !== null && (counterevidence(payment) || payment.destination_tx_hash !== null);
    if (storedCounter) reasons.push("stored_transfer_or_arrival_evidence");
    if (liveCounter) reasons.push("observed_transfer_or_refund_evidence");
    if (findings.some(finding => finding.code === "contradictory_non_execution" && (!finding.request_id || finding.request_id === attempt.request_id))) reasons.push("stored_non_execution_contradiction");
    const proof = payout?.state === "failed" && payout.status === "FAILED" && payout.never_executed === true && payment?.status === "FAILED";
    const paid = payout?.state === "succeeded" && payout.status === "SUCCESS" && payment?.status === "SUCCESS";
    const successReported = payout?.state === "succeeded" || payout?.status === "SUCCESS" || payment?.status === "SUCCESS";
    const refundReported = refundEvidence(attempt) || (payment !== null && refundEvidence(payment)) ||
      payout?.status === "REFUNDED" || payment?.status === "REFUNDED";
    if (refundReported) reasons.push("refund_reported");
    if (successReported && refundReported) reasons.push("success_refund_conflict");
    if (paid && heldForAttempt.length) reasons.push("paid_payment_still_held");
    const proofConflict = (attempt.never_executed === true || payout?.never_executed === true) && (storedCounter || liveCounter ||
      (payout !== null && (payout.state !== "failed" || (!uncertainProviderStatus(payout.status) && payout.status !== "FAILED"))) ||
      (payment !== null && !uncertainProviderStatus(payment.status) && payment.status !== "FAILED"));
    if (proofConflict) reasons.push("non_execution_contradicted");
    if (payout && uncertainProviderStatus(payout.status)) reasons.push("payout_status_unknown");
    if (payment && uncertainProviderStatus(payment.status)) reasons.push("payment_status_unknown");
    if (payout && !uncertainProviderStatus(payout.status) && ((payout.state === "failed" && !["FAILED", "REFUNDED"].includes(payout.status ?? "")) || (payout.state === "succeeded" && payout.status !== "SUCCESS") ||
        (["held", "processing"].includes(payout.state) && ["FAILED", "SUCCESS", "REFUNDED"].includes(payout.status ?? "")))) reasons.push("payout_state_status_conflict");
    if (payout && payment && !uncertainProviderStatus(payment.status) && ((payout.state === "failed" && payment.status === "SUCCESS") || (payout.state === "succeeded" && payment.status !== "SUCCESS"))) reasons.push("payout_payment_status_conflict");
    if (!proof) reasons.push("consistent_explicit_non_execution_not_reported");
    const inconsistent = reasons.some(reason => ["foreign_request_id", "changed_payment_correlation", "changed_approval_id", "original_request_mismatch", "held_request_mismatch", "paid_payment_still_held", "success_refund_conflict", "stored_non_execution_contradiction", "non_execution_contradicted", "payout_state_status_conflict", "payout_payment_status_conflict"].includes(reason));
    return { attempt, payoutResult, paymentResult, payout, payment, proof, paid, successReported, inconsistent, reasons, storedCounter, liveCounter, held: heldForAttempt.length > 0 };
  });
  const coherentPaid = facts.filter(fact => fact.paid && !fact.inconsistent && fact.payment?.request && requestMatches(fact.attempt, fact.payment.request));
  const coherentNonExecution = facts.filter(fact => fact.proof && !fact.inconsistent && !fact.storedCounter && !fact.liveCounter && !fact.held &&
    fact.payment?.request && requestMatches(fact.attempt, fact.payment.request));
  const duplicateGroups: string[][] = [];
  const grouped = new Map<string, typeof coherentPaid>();
  for (const fact of coherentPaid) {
    if (fact.attempt.judgment_id === null || fact.attempt.seq === null) continue;
    const key = JSON.stringify([fact.attempt.judgment_id, fact.attempt.seq]);
    grouped.set(key, [...(grouped.get(key) ?? []), fact]);
  }
  for (const group of grouped.values()) if (group.length > 1) duplicateGroups.push(group.map(fact => fact.attempt.request_id));
  const duplicateIds = new Set(duplicateGroups.flat());
  const items: RecoveryPreview["items"] = facts.map(fact => {
    const { attempt } = fact;
    const peers = facts.filter(peer => peer !== fact && attempt.judgment_id !== null && attempt.seq !== null && peer.attempt.judgment_id === attempt.judgment_id && peer.attempt.seq === attempt.seq);
    const other = facts.filter(peer => peer !== fact && !peers.includes(peer));
    const relatedUncertain = facts.some(peer => peer !== fact && (peer.held || (!coherentNonExecution.includes(peer) && !coherentPaid.includes(peer))));
    const reasons = [...fact.reasons, ...globalBlockers];
    if (relatedUncertain) reasons.push("related_attempt_unresolved");
    if (historicalRelease(attempt)) reasons.push("historical_release_requires_review");
    if (peers.some(peer => coherentPaid.includes(peer))) reasons.push("same_obligation_payment_reported");
    let category: RecoveryCategory = "retain_commitment";
    if (fact.inconsistent) category = "contradictory";
    else if (duplicateIds.has(attempt.request_id)) { category = "possible_duplicate"; reasons.push("multiple_same_obligation_payments_reported"); }
    else if (coherentPaid.includes(fact)) category = "payment_reported";
    else if (coherentNonExecution.includes(fact) && globalBlockers.length === 0 && !relatedUncertain) category = "non_execution_reported";
    return {
      request_id: attempt.request_id, category, reason_codes: [...new Set(reasons)],
      review_note: historicalRelease(attempt) && category !== "non_execution_reported"
        ? "Review whether the historical budget release must be restored to commitment; do not create another send from this report."
        : category === "payment_reported" || category === "possible_duplicate"
          ? "Review settlement and accounting under the original IDs, including possible overpayment; this report applies no correction."
          : "Retain or review the obligation under its original IDs. Fresh authoritative evidence and human review are required before any later correction.",
      stored: {
        state: attempt.state, resolution: attempt.resolution, never_executed: attempt.never_executed, recipient: attempt.recipient, amount_atomic: attempt.amount_atomic,
        payout_correlation_id: attempt.payout_correlation_id, approval_id: attempt.approval_id, tx_hash: attempt.tx_hash, refund_tx_hash: attempt.refund_tx_hash, refunded_amount: attempt.refunded_amount,
      },
      reported: { payout: fact.payoutResult, payment: fact.paymentResult },
      same_obligation_request_ids: peers.map(peer => peer.attempt.request_id), other_same_job_request_ids: other.map(peer => peer.attempt.request_id),
    };
  });
  return {
    schema_version: 1, snapshot_sha256: inspection.snapshot.sha256, binding_sha256: collection.binding_sha256, collection_sha256: hashCanonical(collection),
    contract_id: binding.contract_id, clearance: "none", requires_review: true, requires_fresh_evidence: true, items,
    owner_observations: collection.owners, held_observation: collection.held, unmatched_held_count: collection.unmatched_held_count,
    ledger_findings: findings.map(finding => ({ code: finding.code, message: finding.message, ...(finding.request_id ? { request_id: finding.request_id } : {}),
      ...(finding.contract_id ? { contract_id: finding.contract_id } : {}), ...(finding.table ? { table: finding.table } : {}), ...(finding.column ? { column: finding.column } : {}) })),
    accounting: {
      all_reported_success_request_ids: facts.filter(fact => fact.successReported).map(fact => fact.attempt.request_id),
      payment_reported_request_ids: coherentPaid.map(fact => fact.attempt.request_id),
      excluded_success_request_ids: facts.filter(fact => fact.successReported && !coherentPaid.includes(fact)).map(fact => fact.attempt.request_id),
      matched_status_report_subtotal_atomic: coherentPaid.reduce((sum, fact) => sum + BigInt(fact.attempt.amount_atomic!), 0n).toString(),
      possible_duplicate_groups: duplicateGroups, historically_released_request_ids: attempts.filter(historicalRelease).map(attempt => attempt.request_id),
    },
    limitations: [
      "Advisory observations only: no SQL, repair, signing, send, startup clearance or permission to resume is produced.",
      "Origin, deployment, provenance and agent bindings are operator-declared and are not independently attested by this report.",
      "Snapshot, binding and collection digests identify inputs; they do not authenticate platform responses or prove freshness.",
      "Only projected recipient, amount and fixed application payment fields are compared. Full signed terms, signatures, obligation validity and provenance are not verified.",
      "A non-execution report is not readiness to release budget; later correction requires fresh authoritative evidence and human review.",
      "The matched status report subtotal uses stored amounts for matched reports only, not net settlement or a complete paid total. Other success claims remain listed as excluded; same-obligation multiple payments require overpayment review.",
      "Unknown, unsupported or missing legacy evidence remains unresolved; unmatched held records are counted without inferring associations.",
    ],
  };
}
