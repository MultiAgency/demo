import { z } from "zod";
import { hashCanonical } from "./canonical";
import { USDC_NEAR } from "./terms";

const id = z.string().min(1).max(256);
const atomic = z.string().regex(/^(0|[1-9]\d*)$/).max(40);
const instant = z.iso.datetime();
/** Proposed app/platform read contract. Only a trusted platform adapter may supply it, never an HTTP caller. */
export const fundingReconciliationSchema = z.object({
  schema_version: z.literal(1), reconciliation_id: id,
  job_id: id, terms_hash: z.string().regex(/^[a-f0-9]{64}$/),
  deployment: id, platform_host: id, app_origin: z.string().url(), organization: id,
  owner: id, agent_id: id, asset: z.literal(USDC_NEAR), chain: z.literal("near"), network: z.literal("mainnet"),
  observed_at: instant, expires_at: instant,
  // A provider-supported recovery procedure may resolve an unbound legacy request; an app guess cannot.
  original_allocation: z.object({ state: z.literal("resolved"), evidence_reference: id,
    resolution: z.enum(["exact_operation", "provider_recovery_procedure"]) }).strict(),
  route_ready: z.literal(true), credited_atomic: atomic, available_atomic: atomic, target_atomic: atomic,
  expected_credit_atomic: atomic, fee_atomic: atomic, transfer_atomic: atomic,
  destination: z.object({ address: z.string().min(2).max(64).regex(/^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$/),
    allocation_request_id: id, correlation_id: id,
    can_receive_this_transfer: z.literal(true), minimum_atomic: atomic, expires_at: instant, memo: z.null() }).strict(),
}).strict();
export type FundingReconciliation = z.infer<typeof fundingReconciliationSchema>;
/**
 * Proposed provider read: what became of a recovery attempt's destination. Only a trusted platform adapter may supply
 * it. It is the only evidence that lets a recovery attempt end without credit; silence or a cancelled wallet never does.
 */
export const fundingRecoveryOutcomeSchema = z.object({
  schema_version: z.literal(1), correlation_id: id, allocation_request_id: id,
  state: z.literal("not_received"), destination_expired: z.literal(true), received_atomic: z.literal("0"), observed_at: instant,
}).strict();
export interface FundingRecoveryOutcomeQuery extends FundingRecoveryBinding { correlation_id: string; allocation_request_id: string }
export interface FundingRecoveryObservation { attempt_id: string; outcome: "funded" | "not_received" | null; message: string }
export interface FundingRecoveryBinding {
  job_id: string; terms_hash: string; deployment: string; platform_host: string;
  app_origin: string; organization: string; owner: string; agent_id: string; target_atomic: string;
}
export type FundingRecoveryCode = "platform_recovery_unavailable" | "reconciliation_unavailable" | "invalid_reconciliation" |
  "binding_mismatch" | "stale_reconciliation" | "amount_mismatch" | "job_not_recoverable" | "policy_unverified" | "wallet_outcome_unknown";
export type FundingRecoveryView =
  | { schema_version: 1; state: "blocked"; code: FundingRecoveryCode; message: string; plan: null }
  | { schema_version: 1; state: "ready"; code: "reconciled"; message: string; plan: FundingReconciliation & { plan_hash: string } };

/** Observation time may advance; the reviewed transfer, evidence and expiry must not change silently. */
export function fundingPlanHash(plan: FundingReconciliation): string {
  const { observed_at: _observed, ...intent } = plan;
  return hashCanonical(intent);
}
export function validateRecoveryPlan(input: unknown, binding: FundingRecoveryBinding, now: number): FundingRecoveryView {
  const blocked = (code: FundingRecoveryCode, message: string): FundingRecoveryView => ({ schema_version: 1, state: "blocked", code, message, plan: null });
  const parsed = fundingReconciliationSchema.safeParse(input);
  if (!parsed.success) return blocked("invalid_reconciliation", "The platform has not supplied a complete funding clearance. Keep the original allocation unresolved.");
  const plan = parsed.data;
  if (Object.entries(binding).some(([key, value]) => plan[key as keyof FundingReconciliation] !== value))
    return blocked("binding_mismatch", "The reconciliation does not match this job, owner, agent or signed terms.");
  const observed = Date.parse(plan.observed_at), expires = Date.parse(plan.expires_at);
  if (observed > now || now - observed > 300_000 || expires <= now || expires <= observed || expires - observed > 300_000 || Date.parse(plan.destination.expires_at) <= now)
    return blocked("stale_reconciliation", "Reconciliation or destination validity has expired. Refresh the existing reconciliation; do not request another address.");
  const credited = BigInt(plan.credited_atomic), target = BigInt(plan.target_atomic);
  const credit = BigInt(plan.expected_credit_atomic), transfer = BigInt(plan.transfer_atomic);
  if (credited <= 0n || credited >= target || plan.available_atomic !== plan.credited_atomic || credit !== target - credited ||
      transfer !== credit + BigInt(plan.fee_atomic) || transfer < BigInt(plan.destination.minimum_atomic))
    return blocked("amount_mismatch", "The existing credit, remaining amount, fee or route minimum does not reconcile. No transfer is ready.");
  return { schema_version: 1, state: "ready", code: "reconciled", message: "Review the reconciled credit, exact transfer and destination before opening your wallet.", plan: { ...plan, plan_hash: fundingPlanHash(plan) } };
}
