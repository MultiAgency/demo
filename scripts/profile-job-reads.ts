/** Repeatable offline scaling profile. No sockets, provider requests, credentials or payments. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Engine, type Deps } from "../src/server/engine";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { jobActionPlan } from "../src/shared/job-actions";
import { setup } from "../tests/support/harness";

const ctx = await setup(JOB_DEMO_TERMS);
const deps = (ctx.rt.engine as unknown as { d: Deps }).d;
const db = deps.db;
for (let i = 1; i < 5; i++) ctx.rt.engine.createContract({ ...JOB_DEMO_TERMS, company: `Owned profile fixture ${i}` });
let queries = 0, providerCalls = 0;
const queryShapes = new Map<string, number>();
const countedDb = new Proxy(db, { get(target, key) {
  const value = Reflect.get(target, key, target);
  if (key === "query") return (...args: unknown[]) => {
    queries++;
    const sql = String(args[0]); queryShapes.set(sql, (queryShapes.get(sql) ?? 0) + 1);
    return Reflect.apply(value, target, args);
  };
  return typeof value === "function" ? value.bind(target) : value;
} });
const forbidden = () => { providerCalls++; throw Error("The local read profile attempted an external operation"); };
const platform = new Proxy(deps.platform, { get(target, key, receiver) { const value = Reflect.get(target, key, receiver); return typeof value === "function" ? forbidden : value; } });
const engine = new Engine({ ...deps, db: countedDb, platform, chain: { isFullAccessKey: async () => forbidden(), isRegistered: async () => forbidden() } });
const account = "maria.demo";
const samples: unknown[] = [];
let unrelated = 0;
function measure(name: string, run: () => unknown) {
  for (let i = 0; i < 3; i++) run();
  queries = 0; queryShapes.clear();
  const times: number[] = [];
  for (let i = 0; i < 20; i++) { const start = performance.now(); run(); times.push(performance.now() - start); }
  times.sort((a, b) => a - b);
  return { name, samples: times.length, p50_ms: +times[9]!.toFixed(3), p95_ms: +times[18]!.toFixed(3),
    query_calls_per_read: queries / times.length, query_shapes: [...queryShapes.keys()] };
}
try {
  for (const size of [0, 500, 2500]) {
    db.transaction(() => {
      while (unrelated < size) {
        const fixture = ctx.rt.engine.createContract({ ...JOB_DEMO_TERMS, company: `Unrelated profile fixture ${unrelated++}`,
          representative: { near_account: "other-agency.demo" }, contractor: { ...JOB_DEMO_TERMS.contractor, near_account: "other-builder.demo" } });
        db.query(`INSERT INTO owner_steps (correlation_id,organization,contract_id,kind,action,standard,state,created_at,updated_at)
          VALUES (?,?,?,'approval_vote','{}','dao','submitted',?,?)`).run(`profile-owner-${unrelated}`, "unrelated-org", fixture.id,
            "2026-11-20T12:00:00Z", "2026-11-20T12:00:00Z");
        db.query("INSERT INTO events (contract_id,at,kind,text) VALUES (?,?,'alert','Synthetic history')").run(fixture.id, "2026-11-20T12:00:00Z");
      }
    })();
    db.exec("PRAGMA query_only = ON");
    samples.push({ owned_jobs: 5, unrelated_jobs: size, history_rows: 0, operations: [
      measure("list_jobs", () => engine.jobsFor(account)),
      measure("action_plans", () => engine.jobsFor(account).map(jobActionPlan)),
      measure("single_snapshot", () => engine.recordedJobSnapshot(ctx.id, account)),
    ] });
    db.exec("PRAGMA query_only = OFF");
  }
  db.transaction(() => {
    for (let revision = 1; revision <= 200; revision++) db.query(`INSERT INTO job_submissions
      (id,contract_id,client_request_id,content_hash,revision,terms_hash,builder,report,evidence,state,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'closed',?)`).run(`profile-${revision}`, ctx.id, `profile-${revision}`, "f".repeat(64), revision,
        "f".repeat(64), account, "Synthetic historical report. ".repeat(400), "[]", "2026-11-20T12:00:00Z");
  })();
  db.exec("PRAGMA query_only = ON");
  samples.push({ owned_jobs: 5, unrelated_jobs: unrelated, history_rows: 200, operations: [
    measure("list_jobs", () => engine.jobsFor(account)),
    measure("action_plans", () => engine.jobsFor(account).map(jobActionPlan)),
    measure("single_snapshot", () => engine.recordedJobSnapshot(ctx.id, account)),
  ] });
  db.exec("PRAGMA query_only = OFF");
  db.transaction(() => {
    for (let i = 5; i < 100; i++) ctx.rt.engine.createContract({ ...JOB_DEMO_TERMS, company: `Owned scaling fixture ${i}` });
  })();
  db.exec("PRAGMA query_only = ON");
  samples.push({ owned_jobs: 100, unrelated_jobs: unrelated, history_rows: 200, operations: [
    measure("list_jobs", () => engine.jobsFor(account)),
    measure("action_plans", () => engine.jobsFor(account).map(jobActionPlan)),
    measure("single_snapshot", () => engine.recordedJobSnapshot(ctx.id, account)),
  ] });
  const sources = ["../src/server/engine.ts", "../src/server/db.ts", "../src/server/jobs/read-queries.ts", "../src/server/ledger.ts", "./profile-job-reads.ts"];
  const result = { fixture_only: true, runtime: Bun.version,
    source_sha256: Object.fromEntries(sources.map((file) => [file, createHash("sha256").update(readFileSync(new URL(file, import.meta.url))).digest("hex")])),
    provider_calls: providerCalls, database_writes_during_measurements: false, cases: samples,
    limitations: "Warm in-memory SQLite measurements and query-method counts, not hosted latency, real model inference or provider performance. Synthetic unsigned records and history isolate local read costs." };
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex >= 0) {
    const path = process.argv[outputIndex + 1]; if (!path) throw Error("--output requires a file path");
    await Bun.write(path, JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result, null, 2));
} finally { db.exec("PRAGMA query_only = OFF"); await (await ctx.rt.auth.$context).checkSchema?.(); db.close(); }
