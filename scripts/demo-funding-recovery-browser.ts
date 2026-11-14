/** Isolated recovery review UI. All evidence/accounts are fixtures; no wallet, allocation or payment is opened. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { activate } from "../tests/support/harness";
import type { Deps } from "../src/server/engine";
import type { FundingReconciliation } from "../src/shared/funding-recovery";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { USDC_NEAR } from "../src/shared/terms";
import { fundingKey, fundingRecoveryRequest } from "../src/web/funding";
import { browserDriver, check } from "./browser-driver";

const root = join(import.meta.dir, "..");
mkdirSync(join(root, "data/release-evidence"), { recursive: true });
const directory = mkdtempSync(join(root, "data/release-evidence/funding-recovery-browser-"));
const artifacts = process.env.PAPERWORK_DEMO_ARTIFACTS ? mkdtempSync(join(process.env.PAPERWORK_DEMO_ARTIFACTS, "funding-recovery-")) : directory;
const ctx = await activate("0.01", { ...JOB_DEMO_TERMS, scope: [{ ...JOB_DEMO_TERMS.scope[0]!, value_usd: "1" }] });
const deps = (ctx.rt.engine as unknown as { d: Deps }).d;
const now = ctx.rt.clock.now().getTime();
deps.platform.fundingRecovery = async binding => ({ ...binding, schema_version: 1, reconciliation_id: "fixture-reviewed-recovery", asset: USDC_NEAR, chain: "near", network: "mainnet",
  observed_at: new Date(now).toISOString(), expires_at: new Date(now + 120_000).toISOString(), original_allocation: { state: "resolved", resolution: "provider_recovery_procedure", evidence_reference: "fixture-provider-resolution" },
  route_ready: true, credited_atomic: "10000", available_atomic: "10000", expected_credit_atomic: "990000", fee_atomic: "1000", transfer_atomic: "991000", destination: {
    address: "ab".repeat(32), allocation_request_id: "fixture-original-request", correlation_id: "fixture-original-operation", can_receive_this_transfer: true,
    minimum_atomic: "1000", expires_at: new Date(now + 600_000).toISOString(), memo: null,
  } } satisfies FundingReconciliation);
const reviewed = await ctx.rt.engine.fundingRecovery(ctx.id);
check(reviewed.state === "ready", "Fixture reconciliation must verify");
const c = await ctx.rt.engine.viewContract(ctx.id); c.platform.mode = "remote";
const config = await (await ctx.rt.app.request("/api/config")).json();
config.platform = "remote"; config.demo_controls = false; config.auth = { required: true, network: "mainnet", recipient: "fixture.near" };
writeFileSync(join(directory, "fixture.json"), JSON.stringify({ c, config }));
writeFileSync(join(directory, "entry.tsx"), `import React from 'react';import {createRoot} from ${JSON.stringify(join(root, "node_modules/react-dom/client"))};
import {SessionProvider} from ${JSON.stringify(join(root, "src/web/session.tsx"))};import {FundingRecovery} from ${JSON.stringify(join(root, "src/web/components/FundingRecovery.tsx"))};
import ${JSON.stringify(join(root, "src/web/styles.css"))};import fixture from './fixture.json';
createRoot(document.getElementById('root')).render(<SessionProvider config={fixture.config}><main className="page"><h1>Recover job funding</h1><FundingRecovery c={fixture.c}/></main></SessionProvider>);`);
const built = await Bun.build({ entrypoints: [join(directory, "entry.tsx")], outdir: directory, target: "browser", naming: "[name].[ext]" });
check(built.success, String(built.logs));
let actor = c.terms.representative.near_account, mode = "ready", recoveryReads = 0, mutationCalls = 0;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
  const path = new URL(request.url).pathname;
  if (request.method !== "GET") { mutationCalls++; return Response.json({ error: "No mutations in UI fixture" }, { status: 403 }); }
  if (path === "/api/me") return Response.json({ session: { accountId: actor } });
  if (path.endsWith("/funding-recovery")) {
    recoveryReads++;
    if (actor !== c.terms.representative.near_account) return Response.json({ error: "Representative only" }, { status: 403 });
    if (mode === "blocked") return Response.json({ schema_version: 1, state: "blocked", code: "reconciliation_unavailable", message: "Original allocation remains unresolved.", plan: null });
    if (mode === "expired" && reviewed.state === "ready") return Response.json({ ...reviewed, plan: { ...reviewed.plan, expires_at: new Date(now - 1).toISOString() } });
    return Response.json(reviewed);
  }
  if (path === "/fixture-builder") { actor = c.terms.contractor.near_account; return Response.json({ ok: true }); }
  if (path === "/fixture-blocked") { mode = "blocked"; return Response.json({ ok: true }); }
  if (path === "/fixture-expired") { mode = "expired"; return Response.json({ ok: true }); }
  if (path === "/axe.js") return new Response(readFileSync(join(root, "node_modules/axe-core/axe.min.js")), { headers: { "Content-Type": "application/javascript" } });
  if (path === "/") return new Response(`<!doctype html><html lang="en"><head><title>Recovery fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/entry.css"></head><body><div id="root"></div><script>Date.now=()=>${now}</script><script type="module" src="/entry.js"></script></body></html>`, { headers: { "Content-Type": "text/html", "Content-Security-Policy": "connect-src 'self'; frame-src 'none'" } });
  if (path === "/entry.js" || path === "/entry.css") return new Response(Bun.file(join(directory, path.slice(1))));
  return new Response("Not found", { status: 404 });
} });
const driver = browserDriver({ owner: `paperwork-funding-recovery-${process.pid}` }, artifacts);
const evaluate = <T>(js: string) => driver.evaluate<T>("owner", js);
const buttonDisabled = "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Review recovered funding')).disabled";
async function openReview() {
  await driver.pageWait("owner", "!!document.querySelector('summary')", "recovery disclosure");
  await evaluate("document.querySelector('summary').focus()");
  await driver.command("owner", "press", "Enter");
}
try {
  await driver.open("owner", server.url.origin);
  check(recoveryReads === 0, "Collapsed review must not allocate or read recovery");
  await openReview();
  await driver.pageWait("owner", "!!document.querySelector('input[type=checkbox]')", "verified recovery review");
  check(await evaluate<boolean>(buttonDisabled), "Wallet review requires explicit acknowledgement");
  const text = await driver.text("owner");
  for (const value of ["0.01 USDC", "0.99 USDC", "0.001 USDC", "0.991 USDC", "991000", "ab".repeat(32)]) check(text.includes(value), `Review must display ${value}`);
  await driver.activate("owner", "checkbox", "I reviewed the existing credit, exact transfer, provider fee and destination.");
  check(!await evaluate<boolean>(buttonDisabled), "Valid acknowledged review enables wallet review");
  for (const [width, height, scheme] of [[1440, 1000, "light"], [390, 844, "dark"]] as const) {
    await driver.command("owner", "set", "viewport", String(width), String(height));
    await driver.command("owner", "set", "media", scheme);
    check(await evaluate<boolean>("document.documentElement.scrollWidth<=innerWidth"), "Recovery review must reflow without overflow");
    await evaluate(`new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='/axe.js';s.onload=resolve;s.onerror=reject;document.head.appendChild(s)})`);
    const violations = await evaluate<unknown[]>("(async()=>{const r=await axe.run({runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}});return r.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))})()");
    check(violations.length === 0, `Recovery axe violations: ${JSON.stringify(violations)}`);
    await driver.capture("owner", `recovery-${width}-${scheme}`);
  }
  const q = fundingRecoveryRequest(c, reviewed, now);
  await evaluate(`localStorage.setItem(${JSON.stringify(fundingKey(q))},'fixture original uncertain wallet request')`);
  await driver.command("owner", "reload"); await openReview();
  await driver.pageWait("owner", "document.body.innerText.includes('A wallet request may already')", "persistent funding marker");
  check(await evaluate<boolean>(buttonDisabled), "Existing marker must block recovery without resetting it");
  await evaluate("fetch('/fixture-blocked')"); await driver.command("owner", "reload"); await openReview();
  await driver.pageWait("owner", "document.body.innerText.includes('Original allocation remains unresolved')", "blocked provider review");
  check(await evaluate<boolean>(buttonDisabled), "Unresolved provider outcome cannot enable wallet review");
  await evaluate("fetch('/fixture-expired')"); await driver.command("owner", "reload"); await openReview();
  await driver.pageWait("owner", "document.body.innerText.includes('changed or expired')", "expired reconciliation");
  check(await evaluate<boolean>(buttonDisabled), "Expired or changed plan cannot enable wallet review");
  await evaluate("fetch('/fixture-builder')"); await driver.command("owner", "reload"); await openReview();
  await driver.pageWait("owner", "document.body.innerText.includes('Sign in with the named agency')", "account switch");
  check(await evaluate<boolean>(buttonDisabled), "Builder cannot review recovery as agency");
  check(!await evaluate<boolean>(`document.body.innerText.includes(${JSON.stringify(q.address)})`), "Account switch must clear destination evidence");
  check(mutationCalls === 0, "Browser review must never allocate, prepare or open a wallet");
  writeFileSync(join(artifacts, "receipt.json"), JSON.stringify({ passed: true, simulated: true, wallet_opened: false, mutation_calls: mutationCalls,
    checks: ["keyboard disclosure", "exact credit/remainder/fee/amount", "explicit acknowledgement", "desktop light and phone dark reflow", "axe WCAG", "persisted marker", "unresolved and expired evidence", "account switch"], captures: driver.captures }, null, 2));
  console.log(`PASS offline funding recovery UI: ${join(artifacts, "receipt.json")}`);
} finally { await driver.close(); server.stop(true); await ctx.rt.close(); }
