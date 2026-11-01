import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
  agent_id: string | null;
  grant_id: string | null;
  grant_expires_at: string | null;
  credential_enc: string | null;
  frozen: number;
}

export type PayoutStatus =
  | "escalated" // waiting for the representative
  | "rejected" // representative declined an escalation
  | "persisted" // request + idempotency key saved, not yet confirmed sent
  | "queued" // accepted by the provider, waiting out the timelock
  | "paid"
  | "cancelled"
  | "refused" // the provider refused it (policy, budget, grant...)
  | "failed"
  | "needs_review"; // outcome unknown: never resent automatically

export interface PayoutRow {
  id: string;
  contract_id: string;
  period: string;
  score: string;
  amount_atomic: string;
  idem_key: string | null;
  request: string | null;
  status: PayoutStatus;
  correlation_id: string | null;
  dispatch_at: string | null;
  tx_hash: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntentRow {
  correlation_id: string;
  contract_id: string;
  type: string;
  prepared: string;
  credential_enc: string | null;
  payout_id: string | null;
  status: "prepared" | "submitted" | "failed";
  error: string | null;
  created_at: string;
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
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS contracts (
      id TEXT PRIMARY KEY,
      terms TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      contractor_link_hash TEXT NOT NULL,
      rep_sig TEXT,
      contractor_sig TEXT,
      agent_id TEXT,
      grant_id TEXT,
      grant_expires_at TEXT,
      credential_enc TEXT,
      frozen INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS intents (
      correlation_id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL REFERENCES contracts(id),
      type TEXT NOT NULL,
      prepared TEXT NOT NULL,
      credential_enc TEXT,
      payout_id TEXT,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payouts (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL REFERENCES contracts(id),
      period TEXT NOT NULL,
      score TEXT NOT NULL,
      amount_atomic TEXT NOT NULL,
      idem_key TEXT UNIQUE,
      request TEXT,
      status TEXT NOT NULL,
      correlation_id TEXT,
      dispatch_at TEXT,
      tx_hash TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
