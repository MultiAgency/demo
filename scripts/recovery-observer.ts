/** Synthetic recovery child: one bound SDK agent, read procedures only, no polling timers. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, writeSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { startServer } from "../src/server/index";
import { MultiAgencyOpenings } from "../src/server/jobs/openings";
import { SdkPlatform, caFetch } from "../src/server/platform/client";
import { makePlatform } from "../src/server/platform/index";
import type { PayoutAnswer } from "../src/server/platform/port";
import { readStack } from "../src/server/platform/stack";
import { recoveryIdSchema } from "../src/server/recovery/evidence";

let traceFd: number | undefined;
let stopServer: (() => void) | undefined;
const procedures = new Set(["overview", "deposit", "payouts/status", "paymentStatus", "held", "owner/status"]);
const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const statuses = ["PENDING", "PENDING_APPROVAL", "PROCESSING", "SUCCESS", "FAILED", "REFUNDED", "UNKNOWN"] as const;
const payoutStates = new Set(["succeeded", "failed", "held", "processing", "refused", "unknown", "not_found"]);
type SafeStatus = typeof statuses[number];
type TraceEvent =
  | { event: "attempt"; procedure: string; method: string; violation: boolean }
  | { event: "observation"; procedure: "payouts/status"; ok: boolean; request_id: string; state?: PayoutAnswer["state"]; status?: SafeStatus | null }
  | { event: "observation"; procedure: "paymentStatus"; ok: boolean; correlation_id: string; status?: SafeStatus | null };
const safeStatus = (value: unknown): value is SafeStatus | null => value === null || statuses.includes(value as SafeStatus);
function requireThat(value: unknown): asserts value { if (!value) throw new Error("Recovery observer refused its fixture configuration."); }
function loopback(value: string): URL {
  const url = new URL(value);
  requireThat(["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    !url.username && !url.password && !url.search && !url.hash);
  return url;
}
function closeTrace() {
  if (traceFd === undefined) return;
  const fd = traceFd; traceFd = undefined;
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function record(event: TraceEvent) {
  requireThat(traceFd !== undefined);
  const bytes = Buffer.from(`${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`);
  for (let offset = 0; offset < bytes.length;) {
    const count = writeSync(traceFd, bytes, offset, bytes.length - offset, null);
    requireThat(count > 0); offset += count;
  }
  fsyncSync(traceFd);
}

try {
  const env = process.env;
  requireThat(Bun.argv.length === 2 && env.NODE_ENV !== "production" && env.PLATFORM === "remote" && env.PORT === "0");
  const stackDir = env.PLATFORM_STACK_DIR, databasePath = env.DB_PATH, tracePath = env.PAPERWORK_RECOVERY_TRACE;
  const organization = env.PAPERWORK_RECOVERY_ORGANIZATION, agent = env.PAPERWORK_RECOVERY_AGENT;
  const requestId = env.PAPERWORK_RECOVERY_REQUEST_ID, correlationId = env.PAPERWORK_RECOVERY_CORRELATION_ID;
  requireThat(stackDir && isAbsolute(stackDir) && databasePath && isAbsolute(databasePath) && tracePath && isAbsolute(tracePath) &&
    recoveryIdSchema.safeParse(organization).success && recoveryIdSchema.safeParse(agent).success &&
    recoveryIdSchema.safeParse(requestId).success && recoveryIdSchema.safeParse(correlationId).success);
  const database = lstatSync(databasePath);
  requireThat(database.isFile() && !database.isSymbolicLink());
  const traceParent = lstatSync(dirname(tracePath));
  requireThat(traceParent.isDirectory() && !traceParent.isSymbolicLink() && process.getuid !== undefined &&
    traceParent.uid === process.getuid() && (traceParent.mode & 0o7777) === 0o700);
  traceFd = openSync(tracePath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const trace = fstatSync(traceFd);
  requireThat(trace.isFile() && trace.uid === process.getuid() && (trace.mode & 0o7777) === 0o600 && trace.nlink === 1);
  fsyncSync(traceFd);

  const stack = readStack(stackDir), platformUrl = loopback(stack.url);
  requireThat(platformUrl.pathname === "/");
  loopback(stack.rpcUrl);
  if (stack.marketUrl) loopback(stack.marketUrl);
  requireThat(env.PLATFORM_DEPLOYMENT === stack.deployment);
  const prefix = `/apps/v1/o/${encodeURIComponent(organization!)}/a/${encodeURIComponent(agent!)}/rpc/`;
  const send = caFetch(stack.caPem);
  const observedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let procedure = "blocked", method = "invalid", allowed = false;
    try {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const requestedMethod = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      method = methods.has(requestedMethod) ? requestedMethod : "invalid";
      const candidate = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
      procedure = procedures.has(candidate) ? candidate : "blocked";
      allowed = url.origin === platformUrl.origin && !url.username && !url.password && !url.search && !url.hash &&
        method === "POST" && procedures.has(candidate);
    } catch { /* Malformed or foreign requests are recorded without their private URL or input. */ }
    record({ event: "attempt", procedure, method, violation: !allowed });
    if (!allowed) throw new Error("Recovery observer blocked a non-read SDK request.");
    return send(input, { ...init, redirect: "error" });
  }) as unknown as typeof fetch;

  // Read only explicit fixture settings; inherited credentials, model keys and discovery services are unused.
  const config = loadConfig({
    PLATFORM: "remote", PLATFORM_STACK_DIR: stackDir, PLATFORM_DEPLOYMENT: stack.deployment, DB_PATH: databasePath,
    PORT: "0", GITHUB: "fake", JUDGE: "rules", AGENT_POLL_MS: "0", STATUS_POLL_MS: "3600000",
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
  });
  process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
  const kit = makePlatform({ mode: "remote", deployment: stack.deployment, stackDir, now: () => new Date() });
  const platform = new SdkPlatform({ url: stack.url, credential: stack.credential, deployment: stack.deployment, fetch: observedFetch, grantLabel: "invoices" });
  const agentFor = platform.agent.bind(platform);
  platform.agent = (requestedOrganization, requestedAgent) => {
    const handle = agentFor(requestedOrganization, requestedAgent);
    const readPayout = handle.payoutStatus.bind(handle), readPayment = handle.paymentStatus.bind(handle);
    handle.payoutStatus = async originalRequest => {
      if (requestedOrganization !== organization || requestedAgent !== agent || originalRequest !== requestId) {
        record({ event: "attempt", procedure: "payouts/status", method: "POST", violation: true });
        throw new Error("Recovery observer blocked an unbound payout read.");
      }
      try {
        const result = await readPayout(originalRequest);
        const bound = result.ok && result.value.requestId === requestId && result.value.correlationId === correlationId && payoutStates.has(result.value.state);
        record({ event: "observation", procedure: "payouts/status", ok: bound, request_id: requestId!,
          ...(bound && { state: result.value.state, ...(safeStatus(result.value.status) && { status: result.value.status }) }) });
        return result;
      } catch {
        record({ event: "observation", procedure: "payouts/status", ok: false, request_id: requestId! });
        throw new Error("Recovery observer payout read failed.");
      }
    };
    handle.paymentStatus = async originalCorrelation => {
      if (requestedOrganization !== organization || requestedAgent !== agent || originalCorrelation !== correlationId) {
        record({ event: "attempt", procedure: "paymentStatus", method: "POST", violation: true });
        throw new Error("Recovery observer blocked an unbound payment read.");
      }
      try {
        const result = await readPayment(originalCorrelation);
        record({ event: "observation", procedure: "paymentStatus", ok: result.ok, correlation_id: correlationId!,
          ...(result.ok && safeStatus(result.value.status) && { status: result.value.status }) });
        return result;
      } catch {
        record({ event: "observation", procedure: "paymentStatus", ok: false, correlation_id: correlationId! });
        throw new Error("Recovery observer payment read failed.");
      }
    };
    return handle;
  };
  kit.platform = platform;
  // Market and discovery are outside this bound-job rehearsal and must not provide untraced network paths.
  kit.market = null;
  const noDiscovery = (async () => { throw new Error("Discovery is unavailable in the recovery observer."); }) as unknown as typeof fetch;
  const runtime = await createRuntime(config, { kit, boardApi: null, openings: new MultiAgencyOpenings(noDiscovery) });
  const server = await startServer(runtime, 0, "127.0.0.1");
  stopServer = () => { server.stop(true); };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    stopServer?.(); closeTrace(); process.exit(0);
  });
  console.log(`\nPaperwork recovery observer · ISOLATED SDK FIXTURE · timers disabled\n→ http://localhost:${server.port}/\n`);
} catch (error) {
  stopServer?.();
  try { closeTrace(); } catch { /* The child still refuses startup when its private trace cannot be flushed. */ }
  const prefix = "Payout ", suffix = " has a budget-releasing outcome without consistent non-execution proof. Preserve this database and reconcile the original platform identities before continuing; no schema or records were changed.";
  const message = error instanceof Error ? error.message : "";
  const unsafeRelease = message.startsWith(prefix) && message.endsWith(suffix) &&
    recoveryIdSchema.safeParse(message.slice(prefix.length, -suffix.length)).success;
  console.error(`Recovery observer startup refused (${unsafeRelease ? "unsafe_budget_release" : "initialization_failed"}); no listener or resumption clearance was produced.`);
  process.exitCode = 1;
}
