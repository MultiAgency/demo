/** Actual browser UI walkthrough; all accounts, signatures and payments are fixtures. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { startServer } from "../src/server/index";
import type { ContractView } from "../src/shared/views";
import { toAtomic } from "../src/shared/money";
import { readStack } from "../src/server/platform/stack";
import type { HireView } from "../src/shared/market";

type Actor = "agency" | "builder";
const full = process.env.PAPERWORK_BROWSER_FULL === "1";
const stack = full && process.env.PLATFORM_STACK_DIR ? readStack(process.env.PLATFORM_STACK_DIR) : null;
if (full && (!stack?.marketUrl || ![stack.url, stack.rpcUrl, stack.marketUrl].every(url => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname))))
  throw new Error("The combined browser check requires the isolated loopback stack and --market simulator.");
const dir = mkdtempSync(join(process.env.PAPERWORK_DEMO_ARTIFACTS ?? tmpdir(), "paperwork-browser-"));
const sessions: Record<Actor, string> = { agency: `paperwork-agency-${process.pid}`, builder: `paperwork-builder-${process.pid}` };
const opened = new Set<Actor>();
const steps: string[] = [];
const captures: string[] = [];
const rt = await createRuntime(loadConfig({ PLATFORM: stack ? "remote" : "fake", GITHUB: "fake", JUDGE: "rules", PORT: "0",
  ...(stack && { PLATFORM_STACK_DIR: process.env.PLATFORM_STACK_DIR, PLATFORM_DEPLOYMENT: stack.deployment }),
}), { manualFakeSettlement: !stack });
const server = await startServer(rt, 0, "127.0.0.1");
const base = server.url.origin;
let contractId = "";

function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const pause = () => Bun.sleep(150);
async function command(actor: Actor, ...args: string[]) {
  const child = Bun.spawn(["agent-browser", "--session", sessions[actor], "--json", ...args], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: "5000" },
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 15_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    check(exit === 0, `Browser ${args[0]} failed (${exit}): ${stderr || stdout}`);
    const result = JSON.parse(stdout);
    check(result.success, `Browser ${args[0]} failed: ${result.error}`);
    return result.data;
  } finally { clearTimeout(timeout); }
}
async function evaluate<T>(actor: Actor, expression: string): Promise<T> {
  return (await command(actor, "eval", expression)).result as T;
}
async function pageWait(actor: Actor, expression: string, label: string) {
  for (const end = Date.now() + 12_000; Date.now() < end; await pause()) {
    if (await evaluate<boolean>(actor, expression)) return;
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function reference(actor: Actor, role: string, name: string, prefix = false) {
  const snapshot = await command(actor, "snapshot", "-i");
  const entry = Object.entries(snapshot.refs as Record<string, { role: string; name: string }>).find(([, value]) =>
    value.role === role && (prefix ? value.name.startsWith(name) : value.name === name));
  check(entry, `No ${role} named ${name}`);
  return `@${entry[0]}`;
}
async function click(actor: Actor, selector: string) {
  // agent-browser 0.26 clicks offscreen coordinates without scrolling. Explicitly reveal every target.
  await command(actor, "scrollintoview", selector);
  await command(actor, "click", selector);
  await pause();
}
async function button(actor: Actor, text: string) {
  await pageWait(actor, `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`, text);
  await command(actor, "scrollintoview", await reference(actor, "button", text));
  await command(actor, "click", await reference(actor, "button", text));
  await pause();
}
async function actionOrDone(actor: Actor, pattern: string, done: () => boolean | Promise<boolean>, label: string) {
  for (const until = Date.now() + 12_000; Date.now() < until; await pause()) {
    if (await done()) return;
    const action = await evaluate<string | null>(actor, `[...document.querySelectorAll('button')].find(b=>!b.disabled&&new RegExp(${JSON.stringify(pattern)}).test(b.textContent.trim()))?.textContent.trim()??null`);
    if (await done()) return;
    if (!action) continue;
    try {
      await command(actor, "scrollintoview", await reference(actor, "button", action));
      if (await done()) return;
      await command(actor, "click", await reference(actor, "button", action));
      await pause();
      return;
    } catch (error) { if (await done()) return; throw error; }
  }
  throw new Error(`Timed out waiting for ${label} or its completed state`);
}
async function fill(actor: Actor, label: string, value: string) {
  await command(actor, "scrollintoview", await reference(actor, "textbox", label, true));
  await command(actor, "fill", await reference(actor, "textbox", label, true), value);
}
async function capture(actor: Actor, name: string) {
  const path = join(dir, `${name}.png`);
  await command(actor, "screenshot", path, "--full");
  captures.push(path);
}
async function view() { return rt.engine.viewContract(contractId); }
async function state(predicate: (v: ContractView) => boolean, label: string) {
  for (const end = Date.now() + 12_000; Date.now() < end; await pause()) {
    const v = await view();
    if (predicate(v)) return v;
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function step(text: string) { steps.push(text); console.log(`✓ ${text}`); }
async function open(actor: Actor, url: string) {
  opened.add(actor);
  await command(actor, "open", url);
  await command(actor, "set", "viewport", "1440", "1000");
}
async function submitRevision(revision: number) {
  await pageWait("builder", "!!document.querySelector('.job-builder textarea')", "builder report form");
  await fill("builder", "Work report", revision === 1
    ? "CSV export is complete. Please review the linked implementation and acceptance tests."
    : "CSV export and the requested test report are complete. The revision includes the CSV sample and test output.");
  await fill("builder", "Invoice number", `INV-00${revision}`);
  await fill("builder", "Invoice amount · USDC", "300");
  await fill("builder", "d1 evidence URL", "https://github.com/acme/app/pull/101");
  await fill("builder", "d1 evidence description", revision === 1 ? "CSV export implementation" : "CSV export, sample and acceptance test output");
  if (revision === 1) {
    // Fail one automatic GET while the builder is editing. The form must stay mounted, then recover.
    await evaluate("builder", `(() => {
      const original = window.fetch.bind(window);
      const statusPath = ${JSON.stringify(`/api/contracts/${contractId}`)};
      window.__jobStatusProbe = { failed: false, recovered: false,
        draft: [...document.querySelectorAll('.job-builder input,.job-builder textarea')].map(e => e.value) };
      window.fetch = async (...args) => {
        const url = new URL(args[0] instanceof Request ? args[0].url : args[0], location.href);
        const method = args[1]?.method ?? (args[0] instanceof Request ? args[0].method : 'GET');
        if (method === 'GET' && url.pathname === statusPath) {
          if (!window.__jobStatusProbe.failed) {
            window.__jobStatusProbe.failed = true;
            return new Response(JSON.stringify({ error: 'Simulated status read outage' }), { status: 503, headers: { 'content-type': 'application/json' } });
          }
          const response = await original(...args);
          if (response.ok) window.__jobStatusProbe.recovered = true;
          return response;
        }
        return original(...args);
      };
    })()`);
    await pageWait("builder", "document.body.innerText.includes('Status could not refresh')", "visible temporary status failure");
    check(await evaluate<boolean>("builder", "JSON.stringify([...document.querySelectorAll('.job-builder input,.job-builder textarea')].map(e=>e.value))===JSON.stringify(window.__jobStatusProbe.draft)"), "A failed background read must preserve the builder's unfinished report, invoice and evidence");
    await pageWait("builder", "window.__jobStatusProbe.recovered&&!document.body.innerText.includes('Status could not refresh')", "automatic recovery after temporary status failure");
    check(await evaluate<boolean>("builder", "JSON.stringify([...document.querySelectorAll('.job-builder input,.job-builder textarea')].map(e=>e.value))===JSON.stringify(window.__jobStatusProbe.draft)"), "A successful background read must preserve the same unfinished draft");
    step("Automatic status reads recover from a simulated 503 without losing the builder's report, invoice or evidence");
  }
  await button("builder", revision === 1 ? "Submit report and invoice" : "Submit revised report and invoice");
  const submitted = await state(v => v.submissions[0]?.revision === revision && v.submissions[0]?.state === "submitted", "submitted revision");
  await pageWait("builder", "document.body.innerText.includes('Submitted · awaiting proposal')", "visible submission outcome");
  check(submitted.paid_usd === "0", "Submission must not count as payment");
  return submitted.submissions[0]!;
}

/** A separate instant service hire in the same app; never a second payment path for the builder job. */
async function marketJourney(builderRequest: string) {
  check(rt.market, "The combined app must expose its isolated market integration");
  await command("agency", "set", "viewport", "1440", "1000");
  await click("agency", 'a[href="#/market"]');
  await pageWait("agency", "document.body.innerText.includes('New agency')", "market navigation in the same app");
  await fill("agency", "Name", "Combined demo agency");
  await button("agency", "Create agency");
  await pageWait("agency", "location.hash.startsWith('#/market/')", "market agency");
  const agencyId = (await evaluate<string>("agency", "location.hash")).split("/")[2]!;
  const agencyRow = () => rt.market!.agencies.row(agencyId);
  for (let i = 0; i < 30 && agencyRow().stage !== "ready"; i++) {
    await actionOrDone("agency", "^(Sign \\(|Confirm \\(demo\\)|Register \\(demo\\))", () => agencyRow().stage === "ready", "market setup action");
  }
  check(agencyRow().stage === "ready", "The agency's separate market agent must finish setup");
  await pageWait("agency", "document.body.innerText.includes('Hire a listed agent')", "ready market account");
  await button("agency", "Fund $10 (demo)");
  await fill("agency", "Agent handle", "writer");
  await fill("agency", "Brief", "A separate service job: write a short article about agency coordination. This is not the builder's job.");
  await button("agency", "Ask for a quote");
  const hires = () => rt.market!.hires.forAgency(agencyId).map(h => rt.market!.hires.view(h));
  await pageWait("agency", "document.body.innerText.includes('Approve and hire for 0.5 USDC')", "market quote and explicit pre-delivery approval");
  check(hires().length === 1 && hires()[0]?.state === "quoted", "A quote must be retained without payment");
  const quote = hires()[0]!;
  check(quote.request_id !== builderRequest && quote.amount_usd === "0.5", "Market service and builder payment identities must be distinct");
  check(await evaluate<boolean>("agency", "document.body.innerText.includes('accepted the moment the agent delivers')"), "The instant hire lifecycle must be visible before approval");
  await capture("agency", "07-market-quote");
  await button("agency", "Approve and hire for 0.5 USDC");
  for (let i = 0; i < 30 && hires()[0]?.state !== "paid"; i++) {
    const available = await evaluate<boolean>("agency", "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Check the outcome'&&!b.disabled)");
    if (hires()[0]?.state === "paid") break;
    if (available) try {
      await command("agency", "scrollintoview", await reference("agency", "button", "Check the outcome"));
      if (hires()[0]?.state === "paid") break;
      await command("agency", "click", await reference("agency", "button", "Check the outcome"));
    } catch (error) { if (hires()[0]?.state !== "paid") throw error; }
    await pause();
  }
  const paid: HireView = hires()[0]!;
  check(paid.state === "paid" && paid.deliverable === "the article", "The SDK must confirm the separate service hire's payment and deliverable");
  check(hires().length === 1 && paid.request_id === quote.request_id, "Observation must preserve one original market hire");
  await pageWait("agency", "document.body.innerText.includes('the article')", "market delivery outcome");
  await capture("agency", "08-market-paid-desktop");
  await command("agency", "set", "viewport", "390", "844");
  check(await evaluate<boolean>("agency", "document.documentElement.scrollWidth<=innerWidth"), "market mobile view overflows horizontally");
  await capture("agency", "09-market-paid-mobile");
  const builderPayments = (await rt.kit.controls!.transfers()).filter(p => p.recipient === "maria.demo" && p.status === "SUCCESS");
  check(builderPayments.length === 1, "The separate market hire must not pay the builder job again");
  step("The same browser app quotes, explicitly hires and receives a separate listed-agent service; builder and market identities remain distinct");
  return { agency: agencyId, agent: agencyRow().agent, request_id: paid.request_id, state: paid.state, amount_usd: paid.amount_usd,
    deliverable: paid.deliverable, confirmation_source: "SDK market status; provider/chain/market simulated", limitations: ["Directory and worker loop unavailable on pinned simulator", "No hosted or real payment evidence"] };
}

console.log("Paperwork browser walkthrough · SIMULATED accounts, signatures, provider and settlement");
console.log(`Artifacts: ${dir}`);
try {
  await open("agency", `${base}/#/new`);
  check(await evaluate<boolean>("agency", "document.title==='Paperwork'&&document.querySelector('h1')?.textContent==='New job'&&[...document.querySelectorAll('a')].some(a=>a.textContent.trim()==='Jobs')"), "Expected Paperwork branding and job navigation");
  await pageWait("agency", "!!document.querySelector('button[aria-label=\"Remove d3\"]')", "offer form");
  await click("agency", 'button[aria-label="Remove d3"]');
  await click("agency", 'button[aria-label="Remove d2"]');
  await pageWait("agency", "document.querySelectorAll('.scope-edit>li').length===1", "single deliverable");
  await button("agency", "Create draft");
  await pageWait("agency", "location.hash.startsWith('#/c/')", "draft navigation");
  contractId = (await evaluate<string>("agency", "location.hash")).split("/")[2]!;
  check(contractId.startsWith("c_"), "Expected a job identity");
  const offered = await view();
  check(offered.terms.v === 3 && offered.total_usd === "300", "Expected the signed report/invoice workflow");
  step("Agency creates the $300 report/invoice job using the visible form");

  await button("agency", "Sign as acme.demo");
  await state(v => !!v.signatures.representative, "agency signature");
  const builderUrl = await evaluate<string>("agency", "[...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='Builder submission').href");
  await open("builder", builderUrl);
  await button("builder", "Sign as maria.demo (demo wallet)");
  await state(v => !!v.signatures.contractor, "builder acceptance");
  step("Agency and builder sign the same immutable terms through separate browser sessions");

  for (let i = 0; i < 30 && (await view()).stage !== "active"; i++) {
    await actionOrDone("agency", "^(Continue|Sign \\(|Confirm \\(demo\\)|Fund \\$)", async () => (await view()).stage === "active", "builder setup action");
  }
  await state(v => v.stage === "active", "funded platform agent");
  step("Agency completes setup, signed policy and simulated funding using the checklist");
  const first = await submitRevision(1);
  step("Builder submits report, invoice and evidence; no payout is yet requested");
  check((await view()).payouts.length === 0, "Submission must not create a payout");

  await button("agency", "Propose compensation");
  step("Agency discovers the builder submission and can propose compensation without a page reload");
  const held = await state(v => v.payouts[0]?.state === "held", "held proposal");
  check(held.paid_usd === "0", "Held proposal is unpaid");
  await pageWait("agency", "document.body.innerText.includes('Held for your approval')", "visible held proposal");
  await capture("agency", "01-held-proposal");
  let revised = first;
  if (!full) {
  await fill("agency", "Changes needed", "Attach a CSV sample and acceptance test output before payout.");
  await button("agency", "Request changes");
  await state(v => v.submissions[0]?.state === "changes_pending", "cancellation pending");
  await pageWait("builder", "document.body.innerText.includes('Wait for cancellation')", "builder waits for cancellation");
  await capture("builder", "02-changes-pending");
  await button("agency", "Reject held payout for revision");
  await state(v => v.submissions[0]?.state === "changes_requested", "confirmed rejection");
  step("Agency requests changes and signs rejection; builder waits for confirmed cancellation");

  revised = await submitRevision(2);
  check(revised.terms_hash === offered.hash && revised.invoice.id !== first.invoice.id, "Revision must retain terms and a distinct invoice identity");
  await button("agency", "Propose compensation");
  await state(v => v.submissions[0]?.payout_request_ids.some(id => v.payouts.some(p => p.request_id === id && p.state === "held")) ?? false, "revised held proposal");
  } else step("Pinned SDK simulator rework is separately blocked by missing non-execution proof; original submission proceeds to explicit review");
  await button("agency", "Approve $300.00");
  const approved = await state(v => v.payouts[0]?.state === "processing", "approved, unsettled payout");
  check(approved.paid_usd === "0", "Approval must not count as settlement");
  await pageWait("agency", "document.body.innerText.includes('Settlement is still pending')", "visible pending settlement");
  await capture("agency", "03-approved-not-settled");
  step(`Agency approves the ${full ? "submission's" : "revised"} proposal; processing is visible with zero confirmed paid`);

  await button("agency", "Settle approved payouts");
  const paid = await state(v => v.submissions[0]?.state === "settled", "confirmed settlement");
  await pageWait("agency", "document.body.innerText.includes('Confirmed settlement')", "agency settlement evidence");
  await capture("agency", "04-agency-settled-desktop");
  await pageWait("builder", "document.body.innerText.includes('Confirmed settlement')", "builder settlement evidence");
  await capture("builder", "05-builder-settled-desktop");
  for (const actor of ["agency", "builder"] as const) {
    await command(actor, "set", "viewport", "390", "844");
    check(await evaluate<boolean>(actor, "document.documentElement.scrollWidth<=innerWidth"), `${actor} mobile view overflows horizontally`);
    await capture(actor, `06-${actor}-settled-mobile`);
  }
  const transfers = await rt.kit.controls!.transfers();
  const successful = transfers.filter(p => p.status === "SUCCESS");
  check(successful.length === 1, "Expected exactly one successful simulated transfer");
  check(successful[0]!.recipient === paid.terms.payee.address && successful[0]!.amount === toAtomic(paid.total_usd, 6).toString(), "The successful simulated transfer must match the signed payee and gross amount");
  check(paid.paid_usd === paid.total_usd, "Expected the agreed gross scope amount to be settled");
  if (!full) check(paid.submissions.length === 2 && paid.submissions[1]?.state === "changes_requested", "Original revision and feedback must remain visible");
  const payment = paid.payouts.find(p => p.state === "paid")!;
  const finalSubmission = paid.submissions.find(s => s.id === revised.id)!;
  check(finalSubmission.judgment_id, "The final receipt must link the recorded compensation proposal");
  check(payment.approval_vote_id && payment.payment_correlation_id && (full || payment.tx_hash), "Settlement must retain approval and payment evidence");
  for (const actor of ["agency", "builder"] as const) {
    check(await evaluate<boolean>(actor, `document.body.innerText.includes(${JSON.stringify(payment.request_id)})`), `${actor} must display the same payment identity`);
  }
  step("Both parties see the same confirmed settlement at desktop and mobile sizes; one successful payment");
  const market = full ? await marketJourney(payment.request_id) : null;
  writeFileSync(join(dir, "receipt.json"), JSON.stringify({ simulated: true, scope: full ? "One browser app with builder payout and a separate marketplace service hire through SDK; no real wallet/payment" : "Builder job with simulated revision", automation: "agent-browser; scrollintoview before trusted clicks", job: contractId, terms_hash: paid.hash, submission: revised.id, invoice: revised.invoice.id, proposal: finalSubmission.judgment_id, request: payment.request_id, approval: payment.approval_vote_id, payment: payment.payment_correlation_id, tx_hash: payment.tx_hash, paid_usd: paid.paid_usd, successful_transfers: 1, market, steps, captures }, null, 2));
  console.log(`PASS · ${full ? "combined builder and market browser experience" : "complete browser job with revision"} · receipt ${join(dir, "receipt.json")}`);
} catch (error) {
  writeFileSync(join(dir, "failure.txt"), String(error));
  for (const actor of opened) {
    try { await capture(actor, `failure-${actor}`); } catch {}
    try { writeFileSync(join(dir, `failure-${actor}.json`), JSON.stringify(await command(actor, "snapshot", "-i"), null, 2)); } catch {}
  }
  throw error;
} finally {
  for (const actor of opened) { try { await command(actor, "close"); } catch {} }
  server.stop(true);
}
