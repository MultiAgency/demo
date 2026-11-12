import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectLedger } from "../../src/server/recovery/inspect";
import type { RecoveryBinding } from "../../src/server/recovery/evidence";

/** Standalone synthetic records; deliberately no application runtime, auth or source state is copied. */
export function recoveryLedger(version: 2 | 3 = 3) {
  const directory = mkdtempSync(join(tmpdir(), "paperwork-recovery-evidence-"));
  const path = join(directory, "snapshot.sqlite");
  const db = new Database(path, { strict: true });
  try {
    db.exec(`PRAGMA journal_mode=DELETE;
      CREATE TABLE app_identity(id INTEGER PRIMARY KEY, deployment TEXT);
      CREATE TABLE contracts(id TEXT PRIMARY KEY, terms TEXT, hash TEXT, organization TEXT, signing_recipient TEXT);
      CREATE TABLE platform_agents(organization TEXT PRIMARY KEY, agent TEXT, agent_id TEXT);
      CREATE TABLE judgments(id TEXT PRIMARY KEY, contract_id TEXT, outcome TEXT);
      CREATE TABLE job_submissions(id TEXT PRIMARY KEY, contract_id TEXT, judgment_id TEXT);
      CREATE TABLE job_invoices(id TEXT PRIMARY KEY, contract_id TEXT, submission_id TEXT);
      CREATE TABLE payout_attempts(request_id TEXT PRIMARY KEY, kind TEXT, contract_id TEXT, seq INTEGER, attempt INTEGER,
        run_id TEXT, recipient TEXT, amount_atomic TEXT, state TEXT, code TEXT, correlation_id TEXT, approval_id TEXT,
        vote_correlation_id TEXT, never_executed INTEGER, tx_hash TEXT, refund_tx_hash TEXT, refunded_amount TEXT, resolution TEXT);
      CREATE TABLE payout_lines(request_id TEXT, deliverable_id TEXT, amount_atomic TEXT);
      CREATE TABLE owner_steps(correlation_id TEXT PRIMARY KEY, contract_id TEXT, organization TEXT, kind TEXT, state TEXT, request_id TEXT, verdict TEXT);
      INSERT INTO app_identity VALUES(1,'fixture-deployment');
      INSERT INTO platform_agents VALUES('fixture-organization','fixture-agent','fixture-agent-id');
      INSERT INTO judgments VALUES('fixture-judgment','fixture-job','rejected');
      INSERT INTO payout_attempts VALUES('fixture-request','payout','fixture-job',1,1,'fixture-judgment','builder.demo','300000000',
        'failed',NULL,'fixture-payment','fixture-approval','fixture-owner',0,NULL,NULL,NULL,'reowe');
      INSERT INTO payout_lines VALUES('fixture-request','d1','300000000');
      INSERT INTO owner_steps VALUES('fixture-owner','fixture-job','fixture-organization','approval_vote','unknown','fixture-request','approve');
    `);
    db.query("INSERT INTO contracts VALUES(?,?,?,?,?)").run("fixture-job", JSON.stringify({ v: version }), "a".repeat(64), "fixture-organization", "covenant");
  } finally { db.close(); }
  const inspection = inspectLedger(path);
  const binding: RecoveryBinding = {
    schema_version: 1, snapshot_sha256: inspection.snapshot.sha256, provenance_sha256: "b".repeat(64), platform_origin: "https://platform.invalid",
    deployment: "fixture-deployment", contract_id: "fixture-job", terms_hash: "a".repeat(64), organization: "fixture-organization", agent: "fixture-agent", agent_id: "fixture-agent-id",
  };
  return { directory, path, inspection, binding };
}
