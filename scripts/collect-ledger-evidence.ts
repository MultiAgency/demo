/** One selected job, explicit provenance and four read-only SDK procedures. No repair or application startup. */
const usage = `Usage: bun --no-env-file scripts/collect-ledger-evidence.ts <standalone-snapshot.sqlite> <binding.json> <credential-file>

Collect one job's platform observations and print an advisory correction preview.
The binding must identify the exact snapshot and trusted original platform/job records.
Reports contain private financial identities; keep them in protected operator storage.
No dotenv, automatic retry, repair, force-start, signing or payment options are supported.

Exit codes: 0 help; 2 review-only report (never clearance); 1 input/collection error.
`;

async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(usage); return; }
  if (args.length !== 3 || args.some(value => !value.trim() || value.startsWith("-"))) {
    process.stderr.write(`Invalid arguments (invalid_arguments).\n${usage}`); process.exitCode = 1; return;
  }
  try {
    const { constants, openSync, fstatSync, readSync, closeSync, lstatSync } = await import("node:fs");
    function smallFile(path: string, maximum: number) {
      const before = lstatSync(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximum) throw new Error();
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error();
        const bytes = Buffer.alloc(before.size);
        for (let offset = 0; offset < bytes.length;) {
          const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (!read) throw new Error();
          offset += read;
        }
        const after = fstatSync(fd), named = lstatSync(path);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
            named.ino !== before.ino || named.dev !== before.dev || named.isSymbolicLink()) throw new Error();
        return bytes.toString("utf8");
      } finally { closeSync(fd); }
    }
    const { inspectLedger } = await import("../src/server/recovery/inspect");
    const { parseRecoveryBinding, collectRecoveryEvidence } = await import("../src/server/recovery/collect");
    const inspection = inspectLedger(args[0]!);
    const binding = parseRecoveryBinding(inspection, JSON.parse(smallFile(args[1]!, 64 * 1024)));
    const credential = smallFile(args[2]!, 8 * 1024).trim();
    // App credentials are opaque; the reader validates bounded HTTP-header safety, not a private token format.
    const { createRecoveryReader } = await import("../src/server/recovery/sdk-reader");
    const reader = createRecoveryReader({ origin: binding.platform_origin, deployment: binding.deployment, credential });
    const collection = await collectRecoveryEvidence(inspection, binding, reader);
    const after = inspectLedger(args[0]!);
    if (after.snapshot.sha256 !== inspection.snapshot.sha256 || after.snapshot.bytes !== inspection.snapshot.bytes) throw new Error();
    const { previewRecovery } = await import("../src/server/recovery/preview");
    const preview = previewRecovery(inspection, collection);
    process.stdout.write(`${JSON.stringify({ collection, preview }, null, 2)}\n`);
    process.exitCode = 2;
  } catch {
    // Raw filesystem, SDK, validation and transport errors can contain credentials or private document contents.
    process.stderr.write("Evidence collection could not produce a report. (collection_failed)\n");
    process.exitCode = 1;
  }
}

await main(Bun.argv.slice(2));
export {};
