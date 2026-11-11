import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db";
import { canonicalJson } from "../src/shared/canonical";
import { DEMO_TERMS, JOB_DEMO_TERMS } from "../src/shared/demo";
import { parseTerms, termsHash } from "../src/shared/terms";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const ids = {
  contract: "c_compat_fixture", submission: "s_compat_fixture", invoice: "i_compat_fixture",
  judgment: "r_compat_fixture", request: "compat-original-request-1", payment: "compat-original-payment-1",
  approval: "compat-original-approval-1", vote: "compat-original-vote-1",
};
const tables = ["contracts", "judgments", "job_submissions", "job_invoices", "payout_attempts", "payout_lines", "events"];

/** Disposable ledger fixture only: no runtime, provider, key or payment operation is created. */
function fixture(state: "rejected" | "unknown" | "processing" | "paid" | "failed" = "rejected", proof = 0, legacy = false,
  options: { resolution?: "reowe" | "rejected" | "arrived"; v2?: boolean; txHash?: string; refundTxHash?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "paperwork-rejection-compat-"));
  directories.push(dir);
  const path = join(dir, "fixture.sqlite");
  const db = openDb(path);
  try {
    const terms = parseTerms(options.v2 ? DEMO_TERMS : JOB_DEMO_TERMS);
    const hash = termsHash(terms);
    const at = "2026-11-20T12:00:00.000Z";
    db.query("INSERT INTO contracts (id, terms, hash, created_at, contractor_link_hash, rep_sig, contractor_sig, organization) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ids.contract, canonicalJson(terms), hash, at, "fixture-link-hash", '{"fixture":"agency"}', '{"fixture":"builder"}', ids.contract);
    db.query("INSERT INTO judgments (id, contract_id, at, json, outcome, closed_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ids.judgment, ids.contract, at, '{"fixture":"original assessment"}', "rejected", at);
    db.query("INSERT INTO job_submissions (id, contract_id, client_request_id, content_hash, revision, terms_hash, builder, report, evidence, judgment_id, proposed_atomic, state, changes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ids.submission, ids.contract, "original-client-identity", "original-content-hash", 1, hash, terms.contractor.near_account,
        "Original immutable builder report", '[{"deliverable_id":"d1","label":"Original evidence","url":"https://example.test/evidence"}]',
        ids.judgment, "300000000", "changes_requested", "Original agency feedback", at);
    db.query("INSERT INTO job_invoices (id, submission_id, contract_id, number, amount_atomic) VALUES (?, ?, ?, ?, ?)")
      .run(ids.invoice, ids.submission, ids.contract, "COMPAT-INV-001", "300000000");
    db.query("INSERT INTO payout_attempts (request_id, kind, contract_id, seq, attempt, run_id, recipient, amount_atomic, state, correlation_id, approval_id, vote, vote_correlation_id, never_executed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ids.request, "payout", ids.contract, 1, 1, ids.judgment, terms.payee.address, "300000000", state,
        ids.payment, ids.approval, state === "rejected" ? "reject" : "approve", ids.vote, proof, at, at);
    db.query("UPDATE payout_attempts SET resolution = ?, tx_hash = ?, refund_tx_hash = ? WHERE request_id = ?")
      .run(options.resolution ?? null, options.txHash ?? null, options.refundTxHash ?? null, ids.request);
    db.query("INSERT INTO payout_lines (request_id, deliverable_id, amount_atomic) VALUES (?, ?, ?)").run(ids.request, "d1", "300000000");
    db.query("INSERT INTO events (contract_id, at, kind, text) VALUES (?, ?, ?, ?)").run(ids.contract, at, "fixture", "Original payout identity retained");
    // Model the earlier schema in this disposable fixture, never an application database.
    if (legacy) db.exec("ALTER TABLE payout_attempts DROP COLUMN never_executed");
  } finally { db.close(); }
  return path;
}

function snapshot(path: string) {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const schema = db.query("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    const rows = Object.fromEntries(tables.map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()])) as Record<string, Record<string, unknown>[]>;
    return { schema, rows };
  } finally { db.close(); }
}

function refuse(path: string) {
  let error: unknown;
  try { const db = openDb(path); db.close(); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain("non-execution proof");
  expect(message).toContain(ids.request);
  expect(message.toLowerCase()).toContain("preserve");
  expect(message.toLowerCase()).toContain("reconcil");
  expect(message.toLowerCase()).not.toMatch(/delete|reset/);
}

test("a pre-proof rejected payout refuses before schema migration and preserves its complete ledger", () => {
  const path = fixture("rejected", 0, true);
  const before = snapshot(path);
  expect(before.rows.payout_attempts![0]!).not.toHaveProperty("never_executed");
  refuse(path);
  expect(snapshot(path)).toEqual(before);
  expect(before.rows.payout_attempts![0]!.request_id).toBe(ids.request);
  expect(before.rows.payout_attempts![0]!.correlation_id).toBe(ids.payment);
  expect(before.rows.job_submissions![0]!.id).toBe(ids.submission);
  expect(before.rows.job_invoices![0]!.id).toBe(ids.invoice);
});

test("an already-added default-zero proof column does not legitimize an earlier rejection", () => {
  const path = fixture();
  const before = snapshot(path);
  expect(before.rows.payout_attempts![0]!.never_executed).toBe(0);
  refuse(path);
  expect(snapshot(path)).toEqual(before);
});

test("a proof-bearing rejection reopens without changing its terms, invoice, approval or payment identities", () => {
  const path = fixture("rejected", 1);
  const before = snapshot(path);
  const reopened = openDb(path);
  reopened.close();
  expect(snapshot(path)).toEqual(before);
  expect(before.rows.payout_attempts![0]!.never_executed).toBe(1);
  expect(before.rows.payout_attempts![0]!.approval_id).toBe(ids.approval);
  expect(before.rows.payout_attempts![0]!.vote_correlation_id).toBe(ids.vote);
});

test("unambiguous legacy unknown, processing and paid identities migrate with default-zero proof", () => {
  for (const state of ["unknown", "processing", "paid"] as const) {
    const path = fixture(state, 0, true);
    const before = snapshot(path);
    const reopened = openDb(path);
    reopened.close();
    const after = snapshot(path);
    expect(after.rows.payout_attempts![0]!.never_executed).toBe(0);
    const { never_executed, ...preserved } = after.rows.payout_attempts![0]!;
    expect(preserved).toEqual(before.rows.payout_attempts![0]!);
    for (const table of tables.filter((table) => table !== "payout_attempts")) expect(after.rows[table]).toEqual(before.rows[table]);
    expect(after.rows.payout_attempts![0]!.request_id).toBe(ids.request);
    expect(after.rows.payout_attempts![0]!.state).toBe(state);
  }
});

test("repeated refusal cannot partially migrate an unsafe ledger into a subsequently accepted one", () => {
  for (const legacy of [true, false]) {
    const path = fixture("rejected", 0, legacy);
    const before = snapshot(path);
    refuse(path);
    refuse(path);
    expect(snapshot(path)).toEqual(before);
  }
});

test("pre-proof v3 freeing manual resolutions refuse startup and preserve any already-created replacement identity", () => {
  for (const resolution of ["reowe", "rejected"] as const) {
    for (const legacy of [true, false]) {
      const path = fixture("failed", 0, legacy, { resolution });
      const db = new Database(path, { strict: true });
      try {
        // Earlier code may already have created a replacement after freeing the original uncertain amount.
        db.query("INSERT INTO payout_attempts (request_id, kind, contract_id, seq, attempt, run_id, recipient, amount_atomic, state, correlation_id, created_at, updated_at) VALUES (?, 'payout', ?, 2, 1, ?, 'maria.demo', '300000000', 'unknown', ?, ?, ?)")
          .run("compat-replacement-request", ids.contract, ids.judgment, "compat-replacement-payment", "2026-11-20T12:01:00Z", "2026-11-20T12:01:00Z");
      } finally { db.close(); }
      const before = snapshot(path);
      refuse(path);
      refuse(path);
      expect(snapshot(path)).toEqual(before);
      expect(before.rows.payout_attempts!.map((r) => r.request_id)).toEqual([ids.request, "compat-replacement-request"]);
    }
  }
});

test("v3 freeing manual resolutions reopen only with non-execution proof and no contradictory transaction evidence", () => {
  for (const resolution of ["reowe", "rejected"] as const) {
    const safePath = fixture("failed", 1, false, { resolution });
    const before = snapshot(safePath);
    openDb(safePath).close();
    expect(snapshot(safePath)).toEqual(before);
    for (const evidence of [{ txHash: "fixture-positive-tx" }, { refundTxHash: "fixture-refund-tx" }]) {
      const unsafePath = fixture("failed", 1, false, { resolution, ...evidence });
      const unsafeBefore = snapshot(unsafePath);
      refuse(unsafePath);
      expect(snapshot(unsafePath)).toEqual(unsafeBefore);
    }
  }
});

test("manual arrived and v2 legacy failure review retain their existing compatibility behavior", () => {
  const arrived = fixture("failed", 0, false, { resolution: "arrived" });
  const arrivedBefore = snapshot(arrived);
  openDb(arrived).close();
  expect(snapshot(arrived)).toEqual(arrivedBefore);
  for (const resolution of ["reowe", "rejected"] as const) {
    const legacy = fixture("failed", 0, true, { resolution, v2: true });
    const before = snapshot(legacy);
    openDb(legacy).close();
    const after = snapshot(legacy);
    const { never_executed, ...retained } = after.rows.payout_attempts![0]!;
    expect(never_executed).toBe(0);
    expect(retained).toEqual(before.rows.payout_attempts![0]!);
    for (const table of tables.filter((table) => table !== "payout_attempts")) expect(after.rows[table]).toEqual(before.rows[table]);
  }
});
