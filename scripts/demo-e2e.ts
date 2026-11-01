/**
 * bun run demo:e2e
 *
 * Runs the whole Covenant flow headlessly against the simulator: both parties sign, the contract
 * wallet is created and funded, the agent pays on its own, the contractor verifies, and a
 * "compromised server" tries four bad payouts. No keys, no network. Exits 0 only if every step passes.
 */
import { createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { startServer } from "../src/server/index";
import { DEMO_TERMS } from "../src/shared/demo";

const CLOCK_START = Date.parse("2026-11-20T12:00:00Z");
const rt = await createRuntime(loadConfig({ PROVIDER: "sim", GITHUB: "fake" }), { clockStart: CLOCK_START });
const server = await startServer(rt, 0);
const base = `${server.url}api`;

let step = 0;
const failures: string[] = [];

function log(title: string, detail = "") {
  step += 1;
  console.log(`\n${String(step).padStart(2, "0")}. ${title}${detail ? `\n    ${detail.split("\n").join("\n    ")}` : ""}`);
}
function check(ok: boolean, label: string) {
  console.log(`    ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures.push(label);
}
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json.error}`);
  return json as T;
}
async function sign(account_id: string, req: { message: string; nonce: string; recipient: string }) {
  return api("POST", "/sim/sign", { account_id, ...req });
}
async function ownerAction(id: string, type: string, extra: Record<string, unknown> = {}) {
  const prepared = await api("POST", `/contracts/${id}/intents`, { type, ...extra });
  const signed = await sign(prepared.signer, prepared);
  return api("POST", `/intents/${prepared.correlation_id}/submit`, { public_key: signed.public_key, signature: signed.signature });
}

try {
  console.log("Covenant · keyless end-to-end demo (SIMULATED: no real funds, no network)");
  const cfg = await api("GET", "/config");
  console.log(`Simulated clock: ${cfg.now} · timelock ${cfg.timelock_ms / 60000} min`);

  // 1. Draft
  const created = await api("POST", "/contracts", DEMO_TERMS);
  const id = created.id;
  log("Draft the work order", `${DEMO_TERMS.company} pays ${DEMO_TERMS.contractor.name} $${DEMO_TERMS.rate_per_accepted_pr_usd} per accepted PR, capped at $${DEMO_TERMS.monthly_cap_usd}/month, until ${DEMO_TERMS.end}.`);
  let c = await api("GET", `/contracts/${id}`);
  check(c.stage === "needs_signatures", `contract ${id} is a draft, terms hash ${c.hash.slice(0, 16)}…`);

  // 2-3. Both parties sign the terms hash (NEP-413)
  for (const role of ["representative", "contractor"] as const) {
    const req = await api("GET", `/contracts/${id}/signing-request?role=${role}`);
    const signed = await sign(req.account_id, req);
    c = await api("POST", `/contracts/${id}/signatures`, { role, signed, contractor_token: created.contractor_token });
    log(`${role === "representative" ? "Representative" : "Contractor"} signs`, `${req.account_id} signs "${req.message.slice(0, 48)}…"`);
    check(!!c.signatures[role], "signature verified against a full-access key");
  }

  // 4. Contract wallet
  log("Create the contract wallet", "The representative's wallet signs agent_create with the compiled policy.");
  c = await ownerAction(id, "agent_create");
  check(!!c.agent?.agent_id, `agent ${c.agent?.agent_id} created`);
  console.log(`    policy: only ${c.compiled.policy.destinations.list[0].address}, per-tx & monthly limit ${Number(c.compiled.policy.limits.monthly[DEMO_TERMS.asset]) / 1e6} USDC, timelock ${c.compiled.policy.timelock_ms / 60000} min`);

  // 5. Grant
  log("Issue the agent's permission", "The grant expires exactly at the contract end.");
  c = await ownerAction(id, "grant_issue");
  check(c.grant?.expires_at === c.compiled.grant.expires_at, `grant expires ${c.grant?.expires_at}`);

  // 6. Fund
  log("Fund the wallet", "Simulated deposit of $60 USDC.");
  await api("POST", "/sim/fund", { agent_id: c.agent.agent_id, usd: "60" });
  c = await api("GET", `/contracts/${id}`);
  check(c.stage === "active" && c.agent.available_usd === "60", `balance $${c.agent.available_usd}`);

  // 7. Contractor verifies
  let v = await api("GET", `/contracts/${id}/verify`);
  log("Contractor verifies the contract wallet");
  for (const ch of v.checks) console.log(`    ${ch.ok ? "✓" : "✗"} ${ch.label}`);
  check(v.overall === "green", "live policy == compile(signed terms), grant expiry == contract end");

  // 8. Agent run
  const run = await api("POST", `/contracts/${id}/run`);
  log("The agent runs on its own", run.score.prs.map((p: any) => `${p.accepted ? "✓ accept" : "✗ reject"}  ${p.key} ${p.title} — ${p.reason}`).join("\n"));
  check(run.payout?.status === "queued" && run.amount_usd === "40", `decided to pay $${run.amount_usd}; queued until ${run.payout?.dispatch_at}`);

  // 9. Timelock passes
  await api("POST", "/sim/advance", { ms: cfg.timelock_ms + 1000 });
  c = await api("GET", `/contracts/${id}`);
  const paid = c.payouts[0];
  log("Timelock passes, nobody cancels", `tx ${paid.tx_hash}`);
  check(paid.status === "paid" && String(paid.tx_hash).startsWith("SIMULATED-"), "paid (simulated tx hash)");

  // 10. Compromised server
  log("Compromised server: app checks off, requests go straight to the provider");
  for (const scenario of ["overpay", "redirect", "injected"] as const) {
    const r = await api("POST", `/contracts/${id}/attacks/${scenario}?mode=dry`);
    const f = r.findings.map((x: any) => `${x.code} (${x.layer}) → ${x.clause.title}`).join(", ");
    console.log(`    ${r.outcome !== "allowed" ? "✓" : "✗"} ${scenario}: ${r.story}\n        ${f || "NO REFUSAL"}`);
    if (r.outcome === "allowed") failures.push(`attack ${scenario} was not stopped`);
  }
  const live = await api("POST", `/contracts/${id}/attacks/overpay?mode=live`);
  check(live.outcome === "refused", `non-dry overpay is refused outright: ${live.findings[0]?.code}`);

  // 11. After the end date
  await api("POST", "/sim/advance", { to: "2026-12-01T09:00:00.000Z" });
  const ended = await api("POST", `/contracts/${id}/attacks/after_end?mode=live`);
  log("After the contract ends", ended.story);
  check(ended.outcome === "refused" && ended.findings[0]?.layer === "grant", `refused at the grant layer: ${ended.findings[0]?.code} → ${ended.findings[0]?.clause.title}`);

  console.log(failures.length ? `\n✗ ${failures.length} step(s) failed:\n  - ${failures.join("\n  - ")}` : "\n✓ All steps passed. The contract was the spending limit.");
} catch (err) {
  failures.push(String(err));
  console.error(`\n✗ ${err}`);
} finally {
  server.stop(true);
  process.exit(failures.length ? 1 : 0);
}
