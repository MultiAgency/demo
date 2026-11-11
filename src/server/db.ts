import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AttemptState, JudgmentOutcome, PayoutResolution } from "../shared/views";
import { OPEN_STATES } from "./payouts";
import type { JobSubmissionState } from "../shared/jobs";

export interface JobRow {
  id: string; contract_id: string; client_request_id: string; content_hash: string; revision: number;
  terms_hash: string; builder: string; report: string; evidence: string; judgment_id: string | null;
  proposed_atomic: string; state: JobSubmissionState; changes: string | null; created_at: string;
}
export interface JobInvoiceRow { id: string; submission_id: string; contract_id: string; number: string; amount_atomic: string }

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
  never_executed: number;
  refund_tx_hash: string | null;
  resolution: PayoutResolution | null;
  retry_at: string | null;
  auto_retry: number;
  scenario: string | null;
  /** request_conflict only: what the platform's own record under this request id reads (information, never acted on). */
  platform_record: string | null;
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

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { strict: true });
  try {
    refuseOldSchema(db);
    refuseUnprovenRejections(db);
    refuseUnprovenJobResolutions(db);
  } catch (error) {
    db.close();
    throw error;
  }
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
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
    CREATE TABLE IF NOT EXISTS job_submissions (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL REFERENCES contracts(id),
      client_request_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      revision INTEGER NOT NULL,
      terms_hash TEXT NOT NULL,
      builder TEXT NOT NULL,
      report TEXT NOT NULL,
      evidence TEXT NOT NULL,
      judgment_id TEXT UNIQUE REFERENCES judgments(id),
      proposed_atomic TEXT NOT NULL DEFAULT '0',
      state TEXT NOT NULL DEFAULT 'submitted',
      changes TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(contract_id, client_request_id),
      UNIQUE(contract_id, revision)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_submission ON job_submissions(contract_id)
      WHERE state IN ('submitted', 'proposed', 'changes_pending');
    CREATE TABLE IF NOT EXISTS job_invoices (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL UNIQUE REFERENCES job_submissions(id),
      contract_id TEXT NOT NULL REFERENCES contracts(id),
      number TEXT NOT NULL,
      amount_atomic TEXT NOT NULL,
      UNIQUE(contract_id, number)
    );
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
      platform_record TEXT,
      never_executed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (contract_id, kind, seq, attempt)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_payout ON payout_attempts(contract_id)
      WHERE kind = 'payout' AND (state IN (${open}) OR (state = 'failed' AND (resolution IS NULL OR resolution = 'disputed')));
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
  const attemptCols = new Set((db.query("SELECT name FROM pragma_table_info('payout_attempts')").all() as { name: string }[]).map((c) => c.name));
  if (!attemptCols.has("platform_record")) db.exec("ALTER TABLE payout_attempts ADD COLUMN platform_record TEXT");
  if (!attemptCols.has("never_executed")) db.exec("ALTER TABLE payout_attempts ADD COLUMN never_executed INTEGER NOT NULL DEFAULT 0");
  const index = db.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'one_open_payout'").get() as { sql: string } | null;
  if (index && !index.sql.includes("'disputed'")) db.transaction(() => {
    // Preserve every row while extending the existing monetary lock to business reviews closed as disputed.
    db.exec(`DROP INDEX one_open_payout; CREATE UNIQUE INDEX one_open_payout ON payout_attempts(contract_id)
      WHERE kind = 'payout' AND (state IN (${open}) OR (state = 'failed' AND (resolution IS NULL OR resolution = 'disputed')))`);
  })();
  return db;
}

/** A database from the provider-adapter era can't be migrated: refuse it instead of guessing. */
function refuseOldSchema(db: Database) {
  const cols = db.query("SELECT name FROM pragma_table_info('contracts')").all() as { name: string }[];
  if (cols.length === 0) return;
  const names = new Set(cols.map((c) => c.name));
  if (names.has("credential_enc") || !names.has("organization"))
    throw new Error("This database was made by an older Covenant (provider adapter). Preserve it; recovery or migration needs review before this app can use it.");
}

/** Older rejection inference was insufficient. Refuse it without rewriting history or freeing money. */
function refuseUnprovenRejections(db: Database) {
  const columns = db.query("SELECT name FROM pragma_table_info('payout_attempts')").all() as { name: string }[];
  if (!columns.length) return;
  const hasProof = columns.some((c) => c.name === "never_executed");
  const unproven = hasProof ? " AND COALESCE(never_executed, 0) != 1" : "";
  const row = db.query(`SELECT request_id FROM payout_attempts WHERE kind = 'payout' AND state = 'rejected'${unproven} LIMIT 1`).get() as { request_id: string } | null;
  if (row) throw new Error(`Payout ${row.request_id} was recorded as rejected without non-execution proof. Preserve this database and reconcile the original platform identities before continuing; no schema or records were changed.`);
}

/** A v3 manual resolution must not silently import budget freed by the earlier, weaker review rule. */
function refuseUnprovenJobResolutions(db: Database) {
  const columns = db.query("SELECT name FROM pragma_table_info('payout_attempts')").all() as { name: string }[];
  if (!columns.length) return;
  const proof = columns.some((c) => c.name === "never_executed") ? "p.never_executed" : "0";
  const rows = db.query(`SELECT p.request_id, p.tx_hash, p.refund_tx_hash, ${proof} AS never_executed, c.terms
    FROM payout_attempts p JOIN contracts c ON c.id = p.contract_id
    WHERE p.kind = 'payout' AND p.state = 'failed' AND p.resolution IN ('reowe', 'rejected')`).all() as {
      request_id: string; tx_hash: string | null; refund_tx_hash: string | null; never_executed: number; terms: string;
    }[];
  for (const row of rows) {
    let version: unknown;
    try { version = (JSON.parse(row.terms) as { v?: unknown }).v; } catch { continue; }
    if (version !== 3) continue; // This compatibility rule applies only to identifiable v3 jobs.
    if (row.never_executed === 1 && !row.tx_hash && !row.refund_tx_hash) continue;
    throw new Error(`Payout ${row.request_id} has a manual budget-releasing resolution without verifiable non-execution proof. Preserve this database and reconcile the original platform identities before continuing; no schema or records were changed.`);
  }
}
