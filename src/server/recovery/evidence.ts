import { z } from "zod";

export const recoveryIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:@-]+$/).refine((value) => value !== "." && value !== "..");
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const id = recoveryIdSchema, digest = digestSchema;

/** Operator-declared provenance, never a platform attestation or permission to repair. */
export const recoveryBindingSchema = z.strictObject({
  schema_version: z.literal(1),
  snapshot_sha256: digest,
  provenance_sha256: digest,
  platform_origin: z.string().max(512).refine((value) => {
    try {
      const url = new URL(value);
      return url.origin === value && !url.username && !url.password && !url.hostname.includes("*") &&
        (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
    } catch { return false; }
  }),
  deployment: id,
  contract_id: id,
  terms_hash: digest,
  organization: id,
  agent: id,
  agent_id: id,
});
export type RecoveryBinding = z.infer<typeof recoveryBindingSchema>;

export interface RequestEvidence {
  recipient: string;
  asset: string;
  amount: string;
  chain: string;
  confidential: boolean;
  has_memo: boolean;
}
export interface PayoutEvidence {
  request_id: string;
  state: "succeeded" | "failed" | "held" | "processing" | "refused" | "unknown" | "not_found";
  status: string | null;
  correlation_id: string | null;
  never_executed: boolean | null;
}
export interface PaymentEvidence {
  status: string;
  approval_id: string | null;
  tx_hash: string | null;
  destination_tx_hash: string | null;
  refund_tx_hash: string | null;
  refunded_amount: string | null;
  request: RequestEvidence | null;
}
export interface HeldEvidence {
  correlation_id: string;
  approval_id: string;
  request: RequestEvidence | null;
}
export interface OwnerEvidence {
  stage: string;
  phase: "open" | "submitted" | "settled" | "expired" | null;
  status: string | null;
}
export type ReadFailure = "session" | "forbidden" | "refused" | "unresolved" | "busy" | "rate_limited" |
  "unavailable" | "unknown" | "provider" | "invalid_response" | "timeout" | "oversized_response" | "collection_budget";
export type ReadResult<T> = ({ ok: true; value: T } | { ok: false; kind: ReadFailure }) & { response_sha256: string | null };

const text = z.string().max(512);
const status = z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/);
export const requestEvidenceSchema = z.strictObject({ recipient: text, asset: text, amount: z.string().max(256).regex(/^\d+$/), chain: text, confidential: z.boolean(), has_memo: z.boolean() });
export const payoutEvidenceSchema = z.strictObject({ request_id: id, state: z.enum(["succeeded", "failed", "held", "processing", "refused", "unknown", "not_found"]), status: status.nullable(), correlation_id: id.nullable(), never_executed: z.boolean().nullable() });
export const paymentEvidenceSchema = z.strictObject({ status, approval_id: id.nullable(), tx_hash: text.nullable(), destination_tx_hash: text.nullable(), refund_tx_hash: text.nullable(), refunded_amount: text.nullable(), request: requestEvidenceSchema.nullable() });
export const heldEvidenceSchema = z.array(z.strictObject({ correlation_id: id, approval_id: id, request: requestEvidenceSchema.nullable() })).max(500);
export const ownerEvidenceSchema = z.strictObject({ stage: z.enum(["submitted", "submitting", "expired", "failed", "voting", "unknown"]), phase: z.enum(["open", "submitted", "settled", "expired"]).nullable(), status: status.nullable() });
const readFailureSchema = z.enum(["session", "forbidden", "refused", "unresolved", "busy", "rate_limited", "unavailable", "unknown", "provider", "invalid_response", "timeout", "oversized_response", "collection_budget"]);
export function readResultSchema<T>(value: z.ZodType<T>) {
  return z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), value, response_sha256: digest.nullable() }),
    z.strictObject({ ok: z.literal(false), kind: readFailureSchema, response_sha256: digest.nullable() }),
  ]);
}
export function observationSchema<T>(value: z.ZodType<T>) {
  return z.strictObject({ target_id: id.nullable(), started_at: z.iso.datetime(), completed_at: z.iso.datetime(), result: readResultSchema(value) });
}

/** This interface deliberately exposes no signing, preparation, reconciliation or send operation. */
export interface RecoveryReader {
  readonly origin: string;
  readonly deployment: string;
  readonly sdk_version: string;
  payoutStatus(binding: RecoveryBinding, requestId: string, signal?: AbortSignal): Promise<ReadResult<PayoutEvidence>>;
  paymentStatus(binding: RecoveryBinding, correlationId: string, signal?: AbortSignal): Promise<ReadResult<PaymentEvidence>>;
  held(binding: RecoveryBinding, signal?: AbortSignal): Promise<ReadResult<HeldEvidence[]>>;
  ownerStatus(binding: RecoveryBinding, correlationId: string, signal?: AbortSignal): Promise<ReadResult<OwnerEvidence>>;
}
export interface Observation<T> {
  target_id: string | null;
  started_at: string;
  completed_at: string;
  result: ReadResult<T>;
}
export interface EvidenceCollection {
  schema_version: 1;
  binding: RecoveryBinding;
  binding_sha256: string;
  snapshot: { sha256: string; bytes: number };
  sdk_version: string;
  started_at: string;
  completed_at: string;
  payouts: Observation<PayoutEvidence>[];
  payments: Observation<PaymentEvidence>[];
  owners: Observation<OwnerEvidence>[];
  held: Observation<HeldEvidence[]>;
  unmatched_held_count: number | null;
  complete: boolean;
  clearance: "none";
  limitations: string[];
}
