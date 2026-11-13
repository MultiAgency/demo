/**
 * Browser walkthrough of a Market-settled job: import, settlement choice, acceptance, report, assessment and
 * Market acceptance. The Market, both accounts and every signature are fixtures; no platform payment exists to make.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { startServer } from "../src/server/index";
import { MarketApi } from "../src/server/market/api";
import { isMarketSettled } from "../src/shared/terms";
import type { ContractView } from "../src/shared/views";
import { browserDriver, check } from "./browser-driver";

const JOB = "f4a00000-0000-4000-8000-000000000077";
const dir = mkdtempSync(join(process.env.PAPERWORK_DEMO_ARTIFACTS ?? tmpdir(), "paperwork-market-settled-"));
const steps: string[] = [];
const step = (text: string) => { steps.push(text); console.log(`✓ ${text}`); };

// The public Market job as its API reports it. Only `status` changes during the walkthrough.
const market = { status: "in_progress" };
const marketFetch = (async () => Response.json({
  jobId: JOB, creatorAccountId: "cfb00000-0000-4000-8000-000000000001", title: "CSV export for monthly reports",
  description: "Users can download any monthly report as CSV; covered by tests.", tags: [], budgetAmount: "300.000000000000",
  budgetToken: "USDC", requiresVerifiable: false, jobKind: "standard", status: market.status, maxSlots: 1, currentMaxSlots: 0,
  isPrivate: false, acceptanceWindowDays: 3, minBuilderVerification: "none", isTestRun: false,
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
})) as unknown as typeof fetch;

const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules", PORT: "0" }),
  { boardApi: new MarketApi("https://market.invalid", "aat_fixture", marketFetch) });
const server = await startServer(rt, 0, "127.0.0.1");
const base = server.url.origin;
const browser = browserDriver({ agency: `paperwork-market-agency-${process.pid}`, builder: `paperwork-market-builder-${process.pid}` }, dir);
const { button, fill, open, pageWait, evaluate, capture, text } = browser;
const shows = (words: string) => `document.body.innerText.includes(${JSON.stringify(words)})`;

let contractId = "";
const view = () => rt.engine.viewContract(contractId);
async function state(predicate: (v: ContractView) => boolean, label: string) {
  for (const end = Date.now() + 12_000; Date.now() < end; await Bun.sleep(150)) {
    const v = await view();
    if (predicate(v)) return v;
  }
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  await open("agency", `${base}/#/new`);
  await fill("agency", "Market job link or id", `https://market.invalid/jobs/${JOB}`);
  await button("agency", "Import");
  await pageWait("agency", shows(`Market job ${JOB}`), "imported Market job");
  check(await evaluate<boolean>("agency", "document.querySelector('[aria-label=\"d1 title\"]').value==='CSV export for monthly reports' && document.querySelector('[aria-label=\"d1 value\"]').value==='300'"), "Import must pre-fill the scope from the Market job");
  step("Agency imports a public Market job; its title, description and budget pre-fill an editable scope");

  await browser.activate("agency", "radio", "The Agent Market", true);
  await pageWait("agency", shows("Settled on the Agent Market: no platform agent, policy or payout is created for this job."), "Market settlement preview");
  check(!(await evaluate<boolean>("agency", "[...document.querySelectorAll('.field-label')].some(l=>l.textContent==='Payee')")), "A Market-settled offer must not ask for a NEAR payee");
  await capture("agency", "01-market-settlement-choice");
  await button("agency", "Create draft");
  await pageWait("agency", "location.hash.startsWith('#/c/')", "created job");
  contractId = (await evaluate<string>("agency", "location.hash")).split("/")[2]!;
  const offered = await view();
  check(isMarketSettled(offered.terms) && offered.terms.market_source.job_id === JOB, "The signed terms must record Market settlement and its source job");
  step("Agency chooses Market settlement; the terms carry the Market job and no NEAR payee");

  await button("agency", "Sign as acme.demo");
  const token = await evaluate<string>("agency", `localStorage.getItem(${JSON.stringify(`paperwork.link.${contractId}`)})`);
  await open("builder", `${base}/#/c/${contractId}/sign?t=${token}`);
  await button("builder", "Sign as maria.demo (demo wallet)");
  const accepted = await state(v => v.stage === "active", "accepted job without platform setup");
  check(accepted.platform.agent_id === null && rt.engine.onboarding.agentRow(contractId) === null, "A Market-settled job must not reserve a platform agent");
  await pageWait("agency", shows("Submission and review"), "agency review view without a setup checklist");
  check(!(await text("agency")).includes("Fund the agent"), "A Market-settled job must show no funding step");
  step("Both parties sign; the job is active with no platform setup, agent or funding step");

  await pageWait("builder", "!!document.querySelector('.job-builder textarea')", "builder report form");
  await fill("builder", "Work report", "CSV export is complete. The linked change and tests demonstrate the acceptance criteria.");
  await fill("builder", "Invoice number", "MKT-001");
  await fill("builder", "Invoice amount · USDC", "300");
  await fill("builder", "d1 evidence URL", "https://github.com/acme/app/pull/101");
  await fill("builder", "d1 evidence description", "CSV export implementation and tests");
  await button("builder", "Submit report and invoice");
  await state(v => v.submissions[0]?.state === "submitted", "filed report");
  step("Builder files the report, invoice and evidence");

  await button("agency", "Assess against criteria");
  await state(v => v.submissions[0]?.state === "proposed", "agent assessment");
  await pageWait("agency", shows("Agent recommends"), "agency sees the assessment");
  await pageWait("builder", shows("Assessed · accept on the Market"), "builder sees the review status");
  check(!(await text("builder")).includes("Agent recommends"), "The builder must not read the agent's recommendation before the agency decides");
  await capture("agency", "02-assessed");
  step("Agency has the agent assess the report; the recommendation is the agency's alone");

  await button("agency", "Check Market acceptance");
  await pageWait("agency", "!!document.querySelector('.alert')", "refusal while the Market job is still in progress");
  check((await view()).submissions[0]!.state === "proposed", "Acceptance must not be recorded while the Market job is in progress");
  market.status = "completed";
  await button("agency", "Check Market acceptance");
  const done = await state(v => v.submissions[0]?.state === "market_accepted", "recorded Market acceptance");
  await pageWait("builder", shows("Accepted on Market · payment unconfirmed"), "builder sees Market acceptance");
  check(done.payouts.length === 0 && done.paid_usd === "0" && (await rt.kit.controls!.transfers()).length === 0, "Paperwork must request and record no payment for a Market-settled job");
  await capture("builder", "03-market-accepted");
  step("Acceptance is recorded only once the Market reports the job completed; Paperwork requests and confirms no payment");

  writeFileSync(join(dir, "receipt.json"), JSON.stringify({
    simulated: true, scope: "Market-settled job in two keyless fixture browsers; the Market API is an in-process fixture, not the hosted Market",
    job: contractId, terms_hash: done.hash, market_job: JOB, submission: done.submissions[0]!.id, payouts: 0, steps, captures: browser.captures,
  }, null, 2));
  console.log(`PASS · Market-settled job in the browser · receipt ${join(dir, "receipt.json")}`);
} catch (error) {
  writeFileSync(join(dir, "failure.txt"), String(error));
  for (const actor of browser.opened) { try { await capture(actor, `failure-${actor}`); } catch { /* Keep the original failure. */ } }
  throw error;
} finally {
  await browser.close();
  server.stop(true);
}
