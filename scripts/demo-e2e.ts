/**
 * bun run demo:e2e
 *
 * Runs the whole Covenant flow headlessly against the simulator. Both parties sign a scope of
 * deliverables, the contract wallet is created and funded with the scope total, and every merged PR
 * is judged against the scope: the agent pays value × completion per deliverable, escalates a
 * prompt-injected PR, and pays the rest as work lands. Then a "compromised server" tries four bad
 * payouts. No keys, no network. Exits 0 only if every step passes.
 */
import { createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { startServer } from "../src/server/index";
import { DEMO_TERMS } from "../src/shared/demo";

const CLOCK_START = Date.parse("2026-11-20T12:00:00Z");
const rt = await createRuntime(loadConfig({ PROVIDER: "sim", GITHUB: "fake", JUDGE: "rules" }), { clockStart: CLOCK_START });
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
const sign = (account_id: string, req: { message: string; nonce: string; recipient: string }) => api("POST", "/sim/sign", { account_id, ...req });
async function ownerAction(id: string, type: string, extra: Record<string, unknown> = {}) {
  const prepared = await api("POST", `/contracts/${id}/intents`, { type, ...extra });
  const signed = await sign(prepared.signer, prepared);
  return api("POST", `/intents/${prepared.correlation_id}/submit`, { public_key: signed.public_key, signature: signed.signature });
}
const pays = (run: any) => run.payouts.map((p: any) => `${p.deliverable.id} $${p.amount_usd}`).join(", ") || "nothing";
const skipTimelock = (ms: number) => api("POST", "/sim/advance", { ms: ms + 1000 });

try {
  console.log("Covenant · keyless end-to-end demo (SIMULATED: no real funds, no network)");
  const cfg = await api("GET", "/config");
  console.log(`Simulated clock: ${cfg.now} · cancel window ${cfg.timelock_ms / 60000} min · judge: ${cfg.judge.kind}`);

  // 1. Draft the scope
  const created = await api("POST", "/contracts", DEMO_TERMS);
  const id = created.id;
  log(
    "Draft the work order: a signed scope of deliverables",
    DEMO_TERMS.scope.map((d) => `${d.id}  $${d.value_usd.padStart(4)}  ${d.title}`).join("\n"),
  );
  let c = await api("GET", `/contracts/${id}`);
  check(c.stage === "needs_signatures" && c.total_usd === "1000", `scope total $${c.total_usd}, terms hash ${c.hash.slice(0, 16)}…`);

  // 2-3. Both parties sign the terms hash (NEP-413)
  for (const role of ["representative", "contractor"] as const) {
    const req = await api("GET", `/contracts/${id}/signing-request?role=${role}`);
    c = await api("POST", `/contracts/${id}/signatures`, { role, signed: await sign(req.account_id, req), contractor_token: created.contractor_token });
    log(`${role === "representative" ? "Representative" : "Contractor"} signs`, `${req.account_id} signs "${req.message.slice(0, 48)}…"`);
    check(!!c.signatures[role], "signature verified against a full-access key");
  }

  // 4-6. Wallet, grant, funding
  c = await ownerAction(id, "agent_create");
  const pol = c.compiled.policy;
  log("Create the contract wallet", `only ${pol.destinations.list[0].address}; one payment ≤ $${Number(pol.limits.per_transaction[DEMO_TERMS.asset]) / 1e6} (largest deliverable); ${pol.timelock_ms / 60000}-min cancel window`);
  check(!!c.agent?.agent_id, `agent ${c.agent?.agent_id} created with the compiled policy`);
  c = await ownerAction(id, "grant_issue");
  log("Issue the agent's permission");
  check(c.grant?.expires_at === c.compiled.grant.expires_at, `expires ${c.grant?.expires_at} (the contract end)`);
  await api("POST", "/sim/fund", { agent_id: c.agent.agent_id, usd: c.total_usd });
  c = await api("GET", `/contracts/${id}`);
  log("Fund the wallet with the scope total");
  check(c.stage === "active" && c.agent.available_usd === "1000", `balance $${c.agent.available_usd}`);

  // 7. Verify
  const v = await api("GET", `/contracts/${id}/verify`);
  log("Contractor verifies the contract wallet");
  check(v.overall === "green", "live policy == compile(signed terms); permission expires at the contract end");

  // 8. First run: judge the merges so far
  let run = await api("POST", `/contracts/${id}/run`);
  log(
    "The agent judges merged PRs against the scope",
    [
      ...run.judgment.prs.map((p: any) => `${p.eligible && p.deliverable ? "→ " + p.deliverable : "✗   "}  ${p.key} ${p.title}${p.eligible && p.deliverable ? "" : ` — ${p.reason}`}`),
      ...run.judgment.deliverables.map((d: any) => `${d.id} completion ${d.completion * 100}%`),
    ].join("\n"),
  );
  check(pays(run) === "d1 $300, d2 $100, d3 $250", `pays ${pays(run)} (value × completion), each its own payment, in the cancel window`);
  await skipTimelock(cfg.timelock_ms);
  c = await api("GET", `/contracts/${id}`);
  check(c.paid_usd === "650", `paid $${c.paid_usd} of $${c.total_usd}`);

  // 9. A merge finishes d2
  let merged = (await api("POST", "/sim/merge", { contract_id: id })).merged;
  run = await api("POST", `/contracts/${id}/run`);
  log("A new PR is merged", `${merged.title} (#${merged.number})`);
  check(pays(run) === "d2 $100", `pays only the difference: ${pays(run)}`);
  await skipTimelock(cfg.timelock_ms);

  // 10. A prompt-injected merge
  merged = (await api("POST", "/sim/merge", { contract_id: id })).merged;
  run = await api("POST", `/contracts/${id}/run`);
  log("A merged PR hides instructions for the AI reviewer", `${merged.title} (#${merged.number})`);
  check(run.judgment.decision === "escalate" && run.payouts[0]?.status === "escalated", `escalated instead of paid: ${pays(run)} waits for the representative`);
  await api("POST", `/payouts/${run.payouts[0].id}/reject`);
  run = await api("POST", `/contracts/${id}/run`);
  check(run.payouts.length === 0 && run.judgment.decision === "pay", "rejected; that PR no longer counts or escalates");

  // 11. The real completion of d3
  merged = (await api("POST", "/sim/merge", { contract_id: id })).merged;
  run = await api("POST", `/contracts/${id}/run`);
  log("The PR that actually finishes rate limiting is merged", `${merged.title} (#${merged.number})`);
  check(pays(run) === "d3 $250", `pays ${pays(run)}`);
  await skipTimelock(cfg.timelock_ms);
  c = await api("GET", `/contracts/${id}`);
  check(c.paid_usd === "1000", `scope fully paid: $${c.paid_usd} of $${c.total_usd}`);

  // 12. Compromised server
  log("Compromised server: app checks off, requests go straight to the provider");
  for (const scenario of ["overpay", "redirect", "injected"] as const) {
    const r = await api("POST", `/contracts/${id}/attacks/${scenario}?mode=dry`);
    const f = r.findings.map((x: any) => `${x.code} (${x.layer}) → ${x.clause.title}`).join(", ");
    console.log(`    ${r.outcome !== "allowed" ? "✓" : "✗"} ${scenario}: ${r.story}\n        ${f || "NO REFUSAL"}`);
    if (r.outcome === "allowed") failures.push(`attack ${scenario} was not stopped`);
  }

  // 13. After the end date
  await api("POST", "/sim/advance", { to: "2026-12-01T09:00:00.000Z" });
  const ended = await api("POST", `/contracts/${id}/attacks/after_end?mode=live`);
  log("After the contract ends", ended.story);
  check(ended.outcome === "refused" && ended.findings[0]?.layer === "grant", `refused at the grant layer: ${ended.findings[0]?.code} → ${ended.findings[0]?.clause.title}`);

  console.log(failures.length ? `\n✗ ${failures.length} step(s) failed:\n  - ${failures.join("\n  - ")}` : "\n✓ All steps passed. Paid for the scope, never more.");
} catch (err) {
  failures.push(String(err));
  console.error(`\n✗ ${err}`);
} finally {
  server.stop(true);
  process.exit(failures.length ? 1 : 0);
}
