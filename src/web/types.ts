import type { Policy } from "@near-intents-agent-api/sdk";

export interface Deliverable {
  id: string;
  title: string;
  criteria: string;
  value_usd: string;
}

export interface Terms {
  v: 2;
  company: string;
  representative: { near_account: string };
  contractor: { name: string; github: string; near_account: string };
  payee: { chain: "near"; address: string };
  asset: string;
  scope: Deliverable[];
  start: string;
  end: string;
  repos: string[];
  acceptance: string;
}

export interface PrReview {
  key: string;
  title: string;
  url: string;
  merged_at: string;
  eligible: boolean;
  deliverable: string | null;
  reason: string;
  flags: string[];
}

export interface Judgment {
  judge: "rules" | "near-ai";
  model?: string;
  decision: "pay" | "escalate";
  summary: string;
  prs: PrReview[];
  deliverables: { id: string; completion: number; prs: string[]; reason: string }[];
  at: string;
}

export interface ScopeItem extends Deliverable {
  completion: number;
  paid_usd: string;
  pending_usd: string;
  escalated_usd: string;
  prs: { key: string; title: string; url: string; flagged?: boolean }[];
}

export interface Signature {
  account_id: string;
  public_key: string;
  signature: string;
  signed_at: string;
}

export interface Payout {
  id: string;
  status: "escalated" | "rejected" | "persisted" | "queued" | "paid" | "cancelled" | "refused" | "failed" | "needs_review";
  amount_usd: string;
  deliverable: { id: string; title: string; value_usd: string } | null;
  completion: number | null;
  reason: string | null;
  judge: { kind: string; model: string | null; decision: "pay" | "escalate"; summary: string } | null;
  prs: { key: string; title: string; url: string; reason: string }[];
  correlation_id: string | null;
  dispatch_at: string | null;
  tx_hash: string | null;
  error: { code?: string; layer?: string; title?: string; detail?: string } | null;
  created_at: string;
}

export interface ContractView {
  id: string;
  hash: string;
  terms: Terms;
  compiled: { name: string; policy: Policy; grant: { label: string; expires_at: string } };
  created_at: string;
  now: string;
  provider: "sim" | "live";
  signatures: { representative: Signature | null; contractor: Signature | null };
  agent: { agent_id: string; frozen: boolean; available_usd: string; deposit_address: string } | null;
  grant: { grant_id: string; expires_at: string } | null;
  stage: "needs_signatures" | "needs_wallet" | "needs_grant" | "needs_funding" | "active" | "ended" | "frozen";
  total_usd: string;
  paid_usd: string;
  committed_usd: string;
  scope: ScopeItem[];
  judgment: Judgment | null;
  payouts: Payout[];
  events: { id: number; at: string; kind: string; text: string }[];
}

export interface AppConfig {
  provider: "sim" | "live";
  timelock_ms: number;
  evidence: "fake" | "github";
  demo_wallet: boolean;
  demo_accounts: { representative: string; contractor: string } | null;
  now: string;
  auth: { required: boolean; recipient: string; network: "mainnet" | "testnet" };
  judge: { kind: "rules" | "near-ai"; model: string | null };
}

export interface VerifyReport {
  id: string;
  hash: string;
  terms: Terms;
  compiled: ContractView["compiled"];
  checks: { id: string; label: string; ok: boolean; info?: boolean }[];
  agent_id: string | null;
  overall: "green" | "red" | "incomplete";
  policy: { status: string; synced: boolean; equal: boolean; diffs: { path: string; expected: unknown; actual: unknown }[]; policy_hash: string } | null;
  grant: { expires_at: string; matches_end: boolean; revoked: boolean } | null;
  funds: { available_usd: string; unpaid_usd: string; covers_cap: boolean; frozen: boolean } | null;
  frozen: boolean;
}

export interface AttackResult {
  scenario: string;
  ready: boolean;
  story: string;
  hint?: string;
  mode?: "dry" | "live";
  outcome?: "refused" | "would_refuse" | "allowed";
  findings?: { code: string; layer: string; detail: string; clause: { id: string; title: string; text: string } }[];
  request?: unknown;
  raw?: unknown;
  pull_request?: { title: string; body: string; url: string };
  fooled_ai_output?: { label: string; accepted_prs: number; amount_usd: string };
}
