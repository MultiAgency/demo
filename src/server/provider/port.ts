import type { Policy } from "@near-intents-agent-api/sdk";
import type { Layer } from "../../shared/clauses";

/**
 * The narrow slice of the NEAR Intents Agent API that Covenant uses.
 * `sim.ts` implements it in memory (keyless demo, tests); `live.ts` wraps @near-intents-agent-api/sdk.
 * Shapes follow SDK 0.7.3 (Policy, ErrorDocument, StatusType, dry-run warnings).
 */

export type ExecStatus =
  | "QUEUED"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED"
  | "UNCERTAIN"
  | "NEEDS_REVIEW";

export interface ProviderErrorObject {
  status: string;
  code: string;
  layer: Layer;
  title: string;
  detail?: string;
}

/** Thrown when the provider refuses a request. Mirrors the API's JSON:API error document. */
export class ProviderRefusal extends Error {
  constructor(
    readonly httpStatus: number,
    readonly errors: ProviderErrorObject[],
    readonly requestId: string,
  ) {
    super(errors.map((e) => `${e.layer}/${e.code}: ${e.title}`).join("; "));
    this.name = "ProviderRefusal";
  }
  get first(): ProviderErrorObject {
    return this.errors[0]!;
  }
}

export type OwnerIntent =
  | { type: "agent_create"; owner: { type: "near"; account_id: string; public_key: string }; name: string; policy: Policy }
  | { type: "grant_issue"; agent_id: string; label: string; expires_at: string }
  | { type: "execution_cancel"; agent_id: string; correlation_id: string }
  | { type: "agent_freeze"; agent_id: string };

/** What the owner's wallet must sign. `standard` tells the browser which wallet call to use. */
export interface PreparedIntent {
  correlation_id: string;
  type: OwnerIntent["type"];
  standard: "nep413" | "nep366";
  signer: string;
  message: string;
  nonce: string; // base64, 32 bytes
  recipient: string;
  /** For grant_issue: the credential our server will use. Never shown to the browser. */
  credential?: string;
}

export type IntentOutcome =
  | { type: "agent_create"; agent_id: string }
  | { type: "grant_issue"; grant_id: string; expires_at: string }
  | { type: "execution_cancel"; correlation_id: string }
  | { type: "agent_freeze"; agent_id: string };

export interface PolicyView {
  agent_id: string;
  status: "APPLIED" | "PENDING" | string;
  provider_policy_synced: boolean;
  policy: Policy;
  policy_hash: string;
  revision: number;
}

export interface GrantInfo {
  grant_id: string;
  label: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface AgentInfo {
  agent_id: string;
  name: string;
  owner_account: string;
  frozen: boolean;
  available: string; // atomic USDC
  deposit_address: string;
}

export interface WithdrawRequest {
  asset: string;
  amount: string; // atomic
  chain: string;
  recipient: string;
  memo?: string;
}

export interface WithdrawAccepted {
  correlation_id: string;
  status: ExecStatus;
  dispatch_at: string | null;
  idempotency_key: string;
  replayed: boolean;
}

export interface DryWarning {
  code: string;
  detail: string;
  layer: Layer;
}

export interface DryResult {
  dry: true;
  amount_usd: string;
  warnings: DryWarning[];
}

export interface ExecutionView {
  correlation_id: string;
  status: ExecStatus;
  amount: string;
  recipient: string;
  dispatch_at: string | null;
  tx_hash: string | null;
  failure_reason: string | null;
}

export interface Provider {
  readonly mode: "sim" | "live";
  now(): Date;
  prepareIntent(intent: OwnerIntent): Promise<PreparedIntent>;
  submitIntent(correlationId: string, signed: { public_key: string; signature: string }): Promise<IntentOutcome>;
  getAgent(agentId: string): Promise<AgentInfo>;
  getPolicy(agentId: string): Promise<PolicyView>;
  getGrant(agentId: string, grantId: string): Promise<GrantInfo>;
  withdraw(credential: string, agentId: string, req: WithdrawRequest, opts: { idempotencyKey: string }): Promise<WithdrawAccepted>;
  withdrawDry(credential: string, agentId: string, req: WithdrawRequest, opts: { idempotencyKey: string }): Promise<DryResult>;
  getExecution(agentId: string, correlationId: string): Promise<ExecutionView>;
  listScheduled(agentId: string): Promise<ExecutionView[]>;
}

/** Does `public_key` belong to `account_id` as a full-access key? (RPC view_access_key in live.) */
export interface KeyRegistry {
  isFullAccessKey(accountId: string, publicKey: string): Promise<boolean>;
}
