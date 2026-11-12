import type { JobAttention, MyJob } from "../../shared/my-jobs";
import { totalAtomic } from "../../shared/policy-request";
import { endInstant, startInstant, type Terms } from "../../shared/terms";
import type { AttemptRow, ContractRow, JobRow, OwnerStepRow, PlatformAgentRow } from "../db";
import { isCommitted } from "../payouts";

export interface JobAttentionSnapshot {
  terms: Terms;
  roles: MyJob["roles"];
  row: Pick<ContractRow, "rep_sig" | "contractor_sig" | "frozen">;
  agent: Pick<PlatformAgentRow, "stage"> | null;
  latestSubmission: Pick<JobRow, "state" | "judgment_id"> | null;
  payouts: readonly Pick<AttemptRow, "kind" | "request_id" | "run_id" | "state" | "resolution" | "amount_atomic" | "vote" | "code">[];
  openJudgmentId: string | null;
  ownerSteps: readonly Pick<OwnerStepRow, "kind" | "state" | "request_id" | "confirm_url">[];
  now: Date;
}

/** A projection of already stored records. It never refreshes, prepares, signs, sends or persists anything. */
export function jobAttention(s: JobAttentionSnapshot): JobAttention {
  const waiting = (summary: string, detail: string): JobAttention => ({ state: "waiting", summary, detail, actions: [] });
  const action = (role: "agency" | "builder", label: string, summary: string, detail: string, otherSummary: string, otherDetail: string): JobAttention =>
    s.roles.includes(role) ? { state: "needs_action", summary, detail, actions: [{ role, label }] } : waiting(otherSummary, otherDetail);
  const payouts = s.payouts.filter((p) => p.kind === "payout");
  const paymentById = new Map(payouts.map((p) => [p.request_id, p]));
  const unfinished = (p: typeof payouts[number]) => isCommitted(p) && p.state !== "paid";
  const uncertainVote = s.ownerSteps.some((step) => {
    const payout = step.request_id ? paymentById.get(step.request_id) : undefined;
    return step.kind === "approval_vote" && (!payout || unfinished(payout)) &&
      (step.state === "submitted" || step.state === "unknown" || (step.state === "prepared" && !!step.confirm_url));
  });
  // A prepared external confirmation may have been signed elsewhere. Local deadlines cannot free its identity.
  if (uncertainVote || payouts.some((p) => ["pending", "waiting", "unknown", "processing", "resolved", "disputed"].includes(p.state) ||
    (p.state === "held" && p.vote !== null) || (p.state === "failed" && (p.resolution === "arrived" || p.resolution === "disputed"))))
    return waiting("Waiting for payment evidence", "Follow the original payment and approval identities in the job. An attempted decision, manual receipt note or elapsed deadline does not confirm settlement or cancellation.");

  const scope = BigInt(totalAtomic(s.terms));
  const confirmed = payouts.filter((p) => p.state === "paid").reduce((sum, p) => sum + BigInt(p.amount_atomic), 0n);
  if (scope > 0n && confirmed === scope && !payouts.some(unfinished) && !!s.row.rep_sig && !!s.row.contractor_sig)
    return { state: "completed", summary: "Full scope payment confirmed", detail: "Stored platform payment outcomes confirm the full agreed scope amount. Approval, a closed review and the job end date alone do not establish this outcome.", actions: [] };
  if (confirmed > scope)
    return action("agency", "Review payment records", "Payment records need review", "Confirmed amounts exceed the signed scope. Inspect the existing records; this summary authorizes no new payment.", "Waiting for payment review", "The agency needs to inspect the existing payment records.");

  if (s.latestSubmission?.state === "disputed")
    return waiting("Waiting for disputed payment evidence", "The review is closed as disputed. Its amount remains committed; follow the original job rather than file replacement work or payment.");
  const held = payouts.some((p) => p.state === "held" && p.vote === null);
  if (s.latestSubmission?.state === "changes_pending") {
    if (held) return action("agency", "Review payout cancellation", "Cancel the existing payout before revision", "Changes were requested. Open the existing payout to review its rejection; cancellation must be confirmed before the builder can revise.", "Waiting for confirmed cancellation", "Changes were requested, but the original payout is still open. Do not submit a replacement revision yet.");
    return waiting("Waiting for confirmed cancellation", "Changes were requested. The original payment outcome must be resolved before a replacement revision can be filed.");
  }
  if (held) return action("agency", "Review payout proposal", "Compensation proposal needs review", "Inspect the submission and existing held payout. Agency approval remains explicit; a proposal is not payment.", "Waiting for agency payout review", "The compensation proposal is held for the agency's decision. Payment is not confirmed.");
  if (payouts.some((p) => p.state === "failed" && p.resolution === null))
    return action("agency", "Review payment issue", "Payment issue needs review", "Inspect the original failed payment and its evidence. A review must not create a replacement while its money outcome is uncertain.", "Waiting for payment review", "The agency must review the original payment issue. No confirmed payment or cancellation is recorded.");
  if (payouts.some((p) => p.state === "blocked" || (p.state === "refused" && s.openJudgmentId !== null && p.run_id === s.openJudgmentId)))
    return action("agency", "Inspect existing payout", "Existing payout needs attention", "Inspect the recorded refusal or block, including any setup or funding issue. Keep the original payment identity until its supported recovery is established.", "Waiting for agency payment review", "The agency needs to inspect the existing payout's block or refusal.");

  if (s.ownerSteps.some((step) => step.kind !== "approval_vote" && (step.state === "submitted" || step.state === "unknown" || (step.state === "prepared" && !!step.confirm_url))))
    return waiting("Waiting for setup confirmation", "Observe the existing owner action in the setup checklist. An uncertain or externally signable action must not be replaced by a new one.");
  if (s.now.getTime() > Date.parse(endInstant(s.terms)))
    return waiting("Job ended; full payment is not confirmed", "The end date does not prove delivery, cancellation or payment. Open the original job to review any remaining scope and evidence.");
  if (s.row.frozen)
    return action("agency", "Review frozen job", "Job is frozen", "Open the existing job to inspect the freeze and its recorded state. This summary does not unfreeze or authorize payment.", "Waiting for the agency", "The job is frozen. The agency must review its existing controls before work or payment can continue.");

  const signatures: JobAttention["actions"] = [];
  if (!s.row.rep_sig && s.roles.includes("agency")) signatures.push({ role: "agency", label: "Review and sign terms" });
  if (!s.row.contractor_sig && s.roles.includes("builder")) signatures.push({ role: "builder", label: "Review offered terms" });
  if (signatures.length) return { state: "needs_action", summary: "Review the offered terms", detail: "The named party's acceptance is missing. Builders must use the agency's original private invitation link; discovery creates no new invitation or signature.", actions: signatures };
  if (!s.row.rep_sig || !s.row.contractor_sig)
    return waiting("Waiting for the other party's acceptance", "Both named parties must accept the same job terms before setup and delivery continue.");
  if (s.agent?.stage === "policy_pending")
    return waiting("Waiting for the agreed policy", "The stored setup checklist is waiting for the policy to apply. Open the original job to observe its current outcome.");
  if (!s.agent || s.agent.stage !== "ready")
    return action("agency", "Continue existing setup", "Agency setup needs attention", "Open the existing job's setup checklist. This local summary does not establish current funding or prepare another owner action.", "Waiting for agency setup", "The agency's existing setup checklist is incomplete. Funding is not established by this summary.");
  if (s.now.getTime() < Date.parse(startInstant(s.terms)))
    return waiting("Waiting for the agreed start date", "The accepted terms have not started. Setup progress does not change the agreed work window.");
  if (s.terms.v === 2)
    return action("agency", "Open existing merge workflow", "Review the existing merge workflow", "This job uses merged-PR acceptance. Inspect its agreed scope and recorded reviews; no report-and-invoice task is inferred.", "Waiting in the merge workflow", "This job uses the existing merged-PR acceptance terms. Open the job to inspect its scope and recorded reviews.");
  if (s.latestSubmission?.state === "submitted")
    return action("agency", "Assess the submission", "Submission needs agency assessment", "The builder filed a report and invoice. Open that submission to propose compensation or request changes under the accepted terms.", "Waiting for agency assessment", "The report and invoice are submitted. A compensation proposal and agency approval are still separate steps.");
  if (s.latestSubmission?.state === "changes_requested")
    return action("builder", "Review requested changes", "Builder revision needs attention", "The recorded review permits a revision. Open the existing builder view and the agency's feedback; keep the original job identity.", "Waiting for the builder's revision", "The agency requested changes and no cancellation remains pending for this submission.");
  if (s.latestSubmission?.state === "proposed")
    return waiting("Waiting for the proposal's payment record", "A compensation proposal is recorded. Observe its original payment identity before preparing another decision or submission.");
  if (s.latestSubmission?.state === "closed" || s.latestSubmission?.state === "settled" || confirmed > 0n)
    return action("builder", "Review remaining scope", "Full scope payment is not yet confirmed", "A submission or payment covers only part of the job, or its review closed without full payment. Open the existing job to review remaining scope; this summary does not promise a new submission form.", "Waiting for remaining scope review", "The job is not fully paid. Review the existing scope and outcomes with the builder; a settled submission does not complete the whole job.");
  return {
    state: "needs_action", summary: "Review job readiness",
    detail: "Open the agreed job to check setup and funding before starting or submitting work.",
    actions: s.roles.map((role) => ({ role, label: role === "agency" ? "Verify setup and funding" : "Review job readiness" })),
  };
}
