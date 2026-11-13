import type { SetupStage } from "./views";

export interface JobAttention {
  /** Stable machine reason. Optional when reading older app responses. */
  reason_code?: "payment_evidence_pending" | "scope_settled" | "payment_records_review" | "payment_disputed"
    | "cancellation_review" | "cancellation_pending" | "payout_review" | "payment_issue" | "payout_blocked"
    | "setup_confirmation_pending" | "job_ended_unsettled" | "job_frozen" | "acceptance_required"
    | "acceptance_pending" | "policy_pending" | "setup_incomplete" | "start_pending" | "merge_review"
    | "market_acceptance_pending" | "market_accepted"
    | "submission_review" | "revision_requested" | "proposal_record_pending" | "remaining_scope_review" | "readiness_review" | "funding_required" | "submission_due" | "submission_closed";
  state: "needs_action" | "waiting" | "completed";
  summary: string;
  detail: string;
  /** Navigation to an existing authorized view only; never prepares or submits an action. */
  actions: { role: "agency" | "builder"; label: string }[];
}

/** Private account-scoped discovery of existing Paperwork records, never a public job posting. */
export interface MyJob {
  /** Original contract/job identity; discovery creates no new record or invitation. */
  id: string;
  title: string;
  company: string;
  builder_name: string;
  scope_usd: string;
  start: string;
  end: string;
  /** Stored setup progress, not a submission, approval or confirmed-payment state. */
  stage: SetupStage;
  roles: ("agency" | "builder")[];
  builder_accepted: boolean;
  workflow: "report_invoice" | "pay_on_merge";
  attention: JobAttention;
}
