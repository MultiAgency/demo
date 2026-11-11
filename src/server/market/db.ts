import type { Database } from "bun:sqlite";

/**
 * The market module's own tables: agencies (one market agent each), their owner steps and DAO votes, hires (client
 * side), and assignments and webhook deliveries (worker side). Nothing here is shared with contracts and payouts.
 */
export type AgencyStage = "needs_setup" | "needs_create" | "needs_consent" | "needs_grant" | "needs_registration" | "ready";

export interface AgencyRow {
  id: string;
  name: string;
  /** The platform Organization this agency's market agent belongs to. */
  organization: string;
  /** The owner's NEAR account: a wallet, or a Sputnik DAO. */
  owner: string;
  signer: "wallet" | "dao";
  owner_public_key: string | null;
  agent: string | null;
  agent_id: string | null;
  consent_id: string | null;
  consent_expires_at: string | null;
  stage: AgencyStage;
  /** The sign request issued last (wallet), so the signed body is rebuilt exactly. */
  pending_sign: string | null;
  /** The deposit address the platform gave last, JSON {address, expiresAt, at}. */
  deposit: string | null;
  created_at: string;
  updated_at: string;
}

/** A DAO vote Covenant filed: a setup, a consent, an owner action or a hire. */
export interface DaoVoteRow {
  id: string;
  agency_id: string;
  kind: "setup" | "consent" | "agent_create" | "grant_issue" | "hire";
  /** The owner step's correlation id, or the hire's requestId. */
  ref: string | null;
  hash: string;
  description: string;
  voting_until: number;
  /** A hire's approval: until when it may be paid, as the platform answered the filing (it caps what was asked). */
  valid_until: string | null;
  proposal: string | null;
  proposal_and_vote: string | null;
  state: "pending" | "done" | "expired";
  created_at: string;
  updated_at: string;
}

export interface MarketStepRow {
  correlation_id: string;
  agency_id: string;
  kind: "agent_create" | "grant_issue";
  intent: string | null;
  confirm_url: string | null;
  expires_at: string;
  summary: string;
  state: "prepared" | "submitted" | "success" | "failed" | "expired" | "unknown";
  failure_code: string | null;
  created_at: string;
  updated_at: string;
}

export type HireState = "quoted" | "voting" | "vote_expired" | "hiring" | "unknown" | "paid" | "not_charged" | "refused";

export interface HireRow {
  request_id: string;
  agency_id: string;
  handle: string;
  brief: string;
  /** The quoted terms, JSON (HireTerms): what the owner approves, or the DAO votes on. */
  terms: string;
  state: HireState;
  code: string | null;
  task_id: string | null;
  task_state: string | null;
  deliverable: string | null;
  dao_vote_id: string | null;
  approved_by: string | null;
  quoted_at: string;
  updated_at: string;
}

export type SubmitState = "none" | "submitting" | "submitted" | "unknown";

export interface AssignmentRow {
  assignment_id: string;
  job_id: string;
  title: string;
  description: string;
  status: string;
  escrow_amount: string | null;
  escrow_token: string | null;
  sla_deadline_at: string | null;
  deliverable: string | null;
  submit_state: SubmitState;
  submit_error: string | null;
  /** The agency's deposit address shown when the market accepted this job: where its earnings were to be withdrawn. */
  deposit_address: string | null;
  accepted_at: string | null;
  seen_at: string;
  updated_at: string;
}

export function migrateMarket(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_agencies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      organization TEXT NOT NULL UNIQUE,
      owner TEXT NOT NULL,
      signer TEXT NOT NULL,
      owner_public_key TEXT,
      agent TEXT,
      agent_id TEXT,
      consent_id TEXT,
      consent_expires_at TEXT,
      stage TEXT NOT NULL,
      pending_sign TEXT,
      deposit TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_dao_votes (
      id TEXT PRIMARY KEY,
      agency_id TEXT NOT NULL REFERENCES market_agencies(id),
      kind TEXT NOT NULL,
      ref TEXT,
      hash TEXT NOT NULL,
      description TEXT NOT NULL,
      voting_until INTEGER NOT NULL,
      valid_until TEXT,
      proposal TEXT,
      proposal_and_vote TEXT,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_steps (
      correlation_id TEXT PRIMARY KEY,
      agency_id TEXT NOT NULL REFERENCES market_agencies(id),
      kind TEXT NOT NULL,
      intent TEXT,
      confirm_url TEXT,
      expires_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      state TEXT NOT NULL,
      failure_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_hires (
      request_id TEXT PRIMARY KEY,
      agency_id TEXT NOT NULL REFERENCES market_agencies(id),
      handle TEXT NOT NULL,
      brief TEXT NOT NULL,
      terms TEXT NOT NULL,
      state TEXT NOT NULL,
      code TEXT,
      task_id TEXT,
      task_state TEXT,
      deliverable TEXT,
      dao_vote_id TEXT,
      approved_by TEXT,
      quoted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_assignments (
      assignment_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      escrow_amount TEXT,
      escrow_token TEXT,
      sla_deadline_at TEXT,
      deliverable TEXT,
      submit_state TEXT NOT NULL DEFAULT 'none',
      submit_error TEXT,
      deposit_address TEXT,
      accepted_at TEXT,
      seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_deliveries (
      delivery_id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
  `);
}

/** `UPDATE <table> SET ... WHERE <key> = ?`, stamping `updated_at`. */
export function update(db: Database, table: string, key: string, id: string, fields: Record<string, string | number | null>, now: string) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.query(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE ${key} = ?`).run(...Object.values(fields), now, id);
}
