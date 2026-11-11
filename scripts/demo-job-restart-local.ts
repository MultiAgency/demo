/** No-environment local launcher for the isolated SDK process-restart proof. No live services or funds. */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const pinnedDigest = "36a66cb4212faef9d651a342baead7203238eb19d866acf9a8b2ec6ef1e76518";
const pinnedSource = "f7caad4537e982190094e2654a064b25e7725f8a";
const pinnedDependencies = "eb9728c521ebb5d31d352941e3d3e20eaa33d9d08e8c3cb4567e4ce08f05c9eb";
const preflight = process.argv.includes("--preflight");
const bootstrapOnly = process.argv.includes("--bootstrap-only");
const fullCheck = process.argv.includes("--full-check");
const full = fullCheck || process.argv.includes("--full");
const artifactDir = mkdtempSync(join(tmpdir(), full ? "covenant-full-launch-" : "covenant-restart-launch-"));
const jobArtifacts = join(artifactDir, "jobs");
mkdirSync(jobArtifacts);
const suppliedStack = process.env.PLATFORM_STACK_DIR;
const record: Record<string, unknown> = { started_at: new Date().toISOString(), simulated_only: true, mode: suppliedStack ? "caller-owned-stack" : "owned-fresh-stack", launcher_sha256: sha(readFileSync(import.meta.path)), artifact_directory: artifactDir };
const logLines: string[] = [];
const owned: Owned[] = [];
let ownedStackDir: string | null = null;
let stackProcess: Owned | null = null;
let interrupted: string | null = null;
const pause = (ms = 100) => Bun.sleep(ms);
const appRunner = join(root, "scripts", fullCheck ? "demo-browser.ts" : full ? "demo-full.ts" : "demo-job-restart.ts");

interface Snapshot {
  runDigest: string; sourceHead: string; overlayDiffSha256: string | null; dependencyTree: string; node: string;
  frontend: { source: string; build: string };
}
interface Owned {
  child: ReturnType<typeof Bun.spawn>;
  label: string;
  output: string;
  done?: { exit_result: number | null; signals: string[]; wait_timed_out?: boolean };
}
function sha(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function log(message: string) {
  console.log(message);
  logLines.push(message);
  writeFileSync(join(artifactDir, "launcher.log"), logLines.join("\n") + "\n");
}
function loopback(value: string) {
  return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname);
}
function checkStack(stateFile: string, ownerRoot?: string) {
  const file = realpathSync(stateFile);
  if (ownerRoot) check(file.startsWith(`${realpathSync(ownerRoot)}/`), "The ready stack directory is outside this launcher's isolated copy.");
  const state = JSON.parse(readFileSync(file, "utf8")) as { app?: { base: string }; chain?: { rpc: string }; market?: { url: string } | null; createdAgents?: unknown[]; transfers?: unknown[] };
  check(state.app?.base && state.chain?.rpc && loopback(state.app.base) && loopback(state.chain.rpc), "Only an isolated loopback app gateway and chain are supported.");
  check(state.createdAgents?.length === 0 && state.transfers?.length === 0, "The restart proof needs a fresh stack; no previous job is retried.");
  if (full) check(state.market?.url && loopback(state.market.url), "The combined experience requires the isolated stack's --market simulator.");
  return dirname(file);
}

// The canonical source digest is the release-candidate algorithm: sorted relative filenames, NUL, bytes, NUL.
// Runtime output and node_modules are outside that digest. Refuse secret/runtime inputs before reading any files.
const runtimeNames = new Set([".test-artifacts", "node_modules", ".owner-intents", ".ops", ".invoices", ".strategy", ".plans", ".evidence", ".inbox", ".agreements", ".notify", ".work-orders", ".hosted", ".agent-connections", ".machine-auth", ".app-access", ".proposals"]);
function sourceDigest(directory: string) {
  const hash = createHash("sha256");
  const scan = (path: string, prefix = "") => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && (runtimeNames.has(entry.name) || entry.name === "SNAPSHOT.json")) continue;
      check(entry.name !== ".env" && entry.name !== ".aws" && entry.name !== ".git", "Unexpected secret or repository metadata in the frozen snapshot; nothing was copied.");
      const name = prefix + entry.name;
      if (entry.isDirectory()) scan(join(path, entry.name), `${name}/`);
      else if (entry.isFile()) hash.update(name).update("\0").update(readFileSync(join(path, entry.name))).update("\0");
      else throw new Error(`Unexpected source symlink: ${name}`);
    }
  };
  scan(directory);
  return hash.digest("hex");
}
function installedFingerprint(directory: string) {
  const store = join(directory, "node_modules", ".pnpm");
  return createHash("sha256").update(readFileSync(join(store, "lock.yaml"))).update("\0").update(readdirSync(store).sort().join("\n")).digest("hex");
}
function dependencyFingerprint(directory: string) {
  const base = realpathSync(directory);
  const hash = createHash("sha256");
  let entries = 0;
  const danglingLinks: string[] = [];
  const scan = (path: string, prefix = "") => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name, full = join(path, entry.name);
      if (entry.isDirectory()) scan(full, `${name}/`);
      else if (entry.isFile()) { hash.update(name).update("\0file\0").update(readFileSync(full)).update("\0"); entries++; }
      else if (entry.isSymbolicLink()) {
        const link = readlinkSync(full);
        const lexical = resolve(dirname(full), link);
        check(lexical === base || lexical.startsWith(`${base}/`), `Public dependency link leaves the installed tree: ${name}`);
        let target: string | null = null;
        try { target = realpathSync(full); }
        catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
        if (target) check(target === base || target.startsWith(`${base}/`), `Resolved public dependency link leaves the installed tree: ${name}`);
        else danglingLinks.push(name);
        hash.update(name).update("\0link\0").update(link).update(target ? "\0present\0" : "\0missing\0"); entries++;
      } else throw new Error(`Unsupported public dependency entry: ${name}`);
    }
  };
  scan(base);
  return { sha256: hash.digest("hex"), entries, dangling_links: danglingLinks };
}
function systemEnvironment(node?: string): Record<string, string> {
  return {
    PATH: node ? `${dirname(node)}:${process.env.PATH ?? "/usr/bin:/bin"}` : process.env.PATH ?? "/usr/bin:/bin",
    ...(process.env.TMPDIR && { TMPDIR: process.env.TMPDIR }),
    ...(process.env.LANG && { LANG: process.env.LANG }),
    ...(process.env.USER && { USER: process.env.USER }),
    ...(process.env.LOGNAME && { LOGNAME: process.env.LOGNAME }),
  };
}
function own(command: string[], label: string, cwd: string, env: Record<string, string>): Owned {
  check(!interrupted, `Launcher interrupted by ${interrupted}; no further process is started.`);
  const child = Bun.spawn(command, { cwd, env, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const proc: Owned = { child, label, output: "" };
  owned.push(proc);
  for (const stream of [child.stdout, child.stderr]) void (async () => {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const text = new TextDecoder().decode(chunk.value);
      proc.output += text;
      writeFileSync(join(artifactDir, `${label}.log`), proc.output);
      process.stdout.write(text);
    }
  })().catch((error) => log(`${label} output ended: ${String(error)}`));
  return proc;
}
async function waitExit(proc: Owned, ms: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void proc.child.exited.then((code) => { clearTimeout(timer); resolve(code); });
  });
}
function signalGroup(proc: Owned, signal: "SIGTERM" | "SIGKILL") {
  // detached:true made this child the leader of a new process group, containing only this launcher's descendants.
  try { process.kill(-proc.child.pid, signal); }
  catch (error) { if ((error as { code?: string }).code !== "ESRCH") throw error; }
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  interrupted = signal;
  record.interrupted = signal;
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  for (const proc of owned) if (!proc.done) signalGroup(proc, "SIGTERM");
});
async function stopOwned(proc: Owned, gracefulMs = 1000) {
  if (proc.done) return;
  let exit = await waitExit(proc, gracefulMs);
  const signals: string[] = [];
  if (exit === null) { signals.push("SIGTERM"); signalGroup(proc, "SIGTERM"); exit = await waitExit(proc, 5000); }
  if (exit === null) { signals.push("SIGKILL"); signalGroup(proc, "SIGKILL"); exit = await waitExit(proc, 5000); }
  proc.done = { exit_result: exit, signals, ...(exit === null && { wait_timed_out: true }) };
  check(exit !== null, `Owned ${proc.label} process group did not stop; inspect retained artifacts.`);
}
async function nodeExecutable(version: string) {
  const candidates = [...new Set([
    join(homedir(), ".nvm", "versions", "node", version, "bin", "node"),
    "/opt/homebrew/opt/node@24/bin/node",
    ...String(process.env.PATH ?? "").split(":").map((part) => join(part, "node")),
  ])];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const probe = Bun.spawn([candidate, "--version"], { env: systemEnvironment(), stdout: "pipe", stderr: "ignore", timeout: 3000 });
    const output = await new Response(probe.stdout).text();
    if (await probe.exited === 0 && output.trim() === version) return realpathSync(candidate);
  }
  throw new Error(`The pinned snapshot requires ${version}; no matching installed Node executable was found. Nothing was installed or started.`);
}
async function preparePlatform() {
  const candidates = [join(root, "..", "sdk", ".test-artifacts", "stack-snapshots", pinnedDigest), "/tmp/covenant-job-stack-nUaut7"];
  const source = candidates.find((path) => existsSync(join(path, "SNAPSHOT.json")));
  check(source, `Verified platform snapshot ${pinnedDigest} is missing. This launcher does not install dependencies or use a hosted gateway.`);
  const snapshot = JSON.parse(readFileSync(join(source, "SNAPSHOT.json"), "utf8")) as Snapshot;
  check(snapshot.runDigest === pinnedDigest && snapshot.sourceHead === pinnedSource && snapshot.overlayDiffSha256 === null && snapshot.dependencyTree === pinnedDependencies, "The available snapshot is not the pinned verified candidate.");
  log(`Verifying frozen platform ${snapshot.runDigest}; no app job has started.`);
  check(sourceDigest(source) === pinnedDigest, "Frozen platform source bytes do not match the pinned snapshot.");
  check(installedFingerprint(source) === pinnedDependencies, "Installed platform dependencies do not match the frozen candidate.");
  const node = await nodeExecutable(snapshot.node);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (runtimeNames.has(entry.name) && entry.name !== "node_modules" && entry.name !== ".test-artifacts") check(readdirSync(join(source, entry.name)).length === 0, "Frozen snapshot contains runtime state; it will not be read or copied.");
  }
  const destination = join(artifactDir, "platform");
  mkdirSync(destination);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (runtimeNames.has(entry.name)) continue;
    cpSync(join(source, entry.name), join(destination, entry.name), { recursive: true, verbatimSymlinks: true });
  }
  check(sourceDigest(destination) === pinnedDigest && sourceDigest(source) === pinnedDigest, "Platform source changed during copying; no stack was started.");
  const dependencies = realpathSync(join(source, "node_modules"));
  log("Fingerprinting and copying public platform dependencies into the isolated tree.");
  const before = dependencyFingerprint(dependencies);
  cpSync(dependencies, join(destination, "node_modules"), { recursive: true, dereference: false, verbatimSymlinks: true });
  const copied = dependencyFingerprint(join(destination, "node_modules"));
  check(before.sha256 === copied.sha256 && before.sha256 === dependencyFingerprint(dependencies).sha256, "Public dependency bytes or links changed while copying; no stack was started.");
  check(installedFingerprint(destination) === pinnedDependencies && installedFingerprint(source) === pinnedDependencies, "The copied installed dependency tree does not match the frozen candidate.");
  Object.assign(record, { platform_snapshot: snapshot, platform_source: source, isolated_platform_copy: destination, public_dependency_content: copied, node_executable: node, node_version: snapshot.node });
  writeFileSync(join(artifactDir, "copy-provenance.json"), JSON.stringify(record, null, 2));
  return { destination, node };
}

log(`Covenant ${full ? "combined app" : "local restart"} launcher · simulated provider, chain, signatures and funds only`);
log(`Artifacts: ${artifactDir}`);
try {
  let stackDir: string;
  if (suppliedStack) {
    stackDir = checkStack(join(suppliedStack, "state.json"));
    log("Using the explicitly supplied caller-owned fresh loopback stack; it will not be stopped by this launcher.");
  } else {
    const platform = await preparePlatform();
    if (preflight) {
      Object.assign(record, { result: "passed", scope: "preflight only; no server or application job started" });
      log("PASS · verified source, matching copied public dependencies and installed Node; no server or job started.");
      process.exitCode = 0;
      stackDir = "";
    } else {
      stackProcess = own([platform.node, "test/e2e/run.mjs", "--prebuilt-web", "--stack", "--app", "covenant", "--no-browser", "--owner", "acme.demo", "--payee", "maria.demo", "--builder", "attacker.demo", ...(full ? ["--market"] : [])], "platform-stack", platform.destination, systemEnvironment(platform.node));
      let ready = "";
      for (const until = Date.now() + 45_000; Date.now() < until; await pause()) {
        const match = /Isolated stack ready: ([^\r\n]+state\.json)/.exec(stackProcess.output);
        if (match) { ready = checkStack(match[1]!, platform.destination); break; }
        if (stackProcess.child.exitCode !== null) throw new Error("Owned offline stack exited before readiness; inspect platform-stack.log.");
      }
      check(ready, "Owned offline stack did not become ready within 45 seconds; no application job was started.");
      ownedStackDir = ready;
      record.stack_directory = ready;
      stackDir = ready;
    }
  }
  if (!preflight && !bootstrapOnly) {
    record.app_runner_sha256 = sha(readFileSync(appRunner));
    const job = own([process.execPath, appRunner], full ? "combined-app" : "restart-job", root, { ...systemEnvironment(), PLATFORM_STACK_DIR: stackDir, JOB_RESTART_ARTIFACTS: jobArtifacts,
      ...(full && { COVENANT_DEMO_ARTIFACTS: jobArtifacts, FULL_DEMO_PORT: process.env.FULL_DEMO_PORT ?? "3002" }),
      ...(fullCheck && { DEMO_BROWSER_FULL: "1" }),
      ...(!full && process.env.JOB_RESTART_DROP_WITHDRAW === "1" && { JOB_RESTART_DROP_WITHDRAW: "1" }),
    });
    const exit = full && !fullCheck ? await job.child.exited : await waitExit(job, fullCheck ? 360_000 : 180_000);
    check(exit !== null, "Restart proof exceeded its bounded window. Its database and IDs remain in the artifact directory; no replacement job will be created.");
    check(exit === 0 || (full && !fullCheck && interrupted), "Local check failed; inspect the child log and retained receipts. No replacement payment is attempted.");
    job.done = { exit_result: exit, signals: [] };
    record.result = full && !fullCheck ? "stopped" : "passed";
    record.scope = full ? "combined builder and market app on a fresh isolated SDK gateway; simulated only" : "full app process-restart proof through a fresh isolated SDK gateway; simulated only";
    log(full && !fullCheck ? "Stopped the combined local app; keeping its isolated artifacts." : `PASS · ${fullCheck ? "combined browser experience" : "one-command local SDK restart demonstration"} completed.`);
  } else if (bootstrapOnly || suppliedStack) {
    record.result = "passed";
    record.scope = "bootstrap/preflight only; no application job started";
    log("PASS · fresh loopback stack bootstrap; no application job started.");
  }
} catch (error) {
  record.result = "failed";
  record.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  log(`FAIL · ${record.error}`);
} finally {
  const cleanupErrors: string[] = [];
  for (const proc of [...owned].reverse()) {
    if (proc === stackProcess && ownedStackDir) writeFileSync(join(ownedStackDir, "stop"), "");
    try { await stopOwned(proc, proc === stackProcess && ownedStackDir ? 8000 : 1000); }
    catch (error) { cleanupErrors.push(String(error)); }
  }
  if (cleanupErrors.length) { record.result = "failed"; record.cleanup_errors = cleanupErrors; process.exitCode = 1; }
  record.completed_at = new Date().toISOString();
  record.owned_processes = owned.map((proc) => ({ label: proc.label, pid: proc.child.pid, termination: proc.done }));
  record.child_receipts = readdirSync(jobArtifacts).flatMap((name) => existsSync(join(jobArtifacts, name, "receipt.json")) ? [join(jobArtifacts, name, "receipt.json")] : []);
  writeFileSync(join(artifactDir, "launcher-receipt.json"), JSON.stringify(record, null, 2));
  log(`Launcher receipt: ${join(artifactDir, "launcher-receipt.json")}`);
}
