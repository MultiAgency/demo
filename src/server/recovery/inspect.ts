import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";

export type LedgerInspectionErrorCode = "snapshot_required" | "invalid_snapshot" | "unsupported_schema" | "snapshot_changed";

export class LedgerInspectionError extends Error {
  constructor(readonly code: LedgerInspectionErrorCode, message: string) {
    super(message);
    this.name = "LedgerInspectionError";
  }
}

interface Finding {
  code: string;
  message: string;
  request_id?: string;
  contract_id?: string;
  table?: string;
  column?: string;
}

interface InspectedAttempt {
  request_id: string;
  contract_id: string;
  kind: string | null;
  seq: number | null;
  attempt: number | null;
  judgment_id: string | null;
  recipient: string | null;
  amount_atomic: string | null;
  state: string | null;
  resolution: string | null;
  code: string | null;
  payout_correlation_id: string | null;
  approval_id: string | null;
  owner_step_correlation_id: string | null;
  never_executed: boolean | null;
  tx_hash: string | null;
  refund_tx_hash: string | null;
  refunded_amount: string | null;
  /** Retained payment status that contradicts non-execution (REFUNDED); null when absent or not recorded by older versions. */
  counterevidence: string | null;
  lines: { deliverable_id: string | null; amount_atomic: string | null }[];
  same_obligation_request_ids: string[];
  other_same_job_request_ids: string[];
}

export interface LedgerInspection {
  schema_version: 1;
  snapshot: { sha256: string; bytes: number };
  deployment: string | null;
  host: null;
  tables: { name: string; columns: string[] }[];
  jobs: {
    id: string;
    terms_version: number | null;
    terms_hash: string | null;
    organization: string | null;
    signing_recipient: string | null;
    agent: { name: string | null; id: string | null } | null;
    submission_ids: string[];
    invoice_ids: string[];
    judgment_ids: string[];
    payout_request_ids: string[];
  }[];
  attempts: InspectedAttempt[];
  owner_steps: {
    correlation_id: string;
    contract_id: string | null;
    organization: string | null;
    kind: string | null;
    state: string | null;
    request_id: string | null;
    verdict: string | null;
  }[];
  findings: Finding[];
  summary: { job_count: number; attempt_count: number; unproven_release_count: number; contradiction_count: number; requires_review: boolean };
  limitations: string[];
}

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_ROWS_PER_TABLE = 10_000;
const MAX_ATTEMPTS_PER_JOB = 200;
const SIDECARS = ["-wal", "-shm", "-journal"] as const;
// SQL identifiers come only from this allowlist, never from database rows or CLI arguments.
const PROJECTIONS = {
  app_identity: ["id", "deployment"],
  contracts: ["id", "terms", "hash", "organization", "signing_recipient"],
  platform_agents: ["organization", "agent", "agent_id"],
  payout_attempts: ["request_id", "kind", "contract_id", "seq", "attempt", "run_id", "recipient", "amount_atomic", "state", "code", "correlation_id", "approval_id", "vote_correlation_id", "never_executed", "tx_hash", "refund_tx_hash", "refunded_amount", "counterevidence", "resolution"],
  payout_lines: ["request_id", "deliverable_id", "amount_atomic"],
  owner_steps: ["correlation_id", "contract_id", "organization", "kind", "state", "request_id", "verdict"],
  job_submissions: ["id", "contract_id", "judgment_id"],
  job_invoices: ["id", "contract_id", "submission_id"],
  judgments: ["id", "contract_id", "outcome"],
} as const;
type Table = keyof typeof PROJECTIONS;
type Row = Record<string, unknown>;
const string = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const integer = (value: unknown): number | null => {
  if (typeof value === "bigint") return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
};
const amount = (value: unknown): string | null => {
  const text = typeof value === "bigint" ? value.toString() : string(value);
  return text !== null && text.length <= 256 && /^\d+$/.test(text) ? text : null;
};
const ATTEMPT_STATES = new Set(["pending", "blocked", "waiting", "unknown", "held", "processing", "failed", "refused", "rejected", "dropped", "paid"]);
const RESOLUTIONS = new Set(["arrived", "reowe", "rejected", "disputed"]);
const OWNER_STATES = new Set(["prepared", "submitted", "success", "failed", "expired", "unknown"]);
const OWNER_KINDS = new Set(["agent_create", "grant_issue", "policy_update", "approval_vote", "agent_freeze"]);

function groupBy<T>(items: readonly T[], key: (item: T) => string | null): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    if (id === null) continue;
    const group = grouped.get(id);
    if (group) group.push(item);
    else grouped.set(id, [item]);
  }
  return grouped;
}

function identity(value: unknown): string {
  const id = string(value);
  if (!id) throw new LedgerInspectionError("unsupported_schema", "The snapshot contains missing ledger identities; no inventory was produced.");
  return id;
}

function assertNoSidecars(path: string) {
  for (const suffix of SIDECARS) {
    try { lstatSync(`${path}${suffix}`); }
    catch (error) {
      if ((error as { code?: string }).code === "ENOENT") continue;
      throw error;
    }
    throw new LedgerInspectionError("snapshot_required", "Use a consistent standalone snapshot without WAL, SHM or journal sidecars. The inspector never checkpoints a database.");
  }
}

function sameFile(a: Stats, b: Stats) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function readBytes(fd: number, size: number): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  for (let offset = 0; offset < size;) {
    const read = readSync(fd, bytes, offset, size - offset, offset);
    if (!read) throw new LedgerInspectionError("snapshot_changed", "The snapshot changed while being read; no inventory was produced.");
    offset += read;
  }
  return bytes;
}

function hashDescriptor(fd: number, size: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(size, 64 * 1024));
  for (let offset = 0; offset < size;) {
    const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!read) throw new LedgerInspectionError("snapshot_changed", "The snapshot changed during inspection; no inventory was produced.");
    hash.update(buffer.subarray(0, read));
    offset += read;
  }
  return hash.digest("hex");
}

/** Inspect only an operator-prepared snapshot. No application runtime, migrations or external calls. */
export function inspectLedger(path: string): LedgerInspection {
  return loadLedgerSnapshot(path).inspection;
}

/** Securely load one immutable snapshot. Raw bytes are operator-private database contents: never report or log them. */
export function loadLedgerSnapshot(path: string): { inspection: LedgerInspection; bytes: Uint8Array } {
  let fd: number | undefined;
  let db: Database | undefined;
  try {
    if (!path || path === ":memory:" || path.startsWith("file:"))
      throw new LedgerInspectionError("snapshot_required", "Provide one existing standalone SQLite snapshot file.");
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_SNAPSHOT_BYTES)
      throw new LedgerInspectionError("snapshot_required", "Use a regular standalone SQLite snapshot no larger than 64 MiB; symlinks are not supported.");
    if (before.size < 100)
      throw new LedgerInspectionError("invalid_snapshot", "The input is not a supported SQLite snapshot.");
    assertNoSidecars(path);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!sameFile(before, fstatSync(fd)))
      throw new LedgerInspectionError("snapshot_changed", "The snapshot changed before inspection; no inventory was produced.");
    const bytes = readBytes(fd, before.size);
    if (bytes.subarray(0, 16).toString("ascii") !== "SQLite format 3\0")
      throw new LedgerInspectionError("invalid_snapshot", "The input is not a supported SQLite snapshot.");
    if (bytes[18] !== 1 || bytes[19] !== 1)
      throw new LedgerInspectionError("snapshot_required", "Use a standalone rollback-journal-format snapshot. WAL-format input is refused even when its sidecars are absent.");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // Even readonly file-backed SQLite can write WAL shared memory. Never give SQLite a source path.
    db = Database.deserialize(bytes, { readonly: true, strict: true, safeIntegers: true });
    const integrity = db.query("SELECT * FROM pragma_quick_check").all() as Row[];
    if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== "ok")
      throw new LedgerInspectionError("invalid_snapshot", "SQLite integrity checks failed; no inventory was produced.");
    const report = inventory(db);
    assertNoSidecars(path);
    if (!sameFile(before, fstatSync(fd)) || !sameFile(before, lstatSync(path)) || hashDescriptor(fd, before.size) !== sha256)
      throw new LedgerInspectionError("snapshot_changed", "The source snapshot changed during inspection; no inventory was produced.");
    return { inspection: { ...report, snapshot: { sha256, bytes: before.size } }, bytes };
  } catch (error) {
    if (error instanceof LedgerInspectionError) throw error;
    if ((error as { code?: string }).code === "ENOENT")
      throw new LedgerInspectionError(fd === undefined ? "snapshot_required" : "snapshot_changed",
        "The standalone snapshot is missing or changed. No inventory was produced.");
    // Do not expose database values, SQL errors, paths or environment details through diagnostics.
    throw new LedgerInspectionError("invalid_snapshot", "The standalone snapshot could not be read or inspected. No inventory was produced.");
  } finally {
    db?.close();
    if (fd !== undefined) closeSync(fd);
  }
}

function inventory(db: Database): Omit<LedgerInspection, "snapshot"> {
  const findings: Finding[] = [];
  const tables: LedgerInspection["tables"] = [];
  const rows = {} as Record<Table, Row[]>;
  const present = new Map<Table, Set<string>>();
  for (const [name, columns] of Object.entries(PROJECTIONS) as [Table, readonly string[]][]) {
    const schema = db.query("SELECT type, sql FROM sqlite_schema WHERE name = ?").get(name) as { type: string; sql: string | null } | null;
    if (!schema) {
      if (name === "contracts" || name === "payout_attempts")
        throw new LedgerInspectionError("unsupported_schema", "The snapshot does not contain a supported contract and payout ledger.");
      findings.push({ code: "missing_table", table: name, message: "Related ledger information is absent; no table was created." });
      rows[name] = [];
      continue;
    }
    if (schema.type !== "table" || /^\s*CREATE\s+VIRTUAL\b/i.test(schema.sql ?? ""))
      throw new LedgerInspectionError("unsupported_schema", "Ledger projections must use ordinary tables, not views or virtual tables.");
    const info = db.query("SELECT name, hidden FROM pragma_table_xinfo(?)").all(name) as { name: string; hidden: number | bigint }[];
    const available = new Set(info.map(column => column.name));
    present.set(name, available);
    if (info.some(column => columns.includes(column.name) && column.hidden !== 0 && column.hidden !== 0n))
      throw new LedgerInspectionError("unsupported_schema", "Generated or hidden ledger fields are not supported.");
    tables.push({ name, columns: [...available].sort() });
    for (const column of columns) if (!available.has(column))
      findings.push({ code: "missing_column", table: name, column, message: "Missing information remains unknown; the snapshot was not migrated." });
    const requiredKeys = name === "contracts" ? ["id"] : name === "payout_attempts" ? ["request_id", "contract_id"] : [];
    if (requiredKeys.some(key => !available.has(key)))
      throw new LedgerInspectionError("unsupported_schema", "Core ledger identity columns are absent; no inventory was produced.");
    const count = db.query(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: bigint };
    if (count.count > BigInt(MAX_ROWS_PER_TABLE))
      throw new LedgerInspectionError("unsupported_schema", "The snapshot exceeds the supported limit of 10,000 rows per ledger table. No partial inventory was produced.");
    const projection = columns.map(column => `${available.has(column) ? `"${column}"` : "NULL"} AS "${column}"`).join(", ");
    rows[name] = db.query(`SELECT ${projection} FROM "${name}"`).all() as Row[];
  }

  const identities = rows.app_identity.filter(row => integer(row.id) === 1);
  const deployment = identities.length === 1 && rows.app_identity.length === 1 ? string(identities[0]?.deployment) : null;
  if (!deployment && (rows.contracts.length || rows.payout_attempts.length))
    findings.push({ code: "deployment_unbound", message: "No unambiguous stored deployment binding was found. Do not adopt these records into another deployment." });
  const unique = (values: string[]) => [...new Set(values)].sort();
  const grouped = {
    agents: groupBy(rows.platform_agents, row => string(row.organization)),
    submissions: groupBy(rows.job_submissions, row => string(row.contract_id)),
    invoices: groupBy(rows.job_invoices, row => string(row.contract_id)),
    judgments: groupBy(rows.judgments, row => string(row.contract_id)),
    attempts: groupBy(rows.payout_attempts, row => string(row.contract_id)),
    lines: groupBy(rows.payout_lines, row => string(row.request_id)),
  };
  if ([...grouped.attempts.values()].some(group => group.length > MAX_ATTEMPTS_PER_JOB))
    throw new LedgerInspectionError("unsupported_schema", "The snapshot exceeds the supported limit of 200 attempts per job. No partial inventory was produced.");
  const idsFor = (items: Map<string, Row[]>, contract: string) => unique((items.get(contract) ?? []).map(row => identity(row.id)));
  const jobs = rows.contracts.map(row => {
    const id = identity(row.id);
    let version: number | null = null;
    try {
      const terms = JSON.parse(typeof row.terms === "string" ? row.terms : "null") as { v?: unknown } | null;
      if (terms?.v === 2 || terms?.v === 3) version = terms.v;
    } catch { /* malformed or unsupported terms remain unknown */ }
    if (version === null) findings.push({ code: "invalid_record", contract_id: id, message: "Stored terms are unreadable or their workflow version is unsupported." });
    if (!string(row.hash) || !string(row.organization) || !["covenant", "multiagency-paperwork"].includes(string(row.signing_recipient) ?? ""))
      findings.push({ code: "invalid_record", contract_id: id, message: "The stored terms hash, Organization or signing recipient is missing or unsupported." });
    const agent = grouped.agents.get(string(row.organization) ?? "") ?? [];
    if (agent.length > 1) findings.push({ code: "invalid_record", contract_id: id, message: "Multiple stored agent bindings need review." });
    return {
      id, terms_version: version, terms_hash: string(row.hash), organization: string(row.organization), signing_recipient: string(row.signing_recipient),
      agent: agent.length === 1 ? { name: string(agent[0]?.agent), id: string(agent[0]?.agent_id) } : null,
      submission_ids: idsFor(grouped.submissions, id), invoice_ids: idsFor(grouped.invoices, id), judgment_ids: idsFor(grouped.judgments, id),
      payout_request_ids: unique((grouped.attempts.get(id) ?? []).map(attempt => identity(attempt.request_id))),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(jobs.map(job => job.id)).size !== jobs.length)
    throw new LedgerInspectionError("unsupported_schema", "Duplicate job identities prevent a reliable inventory.");
  const jobById = new Map(jobs.map(job => [job.id, job]));

  const attempts: InspectedAttempt[] = rows.payout_attempts.map(row => {
    const request = identity(row.request_id), contract = identity(row.contract_id);
    const proof = row.never_executed === 1 || row.never_executed === 1n ? true : row.never_executed === 0 || row.never_executed === 0n ? false : null;
    const lines = (grouped.lines.get(request) ?? []).map(line => ({ deliverable_id: string(line.deliverable_id), amount_atomic: amount(line.amount_atomic) }))
      .sort((a, b) => (a.deliverable_id ?? "").localeCompare(b.deliverable_id ?? ""));
    const item: InspectedAttempt = {
      request_id: request, contract_id: contract, kind: string(row.kind), seq: integer(row.seq), attempt: integer(row.attempt), judgment_id: string(row.run_id),
      recipient: string(row.recipient), amount_atomic: amount(row.amount_atomic), state: string(row.state), resolution: string(row.resolution), code: string(row.code),
      payout_correlation_id: string(row.correlation_id), approval_id: string(row.approval_id), owner_step_correlation_id: string(row.vote_correlation_id),
      never_executed: proof, tx_hash: string(row.tx_hash), refund_tx_hash: string(row.refund_tx_hash), refunded_amount: amount(row.refunded_amount), counterevidence: string(row.counterevidence), lines,
      same_obligation_request_ids: [], other_same_job_request_ids: [],
    };
    if (!jobById.has(contract) || !["payout", "attack"].includes(item.kind ?? "") || !ATTEMPT_STATES.has(item.state ?? "") ||
        (row.resolution !== null && (!RESOLUTIONS.has(item.resolution ?? "") || item.state !== "failed")) || item.recipient === null ||
        item.amount_atomic === null || BigInt(item.amount_atomic) <= 0n || item.seq === null || item.seq < 1 || item.attempt === null || item.attempt < 1 ||
        (proof === null && present.get("payout_attempts")?.has("never_executed")) ||
        (row.tx_hash !== null && item.tx_hash === null) || (row.refund_tx_hash !== null && item.refund_tx_hash === null) ||
        (row.refunded_amount !== null && item.refunded_amount === null) || (row.counterevidence != null && item.counterevidence === null) ||
        lines.some(line => !line.deliverable_id || line.amount_atomic === null || BigInt(line.amount_atomic) <= 0n))
      findings.push({ code: "invalid_record", request_id: request, contract_id: contract, message: "A payout has incomplete or invalid identity, status, resolution, recipient, amount, sequence or proof information." });
    if (item.kind === "payout") {
      if (!lines.length || (item.amount_atomic !== null && lines.every(line => line.amount_atomic !== null) &&
          lines.reduce((sum, line) => sum + BigInt(line.amount_atomic!), 0n) !== BigInt(item.amount_atomic)) ||
          new Set(lines.map(line => line.deliverable_id)).size !== lines.length)
        findings.push({ code: "invalid_record", request_id: request, contract_id: contract, message: "Payout line allocations are absent, duplicated or do not equal the stored amount." });
      const released = item.state === "rejected" || (item.state === "failed" && (item.resolution === "reowe" || item.resolution === "rejected"));
      if (released) findings.push({ code: proof === true ? "recorded_release_requires_verification" : "unproven_budget_release", request_id: request, contract_id: contract,
        message: proof === true ? "A historical release has stored proof; verify its original platform binding and every related attempt before reconciliation." : "A historical release lacks positive stored non-execution proof. Preserve it and inspect every related attempt." });
      const counterevidence = row.tx_hash !== null || row.refund_tx_hash !== null || row.refunded_amount !== null || item.counterevidence !== null;
      if ((proof === true && (counterevidence || ["paid", "pending", "blocked", "waiting", "unknown", "processing", "held"].includes(item.state ?? "") || item.resolution === "arrived")) ||
          (item.state === "refused" && counterevidence))
        findings.push({ code: "contradictory_non_execution", request_id: request, contract_id: contract, message: "The stored non-execution outcome or proof conflicts with payment, refund or arrival information." });
      if (item.code === "request_conflict") findings.push({ code: "request_conflict", request_id: request, contract_id: contract, message: "This request identity conflicts with a platform record. Never adopt or replace it from this inventory." });
    }
    return item;
  }).sort((a, b) => a.request_id.localeCompare(b.request_id));
  if (new Set(attempts.map(attempt => attempt.request_id)).size !== attempts.length)
    throw new LedgerInspectionError("unsupported_schema", "Duplicate request identities prevent a reliable inventory.");
  const attemptsByJob = groupBy(attempts, item => item.contract_id);
  for (const item of attempts) {
    const peers = (attemptsByJob.get(item.contract_id) ?? []).filter(peer => peer !== item && peer.kind === "payout");
    item.same_obligation_request_ids = item.kind === "payout" && item.judgment_id !== null && item.seq !== null
      ? peers.filter(peer => peer.judgment_id === item.judgment_id && peer.seq === item.seq).map(peer => peer.request_id) : [];
    item.other_same_job_request_ids = peers.filter(peer => !item.same_obligation_request_ids.includes(peer.request_id)).map(peer => peer.request_id);
  }
  const ownerSteps = rows.owner_steps.map(row => ({
    correlation_id: identity(row.correlation_id), contract_id: string(row.contract_id), organization: string(row.organization), kind: string(row.kind),
    state: string(row.state), request_id: string(row.request_id), verdict: string(row.verdict),
  })).sort((a, b) => a.correlation_id.localeCompare(b.correlation_id));

  const attemptById = new Map(attempts.map(attempt => [attempt.request_id, attempt]));
  const judgmentById = new Map(rows.judgments.map(row => [identity(row.id), row]));
  const submissionById = new Map(rows.job_submissions.map(row => [identity(row.id), row]));
  const ownerById = new Map(ownerSteps.map(step => [step.correlation_id, step]));
  for (const name of ["judgments", "job_submissions", "job_invoices"] as const) {
    const seen = new Set<string>();
    for (const row of rows[name]) {
      const id = identity(row.id), contract = string(row.contract_id);
      if (seen.has(id) || contract === null || !jobById.has(contract))
        findings.push({ code: "invalid_record", table: name, ...(contract && { contract_id: contract }), message: "A related ledger record has a missing, duplicated or dangling identity." });
      seen.add(id);
    }
  }
  for (const row of rows.job_submissions) {
    const judgment = row.judgment_id === null ? null : judgmentById.get(string(row.judgment_id) ?? "");
    if (row.judgment_id !== null && (!judgment || judgment.contract_id !== row.contract_id))
      findings.push({ code: "invalid_record", table: "job_submissions", message: "A submission's judgment is missing or belongs to another job." });
  }
  for (const row of rows.job_invoices) {
    const submission = submissionById.get(string(row.submission_id) ?? "");
    if (!submission || submission.contract_id !== row.contract_id)
      findings.push({ code: "invalid_record", table: "job_invoices", message: "An invoice's submission is missing or belongs to another job." });
  }
  for (const line of rows.payout_lines) if (!attemptById.has(string(line.request_id) ?? ""))
    findings.push({ code: "invalid_record", table: "payout_lines", ...(string(line.request_id) && { request_id: string(line.request_id)! }), message: "A payout allocation has no matching request identity." });
  const organizations = new Set(jobs.map(job => job.organization).filter(value => value !== null));
  for (const agent of rows.platform_agents) if (!organizations.has(string(agent.organization) ?? ""))
    findings.push({ code: "invalid_record", table: "platform_agents", message: "A stored agent has no matching job Organization." });
  for (const item of attempts) {
    const job = jobById.get(item.contract_id);
    const judgment = item.judgment_id === null ? null : judgmentById.get(item.judgment_id);
    const owner = item.owner_step_correlation_id === null ? null : ownerById.get(item.owner_step_correlation_id);
    if ((item.kind === "payout" && (!item.judgment_id || !job?.agent?.name || !job.agent.id)) ||
        (item.judgment_id !== null && (!judgment || judgment.contract_id !== item.contract_id)) ||
        (item.owner_step_correlation_id !== null && (!owner || owner.kind !== "approval_vote" || owner.request_id !== item.request_id ||
          owner.contract_id !== item.contract_id || !["approve", "reject"].includes(owner.verdict ?? ""))))
      findings.push({ code: "invalid_record", request_id: item.request_id, contract_id: item.contract_id, message: "A payout's stored agent, judgment or owner-step association is missing or inconsistent." });
  }
  if (ownerById.size !== ownerSteps.length)
    findings.push({ code: "invalid_record", table: "owner_steps", message: "Duplicate owner-step identities need review." });
  for (const step of ownerSteps) {
    const job = step.contract_id === null ? null : jobById.get(step.contract_id);
    const payout = step.request_id === null ? null : attemptById.get(step.request_id);
    if ((step.contract_id !== null && (!job || job.organization !== step.organization)) ||
        (step.request_id !== null && (!payout || payout.contract_id !== step.contract_id)) ||
        !OWNER_STATES.has(step.state ?? "") || !OWNER_KINDS.has(step.kind ?? "") ||
        (step.kind === "approval_vote" ? !step.request_id || !["approve", "reject"].includes(step.verdict ?? "") : step.request_id !== null || step.verdict !== null))
      findings.push({ code: "invalid_record", table: "owner_steps", message: "An owner step has an invalid state or a dangling/mismatched job, Organization or request association." });
  }

  return {
    schema_version: 1, deployment, host: null, tables, jobs, attempts, owner_steps: ownerSteps, findings,
    summary: { job_count: jobs.length, attempt_count: attempts.length, unproven_release_count: findings.filter(f => f.code === "unproven_budget_release").length,
      contradiction_count: findings.filter(f => f.code === "contradictory_non_execution").length, requires_review: findings.length > 0 },
    limitations: ["Local inventory only: stored proof and status are not independently verified platform evidence or permission to resume payments.",
      "Only workflow version and ledger identity/value shapes are inspected; signed terms, hashes and signatures are not cryptographically verified.",
      "The original platform host, snapshot completeness and freshness require trusted operator provenance; they are not established by this report."],
  };
}
