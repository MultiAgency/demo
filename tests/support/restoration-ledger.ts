import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runtime } from "../../src/server/app";
import { collectRecoveryEvidence, evidenceDigest } from "../../src/server/recovery/collect";
import type { EvidenceCollection, ReadResult, RecoveryReader } from "../../src/server/recovery/evidence";
import { inspectLedger } from "../../src/server/recovery/inspect";
import { DEMO_TERMS, JOB_DEMO_TERMS } from "../../src/shared/demo";
import { scopeTotal, USDC_NEAR } from "../../src/shared/terms";
import { activate, castVote, START } from "./harness";

export const RESTORATION_NOW = new Date(START + 1000);
export const restorationDb = (rt: Runtime) => (rt.engine as unknown as { d: { db: Database } }).d.db;

export async function closeRestorationRuntime(rt: Runtime) {
  await (await rt.auth.$context).checkSchema?.();
  restorationDb(rt).close(true);
}

/** Read bytes into memory so inspecting a fixture cannot create SQLite sidecars. */
export function restorationRows(path: string) {
  const db = Database.deserialize(readFileSync(path), { readonly: true, strict: true });
  try {
    const names = db.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    return Object.fromEntries(names.map(({ name }) => [name,
      db.query(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all() as Record<string, unknown>[],
    ]));
  } finally { db.close(); }
}

export async function restorationEvidence(path: string, contractId?: string) {
  const inspection = inspectLedger(path), job = contractId === undefined ? inspection.jobs[0]! : inspection.jobs.find(row => row.id === contractId)!;
  const attempt = inspection.attempts.find(row => row.contract_id === job.id)!;
  const binding = {
    schema_version: 1 as const, snapshot_sha256: inspection.snapshot.sha256, provenance_sha256: "b".repeat(64),
    platform_origin: "https://platform.invalid", deployment: inspection.deployment!, contract_id: job.id,
    terms_hash: job.terms_hash!, organization: job.organization!, agent: job.agent!.name!, agent_id: job.agent!.id!,
  };
  const good = <T>(value: T): ReadResult<T> => ({ ok: true, value, response_sha256: evidenceDigest(value) });
  const reader: RecoveryReader = {
    origin: binding.platform_origin, deployment: binding.deployment, sdk_version: "0.5.7",
    async payoutStatus(_, requestId) { return good({ request_id: requestId, state: "failed", status: "FAILED", correlation_id: attempt.payout_correlation_id, never_executed: false }); },
    async paymentStatus() { return good({ status: "FAILED", approval_id: attempt.approval_id, tx_hash: null, destination_tx_hash: null, refund_tx_hash: null, refunded_amount: null,
      request: { recipient: attempt.recipient!, amount: attempt.amount_atomic!, asset: USDC_NEAR, chain: "near", confidential: true, has_memo: false } }); },
    async ownerStatus() { return good({ stage: "unknown", phase: null, status: null }); },
    async held() { return good([]); },
  };
  const collection = await collectRecoveryEvidence(inspection, binding, reader, { now: () => RESTORATION_NOW });
  return { inspection, input: { correction_id: "fixture-restore-original", request_id: attempt.request_id, binding, collection, collection_sha256: evidenceDigest(collection) } };
}

/** Fixture evidence changes are explicit observations, never inferred from a failure code. */
export function changeRestorationEvidence(input: Awaited<ReturnType<typeof restorationEvidence>>["input"], change: (collection: EvidenceCollection) => void) {
  const result = structuredClone(input);
  change(result.collection);
  result.collection_sha256 = evidenceDigest(result.collection);
  return result;
}

/** Build through the actual signed workflow, then model an old manual release only in our closed fixture copy. */
export async function restorationLedger(version: 2 | 3 = 3, options: { partial?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "paperwork-restoration-"));
  const runtimeDirectory = join(directory, "runtime"), backupDirectory = join(directory, "backup");
  mkdirSync(runtimeDirectory); mkdirSync(backupDirectory);
  const runtimePath = join(runtimeDirectory, "paperwork.sqlite"), backup = join(backupDirectory, "paperwork.sqlite"), path = join(directory, "snapshot.sqlite");
  const terms = version === 2 ? options.partial ? DEMO_TERMS : { ...DEMO_TERMS, scope: [DEMO_TERMS.scope[0]!] } : options.partial ? { ...JOB_DEMO_TERMS, scope: [
    { ...JOB_DEMO_TERMS.scope[0]!, value_usd: "150" },
    { ...JOB_DEMO_TERMS.scope[0]!, id: "d2", title: "CSV documentation", value_usd: "150" },
  ] } : JOB_DEMO_TERMS;
  const ctx = await activate(scopeTotal(terms), terms, { DB_PATH: runtimePath }).catch(error => {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  });
  let submissionId: string | null = null;
  try {
    if (version === 3) {
      const submission = await ctx.rt.engine.submitJob(ctx.id, {
        client_request_id: "restoration-original-submission", report: "PRIVATE-RESTORATION-REPORT: CSV export and tests are ready for agency review.",
        evidence: terms.scope.map(item => ({ deliverable_id: item.id, label: `${item.id} acceptance tests`, url: `https://evidence.invalid/${item.id}` })),
        invoice: { number: "PRIVATE-RESTORATION-INVOICE", amount_usd: "300" },
      }, JOB_DEMO_TERMS.contractor.near_account);
      submissionId = submission.id;
    }
    const proposed = submissionId ? await ctx.rt.engine.proposeJob(submissionId) : await ctx.rt.engine.run(ctx.id);
    const payout = proposed.payouts[0]!;
    await castVote(ctx, payout.request_id, "approve");
    Object.assign(ctx.stub.payouts.get(payout.request_id)!, { state: "failed", status: "FAILED", failureCode: "delivery_outcome_unknown", txHash: null });
    await ctx.rt.engine.getContract(ctx.id);
    const requestId = payout.request_id, judgmentId = ctx.rt.engine.attempt(requestId).run_id!;
    await closeRestorationRuntime(ctx.rt);
    // The original fixture runtime is closed. Only the separate backup may be checkpointed or edited.
    cpSync(runtimePath, backup);
    if (existsSync(`${runtimePath}-wal`)) cpSync(`${runtimePath}-wal`, `${backup}-wal`);
    const db = new Database(backup, { strict: true });
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
      db.query("UPDATE payout_attempts SET resolution = 'reowe', never_executed = 0 WHERE request_id = ? AND state = 'failed'").run(requestId);
    } finally { db.close(true); }
    // Bun may leave an orphan SHM for the backup. The standalone snapshot gets only its committed DELETE main file.
    cpSync(backup, path);
    const { inspection, input } = await restorationEvidence(path);
    return { directory, path, ctx, requestId, judgmentId, submissionId, inspection, input, terms, version };
  } catch (error) {
    try { await closeRestorationRuntime(ctx.rt); } catch { /* An earlier stage may already have closed this owned fixture. */ }
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export type RestorationFixture = Awaited<ReturnType<typeof restorationLedger>>;

/** Add a declared conflict policy while retaining the fixture's columns, rowids and explicit indexes. */
export function addRestorationConflictConstraint(db: Database,
  table: "events" | "payout_attempts" | "judgments" | "job_submissions", column: string, policy: "REPLACE" | "IGNORE") {
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const { sql } = db.query("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as { sql: string };
  const columns = (db.query("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map(row => row.name);
  if (!columns.includes(column)) throw new Error("Unknown fixture conflict column");
  const indexes = db.query("SELECT sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name").all(table) as { sql: string }[];
  const temporary = `fixture_constrained_${table}`, end = sql.lastIndexOf(")");
  const create = `${sql.slice(0, end)}, UNIQUE (${quote(column)}) ON CONFLICT ${policy}${sql.slice(end)}`
    .replace(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|\w+)/i, `CREATE TABLE ${quote(temporary)}`);
  const fields = ["rowid", ...columns].map(quote).join(", ");
  db.exec("PRAGMA foreign_keys = OFF");
  db.transaction(() => {
    db.exec(create);
    db.exec(`INSERT INTO ${quote(temporary)} (${fields}) SELECT ${fields} FROM ${quote(table)}`);
    db.exec(`DROP TABLE ${quote(table)}; ALTER TABLE ${quote(temporary)} RENAME TO ${quote(table)}`);
    for (const index of indexes) db.exec(index.sql);
  })();
}

/** Separate synthetic history ensures a conflicting UPDATE cannot pass by deleting another job's row. */
export function seedUnrelatedRestorationJob(db: Database, f: RestorationFixture, eventKind = "recovery_correction") {
  const ids = { contract: "fixture-unrelated-job", judgment: "fixture-unrelated-judgment", request: "fixture-unrelated-request",
    submission: "fixture-unrelated-submission", organization: "fixture-unrelated-organization" };
  const row = (table: string, key: string, value: string) => db.query(`SELECT * FROM ${table} WHERE ${key} = ?`).get(value) as Record<string, unknown>;
  const insert = (table: string, values: Record<string, unknown>) => {
    const names = Object.keys(values);
    db.query(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
      .run(...Object.values(values) as (string | number | null)[]);
  };
  const contract = row("contracts", "id", f.ctx.id);
  insert("contracts", { ...contract, id: ids.contract, hash: "e".repeat(64), organization: ids.organization, rep_sig: null, contractor_sig: null });
  insert("platform_agents", { ...row("platform_agents", "organization", String(contract.organization)), organization: ids.organization,
    agent: "fixture-unrelated-agent", agent_id: "fixture-unrelated-agent-id" });
  insert("judgments", { ...row("judgments", "id", f.judgmentId), id: ids.judgment, contract_id: ids.contract,
    outcome: "disputed", closed_at: RESTORATION_NOW.toISOString() });
  insert("payout_attempts", { ...row("payout_attempts", "request_id", f.requestId), request_id: ids.request, contract_id: ids.contract,
    run_id: ids.judgment, resolution: "disputed", correlation_id: "fixture-unrelated-payment", approval_id: null, vote_correlation_id: null });
  db.query("INSERT INTO payout_lines SELECT ?, deliverable_id, amount_atomic FROM payout_lines WHERE request_id = ?").run(ids.request, f.requestId);
  if (f.submissionId) {
    insert("job_submissions", { ...row("job_submissions", "id", f.submissionId), id: ids.submission, contract_id: ids.contract,
      judgment_id: ids.judgment, state: "disputed", terms_hash: "e".repeat(64) });
    const invoice = row("job_invoices", "submission_id", f.submissionId);
    insert("job_invoices", { ...invoice, id: "fixture-unrelated-invoice", contract_id: ids.contract, submission_id: ids.submission });
  }
  db.query("INSERT INTO events (contract_id, at, kind, text) VALUES (?, ?, ?, 'PRIVATE-unrelated-retained-event')")
    .run(ids.contract, RESTORATION_NOW.toISOString(), eventKind);
  return ids;
}
