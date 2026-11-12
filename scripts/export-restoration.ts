/** Export one reviewed restoration into a new private bundle. No application runtime or platform calls. */
const usage = `Usage: bun --no-env-file scripts/export-restoration.ts <standalone-snapshot.sqlite> <restoration-request.json> <new-bundle-directory>

Save a corrected standalone snapshot, original request, receipt and hash manifest.
The destination's parent must already exist and be an operator-owned private directory.
An incomplete or conflicting destination is refused; a verified completed bundle can be reused.
Keep the bundle unchanged and private. Export does not authorize startup or payment resumption.

Exit codes: 0 completed export, verified reuse or help; 1 input/export failure.
`;

async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(usage); return; }
  if (args.length !== 3 || args.some(value => !value.trim() || value.startsWith("-"))) {
    process.stderr.write(`Invalid arguments (invalid_arguments).\n${usage}`);
    process.exitCode = 1; return;
  }
  let code = "invalid_request";
  try {
    const { constants, openSync, fstatSync, readSync, closeSync, lstatSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    function readRequest(path: string) {
      const before = lstatSync(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 4 * 1024 * 1024) throw new Error();
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const unchanged = (stat: ReturnType<typeof fstatSync>) => stat.isFile() && stat.ino === before.ino && stat.dev === before.dev &&
          stat.size === before.size && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
        if (!unchanged(fstatSync(fd))) throw new Error();
        const bytes = Buffer.alloc(before.size);
        for (let offset = 0; offset < bytes.length;) {
          const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (!read) throw new Error();
          offset += read;
        }
        if (!unchanged(fstatSync(fd)) || !unchanged(lstatSync(path))) throw new Error();
        return bytes;
      } finally { closeSync(fd); }
    }
    const original = readRequest(args[1]!);
    const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(original));
    const { exportRestorationBundle, RestorationExportError } = await import("../src/server/recovery/export");
    let result: ReturnType<typeof exportRestorationBundle>;
    code = "export_failed";
    try { result = exportRestorationBundle(args[0]!, request, args[2]!); }
    catch (error) {
      if (error instanceof RestorationExportError) code = error.code;
      throw error;
    }
    if (digest(readRequest(args[1]!)) !== digest(original)) throw new Error();
    const manifest = result.manifest;
    process.stdout.write(`${JSON.stringify({ schema_version: 1, result: result.result, correction_id: manifest.correction_id,
      output_snapshot_sha256: manifest.output_snapshot_sha256, audit_sha256: manifest.audit_sha256,
      manifest_sha256: result.manifest_sha256, clearance: "none" }, null, 2)}\n`);
  } catch {
    // Filesystem, JSON and SQLite errors can contain private input values or paths.
    process.stderr.write(`Restoration export could not complete (${code}). No source write or resumption was performed.\n`);
    process.exitCode = 1;
  }
}

await main(Bun.argv.slice(2));
export {};
