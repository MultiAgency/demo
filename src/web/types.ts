// The web app's view of the API. Everything the server returns is typed in src/shared/views.ts;
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

/** POST /api/payouts/:rid/vote. `terms` are the payment terms the platform proved for this approval. */
export interface VoteAnswer {
  dao?: import("../server/platform/port").OwnerPrepared["dao"];
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

/** A wallet's NEP-413 signature, or its explicitly simulated demo equivalent. */
export interface Signed {
  account_id: string;
  public_key: string;
  signature: string;
  nonce: string;
}
