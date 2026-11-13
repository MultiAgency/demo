import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindAppDeployment, openDb } from "../src/server/db";
import { migrateMarket } from "../src/server/market/db";
import { canonicalJson } from "../src/shared/canonical";
import { DEMO_TERMS, JOB_DEMO_TERMS } from "../src/shared/demo";
import { parsePlatformTerms, termsHash } from "../src/shared/terms";

// Disposable databases only; no application state, credentials, SDK calls or funds are used.
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const pathFor = () => {
  const directory = mkdtempSync(join(tmpdir(), "paperwork-db-binding-"));
  directories.push(directory);
  return join(directory, "fixture.sqlite");
};
const at = "2026-11-20T12:00:00.000Z";
const snapshot = (db: Database) => Object.fromEntries(["contracts", "market_agencies", "payout_attempts"].map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

test("an empty database keeps its first deployment binding across reopen, including while still empty", () => {
  const path = pathFor();
  let db = openDb(path);
  try {
    bindAppDeployment(db, "multiagency-paperwork");
    expect(() => bindAppDeployment(db, "multiagency-paperwork")).not.toThrow();
    expect(() => bindAppDeployment(db, "covenant")).toThrow(/deployment/i);
  } finally { db.close(); }
  db = openDb(path);
  try {
    expect(() => bindAppDeployment(db, "multiagency-paperwork")).not.toThrow();
    expect(() => bindAppDeployment(db, "covenant")).toThrow(/deployment/i);
  } finally { db.close(); }
});

for (const source of ["contracts", "market_agencies"] as const) {
  test(`unbound historical ${source} refuse a new app identity and allow only explicit legacy recovery`, () => {
    const db = openDb(":memory:");
    try {
      migrateMarket(db);
      if (source === "contracts") {
        const terms = parsePlatformTerms(JOB_DEMO_TERMS);
        db.query("INSERT INTO contracts (id, terms, hash, created_at, contractor_link_hash, organization, signing_recipient) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run("original-job", canonicalJson(terms), termsHash(terms), at, "original-private-link-hash", "original-organization", "covenant");
        db.query("INSERT INTO payout_attempts (request_id, kind, contract_id, seq, attempt, recipient, amount_atomic, state, correlation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run("original-payout", "payout", "original-job", 1, 1, terms.payee.address, "300000000", "unknown", "original-payment-correlation", at, at);
      } else {
        db.query("INSERT INTO market_agencies (id, name, organization, owner, signer, stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run("original-agency", "Original agency", "original-market-organization", "agency.demo", "wallet", "needs_setup", at, at);
      }
      const before = snapshot(db);
      expect(() => bindAppDeployment(db, "multiagency-paperwork")).toThrow(/deployment/i);
      expect(snapshot(db)).toEqual(before);
      expect(() => bindAppDeployment(db, "covenant")).not.toThrow();
      expect(() => bindAppDeployment(db, "multiagency-paperwork")).toThrow(/deployment/i);
      expect(snapshot(db)).toEqual(before);
    } finally { db.close(); }
  });
}

test("migration pins pre-Paperwork v2/v3 records to their original signing domain without changing accepted bytes", () => {
  const path = pathFor();
  const old = new Database(path, { strict: true });
  let before: Record<string, unknown>[] = [];
  try {
    // Real pre-column schema, not a current row with a rewritten recipient.
    old.exec(`CREATE TABLE contracts (
      id TEXT PRIMARY KEY, terms TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
      contractor_link_hash TEXT NOT NULL, rep_sig TEXT, contractor_sig TEXT, organization TEXT NOT NULL,
      payee_registered INTEGER, frozen INTEGER NOT NULL DEFAULT 0
    )`);
    for (const input of [DEMO_TERMS, JOB_DEMO_TERMS]) {
      const terms = parsePlatformTerms(input);
      old.query("INSERT INTO contracts (id, terms, hash, created_at, contractor_link_hash, rep_sig, organization) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(`original-v${terms.v}`, canonicalJson(terms), termsHash(terms), at, `original-v${terms.v}-link-hash`,
          JSON.stringify({ account_id: terms.representative.near_account, public_key: "fixture-key", signature: "original-saved-signature", nonce: "original-saved-nonce", signed_at: at }),
          `original-v${terms.v}-organization`);
    }
    before = old.query("SELECT * FROM contracts ORDER BY id").all() as Record<string, unknown>[];
  } finally { old.close(); }
  const migrated = openDb(path);
  try {
    const rows = migrated.query("SELECT * FROM contracts ORDER BY id").all() as Record<string, unknown>[];
    expect(rows.map((row) => row.signing_recipient)).toEqual(["covenant", "covenant"]);
    expect(rows.map(({ signing_recipient: _recipient, ...row }) => row)).toEqual(before);
  } finally { migrated.close(); }
  const reopened = openDb(path);
  try { expect(reopened.query("SELECT signing_recipient FROM contracts ORDER BY id").all()).toEqual([{ signing_recipient: "covenant" }, { signing_recipient: "covenant" }]); }
  finally { reopened.close(); }
});
