import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractPackage } from "@multiagency/sdk";
import { StackControls } from "../src/server/platform/stack";
/**
 * One job, using Paperwork's real workflow code and existing FakePlatform.
 * Simulated signatures, provider, settlement and rule-based assessment; no network or real funds.
 * Optional fault/revision walkthrough: PAPERWORK_JOB_CHANGES=1 PAPERWORK_JOB_LOST_REPLY=1 bun run demo:job
 */
import { createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { toAtomic } from "../src/shared/money";
import { parseTerms, scopeTotal } from "../src/shared/terms";
import type { JobSubmissionInput } from "../src/shared/jobs";
import { readStack } from "../src/server/platform/stack";

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const withChanges = process.env.PAPERWORK_JOB_CHANGES === "1";
const lostReply = process.env.PAPERWORK_JOB_LOST_REPLY === "1";
const stackDir = process.env.PLATFORM_STACK_DIR;
const stack = stackDir ? readStack(stackDir) : null;
const dao = process.env.PAPERWORK_JOB_DAO === "1";
if (dao && !stack?.dao) throw new Error("DAO proof needs a loopback stack started with --dao-treasury.");
if (stack && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(stack.url).hostname)) throw new Error("The job recipe only supports an isolated loopback platform stack.");
if (stack && lostReply) throw new Error("PAPERWORK_JOB_LOST_REPLY is stand-in-only in this recipe. Use PAPERWORK_RESTART_DROP_WITHDRAW=1 bun run demo:job:restart for the gateway/provider fault.");
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const terms = parseTerms({
  ...JOB_DEMO_TERMS,
  ...(process.env.PAPERWORK_JOB_FIXTURE_NAME && { company: process.env.PAPERWORK_JOB_FIXTURE_NAME }),
  ...(dao && stack?.dao && { agency_owner: { type: "dao", account_id: stack.dao } }),
  ...(stack && {
    representative: { near_account: stack.owner },
    contractor: { ...JOB_DEMO_TERMS.contractor, near_account: stack.payees[0]! },
    payee: { chain: "near", address: stack.payees[0]! },
    start: day(-7), end: day(21),
  }),
  scope: JOB_DEMO_TERMS.scope.map((d) => ({ ...d, value_usd: process.env.PAPERWORK_BUDGET_USD ?? d.value_usd })),
});
const amount = process.env.PAPERWORK_INVOICE_USD ?? scopeTotal(terms);
const restart = process.env.PAPERWORK_JOB_DAO_RESTART === "1";
if (restart && (!dao || withChanges)) throw new Error("DAO restart is a separate no-revision fixture.");
const restartArtifacts = dao ? mkdtempSync(join(tmpdir(), "paperwork-dao-restart-")) : null;
const database = restartArtifacts ? join(restartArtifacts, "paperwork.sqlite") : null;
const runtimeConfig = loadConfig({
  PLATFORM: stack ? "remote" : "fake", GITHUB: "fake", JUDGE: "rules",
  ...(stackDir && stack && { PLATFORM_STACK_DIR: stackDir, PLATFORM_DEPLOYMENT: stack.deployment }),
  ...(database && { DB_PATH: database }),
});
let rt = await createRuntime(runtimeConfig, stack ? {} : { clockStart: Date.parse("2026-11-20T12:00:00Z") });
let c = rt.engine;
const kit = rt.kit;
const sign = kit.devSigner!.sign413.bind(kit.devSigner!);
const controls = kit.controls!;
const successfulBefore = (await controls.transfers()).filter(p => p.status === "SUCCESS").length;
const { id, contractorToken } = c.createContract(terms);
const step = (number: string, title: string) => console.log(`\n${number}. ${title}`);
const show = (message: string) => console.log(`    ${message}`);

console.log(`Paperwork · ONE BUILDER JOB · ${stack ? `LOCAL PLATFORM GATEWAY via SDK ${contractPackage.version} (${new URL(stack.url).host})` : "PLATFORM STAND-IN"}`);
if (restartArtifacts) console.log(`DAO fixture artifacts: ${restartArtifacts}`);
console.log(`SIMULATED signatures, provider and settlement. Rule-based proposal; evidence links are references, not fetched or verified. ${stack ? "Loopback integration only; no hosted services or real funds." : "No real funds or network."}`);
const wait = async () => { await Bun.sleep(250); };
async function observe(checkState: (view: Awaited<ReturnType<typeof c.getContract>>) => boolean, label: string) {
  for (const until = Date.now() + 20_000; Date.now() < until; await wait()) {
    const view = await c.getContract(id);
    if (checkState(view)) return view;
  }
  throw new Error(`Timed out observing ${label}; no replacement payment was sent.`);
}
step("01", "Agency offers the job");
show(`${terms.company} → ${terms.contractor.name}; ${scopeTotal(terms)} USDC, deadline ${terms.end} (UTC)`);
show(`${terms.scope[0]!.title}: ${terms.scope[0]!.criteria}`);
show("Payment terms: scope completion less committed amounts, capped by invoice; explicit agency approval; USDC on NEAR through the platform.");
const offered = await c.viewContract(id);
show(`job ${id}; accepted-terms hash ${offered.hash}`);
for (const role of ["representative", "contractor"] as const) {
  const request = c.signingRequest(id, role);
  const signed = await sign(request);
  await c.addSignature(id, role, {
    account_id: request.account_id, public_key: signed.publicKey, signature: signed.signature, nonce: request.nonce,
  }, contractorToken);
}
step("02", "Builder accepts the exact offered terms");
show(`${terms.contractor.near_account} and ${terms.representative.near_account} signed the same hash using the demo wallet.`);
const votedDaoSteps = new Set<string>();
let next = await c.next(id);
for (let i = 0; i < 180 && next.kind !== "done"; i++) {
  if (dao) await wait();
  if (next.kind === "sign") {
    const s = await sign(next.sign);
    next = await c.signed(id, { step: next.step, nonce: next.sign.nonce, ...s });
  } else if (next.kind === "owner_step") {
    if (next.dao) {
      const hash = (next.dao.transaction.actions[0]?.params.args as any).request;
      if (!votedDaoSteps.has(next.correlation_id)) {
        await (controls as StackControls).daoVote(hash.payload_v2.Eddsa);
        votedDaoSteps.add(next.correlation_id);
      }
      await c.getOwnerStep(next.correlation_id);
      next = await c.next(id);
      continue;
    }
    check(next.sign, "This stand-in owner step needs a demo sign request.");
    await c.submitOwnerStep(next.correlation_id, await sign(next.sign));
    next = await c.next(id);
  } else if (next.kind === "dao_vote") {
    if (!votedDaoSteps.has(next.request.id)) {
      await (controls as StackControls).daoVote(next.request.hash);
      votedDaoSteps.add(next.request.id);
    }
    next = await c.next(id);
  } else { await wait(); next = await c.next(id); }
}
check(next.kind === "done", `Setup did not finish: ${JSON.stringify(next)}`);
await controls.fund(c.onboarding.agentRow(id)!.agent_id!, toAtomic(scopeTotal(terms), 6).toString());
show("The contract has its own policy-bound platform agent, funded with exactly the scope budget (simulated).");

const body = (revision: number): JobSubmissionInput => ({
  client_request_id: `job-demo-revision-${revision}`,
  report: process.env.PAPERWORK_REPORT ?? "CSV export is complete. The linked change includes monthly report export and the acceptance tests. Please review the evidence against the signed criteria.",
  evidence: [{ deliverable_id: "d1", label: "CSV export and acceptance tests", url: process.env.PAPERWORK_EVIDENCE_URL ?? "https://github.com/acme/app/pull/101" }],
  invoice: { number: revision === 1 ? "INV-DEMO-001" : `INV-DEMO-001-R${revision}`, amount_usd: amount },
});
let submitted = await c.submitJob(id, body(1), terms.contractor.near_account);
step("03", "Builder submits a report, invoice and supporting evidence");
show(`submission ${submitted.id}; invoice ${submitted.invoice.id} (${submitted.invoice.number}), ${submitted.invoice.amount_usd} USDC`);
check((await c.viewContract(id)).payouts.length === 0, "Submission alone must not request or pay compensation.");
show("Submitted. No compensation proposal, approval or payment yet.");

async function propose() {
  if (lostReply) controls.dropNextReply!();
  const proposed = await c.proposeJob(submitted.id);
  const p = proposed.payouts.find((x) => submitted.id === proposed.submissions.find((s) => s.payout_request_ids.includes(x.request_id))?.id);
  check(p, "No payout linked to this submission.");
  if (lostReply) {
    check(p.state === "unknown", "Expected injected lost request response to leave an unknown outcome.");
    show(`Lost payout response injected: ${p.request_id} is unknown. Observe this identity; do not replace it.`);
  }
  const observed = await observe((view) => view.payouts.some((x) => x.request_id === p.request_id && x.state === "held"), "held payout");
  const held = observed.payouts.find((x) => x.request_id === p.request_id)!;
  check(held.state === "held", `Expected a held proposal, got ${held.state} (${held.code}).`);
  check(observed.paid_usd === "0", "A proposal must not count as settled payment.");
  return held;
}
async function vote(requestId: string, verdict: "approve" | "reject") {
  const prepared = await c.vote(requestId, verdict);
  if (prepared.dao) {
    const hash = (prepared.dao.transaction.actions[0]?.params.args as any).request;
    await (controls as StackControls).daoVote(hash.payload_v2.Eddsa);
    if (!(restart && verdict === "approve")) await c.getOwnerStep(prepared.correlation_id);
    return prepared.correlation_id;
  }
  check(prepared.sign, "This stand-in vote needs a demo signature.");
  await c.submitOwnerStep(prepared.correlation_id, await sign(prepared.sign));
  return prepared.correlation_id;
}
step("04", "Agent proposes compensation within the accepted terms and invoice");
let payout = await propose();
show(`${payout.amount_usd} USDC; request ${payout.request_id}; held for ${terms.representative.near_account}'s approval.`);
if (withChanges) {
  step("04a", "Agency requests changes; held payment must be rejected before revision");
  await c.requestJobChanges(submitted.id, "Attach the test report before payout.");
  check(c.jobSubmissions(id).find((x) => x.id === submitted.id)!.state === "changes_pending", "The live payout must stay committed while cancellation is pending.");
  await vote(payout.request_id, "reject");
  await observe((view) => view.submissions.find((s) => s.id === submitted.id)?.state === "changes_requested", "confirmed rejection");
  check(c.jobSubmissions(id).find((x) => x.id === submitted.id)!.state === "changes_requested", "Signed rejection must be confirmed before revision.");
  submitted = await c.submitJob(id, body(2), terms.contractor.near_account);
  payout = await propose();
  show(`Original retained; revision ${submitted.revision}, invoice ${submitted.invoice.id}; new held request ${payout.request_id}.`);
}
step("05", "Agency explicitly approves the proven payout terms");
const approvalStep = await vote(payout.request_id, "approve");
if (restart && database && restartArtifacts && stackDir) {
  await (await rt.auth.$context).checkSchema?.();
  rt.db.close(true);
  const child = Bun.spawn([process.execPath, "--no-env-file", new URL("./resume-dao-job.ts", import.meta.url).pathname,
    stackDir, database, id, payout.request_id, approvalStep, join(restartArtifacts, "receipt.json")],
    { env: { PATH: process.env.PATH ?? "" }, stdout: "inherit", stderr: "inherit" });
  check(await child.exited === 0, "DAO restart subprocess failed; original database and IDs retained.");
  console.log(`PASS · DAO recovery in process ${child.pid}, original application DB closed in ${process.pid}; receipt ${join(restartArtifacts, "receipt.json")}`);
  process.exit(0);
}
// The stand-in auto-settles after status reads; inspect without advancing it so this distinct phase stays visible.
const approved = stack
  ? await observe((view) => view.payouts.find((p) => p.request_id === payout.request_id)?.state === "processing", "approved payout")
  : await c.viewContract(id);
check(approved.payouts.find((p) => p.request_id === payout.request_id)!.state === "processing", "Expected approved payout still processing.");
check(approved.paid_usd === "0", "Approval must not be represented as settlement.");
show(`Signed approval ${approvalStep}; processing. Confirmed paid amount remains 0.`);
await controls.settle(c.attempt(payout.request_id).correlation_id!);
const paid = await observe((view) => view.submissions.find((s) => s.id === submitted.id)?.state === "settled", "settlement");
const confirmed = paid.payouts.find((p) => p.request_id === payout.request_id)!;
const finalSubmission = paid.submissions.find((s) => s.id === submitted.id)!;
check(confirmed.state === "paid" && finalSubmission.state === "settled", "Expected the platform to confirm settlement.");
if (!stack) check(confirmed.tx_hash, "Expected the stand-in's simulated transaction evidence.");
check((await controls.transfers()).filter((payment) => payment.status === "SUCCESS").length === successfulBefore + 1, "Expected exactly one additional successful simulated transfer.");
step("06", "Payment is confirmed and visible to agency and builder");
const historyResponse = await rt.app.request(`/api/contracts/${id}/submissions`);
check(historyResponse.ok, "Submission history must be readable in the keyless demonstration.");
const history = await historyResponse.json() as { id: string; state: string }[];
check(history.find((s) => s.id === submitted.id)?.state === "settled", "Both party views must read the settled outcome.");
show(`${confirmed.amount_usd} USDC → ${confirmed.recipient}; ${confirmed.tx_hash ? `transaction ${confirmed.tx_hash}` : "platform confirms SUCCESS; this stack supplies no transaction hash"}`);
console.log("\nLinked receipt (simulation):");
console.log(JSON.stringify({
  job: id,
  terms_hash: paid.hash,
  builder: terms.contractor.near_account,
  submission: submitted.id,
  revision: submitted.revision,
  invoice: submitted.invoice.id,
  compensation_proposal: finalSubmission.judgment_id,
  approval: approvalStep,
  payout_request: confirmed.request_id,
  payment_correlation: c.attempt(confirmed.request_id).correlation_id,
  settlement: confirmed.state,
  tx_hash: confirmed.tx_hash,
  confirmation_source: "platform payouts/status succeeded; provider/chain simulated",
  paid_usd: paid.paid_usd,
  history: `/api/contracts/${id}/submissions`,
}, null, 2));
console.log("\nPASS · one job, one explicit approval, one confirmed simulated payment.");
