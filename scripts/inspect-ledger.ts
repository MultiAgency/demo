/** Inventory one standalone snapshot only. This command never repairs a ledger or starts the application. */
const usage = `Usage: bun --no-env-file scripts/inspect-ledger.ts <standalone-snapshot.sqlite>

Inspect a clean standalone SQLite snapshot without changing it.
No repair, write, force, network or configuration options are supported.
An inventory does not verify platform evidence or authorize startup or payment resumption.

Exit codes: 0 inventory without findings; 2 review required; 1 inspection/usage error.
`;

const messages: Readonly<Record<string, string>> = {
  snapshot_required: "A clean standalone SQLite snapshot is required.",
  invalid_snapshot: "The supplied snapshot cannot be inspected.",
  unsupported_schema: "The snapshot schema is not supported.",
  snapshot_changed: "The snapshot changed during inspection.",
};

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(usage);
    return;
  }
  if (args.length !== 1 || !args[0]?.trim() || args[0].startsWith("-")) {
    process.stderr.write(`Invalid arguments (invalid_arguments).\n${usage}`);
    process.exitCode = 1;
    return;
  }

  // Help and invalid arguments return before the inspector is loaded or any database is opened.
  try {
    const { inspectLedger, LedgerInspectionError } = await import("../src/server/recovery/inspect");
    try {
      const report = inspectLedger(args[0]);
      const output = JSON.stringify(report, null, 2);
      process.stdout.write(`${output}\n`);
      process.exitCode = report.summary.requires_review ? 2 : 0;
    } catch (error) {
      const code = error instanceof LedgerInspectionError && Object.hasOwn(messages, error.code)
        ? error.code : "inspection_failed";
      process.stderr.write(`${messages[code] ?? "Ledger inspection failed."} (${code})\n`);
      process.exitCode = 1;
    }
  } catch {
    // Do not disclose import failures, SQLite diagnostics, paths or stored values.
    process.stderr.write("Ledger inspection failed. (inspection_failed)\n");
    process.exitCode = 1;
  }
}

await main(Bun.argv.slice(2));

export {};
