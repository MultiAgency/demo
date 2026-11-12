/** Complete v2 payment browser journey. All identities, signatures, evidence and money are fixtures. */
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { startServer } from "../src/server/index";
import type { ContractView } from "../src/shared/views";
type Actor = "agency" | "builder";
const dir = mkdtempSync(join(process.env.PAPERWORK_DEMO_ARTIFACTS ?? tmpdir(), "paperwork-v2-browser-"));
const sessions: Record<Actor, string> = { agency: `paperwork-v2-agency-${process.pid}`, builder: `paperwork-v2-builder-${process.pid}` };
const opened = new Set<Actor>();
const steps: string[] = [], captures: string[] = [];
const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules", PORT: "0" }), { manualFakeSettlement: true });
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

async function tab(actor: Actor, label: string) {
  await command(actor, "scrollintoview", await reference(actor, "tab", label, true));
  await command(actor, "click", await reference(actor, "tab", label, true));
  await pause();
}
async function pay(amount: string, expectedPaid: string) {
  const held = (await state(v => v.payouts.some(p => p.state === "held" && p.amount_usd === amount), `held ${amount}`)).payouts.find(p => p.state === "held")!;
  const beforePaid = (await view()).paid_usd;
  await button("agency", `Approve $${Number(amount).toFixed(2)}`);
  const approved = await state(v => v.payouts.find(p => p.request_id === held.request_id)?.state === "processing", "explicit approval without settlement");
  check(approved.paid_usd === beforePaid, "Approval was counted as settlement");
  await button("agency", "Settle approved payouts");
  await state(v => v.payouts.find(p => p.request_id === held.request_id)?.state === "paid" && v.paid_usd === expectedPaid, `confirmed ${expectedPaid}`);
  return held.request_id;
}
console.log(`Paperwork v2 full payment browser · SIMULATED only
Artifacts: ${dir}`);
try {
  await open("agency", `${base}/#/new`);
  await pageWait("agency", "document.querySelectorAll('input[name=workflow]').length===2", "workflow choice");
  await command("agency", "click", await reference("agency", "radio", "Pay on merge", true));
  await pageWait("agency", "!document.body.innerText.includes('DAO owner (optional)')", "v2 workflow selected");
  await button("agency", "Create draft");
  await pageWait("agency", "location.hash.startsWith('#/c/')", "draft identity");
  contractId = (await evaluate<string>("agency", "location.hash")).split("/")[2]!;
  const offered = await view();
  check(offered.terms.v === 2 && offered.total_usd === "1000", "Expected full v2 merge scope");
  await button("agency", "Sign as acme.demo");
  await state(v => !!v.signatures.representative, "representative signature");
  await pageWait("agency", "!!document.querySelector('input[aria-label=\"Builder signing link\"]')", "original invitation");
  const invitation = await evaluate<string>("agency", "document.querySelector('input[aria-label=\"Builder signing link\"]').value");
  await open("builder", invitation);
  await button("builder", "Sign as maria.demo (demo wallet)");
  await state(v => !!v.signatures.contractor, "builder signature");
  step("Both parties sign the same v2 terms using separate fixture browser sessions");
  await command("agency", "reload");
  await pageWait("agency", "[...document.querySelectorAll('button')].some(b=>!b.disabled&&b.textContent.trim()==='Continue')", "agency observes builder acceptance");
  for (let i = 0; i < 30 && (await view()).stage !== "active"; i++)
    await actionOrDone("agency", "^(Continue|Sign [(]|Confirm|Fund)", async () => (await view()).stage === "active", "v2 setup");
  await state(v => v.stage === "active" && v.platform.balance_usd === "1000", "exact simulated funding");
  await button("agency", "Check merges");
  const initial = await state(v => v.payouts.some(p => p.state === "held"), "first judged payout");
  const judgment = initial.judgment as { prs: { key: string; eligible: boolean; deliverable: string | null; reason: string }[] };
  const self = judgment.prs.find(p => p.key.endsWith("#105"));
  check(self && !self.eligible, "Self-merged PR counted");
  const notScope = judgment.prs.find(p => p.key.endsWith("#103"));
  check(notScope && (!notScope.eligible || !notScope.deliverable), "Unrelated merged PR counted");
  await pageWait("agency", `document.querySelector('.out-of-scope')?.innerText.includes(${JSON.stringify(self.key)}) && document.querySelector('.out-of-scope')?.innerText.includes(${JSON.stringify(notScope.key)})`, "visible PR exclusions");
  await capture("agency", "01-ineligible-self-merged-excluded");
  step("Browser shows self-merged and unrelated PR exclusions before approval");
  await tab("agency", "Payouts");
  const requests: string[] = [];
  requests.push(await pay("500", "500"));
  requests.push(await pay("150", "650"));
  await button("agency", "Simulate a merge");
  await button("agency", "Check merges");
  requests.push(await pay("100", "750"));
  await button("agency", "Simulate a merge");
  await button("agency", "Check merges");
  const flagged = await state(v => v.payouts.some(p => p.state === "held" && p.prs.some(pr => pr.flags.length)), "flagged held work");
  const rejected = flagged.payouts.find(p => p.state === "held")!;
  const flag = rejected.prs.flatMap(pr => pr.flags)[0]!;
  await pageWait("agency", `document.body.innerText.includes(${JSON.stringify(flag)})`, "visible untrusted-instruction flag");
  await capture("agency", "02-flagged-work-before-rejection");
  await button("agency", "Reject");
  await state(v => v.payouts.find(p => p.request_id === rejected.request_id)?.state === "rejected" && v.paid_usd === "750" && v.committed_usd === "750", "proven rejection without payment");
  const afterRejection = await view();
  const count = afterRejection.payouts.length;
  const lastEvent = Math.max(0, ...afterRejection.events.map(event => event.id));
  await button("agency", "Check merges");
  await state(v => v.events.some(event => event.id > lastEvent && event.kind === "run"), "fresh repeated merge-check result");
  await pageWait("agency", "![...document.querySelectorAll('button')].some(b=>b.disabled&&b.textContent.includes('Check merges'))", "repeat judgment finished");
  const excluded = await view();
  check(excluded.payouts.length === count && excluded.paid_usd === "750" && excluded.open_judgment === null, "Rejected work created another obligation");
  step("Explicit rejection requires non-execution proof; repeated merge check does not repay rejected work");
  await button("agency", "Simulate a merge");
  await button("agency", "Check merges");
  requests.push(await pay("250", "1000"));
  const paid = await state(v => v.paid_usd === v.total_usd && v.open_judgment === null, "entire signed scope settled");
  const success = (await rt.kit.controls!.transfers()).filter(p => p.status === "SUCCESS");
  check(success.length === 4 && success.every(p => p.recipient === paid.terms.payee.address) && success.reduce((sum, p) => sum + BigInt(p.amount), 0n) === 1000000000n, "Wrong payment count, recipient or scope total");
  for (const actor of ["agency", "builder"] as const) {
    await open(actor, `${base}/?v2-reload=${actor}#/c/${contractId}`);
    await pageWait(actor, "document.body.innerText.includes('Paid for the scope') && document.body.innerText.includes('$1,000.00')", "confirmed full-scope view after reload");
    const observed = await evaluate<{ hash: string; paid_usd: string; payouts: { request_id: string; state: string }[] }>(actor, `fetch('/api/contracts/${contractId}').then(r=>r.json())`);
    check(observed.hash === offered.hash && observed.paid_usd === "1000" && requests.every(id => observed.payouts.some(p => p.request_id === id && p.state === "paid")), "Party reload changed original paid identities");
    for (const [w, h] of [[1440, 1000], [390, 844]]) {
      await command(actor, "set", "viewport", String(w), String(h));
      check(await evaluate<boolean>(actor, "document.documentElement.scrollWidth<=innerWidth"), "V2 payment view overflows viewport");
      await capture(actor, `03-${actor}-settled-${w}`);
    }
  }
  step("Both party browser views retain original paid identities at desktop/mobile after reload; $1,000 scope fully settled");
  writeFileSync(join(dir, "receipt.json"), JSON.stringify({ simulated: true, scope: "V2 complete GUI merge/payment journey; keyless fixture browsers, not hosted authentication", pins: JSON.parse(readFileSync(new URL('../vendor/multiagency-sdk/gateway-pin.json', import.meta.url), 'utf8')), gateway_contacted: false, browser_script_sha256: createHash('sha256').update(readFileSync(import.meta.path)).digest('hex'), job: contractId, terms_hash: paid.hash, payout_requests: requests, rejected_request: rejected.request_id, paid_usd: paid.paid_usd, successful_transfers: success.length, steps, captures }, null, 2));
  console.log(`PASS v2 payment browser; receipt ${join(dir, "receipt.json")}`);
} catch (error) {
  writeFileSync(join(dir, "failure.txt"), String(error));
  for (const actor of opened) { try { await capture(actor, `failure-${actor}`); writeFileSync(join(dir, `failure-${actor}.json`), JSON.stringify(await command(actor, "snapshot", "-i"))); } catch {} }
  throw error;
} finally { for (const actor of opened) { try { await command(actor, "close"); } catch {} } server.stop(true); }
