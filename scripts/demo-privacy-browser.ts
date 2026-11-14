/** Loopback-only privacy browser matrix. Fixture sessions are NOT hosted wallet authentication. */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server/app";
import type { Auth } from "../src/server/auth";
import { startServer } from "../src/server/index";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { setup, signTerms } from "../tests/support/harness";

const dir = mkdtempSync(join(process.env.PAPERWORK_DEMO_ARTIFACTS ?? tmpdir(), "paperwork-privacy-browser-"));
const session = `paperwork-privacy-${process.pid}`;
const digest = (file: URL) => createHash("sha256").update(readFileSync(file)).digest("hex");
const sdkArtifact = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies["@multiagency/sdk"] as string;
if (!sdkArtifact.startsWith("./vendor/multiagency-sdk/") || sdkArtifact.includes("..")) throw Error("Expected a repository-local SDK artifact");
const pins = () => ({ sdk_sha256: digest(new URL(`../${sdkArtifact}`, import.meta.url)), gateway: JSON.parse(readFileSync(new URL("../vendor/multiagency-sdk/gateway-pin.json", import.meta.url), "utf8")), lockfile_sha256: digest(new URL("../bun.lock", import.meta.url)), browser_script_sha256: digest(new URL(import.meta.url)) });
const initialPins = pins();
if (initialPins.sdk_sha256 !== initialPins.gateway.sdkTarballSha256) throw Error("SDK/gateway pin mismatch");
const ctx = await setup();
const db = ctx.rt.db;
const jobs: { id: string; version: number; existing: boolean; token: string }[] = [];
for (const version of [2, 3]) for (const existing of [false, true]) {
  const created = version === 2 && !existing ? { id: ctx.id, contractorToken: ctx.token } : ctx.rt.engine.createContract({ ...(version === 3 ? JOB_DEMO_TERMS : (await ctx.rt.engine.viewContract(ctx.id)).terms), company: `Privacy fixture v${version} ${existing ? "existing" : "new"}` });
  if (existing) {
    // A historical recipient is fixture-seeded before signing, never rewritten by the app.
    if (version === 2) db.query("UPDATE contracts SET signing_recipient = 'covenant' WHERE id = ?").run(created.id);
    await signTerms({ ...ctx, id: created.id, token: created.contractorToken });
  }
  jobs.push({ id: created.id, version, existing, token: created.contractorToken });
}
const snapshot = () => db.query("SELECT id, hash, signing_recipient, rep_sig, contractor_sig, contractor_link_hash FROM contracts ORDER BY id").all();
const before = JSON.stringify(snapshot());
const accounts: Record<string, string> = { agency: "acme.demo", builder: "maria.demo", unrelated: "attacker.demo" };
const auth = {
  handler: async (request: Request) => Response.json({ success: true }, request.url.endsWith("/sign-out") ? { headers: { "set-cookie": "privacy_fixture_actor=; Max-Age=0; Path=/" } } : {}),
  api: { getSession: async ({ headers }: { headers: Headers }) => {
    const key = /(?:^|;\s*)privacy_fixture_actor=([^;]*)/.exec(headers.get("cookie") ?? "")?.[1];
    return key && accounts[key] ? { user: { id: accounts[key] } } : null;
  } },
  nearAccountFor: (id: string) => id,
} as unknown as Auth;
ctx.rt.config.auth.required = true;
ctx.rt.app = buildApp({ ...ctx.rt, auth });
const server = await startServer(ctx.rt, 0, "127.0.0.1");
const base = server.url.origin;
const steps: string[] = [];
function check(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
async function command(...args: string[]) {
  const child = Bun.spawn(["agent-browser", "--session", session, "--json", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 20000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    check(code === 0, `Browser ${args[0]} failed: ${stderr || stdout}`);
    const result = JSON.parse(stdout); check(result.success, result.error); return result.data;
  } finally { clearTimeout(timer); }
}
async function evaluate<T>(expression: string): Promise<T> { return (await command("eval", expression)).result; }
async function wait(expression: string) {
  for (const end = Date.now() + 10000; Date.now() < end; await Bun.sleep(150)) if (await evaluate<boolean>(expression)) return;
  throw Error(`Browser condition timed out: ${expression}`);
}
async function actor(name: string, url: string) {
  await evaluate(`document.cookie='privacy_fixture_actor=${name}; Path=/; SameSite=Strict'`);
  await command("open", `${base}/?matrix=${Date.now()}${url}`);
}
try {
  await command("open", base);
  for (const job of jobs) {
    for (const name of ["anonymous", "unrelated", "builder", "agency"]) {
      await actor(name, `#/c/${job.id}${name === "builder" ? `/sign?t=${job.token}` : ""}`);
      const allowed = name === "agency" || name === "builder";
      const expected = allowed ? 200 : name === "anonymous" ? 401 : 403;
      const result = await evaluate<{ status: number; body: string; cache: string }>(`fetch('/api/contracts/${job.id}').then(async r=>({status:r.status,body:await r.text(),cache:r.headers.get('cache-control')}))`);
      check(result.status === expected && result.cache === "no-store", `v${job.version} ${name} private read/cache mismatch: ${result.status}, ${result.cache}`);
      if (allowed) {
        await wait(name === "builder" ? "document.body.innerText.includes('Deliverables')" : `document.body.innerText.includes(${JSON.stringify(JSON.parse(result.body).terms.company)})`);
        if (name === "builder") { const v = JSON.parse(result.body); check(v.next_step === null && v.platform.deposit === null && v.platform.consents === null, "Builder received owner fields"); }
        const own = name === "agency" ? "representative" : "contractor", other = name === "agency" ? "contractor" : "representative";
        check(await evaluate<number>(`fetch('/api/contracts/${job.id}/signing-request?role=${own}').then(r=>r.status)`) === 200, "Own signing request refused");
        check(await evaluate<number>(`fetch('/api/contracts/${job.id}/signing-request?role=${other}').then(r=>r.status)`) === 403, "Other-role signing request allowed");
      } else {
        await wait(name === "anonymous" ? "document.body.innerText.includes('Sign in with NEAR')" : "document.body.innerText.includes('Only the agency or builder')");
        check(!await evaluate<boolean>("document.body.innerText.includes('CSV export')"), "Unauthorized UI showed private scope");
      }
    }
    await actor("anonymous", `#/c/${job.id}/verify`);
    await wait("document.querySelector('h1')?.textContent==='Verification status'");
    check(!await evaluate<boolean>(`performance.getEntriesByType('resource').some(r=>new URL(r.name).pathname==='/api/contracts/${job.id}')`), "Public Verify fetched full job");
    for (const [width, height] of [[390, 844], [1440, 1000]]) {
      await command("set", "viewport", String(width), String(height));
      check(await evaluate<boolean>("document.documentElement.scrollWidth<=innerWidth"), "Public Verify overflow");
      await command("screenshot", join(dir, `v${job.version}-${job.existing ? "existing" : "new"}-${width}.png`), "--full");
    }
    steps.push(`v${job.version} ${job.existing ? "existing signed" : "new unsigned"}: anonymous/unrelated refusals, party reads, own-role signing and public-only desktop/mobile Verify`);
    console.log(`PASS ${steps.at(-1)}`);
  }
  // Switch from a party to a refused account in the same private browser tab; focus triggers the protected refresh.
  const job = jobs[0]!;
  await actor("builder", `#/c/${job.id}/sign?t=${job.token}`);
  await wait("document.body.innerText.includes('Deliverables')");
  await evaluate("document.cookie='privacy_fixture_actor=unrelated; Path=/';window.dispatchEvent(new Event('focus'))");
  await wait("document.body.innerText.includes('Only the agency or builder')");
  check(!await evaluate<boolean>("document.body.innerText.includes('CSV export')"), "Refused refresh retained private details");
  check(JSON.stringify(pins()) === JSON.stringify(initialPins), "Candidate pins changed during run");
  check(JSON.stringify(snapshot()) === before, "Browser reads changed signatures, recipients or invitations");
  check(ctx.stub.transfers.length === 0, "Privacy browser run moved simulated funds");
  writeFileSync(join(dir, "receipt.json"), JSON.stringify({ simulated: true, pins: initialPins, gateway_contacted: false, scope: "v2/v3 new and existing signed fixture jobs; fixture sessions, not wallet login", steps, refused_refresh_clears_private_view: true, original_signed_records_unchanged: true, transfers: 0 }, null, 2));
  console.log(`PASS privacy browser matrix; receipt ${join(dir, "receipt.json")}`);
} catch (error) {
  writeFileSync(join(dir, "failure.txt"), String(error));
  try { await command("screenshot", join(dir, "failure.png"), "--full"); } catch {}
  throw error;
} finally { try { await command("close"); } catch {} server.stop(true); }
