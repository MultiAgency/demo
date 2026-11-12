import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../src/shared/canonical";
import { evidenceDigest } from "../src/server/recovery/collect";
import { exportRestorationBundle, RestorationExportError } from "../src/server/recovery/export";
import { restoreCommitment } from "../src/server/recovery/restore";
import { addRestorationConflictConstraint, RESTORATION_NOW, restorationEvidence, restorationLedger, restorationRows,
  seedUnrelatedRestorationJob, type RestorationFixture } from "./support/restoration-ledger";

const fixtures: RestorationFixture[] = [];
const children = new Set<ReturnType<typeof Bun.spawn>>();
const files = ["manifest.json", "receipt.json", "request.json", "snapshot.sqlite"];
const payloads = ["snapshot.sqlite", "request.json", "receipt.json"] as const;
const childScript = new URL("./support/recovery-export-child.ts", import.meta.url).pathname;
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const now = () => RESTORATION_NOW;
afterEach(async () => {
  for (const child of children) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
  children.clear();
  for (const f of fixtures.splice(0)) rmSync(f.directory, { recursive: true, force: true });
});
async function fixture(version: 2 | 3 = 3) {
  const f = await restorationLedger(version); fixtures.push(f);
  const target = join(f.directory, "bundle"), requestPath = join(f.directory, "original-request.json");
  writeFileSync(requestPath, `${canonicalJson(f.input)}\n`, { mode: 0o600 });
  return { ...f, target, requestPath };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function publish(f: Fixture) { return exportRestorationBundle(f.path, f.input, f.target, { now }); }
function image(directory: string) {
  return readdirSync(directory).sort().map(name => {
    const path = join(directory, name), stat = lstatSync(path);
    return { name, mode: stat.mode & 0o777, inode: stat.ino, mtime_ms: stat.mtimeMs, link: stat.isSymbolicLink() ? readlinkSync(path) : null,
      sha256: stat.isFile() ? sha(readFileSync(path)) : null };
  });
}
function refuse(f: Fixture, options: { source?: string; request?: typeof f.input; target?: string; codes?: string[] } = {}) {
  const source = readFileSync(f.path), request = readFileSync(f.requestPath), listing = readdirSync(f.directory).sort();
  const target = options.target ?? f.target, before = existsSync(target) && lstatSync(target).isDirectory() ? image(target) : null;
  let error: unknown;
  try { exportRestorationBundle(options.source ?? f.path, options.request ?? f.input, target, { now }); }
  catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(RestorationExportError);
  if (options.codes) expect(options.codes).toContain((error as RestorationExportError).code);
  expect(String(error)).not.toContain("PRIVATE-");
  expect(readFileSync(f.path)).toEqual(source);
  expect(readFileSync(f.requestPath)).toEqual(request);
  expect(readdirSync(f.directory).sort()).toEqual(listing);
  if (before) expect(image(target)).toEqual(before);
}
function rehash(f: Fixture, name: typeof payloads[number]) {
  const manifestPath = join(f.target, "manifest.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bytes = readFileSync(join(f.target, name));
  manifest.files[name] = { bytes: bytes.length, sha256: sha(bytes) };
  if (name === "snapshot.sqlite") manifest.output_snapshot_sha256 = sha(bytes);
  if (name === "request.json") manifest.request_sha256 = sha(bytes);
  if (name === "receipt.json") manifest.receipt_sha256 = sha(bytes);
  writeFileSync(manifestPath, `${canonicalJson(manifest)}\n`);
}

describe("private durable restoration bundles from signed disposable snapshots", () => {
  test("a conflicting REPLACE event constraint refuses export before reserving a destination", async () => {
    const f = await fixture();
    const db = new Database(f.path, { strict: true });
    try {
      db.exec("UPDATE events SET kind = 'fixture_history_' || id");
      seedUnrelatedRestorationJob(db, f);
      addRestorationConflictConstraint(db, "events", "kind", "REPLACE");
    } finally { db.close(true); }
    const fresh = await restorationEvidence(f.path, f.ctx.id);
    f.inspection = fresh.inspection; f.input = fresh.input;
    writeFileSync(f.requestPath, `${canonicalJson(f.input)}\n`, { mode: 0o600 });
    const rows = restorationRows(f.path);
    expect(rows.events!.filter(row => row.kind === "recovery_correction")).toHaveLength(1);
    refuse(f, { codes: ["export_failed"] });
    expect(existsSync(f.target)).toBe(false);
    expect(restorationRows(f.path)).toEqual(rows);
    expect(restorationRows(f.path)).not.toHaveProperty("recovery_corrections");
    expect(f.ctx.stub.calls.requestPayout).toBe(1);
    expect(f.ctx.stub.transfers).toHaveLength(0);
  });

  for (const version of [2, 3] as const) test(`v${version}: publishes matching snapshot, original request, receipt and completion manifest without changing inputs`, async () => {
    const f = await fixture(version), source = readFileSync(f.path), request = readFileSync(f.requestPath), before = readdirSync(f.directory).sort();
    const result = publish(f);
    expect(result.result).toBe("exported");
    expect(readdirSync(f.target).sort()).toEqual(files);
    expect(lstatSync(f.target).mode & 0o777).toBe(0o700);
    for (const name of files) { expect(lstatSync(join(f.target, name)).mode & 0o777).toBe(0o600); expect(lstatSync(join(f.target, name)).nlink).toBe(1); }
    const manifestBytes = readFileSync(join(f.target, "manifest.json")), manifest = JSON.parse(manifestBytes.toString("utf8"));
    expect(manifestBytes.toString("utf8")).toBe(`${canonicalJson(manifest)}\n`);
    expect(result.manifest).toEqual(manifest); expect(result.manifest_sha256).toBe(sha(manifestBytes));
    expect(manifest).toMatchObject({ schema_version: 1, operation: "restore_commitment_v1", correction_id: f.input.correction_id,
      source_snapshot_sha256: sha(source), binding_sha256: evidenceDigest(f.input.binding), collection_sha256: f.input.collection_sha256, clearance: "none" });
    for (const name of payloads) {
      const bytes = readFileSync(join(f.target, name));
      expect(manifest.files[name]).toEqual({ bytes: bytes.length, sha256: sha(bytes) });
    }
    expect(readFileSync(join(f.target, "request.json"), "utf8")).toBe(`${canonicalJson(f.input)}\n`);
    const receiptBytes = readFileSync(join(f.target, "receipt.json")), receipt = JSON.parse(receiptBytes.toString("utf8"));
    expect(manifest.request_sha256).toBe(sha(readFileSync(join(f.target, "request.json"))));
    expect(manifest.receipt_sha256).toBe(sha(receiptBytes));
    expect(manifest.output_snapshot_sha256).toBe(sha(readFileSync(join(f.target, "snapshot.sqlite"))));
    expect(receipt).toMatchObject({ result: "applied", clearance: "none", request_id: f.requestId, committed_before_atomic: "0", committed_after_atomic: "300000000", paid_after_atomic: "0" });
    expect(receiptBytes.toString("utf8")).not.toContain("PRIVATE-");
    const rows = restorationRows(join(f.target, "snapshot.sqlite"));
    expect(rows.payout_attempts![0]).toMatchObject({ request_id: f.requestId, resolution: "disputed", state: "failed", never_executed: 0 });
    expect(rows.recovery_corrections).toHaveLength(1);
    expect(rows.recovery_corrections![0]).toMatchObject({ correction_id: f.input.correction_id, source_snapshot_sha256: sha(source), collection_sha256: f.input.collection_sha256 });
    expect(manifest.audit_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(restoreCommitment(join(f.target, "snapshot.sqlite"), f.input, { now }).receipt.result).toBe("already_applied");
    expect(readFileSync(f.path)).toEqual(source); expect(readFileSync(f.requestPath)).toEqual(request);
    expect(readdirSync(f.directory).sort()).toEqual([...before, "bundle"].sort());
    expect(f.ctx.stub.calls.requestPayout).toBe(1); expect(f.ctx.stub.transfers).toHaveLength(0);
  });

  test("an exact fully verified bundle is reused after evidence ages, without rewriting any file", async () => {
    const f = await fixture(), first = publish(f), before = image(f.target);
    const result = exportRestorationBundle(f.path, f.input, f.target, { now: () => new Date(RESTORATION_NOW.getTime() + 3_600_000) });
    expect(result).toMatchObject({ result: "already_exported", manifest: first.manifest, manifest_sha256: first.manifest_sha256 });
    expect(image(f.target)).toEqual(before);
  });

  test("a logically identical repacked bundle cannot bypass reproduction from the original source", async () => {
    const f = await fixture(); publish(f);
    const path = join(f.target, "snapshot.sqlite"), original = readFileSync(path);
    const db = new Database(path, { strict: true });
    try { db.exec("VACUUM"); } finally { db.close(true); }
    const repacked = readFileSync(path);
    expect(repacked).not.toEqual(original);
    // The local audit still passes: only reproduction from the pinned original distinguishes these bytes.
    const replay = restoreCommitment(path, f.input, { now });
    expect(replay.receipt.result).toBe("already_applied");
    expect(replay.snapshot_bytes).toEqual(repacked);
    writeFileSync(join(f.target, "receipt.json"), `${canonicalJson({ ...replay.receipt, result: "applied" })}\n`);
    rehash(f, "snapshot.sqlite"); rehash(f, "receipt.json");
    refuse(f, { codes: ["invalid_bundle"] });
  });

  test("a payload removed after publication cannot be acknowledged as a successful export", async () => {
    const f = await fixture(), source = readFileSync(f.path), request = readFileSync(f.requestPath);
    let reached = false, result: unknown, error: unknown;
    try {
      result = exportRestorationBundle(f.path, f.input, f.target, { now, onPhase: phase => {
        if (phase === "after_publish") { reached = true; unlinkSync(join(f.target, "receipt.json")); }
      } });
    } catch (failure) { error = failure; }
    expect(reached).toBe(true); expect(result).toBeUndefined(); expect(error).toBeInstanceOf(RestorationExportError);
    expect(readFileSync(f.path)).toEqual(source); expect(readFileSync(f.requestPath)).toEqual(request);
    expect(existsSync(join(f.target, "manifest.json"))).toBe(true);
    expect(existsSync(join(f.target, "receipt.json"))).toBe(false);
    refuse(f);
  });

  test("a fixture-seeded link/unlink crash window is fully verified and synced before retained-manifest reuse", async () => {
    const f = await fixture(), source = readFileSync(f.path);
    let staging: string | undefined, manifestHash: string | undefined, error: unknown;
    try {
      exportRestorationBundle(f.path, f.input, f.target, { now, onPhase: phase => {
        if (phase !== "before_publish") return;
        const temporary = readdirSync(f.directory).filter(name => name.startsWith(".paperwork-restoration-") && name.endsWith(".manifest.tmp"));
        expect(temporary).toHaveLength(1);
        staging = join(f.directory, temporary[0]!);
        manifestHash = sha(readFileSync(staging));
        linkSync(staging, join(f.target, "manifest.json"));
        throw new Error("Fixture-seeded retained manifest link; no successful result was delivered.");
      } });
    } catch (failure) { error = failure; }
    expect(error).toBeInstanceOf(RestorationExportError);
    expect(staging).toBeDefined();
    expect(lstatSync(staging!).nlink).toBe(2);
    expect(lstatSync(staging!).ino).toBe(lstatSync(join(f.target, "manifest.json")).ino);
    const before = image(f.target), result = publish(f);
    expect(result.result).toBe("already_exported"); expect(result.manifest_sha256).toBe(manifestHash!);
    expect(result.manifest.clearance).toBe("none"); expect(image(f.target)).toEqual(before);
    expect(readFileSync(f.path)).toEqual(source);
  });

  for (const name of payloads) for (const rehashed of [false, true])
    test(`${name} tampering ${rehashed ? "with a rewritten hash manifest" : "without new hashes"} cannot be reused`, async () => {
      const f = await fixture(); publish(f);
      const path = join(f.target, name);
      if (name === "snapshot.sqlite") {
        const db = new Database(path, { strict: true });
        try { db.query("UPDATE contracts SET created_at = '2026-11-19T00:00:00.000Z' WHERE id = ?").run(f.ctx.id); }
        finally { db.close(true); }
      } else {
        const value = JSON.parse(readFileSync(path, "utf8"));
        if (name === "request.json") value.correction_id = "different-correction";
        else value.committed_after_atomic = "0";
        writeFileSync(path, `${canonicalJson(value)}\n`);
      }
      if (rehashed) rehash(f, name);
      refuse(f);
    });

  for (const field of ["source_snapshot_sha256", "audit_sha256"] as const) test(`a rewritten manifest ${field} cannot be trusted even with intact payloads`, async () => {
    const f = await fixture(); publish(f);
    const path = join(f.target, "manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest[field] = "f".repeat(64);
    writeFileSync(path, `${canonicalJson(manifest)}\n`);
    refuse(f);
  });

  for (const name of files) test(`a missing ${name} makes a bundle incomplete and is never repaired implicitly`, async () => {
    const f = await fixture(); publish(f); unlinkSync(join(f.target, name)); refuse(f);
  });

  for (const name of ["extra.json", "snapshot.sqlite-wal", "snapshot.sqlite-shm", "snapshot.sqlite-journal"])
    test(`${name} prevents reuse rather than being ignored or removed`, async () => {
      const f = await fixture(); publish(f); writeFileSync(join(f.target, name), "PRIVATE-unexpected-bundle-data", { mode: 0o600 }); refuse(f);
    });

  for (const suffix of ["-wal", "-shm", "-journal"]) test(`original source ${suffix} prevents reuse even when its main-file digest is unchanged`, async () => {
    const f = await fixture(); publish(f);
    writeFileSync(`${f.path}${suffix}`, "PRIVATE-new-source-sidecar", { mode: 0o600 });
    refuse(f);
  });

  for (const name of files) test(`${name} must be an owned regular file, not a symlink to an otherwise valid payload`, async () => {
    const f = await fixture(); publish(f);
    const path = join(f.target, name), outside = join(f.directory, `outside-${name}`);
    writeFileSync(outside, readFileSync(path), { mode: 0o600 }); unlinkSync(path); symlinkSync(outside, path); refuse(f);
  });

  test("a shared hard-linked payload and permissive private-file modes are refused", async () => {
    const f = await fixture(); publish(f);
    linkSync(join(f.target, "snapshot.sqlite"), join(f.directory, "shared-snapshot.sqlite")); refuse(f);
    unlinkSync(join(f.directory, "shared-snapshot.sqlite"));
    chmodSync(join(f.target, "receipt.json"), 0o644); refuse(f);
  });

  for (const conflict of ["correction ID", "evidence", "source"] as const) test(`an existing bundle cannot be reused for conflicting ${conflict}`, async () => {
    const f = await fixture(); publish(f);
    if (conflict === "source") {
      const other = await fixture(2);
      refuse(f, { source: other.path, request: other.input });
    } else {
      const request = structuredClone(f.input);
      if (conflict === "correction ID") request.correction_id = "different-correction";
      else { request.collection.sdk_version = "0.5.6"; request.collection_sha256 = evidenceDigest(request.collection); }
      refuse(f, { request });
    }
  });

  test("an existing empty directory is left untouched rather than adopted", async () => {
    const f = await fixture(); mkdirSync(f.target, { mode: 0o700 }); refuse(f, { codes: ["incomplete_bundle", "invalid_bundle"] });
  });

  test("source and original request files cannot be overwritten by choosing them as the output path", async () => {
    const f = await fixture(); refuse(f, { target: f.path }); refuse(f, { target: f.requestPath });
  });

  test("symlinked target/parent directories and public parents cannot redirect or expose an export", async () => {
    const f = await fixture(), parent = join(f.directory, "private-parent"), alias = join(f.directory, "parent-alias");
    mkdirSync(parent, { mode: 0o700 }); symlinkSync(parent, alias); refuse(f, { target: join(alias, "new-bundle") });
    publish(f);
    const targetAlias = join(f.directory, "bundle-alias"); symlinkSync(f.target, targetAlias); refuse(f, { target: targetAlias });
    chmodSync(parent, 0o755); refuse(f, { target: join(parent, "new-bundle") });
  });

  for (const phase of ["before_publish", "after_publish"] as const)
    test(`real SIGKILL ${phase === "before_publish" ? "before completion publication leaves an unreusable partial directory" : "after durable publication permits verified lost-result reuse"}`, async () => {
      const f = await fixture(), source = readFileSync(f.path), request = readFileSync(f.requestPath);
      const child = Bun.spawn([process.execPath, "--no-env-file", childScript, f.path, f.requestPath, f.target, phase],
        { env: {}, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      children.add(child);
      const reader = child.stdout.getReader(); let text = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([(async () => {
          while (!text.includes(`PHASE ${phase}\n`)) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error("Fixture child ended before the synchronized publication phase.");
            text += new TextDecoder().decode(chunk.value);
          }
        })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture child did not reach its bounded publication phase.")), 5000); })]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
      child.kill("SIGKILL");
      expect(await child.exited).not.toBe(0);
      const stderr = await new Response(child.stderr).text();
      expect(stderr).toBe(""); expect(text).toBe(`PHASE ${phase}\n`);
      expect(readFileSync(f.path)).toEqual(source); expect(readFileSync(f.requestPath)).toEqual(request);
      if (phase === "before_publish") {
        expect(existsSync(f.target)).toBe(true); expect(existsSync(join(f.target, "manifest.json"))).toBe(false);
        expect(lstatSync(f.target).mode & 0o777).toBe(0o700);
        refuse(f, { codes: ["incomplete_bundle"] });
      } else {
        expect(readdirSync(f.target).sort()).toEqual(files);
        const before = image(f.target), reused = publish(f);
        expect(reused.result).toBe("already_exported"); expect(image(f.target)).toEqual(before);
      }
    }, 15_000);
});
