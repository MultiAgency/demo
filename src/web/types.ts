// The web app's view of the API. Everything the server returns is typed in src/shared/views.ts (frozen);
// this file re-exports those types and adds the few shapes views.ts leaves open.
import type { ConfigView, SignRequest } from "../shared/views";

export type {
  AttemptState,
  ContractView,
  EventView,
  Expectations,
  JudgmentOutcome,
  NextStep,
  PayoutView,
  ScopeRow,
  SetupStage,
  SignatureView,
  SignRequest,
  VerifyView,
} from "../shared/views";
export type { Clause } from "../shared/clauses";
export type { Deliverable, Terms } from "../shared/terms";
export type { Consent, Deposit, Overview } from "../server/platform/port";

export type AppConfig = ConfigView;

/** GET /api/contracts rows. */
export interface ContractRow {
  id: string;
  company: string;
  contractor: string;
  payee: string;
  total: string;
  paid: string;
  start: string;
  end: string;
  stage: string;
}

/** ContractView.judgment (typed `unknown` in views.ts): the last run of the judge. Read defensively. */
export interface Judgment {
  judge: "rules" | "near-ai";
  model?: string;
  decision: "pay" | "escalate";
  summary: string;
  prs: { key: string; title: string; url: string; merged_at: string; eligible: boolean; deliverable: string | null; reason: string; flags: string[] }[];
  at: string;
}

/** POST /api/payouts/:rid/vote. `terms` are the payment terms the platform proved for this approval. */
export interface VoteAnswer {
  correlation_id: string;
  sign?: SignRequest;
  confirm?: { url: string; expires_at: string };
  terms: { recipient: string; asset: string; amount: string; chain?: string } | null;
  flags: string[];
}

/** GET /api/contracts/:id/signing-request?role= (terms signatures, unchanged). */
export interface TermsSigningRequest {
  account_id: string;
  message: string;
  recipient: string;
  nonce: string;
}

/** POST /api/sim/sign: a demo-wallet NEP-413 signature (demo_controls only). */
export interface Signed {
  account_id: string;
  public_key: string;
  signature: string;
  nonce: string;
}
