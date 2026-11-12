/**
 * True Paperwork process restart on an independent, isolated SDK gateway.
 * Default fault: the local proxy suppresses the completed proposal's app HTTP response.
 * PAPERWORK_RESTART_DROP_WITHDRAW=1 additionally uses the existing stack's provider-response-loss control.
 * PAPERWORK_RESTART_COLLECT=1 also checks the read-only collector after stopping the synthetic app.
 * PAPERWORK_RECOVERY_REHEARSAL=1 restores a seeded historical fixture and observes a separate working copy.
 * PLATFORM_STACK_DIR=<fresh loopback stack directory> bun scripts/demo-job-restart.ts
 */
import { Database } from "bun:sqlite";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { parseTerms, scopeTotal, USDC_DECIMALS } from "../src/shared/terms";
import { toAtomic } from "../src/shared/money";
import type { ContractView, NextStep, SignRequest } from "../src/shared/views";
import type { JobSubmissionInput, JobSubmissionView } from "../src/shared/jobs";
import { readStack, StackControls } from "../src/server/platform/stack";

const root = resolve(import.meta.dir, "..");
const collect = process.env.PAPERWORK_RESTART_COLLECT === "1";
const recovery = process.env.PAPERWORK_RECOVERY_REHEARSAL === "1";
const dropWithdrawResponse = process.env.PAPERWORK_RESTART_DROP_WITHDRAW === "1";
if (recovery && (collect || dropWithdrawResponse || process.argv.some(value => value === "--full" || value === "--full-check")))
  throw new Error("Recovery rehearsal cannot be combined with collector, full-demo or provider-response-drop modes.");
if (collect && (dropWithdrawResponse || process.argv.some(value => value === "--full" || value === "--full-check")))
  throw new Error("Collector proof cannot be combined with full-demo or provider-response-drop modes.");
const stackDir = process.env.PLATFORM_STACK_DIR;
if (!stackDir) throw new Error("Set PLATFORM_STACK_DIR to a fresh isolated platform stack holding state.json.");
const stack = readStack(stackDir);
for (const value of [stack.url, stack.rpcUrl]) {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) throw new Error("This proof only supports an isolated loopback stack.");
}
const initialState = JSON.parse(readFileSync(stack.stateFile, "utf8")) as StackState;
if (initialState.transfers.length || initialState.createdAgents.length) throw new Error("Use a fresh stack with no created Organization agents or payments; do not replay this job in a used stack.");
const artifactDir = mkdtempSync(join(process.env.PAPERWORK_RESTART_ARTIFACTS ?? "/tmp", "paperwork-job-restart-"));
const appSnapshot = join(artifactDir, "app");
let databasePath = join(artifactDir, "state", "paperwork.sqlite");
mkdirSync(appSnapshot);
mkdirSync(dirname(databasePath));
const hash = (contents: string | Uint8Array) => createHash("sha256").update(contents).digest("hex");

/** Only source, package metadata and public installed dependencies. No application secrets or runtime state. */
function manifest(directory: string) {
  const files: { path: string; sha256: string }[] = [];
  const scan = (path: string, relative: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) scan(join(path, entry.name), name);
      else if (entry.isFile()) files.push({ path: name, sha256: hash(readFileSync(join(path, entry.name))) });
      else throw new Error(`Unexpected source symlink: ${name}`);
    }
  };
  scan(join(directory, "src"), "src");
  for (const name of ["package.json", "bun.lock", "tsconfig.json"]) files.push({ path: name, sha256: hash(readFileSync(join(directory, name))) });
  if (recovery) for (const name of ["recovery-rehearsal.ts", "recovery-observer.ts"]) {
    const path = `scripts/${name}`;
    files.push({ path, sha256: hash(readFileSync(join(directory, path))) });
  }
  return { sha256: hash(JSON.stringify(files)), files };
}
function dependencyManifest(directory: string) {
  const entries: { path: string; sha256?: string; link?: string }[] = [];
  const base = realpathSync(directory);
  const scan = (path: string, relative = "") => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const full = join(path, entry.name);
      if (entry.isDirectory()) scan(full, name);
      else if (entry.isFile()) entries.push({ path: name, sha256: hash(readFileSync(full)) });
      else if (entry.isSymbolicLink()) {
        const target = realpathSync(full);
        if (target !== base && !target.startsWith(`${base}/`)) throw new Error(`Dependency symlink leaves the public installed tree: ${name}`);
        entries.push({ path: name, link: readlinkSync(full) });
      } else throw new Error(`Unsupported dependency entry: ${name}`);
    }
  };
  scan(directory);
  return { sha256: hash(JSON.stringify(entries)), entries };
}
const sourceBefore = manifest(root);
for (const name of ["src", "package.json", "bun.lock", "tsconfig.json"]) cpSync(join(root, name), join(appSnapshot, name), { recursive: true });
if (recovery) {
  mkdirSync(join(appSnapshot, "scripts"));
  for (const name of ["recovery-rehearsal.ts", "recovery-observer.ts"]) cpSync(join(root, "scripts", name), join(appSnapshot, "scripts", name));
}
if (manifest(root).sha256 !== sourceBefore.sha256 || manifest(appSnapshot).sha256 !== sourceBefore.sha256) throw new Error("The app source changed during snapshotting. No server or job was started; take a stable source snapshot first.");
const dependenciesBefore = dependencyManifest(join(root, "node_modules"));
cpSync(join(root, "node_modules"), join(appSnapshot, "node_modules"), { recursive: true, dereference: false, verbatimSymlinks: true });
const dependenciesCopied = dependencyManifest(join(appSnapshot, "node_modules"));
if (dependenciesCopied.sha256 !== dependenciesBefore.sha256 || dependencyManifest(join(root, "node_modules")).sha256 !== dependenciesBefore.sha256) throw new Error("Installed dependencies changed during snapshotting. No server or job was started.");
const sdkVersion = JSON.parse(readFileSync(join(appSnapshot, "node_modules/@multiagency/sdk/package.json"), "utf8")).version as string;
const nodeVersion = JSON.parse(readFileSync(join(stackDir, "../manifest.json"), "utf8")).node as string;
writeFileSync(join(artifactDir, "dependency-manifest.json"), JSON.stringify(dependenciesCopied, null, 2));
writeFileSync(join(artifactDir, "app-source-manifest.json"), JSON.stringify({ ...sourceBefore, runner_sha256: hash(readFileSync(import.meta.path)), dependencies_sha256: dependenciesCopied.sha256, sdk: sdkVersion, bun: Bun.version }, null, 2));

interface StackState {
  createdAgents: unknown[];
  simulated: string[];
  providerErrors: unknown[];
  transfers: { agent: string; correlation: string; status: string; recipient: string; amount: string }[];
}
interface ChildApp {
  process: ReturnType<typeof Bun.spawn>;
  origin: string;
  pid: number;
  generation: number;
  trace_path?: string;
  termination?: { requested_signal: "SIGKILL" | "SIGTERM"; requested_signals: ("SIGKILL" | "SIGTERM")[]; awaited_exit_result: number | null; observed_at: string; wait_timed_out?: boolean };
}
interface RecoveryTrace {
  event: "attempt" | "observation"; procedure: string; at: string; method?: string; violation?: boolean;
  ok?: boolean; request_id?: string; correlation_id?: string; state?: string; status?: string | null;
}
function recoveryTrace(app: ChildApp): RecoveryTrace[] {
  check(app.trace_path, "The supervised process did not retain an SDK trace.");
  return readFileSync(app.trace_path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as RecoveryTrace);
}
function assertFreshRecoveryReads(app: ChildApp, requestId: string, correlationId: string) {
  const trace = recoveryTrace(app), attempts = trace.filter(row => row.event === "attempt");
  check(trace.every(row => row.event === "attempt" || row.event === "observation") && attempts.length > 0 &&
    attempts.every(row => row.violation === false && row.method === "POST") &&
    trace.some(row => row.event === "observation" && row.ok === true && row.procedure === "payouts/status" && row.request_id === requestId && row.state === "processing") &&
    trace.some(row => row.event === "observation" && row.ok === true && row.procedure === "paymentStatus" && row.correlation_id === correlationId && row.status !== "SUCCESS"),
    "Each supervised process must successfully observe the original unsettled payout and payment without an SDK mutation attempt.");
  return trace;
}
const processes: ChildApp[] = [];
let active: ChildApp | null = null;
let proxy: ReturnType<typeof Bun.serve> | null = null;
const pause = (ms = 250) => Bun.sleep(ms);
const HTTP_TIMEOUT_MS = 30_000;
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function startApp(generation: number, observation?: { directory: string; organization: string; agent: string; requestId: string; correlationId: string }): Promise<ChildApp> {
  const logPath = join(artifactDir, `app-${generation}.log`);
  const tracePath = observation ? join(observation.directory, `app-${generation}-trace.jsonl`) : undefined;
  const child = Bun.spawn([process.execPath, "--no-env-file", observation ? "scripts/recovery-observer.ts" : "src/server/index.ts"], {
    cwd: appSnapshot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...(process.env.TMPDIR && { TMPDIR: process.env.TMPDIR }),
      PLATFORM: "remote", PLATFORM_STACK_DIR: stackDir!, PLATFORM_DEPLOYMENT: stack.deployment,
      DB_PATH: databasePath, PORT: "0", GITHUB: "fake", JUDGE: "rules", AGENT_POLL_MS: "0", STATUS_POLL_MS: "3600000",
      BETTER_AUTH_SECRET: "paperwork-process-restart-fixture-secret-only-not-for-hosting",
      ...(recovery && { COPILOTKIT_TELEMETRY_DISABLED: "true" }),
      ...(observation && { PAPERWORK_RECOVERY_TRACE: tracePath!, PAPERWORK_RECOVERY_ORGANIZATION: observation.organization,
        PAPERWORK_RECOVERY_AGENT: observation.agent, PAPERWORK_RECOVERY_REQUEST_ID: observation.requestId,
        PAPERWORK_RECOVERY_CORRELATION_ID: observation.correlationId }),
    },
    stdout: "pipe", stderr: "pipe",
  });
  let logs = "";
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      logs += new TextDecoder().decode(chunk.value);
      writeFileSync(logPath, logs);
    }
  };
  void capture(child.stdout as ReadableStream<Uint8Array>);
  void capture(child.stderr as ReadableStream<Uint8Array>);
  const candidate: ChildApp = { process: child, origin: "", pid: child.pid, generation, ...(tracePath && { trace_path: tracePath }) };
  processes.push(candidate);
  for (const until = Date.now() + 30_000; Date.now() < until; await pause(100)) {
    if (child.exitCode !== null) throw new Error(`App generation ${generation} exited (${child.exitCode}); inspect ${logPath}.`);
    const match = /→\s+(http:\/\/localhost:\d+\/)/.exec(logs);
    if (!match) continue;
    const origin = match[1]!.replace("localhost", "127.0.0.1");
    const health = await fetch(`${origin}api/config`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!health?.ok) continue;
    const config = await health.json() as { platform: string; stack: boolean; demo_controls: boolean };
    check(config.platform === "remote" && config.stack && config.demo_controls, "App must use the independent local SDK gateway.");
    candidate.origin = origin;
    return candidate;
  }
  await stopApp(candidate, "SIGKILL");
  throw new Error(`App generation ${generation} did not start; inspect ${logPath}.`);
}
async function stopApp(app: ChildApp, signal: "SIGKILL" | "SIGTERM") {
  if (app.termination) return;
  const signals: ("SIGKILL" | "SIGTERM")[] = [signal];
  app.process.kill(signal);
  const waitForExit = () => new Promise<{ result: number } | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000);
    void app.process.exited.then((result) => { clearTimeout(timer); resolve({ result }); });
  });
  let outcome = await waitForExit();
  if (!outcome && signal !== "SIGKILL") {
    signals.push("SIGKILL");
    app.process.kill("SIGKILL");
    outcome = await waitForExit();
  }
  app.termination = { requested_signal: signal, requested_signals: signals, awaited_exit_result: outcome?.result ?? null, observed_at: new Date().toISOString(), ...(!outcome && { wait_timed_out: true }) };
  if (!outcome) throw new Error(`Owned app process ${app.pid} did not report exit within the bounded stop window.`);
}
async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  check(active, "No app process is running.");
  const response = await fetch(`${active.origin}api${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${result.error ?? "request refused"}`);
  return result;
}
async function sign(req: SignRequest) {
  return request<{ account_id: string; publicKey: string; public_key: string; signature: string; nonce: string }>("POST", "/sim/sign", req);
}
async function observe(id: string, predicate: (view: ContractView) => boolean, label: string) {
  for (const until = Date.now() + 25_000; Date.now() < until; await pause()) {
    const view = await request<ContractView>("GET", `/contracts/${id}`);
    if (predicate(view)) return view;
  }
  throw new Error(`Timed out observing ${label}. No replacement payment was requested.`);
}
async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out; the outcome remains uncertain and its database/IDs are preserved. No replacement request is issued.`)), ms);
    void promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
function paymentIdentity(requestId: string, requireCorrelation = true) {
  const db = new Database(databasePath, { readonly: true, strict: true });
  try {
    const row = db.query("SELECT request_id, contract_id, run_id, correlation_id, approval_id, vote_correlation_id, recipient, amount_atomic, seq, attempt, state FROM payout_attempts WHERE request_id = ?").get(requestId) as { request_id: string; contract_id: string; run_id: string; correlation_id: string | null; approval_id: string | null; vote_correlation_id: string | null; recipient: string; amount_atomic: string; seq: number; attempt: number; state: string } | null;
    check(row && (!requireCorrelation || row.correlation_id), "The existing payout must have its durable request identity and, once known, its platform correlation.");
    return row;
  } finally { db.close(); }
}
const transcript: string[] = [];
function report(message: string) {
  console.log(message);
  transcript.push(message);
  writeFileSync(join(artifactDir, "transcript.txt"), transcript.join("\n") + "\n");
}
const platformSnapshotFile = join(resolve(stackDir, "../../../.."), "SNAPSHOT.json");
const receipt: Record<string, unknown> = {
  scope: "True app process kill/restart with durable SQLite and independent SDK gateway; simulated provider/chain/signatures/settlement only",
  fault_boundary: dropWithdrawResponse ? "Provider accepts withdrawal and its response is dropped by existing stack control; app HTTP proposal response also suppressed" : "Completed proposal app HTTP response suppressed by local proxy; not a lost gateway/provider response",
  provider_response_drop: dropWithdrawResponse,
  ...(collect && { collector_requested: true }),
  ...(recovery && { recovery_rehearsal_requested: true }),
  started_at: new Date().toISOString(), sdk: sdkVersion, bun: Bun.version, platform_node: nodeVersion,
  app_source_sha256: sourceBefore.sha256,
  dependencies_sha256: dependenciesCopied.sha256,
  database_relative_path: "state/paperwork.sqlite",
  platform_manifest: JSON.parse(readFileSync(join(stackDir, "../manifest.json"), "utf8")),
  platform_snapshot: existsSync(platformSnapshotFile) ? JSON.parse(readFileSync(platformSnapshotFile, "utf8")) : null,
  platform_provenance_scope: existsSync(platformSnapshotFile) ? "Pinned platform snapshot and E2E manifest" : "Caller-owned standalone E2E manifest; no release snapshot supplied",
};

/** This probe reads only its stopped synthetic app's copy and the launcher's still-running simulated gateway. */
async function collectProof(expected: { job: string; termsHash: string; requestId: string; correlationId: string | null; judgmentId: string | null }, providerBefore: StackState) {
  const startedAt = new Date().toISOString();
  check(!active && processes.every(app => app.termination && !app.termination.wait_timed_out), "Collector proof requires every owned app process to have stopped.");
  const directory = join(artifactDir, "collector");
  mkdirSync(directory, { mode: 0o700 });
  const ledgerFiles = () => ["", "-wal", "-shm", "-journal"].flatMap(suffix => {
    const path = `${databasePath}${suffix}`;
    if (!existsSync(path)) return [];
    const stat = lstatSync(path);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024 * 1024, "Stopped fixture ledger files must be bounded regular files.");
    return [{ suffix, bytes: stat.size, sha256: hash(readFileSync(path)) }];
  });
  const sourceFiles = ledgerFiles(), sourceDigest = hash(JSON.stringify(sourceFiles));
  check(sourceFiles.some(file => file.suffix === "") && !sourceFiles.some(file => file.suffix === "-journal"), "Collector proof needs the stopped fixture's main database without a rollback journal.");
  const backupDirectory = join(directory, "backup");
  mkdirSync(backupDirectory, { mode: 0o700 });
  const backupPath = join(backupDirectory, "paperwork.sqlite"), snapshotPath = join(directory, "snapshot.sqlite");
  cpSync(databasePath, backupPath);
  if (sourceFiles.some(file => file.suffix === "-wal")) cpSync(`${databasePath}-wal`, `${backupPath}-wal`);
  check(hash(JSON.stringify(ledgerFiles())) === sourceDigest, "Stopped source ledger changed during copying; collector was not started.");
  // Reconstruct shared memory and checkpoint only this disposable copy. Never open or checkpoint the source ledger.
  const snapshot = new Database(backupPath, { strict: true });
  try {
    const checkpoint = snapshot.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    check(checkpoint.busy === 0, "Disposable snapshot checkpoint did not finish.");
    const journal = snapshot.query("PRAGMA journal_mode = DELETE").get() as { journal_mode: string };
    check(journal.journal_mode === "delete", "Disposable snapshot did not reach standalone journal format.");
  } finally { snapshot.close(true); }
  // Bun may retain an orphan SHM file after leaving WAL mode. Keep it with the backup, never remove source sidecars.
  cpSync(backupPath, snapshotPath);
  check(["-wal", "-shm", "-journal"].every(suffix => !existsSync(`${snapshotPath}${suffix}`)), "Disposable snapshot still has sidecars.");
  check(hash(JSON.stringify(ledgerFiles())) === sourceDigest, "Snapshot preparation changed the stopped source ledger.");

  // Execute the same verified source copy as both app generations, never late-import the changing checkout.
  const [inspector, collector, adapter, reviewer, transport] = await Promise.all([
    import(join(appSnapshot, "src/server/recovery/inspect.ts")) as Promise<typeof import("../src/server/recovery/inspect")>,
    import(join(appSnapshot, "src/server/recovery/collect.ts")) as Promise<typeof import("../src/server/recovery/collect")>,
    import(join(appSnapshot, "src/server/recovery/sdk-reader.ts")) as Promise<typeof import("../src/server/recovery/sdk-reader")>,
    import(join(appSnapshot, "src/server/recovery/preview.ts")) as Promise<typeof import("../src/server/recovery/preview")>,
    import(join(appSnapshot, "src/server/platform/client.ts")) as Promise<typeof import("../src/server/platform/client")>,
  ]);
  const inspection = inspector.inspectLedger(snapshotPath), job = inspection.jobs.find(row => row.id === expected.job);
  const attempt = inspection.attempts[0];
  check(inspection.jobs.length === 1 && job?.terms_hash === expected.termsHash && inspection.attempts.length === 1 && attempt?.kind === "payout" &&
    attempt.request_id === expected.requestId && attempt.payout_correlation_id === expected.correlationId && attempt.judgment_id === expected.judgmentId && attempt.state === "paid",
    "Standalone snapshot did not retain the original job and settled payment identities.");
  const identity = { platform_origin: new URL(stack.url).origin, deployment: stack.deployment, contract_id: expected.job,
    terms_hash: expected.termsHash, organization: job.organization, agent: job.agent?.name, agent_id: job.agent?.id };
  const modules = ["src/server/recovery/inspect.ts", "src/server/recovery/evidence.ts", "src/server/recovery/collect.ts", "src/server/recovery/sdk-reader.ts",
    "src/server/recovery/preview.ts", "src/server/platform/client.ts", "node_modules/@multiagency/sdk/package.json", "node_modules/@multiagency/sdk/dist/contract/index.js"]
    .map(path => ({ path, sha256: hash(readFileSync(join(appSnapshot, path))) }));
  const provenance = { schema_version: 1, simulated_only: true, scope: "Standalone snapshot and SDK read transport only; no historical repair or resumption.",
    app_source_sha256: sourceBefore.sha256, dependencies_sha256: dependenciesCopied.sha256, sdk: sdkVersion, bun: Bun.version, platform_node: nodeVersion,
    platform_manifest_sha256: hash(JSON.stringify(receipt.platform_manifest)), platform_snapshot_sha256: hash(JSON.stringify(receipt.platform_snapshot)),
    stopped_source_files: sourceFiles, stopped_source_sha256: sourceDigest, snapshot: inspection.snapshot, original_binding: identity, executed_modules: modules };
  const provenanceText = `${JSON.stringify(provenance, null, 2)}\n`;
  const binding = collector.parseRecoveryBinding(inspection, { schema_version: 1, snapshot_sha256: inspection.snapshot.sha256, provenance_sha256: hash(provenanceText), ...identity });
  const calls: string[] = [], send = transport.caFetch(stack.caPem);
  const prefix = `/apps/v1/o/${encodeURIComponent(binding.organization)}/a/${encodeURIComponent(binding.agent)}/rpc/`;
  const observedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input)), procedure = url.pathname.slice(prefix.length);
    check(url.origin === binding.platform_origin && url.pathname.startsWith(prefix) && !url.search && !url.hash && init?.method === "POST" &&
      ["payouts/status", "paymentStatus", "owner/status", "held"].includes(procedure), "Collector transport attempted a request outside the four bound read procedures.");
    calls.push(procedure);
    return send(input, init);
  }) as typeof fetch;
  const reader = adapter.createRecoveryReader({ origin: binding.platform_origin, deployment: binding.deployment, credential: stack.credential, fetch: observedFetch });
  check(reader.sdk_version === sdkVersion, "Collector SDK version differs from the verified dependency snapshot.");
  const collection = await collector.collectRecoveryEvidence(inspection, binding, reader);
  const preview = reviewer.previewRecovery(inspection, collection), after = inspector.inspectLedger(snapshotPath);
  check(after.snapshot.sha256 === inspection.snapshot.sha256 && after.snapshot.bytes === inspection.snapshot.bytes &&
    hash(JSON.stringify(ledgerFiles())) === sourceDigest && manifest(appSnapshot).sha256 === sourceBefore.sha256, "Collector changed its source ledger, standalone snapshot or verified app source.");
  await pause(300);
  const providerAfter = JSON.parse(readFileSync(stack.stateFile, "utf8")) as StackState;
  const transfers = (state: StackState) => state.transfers.map(({ agent, correlation, status, recipient, amount }) => ({ agent, correlation, status, recipient, amount }));
  check(JSON.stringify(transfers(providerAfter)) === JSON.stringify(transfers(providerBefore)) && providerAfter.providerErrors.length === providerBefore.providerErrors.length &&
    providerAfter.createdAgents.length === providerBefore.createdAgents.length, "Collector created or changed simulated provider activity.");
  check(collection.payouts.length === 1 && collection.payouts[0]!.target_id === expected.requestId && collection.payments.length === 1 &&
    collection.payments[0]!.target_id === expected.correlationId && preview.items.length === 1 && preview.items[0]!.request_id === expected.requestId,
    "Collector did not preserve the original request and payment read scope.");
  const expectedCalls = [...collection.payouts.map(() => "payouts/status"), ...collection.payments.map(() => "paymentStatus"), ...collection.owners.map(() => "owner/status"), "held"];
  check(JSON.stringify(calls) === JSON.stringify(expectedCalls), "Collector read trace contains an extra, retried or missing HTTP request.");
  const reportText = `${JSON.stringify({ collection, preview }, null, 2)}\n`, bindingText = `${JSON.stringify(binding, null, 2)}\n`;
  check(![provenanceText, bindingText, reportText].some(text => text.includes(stack.credential)), "Collector artifacts contained the fixture credential.");
  writeFileSync(join(directory, "provenance.json"), provenanceText, { mode: 0o600 });
  writeFileSync(join(directory, "binding.json"), bindingText, { mode: 0o600 });
  writeFileSync(join(directory, "report.json"), reportText, { mode: 0o600 });
  const observations = [...collection.payouts, ...collection.payments, ...collection.owners, collection.held];
  receipt.collector = { scope: "Actual isolated SDK reads and standalone snapshot integrity only; no historical repair, financial clearance or resumption.",
    started_at: startedAt, completed_at: new Date().toISOString(),
    integration_read_pass: collection.complete && observations.every(row => row.result.response_sha256 !== null), clearance: "none", simulated_only: true,
    report_relative_path: "collector/report.json", report_sha256: hash(reportText), binding_sha256: collection.binding_sha256, provenance_sha256: hash(provenanceText),
    executed_modules_sha256: hash(JSON.stringify(modules)), snapshot: inspection.snapshot, stopped_source_sha256: sourceDigest, source_unchanged: true,
    request_id: expected.requestId, payment_correlation_id: expected.correlationId, sdk: reader.sdk_version, read_procedures: calls,
    preview_categories: preview.items.map(item => item.category), unsupported_original_requests: collection.payments.filter(row => row.result.ok && row.result.value.request === null).length,
    unknown_owner_phases: collection.owners.filter(row => row.result.ok && row.result.value.phase === null).length,
    provider_payment_count_before: providerBefore.transfers.length, provider_payment_count_after: providerAfter.transfers.length };
  check(collection.complete && observations.every(row => row.result.response_sha256 !== null), "Collector did not obtain all bounded SDK reads; its advisory artifacts remain available and authorize no correction.");
  report("07. PASS · standalone snapshot and original-ID SDK read transport; unknown metadata stays unresolved, no historical repair or resumption.");
}

try {
  report("Paperwork · TRUE APP PROCESS RESTART · independent SDK gateway");
  report(dropWithdrawResponse ? "SIMULATED provider, chain, signatures and funds. Faults: provider withdrawal response dropped by existing stack control, plus lost app HTTP proposal response." : "SIMULATED provider, chain, signatures and funds. Fault: lost app HTTP proposal response; no gateway/provider loss is claimed.");
  active = await startApp(1);
  const firstPid = active.pid;
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const terms = parseTerms({ ...JOB_DEMO_TERMS,
    company: "Acme Restart Demo",
    representative: { near_account: stack.owner },
    contractor: { ...JOB_DEMO_TERMS.contractor, near_account: stack.payees[0]! },
    payee: { chain: "near", address: stack.payees[0]! }, start: day(-7), end: day(21),
  });
  const created = await request<{ id: string; contractor_token: string }>("POST", "/contracts", terms);
  const id = created.id;
  const offered = await request<ContractView>("GET", `/contracts/${id}`);
  Object.assign(receipt, { job: id, terms_hash: offered.hash });
  report(`01. Offer ${id}; accepted terms ${offered.hash}`);
  for (const role of ["representative", "contractor"] as const) {
    const req = await request<SignRequest>("GET", `/contracts/${id}/signing-request?role=${role}`);
    await request("POST", `/contracts/${id}/signatures`, { role, signed: await sign(req), contractor_token: created.contractor_token });
  }
  let next = await request<NextStep>("POST", `/contracts/${id}/onboarding/next`, {});
  for (let i = 0; i < 100 && next.kind !== "done"; i++) {
    if (next.kind === "sign") {
      const s = await sign(next.sign);
      next = await request("POST", `/contracts/${id}/onboarding/signed`, { step: next.step, nonce: next.sign.nonce, publicKey: s.publicKey, signature: s.signature });
    } else if (next.kind === "owner_step") {
      check(next.sign, "Fixture owner step has no readable sign request.");
      const s = await sign(next.sign);
      await request("POST", `/owner-steps/${next.correlation_id}/submit`, { publicKey: s.publicKey, signature: s.signature });
      next = await request("POST", `/contracts/${id}/onboarding/next`, {});
    } else { await pause(); next = await request("POST", `/contracts/${id}/onboarding/next`, {}); }
  }
  check(next.kind === "done", "Setup did not finish.");
  await request("POST", "/sim/fund", { contract_id: id });
  await observe(id, (v) => v.stage === "active" && v.platform.balance_usd === "300", "fixture funding");
  const submission: JobSubmissionInput = {
    client_request_id: "restart-proof-original-submission",
    report: "CSV export and acceptance tests are complete. Agency review is requested under the signed scope and invoice.",
    evidence: [{ deliverable_id: "d1", label: "CSV export and tests", url: "https://github.com/acme/app/pull/101" }],
    invoice: { number: "INV-RESTART-001", amount_usd: "300" },
  };
  const submitted = await request<JobSubmissionView>("POST", `/contracts/${id}/submissions`, { ...submission, contractor_token: created.contractor_token });
  Object.assign(receipt, { submission: submitted.id, invoice: submitted.invoice.id });
  report(`02. Accepted and submitted ${submitted.id}; invoice ${submitted.invoice.id}`);
  if (dropWithdrawResponse) {
    await new StackControls(stackDir!).command("dropWithdrawResponse", {});
    report("02a. Armed the existing isolated provider dropWithdrawResponse control; no new simulator was introduced.");
  }

  let executionResolve!: (view: ContractView) => void;
  let executionReject!: (error: unknown) => void;
  const executed = new Promise<ContractView>((resolve, reject) => { executionResolve = resolve; executionReject = reject; });
  const origin = active.origin;
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    try {
      const response = await fetch(`${origin}api/submissions/${submitted.id}/propose`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      const view = await response.json() as ContractView & { error?: string };
      if (!response.ok) throw new Error(`Proposal failed before suppression: ${response.status} ${view.error ?? "refused"}`);
      executionResolve(view);
      // No response headers or body reach the client. Release this handler after the client aborts, with a bounded fallback.
      await Promise.race([new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })), pause(5000)]);
      return new Response("Suppressed response (local test only)", { status: 504 });
    } catch (error) { executionReject(error); return new Response("Fixture proxy failed", { status: 502 }); }
  } });
  const abort = new AbortController();
  const client = fetch(proxy.url, { method: "POST", body: "{}", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]) }).then(async (response) => {
    await response.text();
    return "received_response";
  }, () => "lost_response");
  const completed = await bounded(executed, HTTP_TIMEOUT_MS + 5000, "Completed proposal observation barrier");
  const before = completed.payouts.filter((p) => p.kind === "payout");
  check(before.length === 1 && (before[0]!.state === "held" || (dropWithdrawResponse && before[0]!.state === "unknown")), "Expected one held or uncertain original proposal, with no payment yet.");
  const requestId = before[0]!.request_id;
  const beforeIdentity = paymentIdentity(requestId, !dropWithdrawResponse);
  const originalSubmission = completed.submissions.find((s) => s.id === submitted.id)!;
  Object.assign(receipt, { judgment: originalSubmission.judgment_id, payout_request: requestId, payment_correlation: beforeIdentity.correlation_id, retained_identities_before: beforeIdentity, initial_payout_state: before[0]!.state });
  abort.abort();
  check(await client === "lost_response", "Expected the client to lose the app proposal response.");
  proxy.stop(true);
  proxy = null;
  report(`03. App HTTP response suppressed after durable proposal ${originalSubmission.judgment_id}; request ${requestId}`);
  await stopApp(active, "SIGKILL");
  active = null;
  report(`04. Killed app process ${firstPid}; independent gateway remains alive`);
  active = await startApp(2);
  check(active.pid !== firstPid, "Restart must start a distinct OS process.");
  const recovered = await observe(id, (v) => v.payouts.some((p) => p.request_id === requestId && p.state === "held"), "original held payout after restart");
  const recoveredSubmission = recovered.submissions.find((s) => s.id === submitted.id)!;
  const afterIdentity = paymentIdentity(requestId);
  check(recovered.hash === offered.hash, "Accepted terms changed across restart.");
  check(recovered.payouts.length === 1 && recovered.paid_usd === "0", "Recovery must preserve the one held, unpaid proposal.");
  check(recoveredSubmission.id === originalSubmission.id && recoveredSubmission.invoice.id === originalSubmission.invoice.id && recoveredSubmission.judgment_id === originalSubmission.judgment_id, "Submission, invoice or judgment identity changed.");
  check(afterIdentity.request_id === beforeIdentity.request_id && afterIdentity.run_id === beforeIdentity.run_id && (beforeIdentity.correlation_id === null || afterIdentity.correlation_id === beforeIdentity.correlation_id), "A known payment identity changed across app restart.");
  const sameSubmission = await request<JobSubmissionView>("POST", `/contracts/${id}/submissions`, { ...submission, contractor_token: created.contractor_token });
  check(sameSubmission.id === submitted.id && sameSubmission.invoice.id === submitted.invoice.id, "Original submission retry must remain idempotent.");
  const observedState = JSON.parse(readFileSync(stack.stateFile, "utf8")) as StackState;
  check(observedState.transfers.length === 1 && observedState.transfers[0]!.correlation === afterIdentity.correlation_id, "Recovery must not create another platform payment.");
  report(`05. Process ${active.pid} recovered the same submission/invoice/judgment/request/correlation; no replacement payment`);
  const vote = await request<{ correlation_id: string; sign: SignRequest | null }>("POST", `/payouts/${requestId}/vote`, { verdict: "approve" });
  check(vote.sign, "Held payout needs the fixture owner's explicit signature.");
  const signed = await sign(vote.sign);
  await request("POST", `/owner-steps/${vote.correlation_id}/submit`, { publicKey: signed.publicKey, signature: signed.signature });
  const approved = await observe(id, (v) => v.payouts.find((p) => p.request_id === requestId)?.state === "processing", "explicit approval");
  check(approved.paid_usd === "0", "Approval must not be treated as settlement.");
  let rehearsal: Awaited<ReturnType<typeof import("./recovery-rehearsal")["prepareRecoveryRehearsal"]>> | null = null;
  let resumedBefore: ContractView | null = null;
  if (recovery) {
    const stoppedDatabasePath = databasePath, approvedIdentity = paymentIdentity(requestId);
    await stopApp(active, "SIGTERM"); active = null;
    report("06a. Stopped the synthetic app before settlement; only separate backups will receive historical fixture seeding.");
    const module = await import(join(appSnapshot, "scripts/recovery-rehearsal.ts")) as typeof import("./recovery-rehearsal");
    rehearsal = await module.prepareRecoveryRehearsal({ artifactDirectory: artifactDir, stoppedDatabasePath, appSnapshot,
      stackDirectory: stackDir!, environment: { PATH: process.env.PATH ?? "/usr/bin:/bin", PLATFORM: "remote", PLATFORM_STACK_DIR: stackDir!,
        PLATFORM_DEPLOYMENT: stack.deployment, PORT: "0", GITHUB: "fake", JUDGE: "rules", AGENT_POLL_MS: "0", STATUS_POLL_MS: "3600000",
        COPILOTKIT_TELEMETRY_DISABLED: "true",
        BETTER_AUTH_SECRET: "paperwork-process-restart-fixture-secret-only-not-for-hosting" },
      job: id, requestId, correlationId: afterIdentity.correlation_id!, judgmentId: recoveredSubmission.judgment_id!,
      appSourceSha256: sourceBefore.sha256, dependenciesSha256: dependenciesCopied.sha256 });
    receipt.recovery = { ...rehearsal.preparation, stage: "exported_and_inventoried", clearance: "none" };
    databasePath = rehearsal.workingDatabasePath;
    const observation = { directory: rehearsal.directory, organization: rehearsal.binding.organization, agent: rehearsal.binding.agent,
      requestId, correlationId: afterIdentity.correlation_id! };
    active = await startApp(3, observation);
    resumedBefore = await observe(id, view => view.payouts.some(p => p.request_id === requestId && p.state === "disputed"), "restored hold through fresh SDK observation");
    check(resumedBefore.committed_usd === "300" && resumedBefore.paid_usd === "0" && resumedBefore.open_judgment === null &&
      resumedBefore.submissions.some(s => s.id === submitted.id && s.invoice.id === submitted.invoice.id && s.judgment_id === recoveredSubmission.judgment_id && s.state === "disputed"),
      "Restoration did not retain the original committed dispute, submission, invoice and judgment.");
    const firstRecoveryReads = assertFreshRecoveryReads(active, requestId, afterIdentity.correlation_id!);
    const firstRecoveryIdentity = paymentIdentity(requestId), firstRecoveryPid = active.pid;
    check(["request_id", "contract_id", "run_id", "correlation_id", "approval_id", "vote_correlation_id", "recipient", "amount_atomic", "seq", "attempt"]
      .every(key => firstRecoveryIdentity[key as keyof typeof firstRecoveryIdentity] === approvedIdentity[key as keyof typeof approvedIdentity]), "Handoff replaced an original payment identity.");
    await stopApp(active, "SIGKILL"); active = null;
    active = await startApp(4, observation);
    check(active.pid !== firstRecoveryPid, "Recovery restart did not replace the OS process.");
    const afterRestart = await observe(id, view => view.payouts.some(p => p.request_id === requestId && p.state === "disputed"), "same working database after recovery restart");
    check(afterRestart.hash === offered.hash && afterRestart.payouts.length === 1 && afterRestart.committed_usd === "300" && afterRestart.paid_usd === "0" &&
      afterRestart.submissions.some(s => s.id === submitted.id && s.invoice.id === submitted.invoice.id && s.judgment_id === recoveredSubmission.judgment_id) &&
      JSON.stringify(paymentIdentity(requestId)) === JSON.stringify(firstRecoveryIdentity), "Recovery restart changed the original hold or identities.");
    const restartedRecoveryReads = assertFreshRecoveryReads(active, requestId, afterIdentity.correlation_id!);
    const state = JSON.parse(readFileSync(stack.stateFile, "utf8")) as StackState;
    check(state.transfers.length === 1 && state.transfers[0]!.correlation === afterIdentity.correlation_id && state.transfers[0]!.status !== "SUCCESS",
      "The blocked/working-copy rehearsal created or settled a different payment.");
    receipt.recovery = { ...rehearsal.preparation, working_database_relative_path: "recovery/working/paperwork.sqlite",
      first_pid: firstRecoveryPid, restarted_pid: active.pid, timers_disabled: true, original_approved_identity: approvedIdentity,
      held_identity_before_restart: firstRecoveryIdentity, held_identity_after_restart: paymentIdentity(requestId),
      successful_observations_before_restart: firstRecoveryReads, successful_observations_after_restart: restartedRecoveryReads,
      committed_before_restart_usd: resumedBefore.committed_usd, committed_after_restart_usd: afterRestart.committed_usd,
      paid_before_settlement_usd: afterRestart.paid_usd, clearance: "none" };
    report("06b. Inventoried all blockers; mixed-history copy refused before any SDK call. Separate clean copy retained the original dispute across two no-timer app processes.");
  }
  await request("POST", "/sim/settle", { request_id: requestId });
  const settled = await observe(id, (v) => v.submissions.find((s) => s.id === submitted.id)?.state === "settled", "confirmed platform settlement");
  const paid = settled.payouts.find((p) => p.request_id === requestId)!;
  check(paid.state === "paid" && settled.paid_usd === "300", "The original payment did not settle.");
  await pause(400);
  const finalState = JSON.parse(readFileSync(stack.stateFile, "utf8")) as StackState;
  check(finalState.transfers.length === 1 && finalState.transfers[0]!.status === "SUCCESS" && finalState.transfers[0]!.correlation === afterIdentity.correlation_id, "Expected exactly one successful original payment.");
  const providerPayment = finalState.transfers[0]!;
  const signedScopeAmount = toAtomic(scopeTotal(terms), USDC_DECIMALS).toString();
  check(providerPayment.recipient === terms.payee.address, "The provider's settled recipient does not match the signed payee.");
  check(providerPayment.amount === signedScopeAmount, "The provider's settled amount does not match this job's signed scope total.");
  check(finalState.providerErrors.length === 0, "The simulator recorded a provider error.");
  if (rehearsal) {
    await stopApp(active, "SIGTERM"); active = null;
    const trace = processes.filter(app => app.trace_path).flatMap(recoveryTrace), attempts = trace.filter(row => row.event === "attempt");
    check(attempts.length > 0 && attempts.every(row => row.violation === false && row.method === "POST") &&
      trace.some(row => row.event === "observation" && row.ok === true && row.procedure === "payouts/status" && row.state === "succeeded" && row.request_id === requestId),
      "Supervised recovery attempted an outbound mutation or lacked fresh original-payment observations.");
    const preserved = rehearsal.verifyPreserved();
    receipt.recovery = { ...receipt.recovery as object, ...preserved, settled_request_id: paid.request_id, settled_payment_correlation: afterIdentity.correlation_id,
      paid_after_settlement_usd: settled.paid_usd, sdk_trace: trace, sdk_mutation_attempt_count: attempts.filter(row => row.violation).length,
      provider_payment_count_before: 1, provider_payment_count_after: finalState.transfers.length, result: "passed", clearance: "none" };
    check(manifest(appSnapshot).sha256 === sourceBefore.sha256, "The frozen rehearsal source changed during the run.");
    report("06c. Original approved payment settled once after restart; zero SDK mutation attempts. Both export bundles and their sources passed unchanged reuse verification.");
  }
  Object.assign(receipt, {
    result: "passed", completed_at: new Date().toISOString(), app_pids: recovery ? processes.map(app => app.pid) : [firstPid, active!.pid],
    job: id, terms_hash: settled.hash, submission: submitted.id, invoice: submitted.invoice.id,
    judgment: recoveredSubmission.judgment_id, payout_request: requestId, payment_correlation: afterIdentity.correlation_id,
    approval: vote.correlation_id, settlement: paid.state, paid_usd: settled.paid_usd, tx_hash: paid.tx_hash,
    confirmation_source: "platform payouts/status succeeded; provider and chain simulated",
    platform_payment_count: finalState.transfers.length, successful_payment_count: finalState.transfers.filter((t) => t.status === "SUCCESS").length,
    provider_error_count: finalState.providerErrors.length, simulated: finalState.simulated,
    provider_recipient: providerPayment.recipient, provider_amount_atomic: providerPayment.amount, signed_scope_total_atomic: signedScopeAmount,
    retained_identities_before: beforeIdentity, retained_identities_after_restart: afterIdentity,
  });
  report(`06. Explicit agency approval followed by confirmed 300 USDC simulated settlement; ${paid.tx_hash ? `transaction ${paid.tx_hash}` : "gateway supplies no transaction hash"}`);
  if (collect) {
    check(active, "Collector mode requires the original active app.");
    await stopApp(active, "SIGTERM");
    active = null;
    await collectProof({ job: id, termsHash: settled.hash, requestId, correlationId: afterIdentity.correlation_id, judgmentId: recoveredSubmission.judgment_id }, finalState);
    receipt.completed_at = new Date().toISOString();
  }
  report(`PASS · true process restart, same durable identities, one confirmed simulated payment. Receipt: ${join(artifactDir, "receipt.json")}`);
} catch (error) {
  Object.assign(receipt, { result: "failed", completed_at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  proxy?.stop(true);
  const cleanupErrors: string[] = [];
  for (const app of processes) {
    if (!app.termination) {
      try { await stopApp(app, "SIGTERM"); }
      catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
    }
  }
  if (cleanupErrors.length) { receipt.result = "failed"; receipt.cleanup_errors = cleanupErrors; process.exitCode = 1; report(`FAIL · owned process cleanup: ${cleanupErrors.join("; ")}`); }
  if (receipt.result !== "passed") {
    // Timeouts never prove non-execution. Preserve any IDs already written, without another remote request.
    if (existsSync(databasePath)) {
      try {
        const db = new Database(databasePath, { readonly: true, strict: true });
        try { receipt.retained_payment_records_on_failure = db.query("SELECT request_id, contract_id, run_id, correlation_id, amount_atomic, state FROM payout_attempts ORDER BY created_at, rowid").all(); }
        finally { db.close(); }
      } catch { receipt.failure_identity_read = "Unavailable; inspect the preserved fixture database before any further action."; }
    }
  }
  const processRecords = processes.map((p) => ({ generation: p.generation, pid: p.pid, exit_code: p.process.exitCode, trace_path: p.trace_path, termination: p.termination }));
  writeFileSync(join(artifactDir, "receipt.json"), JSON.stringify({ ...receipt, app_processes: processRecords }, null, 2));
  writeFileSync(join(artifactDir, "processes.json"), JSON.stringify(processRecords, null, 2));
}
