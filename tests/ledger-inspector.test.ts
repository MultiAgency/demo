import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectLedger, LedgerInspectionError, type LedgerInspectionErrorCode } from "../src/server/recovery/inspect";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const ids = {
  contract: "c_inspection_original", organization: "organization-original", judgment: "judgment-original",
  request: "request-original", payout: "payment-original", approval: "approval-original", ownerStep: "owner-step-original",
  submission: "submission-original", invoice: "invoice-original", agent: "agent-original", agentId: "agent-id-original",
};
const amount = "9007199254740993123456";
const privateValues = [
  "PRIVATE-TERMS-CONTENT", "PRIVATE-REPORT-CONTENT", "PRIVATE-EVIDENCE-URL", "PRIVATE-INVOICE-NUMBER",
  "PRIVATE-OWNER-INTENT", "PRIVATE-CONFIRMATION-URL", "PRIVATE-OWNER-SUMMARY", "PRIVATE-PAYMENT-PREVIEW",
  "PRIVATE-INVITATION-HASH", "PRIVATE-AUTH-TOKEN", "PRIVATE-UNRELATED-RECORD",
];
const errorCodes = ["snapshot_required", "invalid_snapshot", "unsupported_schema", "snapshot_changed"];

interface FixtureOptions {
  version?: 2 | 3;
  proof?: number | string | null;
  proofColumn?: boolean;
  state?: string;
  resolution?: string | null;
  txHash?: string | null;
  refundTxHash?: string | null;
  refundedAmount?: string | null;
  refundAmountColumn?: boolean;
  code?: string | null;
}

function directory() {
  const result = mkdtempSync(join(tmpdir(), "paperwork-ledger-inspection-"));
  directories.push(result);
  return result;
}

/** Disposable standalone SQL fixtures only: application startup and migrations are deliberately never imported. */
function fixture(options: FixtureOptions = {}) {
  const path = join(directory(), "snapshot.sqlite");
  const db = new Database(path, { strict: true });
  const proofColumn = options.proofColumn !== false;
  const refundAmountColumn = options.refundAmountColumn !== false;
  try {
    db.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE app_identity (id INTEGER PRIMARY KEY, deployment TEXT);
      CREATE TABLE contracts (
        id TEXT PRIMARY KEY, terms TEXT, hash TEXT, organization TEXT, signing_recipient TEXT,
        contractor_link_hash TEXT, rep_sig TEXT, contractor_sig TEXT
      );
      CREATE TABLE platform_agents (
        organization TEXT PRIMARY KEY, agent TEXT, agent_id TEXT, pending_sign TEXT, deposit TEXT
      );
      CREATE TABLE judgments (id TEXT PRIMARY KEY, contract_id TEXT, outcome TEXT, json TEXT);
      CREATE TABLE job_submissions (
        id TEXT PRIMARY KEY, contract_id TEXT, judgment_id TEXT, report TEXT, evidence TEXT
      );
      CREATE TABLE job_invoices (
        id TEXT PRIMARY KEY, contract_id TEXT, submission_id TEXT, number TEXT, amount_atomic TEXT
      );
      CREATE TABLE payout_attempts (
        request_id TEXT PRIMARY KEY, kind TEXT, contract_id TEXT, seq INTEGER, attempt INTEGER, run_id TEXT,
        recipient TEXT, amount_atomic TEXT, state TEXT, resolution TEXT, code TEXT,
        correlation_id TEXT, approval_id TEXT, vote_correlation_id TEXT,
        ${proofColumn ? "never_executed INTEGER," : ""}
        tx_hash TEXT, refund_tx_hash TEXT${refundAmountColumn ? ", refunded_amount TEXT" : ""}
      );
      CREATE TABLE payout_lines (request_id TEXT, deliverable_id TEXT, amount_atomic TEXT);
      CREATE TABLE owner_steps (
        correlation_id TEXT PRIMARY KEY, contract_id TEXT, organization TEXT, kind TEXT, state TEXT,
        request_id TEXT, verdict TEXT, intent TEXT, confirm_url TEXT, summary TEXT, payment_terms TEXT
      );
      CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, token TEXT);
      CREATE TABLE unrelated_private_records (id TEXT PRIMARY KEY, content TEXT);
    `);
    db.query("INSERT INTO app_identity VALUES (1, ?)").run("original-deployment");
    db.query("INSERT INTO contracts VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      ids.contract, JSON.stringify({ v: options.version ?? 3, private_notes: privateValues[0] }), "a".repeat(64),
      ids.organization, "covenant", privateValues[8]!, "private-representative-signature", "private-builder-signature",
    );
    db.query("INSERT INTO platform_agents VALUES (?, ?, ?, ?, ?)").run(ids.organization, ids.agent, ids.agentId, "private-signing-payload", "private-deposit-instructions");
    db.query("INSERT INTO judgments VALUES (?, ?, ?, ?)").run(ids.judgment, ids.contract, "rejected", "private-assessment-json");
    if (options.version !== 2) {
      db.query("INSERT INTO job_submissions VALUES (?, ?, ?, ?, ?)").run(ids.submission, ids.contract, ids.judgment, privateValues[1]!, privateValues[2]!);
      db.query("INSERT INTO job_invoices VALUES (?, ?, ?, ?, ?)").run(ids.invoice, ids.contract, ids.submission, privateValues[3]!, "314159265358979323846");
    }
    const columns = ["request_id", "kind", "contract_id", "seq", "attempt", "run_id", "recipient", "amount_atomic", "state", "resolution", "code", "correlation_id", "approval_id", "vote_correlation_id", ...(proofColumn ? ["never_executed"] : []), "tx_hash", "refund_tx_hash", ...(refundAmountColumn ? ["refunded_amount"] : [])];
    const values = [ids.request, "payout", ids.contract, 1, 1, ids.judgment, "builder.fixture", amount,
      options.state ?? "failed", options.resolution === undefined ? "reowe" : options.resolution, options.code ?? null,
      ids.payout, ids.approval, ids.ownerStep, ...(proofColumn ? [options.proof === undefined ? 0 : options.proof] : []), options.txHash ?? null, options.refundTxHash ?? null, ...(refundAmountColumn ? [options.refundedAmount ?? null] : [])];
    db.query(`INSERT INTO payout_attempts (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
    db.query("INSERT INTO payout_lines VALUES (?, ?, ?)").run(ids.request, "d1", amount);
    db.query("INSERT INTO owner_steps VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      ids.ownerStep, ids.contract, ids.organization, "approval_vote", "unknown", ids.request, "reject",
      privateValues[4]!, privateValues[5]!, privateValues[6]!, privateValues[7]!,
    );
    db.query("INSERT INTO auth_sessions VALUES (?, ?)").run("fixture-session", privateValues[9]!);
    db.query("INSERT INTO unrelated_private_records VALUES (?, ?)").run("fixture-unrelated", privateValues[10]!);
  } finally { db.close(); }
  return path;
}

function change(path: string, action: (db: Database) => void) {
  const db = new Database(path, { strict: true });
  try { action(db); } finally { db.close(); }
}

function snapshot(path: string) {
  const before = statSync(path);
  const bytes = readFileSync(path);
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const schema = db.query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all();
    const tables = db.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    const rows = Object.fromEntries(tables.map(({ name }) => [name, db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
    return { bytes, size: before.size, modified: before.mtimeMs, files: readdirSync(dirname(path)).sort(), schema, rows };
  } finally { db.close(); }
}

function rejected(path: string, expectedCode?: LedgerInspectionErrorCode) {
  let error: unknown;
  try { inspectLedger(path); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(LedgerInspectionError);
  expect(errorCodes).toContain((error as LedgerInspectionError).code);
  if (expectedCode) expect((error as LedgerInspectionError).code).toBe(expectedCode);
  return error as LedgerInspectionError;
}

describe("standalone historical-ledger inspection", () => {
  for (const version of [2, 3] as const) {
    for (const [state, resolution] of [["rejected", null], ["failed", "reowe"], ["failed", "rejected"]] as const) {
      test(`v${version} ${state}/${resolution}: unproven releases are reported without changing the ledger`, () => {
        const path = fixture({ version, state, resolution });
        const before = snapshot(path);
        const report = inspectLedger(path);
        expect(report.schema_version).toBe(1);
        expect(report.deployment).toBe("original-deployment");
        expect(report.host).toBeNull();
        expect(report.jobs[0]).toMatchObject({ id: ids.contract, terms_version: version, terms_hash: "a".repeat(64), organization: ids.organization, signing_recipient: "covenant", agent: { name: ids.agent, id: ids.agentId } });
        expect(report.attempts[0]).toMatchObject({ request_id: ids.request, contract_id: ids.contract, judgment_id: ids.judgment, state, resolution, never_executed: false });
        expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "unproven_budget_release", request_id: ids.request })]));
        expect(report.summary).toMatchObject({ job_count: 1, attempt_count: 1, unproven_release_count: 1, requires_review: true });
        expect(inspectLedger(path)).toEqual(report);
        expect(snapshot(path)).toEqual(before);
      });

      test(`v${version} ${state}/${resolution}: recorded proof still requires authoritative verification`, () => {
        const report = inspectLedger(fixture({ version, state, resolution, proof: 1 }));
        expect(report.attempts[0]!.never_executed).toBe(true);
        expect(report.findings.some((finding) => finding.code === "unproven_budget_release")).toBe(false);
        expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "recorded_release_requires_verification", request_id: ids.request })]));
        expect(report.summary).toMatchObject({ unproven_release_count: 0, contradiction_count: 0, requires_review: true });
      });
    }

    for (const condition of [
      { state: "failed", resolution: "reowe", txHash: "original-transaction" },
      { state: "failed", resolution: "rejected", refundTxHash: "original-refund" },
      { state: "paid", resolution: null },
      { state: "processing", resolution: null },
      { state: "held", resolution: null },
      { state: "failed", resolution: "arrived" },
    ] as const) {
      test(`v${version} proof with ${JSON.stringify(condition)} is contradictory, never permission to release`, () => {
        const report = inspectLedger(fixture({ version, proof: 1, ...condition }));
        expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "contradictory_non_execution", request_id: ids.request })]));
        expect(report.summary.contradiction_count).toBeGreaterThanOrEqual(1);
        expect(report.summary.requires_review).toBe(true);
      });
    }
  }

  test("missing proof remains null and is reported without adding a column", () => {
    const path = fixture({ proofColumn: false });
    const before = snapshot(path);
    const report = inspectLedger(path);
    expect(report.attempts[0]!.never_executed).toBeNull();
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing_column", table: "payout_attempts", column: "never_executed" }),
      expect.objectContaining({ code: "unproven_budget_release", request_id: ids.request }),
    ]));
    expect(snapshot(path)).toEqual(before);
  });

  test("a legacy missing refund-amount column remains unknown without migration", () => {
    const path = fixture({ refundAmountColumn: false, state: "paid", resolution: null });
    const before = snapshot(path);
    const report = inspectLedger(path);
    expect(report.attempts[0]!.refunded_amount).toBeNull();
    expect(report.findings).toContainEqual(expect.objectContaining({ code: "missing_column", table: "payout_attempts", column: "refunded_amount" }));
    expect(report.summary.requires_review).toBe(true);
    expect(snapshot(path)).toEqual(before);
  });

  for (const version of [2, 3] as const) {
    for (const condition of [
      { state: "failed", resolution: "reowe", proof: 1, refundedAmount: amount },
      { state: "failed", resolution: "rejected", proof: 1, refundedAmount: "0" },
      { state: "failed", resolution: "reowe", proof: 1, refundedAmount: "" },
      { state: "rejected", resolution: null, proof: 1, txHash: "" },
      { state: "refused", resolution: null, proof: 0, txHash: "original-transaction" },
      { state: "refused", resolution: null, proof: 0, refundTxHash: "original-refund" },
      { state: "refused", resolution: null, proof: 0, refundedAmount: amount },
    ] as const) {
      test(`v${version} stored counterevidence ${JSON.stringify(condition)} requires review without writes`, () => {
        const path = fixture({ version, ...condition });
        const before = snapshot(path);
        const report = inspectLedger(path);
        expect(report.findings).toContainEqual(expect.objectContaining({ code: "contradictory_non_execution", request_id: ids.request }));
        expect(report.summary).toMatchObject({ contradiction_count: 1, requires_review: true });
        if ("refundedAmount" in condition && typeof condition.refundedAmount === "string" && condition.refundedAmount !== "")
          expect(report.attempts[0]!.refunded_amount).toBe(condition.refundedAmount);
        expect(snapshot(path)).toEqual(before);
      });
    }
  }

  test("a missing relation table is reported while original payment identities remain inspectable", () => {
    const path = fixture();
    change(path, (db) => db.exec("DROP TABLE payout_lines"));
    const before = snapshot(path);
    const report = inspectLedger(path);
    expect(report.attempts[0]).toMatchObject({ request_id: ids.request, payout_correlation_id: ids.payout, owner_step_correlation_id: ids.ownerStep });
    expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_table", table: "payout_lines" })]));
    expect(report.summary.requires_review).toBe(true);
    expect(snapshot(path)).toEqual(before);
  });

  test("missing deployment identity stays unbound rather than adopting a default", () => {
    const path = fixture();
    change(path, (db) => db.exec("DROP TABLE app_identity"));
    const before = snapshot(path);
    const report = inspectLedger(path);
    expect(report.deployment).toBeNull();
    expect(report.host).toBeNull();
    expect(report.findings.some((finding) => finding.code === "deployment_unbound")).toBe(true);
    expect(report.summary.requires_review).toBe(true);
    expect(snapshot(path)).toEqual(before);
  });

  test("originals and replacements use exact job/judgment/sequence context without matching another job by amount", () => {
    const path = fixture();
    change(path, (db) => {
      db.query("INSERT INTO contracts (id, terms, hash, organization, signing_recipient) VALUES (?, ?, ?, ?, ?)").run("c_other", '{"v":2}', "b".repeat(64), "organization-other", "covenant");
      db.query("INSERT INTO judgments (id, contract_id, outcome) VALUES (?, ?, ?)").run("judgment-later", ids.contract, "pending");
      db.query("INSERT INTO judgments (id, contract_id, outcome) VALUES (?, ?, ?)").run("judgment-other", "c_other", "pending");
      const insert = db.query("INSERT INTO payout_attempts (request_id, kind, contract_id, seq, attempt, run_id, recipient, amount_atomic, state, never_executed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const [request, contract, judgment, seq, attempt] of [
        ["request-replacement", ids.contract, ids.judgment, 1, 2],
        ["request-later-judgment", ids.contract, "judgment-later", 1, 1],
        ["request-later-sequence", ids.contract, ids.judgment, 2, 1],
        ["request-unknown-judgment", ids.contract, null, 1, 3],
        ["request-other-job", "c_other", "judgment-other", 1, 1],
      ] as const) insert.run(request, "payout", contract, seq, attempt, judgment, "builder.fixture", amount, "unknown", 0);
    });
    const report = inspectLedger(path);
    const original = report.attempts.find((attempt) => attempt.request_id === ids.request)!;
    const replacement = report.attempts.find((attempt) => attempt.request_id === "request-replacement")!;
    expect(report.summary).toMatchObject({ job_count: 2, attempt_count: 6 });
    expect(original.same_obligation_request_ids).toEqual(["request-replacement"]);
    expect(replacement.same_obligation_request_ids).toEqual([ids.request]);
    expect([...original.other_same_job_request_ids].sort()).toEqual(["request-later-judgment", "request-later-sequence", "request-unknown-judgment"].sort());
    expect(report.attempts.find((attempt) => attempt.request_id === "request-unknown-judgment")!.same_obligation_request_ids).toEqual([]);
    expect(report.attempts.find((attempt) => attempt.request_id === "request-other-job")!.same_obligation_request_ids).toEqual([]);
    expect([...original.same_obligation_request_ids, ...original.other_same_job_request_ids]).not.toContain("request-other-job");
  });

  test("exact amounts, record links and distinct owner/payment correlations survive projection without private contents", () => {
    const path = fixture();
    const bytes = readFileSync(path);
    const report = inspectLedger(path);
    expect(report.snapshot).toMatchObject({ sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength });
    expect(report.jobs[0]).toMatchObject({ submission_ids: [ids.submission], invoice_ids: [ids.invoice], judgment_ids: [ids.judgment], payout_request_ids: [ids.request] });
    expect(report.attempts[0]).toMatchObject({ amount_atomic: amount, payout_correlation_id: ids.payout, approval_id: ids.approval, owner_step_correlation_id: ids.ownerStep, lines: [{ deliverable_id: "d1", amount_atomic: amount }] });
    expect(report.owner_steps[0]).toMatchObject({ correlation_id: ids.ownerStep, contract_id: ids.contract, organization: ids.organization, request_id: ids.request, kind: "approval_vote", state: "unknown", verdict: "reject" });
    const serialized = JSON.stringify(report);
    for (const value of [...privateValues, "private-representative-signature", "private-builder-signature", "private-signing-payload", "private-deposit-instructions", "private-assessment-json"])
      expect(serialized).not.toContain(value);
  });

  test("malformed version/proof values cannot become positive authority", () => {
    const path = fixture({ proof: "true" });
    change(path, (db) => db.query("UPDATE contracts SET terms = ? WHERE id = ?").run("not JSON", ids.contract));
    const report = inspectLedger(path);
    expect(report.jobs[0]!.terms_version).toBeNull();
    expect(report.attempts[0]!.never_executed).not.toBe(true);
    expect(report.findings.some((finding) => finding.code === "invalid_record")).toBe(true);
    expect(report.summary.requires_review).toBe(true);
  });

  for (const column of ["hash", "organization", "signing_recipient"] as const) {
    test(`a present but null job ${column} remains an invalid identity record`, () => {
      const path = fixture();
      change(path, (db) => db.query(`UPDATE contracts SET "${column}" = NULL WHERE id = ?`).run(ids.contract));
      const before = snapshot(path);
      const report = inspectLedger(path);
      expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_record", contract_id: ids.contract })]));
      expect(report.summary.requires_review).toBe(true);
      expect(snapshot(path)).toEqual(before);
    });
  }

  test("an unexpected second deployment identity requires review instead of being ignored", () => {
    const path = fixture();
    change(path, (db) => db.query("INSERT INTO app_identity VALUES (?, ?)").run(2, "another-deployment"));
    const before = snapshot(path);
    const report = inspectLedger(path);
    expect(report.findings.some((finding) => finding.code === "deployment_unbound" || finding.code === "invalid_record")).toBe(true);
    expect(report.summary.requires_review).toBe(true);
    expect(snapshot(path)).toEqual(before);
  });

  test("a paid payout cannot carry a budget-releasing failure resolution", () => {
    const path = fixture({ state: "paid", resolution: "reowe" });
    const before = snapshot(path);
    const report = inspectLedger(path);
    expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_record", request_id: ids.request })]));
    expect(report.summary.requires_review).toBe(true);
    expect(snapshot(path)).toEqual(before);
  });

  for (const [label, sql] of [
    ["missing platform agent", "DELETE FROM platform_agents"],
    ["missing agent name", "UPDATE platform_agents SET agent = NULL"],
    ["missing agent ID", "UPDATE platform_agents SET agent_id = NULL"],
    ["missing payout judgment", "UPDATE payout_attempts SET run_id = NULL"],
    ["non-approval owner step linked as an approval", "UPDATE owner_steps SET kind = 'grant_issue'"],
    ["misspelled owner verdict", "UPDATE owner_steps SET verdict = 'aprove'"],
    ["orphan platform agent", "INSERT INTO platform_agents (organization, agent, agent_id) VALUES ('organization-orphan', 'agent-orphan', 'agent-id-orphan')"],
  ] as const) {
    test(`${label} prevents an apparently valid platform binding without changing the snapshot`, () => {
      const path = fixture({ state: "paid", resolution: null });
      change(path, (db) => db.exec(sql));
      const before = snapshot(path);
      const report = inspectLedger(path);
      expect(report.findings.some((finding) => finding.code === "invalid_record")).toBe(true);
      expect(report.summary.requires_review).toBe(true);
      expect(snapshot(path)).toEqual(before);
    });
  }

  for (const [column, value] of [
    ["kind", null], ["kind", "paymnet"],
    ["state", null], ["state", "settledd"],
    ["resolution", "refunded"],
    ["recipient", null], ["recipient", ""],
    ["amount_atomic", "0"], ["seq", 0], ["attempt", 0],
  ] as const) {
    test(`malformed payout ${column}=${JSON.stringify(value)} requires review without changing stored evidence`, () => {
      const path = fixture({ state: "paid", resolution: null });
      change(path, (db) => db.query(`UPDATE payout_attempts SET "${column}" = ? WHERE request_id = ?`).run(value, ids.request));
      const before = snapshot(path);
      const report = inspectLedger(path);
      expect(report.attempts).toHaveLength(1);
      expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_record", request_id: ids.request })]));
      expect(report.summary.requires_review).toBe(true);
      expect(snapshot(path)).toEqual(before);
    });
  }

  for (const [table, sql] of [
    ["payout_lines", "INSERT INTO payout_lines VALUES ('request-missing', 'd1', '1')"],
    ["job_submissions", "UPDATE job_submissions SET contract_id = 'c_missing'"],
    ["job_submissions", "UPDATE job_submissions SET judgment_id = 'judgment-missing'"],
    ["job_invoices", "UPDATE job_invoices SET contract_id = 'c_missing'"],
    ["job_invoices", "UPDATE job_invoices SET submission_id = 'submission-missing'"],
    ["judgments", "UPDATE judgments SET contract_id = 'c_missing'"],
  ] as const) {
    test(`dangling ${table} relationship is not silently omitted: ${sql}`, () => {
      const path = fixture({ state: "paid", resolution: null });
      change(path, (db) => db.exec(sql));
      const before = snapshot(path);
      const report = inspectLedger(path);
      expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_record", table })]));
      expect(report.summary.requires_review).toBe(true);
      expect(snapshot(path)).toEqual(before);
    });
  }

  test("a payout's missing judgment cannot establish an obligation relationship", () => {
    const path = fixture({ state: "paid", resolution: null });
    change(path, (db) => db.query("UPDATE payout_attempts SET run_id = ? WHERE request_id = ?").run("judgment-missing", ids.request));
    const before = snapshot(path);
    const report = inspectLedger(path);
    expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_record", request_id: ids.request })]));
    expect(report.summary.requires_review).toBe(true);
    expect(snapshot(path)).toEqual(before);
  });

  for (const [label, sql] of [
    ["missing", "DELETE FROM payout_lines"],
    ["too small", "UPDATE payout_lines SET amount_atomic = '1'"],
    ["zero", "UPDATE payout_lines SET amount_atomic = '0'"],
    ["duplicated", "INSERT INTO payout_lines SELECT * FROM payout_lines"],
  ] as const) {
    test(`${label} payout lines cannot present an apparently complete amount allocation`, () => {
      const path = fixture({ state: "paid", resolution: null });
      change(path, (db) => db.exec(sql));
      const before = snapshot(path);
      const report = inspectLedger(path);
      expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_record", request_id: ids.request })]));
      expect(report.summary.requires_review).toBe(true);
      expect(snapshot(path)).toEqual(before);
    });
  }

  test("a stored request conflict remains a finding under the original request, never a replacement association", () => {
    const report = inspectLedger(fixture({ state: "blocked", resolution: null, code: "request_conflict" }));
    expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "request_conflict", request_id: ids.request })]));
    expect(report.attempts[0]!.same_obligation_request_ids).toEqual([]);
    expect(report.summary.requires_review).toBe(true);
  });

  test("attack attempts remain visible but are not treated as budget-releasing job payouts", () => {
    const path = fixture({ state: "paid", resolution: null });
    change(path, (db) => db.query("INSERT INTO payout_attempts (request_id, kind, contract_id, seq, attempt, run_id, recipient, amount_atomic, state, never_executed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("request-attack", "attack", ids.contract, 1, 2, ids.judgment, "builder.fixture", amount, "rejected", 0));
    const report = inspectLedger(path);
    expect(report.attempts.map((attempt) => attempt.request_id).sort()).toEqual(["request-attack", ids.request].sort());
    expect(report.attempts.find((attempt) => attempt.request_id === ids.request)!.same_obligation_request_ids).toEqual([]);
    expect(report.findings.filter((finding) => finding.code === "unproven_budget_release")).toEqual([]);
    expect(report.summary).toMatchObject({ attempt_count: 2, unproven_release_count: 0 });
  });

  test("an attack may have no judgment or payout allocation without becoming an invalid job payout", () => {
    const path = fixture({ state: "paid", resolution: null });
    change(path, (db) => db.query("INSERT INTO payout_attempts (request_id, kind, contract_id, seq, attempt, run_id, recipient, amount_atomic, state, never_executed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("request-unlinked-attack", "attack", ids.contract, 2, 1, null, "builder.fixture", "1", "refused", 0));
    const before = snapshot(path);
    const report = inspectLedger(path);
    expect(report.attempts.find((attempt) => attempt.request_id === "request-unlinked-attack")).toMatchObject({ kind: "attack", judgment_id: null, lines: [] });
    expect(report.findings.filter((finding) => finding.code === "invalid_record")).toEqual([]);
    expect(snapshot(path)).toEqual(before);
  });

  test("inspection never invokes an outbound fetch", () => {
    const path = fixture();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const refuseFetch = (): Promise<Response> => { calls++; throw new Error("Unexpected external call during ledger inspection"); };
    globalThis.fetch = Object.assign(refuseFetch, { preconnect: () => { calls++; throw new Error("Unexpected connection during ledger inspection"); } });
    try {
      expect(inspectLedger(path).attempts[0]!.request_id).toBe(ids.request);
      expect(calls).toBe(0);
    } finally { globalThis.fetch = originalFetch; }
  });
});

describe("only coherent standalone SQLite snapshots are admitted", () => {
  test("a missing input is refused without creating a database or directory", () => {
    const root = directory();
    const path = join(root, "missing", "snapshot.sqlite");
    rejected(path);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  test("corrupt input is refused without modifying bytes or adding sidecars", () => {
    const root = directory();
    const path = join(root, "corrupt.sqlite");
    const bytes = Buffer.alloc(4096, 0x5a);
    bytes.write("This is a disposable non-SQLite fixture, not a recoverable ledger.");
    writeFileSync(path, bytes);
    rejected(path, "invalid_snapshot");
    expect(readFileSync(path)).toEqual(bytes);
    expect(readdirSync(root)).toEqual(["corrupt.sqlite"]);
  });

  test("corrupt SQLite pages cannot produce a partial inventory or rewrite the source", () => {
    const path = fixture();
    const bytes = readFileSync(path);
    // Preserve SQLite's header but destroy the first schema page in this disposable copy.
    bytes.fill(0, 100, 4096);
    writeFileSync(path, bytes);
    rejected(path, "invalid_snapshot");
    expect(readFileSync(path)).toEqual(bytes);
    expect(readdirSync(dirname(path))).toEqual(["snapshot.sqlite"]);
  });

  test("a symlink is refused without following or changing its target", () => {
    const path = fixture();
    const link = join(directory(), "linked.sqlite");
    symlinkSync(path, link);
    const before = snapshot(path);
    rejected(link);
    expect(snapshot(path)).toEqual(before);
    expect(readdirSync(dirname(link))).toEqual(["linked.sqlite"]);
  });

  for (const suffix of ["-wal", "-shm", "-journal"]) {
    test(`the presence of ${suffix} requires a coherent backup, even beside a DELETE-journal database`, () => {
      const path = fixture();
      const main = readFileSync(path);
      const sidecar = Buffer.from("unmerged disposable sidecar");
      writeFileSync(path + suffix, sidecar);
      const files = readdirSync(dirname(path)).sort();
      rejected(path);
      expect(readFileSync(path)).toEqual(main);
      expect(readFileSync(path + suffix)).toEqual(sidecar);
      expect(readdirSync(dirname(path)).sort()).toEqual(files);
    });
  }

  test("a WAL-format header is refused even after sidecars disappear", () => {
    const path = fixture();
    const bytes = readFileSync(path);
    bytes[18] = 2;
    bytes[19] = 2;
    writeFileSync(path, bytes);
    rejected(path);
    expect(readFileSync(path)).toEqual(bytes);
    expect(readdirSync(dirname(path))).toEqual(["snapshot.sqlite"]);
  });

  test("oversized snapshots are refused before accepting a partial ledger", () => {
    const path = join(directory(), "oversized.sqlite");
    writeFileSync(path, "SQLite format 3\0");
    truncateSync(path, 64 * 1024 * 1024 + 1);
    const size = statSync(path).size;
    rejected(path);
    expect(statSync(path).size).toBe(size);
    const fd = openSync(path, "r");
    try {
      const header = Buffer.alloc(16);
      expect(readSync(fd, header, 0, header.length, 0)).toBe(16);
      expect(header.toString()).toBe("SQLite format 3\0");
    } finally { closeSync(fd); }
  });

  test("a view cannot stand in for an allowlisted ledger table", () => {
    const path = fixture();
    change(path, (db) => db.exec("DROP TABLE payout_lines; CREATE VIEW payout_lines AS SELECT request_id, 'd1' AS deliverable_id, amount_atomic FROM payout_attempts"));
    const before = readFileSync(path);
    rejected(path, "unsupported_schema");
    expect(readFileSync(path)).toEqual(before);
  });

  test("generated ledger columns are refused instead of evaluated as stored evidence", () => {
    const path = fixture();
    change(path, (db) => db.exec("DROP TABLE payout_lines; CREATE TABLE payout_lines (request_id TEXT, deliverable_id TEXT, amount_atomic TEXT GENERATED ALWAYS AS ('123456789') VIRTUAL)"));
    const before = readFileSync(path);
    rejected(path, "unsupported_schema");
    expect(readFileSync(path)).toEqual(before);
  });

  test("missing core identity keys are refused without schema repair", () => {
    const path = fixture();
    change(path, (db) => db.exec("ALTER TABLE payout_attempts RENAME COLUMN request_id TO legacy_request"));
    const before = readFileSync(path);
    rejected(path, "unsupported_schema");
    expect(readFileSync(path)).toEqual(before);
  });

  test("a projected table over the row bound is refused without returning a partial inventory", () => {
    const path = fixture();
    change(path, (db) => {
      const insert = db.query("INSERT INTO judgments (id, contract_id, outcome) VALUES (?, ?, ?)");
      db.transaction(() => {
        for (let i = 0; i < 10_000; i++) insert.run(`bounded-judgment-${i}`, ids.contract, "approved");
      })();
    });
    const before = readFileSync(path);
    rejected(path, "unsupported_schema");
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(dirname(path))).toEqual(["snapshot.sqlite"]);
  });

  test("a job over the attempt bound is refused without returning truncated relationships", () => {
    const path = fixture();
    change(path, (db) => {
      const attempt = db.query("INSERT INTO payout_attempts (request_id, kind, contract_id, seq, attempt, run_id, recipient, amount_atomic, state, never_executed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const line = db.query("INSERT INTO payout_lines VALUES (?, ?, ?)");
      db.transaction(() => {
        for (let i = 2; i <= 201; i++) {
          const request = `bounded-attempt-${i}`;
          attempt.run(request, "payout", ids.contract, i, 1, ids.judgment, "builder.fixture", "1", "unknown", 0);
          line.run(request, "d1", "1");
        }
      })();
    });
    const before = readFileSync(path);
    rejected(path, "unsupported_schema");
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(dirname(path))).toEqual(["snapshot.sqlite"]);
  });
});

test("retained REFUNDED counterevidence is reported and contradicts stored proof", () => {
  const path = fixture({ version: 3, state: "failed", resolution: null, proof: 1 });
  change(path, db => db.exec("ALTER TABLE payout_attempts ADD COLUMN counterevidence TEXT; UPDATE payout_attempts SET counterevidence = 'payment status REFUNDED'"));
  const report = inspectLedger(path);
  expect(report.attempts[0]).toMatchObject({ never_executed: true, counterevidence: "payment status REFUNDED" });
  expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "contradictory_non_execution", request_id: ids.request })]));
  expect(report.findings.some(finding => finding.code === "missing_column" && finding.column === "counterevidence")).toBe(false);
});
