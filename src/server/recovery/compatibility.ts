import { Database } from "bun:sqlite";
import { recoveryIdSchema } from "./evidence";
import { LedgerInspectionError, loadLedgerSnapshot } from "./inspect";

export type StartupCompatibilityErrorCode = "invalid_request" | "invalid_snapshot" | "unsupported_snapshot";
export class StartupCompatibilityError extends Error {
  constructor(readonly code: StartupCompatibilityErrorCode) {
    super("Startup compatibility could not be completely inventoried; preserve the snapshot and do not start the application from this result.");
    this.name = "StartupCompatibilityError";
  }
}
export interface StartupCompatibilityBlocker {
  code: "provider_adapter_schema" | "unsafe_budget_release" | "deployment_mismatch" | "deployment_unbound" | "unsupported_schema";
  request_id?: string;
  contract_id?: string;
}
export interface StartupCompatibilityReport {
  schema_version: 1;
  snapshot: { sha256: string; bytes: number };
  expected_deployment: string;
  complete: boolean;
  blockers: StartupCompatibilityBlocker[];
  clearance: "none";
}

/**
 * Inventory the three explicit db.ts compatibility gates without opening, migrating or starting an app database.
 * These deliberately duplicated predicates are checked against actual startup fixtures. Other inventory findings,
 * migration/initialization failures, environment configuration and platform availability are not startup clearance.
 */
export function inspectStartupCompatibility(path: string, expectedDeployment: string): StartupCompatibilityReport {
  if (!recoveryIdSchema.safeParse(expectedDeployment).success) throw new StartupCompatibilityError("invalid_request");
  let loaded: ReturnType<typeof loadLedgerSnapshot>;
  try { loaded = loadLedgerSnapshot(path); }
  catch (error) {
    throw new StartupCompatibilityError(error instanceof LedgerInspectionError && error.code === "unsupported_schema" ? "unsupported_snapshot" : "invalid_snapshot");
  }
  let db: Database;
  try { db = Database.deserialize(loaded.bytes, { readonly: true, strict: true, safeIntegers: true }); }
  catch { throw new StartupCompatibilityError("invalid_snapshot"); }
  let complete = true;
  const blockers: StartupCompatibilityBlocker[] = [];
  const unsupported = () => {
    complete = false;
    if (!blockers.some(row => row.code === "unsupported_schema")) blockers.push({ code: "unsupported_schema" });
  };
  const table = (name: string): Set<string> | null => {
    const stored = db.query("SELECT type, sql FROM sqlite_schema WHERE name = ?").get(name) as { type: string; sql: string | null } | null;
    if (!stored) return null;
    if (stored.type !== "table" || /^\s*CREATE\s+VIRTUAL\b/i.test(stored.sql ?? "")) { unsupported(); return null; }
    const columns = db.query("SELECT name, hidden FROM pragma_table_xinfo(?)").all(name) as { name: string; hidden: bigint }[];
    if (columns.length > 128 || columns.some(row => row.hidden !== 0n)) { unsupported(); return null; }
    const count = db.query(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: bigint };
    if (count.count > 10_000n) { unsupported(); return null; }
    return new Set(columns.map(row => row.name));
  };
  const identity = (value: unknown): string | undefined => {
    if (recoveryIdSchema.safeParse(value).success) return value as string;
    unsupported(); return undefined;
  };
  try {
    db.exec("PRAGMA temp_store = MEMORY; PRAGMA trusted_schema = OFF;");
    // 1. db.ts refuseOldSchema: inspect column names only, never encrypted credential contents.
    try {
      const columns = table("contracts");
      if (!columns) unsupported();
      else if (columns.has("credential_enc") || !columns.has("organization")) blockers.push({ code: "provider_adapter_schema" });
    } catch { unsupported(); }

    // 2. db.ts refuseUnprovenBudgetReleases: all rows, no contracts join or workflow/version filter.
    try {
      const columns = table("payout_attempts");
      if (!columns || !["request_id", "contract_id", "kind", "state", "resolution", "tx_hash", "refund_tx_hash"].every(name => columns.has(name))) unsupported();
      else {
        // Missing legacy optional columns are projected to NULL exactly as the real startup guard does.
        const proof = columns.has("never_executed") ? "never_executed" : "NULL";
        const refunded = columns.has("refunded_amount") ? "refunded_amount" : "NULL";
        const rows = db.query(`SELECT request_id, contract_id, state, tx_hash, refund_tx_hash, ${proof} AS never_executed, ${refunded} AS refunded_amount
          FROM payout_attempts WHERE kind = 'payout' AND (state IN ('rejected', 'refused') OR (state = 'failed' AND resolution IN ('reowe', 'rejected')))`)
          .all() as { request_id: unknown; contract_id: unknown; state: string; tx_hash: unknown; refund_tx_hash: unknown; never_executed: unknown; refunded_amount: unknown }[];
        for (const row of rows) {
          const noCounterevidence = row.tx_hash === null && row.refund_tx_hash === null && row.refunded_amount === null;
          if (noCounterevidence && (row.state === "refused" || row.never_executed === 1 || row.never_executed === 1n)) continue;
          const request_id = identity(row.request_id), contract_id = identity(row.contract_id);
          blockers.push({ code: "unsafe_budget_release", ...(request_id && { request_id }), ...(contract_id && { contract_id }) });
        }
      }
    } catch { unsupported(); }

    // 3. db.ts bindAppDeployment: compare the expected original deployment, including Market-only databases.
    try {
      const columns = table("app_identity");
      const exists = db.query("SELECT 1 FROM sqlite_schema WHERE name = 'app_identity'").get();
      if (exists && (!columns || !columns.has("id") || !columns.has("deployment"))) unsupported();
      else {
        const rows = columns ? db.query("SELECT deployment FROM app_identity WHERE id = 1").all() as { deployment: unknown }[] : [];
        if (rows.length > 1) unsupported();
        else if (rows.length === 1) {
          if (rows[0]!.deployment !== expectedDeployment) blockers.push({ code: "deployment_mismatch" });
        } else if (expectedDeployment === "multiagency-paperwork") {
          const contracts = table("contracts");
          let hasRecords = false;
          if (!contracts) unsupported();
          else hasRecords = !!db.query("SELECT 1 FROM contracts LIMIT 1").get();
          const marketExists = db.query("SELECT 1 FROM sqlite_schema WHERE name = 'market_agencies'").get();
          if (marketExists) {
            if (!table("market_agencies")) unsupported();
            else hasRecords ||= !!db.query("SELECT 1 FROM market_agencies LIMIT 1").get();
          }
          if (hasRecords) blockers.push({ code: "deployment_unbound" });
        }
      }
    } catch { unsupported(); }
    blockers.sort((a, b) => a.code.localeCompare(b.code) || (a.request_id ?? "").localeCompare(b.request_id ?? "") || (a.contract_id ?? "").localeCompare(b.contract_id ?? ""));
    return { schema_version: 1, snapshot: loaded.inspection.snapshot, expected_deployment: expectedDeployment, complete, blockers, clearance: "none" };
  } catch { throw new StartupCompatibilityError("unsupported_snapshot"); }
  finally { db.close(); }
}
