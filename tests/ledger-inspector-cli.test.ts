import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../scripts/inspect-ledger.ts", import.meta.url).pathname;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory() {
  const path = mkdtempSync(join(tmpdir(), "paperwork-inspector-cli-"));
  directories.push(path);
  return path;
}

async function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "--no-env-file", script, ...args], {
    cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exit };
}

/** Disposable fixtures built directly with SQLite: no app schema loader, runtime, auth or provider is imported. */
function fixture(unsafe = false) {
  const cwd = directory();
  const path = join(cwd, "standalone.sqlite");
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE app_identity (id INTEGER PRIMARY KEY, deployment TEXT);
      CREATE TABLE contracts (
        id TEXT PRIMARY KEY, terms TEXT, hash TEXT, organization TEXT, signing_recipient TEXT
      );
      CREATE TABLE platform_agents (organization TEXT PRIMARY KEY, agent TEXT, agent_id TEXT);
      CREATE TABLE judgments (id TEXT PRIMARY KEY, contract_id TEXT, outcome TEXT);
      CREATE TABLE job_submissions (id TEXT PRIMARY KEY, contract_id TEXT, judgment_id TEXT);
      CREATE TABLE job_invoices (id TEXT PRIMARY KEY, contract_id TEXT, submission_id TEXT);
      CREATE TABLE payout_attempts (
        request_id TEXT PRIMARY KEY, kind TEXT, contract_id TEXT, seq INTEGER, attempt INTEGER,
        run_id TEXT, recipient TEXT, amount_atomic TEXT, state TEXT, code TEXT,
        correlation_id TEXT, approval_id TEXT, vote_correlation_id TEXT,
        never_executed INTEGER, tx_hash TEXT, refund_tx_hash TEXT, refunded_amount TEXT, resolution TEXT
      );
      CREATE TABLE payout_lines (request_id TEXT, deliverable_id TEXT, amount_atomic TEXT);
      CREATE TABLE owner_steps (
        correlation_id TEXT PRIMARY KEY, organization TEXT, contract_id TEXT,
        kind TEXT, request_id TEXT, verdict TEXT, state TEXT
      );
    `);
    db.query("INSERT INTO app_identity (id, deployment) VALUES (1, ?)").run("fixture-paperwork");
    db.query("INSERT INTO contracts (id, terms, hash, organization, signing_recipient) VALUES (?, ?, ?, ?, ?)")
      .run("c_cli_original", '{"v":2}', "fixture-terms-hash", "c_cli_original", "covenant");
    db.query("INSERT INTO platform_agents (organization, agent, agent_id) VALUES (?, ?, ?)")
      .run("c_cli_original", "fixture-agent", "fixture-agent-id");
    db.query("INSERT INTO judgments (id, contract_id, outcome) VALUES (?, ?, ?)")
      .run("original-judgment", "c_cli_original", unsafe ? "rejected" : "approved");
    db.query(`INSERT INTO payout_attempts
      (request_id, kind, contract_id, seq, attempt, run_id, recipient, amount_atomic, state,
       correlation_id, approval_id, vote_correlation_id, never_executed, tx_hash, resolution)
      VALUES (?, 'payout', ?, 1, 1, ?, ?, '1000000', ?, ?, ?, ?, 0, ?, ?)`)
      .run("original-request", "c_cli_original", "original-judgment", "builder.fixture",
        unsafe ? "failed" : "paid", "original-payment", "original-approval", "original-owner-step",
        unsafe ? null : "fixture-transaction", unsafe ? "reowe" : null);
    db.query("INSERT INTO payout_lines (request_id, deliverable_id, amount_atomic) VALUES (?, 'd1', '1000000')")
      .run("original-request");
    db.query(`INSERT INTO owner_steps
      (correlation_id, organization, contract_id, kind, request_id, verdict, state)
      VALUES (?, ?, ?, 'approval_vote', ?, ?, 'success')`)
      .run("original-owner-step", "c_cli_original", "c_cli_original", "original-request", unsafe ? "reject" : "approve");
  } finally { db.close(); }
  return { cwd, path };
}

interface Report {
  schema_version: number;
  snapshot: { sha256: string; bytes: number };
  deployment: string | null;
  host: null;
  jobs: unknown[];
  attempts: { request_id: string }[];
  owner_steps: unknown[];
  findings: { code: string }[];
  summary: {
    job_count: number; attempt_count: number; unproven_release_count: number;
    contradiction_count: number; requires_review: boolean;
  };
}

test("help exits without loading a ledger or creating application state", async () => {
  const cwd = directory();
  const result = await run(["--help"], cwd, { DB_PATH: join(cwd, "must-not-exist.sqlite"), PLATFORM: "remote" });
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("bun --no-env-file scripts/inspect-ledger.ts <standalone-snapshot.sqlite>");
  expect(result.stdout).toContain("Exit codes:");
  expect(result.stdout).toContain("does not verify platform evidence or authorize startup or payment resumption");
  expect(result.stderr).toBe("");
  expect(readdirSync(cwd)).toEqual([]);
});

test("usage and unsupported options reject without creating the requested path or echoing values", async () => {
  const cwd = directory();
  const path = join(cwd, "private-fixture-value.sqlite");
  for (const args of [[], ["--repair"], ["--force", path], ["--write", path], ["--network", path],
    ["--config", "private-fixture-value"], ["--help", path], [path, path]]) {
    const result = await run(args, cwd);
    expect(result.exit).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid_arguments");
    expect(result.stderr).not.toContain("private-fixture-value");
    expect(existsSync(path)).toBe(false);
  }
  expect(readdirSync(cwd)).toEqual([]);
});

test("a missing snapshot fails with no partial report and is never created", async () => {
  const cwd = directory();
  const path = join(cwd, "missing-private-snapshot.sqlite");
  const result = await run([path], cwd);
  expect(result.exit).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("snapshot_required");
  expect(result.stderr).not.toContain(path);
  expect(existsSync(path)).toBe(false);
  expect(readdirSync(cwd)).toEqual([]);
});

test("a clean inventory emits pretty JSON and exit zero without app config or snapshot writes", async () => {
  const { cwd, path } = fixture();
  const before = readFileSync(path);
  const files = readdirSync(cwd);
  const result = await run([path], cwd, { PLATFORM: "remote", PUBLIC_URL: "invalid-fixture-origin", DB_PATH: join(cwd, "not-the-input.sqlite") });
  expect(result.exit).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain('\n  "schema_version": 1,');
  const report = JSON.parse(result.stdout) as Report;
  expect(report.schema_version).toBe(1);
  expect(report.snapshot).toEqual({ sha256: createHash("sha256").update(before).digest("hex"), bytes: before.byteLength });
  expect(report.deployment).toBe("fixture-paperwork");
  expect(report.host).toBeNull();
  expect(report.jobs).toHaveLength(1);
  expect(report.attempts.map((attempt) => attempt.request_id)).toEqual(["original-request"]);
  expect(report.owner_steps).toHaveLength(1);
  expect(report.summary).toMatchObject({ job_count: 1, attempt_count: 1, unproven_release_count: 0, contradiction_count: 0, requires_review: false });
  expect(report.findings).toEqual([]);
  expect(readFileSync(path)).toEqual(before);
  expect(readdirSync(cwd)).toEqual(files);
});

test("an unproven historical budget release emits its inventory with review exit two", async () => {
  const { cwd, path } = fixture(true);
  const before = readFileSync(path);
  const result = await run([path], cwd);
  expect(result.exit).toBe(2);
  expect(result.stderr).toBe("");
  const report = JSON.parse(result.stdout) as Report;
  expect(report.attempts.map((attempt) => attempt.request_id)).toEqual(["original-request"]);
  expect(report.summary).toMatchObject({ unproven_release_count: 1, requires_review: true });
  expect(report.findings.length).toBeGreaterThan(0);
  expect(readFileSync(path)).toEqual(before);
  expect(readdirSync(cwd)).toEqual(["standalone.sqlite"]);
});

test("invalid SQLite errors expose only a fixed diagnostic and leave the input unchanged", async () => {
  const cwd = directory();
  const path = join(cwd, "private-fixture-path.sqlite");
  const contents = "private-fixture-value that is not a SQLite database".repeat(4);
  writeFileSync(path, contents);
  const result = await run([path], cwd);
  expect(result.exit).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("The supplied snapshot cannot be inspected. (invalid_snapshot)\n");
  expect(result.stderr).not.toContain("private-fixture");
  expect(readFileSync(path, "utf8")).toBe(contents);
  expect(readdirSync(cwd)).toEqual(["private-fixture-path.sqlite"]);
});

test("a snapshot with a sidecar refuses without a partial report or changed files", async () => {
  const { cwd, path } = fixture();
  const before = readFileSync(path);
  writeFileSync(`${path}-wal`, "fixture-sidecar");
  const result = await run([path], cwd);
  expect(result.exit).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("snapshot_required");
  expect(readFileSync(path)).toEqual(before);
  expect(readFileSync(`${path}-wal`, "utf8")).toBe("fixture-sidecar");
  expect(readdirSync(cwd).sort()).toEqual(["standalone.sqlite", "standalone.sqlite-wal"]);
});
