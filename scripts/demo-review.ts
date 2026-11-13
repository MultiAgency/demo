/**
 * Isolated review UI demonstration. The platform, accounts, signatures and Hermes
 * replies are scripted fixtures. No Hermes host, NEAR model or real funds are used.
 * bun run demo:review        — interactive local UI
 * bun run demo:review:check  — bounded browser walkthrough and screenshots
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { startServer } from "../src/server/index";
import type { ReviewFetch } from "../src/server/review/hermes";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { toAtomic } from "../src/shared/money";
import type { ReviewContext, ReviewResult } from "../src/shared/review";
import { parseTerms, scopeTotal } from "../src/shared/terms";

// Disable the package's process-wide telemetry as well as the runtime's injected sink.
process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";

function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const checking = process.argv.includes("--check");
const port = Number(process.env.PAPERWORK_REVIEW_DEMO_PORT ?? 0);
check(Number.isSafeInteger(port) && port >= 0 && port <= 65535, "PAPERWORK_REVIEW_DEMO_PORT must be a port between 0 and 65535.");
const artifactRoot = process.env.PAPERWORK_DEMO_ARTIFACTS ?? tmpdir();
mkdirSync(artifactRoot, { recursive: true });
const artifacts = mkdtempSync(join(artifactRoot, "paperwork-review-"));
const session = `paperwork-review-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const calls: { method: string; path: string }[] = [];
const runs = new Map<string, { context: ReviewContext; delay: number | null; stop: (() => void) | null }>();
let nextDelay: number | null = 300;
const encoder = new TextEncoder();

function scriptedReview(context: ReviewContext): ReviewResult {
  return {
    summary: "The report describes the CSV export. A CSV sample and test output would help the agency check the signed criteria.",
    findings: context.scope.map((deliverable) => ({
      deliverable_id: deliverable.id,
      status: "needs_clarification",
      comment: "The builder reports a completed export and supplies an implementation reference. The CSV sample and test output are not described in the submission.",
      report_quotes: ["CSV export is complete."],
      evidence_indices: context.evidence.flatMap((evidence, index) => evidence.deliverable_id === deliverable.id ? [index] : []),
    })),
    feedback: "Please attach a sample CSV and the acceptance test output so we can check the monthly report export against the signed criteria.",
  };
}

/** Every review request is handled here; an unexpected path fails without network fallback. */
const reviewFetch: ReviewFetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  check(url.origin === "http://127.0.0.1:8642", "The scripted Hermes transport must not contact another host.");
  const method = init.method ?? "GET";
  calls.push({ method, path: url.pathname });
  if (url.pathname === "/v1/capabilities") return Response.json({
    auth: { required: true }, features: { run_submission: true, run_events_sse: true, run_stop: true },
  });
  if (url.pathname === "/v1/toolsets") return Response.json({ object: "list", platform: "api_server", data: [] });
  if (url.pathname === "/v1/runs" && method === "POST") {
    const body = JSON.parse(String(init.body)) as { input: string; provider: string };
    check(body.provider === "custom:near", "The fixture expects the explicit NEAR custom-provider selection.");
    const context = JSON.parse(body.input) as ReviewContext;
    const runId = `run_demo_${crypto.randomUUID()}`;
    runs.set(runId, { context, delay: nextDelay, stop: null });
    nextDelay = 300;
    return Response.json({ run_id: runId, status: "started" });
  }
  const match = /^\/v1\/runs\/([^/]+)\/(events|stop)$/.exec(url.pathname);
  const runId = match?.[1];
  const run = runId ? runs.get(runId) : null;
  if (!match || !run || !runId) throw new Error("Unexpected scripted Hermes request.");
  if (match[2] === "stop" && method === "POST") {
    run.stop?.();
    return Response.json({ status: "stopping" });
  }
  check(match[2] === "events" && method === "GET", "Unsupported scripted Hermes operation.");
  let stop: () => void = () => {};
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const close = () => {
        if (closed) return;
        closed = true;
        if (timer !== null) clearTimeout(timer);
        init.signal?.removeEventListener("abort", close);
        controller.close();
      };
      const complete = () => {
        if (closed) return;
        const event = { event: "run.completed", run_id: runId, completed: true, partial: false, interrupted: false, output: JSON.stringify(scriptedReview(run.context)) };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        close();
      };
      // null deliberately holds the cancellation fixture until abort/stop.
      // Browser command overhead must never decide whether cancellation is testable.
      if (run.delay !== null) timer = setTimeout(complete, run.delay);
      stop = close;
      run.stop = close;
      init.signal?.addEventListener("abort", close, { once: true });
      if (init.signal?.aborted) close();
    },
    cancel() { stop(); },
  }), { headers: { "content-type": "text/event-stream" } });
};

const rt = await createRuntime(loadConfig({
  PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules", PORT: String(port), DB_PATH: ":memory:",
  PAPERWORK_HERMES_URL: "http://127.0.0.1:8642", PAPERWORK_HERMES_API_KEY: "scripted-review-fixture-key",
  PAPERWORK_HERMES_PROVIDER: "custom:near", PAPERWORK_HERMES_MODEL: "scripted-model-no-inference",
}), { clockStart: Date.parse("2026-11-20T12:00:00Z"), manualFakeSettlement: true, reviewFetch });
const terms = parseTerms(JOB_DEMO_TERMS);
const { id, contractorToken } = rt.engine.createContract(terms);
const sign = rt.kit.devSigner!.sign413.bind(rt.kit.devSigner!);
for (const role of ["representative", "contractor"] as const) {
  const request = rt.engine.signingRequest(id, role);
  const signed = await sign(request);
  await rt.engine.addSignature(id, role, {
    account_id: request.account_id, public_key: signed.publicKey, signature: signed.signature, nonce: request.nonce,
  }, contractorToken);
}
let next = await rt.engine.next(id);
for (let turn = 0; turn < 30 && next.kind !== "done"; turn++) {
  if (next.kind === "sign") next = await rt.engine.signed(id, { step: next.step, nonce: next.sign.nonce, ...await sign(next.sign) });
  else if (next.kind === "owner_step") {
    check(next.sign, "The stand-in owner step must provide its simulated signing request.");
    await rt.engine.submitOwnerStep(next.correlation_id, await sign(next.sign));
    next = await rt.engine.next(id);
  } else next = await rt.engine.next(id);
}
check(next.kind === "done", "The isolated fixture's signed job did not finish setup.");
await rt.kit.controls!.fund(rt.engine.onboarding.agentRow(id)!.agent_id!, toAtomic(scopeTotal(terms), 6).toString());
const submitted = await rt.engine.submitJob(id, {
  client_request_id: `scripted-review-${crypto.randomUUID()}`,
  report: "CSV export is complete. The linked implementation supports monthly report downloads. Please review the implementation against the signed criteria.",
  evidence: [{ deliverable_id: "d1", label: "Submitted CSV export implementation", url: "https://evidence.invalid/csv-export" }],
  invoice: { number: "INV-REVIEW-DEMO-001", amount_usd: "300" },
}, terms.contractor.near_account);
const initial = await rt.engine.viewContract(id);
const server = await startServer(rt, port, "127.0.0.1");
const base = server.url.origin;
// The operating-system-assigned loopback port is known only after listen.
rt.config.auth.publicUrl = base;
rt.config.auth.enforcePublicHost = true;
const url = `${base}/#/c/${id}`;

console.log("Paperwork review assistant · SCRIPTED OFFLINE DEMO");
console.log("Simulated accounts, signatures and funds. Scripted Hermes/model replies; no hosted services or NEAR inference.");
console.log(`Review URL: ${url}`);
console.log(`Artifacts: ${artifacts}`);

if (!checking) {
  console.log("Open the URL, choose Prepare review, edit Draft feedback and explicitly add it to Changes needed. Ctrl-C stops this isolated demo.");
  process.once("SIGINT", () => { server.stop(true); process.exit(0); });
  process.once("SIGTERM", () => { server.stop(true); process.exit(0); });
} else {
  const captures: string[] = [];
  const steps: string[] = [];
  const pause = () => Bun.sleep(120);
  function step(message: string) { steps.push(message); console.log(`✓ ${message}`); }
  async function command(...args: string[]) {
    const child = Bun.spawn(["agent-browser", "--session", session, "--json", ...args], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: "5000" },
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      check(exit === 0, `Browser ${args[0]} failed (${exit}): ${stderr || stdout}`);
      const result = JSON.parse(stdout) as { success: boolean; error?: string; data: any };
      check(result.success, `Browser ${args[0]} failed: ${result.error}`);
      return result.data;
    } finally { clearTimeout(timer); }
  }
  async function evaluate<T>(expression: string): Promise<T> { return (await command("eval", expression)).result as T; }
  async function waitFor(expression: string, label: string) {
    for (const end = Date.now() + 15_000; Date.now() < end; await pause()) if (await evaluate<boolean>(expression)) return;
    throw new Error(`Timed out waiting for ${label}`);
  }
  async function ref(role: string, name: string) {
    const snapshot = await command("snapshot", "-i");
    const entry = Object.entries(snapshot.refs as Record<string, { role: string; name: string }>).find(([, value]) => value.role === role && value.name === name);
    check(entry, `No ${role} named ${name}`);
    return `@${entry[0]}`;
  }
  async function button(name: string) {
    await waitFor(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(name)}&&!b.disabled)`, name);
    await command("scrollintoview", await ref("button", name));
    await command("click", await ref("button", name));
  }
  async function fill(name: string, value: string) {
    await command("scrollintoview", await ref("textbox", name));
    await command("fill", await ref("textbox", name), value);
  }
  async function capture(name: string) {
    const path = join(artifacts, `${name}.png`);
    await evaluate("window.scrollTo({top:0,left:0,behavior:'instant'})");
    await command("screenshot", path, "--full");
    captures.push(path);
  }
  async function unchanged() {
    const view = await rt.engine.viewContract(id);
    check(view.hash === initial.hash && JSON.stringify(view.signatures) === JSON.stringify(initial.signatures), "Review must preserve the accepted terms and signatures.");
    check(JSON.stringify(view.submissions) === JSON.stringify(initial.submissions), "Drafting and applying feedback must not change the immutable submission or its workflow state.");
    check(view.payouts.length === 0 && view.open_judgment === null && view.paid_usd === "0" && view.committed_usd === "0", "Review must not create compensation proposals, payments or commitments.");
    check((await rt.kit.controls!.transfers()).length === 0, "Review must not transfer simulated funds.");
    check(await evaluate<boolean>("window.__reviewMutations.length===0"), "Drafting and applying feedback must not call another mutation endpoint.");
  }
  try {
    await command("open", url);
    await command("set", "viewport", "1440", "1000");
    await waitFor("document.title.endsWith('Paperwork')&&!!document.querySelector('.review-assistant')", "report review UI");
    await evaluate(`(() => {
      const original = window.fetch.bind(window);
      window.__reviewMutations = [];
      window.fetch = (...args) => {
        const request = args[0];
        const path = new URL(request instanceof Request ? request.url : request, location.href).pathname;
        const method = args[1]?.method ?? (request instanceof Request ? request.method : 'GET');
        if (method !== 'GET' && method !== 'HEAD' && path.startsWith('/api/') && !path.includes('/review/copilotkit/')) window.__reviewMutations.push({method,path});
        return original(...args);
      };
    })()`);
    const originalFeedback = "Reviewer note already in progress: check the monthly CSV sample.";
    await fill("Changes needed", originalFeedback);
    check(calls.length === 0, "Opening the review UI must not run the assistant automatically.");
    await button("Prepare review");
    await waitFor("!!document.querySelector('.review-assistant-draft textarea')", "validated feedback draft");
    check(await evaluate<string>("document.querySelector('.job-change-form textarea').value") === originalFeedback, "Generating a review must preserve existing typed feedback.");
    check(await evaluate<boolean>("document.querySelector('.review-assistant-finding').textContent.includes('CSV export is complete.')&&document.querySelector('.review-assistant-sources a').href==='https://evidence.invalid/csv-export'"), "The review must cite the exact report and supplied evidence reference.");
    await unchanged();
    step("Explicit review generates source-backed findings while preserving existing feedback and all job/payment records");
    const edited = "Please attach the monthly CSV sample and the acceptance test output for agency review.";
    await fill("Draft feedback", edited);
    await button("Replace feedback with draft");
    check(await evaluate<string>("document.querySelector('.job-change-form textarea').value") === edited, "Explicit apply must use the reviewer's edited draft.");
    await unchanged();
    step("Editing and explicitly applying the draft changes only the existing Changes needed field");
    await capture("01-review-desktop");

    nextDelay = null;
    await button("Prepare another review");
    await waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Cancel review')", "cancellable review");
    for (const end = Date.now() + 5000; Date.now() < end && runs.size < 2; await pause()) {}
    check(runs.size >= 2, "The cancellable review must retain its original scripted Hermes admission.");
    // Exercise the actual Bun server beyond its default 10s idle limit.
    await Bun.sleep(11_000);
    check(await evaluate<boolean>("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Cancel review')"), "A quiet review must stay connected beyond Bun's default idle timeout.");
    await button("Cancel review");
    await waitFor("document.querySelector('.review-assistant').textContent.includes('Review cancelled')&&!document.querySelector('.review-assistant-draft')", "cancelled draft discarded");
    for (const end = Date.now() + 8000; Date.now() < end && !calls.some((call) => call.path.endsWith("/stop")); await pause()) {}
    check(calls.some((call) => call.path.endsWith("/stop")), "Cancellation must ask Hermes to stop the original admitted run.");
    check(await evaluate<string>("document.querySelector('.job-change-form textarea').value") === edited, "Cancelling a review must preserve the already applied feedback.");
    await unchanged();
    await button("Prepare another review");
    await waitFor("!!document.querySelector('.review-assistant-draft textarea')", "fresh review after cancellation");
    await unchanged();
    step("Cancellation discards its draft, stops the original scripted Hermes run and permits a fresh review");

    await command("set", "viewport", "390", "844");
    check(await evaluate<boolean>("document.documentElement.scrollWidth<=innerWidth"), "Review UI must not overflow the mobile viewport.");
    await capture("02-review-mobile");
    await command("set", "viewport", "1440", "1000");
    check(await evaluate<boolean>("document.documentElement.scrollWidth<=innerWidth"), "Review UI must not overflow the desktop viewport.");
    step("Desktop and mobile review surfaces fit their viewports");
    writeFileSync(join(artifacts, "result.json"), JSON.stringify({
      outcome: "pass", source: "Actual Paperwork UI and backend; scripted Hermes/model replies and platform/signature/fund fixtures",
      no_hosted_services: true, no_near_inference: true, url, job: id, submission: submitted.id,
      hermes_runs: runs.size, hermes_stops: calls.filter((call) => call.path.endsWith("/stop")).length,
      steps, captures,
    }, null, 2));
    console.log(`PASS · isolated offline review UI. Receipt: ${join(artifacts, "result.json")}`);
  } catch (error) {
    await capture("failure").catch(() => {});
    writeFileSync(join(artifacts, "failure.txt"), String(error));
    throw error;
  } finally {
    await command("close").catch(() => {});
    server.stop(true);
  }
}
