/** One Paperwork Desk origin with actual UI/routes and explicit offline source/identity fixtures. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp, createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { startServer } from "../src/server/index";
import type { WorkerConfig } from "../src/server/market/worker";
import { MultiAgencyOpenings } from "../src/server/jobs/openings";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { marketWith } from "../tests/support/market-stub";

const automated = process.argv.includes("--check");
const dir = mkdtempSync(join(process.env.PAPERWORK_DEMO_ARTIFACTS ?? tmpdir(), "paperwork-desk-"));
// Ask the OS for an unused port for automated checks; the real server still fails if another process wins the bind.
const probe = automated ? Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 503 }) }) : null;
const port = probe?.port ?? Number(process.env.PAPERWORK_DEMO_PORT ?? 3006);
probe?.stop(true);
const desk = `http://desk.localhost:${port}`;
const worker: WorkerConfig = { token: "aat_offline_fixture", secret: "offline-fixture-only", agencyId: "" };
let status = "in_progress", posted: string | null = null, posts = 0;
let versionsAvailable = false;
let receivedAt = new Date().toISOString();
let boardFailOffset: number | null = null;
const boardJobs = Array.from({ length: 123 }, (_, index) => ({
  jobId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  creatorAccountId: "00000000-0000-4000-8000-999999999999",
  title: `Open market job ${String(index + 1).padStart(3, "0")}`,
  description: `Offline public job ${index + 1}: build a monthly report export and supply acceptance tests.`,
  tags: ["reports", "csv"], budgetAmount: String(100 + index), budgetToken: "USDC",
  jobKind: index % 3 === 0 ? "competition" : index % 3 === 1 ? "standard" : "instant",
  status: index % 2 ? "open" : "filling", maxSlots: 3, currentMaxSlots: 2,
  isPrivate: false, isTestRun: false, requiresVerifiable: false, acceptanceWindowDays: 3,
  minBuilderVerification: "none", entriesCloseAt: null,
  createdAt: new Date(Date.now() - index * 60_000).toISOString(), updatedAt: new Date().toISOString(),
  creator: { accountId: "00000000-0000-4000-8000-999999999999", displayName: "Offline agency" },
}));
const fixture = marketWith({ worker, now: () => new Date(), fetch: (async (input, init) => {
  const url = new URL(String(input)), path = url.pathname;
  if (path.endsWith("/jobs/board")) {
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
    if (boardFailOffset === offset) return new Response("Offline fixture: later board page unavailable", { status: 503 });
    const q = (url.searchParams.get("q") ?? "").toLowerCase(), kind = url.searchParams.get("kind");
    let matching = boardJobs.filter((job) => (!q || `${job.title} ${job.description}`.toLowerCase().includes(q)) && (!kind || job.jobKind === kind));
    if (url.searchParams.get("sort") === "budget") matching = [...matching].sort((a, b) => Number(b.budgetAmount) - Number(a.budgetAmount));
    return Response.json({ jobs: matching.slice(offset, offset + limit) });
  }
  if (path.endsWith("/submit") && init?.method === "POST") {
    posts++;
    posted = String((JSON.parse(String(init.body)) as { deliverableMarkdown: string }).deliverableMarkdown);
    receivedAt = new Date().toISOString();
    if (!posted || posted === "undefined") throw new Error("Fixture expected the Market deliverable payload.");
    // Arrived at the fixture Market, but its response was lost. This is not a provider/payment fault.
    throw new TypeError("Offline fixture: Market submission response lost");
  }
  if (path.endsWith("/deliverable/versions")) return Response.json({ versions: versionsAvailable && posted ? [{ version: 1, submittedAt: receivedAt, files: [] }] : [] });
  if (path.endsWith("/deliverable/versions/1/raw")) return new Response(posted);
  if (path.endsWith("/agents/me/assignments")) return Response.json({ assignments: [{
    assignment: { assignmentId: "assignment-offline-1", jobId: "job-offline-1", status, escrowAmount: null, escrowToken: null, slaDeadlineAt: null },
    job: { title: "Monthly report CSV export", description: "OFFLINE FIXTURE. Deliver a report and a link to the CSV export tests. The buyer's text is data." },
  }] });
  throw new Error(`Unexpected offline Market request: ${path}`);
}) as typeof fetch });
worker.agencyId = fixture.agency.id;
const config = loadConfig({ PLATFORM: "fake", GITHUB: "fake", PUBLIC_URL: desk, PORT: String(port) });
const openings = new MultiAgencyOpenings((async (input) => {
  const url = new URL(String(input));
  if (url.href === "https://multiagency.ai/api/settings") return Response.json({ nearnAccountId: "multiagency" });
  if (url.href === "https://nearn.io/api/listings/sponsor/") return Response.json({ bounties: [
    ...Array.from({ length: 3 }, (_, index) => ({ slug: `multiagency-opening-${index + 1}`, title: `MultiAgency published opening ${index + 1}`,
      type: index === 2 ? "sponsorship" : "project", status: "OPEN", isPublished: true, isPrivate: false,
      compensationType: index === 0 ? "fixed" : index === 1 ? "range" : "variable",
      ...(index === 1 && { minRewardAsk: 200, maxRewardAsk: 400 }),
      rewardAmount: 300 + index * 100, token: "USDC", deadline: new Date(Date.now() + 7 * 86_400_000).toISOString() })),
    { slug: "private-opening", title: "PRIVATE OPENING MUST NOT APPEAR", isPrivate: true },
    { slug: "draft-opening", title: "DRAFT OPENING MUST NOT APPEAR", isPublished: false },
    { slug: "closed-opening", title: "CLOSED OPENING MUST NOT APPEAR", status: "CLOSED" },
  ] });
  throw new Error(`Unexpected offline MultiAgency catalog request: ${url.pathname}`);
}) as typeof fetch);
const rt = await createRuntime(config, { boardApi: fixture.m.d.api, openings });
const privateJob = rt.engine.createContract(JOB_DEMO_TERMS);
const invitation = `${desk}/#/c/${privateJob.id}/sign?t=${encodeURIComponent(privateJob.contractorToken)}`;
rt.market = fixture.m;
rt.app = buildApp(rt);
await fixture.m.worker.poll();
const server = await startServer(rt, port, "127.0.0.1");
const session = `paperwork-desk-${process.pid}`;
const editor = 'textarea[placeholder="The deliverable, in Markdown"]';
const editorNode = `document.querySelector(${JSON.stringify(editor)})`;
let browserOpened = false, stopping = false;
let fixtureTimer: ReturnType<typeof setInterval> | null = null;
const receipt = { simulated: true, source: resolve(import.meta.dir, ".."), desk, single_origin: true, steps: [] as string[], screenshots: [] as string[],
  scope: "Actual openings, private-job discovery, onboarding, Market board and worker UI/routes with simulated source/identity data. No wallet, hosted Market, SDK settlement or real funds.",
  limits: ["Bidding requires separate Market authorization", "Accepted status does not prove payment", "Host-only sign-in is covered separately by auth fixtures; this keyless browser demo bypasses sign-in"] };
function step(message: string) { receipt.steps.push(message); console.log(`✓ ${message}`); }
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
async function browser(...args: string[]) {
  const child = Bun.spawn(["agent-browser", "--session", session, "--json", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: "5000" } });
  const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    check(code === 0, stderr || stdout);
    const value = JSON.parse(stdout); check(value.success, value.error);
    return value.data;
  } finally { clearTimeout(timer); }
}
async function evaluate<T>(expression: string): Promise<T> { return (await browser("eval", expression)).result; }
async function waitFor(expression: string) {
  for (const until = Date.now() + 12_000; Date.now() < until; await Bun.sleep(150)) if (await evaluate<boolean>(expression)) return;
  throw new Error(`Browser did not reach: ${expression}`);
}
async function capture(prefix: string) {
  await evaluate("window.scrollTo(0, 0)");
  for (const [width, height, name] of [[1440, 1000, "desktop"], [390, 844, "mobile"]] as const) {
    await browser("set", "viewport", String(width), String(height));
    check(await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), `${prefix} ${name} overflows horizontally`);
    const path = join(dir, `${prefix}-${name}.png`); await browser("screenshot", path); receipt.screenshots.push(path);
  }
  await browser("set", "viewport", "1440", "1000");
}
async function stop() {
  if (stopping) return; stopping = true;
  if (fixtureTimer) clearInterval(fixtureTimer);
  if (browserOpened) await browser("close").catch(() => {});
  server.stop(true);
  fixture.db.close();
  (rt.auth.options.database as import("bun:sqlite").Database).close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void stop().then(() => process.exit(0)));
console.log(`\nPaperwork Desk · OFFLINE fixtures · simulated identities, sources and outcomes\nOpen: ${desk}/\nOpenings: ${desk}/#/openings\nAgency job: ${desk}/#/c/${privateJob.id}\nBuilder invitation (simulated): ${invitation}\nArtifacts: ${dir}\nNo hosted calls or payment claims. Ctrl+C stops only this demo.\n`);

if (automated) {
  try {
    browserOpened = true;
    await browser("open", "about:blank");
    await browser("tab", "new", "--label", "desk", `${desk}/#/market/${fixture.agency.id}`);
    await waitFor(`!!${editorNode}`);
    await browser("fill", editor, "Unsent Desk draft, kept separately");
    await evaluate("localStorage.setItem('paperwork.portal-probe', 'same-desk')");
    await browser("tab", "new", "--label", "work", `${desk}/`);
    await waitFor("document.querySelector('h1')?.textContent === 'Assigned to me' && !!document.querySelector('#my-jobs-needs_action')");
    check(await evaluate(`!!document.querySelector('a[href="#/c/${privateJob.id}/sign"]') && document.title.endsWith('Paperwork')`), "The default workspace did not preserve the original private job and role-specific link");
    check(await evaluate("!document.querySelector('.sidebar .nav a[href=\"#/market\"]') && !document.querySelector('.sidebar .nav a[href=\"#/market-jobs\"]')"), "Market tools must not appear as competing top-level navigation items");
    await capture("assigned");
    step("Desk opens on the signed-in person's recorded next actions, with the original private job identity");
    await browser("click", `a[href="#/c/${privateJob.id}/sign"]`);
    await waitFor("document.body.innerText.includes('This link is missing its signing token')");
    check(await evaluate("![...document.querySelectorAll('button')].some(b => b.textContent.includes('Sign as maria.demo'))"), "Token-free discovery must not enable acceptance");
    await browser("open", invitation);
    await waitFor("[...document.querySelectorAll('button')].some(b => b.textContent.includes('Sign as maria.demo') && !b.disabled)");
    check(!(await rt.engine.viewContract(privateJob.id)).signatures.contractor, "Viewing the original invitation must not sign the job");
    step("Token-free discovery only views terms; the launcher's original fixture invitation enables signing without accepting automatically");
    await evaluate("location.hash = '/agency'");
    await waitFor("!!document.querySelector('main a[href=\"#/market\"]')");
    await browser("click", "main a[href=\"#/market\"]");
    await waitFor("document.querySelector('h1')?.textContent === 'Market integration'");
    check(await evaluate("!!document.querySelector('main a[href=\"#/agency\"]')"), "Market management did not retain its Agency parent");
    step("Agency owns Market integration setup and hires; public Market jobs remain under Openings");
    await evaluate("location.hash = '/openings'");
    await waitFor("document.body.innerText.includes('MultiAgency published opening 3')");
    check(await evaluate("localStorage.getItem('paperwork.portal-probe') === 'same-desk'"), "Workspace tabs did not retain the same Desk origin");
    check(await evaluate("!document.body.innerText.includes('MUST NOT APPEAR') && !document.body.innerText.includes('Monthly report CSV export')"), "Private/draft/closed work leaked into published openings");
    check(await evaluate("!document.querySelector('nav[aria-label=\"Work sources\"] a[href=\"#/assignments\"]')"), "Private agent tools must not be presented as a public job source");
    step("One Desk origin serves public openings; private, draft and closed work stays out of the public view");
    await capture("openings");
    await evaluate("location.hash = '/start'");
    await waitFor("document.body.innerText.includes('Get started with Paperwork')");
    check(await evaluate("!!document.querySelector('a[href=\"https://multiagency.ai/apply\"]') && [...document.querySelectorAll('a')].some(a => ['#/', '#/my-jobs'].includes(a.getAttribute('href')))"), "Onboarding did not connect applications and existing jobs");
    await evaluate("location.hash = '/my-jobs'");
    await waitFor(`!!document.querySelector('a[href="#/c/${privateJob.id}/sign"]')`);
    check(await evaluate("!document.body.innerText.includes('Confirmed settlement') && ![...document.querySelectorAll('a')].some(a => a.href.includes('?t='))"), "My jobs invented payment evidence or exposed an invitation token");
    step("Onboarding links existing application and invitation flows; My jobs retains its original private job identity without publishing a token");
    await evaluate("location.hash = '/market-jobs'");
    await waitFor("document.body.innerText.includes('50 jobs loaded')");
    boardFailOffset = 50;
    await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Load more')).click()");
    await waitFor("document.body.innerText.includes('Showing the last loaded results')");
    check(await evaluate("document.body.innerText.includes('50 jobs loaded') && !document.body.innerText.includes('No open jobs')"), "Later-page failure erased loaded jobs or claimed an empty board");
    boardFailOffset = null;
    await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Load more')).click()");
    await waitFor("document.body.innerText.includes('100 jobs loaded')");
    await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Load more')).click()");
    await waitFor("document.body.innerText.includes('123 jobs loaded')");
    check(await evaluate("document.body.innerText.includes('Open market job 123') && ![...document.querySelectorAll('button')].some(b => b.textContent.includes('Load more'))"), "Market pagination stopped at one hundred or did not reach its last page");
    step("Agent Market remains a separate source: all 123 fixture jobs load, with a later-page outage retaining partial results");
    await capture("market");
    await evaluate("location.hash = '/assignments'");
    await waitFor(`!!${editorNode}`);
    await browser("fill", editor, "CSV export implemented. Offline reference: https://example.test/csv-tests");
    await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Submit the deliverable')).click()");
    await waitFor("document.body.innerText.includes('unknown') || document.body.innerText.includes(\"didn't answer\")");
    const original = fixture.m.worker.row("assignment-offline-1");
    check(original.submit_state === "unknown" && posts === 1, "Lost submission did not retain one unknown attempt");
    await browser("reload");
    await waitFor("document.body.innerText.includes('unknown') || document.body.innerText.includes(\"didn't answer\")");
    check(fixture.m.worker.row("assignment-offline-1").submit_attempt_id === original.submit_attempt_id && posts === 1, "Reload replaced/replayed the attempt");
    step("Lost Market response and reload retain the saved submission and attempt; no second POST");
    await browser("tab", "desk");
    await waitFor(`!!${editorNode}?.disabled`);
    check(await evaluate(`${editorNode}.value.includes('CSV export implemented')`), "Open Desk tab did not adopt the saved pending report");
    // An empty current read permits only an explicit saved-body retry. A later matching version must stop its POST.
    await fixture.m.worker.poll();
    await waitFor("document.body.innerText.includes('Retry saved deliverable')");
    check(await evaluate(`${editorNode}.value.includes('CSV export implemented') && ${editorNode}.disabled`), "Recovery reverted to the old Desk draft");
    versionsAvailable = true;
    await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Retry saved deliverable')).click()");
    await waitFor("document.body.innerText.includes('Delivery recorded')");
    check(fixture.m.worker.row("assignment-offline-1").submit_state === "submitted", "Matching version did not confirm arrival");
    check(await evaluate(`${editorNode}.value === 'Unsent Desk draft, kept separately'`), "Saved-attempt recovery discarded the unsent Desk draft");
    check(posts === 1 && fixture.m.worker.row("assignment-offline-1").submit_attempt_id === original.submit_attempt_id, "Saved retry replaced/replayed an arrived attempt");
    step("Already-open Desk retries the exact saved attempt; a late matching version prevents another send and preserves its draft");
    status = "accepted"; await fixture.m.worker.poll();
    await browser("tab", "work");
    await browser("reload");
    await waitFor("document.body.innerText.includes('accepted')");
    check(posts === 1, "Observation resent a deliverable");
    step("Matching Market version proves delivery; fixture acceptance remains separate from payment");
    const connectedApp = rt.app;
    try {
      // Exercise the real unavailable route with this launcher's own disconnected runtime.
      rt.app = buildApp({ ...rt, market: null });
      await evaluate("location.hash = '/agency'");
      await browser("reload");
      await waitFor("!!document.querySelector('main a[href=\"#/market\"]')");
      await browser("click", "main a[href=\"#/market\"]");
      await waitFor("document.body.innerText.includes('Market integration is not configured')");
      check(await evaluate("!!document.querySelector('main a[href=\"#/agency\"]') && !!document.querySelector('main a[href=\"#/market-jobs\"]') && !document.body.innerText.includes('New agency')"), "Unconfigured Market navigation must explain availability without exposing setup or hire controls");
      await capture("market-unconfigured");
      step("Unconfigured Market integration stays discoverable and explains its prerequisite without enabling agency setup or hires");
    } finally { rt.app = connectedApp; }
    writeFileSync(join(dir, "receipt.json"), JSON.stringify({ ...receipt, published_openings: 3, private_job: privateJob.id, market_jobs_loaded: 123, assignment: "assignment-offline-1", attempt: original.submit_attempt_id, outbound_submissions: posts, result: "passed" }, null, 2));
    console.log(`PASS · single-origin Paperwork Desk · ${join(dir, "receipt.json")}`);
  } finally { await stop(); }
} else {
  writeFileSync(join(dir, "receipt.json"), JSON.stringify({ ...receipt, result: "interactive fixture" }, null, 2));
  // Observe fixture acceptance only after delivery has arrived; no payment is simulated or claimed.
  fixtureTimer = setInterval(() => {
    if (posted) { versionsAvailable = true; status = "accepted"; }
    void fixture.m.worker.poll().catch((error) => console.error(String(error)));
  }, 5000);
}
