import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindAppDeployment, openDb } from "../src/server/db";
import { migrateMarket } from "../src/server/market/db";
import { inspectStartupCompatibility, StartupCompatibilityError } from "../src/server/recovery/compatibility";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const at = "2026-11-11T12:00:00.000Z", deployment = "fixture-deployment";
type RecordOptions = { state?: string; resolution?: string | null; proof?: number | string; tx?: string | null; refund?: string | null;
  amount?: string | null; version?: number; orphan?: boolean; kind?: "payout" | "attack" };
function record(db: Database, request: string, options: RecordOptions = {}) {
  const contract = `job-${request}`;
  if (!options.orphan) db.query("INSERT INTO contracts(id, terms, hash, created_at, contractor_link_hash, organization) VALUES(?,?,?,?,?,?)")
    .run(contract, JSON.stringify({ v: options.version ?? 3 }), hash(request), at, "synthetic-link-digest", `org-${request}`);
  db.query(`INSERT INTO payout_attempts(request_id,kind,contract_id,seq,attempt,run_id,recipient,amount_atomic,state,resolution,
    never_executed,tx_hash,refund_tx_hash,refunded_amount,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(request, options.kind ?? "payout", contract, 1, 1, null, "builder.demo", "300000000", options.state ?? "failed", options.resolution === undefined ? "reowe" : options.resolution,
      options.proof ?? 0, options.tx ?? null, options.refund ?? null, options.amount ?? null, at, at);
  db.query("INSERT INTO payout_lines VALUES(?,?,?)").run(request, "d1", "300000000");
}
function fixture(change: (db: Database) => void, bound: string | null = deployment) {
  const directory = mkdtempSync(join(tmpdir(), "paperwork-startup-inventory-")); directories.push(directory);
  const path = join(directory, "snapshot.sqlite"), db = openDb(":memory:");
  try {
    if (bound !== null) bindAppDeployment(db, bound);
    db.exec("PRAGMA foreign_keys = OFF;");
    change(db);
    const bytes = db.serialize();
    expect([...bytes.subarray(18, 20)]).toEqual([1, 1]);
    writeFileSync(path, bytes, { mode: 0o600 });
  } finally { db.close(true); }
  return { directory, path };
}
function candidate(path: string, change?: (db: Database) => void) {
  const result = join(path.slice(0, path.lastIndexOf("/")), `candidate-${Math.random().toString(16).slice(2)}.sqlite`);
  const db = Database.deserialize(readFileSync(path), { strict: true });
  try { change?.(db); writeFileSync(result, db.serialize(), { mode: 0o600 }); } finally { db.close(true); }
  return result;
}
function rows(path: string) {
  const db = Database.deserialize(readFileSync(path), { readonly: true });
  try {
    const schema = db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
    const tables = db.query("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[];
    return { schema, rows: tables.map(({ name }) => ({ name, rows: db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() })) };
  } finally { db.close(); }
}

describe("whole-snapshot startup compatibility inventory — offline disposable records", () => {
  test("reports every unsafe release across versions, orphans and raw counterevidence without joins or first-error truncation", () => {
    const unsafe = ["v2-unproved", "v3-manual", "unknown-version", "orphan-release", "proved-empty-tx", "refused-zero-refund", "malformed-proof"];
    const f = fixture(db => {
      record(db, unsafe[0]!, { version: 2, state: "rejected", resolution: null });
      record(db, unsafe[1]!, { version: 3 });
      record(db, unsafe[2]!, { version: 99, resolution: "rejected" });
      record(db, unsafe[3]!, { orphan: true });
      record(db, unsafe[4]!, { state: "rejected", resolution: null, proof: 1, tx: "" });
      record(db, unsafe[5]!, { state: "refused", resolution: null, amount: "0" });
      record(db, unsafe[6]!, { proof: "malformed" });
      record(db, "valid-proved-release", { proof: 1 });
      record(db, "valid-refusal", { state: "refused", resolution: null });
      for (const state of ["unknown", "processing", "paid"]) record(db, `ordinary-${state}`, { state, resolution: null });
      for (const resolution of ["arrived", "disputed"]) record(db, `human-${resolution}`, { resolution });
      record(db, "attack-is-not-a-payout", { kind: "attack", state: "rejected", resolution: null });
    });
    const before = readFileSync(f.path), contents = rows(f.path), files = readdirSync(f.directory);
    const report = inspectStartupCompatibility(f.path, deployment);
    expect(report).toMatchObject({ schema_version: 1, snapshot: { sha256: hash(before), bytes: before.length }, expected_deployment: deployment, complete: true, clearance: "none" });
    expect(report.blockers).toEqual([...unsafe].sort().map(request_id => ({ code: "unsafe_budget_release", request_id, contract_id: `job-${request_id}` })));
    expect(inspectStartupCompatibility(f.path, deployment)).toEqual(report);
    expect(readFileSync(f.path)).toEqual(before); expect(rows(f.path)).toEqual(contents); expect(readdirSync(f.directory)).toEqual(files);
    expect(() => openDb(candidate(f.path))).toThrow(/Payout v2-unproved.*non-execution proof/);
  });

  test("old schema, every unsafe payout and wrong deployment are reported together although actual startup stops at the first gate", () => {
    const f = fixture(db => {
      record(db, "unsafe-first", { version: 2 }); record(db, "unsafe-second", { version: 3 });
      db.exec("ALTER TABLE contracts ADD COLUMN credential_enc TEXT;");
      db.query("UPDATE contracts SET credential_enc = ?").run("PRIVATE-ENCRYPTED-CREDENTIAL-NOT-AN-IDENTITY");
    });
    const report = inspectStartupCompatibility(f.path, "another-deployment");
    expect(report.complete).toBe(true);
    expect(report.blockers.map(row => row.code)).toEqual(["deployment_mismatch", "provider_adapter_schema", "unsafe_budget_release", "unsafe_budget_release"]);
    expect(JSON.stringify(report)).not.toContain("PRIVATE-");
    expect(() => openDb(candidate(f.path))).toThrow(/older Paperwork/);
    expect(() => openDb(candidate(f.path, db => db.exec("ALTER TABLE contracts DROP COLUMN credential_enc")))).toThrow(/non-execution proof/);
    const db = Database.deserialize(readFileSync(f.path));
    try { expect(() => bindAppDeployment(db, "another-deployment")).toThrow(/belongs to deployment/); } finally { db.close(); }
  });

  test("the other provider-era marker, missing contracts.organization, is inventoried without hiding readable budget gates", () => {
    const f = fixture(db => { record(db, "unsafe-no-organization"); db.exec("ALTER TABLE contracts DROP COLUMN organization"); });
    const report = inspectStartupCompatibility(f.path, deployment);
    expect(report.complete).toBe(true);
    expect(report.blockers.map(row => row.code)).toEqual(["provider_adapter_schema", "unsafe_budget_release"]);
    expect(() => openDb(candidate(f.path))).toThrow(/older Paperwork/);
  });

  for (const records of ["contracts", "market-only"] as const) test(`an unbound default deployment refuses retained ${records}`, () => {
    const f = fixture(db => {
      if (records === "contracts") record(db, "already-paid", { state: "paid", resolution: null });
      else {
        migrateMarket(db);
        db.query("INSERT INTO market_agencies(id,name,organization,owner,signer,stage,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
          .run("fixture-agency", "PRIVATE-AGENCY-NAME", "fixture-market-org", "owner.demo", "wallet", "ready", at, at);
      }
    }, null);
    const before = readFileSync(f.path), report = inspectStartupCompatibility(f.path, "multiagency-paperwork");
    expect(report).toMatchObject({ complete: true, blockers: [{ code: "deployment_unbound" }], clearance: "none" });
    expect(JSON.stringify(report)).not.toContain("PRIVATE-"); expect(readFileSync(f.path)).toEqual(before);
    const db = openDb(candidate(f.path));
    try { expect(() => bindAppDeployment(db, "multiagency-paperwork")).toThrow(/existing records without a deployment binding/); } finally { db.close(); }
  });

  test("empty unbound databases and explicitly expected legacy binding initialization match startup policy without claiming clearance", () => {
    const empty = fixture(() => {}, null);
    expect(inspectStartupCompatibility(empty.path, "multiagency-paperwork")).toMatchObject({ complete: true, blockers: [], clearance: "none" });
    const legacy = fixture(db => record(db, "legacy-paid", { state: "paid", resolution: null }), null);
    expect(inspectStartupCompatibility(legacy.path, "covenant")).toMatchObject({ complete: true, blockers: [], clearance: "none" });
    const db = openDb(candidate(legacy.path));
    try { expect(() => bindAppDeployment(db, "covenant")).not.toThrow(); } finally { db.close(); }
  });

  for (const column of ["tx_hash", "refund_tx_hash", "resolution"] as const) test(`a missing required ${column} marks the inventory incomplete while retaining other readable gates`, () => {
    const f = fixture(db => { record(db, "missing-required"); db.exec(`DROP INDEX one_open_payout; ALTER TABLE payout_attempts DROP COLUMN ${column}`); });
    const before = readFileSync(f.path), report = inspectStartupCompatibility(f.path, "different-deployment");
    expect(report.complete).toBe(false);
    expect(report.blockers.map(row => row.code)).toEqual(["deployment_mismatch", "unsupported_schema"]);
    expect(readFileSync(f.path)).toEqual(before);
    expect(() => openDb(candidate(f.path))).toThrow();
  });

  test("missing app_identity deployment is incomplete rather than a guessed deployment match", () => {
    const f = fixture(db => { record(db, "unsafe-missing-binding"); db.exec("ALTER TABLE app_identity DROP COLUMN deployment"); });
    const report = inspectStartupCompatibility(f.path, deployment);
    expect(report.complete).toBe(false);
    expect(report.blockers.map(row => row.code)).toEqual(["unsafe_budget_release", "unsupported_schema"]);
  });

  test("missing legacy proof projects NULL and still identifies every released payout", () => {
    const f = fixture(db => {
      record(db, "old-proof-v2", { version: 2 }); record(db, "old-proof-v3", { version: 3 });
      db.exec("ALTER TABLE payout_attempts DROP COLUMN never_executed");
    });
    const report = inspectStartupCompatibility(f.path, deployment);
    expect(report.complete).toBe(true);
    expect(report.blockers.map(row => row.request_id)).toEqual(["old-proof-v2", "old-proof-v3"]);
    expect(() => openDb(candidate(f.path))).toThrow(/non-execution proof/);
  });

  test("missing legacy refund amount mirrors NULL startup projection and permitted additive migration only on a candidate copy", () => {
    const f = fixture(db => { record(db, "old-refund-proved", { proof: 1 }); db.exec("ALTER TABLE payout_attempts DROP COLUMN refunded_amount"); });
    const bytes = readFileSync(f.path);
    expect(inspectStartupCompatibility(f.path, deployment)).toMatchObject({ complete: true, blockers: [], clearance: "none" });
    const db = openDb(candidate(f.path));
    try { expect(db.query("SELECT refunded_amount FROM payout_attempts").get()).toEqual({ refunded_amount: null }); } finally { db.close(); }
    expect(readFileSync(f.path)).toEqual(bytes);
  });

  test("invalid inputs and wholly unsupported snapshots use fixed errors without private diagnostics", () => {
    const f = fixture(() => {});
    for (const expected of ["", ".", "..", "private/deployment"]) expect(() => inspectStartupCompatibility(f.path, expected)).toThrow(StartupCompatibilityError);
    writeFileSync(f.path, "PRIVATE-CORRUPT-SNAPSHOT");
    let failure: unknown;
    try { inspectStartupCompatibility(f.path, deployment); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "invalid_snapshot" }); expect(String(failure)).not.toContain("PRIVATE-");
    const db = new Database(":memory:");
    try { db.exec("CREATE TABLE unrelated(id INTEGER)"); writeFileSync(f.path, db.serialize()); } finally { db.close(); }
    expect(() => inspectStartupCompatibility(f.path, deployment)).toThrow(StartupCompatibilityError);
    try { inspectStartupCompatibility(f.path, deployment); } catch (error) { expect(error).toMatchObject({ code: "unsupported_snapshot" }); }
  });
});
