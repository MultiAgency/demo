/** Synthetic SDK rehearsal support. Imported only from the restart runner's frozen source copy. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectStartupCompatibility } from "../src/server/recovery/compatibility";
import { collectRecoveryEvidence, evidenceDigest, parseRecoveryBinding } from "../src/server/recovery/collect";
import { exportRestorationBundle } from "../src/server/recovery/export";
import { inspectLedger } from "../src/server/recovery/inspect";
import { createRecoveryReader } from "../src/server/recovery/sdk-reader";
import { caFetch } from "../src/server/platform/client";
import { readStack } from "../src/server/platform/stack";

type Row = Record<string, string | number | null>;
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function save(path: string, value: unknown) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" }); }
function ledgerFiles(path: string) {
  return ["", "-wal", "-shm", "-journal"].flatMap(suffix => {
    const file = `${path}${suffix}`;
    if (!existsSync(file)) return [];
    const stat = lstatSync(file);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024 * 1024, "Fixture ledger files must be bounded regular files.");
    return [{ suffix, bytes: stat.size, sha256: sha(readFileSync(file)) }];
  });
}
function bundleFiles(path: string) {
  const names = readdirSync(path).sort();
  check(JSON.stringify(names) === JSON.stringify(["manifest.json", "receipt.json", "request.json", "snapshot.sqlite"]), "The retained export bundle changed its file set.");
  return names.map(name => ({ name, sha256: sha(readFileSync(join(path, name))) }));
}
function insert(db: Database, table: string, row: Row) {
  // Table/column names originate only from the fixture's known application tables, never user input.
  const columns = Object.keys(row);
  db.query(`INSERT INTO ${table} (${columns.map(name => `"${name}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row));
}

export interface RecoveryRehearsalInput {
  artifactDirectory: string;
  stoppedDatabasePath: string;
  appSnapshot: string;
  stackDirectory: string;
  environment: Record<string, string>;
  job: string;
  requestId: string;
  correlationId: string;
  judgmentId: string;
  appSourceSha256: string;
  dependenciesSha256: string;
}

export async function prepareRecoveryRehearsal(input: RecoveryRehearsalInput) {
  const directory = join(input.artifactDirectory, "recovery");
  mkdirSync(directory, { mode: 0o700 });
  const stack = readStack(input.stackDirectory);
  const stoppedBefore = ledgerFiles(input.stoppedDatabasePath);
  check(stoppedBefore.some(row => row.suffix === "") && !stoppedBefore.some(row => row.suffix === "-journal"), "The synthetic app must stop before a coherent backup is prepared.");
  const backupDirectory = join(directory, "backup"); mkdirSync(backupDirectory, { mode: 0o700 });
  const backup = join(backupDirectory, "paperwork.sqlite");
  cpSync(input.stoppedDatabasePath, backup);
  if (existsSync(`${input.stoppedDatabasePath}-wal`)) cpSync(`${input.stoppedDatabasePath}-wal`, `${backup}-wal`);
  check(JSON.stringify(ledgerFiles(input.stoppedDatabasePath)) === JSON.stringify(stoppedBefore), "The stopped original changed while its backup was copied.");
  const db = new Database(backup, { strict: true });
  try {
    const checkpoint = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    check(checkpoint.busy === 0, "Only the disposable backup may be checkpointed.");
    check((db.query("PRAGMA journal_mode = DELETE").get() as { journal_mode: string }).journal_mode === "delete", "Backup is not standalone.");
    const original = db.query("SELECT * FROM payout_attempts WHERE request_id = ?").get(input.requestId) as Row;
    check(original?.state === "processing" && original.correlation_id === input.correlationId && original.run_id === input.judgmentId &&
      original.tx_hash === null && original.refund_tx_hash === null && original.refunded_amount === null, "Historical seeding requires the original approved, unsettled synthetic payment without transfer evidence.");
    // Fixture-only old manual release. This is NOT an observed SDK failure or non-execution claim.
    check(db.query("UPDATE payout_attempts SET state = 'failed', resolution = 'reowe', never_executed = 0 WHERE request_id = ?").run(input.requestId).changes === 1,
      "The synthetic historical release was not seeded exactly once.");
  } finally { db.close(true); }
  const cleanSource = join(directory, "clean-source.sqlite"), mixedSource = join(directory, "mixed-source.sqlite");
  cpSync(backup, cleanSource); cpSync(backup, mixedSource);
  const mixed = new Database(mixedSource, { strict: true });
  const unrelated = ["fixture-unrelated-release", "fixture-orphan-release"];
  try {
    mixed.exec("PRAGMA foreign_keys = OFF;"); // Only to construct a disposable historical orphan challenge.
    const contract = mixed.query("SELECT * FROM contracts WHERE id = ?").get(input.job) as Row;
    insert(mixed, "contracts", { ...contract, id: "fixture-unrelated-job", hash: sha("synthetic unrelated startup blocker"), organization: "fixture-unrelated-organization" });
    const judgment = mixed.query("SELECT * FROM judgments WHERE id = ?").get(input.judgmentId) as Row;
    insert(mixed, "judgments", { ...judgment, id: "fixture-unrelated-judgment", contract_id: "fixture-unrelated-job" });
    const original = mixed.query("SELECT * FROM payout_attempts WHERE request_id = ?").get(input.requestId) as Row;
    for (const [index, requestId] of unrelated.entries()) {
      insert(mixed, "payout_attempts", { ...original, request_id: requestId,
        contract_id: index === 0 ? "fixture-unrelated-job" : "fixture-absent-job", run_id: index === 0 ? "fixture-unrelated-judgment" : null,
        correlation_id: null, approval_id: null, vote_correlation_id: null,
        state: index === 0 ? "failed" : "rejected", resolution: index === 0 ? "reowe" : null });
      mixed.query("INSERT INTO payout_lines SELECT ?, deliverable_id, amount_atomic FROM payout_lines WHERE request_id = ?").run(requestId, input.requestId);
    }
  } finally { mixed.close(true); }

  const readCalls: string[] = [], send = caFetch(stack.caPem);
  const sourceHashes = { clean: sha(readFileSync(cleanSource)), mixed: sha(readFileSync(mixedSource)) };
  async function exportCase(source: string, name: "clean" | "mixed") {
    const inspection = inspectLedger(source), job = inspection.jobs.find(row => row.id === input.job)!;
    const before = inspectStartupCompatibility(source, stack.deployment);
    save(join(directory, `${name}-before-compatibility.json`), before);
    const provenance = { schema_version: 1, simulated_only: true, fixture_seeded_historical_release: true,
      actual_platform_payment: "original approved PROCESSING, not a platform failure", app_source_sha256: input.appSourceSha256,
      dependencies_sha256: input.dependenciesSha256, snapshot: inspection.snapshot, stopped_source_files: stoppedBefore };
    save(join(directory, `${name}-provenance.json`), provenance);
    const binding = parseRecoveryBinding(inspection, { schema_version: 1, snapshot_sha256: inspection.snapshot.sha256,
      provenance_sha256: sha(`${JSON.stringify(provenance, null, 2)}\n`), platform_origin: new URL(stack.url).origin,
      deployment: stack.deployment, contract_id: input.job, terms_hash: job.terms_hash,
      organization: job.organization, agent: job.agent?.name, agent_id: job.agent?.id });
    const prefix = `/apps/v1/o/${encodeURIComponent(binding.organization)}/a/${encodeURIComponent(binding.agent)}/rpc/`;
    const observedFetch = (async (target: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(target instanceof Request ? target.url : String(target)), procedure = url.pathname.slice(prefix.length);
      check(url.origin === binding.platform_origin && url.pathname.startsWith(prefix) && !url.search && !url.hash && init?.method === "POST" &&
        ["payouts/status", "paymentStatus", "owner/status", "held"].includes(procedure), "Recovery evidence attempted a procedure outside its read allowlist.");
      readCalls.push(procedure); return send(target, init);
    }) as typeof fetch;
    const collection = await collectRecoveryEvidence(inspection, binding, createRecoveryReader({ origin: binding.platform_origin,
      deployment: binding.deployment, credential: stack.credential, fetch: observedFetch }));
    check(collection.complete && collection.payouts.length === 1 && collection.payments.length === 1 &&
      collection.payouts[0]!.target_id === input.requestId && collection.payments[0]!.target_id === input.correlationId,
      "The fresh collection did not cover the exact original payment.");
    const request = { correction_id: `rehearsal-${name}-restore`, request_id: input.requestId, binding, collection, collection_sha256: evidenceDigest(collection) };
    save(join(directory, `${name}-request.json`), request);
    const bundle = join(directory, `${name}-bundle`), result = exportRestorationBundle(source, request, bundle);
    const after = inspectStartupCompatibility(join(bundle, "snapshot.sqlite"), stack.deployment);
    save(join(directory, `${name}-after-compatibility.json`), after);
    return { source, request, bundle, result, before, after, initialFiles: bundleFiles(bundle), collection };
  }
  const clean = await exportCase(cleanSource, "clean"), mixedCase = await exportCase(mixedSource, "mixed");
  check(clean.before.complete && clean.before.blockers.length === 1 && clean.before.blockers[0]!.request_id === input.requestId &&
    clean.after.complete && clean.after.blockers.length === 0, "The clean case did not remove exactly its selected startup blocker.");
  const remaining = mixedCase.after.blockers.filter(row => row.code === "unsafe_budget_release").map(row => row.request_id).sort();
  check(mixedCase.before.complete && mixedCase.before.blockers.length === 3 && mixedCase.after.complete &&
    JSON.stringify(remaining) === JSON.stringify([...unrelated].sort()) && mixedCase.after.blockers.length === 2,
    "Correcting one job must leave every unrelated unsafe release inventoried, including the orphan.");

  const blockedDirectory = join(directory, "blocked-working"); mkdirSync(blockedDirectory, { mode: 0o700 });
  const blockedDatabase = join(blockedDirectory, "paperwork.sqlite"); cpSync(join(mixedCase.bundle, "snapshot.sqlite"), blockedDatabase);
  const blockedBefore = ledgerFiles(blockedDatabase), blockedTrace = join(directory, "blocked-startup-trace.jsonl");
  const child = Bun.spawn([process.execPath, "--no-env-file", "scripts/recovery-observer.ts"], { cwd: input.appSnapshot,
    env: { ...input.environment, DB_PATH: blockedDatabase, PAPERWORK_RECOVERY_TRACE: blockedTrace,
      PAPERWORK_RECOVERY_ORGANIZATION: clean.request.binding.organization, PAPERWORK_RECOVERY_AGENT: clean.request.binding.agent,
      PAPERWORK_RECOVERY_REQUEST_ID: input.requestId, PAPERWORK_RECOVERY_CORRELATION_ID: input.correlationId },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  check(exit === 1 && stderr.trim() === "Recovery observer startup refused (unsafe_budget_release); no listener or resumption clearance was produced." &&
    !stdout.includes("→") && existsSync(blockedTrace) && readFileSync(blockedTrace, "utf8") === "" &&
    JSON.stringify(ledgerFiles(blockedDatabase)) === JSON.stringify(blockedBefore), "The mixed-history copy must refuse startup before a listener, SDK call or database mutation.");
  save(join(directory, "blocked-startup.json"), { expected_refusal: true, pid: child.pid, exit_code: exit,
    listener_started: false, sdk_calls: 0, database_unchanged: true, blockers: mixedCase.after.blockers,
    diagnostic: stderr.trim(), clearance: "none" });
  const workingDirectory = join(directory, "working"); mkdirSync(workingDirectory, { mode: 0o700 });
  const workingDatabasePath = join(workingDirectory, "paperwork.sqlite"); cpSync(join(clean.bundle, "snapshot.sqlite"), workingDatabasePath);
  check(sha(readFileSync(workingDatabasePath)) === clean.result.manifest.output_snapshot_sha256, "Working copy does not match its immutable export.");
  const preparation = { simulated_only: true, fixture_seeded_historical_release: true,
    scope: "Clean fixture continuation and separate blocked mixed-history challenge; no real historical repair or startup clearance",
    source_hashes: sourceHashes, stopped_source_files: stoppedBefore,
    clean: { bundle_relative_path: "recovery/clean-bundle", manifest: clean.result.manifest, files: clean.initialFiles,
      blockers_before: clean.before.blockers, blockers_after: clean.after.blockers },
    mixed: { bundle_relative_path: "recovery/mixed-bundle", manifest: mixedCase.result.manifest, files: mixedCase.initialFiles,
      blockers_before: mixedCase.before.blockers, blockers_after: mixedCase.after.blockers,
      startup_refusal: { pid: child.pid, exit_code: exit, sdk_calls: 0, database_unchanged: true } },
    collector_read_procedures: readCalls, fresh_collections: [clean.collection, mixedCase.collection],
    working_initial_sha256: sha(readFileSync(workingDatabasePath)), clearance: "none" };
  save(join(directory, "preparation.json"), preparation);
  function verifyPreserved() {
    check(JSON.stringify(ledgerFiles(input.stoppedDatabasePath)) === JSON.stringify(stoppedBefore) &&
      sha(readFileSync(cleanSource)) === sourceHashes.clean && sha(readFileSync(mixedSource)) === sourceHashes.mixed,
      "A retained original or historical source changed during supervised recovery.");
    for (const item of [clean, mixedCase]) {
      check(JSON.stringify(bundleFiles(item.bundle)) === JSON.stringify(item.initialFiles), "A retained export bundle changed during supervised recovery.");
      check(exportRestorationBundle(item.source, item.request, item.bundle).result === "already_exported", "A retained bundle no longer passes exact completed reuse.");
    }
    return { stopped_source_unchanged: true, historical_sources_unchanged: true, bundle_files_unchanged: true, verified_bundle_reuse: true };
  }
  return { directory, workingDatabasePath, binding: clean.request.binding, preparation, verifyPreserved };
}
