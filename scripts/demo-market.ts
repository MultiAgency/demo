/**
 * bun run demo:market   (PLATFORM_STACK_DIR=<platform stack dir> required)
 *
 * Paperwork's agent-market hires against the MultiAgency platform's local stack, through Paperwork's own HTTP API (the
 * routes the browser uses). Simulated: provider, chain, wallet signatures, the DAO's votes and the agent market
 * (listed agents `writer`, which delivers, and `refuser`, which rejects). Real: the gateway, `/apps/v1`, the market
 * agent, its payment key, x402 payment and its resolution from the chain. Start the stack in the platform checkout:
 *   pnpm test:e2e:stack --app multiagency-paperwork --market --no-browser                  # wallet agency
 *   pnpm test:e2e:stack --app multiagency-paperwork --market --dao-treasury --no-browser   # and a DAO agency
 *
 * Each run creates new agencies. Needs platform 0.5.7 or later: M1 and M2 are fixed there
 * (docs/platform-gaps.md). Directory checks require the SDK 0.6.0 simulator contract.
 * Exits non-zero on any failure.
 */
import { readFileSync, realpathSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { Market } from "../src/server/market";
import { MarketApi } from "../src/server/market/api";
import { buildApp, createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import type { AgencyNext, AgencyView, HireView } from "../src/shared/market";

const dir = process.env.PLATFORM_STACK_DIR;
if (!dir) throw new Error("Set PLATFORM_STACK_DIR to the platform stack's directory (where its state.json is).");
const rt = await createRuntime(loadConfig({ PLATFORM: "remote", PLATFORM_STACK_DIR: dir, GITHUB: "fake", JUDGE: "rules" }));
if (!rt.market) throw new Error("The stack serves no agent market: start it with --market.");

const failures: string[] = [];
const check = (cond: boolean, label: string) => {
  console.log(`    ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures.push(label);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function call<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await rt.app.request(`/api${path}`, { method, ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
}
async function ok<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const r = await call<T>(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}
const sign = (s: { account_id: string; message: string; nonce: string; recipient: string }) => ok<{ public_key: string; signature: string }>("POST", "/sim/sign", s);

/**
 * Plays one owner flow like the agency's owner (`next` for setup, `freeze`, `unfreeze`): signs in the wallet, completes
 * the platform's confirm page, or passes the DAO's vote, until the flow is done or `blocked`. Answers how it was signed.
 */
const voted = new Set<string>();
async function play(id: string, path: "next" | "freeze" | "unfreeze"): Promise<{ next: AgencyNext; how: string }> {
  let next = await ok<AgencyNext>("POST", `/market/agencies/${id}/${path}`);
  let how = "nothing to do";
  // A deadline, not a count: with --on-chain-policy-edits each voted owner action takes ~10 s to apply.
  for (const end = Date.now() + 90_000; Date.now() < end && next.kind !== "done" && next.kind !== "blocked"; ) {
    if (next.kind === "sign") {
      console.log(`    · the owner signs the ${next.step} text`);
      const s = await sign(next.sign);
      await ok("POST", `/market/agencies/${id}/signed`, { step: next.step, nonce: next.sign.nonce, publicKey: s.public_key, signature: s.signature });
    } else if (next.kind === "owner_step" && next.sign) {
      console.log(`    · the owner signs: ${next.label}`);
      how = "signed in the wallet (NEP-413)";
      const s = await sign(next.sign);
      await ok("POST", `/market/steps/${next.correlation_id}/submit`, { publicKey: s.public_key, signature: s.signature });
    } else if (next.kind === "owner_step" && next.confirm) {
      console.log(`    · the owner confirms on the platform's page: ${next.label}`);
      how = "signed on the platform's confirm page (NEP-366)";
      await ok("POST", "/sim/confirm", { url: next.confirm.url });
    } else if (next.kind === "dao_vote") {
      how = "passed by the DAO's vote";
      if (!voted.has(next.vote.id)) {
        voted.add(next.vote.id);
        console.log(`    · the DAO votes (${next.vote.kind}): ${next.vote.description.split("<br>")[0]!.replace("* Proposal Action: ", "").slice(0, 110)}`);
        await ok("POST", "/market/sim/vote", { vote_id: next.vote.id });
      } else await sleep(250);
    } else if (next.kind === "register") {
      console.log(`    · the owner registers payment key ${next.account.slice(0, 12)}… on USDC (${next.transaction.actions[0]!.params.methodName})`);
      await ok("POST", "/market/sim/register", { agency_id: id });
    } else await sleep(250);
    next = await ok<AgencyNext>("POST", `/market/agencies/${id}/${path}`);
  }
  return { next, how };
}
const setUp = async (id: string) => (await play(id, "next")).next;

async function hire(id: string, handle: string, brief: string): Promise<HireView> {
  const quoted = await ok<HireView>("POST", `/market/agencies/${id}/quote`, { handle, brief });
  return ok<HireView>("POST", `/market/hires/${quoted.request_id}/approve`);
}
async function followUntil(rid: string, done: (h: HireView) => boolean, tries = 40): Promise<HireView> {
  let h = await ok<HireView>("POST", `/market/hires/${rid}/follow`);
  for (let i = 0; i < tries && !done(h); i++) {
    await sleep(250);
    h = await ok<HireView>("POST", `/market/hires/${rid}/follow`);
  }
  return h;
}

const cfg = await ok("GET", "/config");
const stackState = JSON.parse(await Bun.file(`${dir}/state.json`).text()) as { ownerAccount: string };
console.log(`\nPaperwork · agent market on the LOCAL PLATFORM STACK at ${rt.kit.platform.host}\n`);

// ---------------------------------------------------------------- a wallet-owned agency
console.log("1. A wallet-owned agency sets up its market agent");
const wallet = (await ok<{ id: string }>("POST", "/market/agencies", { name: "Acme Studio", owner: stackState.ownerAccount, signer: "wallet" })).id;
check((await setUp(wallet)).kind === "done", "setup → create → consent (read, owner, market) → market grant → payment key registered");
await ok("POST", "/market/sim/fund", { agency_id: wallet, usd: "10" });
const deposit = await ok("POST", `/market/agencies/${wallet}/deposit`);
check(typeof deposit.address === "string" && deposit.address.length > 0, `a deposit address for funding and earnings: ${deposit.address}`);

console.log("2. It hires `writer`: approved by the owner's hire, paid once, on delivery");
const brief = "An article\nWrite 300 words on NEAR Intents for a developer audience.";
const quoted = await ok<HireView>("POST", `/market/agencies/${wallet}/quote`, { handle: "writer", brief });
check(quoted.state === "quoted" && quoted.terms.handle === "writer" && quoted.amount_usd === "0.5", `quoted: ${quoted.amount_usd} USDC to the market's payee ${quoted.terms.payTo.slice(0, 10)}…, window ${quoted.terms.maxTimeoutSeconds} s`);
const asked = await ok<HireView>("POST", `/market/hires/${quoted.request_id}/approve`);
const paid = await followUntil(asked.request_id, (h) => h.state === "paid");
check(paid.state === "paid", `paid (the chain shows the payment key's nonce and balance moved), task ${paid.task_state}`);
check(paid.deliverable === "the article", `the deliverable beside the terms: "${paid.deliverable}"`);
check((await call("POST", `/market/hires/${paid.request_id}/approve`)).status === 409, "approving it again is refused: one requestId, one hire");
const acct = (await ok<AgencyView>("GET", `/market/agencies/${wallet}`)).account;
check(acct?.opened === true && acct.usdc_usd === "0", "the payment key opened and holds nothing after paying");

console.log("3. It hires `refuser`: rejected, unknown while the payment could still settle, then not charged");
const refused = await hire(wallet, "refuser", brief);
const held = await followUntil(refused.request_id, (h) => h.task_state === "TASK_STATE_REJECTED", 5);
check(held.state === "unknown" && held.task_state === "TASK_STATE_REJECTED", "the task was rejected, yet the payment is unknown: a signed authorization can be relayed until it expires");
await ok("POST", "/market/sim/advance", {});
const notCharged = await followUntil(refused.request_id, (h) => h.state === "not_charged");
check(notCharged.state === "not_charged", "past its expiry with the key's nonce unused: not charged");

console.log("4. Refusals carry the platform's code and send nothing");
const discard = await ok<HireView>("POST", `/market/agencies/${wallet}/quote`, { handle: "writer", brief: "Another brief" });
check((await call("POST", `/market/hires/${discard.request_id}/discard`)).status === 200, "an unapproved quote is discarded; nothing was sent for it");
const unlisted = await call("POST", `/market/agencies/${wallet}/quote`, { handle: "nosuchagent", brief });
check(unlisted.status === 400 && String((unlisted.json as { error?: string }).error).includes("agent_not_found"), `a quote for an unlisted handle is refused agent_not_found (${unlisted.status}), not "send again" (M1, fixed: MultiAgency/platform#66)`);

console.log("5. The public directory");
// Directory SLA is delivery time; the simulator adds 600 seconds to the x402 authorization window.
const upstreamResponse = await fetch(`${rt.market.d.api.base}/v1/agents?q=writer&limit=20`);
const upstream = await upstreamResponse.json() as { agents: { agent_id: string; handle: string }[] };
console.log(`    upstream directory: ${JSON.stringify(upstream)}`);
const listing = await call("GET", "/market/directory?q=writer");
console.log(`    directory response: ${JSON.stringify(listing)}`);
const rows = Array.isArray(listing.json) ? listing.json : [];
const writer = rows.find((a: any) => a.handle === "writer");
check(upstreamResponse.status === 200 && Array.isArray(upstream.agents) && upstream.agents.length === 1 &&
  listing.status === 200 && rows.length === 1 && !!writer && writer.agent_id === upstream.agents[0]!.agent_id && upstream.agents[0]!.handle === "writer",
  "directory search returns exactly the listed writer through Paperwork's public API");
check(!!writer && typeof writer.agent_id === "string" && writer.agent_id.length > 0 &&
  typeof writer.name === "string" && writer.name.length > 0 &&
  (writer.description === null || typeof writer.description === "string") &&
  writer.sla_seconds === 600 && Number.isInteger(writer.delivered_jobs) && writer.delivered_jobs >= 0 &&
  (writer.success_rate === null || (typeof writer.success_rate === "number" && Number.isFinite(writer.success_rate))),
  "directory preserves writer identity and typed metadata, with the simulator delivery SLA");
const absent = await call("GET", "/market/directory?q=not-listed");
check(absent.status === 200 && Array.isArray(absent.json) && absent.json.length === 0,
  "directory search excludes an unlisted handle");
if (writer) {
  const detail = await call("GET", `/market/directory/${encodeURIComponent(writer.agent_id)}`);
  console.log(`    directory detail: ${JSON.stringify(detail)}`);
  const plans = Array.isArray(detail.json.plans) ? detail.json.plans : [];
  check(detail.status === 200 && plans.length === 1 && plans[0].model === "per_call" &&
    plans[0].is_default === true && Number(plans[0].price_amount) === Number(quoted.amount_usd) &&
    plans[0].sla_seconds === writer.sla_seconds && quoted.terms.maxTimeoutSeconds === writer.sla_seconds + 600 &&
    detail.json.reputation?.jobs_counted === 0 && detail.json.reputation?.overall === null,
    "listed agent detail preserves default pricing, SLA and unscored reputation; the signed quote remains payment authority");
}

console.log("6. The owner freezes the market agent; nothing is approved until it's unfrozen");
const froze = await play(wallet, "freeze");
check(froze.next.kind === "done" && (await ok<AgencyView>("GET", `/market/agencies/${wallet}`)).frozen === true, `frozen, ${froze.how}: the platform reads the agent's policy frozen`);
const whileFrozen = await ok<HireView>("POST", `/market/agencies/${wallet}/quote`, { handle: "writer", brief });
check((await call("POST", `/market/hires/${whileFrozen.request_id}/approve`)).status === 409, "approving a job while frozen is refused, with nothing sent");
const thawed = await play(wallet, "unfreeze");
check(thawed.next.kind === "done" && (await ok<AgencyView>("GET", `/market/agencies/${wallet}`)).frozen === false, `unfrozen, ${thawed.how}: the policy is back in force`);
const afterThaw = await followUntil((await ok<HireView>("POST", `/market/hires/${whileFrozen.request_id}/approve`)).request_id, (h) => h.state === "paid");
check(afterThaw.state === "paid", "the job held back while frozen is approved and paid after the unfreeze");

// ---------------------------------------------------------------- a DAO-owned agency
if (cfg.market.dao) {
  console.log(`7. A DAO-owned agency (${cfg.market.dao}): every step is the DAO's vote`);
  const dao = (await ok<{ id: string }>("POST", "/market/agencies", { name: "Council Agency", owner: cfg.market.dao, signer: "dao" })).id;
  check((await setUp(dao)).kind === "done", "setup, creation, consent (read, market), the market grant and the payment key's registration, each passed by the DAO's vote (M2, fixed: MultiAgency/platform#67)");
  await ok("POST", "/market/sim/fund", { agency_id: dao, usd: "10" });
  const proposed = await ok<HireView>("POST", `/market/agencies/${dao}/quote`, { handle: "writer", brief });
  const filed = await ok<HireView>("POST", `/market/hires/${proposed.request_id}/approve`);
  check(filed.state === "voting" && filed.vote?.kind === "hire" && filed.vote.description.includes("Approve market hire"), "approving files the job's exact terms for the DAO's vote; nothing is paid yet");
  check((await call("POST", `/market/hires/${proposed.request_id}/approve`)).status === 409, "approving it again is refused while the vote runs: one requestId, one vote");
  await ok("POST", "/market/sim/vote", { vote_id: filed.vote!.id });
  const daoPaid = await followUntil(proposed.request_id, (h) => h.state === "paid");
  check(daoPaid.state === "paid" && daoPaid.deliverable === "the article", `paid after the DAO's vote, re-quoted against the voted terms; deliverable "${daoPaid.deliverable}"`);
  const daoFroze = await play(dao, "freeze");
  check(daoFroze.next.kind === "done" && (await ok<AgencyView>("GET", `/market/agencies/${dao}`)).frozen === true, `frozen, ${daoFroze.how}: the provider stops the agent's sends`);
  const heldByFreeze = await ok<HireView>("POST", `/market/agencies/${dao}/quote`, { handle: "writer", brief });
  check((await call("POST", `/market/hires/${heldByFreeze.request_id}/approve`)).status === 409, "while frozen, no job is filed for a vote");
  const daoThawed = await play(dao, "unfreeze");
  check(daoThawed.next.kind === "done" && (await ok<AgencyView>("GET", `/market/agencies/${dao}`)).frozen === false, `unfrozen, ${daoThawed.how}: the policy in force applies again`);
} else console.log("7. (no DAO on this stack: start it with --dao-treasury for the DAO agency)");

// Optional real-process worker integration against the same simulator, using only its private fixture token.
if (process.argv.includes("--worker")) {
  console.log("8. A separate agency does the buyer's job through Paperwork's worker HTTP routes");
  const state = z.object({ market: z.object({ url: z.url(), workerCredentialsFile: z.string() }) })
    .parse(JSON.parse(readFileSync(resolve(dir, "state.json"), "utf8")));
  const stackRoot = realpathSync(dir);
  const credentialsPath = realpathSync(state.market.workerCredentialsFile);
  if (!rt.kit.controls || !rt.market.d.controls || dirname(credentialsPath) !== stackRoot ||
      !["127.0.0.1", "localhost", "[::1]"].includes(new URL(state.market.url).hostname))
    throw new Error("Worker integration requires an owned loopback simulator and its local fixture credentials.");
  const credentials = z.object({ worker: z.object({ token: z.string().startsWith("aat_"), webhookSecret: z.string() }) })
    .parse(JSON.parse(readFileSync(credentialsPath, "utf8"))).worker;
  const workerAgency = (await ok<{ id: string }>("POST", "/market/agencies", { name: "Listed worker agency", owner: stackState.ownerAccount, signer: "wallet" })).id;
  check(rt.market.agencies.row(workerAgency).stage === "needs_setup" && workerAgency !== wallet, "worker has a distinct legitimate agency without buyer setup, consent, grant or funding");
  const platformPayoutsBefore = rt.db.query("SELECT request_id FROM payout_attempts ORDER BY request_id").all();
  const workerHire = await hire(wallet, "worker", "Prepare the SDK integration report.");
  const requestId = workerHire.request_id;
  const assignmentId = rt.market.hires.row(requestId).task_id;
  if (!assignmentId) throw new Error("The simulator returned no worker assignment identity.");
  check(workerHire.state !== "paid", "buyer remains unpaid while the worker has not submitted");
  let submissionPosts = 0;
  const observeFetch: typeof fetch = Object.assign((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (init?.method === "POST" && url.pathname.endsWith("/submit")) submissionPosts++;
    return fetch(input, init);
  }) as typeof fetch, { preconnect: fetch.preconnect });
  rt.market = new Market({ ...rt.market.d, api: new MarketApi(state.market.url, credentials.token, observeFetch),
    worker: { agencyId: workerAgency, token: credentials.token, secret: credentials.webhookSecret } });
  rt.app = buildApp(rt);
  await ok("POST", "/market/worker/poll");
  const assignment = rt.market.worker.row(assignmentId);
  check(assignment.status === "in_progress" && assignment.agency_id === workerAgency && assignment.submit_state === "none",
    "Paperwork imports the token-scoped assignment under the distinct worker agency");
  const markdown = "# Integration report\nDelivered through Paperwork's worker API.";
  await ok("POST", `/market/worker/jobs/${encodeURIComponent(assignmentId)}/submit`, { markdown });
  const saved = rt.market.worker.row(assignmentId);
  if (saved.submit_state !== "submitted") {
    const blocked = { simulated: true, result: "BLOCKED", request_id: requestId, assignment_id: assignmentId,
      submit_attempt_id: saved.submit_attempt_id, submit_state: saved.submit_state, error: saved.submit_error,
      submission_posts: submissionPosts, hire_state: rt.market.hires.row(requestId).state };
    const artifacts = mkdtempSync(join(process.env.PAPERWORK_DEMO_ARTIFACTS ?? tmpdir(), "paperwork-market-work-"));
    writeFileSync(join(artifacts, "receipt.json"), JSON.stringify(blocked, null, 2) + "\n");
    console.log(`    blocked worker receipt: ${join(artifacts, "receipt.json")} ${JSON.stringify(blocked)}`);
    check(submissionPosts === 0 && rt.market.hires.row(requestId).state !== "paid",
      "failed preflight sends no submission and does not claim settlement");
    throw new Error("Worker submission remains blocked; preserve the original attempt. The candidate must support deliverable-version preflight; no fallback POST or replacement is allowed.");
  }
  check(saved.submit_state === "submitted" && saved.deliverable === markdown && !!saved.submit_attempt_id,
    "the original worker submission body and attempt are durably recorded");
  await ok("POST", "/market/worker/poll");
  check(rt.market.worker.row(assignmentId).status === "accepted", "Market acceptance is observed from the actual simulator API");
  const paid = await followUntil(requestId, h => h.state === "paid");
  check(paid.request_id === requestId && paid.state === "paid" && paid.deliverable === markdown,
    "the buyer observes settlement and the worker deliverable under the original hire identity");
  check((await call("POST", `/market/worker/jobs/${encodeURIComponent(assignmentId)}/submit`, { markdown })).status === 409 &&
    rt.market.worker.row(assignmentId).submit_attempt_id === saved.submit_attempt_id,
    "a duplicate worker submission is refused without replacing the original attempt");
  check(submissionPosts === 1 && JSON.stringify(rt.db.query("SELECT request_id FROM payout_attempts ORDER BY request_id").all()) === JSON.stringify(platformPayoutsBefore),
    "worker completion requests no platform payout; the buyer's x402 Market payment is separate");
  console.log(`    worker receipt: ${JSON.stringify({ buyer_agency: wallet, worker_agency: workerAgency,
    request_id: requestId, assignment_id: assignmentId, submission_attempt_id: saved.submit_attempt_id,
    assignment_status: rt.market.worker.row(assignmentId).status, hire_state: paid.state, platform_payouts_added: 0 })}`);
}

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}` : "\n✓ every check passed");
process.exit(failures.length ? 1 : 0);
