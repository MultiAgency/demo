import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync,
  unlinkSync, writeSync, type Stats } from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";
import { z } from "zod";
import { canonicalJson, hashCanonical } from "../../shared/canonical";
import { digestSchema, recoveryIdSchema } from "./evidence";
import { loadLedgerSnapshot } from "./inspect";
import { restoreCommitment, type RestorationRequest } from "./restore";

export type RestorationExportErrorCode = "invalid_request" | "invalid_parent" | "invalid_bundle" | "incomplete_bundle" | "bundle_conflict" | "source_changed" | "export_failed";
export class RestorationExportError extends Error {
  constructor(readonly code: RestorationExportErrorCode) {
    super("Restoration export could not acknowledge a durable bundle; retain existing artifacts and do not resume the application.");
    this.name = "RestorationExportError";
  }
}
const SNAPSHOT_LIMIT = 64 * 1024 * 1024, REQUEST_LIMIT = 4 * 1024 * 1024, SMALL_LIMIT = 64 * 1024;
const file = (maximum: number) => z.strictObject({ bytes: z.number().int().positive().max(maximum), sha256: digestSchema });
const manifestSchema = z.strictObject({
  schema_version: z.literal(1), operation: z.literal("restore_commitment_v1"), correction_id: recoveryIdSchema,
  source_snapshot_sha256: digestSchema, request_sha256: digestSchema, binding_sha256: digestSchema, collection_sha256: digestSchema,
  output_snapshot_sha256: digestSchema, audit_sha256: digestSchema, receipt_sha256: digestSchema,
  files: z.strictObject({ "snapshot.sqlite": file(SNAPSHOT_LIMIT), "request.json": file(REQUEST_LIMIT), "receipt.json": file(SMALL_LIMIT) }),
  clearance: z.literal("none"),
});
export type RestorationBundleManifest = z.infer<typeof manifestSchema>;
export interface RestorationExportResult {
  result: "exported" | "already_exported"; manifest: RestorationBundleManifest; manifest_sha256: string;
}
const NAMES = ["manifest.json", "receipt.json", "request.json", "snapshot.sqlite"];
type Pin = { path: string; fd: number; stat: Stats };
type ReadFile = Pin & { bytes: Buffer };
const uid = () => process.getuid?.();
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value: unknown) => Buffer.from(`${canonicalJson(value)}\n`);
const sameIdentity = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a: Stats, b: Stats) => sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
function check(value: unknown, code: RestorationExportErrorCode): asserts value { if (!value) throw new RestorationExportError(code); }
function privateMode(stat: Stats, mode: number) { return uid() !== undefined && stat.uid === uid() && (stat.mode & 0o7777) === mode; }
function maybeStat(path: string): Stats | null {
  try { return lstatSync(path); } catch (error) { if ((error as { code?: string }).code === "ENOENT") return null; throw error; }
}
function pinDirectory(path: string, privateDirectory: boolean, pins: Pin[], code: RestorationExportErrorCode): Pin {
  const before = lstatSync(path);
  check(before.isDirectory() && !before.isSymbolicLink() && (!privateDirectory || privateMode(before, 0o700)), code);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const pin = { path, fd, stat: fstatSync(fd) };
  pins.push(pin);
  check(sameIdentity(before, pin.stat) && pin.stat.isDirectory() && (!privateDirectory || privateMode(pin.stat, 0o700)), code);
  return pin;
}
function checkPin(pin: Pin, code: RestorationExportErrorCode) {
  const named = lstatSync(pin.path), opened = fstatSync(pin.fd);
  check(!named.isSymbolicLink() && sameIdentity(named, pin.stat) && sameIdentity(opened, pin.stat) &&
    opened.uid === pin.stat.uid && opened.mode === pin.stat.mode, code);
}
function readFile(path: string, maximum: number, privateFile: boolean, pins: Pin[], code: RestorationExportErrorCode): ReadFile {
  const before = lstatSync(path);
  check(before.isFile() && !before.isSymbolicLink() && before.size > 0 && before.size <= maximum && (!privateFile || privateMode(before, 0o600)), code);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), stat = fstatSync(fd);
  const opened = { path, fd, stat };
  pins.push(opened);
  check(stat.isFile() && unchanged(before, stat) && (!privateFile || privateMode(stat, 0o600)), code);
  const bytes = Buffer.alloc(stat.size);
  for (let offset = 0; offset < bytes.length;) {
    const size = readSync(fd, bytes, offset, bytes.length - offset, offset);
    check(size > 0, code); offset += size;
  }
  check(unchanged(stat, fstatSync(fd)) && unchanged(stat, lstatSync(path)), code);
  return { ...opened, bytes };
}
function checkRead(file: ReadFile, code: RestorationExportErrorCode) {
  checkPin(file, code);
  check(unchanged(file.stat, fstatSync(file.fd)) && unchanged(file.stat, lstatSync(file.path)), code);
  const hash = createHash("sha256"), buffer = Buffer.alloc(Math.min(file.stat.size, 64 * 1024));
  for (let offset = 0; offset < file.stat.size;) {
    const size = readSync(file.fd, buffer, 0, Math.min(buffer.length, file.stat.size - offset), offset);
    check(size > 0, code); hash.update(buffer.subarray(0, size)); offset += size;
  }
  check(hash.digest("hex") === sha(file.bytes), code);
}
function canonicalFile(bytes: Uint8Array): unknown {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  check(jsonBytes(value).equals(Buffer.from(bytes)), "invalid_bundle");
  return value;
}
function auditDigest(bytes: Uint8Array, correctionId: string): string {
  const db = Database.deserialize(bytes, { readonly: true, strict: true, safeIntegers: true });
  try {
    db.exec("PRAGMA temp_store = MEMORY; PRAGMA trusted_schema = OFF;");
    const rows = db.query("SELECT rowid AS audit_rowid, * FROM recovery_corrections WHERE correction_id = ?").all(correctionId) as Record<string, unknown>[];
    check(rows.length === 1, "invalid_bundle");
    return hashCanonical(Object.fromEntries(Object.entries(rows[0]!).map(([key, value]) => [key, typeof value === "bigint" ? { integer: value.toString() } : value])));
  } finally { db.close(); }
}

/** Export a separate private bundle only. The parent must exist; no replacement, startup or platform operation is exposed. */
export function exportRestorationBundle(sourcePath: string, input: RestorationRequest, targetPath: string,
  options: { now?: () => Date; onPhase?: (phase: "before_publish" | "after_publish") => void } = {}): RestorationExportResult {
  const pins: Pin[] = [];
  try {
    let requestBytes: Buffer, request: RestorationRequest;
    try {
      requestBytes = jsonBytes(input);
      check(requestBytes.length <= REQUEST_LIMIT, "invalid_request");
      request = JSON.parse(requestBytes.toString("utf8")) as RestorationRequest;
      check(recoveryIdSchema.safeParse(request.correction_id).success && digestSchema.safeParse(request.binding?.snapshot_sha256).success, "invalid_request");
    } catch { throw new RestorationExportError("invalid_request"); }
    check(typeof targetPath === "string" && targetPath.length > 0 && basename(targetPath) !== "." && basename(targetPath) !== "..", "invalid_parent");
    const parentInput = resolve(dirname(targetPath)), name = basename(targetPath);
    check(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name), "invalid_parent");
    // Resolve ancestor aliases once (including macOS /var); the final parent itself may not be a symlink.
    const parentBefore = lstatSync(parentInput);
    check(parentBefore.isDirectory() && !parentBefore.isSymbolicLink() && privateMode(parentBefore, 0o700), "invalid_parent");
    const parent = realpathSync(parentInput), target = join(parent, name);
    let component = parse(parent).root;
    const directories = [pinDirectory(component, false, pins, "invalid_parent")];
    for (const part of parent.slice(component.length).split("/").filter(Boolean)) {
      component = join(component, part);
      directories.push(pinDirectory(component, component === parent, pins, "invalid_parent"));
    }
    const parentPin = directories[directories.length - 1]!;
    check(sameIdentity(parentBefore, parentPin.stat), "invalid_parent");
    const guardDirectories = () => { for (const pin of directories) checkPin(pin, "invalid_parent"); };
    const source = readFile(resolve(sourcePath), SNAPSHOT_LIMIT, false, pins, "source_changed");
    const sourceHash = sha(source.bytes);
    check(sourceHash === request.binding.snapshot_sha256, "bundle_conflict");
    try { check(loadLedgerSnapshot(source.path).inspection.snapshot.sha256 === sourceHash, "source_changed"); }
    catch { throw new RestorationExportError("source_changed"); }
    const checkSource = () => {
      checkRead(source, "source_changed");
      check(["-wal", "-shm", "-journal"].every(suffix => !maybeStat(`${source.path}${suffix}`)), "source_changed");
    };
    const stage = join(parent, `.paperwork-restoration-${sha(Buffer.from(name)).slice(0, 32)}.manifest.tmp`);

    function verifyComplete(bundle: Pin): RestorationExportResult {
      guardDirectories(); checkPin(bundle, "invalid_bundle");
      const entries = readdirSync(target).sort();
      check(entries.includes("manifest.json"), "incomplete_bundle");
      check(canonicalJson(entries) === canonicalJson(NAMES), "invalid_bundle");
      const before = fstatSync(bundle.fd);
      const manifestFile = readFile(join(target, "manifest.json"), SMALL_LIMIT, true, pins, "invalid_bundle");
      const parsed = manifestSchema.safeParse(canonicalFile(manifestFile.bytes));
      check(parsed.success, "invalid_bundle");
      const manifest = parsed.data;
      check(manifest.correction_id === request.correction_id && manifest.source_snapshot_sha256 === sourceHash && manifest.request_sha256 === sha(requestBytes) &&
        manifest.binding_sha256 === hashCanonical(request.binding) && manifest.collection_sha256 === request.collection_sha256, "bundle_conflict");
      const reads = {
        "snapshot.sqlite": readFile(join(target, "snapshot.sqlite"), SNAPSHOT_LIMIT, true, pins, "invalid_bundle"),
        "request.json": readFile(join(target, "request.json"), REQUEST_LIMIT, true, pins, "invalid_bundle"),
        "receipt.json": readFile(join(target, "receipt.json"), SMALL_LIMIT, true, pins, "invalid_bundle"),
      };
      for (const [name, entry] of Object.entries(reads)) {
        const expected = manifest.files[name as keyof typeof reads];
        check(entry.stat.nlink === 1 && entry.bytes.length === expected.bytes && sha(entry.bytes) === expected.sha256, "invalid_bundle");
      }
      check(reads["request.json"].bytes.equals(requestBytes) && manifest.files["request.json"].sha256 === manifest.request_sha256 &&
        manifest.files["snapshot.sqlite"].sha256 === manifest.output_snapshot_sha256 && manifest.files["receipt.json"].sha256 === manifest.receipt_sha256, "bundle_conflict");
      canonicalFile(reads["request.json"].bytes);
      const savedReceipt = canonicalFile(reads["receipt.json"].bytes);
      const replay = restoreCommitment(reads["snapshot.sqlite"].path, request, { now: options.now });
      check(replay.receipt.result === "already_applied" && Buffer.from(replay.snapshot_bytes).equals(reads["snapshot.sqlite"].bytes) &&
        canonicalJson(savedReceipt) === canonicalJson({ ...replay.receipt, result: "applied" }) &&
        auditDigest(reads["snapshot.sqlite"].bytes, request.correction_id) === manifest.audit_sha256, "invalid_bundle");
      // An old lossy result can have a self-consistent audit. Reproduce it from the pinned original source too.
      // Its recorded application time preserves aged, exact replay without granting a fresh correction.
      let expected: ReturnType<typeof restoreCommitment>;
      try { expected = restoreCommitment(source.path, request, { now: () => new Date(replay.receipt.applied_at) }); }
      catch { throw new RestorationExportError("invalid_bundle"); }
      check(expected.receipt.result === "applied" && Buffer.from(expected.snapshot_bytes).equals(reads["snapshot.sqlite"].bytes) &&
        canonicalJson(savedReceipt) === canonicalJson(expected.receipt), "invalid_bundle");
      // A crash between link and unlink can retain the private parent-side manifest link. No other links are accepted.
      if (manifestFile.stat.nlink === 2) {
        const staging = readFile(stage, SMALL_LIMIT, true, pins, "invalid_bundle");
        check(staging.stat.nlink === 2 && sameIdentity(staging.stat, manifestFile.stat) && staging.bytes.equals(manifestFile.bytes), "invalid_bundle");
        checkRead(staging, "invalid_bundle"); fsyncSync(staging.fd);
      } else check(manifestFile.stat.nlink === 1 && !maybeStat(stage), "invalid_bundle");
      const allFiles = [manifestFile, ...Object.values(reads)];
      for (const entry of allFiles) { checkRead(entry, "invalid_bundle"); fsyncSync(entry.fd); }
      checkSource();
      guardDirectories(); checkPin(bundle, "invalid_bundle");
      check(unchanged(before, fstatSync(bundle.fd)) && canonicalJson(readdirSync(target).sort()) === canonicalJson(NAMES), "invalid_bundle");
      fsyncSync(bundle.fd); fsyncSync(parentPin.fd);
      for (const entry of allFiles) checkRead(entry, "invalid_bundle");
      checkSource(); guardDirectories(); checkPin(bundle, "invalid_bundle");
      check(unchanged(before, fstatSync(bundle.fd)), "invalid_bundle");
      return { result: "already_exported", manifest, manifest_sha256: sha(manifestFile.bytes) };
    }

    guardDirectories();
    if (maybeStat(target)) return verifyComplete(pinDirectory(target, true, pins, "invalid_bundle"));
    check(!maybeStat(stage), "incomplete_bundle");
    // Validate and transform before reserving any output path. A corrected source cannot become a new publication.
    const restored = restoreCommitment(source.path, request, { now: options.now });
    check(restored.receipt.result === "applied" && restored.receipt.source_snapshot_sha256 === sourceHash, "invalid_request");
    checkSource(); guardDirectories();
    mkdirSync(target, { mode: 0o700 });
    const bundle = pinDirectory(target, true, pins, "invalid_bundle");
    const guard = () => { guardDirectories(); checkPin(bundle, "invalid_bundle"); };
    function writePrivate(path: string, bytes: Uint8Array): Pin {
      guard();
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const entry = { path, fd, stat: fstatSync(fd) }; pins.push(entry);
      check(entry.stat.isFile() && privateMode(entry.stat, 0o600) && entry.stat.nlink === 1, "export_failed");
      for (let offset = 0; offset < bytes.byteLength;) {
        const size = writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
        check(size > 0, "export_failed"); offset += size;
      }
      fsyncSync(fd); guard(); checkPin(entry, "export_failed");
      return entry;
    }
    const receiptBytes = jsonBytes(restored.receipt);
    const payloads = { "snapshot.sqlite": Buffer.from(restored.snapshot_bytes), "request.json": requestBytes, "receipt.json": receiptBytes };
    check(payloads["snapshot.sqlite"].length <= SNAPSHOT_LIMIT && receiptBytes.length <= SMALL_LIMIT, "export_failed");
    for (const [file, bytes] of Object.entries(payloads)) writePrivate(join(target, file), bytes);
    const manifest: RestorationBundleManifest = { schema_version: 1, operation: "restore_commitment_v1", correction_id: request.correction_id,
      source_snapshot_sha256: sourceHash, request_sha256: sha(requestBytes), binding_sha256: restored.receipt.binding_sha256,
      collection_sha256: restored.receipt.collection_sha256, output_snapshot_sha256: restored.receipt.output_snapshot_sha256,
      audit_sha256: auditDigest(restored.snapshot_bytes, request.correction_id), receipt_sha256: sha(receiptBytes),
      files: Object.fromEntries(Object.entries(payloads).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }])) as RestorationBundleManifest["files"], clearance: "none" };
    const manifestBytes = jsonBytes(manifest);
    check(manifestBytes.length <= SMALL_LIMIT, "export_failed");
    const staging = writePrivate(stage, manifestBytes);
    fsyncSync(bundle.fd); fsyncSync(parentPin.fd);
    options.onPhase?.("before_publish");
    guard(); checkSource(); checkPin(staging, "export_failed");
    // link() fails if manifest.json exists. The completion marker is the last publication, never an overwrite.
    linkSync(stage, join(target, "manifest.json"));
    guard(); checkPin(staging, "export_failed");
    check(fstatSync(staging.fd).nlink === 2, "export_failed");
    unlinkSync(stage);
    const verified = verifyComplete(bundle);
    options.onPhase?.("after_publish");
    const final = options.onPhase ? verifyComplete(bundle) : verified;
    guard(); checkSource();
    return { ...final, result: "exported" };
  } catch (error) {
    if (error instanceof RestorationExportError) throw error;
    throw new RestorationExportError("export_failed");
  } finally {
    for (const pin of pins.reverse()) { try { closeSync(pin.fd); } catch { /* No result was acknowledged if a required sync failed. */ } }
  }
}
