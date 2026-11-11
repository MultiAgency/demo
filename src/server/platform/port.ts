// The interface between Paperwork and the MultiAgency platform: the SDK client (client.ts) and the stand-in (fake.ts).
import { USDC_NEAR } from "../../shared/terms";
import type { MarketControls, MarketPlatform } from "../market/port";
export const USDC = USDC_NEAR;
export type Fail =
  | { ok: false; kind: "session" } // credential bad (401)
  | { ok: false; kind: "forbidden"; code?: string } // scope | no_consent | consent_revoked | access_ended | ...
  | { ok: false; kind: "refused"; code: string } // thrown before recording: nothing sent, same id may be re-asked
  | { ok: false; kind: "unresolved" | "busy" }
  | { ok: false; kind: "rate_limited"; retryAfterSeconds: number | null }
  | { ok: false; kind: "unavailable" | "unknown" | "provider"; detail?: string };
export type Res<T> = { ok: true; value: T } | Fail;
export interface Signed413 {
  message: string;
  nonce: string; // 32 bytes, base64
  publicKey: string;
  signature: string; // base64
}
export interface Reviewed {
  revision: number;
  digest: string;
}
export interface Caps {
  per_transaction?: Record<string, string>;
  hourly?: Record<string, string>;
  daily?: Record<string, string>;
  monthly?: Record<string, string>;
}
export interface Budget {
  daily_usd: string | null;
  weekly_usd: string | null;
  monthly_usd: string | null;
}
export interface PolicyChanges {
  withdrawals?: { address: string }[];
  owner_approval?: boolean;
  limits?: Caps;
  budget?: Budget;
}
export type OwnerAction =
  | { type: "agent_create"; owner: { type: "near"; account_id: string; public_key: string }; role: "payout" }
  | { type: "grant_issue"; label: "payout" }
  | { type: "policy_update"; expectedPolicy: Reviewed; changes: PolicyChanges }
  | { type: "approval_vote"; approvalId: string; verdict: "approve" | "reject"; correlationId: string }
  | { type: "agent_freeze" };
export interface Intent413 {
  standard: "nep413";
  payload: { message: string; recipient: string; nonce: string };
}
export interface OwnerPrepared {
  correlationId: string;
  expiresAt: string;
  summary: string;
  intent?: Intent413;
  confirm?: { url: string; expiresAt: string };
  payment?: {
    correlationId: string;
    verdict: "approve" | "reject";
    terms: { recipient: string; asset: string; amount: string; chain?: string } | null;
  };
}
export interface OwnerStatus {
  stage: string;
  /** Authoritative owner-intent lifecycle. Expired means the signing window closed before submission. */
  phase?: "open" | "submitted" | "settled" | "expired";
  status: string | null;
  failureCode: string | null;
}
export interface Overview {
  agentId: string;
  revision: number | null;
  digest: string | null;
  status: "NONE" | "SIGNED" | "APPLIED" | "FAILED";
  synced: boolean;
  notInForce: string | null;
  usdc: string; // confidential USDC balance, atomic
  policy: {
    actions: string[];
    assets: string[] | "any";
    owner_approval: boolean;
    frozen: boolean;
    limits: Caps;
    budget: Budget;
    withdrawals: string[]; // destinations.list action=withdraw chain=near memo=null
  } | null;
  grants: { label: string; revoked: boolean; expiresAt: string }[];
}
export interface PayoutAnswer {
  requestId: string;
  state: "succeeded" | "failed" | "held" | "processing" | "refused" | "unknown" | "not_found";
  status: string | null;
  correlationId: string | null;
  code: string | null;
  failureCode?: string | null;
  /** Authoritative platform proof. A failure code or absent transaction is insufficient. */
  neverExecuted?: boolean;
}
export interface Held {
  correlationId: string;
  approvalId: string;
  request: Record<string, unknown>;
  at: string;
}
export interface PaymentStatus {
  status: string;
  failureCode: string | null;
  approvalId: string | null;
  expiresAt: string | null;
  evidence: {
    txHash: string | null;
    destinationTxHash: string | null;
    refundTxHash: string | null;
    refundTo: string | null;
    refundedAmount: string | null;
  };
}
export interface Deposit {
  address: string;
  memo: string | null;
  minAmount: string | null;
  expiresAt: string | null;
}
export interface Consent {
  id: string;
  agentId: string;
  scopes: string[];
  expiresAt: string; // ISO
  publicKey: string;
  revoked: boolean;
}
export interface AgentHandle {
  ownerPrepare(a: OwnerAction): Promise<Res<OwnerPrepared>>; // always signer:"wallet"
  ownerSubmit(correlationId: string, intent: Intent413, s: { publicKey: string; signature: string }): Promise<Res<{ status: string; failureCode: string | null }>>;
  ownerStatus(correlationId: string): Promise<Res<OwnerStatus>>;
  overview(): Promise<Res<Overview>>;
  deposit(): Promise<Res<Deposit>>; // {asset: USDC}
  requestPayout(i: { requestId: string; recipient: string; amount: string; expectedPolicy: Reviewed }): Promise<Res<PayoutAnswer>>; // delivery {chain:"near"}, no memo
  payoutStatus(requestId: string): Promise<Res<PayoutAnswer>>;
  held(): Promise<Res<Held[]>>;
  paymentStatus(correlationId: string): Promise<Res<PaymentStatus>>;
}
export interface Platform {
  readonly mode: "fake" | "remote";
  readonly host: string;
  readonly deployment: string;
  setupMessage(i: { organization: string; owner: string; expiresAt: string }): string; // area "payables"
  consentMessage(i: { organization: string; owner: string; agent: string; agentId: string; scopes: ("owner" | "payout" | "read")[]; expiresAt: string }): string;
  identity(agent: string): Promise<Res<{ agentId: string | null; created: boolean; owner: string }>>;
  setup(s: Signed413): Promise<Res<{ agent: string; consent: Consent }>>;
  /** The agents this deployment's setups reserved for an Organization and owner (area "payables"): a lost setup reply's agent. Platforms before 0.5.5 answer refused. */
  reservations(organization: string, owner: string): Promise<Res<{ agent: string; owner: string; released: boolean }[]>>;
  submitConsent(s: Signed413): Promise<Res<Consent>>;
  listConsents(organization: string): Promise<Res<Consent[]>>;
  agent(organization: string, agent: string): AgentHandle;
}
export interface ChainReader {
  isFullAccessKey(account: string, publicKey: string): Promise<boolean>;
  isRegistered(token: string, account: string): Promise<boolean | null>; // null = couldn't tell
}
export interface OwnerSigner {
  sign413(p: { message: string; recipient: string; nonce: string }): Promise<{ publicKey: string; signature: string }>;
}
export interface DemoControls {
  fund(agentId: string, atomic: string): Promise<void>;
  settle(correlationId: string): Promise<void>;
  transfers(): Promise<{ recipient: string; amount: string; status: string }[]>;
  completeConfirm?(url: string): Promise<void>; // fake and stack: complete a platform confirm link headlessly
  dropNextReply?(): void; // fake only
  setUnavailable?(on: boolean): void; // fake only
  failAfterApproval?(code: string): void; // fake only
  advance?(ms: number): void; // fake only
}
export interface PlatformConfig {
  /** Stand-in only: browser demos retain the distinct approval and settlement phases. */
  autoSettle?: "after-read" | "manual";
  mode: "fake" | "remote";
  deployment: string;
  url?: string;
  credential?: string;
  caPem?: string;
  rpcUrl?: string;
  stackDir?: string;
  /** The agent market's HTTP API (remote without a stack). Default https://market.near.ai. */
  marketUrl?: string;
  now: () => Date;
}
export interface PlatformKit {
  platform: Platform;
  chain: ChainReader;
  controls: DemoControls | null;
  devSigner: OwnerSigner | null;
  /** The agent market (src/server/market): remote only, since there is no stand-in for it. */
  market?: {
    platform: MarketPlatform;
    controls: MarketControls | null;
    /** The market's HTTP API: market.near.ai, or the local stack's simulated market. */
    url: string;
    /** NEAR RPC for DAO roles. */
    rpcUrl: string;
    /** The local stack's wallet owner and DAO (`--dao-treasury`), for the demo's agency form. */
    owner: string | null;
    dao: string | null;
  } | null;
}
// src/server/platform/index.ts: export function makePlatform(cfg: PlatformConfig): PlatformKit
// src/server/platform/stack.ts:  export function readStack(dir: string): { url: string; credential: string; caPem: string; rpcUrl: string; owner: string; payees: string[] }
// devSigner and controls are non-null only in fake mode or when stackDir is set; config.ts refuses stackDir when NODE_ENV=production.
