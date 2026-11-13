import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db";
import type { Deps } from "../src/server/engine";
import type { Ledger } from "../src/server/ledger";
import { BUILDER_ACCOUNT_SQL, REPRESENTATIVE_ACCOUNT_SQL } from "../src/server/jobs/read-queries";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { activate, setup } from "./support/harness";

test("account discovery parses only matching jobs and one snapshot does not enumerate the account", async () => {
  const ctx = await setup(JOB_DEMO_TERMS);
  const { ledger, d } = ctx.rt.engine as unknown as { ledger: Ledger; d: Deps };
  try {
    for (let i = 0; i < 100; i++) ctx.rt.engine.createContract({ ...JOB_DEMO_TERMS, company: `Unrelated ${i}`,
      representative: { near_account: "unrelated-agency.demo" }, contractor: { ...JOB_DEMO_TERMS.contractor, near_account: "unrelated-builder.demo" } });
    const second = ctx.rt.engine.createContract({ ...JOB_DEMO_TERMS, company: "Second owned record" });
    const parse = spyOn(ledger, "terms");
    try {
      expect(ctx.rt.engine.jobsFor("maria.demo")).toHaveLength(2);
      expect(new Set(parse.mock.calls.map(([row]) => row.id))).toEqual(new Set([ctx.id, second.id]));
      parse.mockClear();
      expect(ctx.rt.engine.listContracts("maria.demo")).toHaveLength(2);
      expect(new Set(parse.mock.calls.map(([row]) => row.id))).toEqual(new Set([ctx.id, second.id]));
      parse.mockClear();
      const list = spyOn(ctx.rt.engine, "jobsFor").mockImplementation(() => { throw Error("Snapshot must not enumerate jobs"); });
      try {
        expect(ctx.rt.engine.recordedJobSnapshot(ctx.id, "maria.demo").job.id).toBe(ctx.id);
        expect(new Set(parse.mock.calls.map(([row]) => row.id))).toEqual(new Set([ctx.id]));
        expect(parse.mock.calls.length).toBeLessThanOrEqual(3);
        expect(() => ctx.rt.engine.recordedJobSnapshot(ctx.id, "outsider.demo")).toThrow("named party");
      } finally { list.mockRestore(); }
    } finally { parse.mockRestore(); }
    const plan = JSON.stringify(d.db.query(`EXPLAIN QUERY PLAN SELECT * FROM contracts WHERE ${REPRESENTATIVE_ACCOUNT_SQL} = ? OR ${BUILDER_ACCOUNT_SQL} = ?`).all("maria.demo", "maria.demo"));
    expect(plan).toContain("contracts_representative_account");
    expect(plan).toContain("contracts_builder_account");
    expect(ctx.stub.calls.requestPayout).toBe(0);
  } finally { await (await ctx.rt.auth.$context).checkSchema?.(); d.db.close(); }
});

test("additive account indexes preserve original terms, signatures and malformed retained rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "paperwork-read-index-"));
  const path = join(directory, "fixture.sqlite");
  let db = openDb(path);
  try {
    // Reopening an existing database adds the indexes without rewriting its records.
    db.exec("DROP INDEX contracts_representative_account; DROP INDEX contracts_builder_account;");
    const insert = db.query("INSERT INTO contracts(id,terms,hash,created_at,contractor_link_hash,organization,rep_sig) VALUES(?,?,?,?,?,?,?)");
    insert.run("valid", JSON.stringify(JOB_DEMO_TERMS), "original-hash", "2026-11-13", "private-digest", "original-org", "original-signature-bytes");
    insert.run("malformed", "{not-json", "malformed-hash", "2026-11-13", "other-digest", "other-org", null);
    const before = db.query("SELECT * FROM contracts ORDER BY id").all();
    db.close();
    db = openDb(path);
    expect(db.query("SELECT * FROM contracts ORDER BY id").all()).toEqual(before);
    expect(db.query(`SELECT id FROM contracts WHERE ${BUILDER_ACCOUNT_SQL} = ?`).all("maria.demo")).toEqual([{ id: "valid" }]);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("history lookups use scoped indexes and ordered histories avoid temporary sorting", () => {
  const db = openDb(":memory:");
  try {
    const plan = (sql: string, ...args: string[]) => JSON.stringify(db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...args));
    const owner = plan("SELECT kind,state,request_id,confirm_url FROM owner_steps WHERE contract_id = ? OR (contract_id IS NULL AND organization = ?) ORDER BY created_at DESC,rowid DESC", "job", "org");
    expect(owner).toContain("owner_steps_contract_history");
    expect(owner).toContain("owner_steps_shared_history");
    expect(owner).not.toContain("SCAN owner_steps");
    expect(plan("SELECT correlation_id FROM owner_steps WHERE request_id = ? AND standard = 'dao' AND state IN ('prepared','submitted','unknown')", "request")).toContain("owner_steps_request");
    for (const [sql, args, index] of [
      ["SELECT * FROM payout_attempts WHERE contract_id = ? ORDER BY created_at DESC,rowid DESC", ["job"], "payout_attempts_contract_history"],
      ["SELECT * FROM events WHERE contract_id = ? ORDER BY id DESC LIMIT 100", ["job"], "events_contract_history"],
      ["SELECT text FROM events WHERE contract_id = ? AND kind = 'alert' ORDER BY id DESC LIMIT 1", ["job"], "events_contract_kind_history"],
    ] as const) {
      const result = plan(sql, ...args);
      expect(result).toContain(index);
      expect(result).not.toContain("TEMP B-TREE");
    }
  } finally { db.close(); }
});

test("one stored snapshot loads original payout history once", async () => {
  const ctx = await setup(JOB_DEMO_TERMS);
  const { ledger, d } = ctx.rt.engine as unknown as { ledger: Ledger; d: Deps };
  const attempts = spyOn(ledger, "attempts");
  try {
    expect(ctx.rt.engine.recordedJobSnapshot(ctx.id, "maria.demo").payments).toEqual([]);
    expect(attempts).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveBeenCalledWith(ctx.id);
  } finally { attempts.mockRestore(); await (await ctx.rt.auth.$context).checkSchema?.(); d.db.close(); }
});

test("batched discovery stays at six queries and matches individual stored snapshots", async () => {
  const ctx = await activate("300", JOB_DEMO_TERMS);
  const { d } = ctx.rt.engine as unknown as { d: Deps };
  const { Engine } = await import("../src/server/engine");
  let queries = 0;
  const countedDb = new Proxy(d.db, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key === "query") return (...args: unknown[]) => { queries++; return Reflect.apply(value, target, args); };
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const engine = new Engine({ ...d, db: countedDb });
  try {
    const submission = await ctx.rt.engine.submitJob(ctx.id, { client_request_id: "batch-original-report", report: "CSV export and acceptance tests are complete.",
      evidence: [{ deliverable_id: "d1", label: "Tests", url: "https://example.invalid/tests" }], invoice: { number: "BATCH-001", amount_usd: "300" } }, "maria.demo");
    await ctx.rt.engine.proposeJob(submission.id);
    for (let i = 0; i < 40; i++) ctx.rt.engine.createContract({ ...JOB_DEMO_TERMS, company: `Batch ${i}` });
    for (let i = 0; i < 30; i++) ctx.rt.engine.createContract({ ...JOB_DEMO_TERMS, company: `Foreign ${i}`,
      representative: { near_account: "foreign.demo" }, contractor: { ...JOB_DEMO_TERMS.contractor, near_account: "outsider.demo" } });
    const row = d.db.query("SELECT organization FROM contracts WHERE id = ?").get(ctx.id) as { organization: string };
    const insert = d.db.query(`INSERT INTO owner_steps (correlation_id,organization,contract_id,kind,action,standard,state,created_at,updated_at)
      VALUES (?,?,?,'approval_vote','{}','dao','unknown','2026-11-20','2026-11-20')`);
    insert.run("shared-original-owner", row.organization, null);
    insert.run("scoped-original-owner", row.organization, ctx.id);
    d.db.exec("PRAGMA query_only = ON");
    const jobs = engine.jobsFor("maria.demo");
    expect(jobs).toHaveLength(41);
    expect(queries).toBe(6);
    for (const job of jobs) expect(job).toEqual(ctx.rt.engine.recordedJobSnapshot(job.id, "maria.demo").job);
    queries = 0;
    expect(engine.jobsFor("nobody.demo")).toEqual([]);
    expect(queries).toBe(1);
  } finally { d.db.exec("PRAGMA query_only = OFF"); await (await ctx.rt.auth.$context).checkSchema?.(); d.db.close(); }
});
