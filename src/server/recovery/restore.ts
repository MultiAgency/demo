import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, hashCanonical } from "../../shared/canonical";
import { jobSubmissionSchema } from "../../shared/jobs";
import { fromAtomic, toAtomic } from "../../shared/money";
import { nonceFromString, verifyNep413 } from "../../shared/nep413";
import { parseTerms, termsHash, termsSigningMessage, USDC_DECIMALS } from "../../shared/terms";
import { OPEN_STATES, owedFor, planPayout, requestIdFor } from "../payouts";
import { digestSchema, recoveryBindingSchema, recoveryIdSchema, type EvidenceCollection, type RecoveryBinding } from "./evidence";
import { loadLedgerSnapshot } from "./inspect";
import { previewRecovery } from "./preview";

export type RestorationErrorCode = "invalid_request" | "invalid_snapshot" | "unsupported_schema" | "unsupported_case" | "invalid_terms" |
  "invalid_evidence" | "stale_evidence" | "correction_conflict" | "divergent_state";
export class RestorationError extends Error {
  constructor(readonly code: RestorationErrorCode) {
    super("Commitment restoration could not produce a corrected snapshot; no source write or resumption was authorized.");
    this.name = "RestorationError";
  }
}
export interface RestorationRequest {
  correction_id: string; request_id: string; binding: RecoveryBinding; collection: EvidenceCollection; collection_sha256: string;
}
export interface RestorationReceipt {
  schema_version: 1; result: "applied" | "already_applied"; correction_id: string; contract_id: string; request_id: string;
  judgment_id: string; submission_id: string | null; source_snapshot_sha256: string; output_snapshot_sha256: string;
  binding_sha256: string; collection_sha256: string; committed_before_atomic: "0"; committed_after_atomic: string;
  paid_before_atomic: "0"; paid_after_atomic: "0"; applied_at: string; clearance: "none";
}
type Row = Record<string, unknown>;
const OPERATION = "restore_commitment_v1";
const AUDIT_SQL = `CREATE TABLE recovery_corrections (
  correction_id TEXT PRIMARY KEY, operation TEXT NOT NULL, contract_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
  judgment_id TEXT NOT NULL, submission_id TEXT, source_snapshot_sha256 TEXT NOT NULL, binding_sha256 TEXT NOT NULL,
  collection_sha256 TEXT NOT NULL, inputs_json TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
  post_state_sha256 TEXT NOT NULL, applied_at TEXT NOT NULL, event_id INTEGER NOT NULL UNIQUE
)`;
const TRIGGERS = {
  recovery_corrections_no_update: "CREATE TRIGGER recovery_corrections_no_update BEFORE UPDATE ON recovery_corrections BEGIN SELECT RAISE(ABORT, 'append-only correction'); END",
  recovery_corrections_no_delete: "CREATE TRIGGER recovery_corrections_no_delete BEFORE DELETE ON recovery_corrections BEGIN SELECT RAISE(ABORT, 'append-only correction'); END",
};
// SQL keywords may vary in case/spacing; string literals define the monetary predicate and must stay exact.
const normalizeSql = (sql: string) => sql.replace(/'(?:''|[^'])*'|[^']+/g, part => part.startsWith("'") ? part :
  part.replace(/\bIF\s+NOT\s+EXISTS\b/gi, "").replace(/\s+/g, "").toLowerCase());
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function requireThat(value: unknown, code: RestorationErrorCode): asserts value { if (!value) throw new RestorationError(code); }
function one(db: Database, sql: string, ...args: string[]): Row {
  const rows = db.query(sql).all(...args) as Row[];
  requireThat(rows.length === 1, "unsupported_case");
  return rows[0]!;
}
const integer = (value: unknown) => typeof value === "bigint" ? value : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : null;
const positive = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,255}$/.test(value);

function checkSchema(db: Database): boolean {
  const objects = db.query("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all() as { type: string; name: string; sql: string | null }[];
  requireThat(objects.length <= 1000, "unsupported_schema");
  for (const item of objects) {
    if (item.type === "trigger") requireThat(Object.hasOwn(TRIGGERS, item.name) && normalizeSql(item.sql ?? "") === normalizeSql(TRIGGERS[item.name as keyof typeof TRIGGERS]), "unsupported_schema");
    if (item.type !== "table") continue;
    requireThat(!/^\s*CREATE\s+VIRTUAL\b/i.test(item.sql ?? ""), "unsupported_schema");
    const columns = db.query("SELECT hidden FROM pragma_table_xinfo(?)").all(item.name) as { hidden: bigint }[];
    requireThat(columns.length <= 128 && columns.every(column => column.hidden === 0n), "unsupported_schema");
    const count = db.query(`SELECT COUNT(*) AS count FROM ${quote(item.name)}`).get() as { count: bigint };
    requireThat(count.count <= 10_000n, "unsupported_schema");
  }
  const required: Record<string, string[]> = {
    contracts: ["id", "terms", "hash", "rep_sig", "contractor_sig", "signing_recipient"],
    payout_attempts: ["request_id", "kind", "contract_id", "seq", "attempt", "run_id", "recipient", "amount_atomic", "state", "resolution", "never_executed", "tx_hash", "refund_tx_hash", "refunded_amount", "platform_record", "auto_retry"],
    judgments: ["id", "contract_id", "json", "outcome", "closed_at"], payout_lines: ["request_id", "deliverable_id", "amount_atomic"],
    job_submissions: ["id", "contract_id", "judgment_id", "client_request_id", "content_hash", "revision", "terms_hash", "builder", "report", "evidence", "proposed_atomic", "state", "changes"],
    job_invoices: ["id", "contract_id", "submission_id", "number", "amount_atomic"], events: ["id", "contract_id", "at", "kind", "text"],
  };
  for (const [table, fields] of Object.entries(required)) {
    requireThat(objects.some(item => item.type === "table" && item.name === table), "unsupported_schema");
    const names = new Set((db.query("SELECT name FROM pragma_table_xinfo(?)").all(table) as { name: string }[]).map(row => row.name));
    requireThat(fields.every(field => names.has(field)), "unsupported_schema");
  }
  const eventColumns = db.query("SELECT name, type, pk FROM pragma_table_xinfo('events')").all() as { name: string; type: string; pk: bigint }[];
  const eventId = eventColumns.find(column => column.name === "id");
  // lastInsertRowid must be the actual public event ID, including SQLite's INTEGER PRIMARY KEY DESC exception.
  requireThat(eventId?.type.toUpperCase() === "INTEGER" && eventId.pk === 1n && eventColumns.filter(column => column.pk !== 0n).length === 1 &&
    !(db.query("SELECT origin FROM pragma_index_list('events')").all() as { origin: string }[]).some(index => index.origin === "pk"), "unsupported_schema");
  const open = OPEN_STATES.map(state => `'${state}'`).join(",");
  const indexes = {
    one_open_payout: `CREATE UNIQUE INDEX one_open_payout ON payout_attempts(contract_id) WHERE kind = 'payout' AND (state IN (${open}) OR (state = 'failed' AND (resolution IS NULL OR resolution = 'disputed')))`,
    one_open_judgment: "CREATE UNIQUE INDEX one_open_judgment ON judgments(contract_id) WHERE outcome = 'pending'",
    one_open_submission: "CREATE UNIQUE INDEX one_open_submission ON job_submissions(contract_id) WHERE state IN ('submitted', 'proposed', 'changes_pending')",
  };
  for (const [name, expected] of Object.entries(indexes)) requireThat(objects.some(item => item.type === "index" && item.name === name && normalizeSql(item.sql ?? "") === normalizeSql(expected)), "unsupported_schema");
  const audit = objects.find(item => item.name === "recovery_corrections");
  if (audit) requireThat(audit.type === "table" && normalizeSql(audit.sql ?? "") === normalizeSql(AUDIT_SQL) &&
    Object.keys(TRIGGERS).every(name => objects.some(item => item.type === "trigger" && item.name === name)), "unsupported_schema");
  else requireThat(!objects.some(item => Object.hasOwn(TRIGGERS, item.name)), "unsupported_schema");
  return !!audit;
}

/** Logical state includes private rows only as a digest, avoiding an impossible self-referential serialized-file hash. */
function stateDigest(db: Database, correctionId: string, pending?: Row): string {
  const schema = db.query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all() as Row[];
  const encode = (value: unknown): unknown => typeof value === "bigint" ? { integer: value.toString() } : typeof value === "number" ? { real: Object.is(value, -0) ? "-0" : String(value) } :
    value instanceof Uint8Array ? { blob: Buffer.from(value).toString("base64") } : value;
  const tables = schema.filter(row => row.type === "table").map(table => {
    const name = table.name as string;
    const layout = db.query("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?").get(name) as { wr: bigint };
    const columns = new Set((db.query("SELECT name FROM pragma_table_xinfo(?)").all(name) as { name: string }[]).map(row => row.name.toLowerCase()));
    const rowid = layout.wr === 1n ? null : ["rowid", "_rowid_", "oid"].find(alias => !columns.has(alias));
    requireThat(layout.wr === 1n || rowid, "unsupported_schema");
    let marker = "__recovery_hidden_rowid__";
    while (columns.has(marker)) marker += "_";
    // Row ordering affects owner-action selection. Bind the actual hidden rowid, never a shadowing named column.
    const rows = db.query(`SELECT ${rowid ? `${quote(rowid)} AS ${quote(marker)}, ` : ""}* FROM ${quote(name)}`).all() as Row[];
    if (name === "recovery_corrections" && pending) {
      const record = { ...pending, [marker]: pending.rowid };
      delete record.rowid;
      rows.push(record);
    }
    const values = rows.map(row => canonicalJson(Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      name === "recovery_corrections" && row.correction_id === correctionId && key === "post_state_sha256" ? null : encode(value),
    ])))).sort();
    return { name, rows: values };
  });
  return hashCanonical({ schema, tables });
}

function checkCase(db: Database, request: RestorationRequest, appliedAt: string | null) {
  const attempt = one(db, "SELECT * FROM payout_attempts WHERE request_id = ?", request.request_id);
  const contractId = request.binding.contract_id, contract = one(db, "SELECT * FROM contracts WHERE id = ?", contractId);
  requireThat(attempt.contract_id === contractId && attempt.kind === "payout" && attempt.state === "failed" &&
    attempt.resolution === (appliedAt === null ? "reowe" : "disputed") && [0n, null].includes(integer(attempt.never_executed)) &&
    (attempt.never_executed === null || integer(attempt.never_executed) === 0n) && attempt.platform_record === null && integer(attempt.auto_retry) === 0n &&
    integer(attempt.seq) === 1n && integer(attempt.attempt) === 1n && positive(attempt.amount_atomic), "unsupported_case");
  requireThat((db.query("SELECT request_id FROM payout_attempts WHERE contract_id = ?").all(contractId) as Row[]).length === 1, "unsupported_case");
  const judgment = one(db, "SELECT * FROM judgments WHERE contract_id = ?", contractId);
  requireThat(judgment.id === attempt.run_id && judgment.outcome === (appliedAt === null ? "pending" : "disputed") && judgment.closed_at === appliedAt, "unsupported_case");
  let terms: ReturnType<typeof parseTerms>;
  try {
    terms = parseTerms(JSON.parse(contract.terms as string));
    requireThat(termsHash(terms) === contract.hash && contract.hash === request.binding.terms_hash && canonicalJson(terms) === contract.terms &&
      ["covenant", "multiagency-paperwork"].includes(contract.signing_recipient as string), "invalid_terms");
    const signature = z.strictObject({ account_id: z.string(), public_key: z.string().max(256), signature: z.string().max(256), nonce: z.string().max(256), signed_at: z.iso.datetime() });
    for (const [field, account] of [["rep_sig", terms.representative.near_account], ["contractor_sig", terms.contractor.near_account]] as const) {
      const record = signature.parse(JSON.parse(contract[field] as string));
      requireThat(record.account_id === account && verifyNep413({ message: termsSigningMessage(contract.hash as string, contract.signing_recipient as "covenant" | "multiagency-paperwork"),
        nonce: nonceFromString(record.nonce), recipient: contract.signing_recipient as string }, record), "invalid_terms");
    }
  } catch { throw new RestorationError("invalid_terms"); }
  requireThat(attempt.recipient === terms.payee.address && attempt.request_id === requestIdFor(contract.hash as string, 1, 1), "unsupported_case");
  const judged = z.object({ decision: z.enum(["pay", "escalate"]), deliverables: z.array(z.object({ id: z.string(), completion: z.number().refine(value => [0, .25, .5, .75, 1].includes(value)) })).max(10) }).parse(JSON.parse(judgment.json as string));
  requireThat(judged.deliverables.length === terms.scope.length && new Set(judged.deliverables.map(row => row.id)).size === terms.scope.length &&
    judged.deliverables.every(row => terms.scope.some(item => item.id === row.id)), "unsupported_case");
  const completion = Object.fromEntries(judged.deliverables.map(row => [row.id, row.completion]));
  const submissions = db.query("SELECT * FROM job_submissions WHERE contract_id = ? ORDER BY revision DESC").all(contractId) as Row[];
  let submission: Row | null = null, invoiceCap: bigint | undefined;
  if (terms.v === 3) {
    submission = submissions[0] ?? null;
    requireThat(submission && submission.judgment_id === judgment.id && submission.terms_hash === contract.hash && submission.builder === terms.contractor.near_account &&
      submission.changes === null && submission.state === (appliedAt === null ? "proposed" : "disputed") &&
      submissions.slice(1).every(row => ["closed", "changes_requested", "settled"].includes(row.state as string)), "unsupported_case");
    const invoice = one(db, "SELECT * FROM job_invoices WHERE submission_id = ?", submission.id as string);
    requireThat(invoice.contract_id === contractId && positive(invoice.amount_atomic) && positive(submission.proposed_atomic), "unsupported_case");
    invoiceCap = BigInt(invoice.amount_atomic);
    const body = jobSubmissionSchema.parse({ client_request_id: submission.client_request_id, report: submission.report, evidence: JSON.parse(submission.evidence as string),
      invoice: { number: invoice.number, amount_usd: fromAtomic(invoiceCap, USDC_DECIMALS) } });
    requireThat(hashCanonical(body) === submission.content_hash && body.evidence.every(row => terms.scope.some(item => item.id === row.deliverable_id)), "unsupported_case");
    const owed = owedFor(terms, completion, new Map()).reduce((sum, row) => sum + row.amount, 0n);
    requireThat(BigInt(submission.proposed_atomic) === (owed < invoiceCap ? owed : invoiceCap) && invoiceCap <= terms.scope.reduce((sum, row) => sum + toAtomic(row.value_usd, USDC_DECIMALS), 0n), "unsupported_case");
  } else requireThat(submissions.length === 0 && (db.query("SELECT id FROM job_invoices WHERE contract_id = ?").all(contractId) as Row[]).length === 0, "unsupported_case");
  const plan = planPayout(terms, completion, new Map(), invoiceCap);
  const lines = db.query("SELECT deliverable_id, amount_atomic FROM payout_lines WHERE request_id = ?").all(request.request_id) as Row[];
  requireThat(plan && plan.amount.toString() === attempt.amount_atomic && canonicalJson(lines.map(row => ({ deliverable_id: row.deliverable_id, amount_atomic: row.amount_atomic })).sort((a, b) => String(a.deliverable_id).localeCompare(String(b.deliverable_id)))) ===
    canonicalJson(plan.lines.map(row => ({ deliverable_id: row.deliverable_id, amount_atomic: row.amount.toString() })).sort((a, b) => a.deliverable_id.localeCompare(b.deliverable_id))), "unsupported_case");
  return { attempt, judgment, submission, contractId, amount: attempt.amount_atomic as string };
}

/** Transform operator-private bytes in memory only. No filesystem writes, platform reads, startup or permission to resume. */
export function restoreCommitment(path: string, input: RestorationRequest, options: { now?: () => Date } = {}): { snapshot_bytes: Uint8Array; receipt: RestorationReceipt } {
  let db: Database | undefined;
  try {
    const parsed = z.strictObject({ correction_id: recoveryIdSchema, request_id: recoveryIdSchema, binding: recoveryBindingSchema,
      collection: z.unknown(), collection_sha256: digestSchema }).safeParse(input);
    requireThat(parsed.success, "invalid_request");
    const request = JSON.parse(canonicalJson(parsed.data)) as RestorationRequest, inputsJson = canonicalJson(request);
    requireThat(hashCanonical(request.collection) === request.collection_sha256 && canonicalJson(request.binding) === canonicalJson(request.collection.binding), "invalid_evidence");
    let loaded: ReturnType<typeof loadLedgerSnapshot>;
    try { loaded = loadLedgerSnapshot(path); } catch { throw new RestorationError("invalid_snapshot"); }
    db = Database.deserialize(loaded.bytes, { strict: true, safeIntegers: true });
    // This isolated transform must not cascade writes through an input schema's foreign keys.
    db.exec("PRAGMA temp_store = MEMORY; PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = OFF;");
    const hasAudit = checkSchema(db);
    const prior = hasAudit ? db.query("SELECT * FROM recovery_corrections WHERE correction_id = ?").get(request.correction_id) as Row | null : null;
    const clock = options.now?.() ?? new Date();
    requireThat(Number.isFinite(clock.getTime()), "invalid_request");
    const appliedAt = prior ? prior.applied_at as string : clock.toISOString();
    const receiptFor = (result: RestorationReceipt["result"], source: string, output: Uint8Array, row: ReturnType<typeof checkCase>): RestorationReceipt => ({
      schema_version: 1, result, correction_id: request.correction_id, contract_id: row.contractId, request_id: request.request_id,
      judgment_id: row.judgment.id as string, submission_id: row.submission?.id as string ?? null, source_snapshot_sha256: source, output_snapshot_sha256: sha(output),
      binding_sha256: hashCanonical(request.binding), collection_sha256: request.collection_sha256, committed_before_atomic: "0", committed_after_atomic: row.amount,
      paid_before_atomic: "0", paid_after_atomic: "0", applied_at: appliedAt, clearance: "none",
    });
    if (prior) {
      requireThat(prior.operation === OPERATION && prior.inputs_json === inputsJson && prior.request_id === request.request_id && prior.contract_id === request.binding.contract_id &&
        prior.source_snapshot_sha256 === request.binding.snapshot_sha256 && prior.binding_sha256 === hashCanonical(request.binding) && prior.collection_sha256 === request.collection_sha256, "correction_conflict");
      const row = checkCase(db, request, appliedAt);
      requireThat(stateDigest(db, request.correction_id) === prior.post_state_sha256, "divergent_state");
      return { snapshot_bytes: loaded.bytes, receipt: receiptFor("already_applied", prior.source_snapshot_sha256 as string, loaded.bytes, row) };
    }
    if (hasAudit) requireThat(!db.query("SELECT 1 FROM recovery_corrections WHERE request_id = ?").get(request.request_id), "correction_conflict");
    requireThat(loaded.inspection.snapshot.sha256 === request.binding.snapshot_sha256, "invalid_evidence");
    let preview: ReturnType<typeof previewRecovery>;
    try { preview = previewRecovery(loaded.inspection, request.collection); } catch { throw new RestorationError("invalid_evidence"); }
    const observations = [...request.collection.payouts, ...request.collection.payments, ...request.collection.owners, request.collection.held];
    requireThat([request.collection.completed_at, ...observations.map(row => row.completed_at)].every(at => {
      const age = clock.getTime() - Date.parse(at); return age >= 0 && age <= 5 * 60_000;
    }), "stale_evidence");
    const forbidden = new Set(["foreign_request_id", "changed_payment_correlation", "changed_approval_id", "original_request_mismatch", "held_request_mismatch"]);
    requireThat(preview.items.length === 1 && preview.items[0]!.request_id === request.request_id && !preview.items[0]!.reason_codes.some(code => forbidden.has(code)) &&
      request.collection.payouts.every(row => !row.result.ok || (row.result.value.state !== "succeeded" && row.result.value.status !== "SUCCESS")) &&
      request.collection.payments.every(row => !row.result.ok || (row.result.value.status !== "SUCCESS" && [row.result.value.tx_hash, row.result.value.destination_tx_hash, row.result.value.refund_tx_hash, row.result.value.refunded_amount].every(value => value === null))), "invalid_evidence");
    const row = checkCase(db, request, null);
    for (const table of hasAudit ? ["events", "recovery_corrections"] : ["events"]) {
      const count = db.query(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get() as { count: bigint };
      requireThat(count.count < 10_000n, "unsupported_schema");
    }
    const before = { payout: { request_id: request.request_id, resolution: "reowe" }, judgment: { id: row.judgment.id, outcome: "pending", closed_at: null },
      submission: row.submission ? { id: row.submission.id, state: "proposed" } : null };
    const after = { payout: { request_id: request.request_id, resolution: "disputed" }, judgment: { id: row.judgment.id, outcome: "disputed", closed_at: appliedAt },
      submission: row.submission ? { id: row.submission.id, state: "disputed" } : null };
    db.transaction(() => {
      if (!hasAudit) { db!.exec(AUDIT_SQL); for (const sql of Object.values(TRIGGERS)) db!.exec(sql); }
      // Override schema-level REPLACE/IGNORE policies: a conflict must abort, never remove history or skip a write.
      requireThat(db!.query("UPDATE OR ABORT payout_attempts SET resolution = 'disputed' WHERE request_id = ? AND state = 'failed' AND resolution = 'reowe'").run(request.request_id).changes === 1, "divergent_state");
      requireThat(db!.query("UPDATE OR ABORT judgments SET outcome = 'disputed', closed_at = ? WHERE id = ? AND outcome = 'pending' AND closed_at IS NULL").run(appliedAt, row.judgment.id as string).changes === 1, "divergent_state");
      if (row.submission) requireThat(db!.query("UPDATE OR ABORT job_submissions SET state = 'disputed' WHERE id = ? AND state = 'proposed' AND changes IS NULL").run(row.submission.id as string).changes === 1, "divergent_state");
      const event = db!.query("INSERT OR ABORT INTO events (contract_id, at, kind, text) VALUES (?, ?, 'recovery_correction', ?)").run(row.contractId, appliedAt, canonicalJson({ correction_id: request.correction_id, operation: OPERATION }));
      const next = db!.query("SELECT COALESCE(MAX(rowid), 0) + 1 AS next FROM recovery_corrections").get() as { next: bigint };
      requireThat(typeof next.next === "bigint" && next.next > 0n && next.next < 9_223_372_036_854_775_807n, "unsupported_schema");
      const audit: Row = { rowid: next.next, correction_id: request.correction_id, operation: OPERATION, contract_id: row.contractId, request_id: request.request_id,
        judgment_id: row.judgment.id, submission_id: row.submission?.id ?? null, source_snapshot_sha256: loaded.inspection.snapshot.sha256,
        binding_sha256: hashCanonical(request.binding), collection_sha256: request.collection_sha256, inputs_json: inputsJson, before_json: canonicalJson(before), after_json: canonicalJson(after),
        post_state_sha256: null, applied_at: appliedAt, event_id: BigInt(event.lastInsertRowid) };
      audit.post_state_sha256 = stateDigest(db!, request.correction_id, audit);
      db!.query(`INSERT OR ABORT INTO recovery_corrections (${Object.keys(audit).map(quote).join(",")}) VALUES (${Object.keys(audit).map(() => "?").join(",")})`)
        .run(...Object.values(audit) as (string | bigint | null)[]);
      checkSchema(db!);
      requireThat(stateDigest(db!, request.correction_id) === audit.post_state_sha256, "divergent_state");
    })();
    const output = db.serialize();
    requireThat(output.byteLength <= 64 * 1024 * 1024 && output[18] === 1 && output[19] === 1, "unsupported_schema");
    return { snapshot_bytes: output, receipt: receiptFor("applied", loaded.inspection.snapshot.sha256, output, row) };
  } catch (error) {
    if (error instanceof RestorationError) throw error;
    throw new RestorationError("unsupported_case");
  } finally { db?.close(); }
}
