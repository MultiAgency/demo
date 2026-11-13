/** Bounded local regression for the five surfaces with narrow-layout and draft risks. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { setup, signTerms, onboard } from "../tests/support/harness";

const dir = mkdtempSync(join(process.env.PAPERWORK_DEMO_ARTIFACTS ?? tmpdir(), "paperwork-responsive-"));
const session = `paperwork-responsive-${process.pid}`;
const ctx = await setup(JOB_DEMO_TERMS);
await signTerms(ctx);
await onboard(ctx);
const draft = ctx.rt.engine.createContract({ ...JOB_DEMO_TERMS, company: "Unsigned layout fixture" });
const server = await startServer(ctx.rt, 0, "127.0.0.1");
const base = server.url.origin;
const results: unknown[] = [];
function check(ok: unknown, message: string): asserts ok { if (!ok) throw Error(message); }
async function browser(...args: string[]) {
  const child = Bun.spawn(["agent-browser", "--session", session, "--json", ...args], { stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 20_000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    check(code === 0, err || out);
    const answer = JSON.parse(out);
    check(answer.success, answer.error);
    return answer.data;
  } finally { clearTimeout(timeout); }
}
async function evaluate<T>(script: string): Promise<T> { return (await browser("eval", script)).result; }
async function waitFor(script: string) {
  for (const end = Date.now() + 10_000; Date.now() < end; await Bun.sleep(100)) if (await evaluate(script)) return;
  throw Error(`Timed out: ${script}`);
}
const routes = [
  ["agency", "/agency"], ["new", "/new"], ["contract", `/c/${ctx.id}`],
  ["sign", `/c/${draft.id}/sign?t=${draft.contractorToken}`], ["verify", `/c/${ctx.id}/verify`],
];
try {
  for (const [name, path] of routes) {
    await browser("open", `${base}/#${path}`);
    await waitFor("!!document.querySelector('h1')");
    for (const theme of ["light", "dark"]) {
      await browser("set", "media", theme);
      for (const width of [320, 390, 768, 1024, 1440]) {
        await browser("set", "viewport", String(width), "900");
        const measurement = await evaluate<{ overflow: boolean; clippedCells: number; formWidth: number | null }>(`({
          overflow: document.documentElement.scrollWidth > innerWidth,
          clippedCells: [...document.querySelectorAll('.agency-jobs td')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>innerWidth||r.left<0)}).length,
          formWidth: document.querySelector('.form')?.getBoundingClientRect().width ?? null
        })`);
        const capture = join(dir, `${name}-${width}-${theme}.png`);
        await browser("screenshot", capture, "--full");
        results.push({ name, width, theme, ...measurement, capture });
        writeFileSync(join(dir, "receipt.json"), JSON.stringify({ simulated: true, results }, null, 2));
        check(!measurement.overflow, `${name} overflows at ${width}px (${theme})`);
        check(measurement.clippedCells === 0, `Agency table clips cells at ${width}px (${theme})`);
        if (name === "new" && width === 1024) check(measurement.formWidth! >= 600, "Tablet form is squeezed by the policy preview");
      }
    }
    console.log(`PASS ${name}: five widths, both themes`);
  }
  await browser("open", `${base}/#/new`);
  await waitFor("!!document.querySelector('input[value=\"Acme Labs\"]')");
  await browser("fill", 'input[value="Acme Labs"]', "Draft restored after navigation");
  await waitFor("document.body.innerText.includes('Draft saved in this tab')");
  await browser("open", `${base}/#/guide`);
  await browser("open", `${base}/#/new`);
  await waitFor("!!document.querySelector('input[value=\"Draft restored after navigation\"]')");
  await browser("reload");
  await waitFor("!!document.querySelector('input[value=\"Draft restored after navigation\"]')");
  await browser("find", "role", "button", "click", "--name", "Discard draft");
  await waitFor("!!document.querySelector('input[value=\"Acme Labs\"]')");
  check(await evaluate("sessionStorage.getItem('paperwork.job-draft.v1:demo') === null"), "Discard must clear stored form data");
  console.log(`PASS draft restoration, reload and discard; evidence ${dir}`);
} catch (error) {
  writeFileSync(join(dir, "failure.txt"), String(error));
  try { await browser("screenshot", join(dir, "failure.png"), "--full"); } catch {}
  throw error;
} finally {
  try { await browser("close"); } catch {}
  server.stop(true);
  await (await ctx.rt.auth.$context).checkSchema?.();
}
