/**
 * bun run demo:market   (PLATFORM_STACK_DIR=<platform stack dir> required)
 *
 * Covenant's agent-market hires against the MultiAgency platform's local stack, through Covenant's own HTTP API (the
 * routes the browser uses). Simulated: provider, chain, wallet signatures, the DAO's votes and the agent market
 * (listed agents `writer`, which delivers, and `refuser`, which rejects). Real: the gateway, `/apps/v1`, the market
 * agent, its payment key, x402 payment and its resolution from the chain. Start the stack in the platform checkout:
 *   pnpm test:e2e:stack --app covenant --market --no-browser                  # wallet agency
 *   pnpm test:e2e:stack --app covenant --market --dao-treasury --no-browser   # and a DAO agency
 *
 * Each run creates new agencies. Needs platform 0.5.7 or later: M1 and M2 are fixed there
 * (docs/platform-gaps.md). The one check marked "gap" (M3) passes while that gap holds, so a fix shows as a failure.
 * Exits non-zero on any failure.
 */
import { createRuntime } from "../src/server/app";
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
console.log(`\nCovenant · agent market on the LOCAL PLATFORM STACK at ${rt.kit.platform.host}\n`);

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
const listing = await call("GET", "/market/directory?q=writer");
check(listing.status === 502, `gap M3: the stack's market serves no directory (${listing.status}); the page takes a handle instead`);

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

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}` : "\n✓ every check passed");
process.exit(failures.length ? 1 : 0);
