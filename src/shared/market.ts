// What the market pages see (server → browser). Market text (briefs, deliverables, job titles) is data: rendered as
// text, never as HTML, and never acted on.

export interface SignRequest {
  account_id: string;
  message: string;
  recipient: string;
  nonce: string;
}

export interface MemberTransactionView {
  receiverId: string;
  actions: { type: "FunctionCall"; params: Record<string, unknown> }[];
}

export interface DaoVoteView {
  id: string;
  kind: "setup" | "consent" | "agent_create" | "grant_issue" | "agent_freeze" | "agent_unfreeze" | "hire";
  hash: string;
  description: string;
  voting_until: string;
  /** A hire's approval: until when it may be paid, as the platform answered (it may be shorter than Paperwork asked). */
  valid_until: string | null;
  /** The platform's page showing the exact text the DAO signs and its hash, recomputed. */
  check_url: string;
  proposal: MemberTransactionView | null;
  proposal_and_vote: MemberTransactionView | null;
  state: "pending" | "done" | "expired";
}

export type AgencyNext =
  | { kind: "sign"; step: "setup" | "consent"; label: string; sign: SignRequest }
  | { kind: "owner_step"; correlation_id: string; label: string; summary: string; sign?: SignRequest; confirm?: { url: string; expires_at: string } }
  | { kind: "dao_vote"; label: string; vote: DaoVoteView }
  | { kind: "register"; label: string; account: string; transaction: MemberTransactionView }
  | { kind: "wait"; label: string; retry_ms: number }
  | { kind: "blocked"; label: string; detail: string }
  | { kind: "done" };

export type HireStateView = "quoted" | "voting" | "vote_expired" | "hiring" | "unknown" | "paid" | "not_charged" | "refused";

export interface HireTermsView {
  handle: string;
  brief: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
  maxTimeoutSeconds: number;
}

export interface HireView {
  request_id: string;
  handle: string;
  brief: string;
  terms: HireTermsView;
  amount_usd: string;
  state: HireStateView;
  code: string | null;
  task_state: string | null;
  deliverable: string | null;
  vote: DaoVoteView | null;
  quoted_at: string;
  updated_at: string;
}

export interface AgencyView {
  id: string;
  name: string;
  organization: string;
  owner: string;
  signer: "wallet" | "dao";
  agent: string | null;
  agent_id: string | null;
  stage: string;
  /** Whether the agent's policy is frozen (null: unread). */
  frozen: boolean | null;
  /** A DAO's own stop page (no time limit; ends every app's consent, doesn't freeze). Null for a wallet. */
  dao_stop_url: string | null;
  consent_expires_at: string | null;
  account: { account: string; registered: boolean; opened: boolean; usdc_usd: string } | null;
  deposit: DepositView | null;
  hires: HireView[];
  worker: boolean;
}

export interface DepositView {
  address: string;
  expires_at: string | null;
  /** Whether the address is registered on USDC: the market refuses to withdraw to an unregistered account. Null: unknown. */
  registered: boolean | null;
  registration: MemberTransactionView;
}

export interface DirectoryAgent {
  agent_id: string;
  handle: string;
  name: string;
  description: string | null;
  sla_seconds: number;
  delivered_jobs: number;
  success_rate: number | null;
}

export interface DirectoryDetail {
  plans: { name: string | null; model: string; price_amount: string; is_default: boolean; sla_seconds: number | null }[];
  reputation: { overall: number | null; jobs_counted: number } | null;
}

export interface AssignmentView {
  assignment_id: string;
  job_id: string;
  title: string;
  description: string;
  status: string;
  escrow_amount: string | null;
  escrow_token: string | null;
  sla_deadline_at: string | null;
  deliverable: string | null;
  submit_state: "none" | "submitting" | "submitted" | "unknown";
  submit_error: string | null;
  /** Optional for older app clients; retry uses the saved body and this existing attempt, never a new identity. */
  submit_attempt_id?: string | null;
  submit_phase?: "preflight" | "posting" | "not_arrived" | null;
  deposit_address: string | null;
  accepted_at: string | null;
}

export interface WorkerView {
  configured: boolean;
  agency_id: string | null;
  webhook_path: string;
  assignments: AssignmentView[];
  deposit: DepositView | null;
  last_poll: { at: string; error: string | null } | null;
}
