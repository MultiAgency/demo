import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AttemptState, JudgmentOutcome } from "../shared/views";

export interface SignatureRecord {
  account_id: string;
  public_key: string;
  signature: string;
  nonce: string;
  signed_at: string;
}

export interface ContractRow {
  id: string;
  terms: string;
  hash: string;
  created_at: string;
  contractor_link_hash: string;
  rep_sig: string | null;
  contractor_sig: string | null;
  organization: string;
  payee_registered: number | null;
  frozen: number;
}

export type AgentStage = "needs_setup" | "needs_create" | "needs_consent" | "needs_grant" | "needs_policy" | "policy_pending" | "ready";

export interface PlatformAgentRow {
  organization: string;
  owner: string;
  owner_public_key: string | null;
  agent: string | null;
  agent_id: string | null;
  setup_consent_id: string | null;
  payout_consent_id: string | null;
  payout_consent_expires_at: string | null;
  owner_consent_id: string | null;
  owner_consent_expires_at: string | null;
  grant_ok: number;
  policy_revision: number | null;
  policy_digest: string | null;
  deposit: string | null;
  /** The sign request the server issued last ({step, message, nonce, recipient}), so the signed body can be rebuilt exactly. */
  pending_sign: string | null;
  stage: AgentStage;
  created_at: string;
  updated_at: string;
}

export type OwnerStepState = "prepared" | "submitted" | "success" | "failed" | "expired" | "unknown";

export interface OwnerStepRow {
  correlation_id: string;
  organization: string;
  contract_id: string | null;
  kind: string;
  action: string;
  standard: string;
  intent: string | null;
  confirm_url: string | null;
  expires_at: string | null;
  summary: string | null;
  payment_terms: string | null;
  request_id: string | null;
  verdict: string | null;
  state: OwnerStepState;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttemptRow {
  request_id: string;
  kind: "payout" | "attack";
  contract_id: string;
  seq: number;
  attempt: number;
  run_id: string | null;
  recipient: string;
  amount_atomic: string;
  state: AttemptState;
  code: string | null;
  /** How the code arrived: refused (recorded or thrown), forbidden, session, blocked (Covenant's own check). */
  fail_kind: string | null;
  correlation_id: string | null;
  approval_id: string | null;
  approval_expires_at: string | null;
  vote: "approve" | "reject" | null;
  vote_correlation_id: string | null;
  failure_code: string | null;
  tx_hash: string | null;
  refund_tx_hash: string | null;
  resolution: "arrived" | "reowe" | "rejected" | null;
  retry_at: string | null;
  auto_retry: number;
  scenario: string | null;
  created_at: string;
  updated_at: string;
}

export interface LineRow {
  request_id: string;
  deliverable_id: string;
  amount_atomic: string;
}

export interface JudgmentRow {
  id: string;
  contract_id: string;
  at: string;
  json: string;
  outcome: JudgmentOutcome;
  closed_at: string | null;
}

export interface EventRow {
  id: number;
  contract_id: string;
  at: string;
  kind: string;
  text: string;
}

/** Attempt states that hold a contract's single open payout slot. */
export const OPEN_STATES: AttemptState[] = ["pending", "blocked", "waiting", "unknown", "held", "processing"];

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  refuseOldSchema(db);
  const open = OPEN_STATES.map((s) => `'${s}'`).join(",");
  db.exec(`
    CREATE TABLE IF NOT EXISTS contracts (
      id TEXT PRIMARY KEY,
      terms TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      contractor_link_hash TEXT NOT NULL,
      rep_sig TEXT,
      contractor_sig TEXT,
      organization TEXT NOT NULL,
      payee_registered INTEGER,
      frozen INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS platform_agents (
      organization TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      owner_public_key TEXT,
      agent TEXT,
      agent_id TEXT,
      setup_consent_id TEXT,
      payout_consent_id TEXT,
      payout_consent_expires_at TEXT,
      owner_consent_id TEXT,
      owner_consent_expires_at TEXT,
      grant_ok INTEGER NOT NULL DEFAULT 0,
      policy_revision INTEGER,
      policy_digest TEXT,
      deposit TEXT,
      pending_sign TEXT,
      stage TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owner_steps (
      correlation_id TEXT PRIMARY KEY,
      organization TEXT NOT NULL,
      contract_id TEXT,
      kind TEXT NOT NULL,
      action TEXT NOT NULL,
      standard TEXT NOT NULL,
      intent TEXT,
      confirm_url TEXT,
      expires_at TEXT,
      summary TEXT,
      payment_terms TEXT,
      request_id TEXT,
      verdict TEXT,
      state TEXT NOT NULL,
      failure_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS judgments (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL REFERENCES contracts(id),
      at TEXT NOT NULL,
      json TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'pending',
      closed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_judgment ON judgments(contract_id) WHERE outcome = 'pending';
    CREATE TABLE IF NOT EXISTS payout_attempts (
      request_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'payout',
      contract_id TEXT NOT NULL REFERENCES contracts(id),
      seq INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      run_id TEXT REFERENCES judgments(id),
      recipient TEXT NOT NULL,
      amount_atomic TEXT NOT NULL,
      state TEXT NOT NULL,
      code TEXT,
      fail_kind TEXT,
      correlation_id TEXT,
      approval_id TEXT,
      approval_expires_at TEXT,
      vote TEXT,
      vote_correlation_id TEXT,
      failure_code TEXT,
      tx_hash TEXT,
      refund_tx_hash TEXT,
      resolution TEXT,
      retry_at TEXT,
      auto_retry INTEGER NOT NULL DEFAULT 0,
      scenario TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (contract_id, kind, seq, attempt)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_payout ON payout_attempts(contract_id)
      WHERE kind = 'payout' AND (state IN (${open}) OR (state = 'failed' AND resolution IS NULL));
    CREATE TABLE IF NOT EXISTS payout_lines (
      request_id TEXT NOT NULL REFERENCES payout_attempts(request_id),
      deliverable_id TEXT NOT NULL,
      amount_atomic TEXT NOT NULL,
      PRIMARY KEY (request_id, deliverable_id)
    );
    CREATE TABLE IF NOT EXISTS pr_reviews (
      contract_id TEXT NOT NULL REFERENCES contracts(id),
      pr_key TEXT NOT NULL,
      verdict TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (contract_id, pr_key)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id TEXT NOT NULL,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL
    );
  `);
  return db;
}

/** A database from the provider-adapter era can't be migrated: refuse it instead of guessing. */
function refuseOldSchema(db: Database) {
  const cols = db.query("SELECT name FROM pragma_table_info('contracts')").all() as { name: string }[];
  if (cols.length === 0) return;
  const names = new Set(cols.map((c) => c.name));
  if (names.has("credential_enc") || !names.has("organization"))
    throw new Error("This database was made by an older Covenant (provider adapter). Delete data/covenant.sqlite and start again.");
}
