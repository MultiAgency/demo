import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../src/shared/canonical";
import { evidenceDigest } from "../src/server/recovery/collect";
import { restorationLedger, type RestorationFixture } from "./support/restoration-ledger";

const fixtures: RestorationFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) rmSync(f.directory, { recursive: true, force: true }); });
const script = new URL("../scripts/export-restoration.ts", import.meta.url).pathname;
async function fixture() {
  const f = await restorationLedger(); fixtures.push(f);
  const requestPath = join(f.directory, "request.json"), target = join(f.directory, "bundle"), input = structuredClone(f.input);
  // The CLI deliberately exposes no clock option. Its synthetic observations are fresh against the real process clock.
  const stamp = new Date().toISOString();
  input.collection.started_at = input.collection.completed_at = stamp;
  for (const row of [...input.collection.payouts, ...input.collection.payments, ...input.collection.owners, input.collection.held]) row.started_at = row.completed_at = stamp;
  input.collection_sha256 = evidenceDigest(input.collection);
  writeFileSync(requestPath, `${canonicalJson(input)}\n`, { mode: 0o600 });
  writeFileSync(join(f.directory, ".env"), "PLATFORM=remote\nDB_PATH=must-not-create.sqlite\nPUBLIC_URL=PRIVATE-INVALID-ORIGIN\n");
  return { ...f, requestPath, target };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function run(f: Fixture, args: string[]) {
  const child = Bun.spawn([process.execPath, "--no-env-file", script, ...args],
    { cwd: f.directory, env: {}, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

test("export CLI help and unsupported arguments cannot load inputs, create state or publish a bundle", async () => {
  const f = await fixture(), before = readdirSync(f.directory).sort();
  const help = await run(f, ["--help"]);
  expect(help.exit).toBe(0); expect(help.stderr).toBe("");
  expect(help.stdout).toContain("export-restoration.ts"); expect(help.stdout).toContain("--no-env-file");
  for (const args of [[], ["--repair"], [f.path, f.requestPath], [f.path, f.requestPath, f.target, "--force"]]) {
    const result = await run(f, args);
    expect(result.exit).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr.length).toBeGreaterThan(0);
  }
  expect(readdirSync(f.directory).sort()).toEqual(before); expect(existsSync(f.target)).toBe(false);
});

test("export CLI publishes and verifies reuse with sanitized JSON, private files and unchanged source/request", async () => {
  const f = await fixture(), source = readFileSync(f.path), request = readFileSync(f.requestPath);
  const result = await run(f, [f.path, f.requestPath, f.target]);
  expect(result.exit).toBe(0); expect(result.stderr).toBe("");
  const summary = JSON.parse(result.stdout);
  expect(summary).toMatchObject({ result: "exported", clearance: "none" });
  expect(summary.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.stdout).not.toContain("PRIVATE-");
  expect(result.stdout).not.toContain("inputs_json"); expect(result.stdout).not.toContain("rep_sig");
  expect(readdirSync(f.target).sort()).toEqual(["manifest.json", "receipt.json", "request.json", "snapshot.sqlite"]);
  const bundle = Object.fromEntries(readdirSync(f.target).map(name => [name, readFileSync(join(f.target, name))]));
  const reused = await run(f, [f.path, f.requestPath, f.target]);
  expect(reused.exit).toBe(0); expect(reused.stderr).toBe("");
  expect(JSON.parse(reused.stdout)).toMatchObject({ result: "already_exported", clearance: "none", manifest_sha256: summary.manifest_sha256 });
  for (const [name, bytes] of Object.entries(bundle)) expect(readFileSync(join(f.target, name))).toEqual(bytes);
  expect(readFileSync(f.path)).toEqual(source); expect(readFileSync(f.requestPath)).toEqual(request);
  expect(existsSync(join(f.directory, "must-not-create.sqlite"))).toBe(false);
  expect(f.ctx.stub.calls.requestPayout).toBe(1); expect(f.ctx.stub.transfers).toHaveLength(0);
});

for (const mode of ["missing request", "malformed request", "symlink request", "tampered bundle"] as const)
  test(`export CLI refuses ${mode} without partial stdout or secret diagnostics`, async () => {
    const f = await fixture(), source = readFileSync(f.path);
    let requestPath = f.requestPath;
    if (mode === "missing request") requestPath = join(f.directory, "PRIVATE-MISSING-REQUEST");
    if (mode === "malformed request") writeFileSync(f.requestPath, "PRIVATE-INVALID-JSON");
    if (mode === "symlink request") { requestPath = join(f.directory, "request-alias.json"); symlinkSync(f.requestPath, requestPath); }
    if (mode === "tampered bundle") {
      expect((await run(f, [f.path, f.requestPath, f.target])).exit).toBe(0);
      writeFileSync(join(f.target, "receipt.json"), '{"PRIVATE":"tampered"}\n');
    }
    const before = readdirSync(f.directory).sort(), result = await run(f, [f.path, requestPath, f.target]);
    expect(result.exit).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stderr).not.toContain("PRIVATE-"); expect(readFileSync(f.path)).toEqual(source);
    expect(readdirSync(f.directory).sort()).toEqual(before);
    if (mode !== "tampered bundle") expect(existsSync(f.target)).toBe(false);
  });
