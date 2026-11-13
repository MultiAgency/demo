import type { DaoRequest } from "../server/market/port";
// API view types shared by the server and the web app.
import type { Consent, Deposit, OwnerAction, Overview } from "../server/platform/port";
import type { Clause } from "./clauses";
import type { Deliverable, Terms } from "./terms";
import type { JobSubmissionView } from "./jobs";


export type AttemptState = "pending" | "blocked" | "waiting" | "unknown" | "refused" | "held" | "processing" | "paid" | "rejected" | "failed" | "resolved" | "disputed" | "dropped";
export type JudgmentOutcome = "pending" | "approved" | "rejected" | "dropped" | "nothing" | "disputed";
export type PayoutResolution = "arrived" | "reowe" | "rejected" | "disputed";
export type SetupStage =
  | "needs_signatures"
  | "needs_setup"
  | "needs_create"
  | "needs_consent"
  | "needs_grant"
  | "needs_policy"
  | "policy_pending"
  | "needs_funding"
  | "active"
  | "ended"
  | "frozen";

export interface SignRequest {
  account_id: string;
  message: string;
  recipient: string;
  nonce: string;
}

export type NextStep =
  | { kind: "dao_vote"; retry_ms: number; label: string; request: DaoRequest }
  | { kind: "sign"; step: "setup" | "consent_payout" | "consent_owner"; label: string; sign: SignRequest }
  | { kind: "owner_step"; correlation_id: string; action: OwnerAction["type"]; label: string; summary: string; dao?: import("../server/platform/port").OwnerPrepared["dao"]; sign?: SignRequest; confirm?: { url: string; expires_at: string } }
  | { kind: "wait"; label: string; retry_ms: number; error?: string }
  | { kind: "done" };

export interface PayoutView {
  request_id: string;
  payment_correlation_id: string | null;
  approval_vote_id: string | null;
  kind: "payout" | "attack";
  seq: number;
  attempt: number;
  state: AttemptState;
  amount_usd: string;
  recipient: string;
  lines: { deliverable_id: string; title: string; amount_usd: string }[];
  code: string | null;
  clause: Clause | null;
  approval: { approval_id: string; expires_at: string | null } | null;
  vote: "approve" | "reject" | null;
  resolution: PayoutResolution | null;
  judge: { kind: string; model: string | null; decision: string; summary: string } | null;
  prs: { key: string; title: string; url: string; flags: string[] }[];
  tx_hash: string | null;
  refund_tx_hash: string | null;
  failure_code: string | null;
  never_executed?: boolean;
  /** request_conflict only: what the platform's record under this request id became (information only). */
  platform_record: string | null;
  created_at: string;
}

export interface SignatureView {
  account_id: string;
  public_key: string;
  signature: string;
  signed_at: string;
}

export interface ScopeRow extends Deliverable {
  completion: number;
  paid_usd: string;
  committed_usd: string;
  prs: { key: string; title: string; url: string; flagged?: boolean }[];
}

export interface EventView {
  id: number;
  at: string;
  kind: string;
  text: string;
}

export interface ContractView {
  id: string;
  hash: string;
  terms: Terms;
  organization: string;
  now: string;
  stage: SetupStage;
  next_step: NextStep | null;
  payee_registered: boolean | null;
  signatures: { representative: SignatureView | null; contractor: SignatureView | null };
  platform: {
    mode: "fake" | "remote";
    host: string;
    agent: string | null;
    agent_id: string | null;
    consents: { payout_expires_at: string; owner_expires_at: string } | null;
    policy: { revision: number; digest: string | null; applied: boolean } | null;
    balance_usd: string | null;
    deposit: Deposit | null;
  };
  total_usd: string;
  paid_usd: string;
  committed_usd: string;
  owed_usd: string;
  scope: ScopeRow[];
  judgment: unknown;
  open_judgment: { id: string; outcome: JudgmentOutcome; owed_usd: string; paid_usd: string } | null;
  payouts: PayoutView[];
  submissions: JobSubmissionView[];
  events: EventView[];
}

/** What Verify expects the platform to report, compiled from the signed terms. */
export interface Expectations {
  payee: string;
  asset: string;
  per_transaction: string; // atomic, the signed per-payment cap
  owner_approval: true;
  withdrawals: string[];
  payout_consent_expires_by: string; // ISO, = contract end
  total: string; // atomic scope total; funding is not a lifetime provider cap
}

export interface VerifyView {
  overall: "green" | "red" | "incomplete";
  checks: { id: string; label: string; ok: boolean; info?: boolean; detail?: string }[];
  /** Null for a Market-settled job, which has no platform policy to expect. */
  expected: Expectations | null;
  observed: Overview | null;
  consents: Consent[];
}

/** GET /api/config. Never contains the platform credential. */
export interface ConfigView {
  platform: "fake" | "remote";
  stack: boolean;
  host: string;
  demo_controls: boolean;
  demo_accounts: { representative: string; contractor: string; attacker: string } | null;
  now: string;
  judge: { kind: "rules" | "near-ai"; model: string | null };
  /** Availability only. Hermes URLs and credentials stay on the server. */
  review?: { enabled: boolean };
  auth: { required: boolean; recipient: string; network: "mainnet" | "testnet" };
  /** The agent market: offered only against the platform (or its stack with `--market`). `owner`/`dao`: the stack's. */
  market: { enabled: boolean; worker: boolean; owner: string | null; dao: string | null };
}

/*
REST:
  GET  /api/config -> ConfigView
  GET  /api/contracts -> list
  POST /api/contracts -> { id, contractor_link, contractor_token }
  GET  /api/contracts/:id -> ContractView
  GET  /api/contracts/:id/signing-request?role= ; POST /api/contracts/:id/signatures   (terms, unchanged)
  POST /api/contracts/:id/onboarding/next -> NextStep
  POST /api/contracts/:id/onboarding/signed { step, nonce, publicKey, signature } -> NextStep
  POST /api/owner-steps/:cid/submit { publicKey, signature } ; GET /api/owner-steps/:cid
  POST /api/contracts/:id/deposit -> Deposit
  POST /api/contracts/:id/run
  POST /api/contracts/:id/retry        (attempt+1 for the open judgment after a recorded refusal)
  POST /api/contracts/:id/drop         (close the open judgment as dropped)
  POST /api/payouts/:rid/vote { verdict } -> { correlation_id, sign?, confirm?, terms, flags }
  POST /api/payouts/:rid/resolve { outcome: "arrived"|"reowe"|"rejected" }
  GET  /api/contracts/:id/verify -> VerifyView (named parties)
  GET  /api/contracts/:id/verify/public -> PublicVerificationView
  POST /api/contracts/:id/attacks/:scenario
  Demo (fake; stack when PLATFORM_STACK_DIR): /api/sim/{sign,fund,settle,merge,advance,confirm}
*/

/** Public app-relayed check status. No private evidence or dynamic labels. */
export const PUBLIC_VERIFICATION_CHECKS = ["terms", "sig-representative", "sig-contractor", "platform", "applied", "actions", "assets", "payee", "cap", "approval", "frozen", "grant", "consent", "signed"] as const;
export interface PublicVerificationView {
  terms_hash: string;
  workflow_version: number;
  overall: "green" | "red" | "incomplete";
  checks: Partial<Record<typeof PUBLIC_VERIFICATION_CHECKS[number], boolean>>;
  checked_at: string;
}
