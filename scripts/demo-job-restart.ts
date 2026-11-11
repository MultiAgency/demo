/**
 * True Covenant process restart on an independent, isolated SDK gateway.
 * Default fault: the local proxy suppresses the completed proposal's app HTTP response.
 * JOB_RESTART_DROP_WITHDRAW=1 additionally uses the existing stack's provider-response-loss control.
 * PLATFORM_STACK_DIR=<fresh loopback stack directory> bun scripts/demo-job-restart.ts
 */
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { parseTerms, scopeTotal, USDC_DECIMALS } from "../src/shared/terms";
import { toAtomic } from "../src/shared/money";
import type { ContractView, NextStep, SignRequest } from "../src/shared/views";
import type { JobSubmissionInput, JobSubmissionView } from "../src/shared/jobs";
import { readStack, StackControls } from "../src/server/platform/stack";

const root = resolve(import.meta.dir, "..");
const stackDir = process.env.PLATFORM_STACK_DIR;
if (!stackDir) throw new Error("Set PLATFORM_STACK_DIR to a fresh isolated platform stack holding state.json.");
const stack = readStack(stackDir);
const dropWithdrawResponse = process.env.JOB_RESTART_DROP_WITHDRAW === "1";
for (const value of [stack.url, stack.rpcUrl]) {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) throw new Error("This proof only supports an isolated loopback stack.");
}
const initialState = JSON.parse(readFileSync(stack.stateFile, "utf8")) as StackState;
if (initialState.transfers.length || initialState.createdAgents.length) throw new Error("Use a fresh stack with no created Organization agents or payments; do not replay this job in a used stack.");
const artifactDir = mkdtempSync(join(process.env.JOB_RESTART_ARTIFACTS ?? "/tmp", "covenant-job-restart-"));
const appSnapshot = join(artifactDir, "app");
const databasePath = join(artifactDir, "state", "covenant.sqlite");
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
  termination?: { requested_signal: "SIGKILL" | "SIGTERM"; requested_signals: ("SIGKILL" | "SIGTERM")[]; awaited_exit_result: number | null; observed_at: string; wait_timed_out?: boolean };
}
const processes: ChildApp[] = [];
let active: ChildApp | null = null;
let proxy: ReturnType<typeof Bun.serve> | null = null;
const pause = (ms = 250) => Bun.sleep(ms);
const HTTP_TIMEOUT_MS = 30_000;
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function startApp(generation: number): Promise<ChildApp> {
  const logPath = join(artifactDir, `app-${generation}.log`);
  const child = Bun.spawn([process.execPath, "src/server/index.ts"], {
    cwd: appSnapshot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...(process.env.TMPDIR && { TMPDIR: process.env.TMPDIR }),
      PLATFORM: "remote", PLATFORM_STACK_DIR: stackDir!, PLATFORM_DEPLOYMENT: stack.deployment,
      DB_PATH: databasePath, PORT: "0", GITHUB: "fake", JUDGE: "rules", AGENT_POLL_MS: "0", STATUS_POLL_MS: "3600000",
      BETTER_AUTH_SECRET: "covenant-process-restart-fixture-secret-only-not-for-hosting",
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
  const candidate: ChildApp = { process: child, origin: "", pid: child.pid, generation };
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
    const row = db.query("SELECT request_id, contract_id, run_id, correlation_id, amount_atomic, state FROM payout_attempts WHERE request_id = ?").get(requestId) as { request_id: string; contract_id: string; run_id: string; correlation_id: string | null; amount_atomic: string; state: string } | null;
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
const receipt: Record<string, unknown> = {
  scope: "True app process kill/restart with durable SQLite and independent SDK gateway; simulated provider/chain/signatures/settlement only",
  fault_boundary: dropWithdrawResponse ? "Provider accepts withdrawal and its response is dropped by existing stack control; app HTTP proposal response also suppressed" : "Completed proposal app HTTP response suppressed by local proxy; not a lost gateway/provider response",
  provider_response_drop: dropWithdrawResponse,
  started_at: new Date().toISOString(), sdk: sdkVersion, bun: Bun.version, platform_node: nodeVersion,
  app_source_sha256: sourceBefore.sha256,
  dependencies_sha256: dependenciesCopied.sha256,
  database_relative_path: "state/covenant.sqlite",
  platform_manifest: JSON.parse(readFileSync(join(stackDir, "../manifest.json"), "utf8")),
  platform_snapshot: JSON.parse(readFileSync(join(resolve(stackDir, "../../../.."), "SNAPSHOT.json"), "utf8")),
};

try {
  report("Covenant · TRUE APP PROCESS RESTART · independent SDK gateway");
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
  Object.assign(receipt, { work_order: id, terms_hash: offered.hash });
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
  Object.assign(receipt, {
    result: "passed", completed_at: new Date().toISOString(), app_pids: [firstPid, active.pid],
    work_order: id, terms_hash: settled.hash, submission: submitted.id, invoice: submitted.invoice.id,
    judgment: recoveredSubmission.judgment_id, payout_request: requestId, payment_correlation: afterIdentity.correlation_id,
    approval: vote.correlation_id, settlement: paid.state, paid_usd: settled.paid_usd, tx_hash: paid.tx_hash,
    confirmation_source: "platform payouts/status succeeded; provider and chain simulated",
    platform_payment_count: finalState.transfers.length, successful_payment_count: finalState.transfers.filter((t) => t.status === "SUCCESS").length,
    provider_error_count: finalState.providerErrors.length, simulated: finalState.simulated,
    provider_recipient: providerPayment.recipient, provider_amount_atomic: providerPayment.amount, signed_scope_total_atomic: signedScopeAmount,
    retained_identities_before: beforeIdentity, retained_identities_after_restart: afterIdentity,
  });
  report(`06. Explicit agency approval followed by confirmed 300 USDC simulated settlement; ${paid.tx_hash ? `transaction ${paid.tx_hash}` : "gateway supplies no transaction hash"}`);
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
  const processRecords = processes.map((p) => ({ generation: p.generation, pid: p.pid, exit_code: p.process.exitCode, termination: p.termination }));
  writeFileSync(join(artifactDir, "receipt.json"), JSON.stringify({ ...receipt, app_processes: processRecords }, null, 2));
  writeFileSync(join(artifactDir, "processes.json"), JSON.stringify(processRecords, null, 2));
}
