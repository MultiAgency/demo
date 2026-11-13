/** Offline UI inspection only. No wallet connector send, signature or provider transaction is invoked. */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activate } from "../tests/support/harness";
import { fundingKey, fundingRequest } from "../src/web/funding";
const root = join(import.meta.dir, "..");
mkdirSync(join(root, "data/release-evidence"), { recursive: true });
const dir = mkdtempSync(join(root, "data/release-evidence/funding-browser-"));
if (process.env.PAPERWORK_DEMO_ARTIFACTS) mkdirSync(process.env.PAPERWORK_DEMO_ARTIFACTS, { recursive: true });
const artifacts = process.env.PAPERWORK_DEMO_ARTIFACTS ? mkdtempSync(join(process.env.PAPERWORK_DEMO_ARTIFACTS, "paperwork-funding-")) : dir;
const ctx = await activate("0");
const c = await ctx.rt.engine.getContract(ctx.id);
c.platform.mode = "remote"; // Display-only fixture: no remote SDK or wallet call is made.
const config = await (await ctx.rt.app.request("/api/config")).json();
config.platform = "remote"; config.demo_controls = false; config.auth = { required: true, network: "mainnet", recipient: "fixture.near" };
const deposit = { address: "ab".repeat(32), memo: null, minAmount: "1000", expiresAt: new Date(Date.now() + 1200_000).toISOString() };
writeFileSync(join(dir, "fixture.json"), JSON.stringify({ c, config }));
writeFileSync(join(dir, "entry.tsx"), `import React from 'react'; import {createRoot} from ${JSON.stringify(join(root, "node_modules/react-dom/client"))};
import {SessionProvider} from ${JSON.stringify(join(root, "src/web/session.tsx"))};
import {JobFunding} from ${JSON.stringify(join(root, "src/web/components/JobFunding.tsx"))};
import ${JSON.stringify(join(root, "src/web/styles.css"))};
import fixture from './fixture.json';
createRoot(document.getElementById('root')).render(<SessionProvider config={fixture.config}><main className="page"><h1>Fund the agent</h1><JobFunding c={fixture.c} config={fixture.config} act={async fn=>{await fn();}}/></main></SessionProvider>);`);
const build = await Bun.build({ entrypoints: [join(dir, "entry.tsx")], outdir: dir, target: "browser", naming: "[name].[ext]" });
if (!build.success) throw Error(String(build.logs));
const session = `paperwork-funding-${process.pid}`;
let actor = c.terms.representative.near_account;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/api/me") return Response.json({ session: { accountId: actor } });
  if (path.endsWith("/deposit")) return Response.json(deposit);
  if (path === "/fixture-builder") { actor = c.terms.contractor.near_account; return Response.json({ ok: true }); }
  if (path === "/") return new Response('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/entry.css"></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>', { headers: { "Content-Type": "text/html", "Content-Security-Policy": "connect-src 'self'; frame-src 'none'" } });
  if (path === "/entry.js" || path === "/entry.css") return new Response(Bun.file(join(dir, path.slice(1))));
  return new Response("Not found", { status: 404 });
} });
async function command(...args: string[]) {
  const child = Bun.spawn(["agent-browser", "--session", session, "--json", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status) throw Error(`Browser command failed: ${err || out}`);
  const result = JSON.parse(out); if (!result.success) throw Error(result.error); return result.data;
}
const evaluate = async (expression: string) => (await command("eval", expression)).result;
function check(ok: unknown, label: string) { if (!ok) throw Error(label); }
try {
  await command("open", server.url.origin);
  await command("wait", "--text", "Review funding in wallet");
  for (let n = 0; n < 30 && !await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Review funding')&&!b.disabled)"); n++) await Bun.sleep(100);
  check(await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Review funding')&&!b.disabled)"), "Representative funding control should be enabled");
  check(await evaluate(`document.body.innerText.includes(${JSON.stringify(deposit.address)}) && document.body.innerText.includes('0.001 USDC') && document.body.innerText.includes('0.00125 NEAR')`), "Full address, exact minimum and storage cost must be visible");
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await command("set", "viewport", String(width), String(height));
    check(await evaluate("document.documentElement.scrollWidth<=innerWidth"), "Funding view must not overflow");
    await command("screenshot", join(artifacts, `funding-${width}.png`), "--full");
  }
  const q = fundingRequest(c, deposit);
  await evaluate(`localStorage.setItem(${JSON.stringify(fundingKey(q))},'offline unresolved attempt')`);
  await command("reload"); await command("wait", "--text", "A funding request may already have been sent");
  check(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Review funding')).disabled"), "Unresolved send must stay blocked after reload");
  await evaluate("fetch('/fixture-builder')"); await command("reload"); await command("wait", "--text", "Sign in and connect");
  check(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Review funding')).disabled"), "Builder cannot fund as representative");
  writeFileSync(join(artifacts, "receipt.json"), JSON.stringify({ passed: true, simulated: true, wallet_opened: false, scope: "Funding UI desktop/mobile, exact minimum/cost/address, persisted unknown-outcome refusal and wrong-account refusal", captures: ["funding-1440.png", "funding-390.png"] }, null, 2));
  console.log(`PASS offline funding UI; no wallet opened. Receipt ${join(artifacts, "receipt.json")}`);
} finally { try { await command("close"); } finally { server.stop(true); } }
