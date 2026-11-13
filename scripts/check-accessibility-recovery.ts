/** Local fixture checks: browser accessibility semantics and adverse-network recovery, not hosted wallet acceptance. */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server/app";
import type { Auth } from "../src/server/auth";
import { startServer } from "../src/server/index";
import { DEMO_TERMS, JOB_DEMO_TERMS } from "../src/shared/demo";
import { activate, signTerms, onboard, agentId, evidence } from "../tests/support/harness";

process.env.CI = "true"; // Freeze the browser bundle so edits cannot interrupt the fixture journey.
const observe = process.argv.includes("--observe");
const dir = mkdtempSync(join(process.env.PAPERWORK_DEMO_ARTIFACTS ?? tmpdir(), "paperwork-accessibility-"));
const session = `paperwork-a11y-${process.pid}`;
const ctx = await activate("300", JOB_DEMO_TERMS);
const created = ctx.rt.engine.createContract(DEMO_TERMS);
const merge = { ...ctx, id: created.id, token: created.contractorToken };
await signTerms(merge); await onboard(merge);
await ctx.rt.kit.controls!.fund(agentId(merge), "1000000000");
const accounts: Record<string, string> = { agency: "acme.demo", builder: "maria.demo", outsider: "outsider.demo" };
const auth = { handler: async (request: Request) => Response.json({ success: true }, request.url.endsWith("/sign-out") ? { headers: { "set-cookie": "a11y_fixture_actor=; Max-Age=0; Path=/" } } : {}),
  api: { getSession: async ({ headers }: { headers: Headers }) => {
    const role = /(?:^|;\s*)a11y_fixture_actor=([^;]*)/.exec(headers.get("cookie") ?? "")?.[1];
    return role && accounts[role] ? { user: { id: accounts[role] } } : null;
  } }, nearAccountFor: (id: string) => id } as unknown as Auth;
ctx.rt.config.auth.required = true;
ctx.rt.app = buildApp({ ...ctx.rt, auth });
const server = await startServer(ctx.rt, 0, "127.0.0.1"), base = server.url.origin;
const checks: { name: string; passed: boolean; detail?: unknown }[] = [];
const axe = readFileSync(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
function check(ok: unknown, name: string, detail?: unknown) {
  checks.push({ name, passed: !!ok, ...(detail !== undefined && { detail }) });
  writeFileSync(join(dir, "receipt.json"), JSON.stringify({ simulated: true, observe, checks, limitations: "Automated axe and Chromium accessibility-tree checks; no claim of a human VoiceOver/NVDA walkthrough or real wallet/provider acceptance. Zoom is CSS 200% layout/text scaling plus 320px reflow." }, null, 2));
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}
async function command(args: string[], input?: string) {
  const p = Bun.spawn(["agent-browser", "--session", session, "--json", ...args], { stdout: "pipe", stderr: "pipe", stdin: input === undefined ? "ignore" : "pipe" });
  if (input !== undefined) { (p.stdin as import("bun").FileSink).write(input); (p.stdin as import("bun").FileSink).end(); }
  const timer = setTimeout(() => p.kill(), 25_000);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code) throw Error(err || out);
    const result = JSON.parse(out); if (!result.success) throw Error(result.error); return result.data;
  } finally { clearTimeout(timer); }
}
const browser = (...args: string[]) => command(args);
async function evaluate<T = any>(script: string): Promise<T> { return (await command(["eval", "--stdin"], script)).result; }
async function waitFor(script: string) {
  for (const end = Date.now() + 12_000; Date.now() < end; await Bun.sleep(100)) if (await evaluate(script)) return;
  throw Error(`Timed out: ${script}`);
}
async function openActor(role: string, path: string) {
  await evaluate(`document.cookie='a11y_fixture_actor=${role}; Path=/; SameSite=Strict'`);
  await browser("open", `${base}/?fixture_actor=${role}&visit=${Date.now()}#${path}`);
  await waitFor("!!document.querySelector('h1')");
}
async function inspect(name: string) {
  await evaluate(axe);
  for (const theme of ["light", "dark"]) {
  await browser("set", "media", theme);
  const result = await evaluate(`axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}}).then(r=>({violations:r.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),incomplete:r.incomplete.map(v=>({id:v.id,nodes:v.nodes.length}))}))`);
  writeFileSync(join(dir, `${name}-${theme}-axe.json`), JSON.stringify(result, null, 2));
  writeFileSync(join(dir, `${name}-ax-tree.json`), JSON.stringify(await browser("snapshot"), null, 2));
  check(result.violations.length === 0, `${name} ${theme}: axe WCAG checks`, result.violations);
  await browser("screenshot", join(dir, `${name}-${theme}.png`), "--full");
  }
  check(await evaluate("!!document.querySelector('main')"), `${name}: main landmark`);
  await browser("focus", ".skip-link"); await browser("press", "Enter");
  check(await evaluate("document.activeElement?.id==='main'"), `${name}: keyboard skip link`);
}
async function clickName(name: string) { await evaluate(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(name)})?.scrollIntoView({block:'center'})`); await browser("find", "role", "button", "click", "--name", name, "--exact"); }
try {
  console.log(`Artifacts: ${dir}`);
  await browser("open", base);
  for (const job of [merge, ctx]) {
    const version = job === ctx ? "v3" : "v2";
    await openActor("agency", `/c/${job.id}`);
    await waitFor("!!document.querySelector('[role=tab]')");
    await inspect(`${version}-agency`);
    await browser("focus", "a[href=\"#/guide\"]");
    await browser("press", "Enter");
    await waitFor("document.querySelector('h1')?.textContent==='How it works'");
    check(await evaluate("document.activeElement===document.querySelector('main h1')"), `${version}: route navigation focuses heading`);
    await openActor("agency", `/c/${job.id}`);
    await waitFor("!!document.querySelector('[role=tab]')");
    const initial = await evaluate("document.querySelector('[role=tab][aria-selected=true]').textContent");
    await browser("focus", "[role=tab][aria-selected=true]");
    await browser("press", "ArrowRight");
    const right = await evaluate("document.querySelector('[role=tab][aria-selected=true]').textContent");
    check(right !== initial && await evaluate("document.activeElement?.getAttribute('aria-selected')==='true'"), `${version}: tabs follow arrow keys`);
    await browser("press", "End");
    check(await evaluate("document.activeElement===document.querySelector('[role=tab]:last-child')"), `${version}: End reaches last tab`);
    await browser("press", "Home");
    check(await evaluate("document.activeElement===document.querySelector('[role=tab]')"), `${version}: Home reaches first tab`);
    check(await evaluate("[...document.querySelectorAll('[role=tab]')].filter(e=>e.tabIndex===0).length===1"), `${version}: tablist has one tab stop`);
    await browser("find", "role", "tab", "click", "--name", "Scope", "--exact");
    check(await evaluate("[...document.querySelectorAll('[role=progressbar]')].every(e=>!!(e.getAttribute('aria-label')||e.getAttribute('aria-labelledby')))"), `${version}: progress has accessible names`);
    await browser("set", "viewport", "1440", "900");
    await evaluate("document.documentElement.style.zoom='2'");
    check(await evaluate("document.documentElement.scrollWidth<=innerWidth"), `${version}: 200% zoom reflows`);
    check(await evaluate("[...document.querySelectorAll('.stat-value')].every(e=>e.scrollWidth<=e.clientWidth)"), `${version}: zoom keeps payment figures readable`);
    await browser("screenshot", join(dir, `${version}-zoom-200.png`), "--full");
    await evaluate("document.documentElement.style.zoom='1'");
    await browser("set", "viewport", "320", "844");
    await browser("screenshot", join(dir, `${version}-mobile.png`), "--full");
    const small = await evaluate(`([...document.querySelectorAll('button,a.btn,[role=tab],summary')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.disabled&&(r.width<24||r.height<24)}).map(e=>({text:e.textContent.trim().slice(0,60),width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})))`);
    check(small.length === 0, `${version}: standalone touch targets at least 24px`, small);
    check(await evaluate("[...document.querySelectorAll('[role=tab]')].every(e=>e.scrollWidth<=e.clientWidth)"), `${version}: phone tab labels stay readable`);
    await browser("set", "viewport", "1440", "900");
    await openActor("builder", `/c/${job.id}/sign?t=${job.token}`);
    await inspect(`${version}-builder`);
  }
  for (const version of [2,3]) {
    await openActor("agency", "/new");
    await waitFor("!!document.querySelector('input[name=workflow]')");
    await browser("find", "label", "Company", "fill", `Keyboard offer v${version}`);
    if (version===2) { await browser("focus", "input[name=workflow]"); await browser("press", "ArrowRight"); }
    await inspect(`v${version}-offer`);
    await browser("focus", "input[value=\"Keyboard offer v"+version+"\"]");
    await browser("press", "Enter");
    await waitFor("location.hash.startsWith('#/c/')&&document.querySelector('h1')?.textContent==='Maria Lopez'");
    const id=await evaluate<string>("location.hash.split('/')[2]");
    const view=await ctx.rt.engine.viewContract(id);
    check(view.terms.v===version&&!view.signatures.contractor&&view.payouts.length===0, `v${version}: keyboard creates offer without acceptance or payment`);
  }
  await openActor("builder", `/c/${ctx.id}/sign?t=${ctx.token}`);
  await waitFor("!!document.querySelector('.job-builder textarea')");
  await browser("find", "label", "Work report", "fill", "Unfinished work report kept through a temporary outage.");
  await evaluate(`window.__originalFetch=window.fetch.bind(window);window.__failRead=false;window.__slowRead=false;window.__lostPost=false;window.__postBodies=[];window.fetch=async(...args)=>{
    const url=new URL(args[0] instanceof Request?args[0].url:args[0],location.href),method=args[1]?.method??'GET';
    if(url.pathname==='/api/contracts/${ctx.id}'&&method==='GET'){
      if(window.__failRead){window.__failRead=false;return Response.json({error:'Fixture temporary outage',code:'unavailable'},{status:503})}
      if(window.__slowRead){window.__slowRead=false;window.__readHeld=true;await new Promise(resolve=>window.__releaseRead=resolve)}
    }
    if(url.pathname==='/api/contracts/${ctx.id}/submissions'&&method==='POST'){
      window.__postBodies.push(JSON.parse(args[1].body));const res=await window.__originalFetch(...args);
      if(window.__lostPost&&res.ok){window.__lostPost=false;throw new TypeError('Fixture response lost after server acceptance')}return res;
    }return window.__originalFetch(...args)
  }`);
  await evaluate("window.__failRead=true");
  await clickName("Refresh status");
  await waitFor("document.body.innerText.includes('Fixture temporary outage')");
  check(await evaluate("document.querySelector('.job-builder textarea')?.value.includes('Unfinished work report')"), "explicit failed refresh preserves report draft");
  // Reload after a failed baseline read, so later scenarios still execute in --observe mode.
  if (!await evaluate("!!document.querySelector('.job-builder textarea')")) { await clickName("Retry loading job"); await waitFor("!!document.querySelector('.job-builder textarea')"); }
  await browser("find", "label", "Work report", "fill", "Unfinished work report kept through a slow connection.");
  await evaluate("window.__slowRead=true"); await clickName("Refresh status");
  await waitFor("window.__readHeld===true");
  check(await evaluate("document.querySelector('.job-builder textarea')?.value.includes('slow connection')"), "slow status read keeps form mounted");
  await evaluate("window.__releaseRead()");
  await waitFor("!document.querySelector('.job-builder button[aria-busy=true]')");
  await browser("find", "label", "d1 evidence URL", "fill", "https://evidence.invalid/accessibility-tests");
  await evaluate("window.__lostPost=true");
  await clickName("Submit report and invoice");
  await waitFor("document.body.innerText.includes('Fixture response lost')");
  const originalId = (await ctx.rt.engine.viewContract(ctx.id)).submissions[0]!.id;
  await browser("reload");
  await waitFor("document.body.innerText.includes('Retry saved submission')");
  await clickName("Retry saved submission");
  await waitFor("!document.body.innerText.includes('Retry saved submission')");
  const recovered = await ctx.rt.engine.viewContract(ctx.id);
  check(recovered.submissions.length === 1 && recovered.submissions[0]!.id === originalId && recovered.payouts.length === 0, "lost submission response retries the same identity once without a payout");
  await openActor("agency", `/c/${merge.id}`);
  await waitFor("document.body.innerText.includes('Check merges')");
  evidence(merge).mergeNext(DEMO_TERMS);
  await evaluate(`window.__mergeFetch=window.fetch.bind(window);window.__loseMerge=true;window.fetch=async(...args)=>{const res=await window.__mergeFetch(...args);if(window.__loseMerge&&(args[1]?.method==='POST')&&String(args[0]).endsWith('/run')&&res.ok){window.__loseMerge=false;throw new TypeError('Fixture merge response lost')}return res}`);
  await clickName("Check merges");
  await waitFor("document.body.innerText.includes('Fixture merge response lost')");
  const mergePayouts=(await ctx.rt.engine.viewContract(merge.id)).payouts.map(p=>p.request_id);
  const requestsBeforeRetry=ctx.stub.calls.requestPayout;
  await clickName("Check merges");
  check(JSON.stringify((await ctx.rt.engine.viewContract(merge.id)).payouts.map(p=>p.request_id))===JSON.stringify(mergePayouts)&&ctx.stub.calls.requestPayout===requestsBeforeRetry, "v2: lost merge result preserves original payout on retry");
  // Account changes must invalidate private state and reject the late previous-account read.
  for (const job of [merge,ctx]) {
    await openActor("agency", `/c/${job.id}`);
    await waitFor("!!document.querySelector('[role=tab]')");
    await evaluate(`window.__beforeSwitch=window.fetch.bind(window);window.__hold=true;window.fetch=async(...args)=>{const url=new URL(args[0] instanceof Request?args[0].url:args[0],location.href);const res=await window.__beforeSwitch(...args);if(window.__hold&&url.pathname==='/api/contracts/${job.id}'){window.__hold=false;window.__oldHeld=true;await new Promise(resolve=>window.__releaseOld=resolve)}return res};window.dispatchEvent(new Event('focus'))`);
    await waitFor("window.__oldHeld===true");
    await evaluate("document.cookie='a11y_fixture_actor=outsider; Path=/; SameSite=Strict';window.dispatchEvent(new StorageEvent('storage',{key:'paperwork.auth.changed'}));window.dispatchEvent(new Event('focus'))");
    await Bun.sleep(400);
    await evaluate("window.__releaseOld()");
    await Bun.sleep(300);
    check(await evaluate("!document.querySelector('[role=tab]')&&!document.body.innerText.includes('CSV export for monthly reports')"), `${job===ctx?'v3':'v2'}: account switch discards late private responses`);
    check(await evaluate("!document.title.includes('Maria')&&!document.title.includes('Acme')"), `${job===ctx?'v3':'v2'}: title retains no private party name`);
  }
  for (const job of [merge,ctx]) {
    if (job===ctx) await ctx.rt.engine.proposeJob(recovered.submissions[0]!.id);
    const payout = (await ctx.rt.engine.viewContract(job.id)).payouts.find(p=>p.kind==='payout'&&p.state==='held')!;
    if (!payout) throw Error("Fixture requires held payout");
    const request = await ctx.rt.engine.vote(payout.request_id,"approve");
    const signed = ctx.stub.sign(request.sign!);
    const requests = ctx.stub.calls.requestPayout;
    ctx.rt.clock.advance(16*60_000);
    await ctx.rt.engine.vote(payout.request_id,"approve");
    let refused=false;try { await ctx.rt.engine.submitOwnerStep(request.correlation_id,signed); } catch { refused=true; }
    check(refused&&ctx.stub.calls.requestPayout===requests&&ctx.stub.transfers.length===0, `${job===ctx?'v3':'v2'}: expired signature cannot pay or create a replacement payout`);
  }
  console.log(`Evidence: ${dir}`);
  const failed=checks.filter(c=>!c.passed);
  if(failed.length&&!observe)throw Error(`${failed.length} accessibility/recovery checks failed`);
} catch(error) {
  writeFileSync(join(dir,"failure.txt"),String(error));
  try{await browser("screenshot",join(dir,"failure.png"),"--full")}catch{}
  throw error;
} finally { try{await browser("close")}catch{} server.stop(true);await(await ctx.rt.auth.$context).checkSchema?.(); }
