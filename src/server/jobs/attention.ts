import type { JobAttention, MyJob } from "../../shared/my-jobs";
import { totalAtomic } from "../../shared/policy-request";
import { endInstant, isMarketSettled, payoutEndInstant, startInstant, type Terms } from "../../shared/terms";
import type { AttemptRow, ContractRow, JobRow, OwnerStepRow, PlatformAgentRow } from "../db";
import { isCommitted } from "../payouts";

export interface JobAttentionSnapshot {
  terms: Terms;
  roles: MyJob["roles"];
  row: Pick<ContractRow, "rep_sig" | "contractor_sig" | "frozen">;
  agent: Pick<PlatformAgentRow, "stage" | "usdc_observed"> | null;
  latestSubmission: Pick<JobRow, "state" | "judgment_id"> | null;
  payouts: readonly Pick<AttemptRow, "kind" | "request_id" | "run_id" | "state" | "resolution" | "amount_atomic" | "vote" | "code">[];
  openJudgmentId: string | null;
  ownerSteps: readonly Pick<OwnerStepRow, "kind" | "state" | "request_id" | "confirm_url">[];
  now: Date;
}

/** A projection of already stored records. It never refreshes, prepares, signs, sends or persists anything. */
export function jobAttention(s: JobAttentionSnapshot): JobAttention {
  const waiting = (reason_code: NonNullable<JobAttention["reason_code"]>, summary: string, detail: string): JobAttention => ({ reason_code, state: "waiting", summary, detail, actions: [] });
  const action = (reason_code: NonNullable<JobAttention["reason_code"]>, role: "agency" | "builder", label: string, summary: string, detail: string, otherSummary: string, otherDetail: string): JobAttention =>
    s.roles.includes(role) ? { reason_code, state: "needs_action", summary, detail, actions: [{ role, label }] } : waiting(reason_code, otherSummary, otherDetail);
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
    return waiting("payment_evidence_pending", "Waiting for payment evidence", "A payment or approval is in progress and its result is not confirmed yet. Nothing to do now; the job follows the original payment and shows its outcome once the platform reports it. A signed decision, manual receipt note or elapsed deadline does not confirm settlement or cancellation.");

  const scope = BigInt(totalAtomic(s.terms));
  const confirmed = payouts.filter((p) => p.state === "paid").reduce((sum, p) => sum + BigInt(p.amount_atomic), 0n);
  if (scope > 0n && confirmed === scope && !payouts.some(unfinished) && !!s.row.rep_sig && !!s.row.contractor_sig)
    return { reason_code: "scope_settled", state: "completed", summary: "Full scope payment confirmed", detail: "Stored platform payment outcomes confirm the full agreed scope amount. Approval, a closed review and the job end date alone do not establish this outcome.", actions: [] };
  if (confirmed > scope)
    return action("payment_records_review", "agency", "Review payment records", "Payment records need review", "Confirmed amounts exceed the signed scope. Inspect the existing records; this summary authorizes no new payment.", "Waiting for payment review", "The agency needs to inspect the existing payment records.");

  if (s.latestSubmission?.state === "disputed")
    return waiting("payment_disputed", "Waiting for disputed payment evidence", "The review is closed as disputed. Its amount remains committed; follow the original job rather than file replacement work or payment.");
  const held = payouts.some((p) => p.state === "held" && p.vote === null);
  if (s.latestSubmission?.state === "changes_pending") {
    if (held) return action("cancellation_review", "agency", "Review payout cancellation", "Cancel the existing payout before revision", "Changes were requested. Open the existing payout to review its rejection; cancellation must be confirmed before the builder can revise.", "Waiting for confirmed cancellation", "Changes were requested, but the original payout is still open. Do not submit a replacement revision yet.");
    return waiting("cancellation_pending", "Waiting for confirmed cancellation", "Changes were requested. The original payment outcome must be resolved before a replacement revision can be filed.");
  }
  if (held) return action("payout_review", "agency", "Review payout proposal", "Compensation proposal needs review", "Inspect the submission and existing held payout. Agency approval remains explicit; a proposal is not payment.", "Waiting for agency payout review", "The compensation proposal is held for the agency's decision. Payment is not confirmed.");
  if (payouts.some((p) => p.state === "failed" && p.resolution === null))
    return action("payment_issue", "agency", "Review payment issue", "Payment issue needs review", "Inspect the original failed payment and its evidence. A review must not create a replacement while its money outcome is uncertain.", "Waiting for payment review", "The agency must review the original payment issue. No confirmed payment or cancellation is recorded.");
  if (payouts.some((p) => p.state === "blocked" || (p.state === "refused" && s.openJudgmentId !== null && p.run_id === s.openJudgmentId)))
    return action("payout_blocked", "agency", "Inspect existing payout", "Existing payout needs attention", "Inspect the recorded refusal or block, including any setup or funding issue. Keep the original payment identity until its supported recovery is established.", "Waiting for agency payment review", "The agency needs to inspect the existing payout's block or refusal.");

  if (s.ownerSteps.some((step) => step.kind !== "approval_vote" && (step.state === "submitted" || step.state === "unknown" || (step.state === "prepared" && !!step.confirm_url))))
    return waiting("setup_confirmation_pending", "Waiting for setup confirmation", "Observe the existing owner action in the setup checklist. An uncertain or externally signable action must not be replaced by a new one.");
  if (s.now.getTime() > Date.parse(payoutEndInstant(s.terms)))
    return waiting("job_ended_unsettled", "Job ended; full payment is not confirmed", "The end date does not prove delivery, cancellation or payment. Open the original job to review any remaining scope and evidence.");
  if (s.row.frozen)
    return action("job_frozen", "agency", "Review frozen job", "Job is frozen", "Open the existing job to inspect the freeze and its recorded state. This summary does not unfreeze or authorize payment.", "Waiting for the agency", "The job is frozen. The agency must review its existing controls before work or payment can continue.");

  const signatures: JobAttention["actions"] = [];
  if (!s.row.rep_sig && s.roles.includes("agency")) signatures.push({ role: "agency", label: "Review and sign terms" });
  if (!s.row.contractor_sig && s.roles.includes("builder")) signatures.push({ role: "builder", label: "Review offered terms" });
  if (signatures.length) return { reason_code: "acceptance_required", state: "needs_action", summary: "Review the offered terms", detail: "The named party's acceptance is missing. Open the job to review the terms and sign them with the named account's wallet.", actions: signatures };
  if (!s.row.rep_sig || !s.row.contractor_sig)
    return waiting("acceptance_pending", "Waiting for the other party's acceptance", "Both named parties must accept the same job terms before setup and delivery continue.");
  if (isMarketSettled(s.terms)) {
    // The Agent Market funded and settles this job: no platform setup applies, and Paperwork never confirms its payout.
    if (s.latestSubmission?.state === "market_accepted")
      return { reason_code: "market_accepted", state: "completed", summary: "Accepted on the Agent Market", detail: "The Market reports the job completed. The Market pays its awarded price; Paperwork has not observed that payout.", actions: [] };
    if (s.latestSubmission?.state === "proposed")
      return action("market_acceptance_pending", "agency", "Accept on the Market or request changes", "Assessment ready for the agency", "The agent assessed the report against the signed criteria. Accept on the Agent Market to release its awarded price, or request changes here. The Market accepts automatically when its acceptance window lapses.", "Waiting for the agency's decision on the Market", "The agency reviews the assessment and accepts on the Agent Market or requests changes.");
    if (s.latestSubmission?.state === "submitted")
      return action("submission_review", "agency", "Assess the submission", "Submission needs agency assessment", "The builder filed a report and invoice. Open it to have the agent assess it against the signed criteria; the Agent Market, not Paperwork, pays this job.", "Waiting for agency assessment", "The report and invoice are submitted. The agency assesses it, then accepts on the Agent Market or requests changes.");
    if (!s.latestSubmission && s.now.getTime() >= Date.parse(startInstant(s.terms)))
      return { reason_code: "readiness_review", state: "needs_action", summary: "No report and invoice submitted yet", detail: "Both parties accepted the terms. The builder submits a report, invoice and evidence here; the Agent Market pays its awarded price after the agency accepts there.", actions: s.roles.map((role) => ({ role, label: role === "agency" ? "Wait for the builder's submission" : "Submit report and invoice" })) };
  }
  if (s.agent?.stage === "policy_pending")
    return waiting("policy_pending", "Waiting for the agreed policy", "The stored setup checklist is waiting for the policy to apply. Open the original job to observe its current outcome.");
  if (!isMarketSettled(s.terms) && (!s.agent || s.agent.stage !== "ready"))
    return action("setup_incomplete", "agency", "Continue existing setup", "Agency setup needs attention", "Open the existing job's setup checklist. This local summary does not establish current funding or prepare another owner action.", "Waiting for agency setup", "The agency's existing setup checklist is incomplete. Funding is not established by this summary.");
  // The last observed balance, as the setup checklist reads it: zero with no payout recorded means unfunded.
  const balance = isMarketSettled(s.terms) ? null : s.agent?.usdc_observed ?? null;
  const funded = balance === null ? null : BigInt(balance || "0") > 0n || payouts.length > 0;
  if (funded === false)
    return action("funding_required", "agency", "Fund the job", "Job is not funded yet", "The agent's last recorded balance was zero. Open the job's setup checklist to deposit the agreed scope total.", "Waiting for agency funding", "The agent's last recorded balance was zero. Payment needs the agency's deposit; open the job for the current status.");
  if (s.now.getTime() < Date.parse(startInstant(s.terms)))
    return waiting("start_pending", "Waiting for the agreed start date", "The accepted terms have not started. Setup progress does not change the agreed work window.");
  if (s.terms.v === 2)
    return action("merge_review", "agency", "Open existing merge workflow", "Review the existing merge workflow", "This job uses merged-PR acceptance. Inspect its agreed scope and recorded reviews; no report-and-invoice task is inferred.", "Waiting in the merge workflow", "This job uses the existing merged-PR acceptance terms. Open the job to inspect its scope and recorded reviews.");
  if (s.latestSubmission?.state === "submitted")
    return action("submission_review", "agency", "Review the submission", "Submission needs agency review", "The builder filed a report and invoice. Open it to approve the assessed compensation or request changes under the accepted terms.", "Waiting for agency review", "The report and invoice are submitted. No payout is requested until the agency approves.");
  // Inside a signed review window: recorded work can still be reviewed and paid, but nothing new can be filed.
  if (s.latestSubmission?.state !== "proposed" && s.now.getTime() > Date.parse(endInstant(s.terms)))
    return waiting("submission_closed", "Submission deadline has passed", "No new report can be filed after the agreed end date. Open the job to see what was delivered and paid; unfinished scope is not paid.");
  if (s.latestSubmission?.state === "changes_requested")
    return action("revision_requested", "builder", "Review requested changes", "Builder revision needs attention", "The recorded review permits a revision. Open the existing builder view and the agency's feedback; keep the original job identity.", "Waiting for the builder's revision", "The agency requested changes and no cancellation remains pending for this submission.");
  if (s.latestSubmission?.state === "proposed")
    return waiting("proposal_record_pending", "Waiting for the proposal's payment record", "A compensation proposal is recorded and its payout request is still being confirmed with the platform. Nothing to do yet; do not file another submission or decision in the meantime.");
  if (s.latestSubmission?.state === "closed" || s.latestSubmission?.state === "settled" || confirmed > 0n)
    return action("remaining_scope_review", "builder", "Review remaining scope", "Full scope payment is not yet confirmed", "A submission or payment covers only part of the job, or its review closed without full payment. Open the existing job to review remaining scope; this summary does not promise a new submission form.", "Waiting for remaining scope review", "The job is not fully paid. Review the existing scope and outcomes with the builder; a settled submission does not complete the whole job.");
  if (funded)
    return action("submission_due", "builder", "Submit report and invoice", "No report and invoice submitted yet", "Setup is complete and the agent's last recorded balance was above zero. Submit your report, invoice and evidence from the job when the work is ready.", "Waiting for the builder's report and invoice", "Setup is complete and the agent's last recorded balance was above zero. Nothing to do until the builder submits.");
  return {
    reason_code: "readiness_review", state: "needs_action", summary: "No report and invoice submitted yet",
    detail: "The builder can submit a report, invoice and evidence from the job. Setup is recorded as complete, but this summary does not confirm funding; check it in the job.",
    actions: s.roles.map((role) => ({ role, label: role === "agency" ? "Verify setup and funding" : "Submit report and invoice" })),
  };
}
