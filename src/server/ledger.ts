import type { Database } from "bun:sqlite";
import { type Judgment, judgmentSchema } from "../shared/judgment";
import { fromAtomic } from "../shared/money";
import { isMarketSettled, type PlatformTerms, type Terms, USDC_DECIMALS } from "../shared/terms";
import type { EventView } from "../shared/views";
import type { AttemptRow, ContractRow, EventRow, JobRow, JudgmentRow, LineRow } from "./db";
import { UserError } from "./errors";
import { isCommitted, type Line, sumLines } from "./payouts";
import type { Overview } from "./platform/port";

/**
 * The durable records behind every payment: contracts, payout attempts and their lines, judgments, and the event log.
 * Reads and writes only; no platform I/O. Callers hold the contract's mutex for any write that belongs to a workflow step.
 */
export class Ledger {
  constructor(private db: Database, private now: () => Date) {}

  nowIso(): string {
    return this.now().toISOString();
  }

  row(id: string): ContractRow {
    const row = this.db.query("SELECT * FROM contracts WHERE id = ?").get(id) as ContractRow | null;
    if (!row) throw new UserError("No such contract.", 404);
    return row;
  }

  terms(row: ContractRow): Terms {
    return JSON.parse(row.terms) as Terms;
  }

  /**
   * The only way platform setup, policy, funding and payout code receives terms. A Market-settled job is paid by the
   * Agent Market, so it is refused here before any platform action could be prepared.
   */
  platformTerms(row: ContractRow): PlatformTerms {
    const terms = this.terms(row);
    if (isMarketSettled(terms)) throw new UserError("This job settles on the Agent Market. Paperwork prepares no platform setup, funding or payout for it; the agency accepts the work on the Market.", 409);
    return terms;
  }

  /**
   * A freeze is reversible: contracts.frozen follows the platform's read. Frozen, nothing is requested; once the
   * owner unfreezes, the flag clears and payouts continue (re-checked against the whole signed policy first).
   */
  syncFrozen(row: ContractRow, ov: Overview) {
    if (!ov.policy) return;
    const frozen = ov.policy.frozen ? 1 : 0;
    if (frozen === row.frozen) return;
    this.db.query("UPDATE contracts SET frozen = ? WHERE id = ?").run(frozen, row.id);
    row.frozen = frozen;
    this.event(row.id, "freeze", frozen ? "The owner froze the contract's agent. Nothing pays until they unfreeze it." : "The owner unfroze the contract's agent. Payouts continue.");
  }

  // ---------------------------------------------------------------- payout attempts

  insertAttempt(i: { request_id: string; kind: "payout" | "attack"; contract_id: string; seq: number; attempt: number; run_id: string | null; recipient: string; amount: bigint; lines: Line[]; auto?: boolean; scenario?: string }) {
    const now = this.nowIso();
    this.db
      .query(
        "INSERT INTO payout_attempts (request_id, kind, contract_id, seq, attempt, run_id, recipient, amount_atomic, state, auto_retry, scenario, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
      )
      .run(i.request_id, i.kind, i.contract_id, i.seq, i.attempt, i.run_id, i.recipient, i.amount.toString(), i.auto ? 1 : 0, i.scenario ?? null, now, now);
    for (const l of i.lines) this.db.query("INSERT INTO payout_lines (request_id, deliverable_id, amount_atomic) VALUES (?, ?, ?)").run(i.request_id, l.deliverable_id, l.amount.toString());
  }

  nextSeq(id: string, kind: "payout" | "attack"): number {
    const r = this.db.query("SELECT MAX(seq) AS m FROM payout_attempts WHERE contract_id = ? AND kind = ?").get(id, kind) as { m: number | null };
    return (r.m ?? 0) + 1;
  }

  attempts(id: string): AttemptRow[] {
    return this.db.query("SELECT * FROM payout_attempts WHERE contract_id = ? ORDER BY created_at DESC, rowid DESC").all(id) as AttemptRow[];
  }

  attemptsForJudgment(id: string, judgmentId: string): AttemptRow[] {
    return this.db.query("SELECT * FROM payout_attempts WHERE contract_id = ? AND run_id = ? ORDER BY created_at DESC, rowid DESC").all(id, judgmentId) as AttemptRow[];
  }

  attempt(requestId: string): AttemptRow {
    const a = this.db.query("SELECT * FROM payout_attempts WHERE request_id = ?").get(requestId) as AttemptRow | null;
    if (!a) throw new UserError("No such payout.", 404);
    return a;
  }

  setAttempt(requestId: string, fields: Partial<Omit<AttemptRow, "request_id">>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db
      .query(`UPDATE payout_attempts SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE request_id = ?`)
      .run(...(Object.values(fields) as (string | number | null)[]), this.nowIso(), requestId);
  }

  allLines(id: string): LineRow[] {
    return this.db.query("SELECT l.* FROM payout_lines l JOIN payout_attempts a ON a.request_id = l.request_id WHERE a.contract_id = ?").all(id) as LineRow[];
  }

  /** Per deliverable, every amount that may have moved: paid, live, unknown or unproven failures. */
  committedBy(id: string): Map<string, bigint> {
    return sumLines(this.attempts(id), this.allLines(id), isCommitted);
  }

  // ---------------------------------------------------------------- judgments and submissions

  /**
   * A stored assessment (`judgments.json`, `job_submissions.assessment`). Its completion becomes money, so a record
   * that does not read back as written stops the step instead of being trusted or repaired.
   */
  assessment(json: string): Judgment {
    let value: unknown;
    try { value = JSON.parse(json); } catch { value = undefined; }
    const parsed = judgmentSchema.safeParse(value);
    if (!parsed.success) throw new Error("A stored assessment is unreadable. Preserve this database; nothing was changed.");
    return parsed.data;
  }

  openJudgment(id: string): JudgmentRow | null {
    return this.db.query("SELECT * FROM judgments WHERE contract_id = ? AND outcome = 'pending'").get(id) as JudgmentRow | null;
  }

  judgmentRow(runId: string): JudgmentRow | null {
    return this.db.query("SELECT * FROM judgments WHERE id = ?").get(runId) as JudgmentRow | null;
  }

  jobForJudgment(runId: string | null): JobRow | null {
    return runId ? this.db.query("SELECT * FROM job_submissions WHERE judgment_id = ?").get(runId) as JobRow | null : null;
  }

  /** DAO approval votes for this payout that may have been signed outside this app or while it was stopped. */
  pendingDaoSteps(requestId: string): string[] {
    return (this.db.query("SELECT correlation_id FROM owner_steps WHERE request_id = ? AND standard = 'dao' AND state IN ('prepared','submitted','unknown')")
      .all(requestId) as { correlation_id: string }[]).map((step) => step.correlation_id);
  }

  // ---------------------------------------------------------------- events

  events(contractId: string): EventView[] {
    return (this.db.query("SELECT * FROM events WHERE contract_id = ? ORDER BY id DESC LIMIT 100").all(contractId) as EventRow[]).map((e) => ({ id: e.id, at: e.at, kind: e.kind, text: e.text }));
  }

  event(contractId: string, kind: string, text: string) {
    this.db.query("INSERT INTO events (contract_id, at, kind, text) VALUES (?, ?, ?, ?)").run(contractId, this.nowIso(), kind, text);
  }

  lastAlert(contractId: string): string | null {
    const r = this.db.query("SELECT text FROM events WHERE contract_id = ? AND kind = 'alert' ORDER BY id DESC LIMIT 1").get(contractId) as { text: string } | null;
    return r?.text ?? null;
  }
}

export function usdText(atomic: bigint | string): string {
  const [w, f = ""] = fromAtomic(BigInt(atomic), USDC_DECIMALS).split(".");
  return `$${w}.${(f + "00").slice(0, 2)}`;
}

/** The event-log sentence for an attempt's current state. */
export function attemptText(a: AttemptRow): string {
  const amt = usdText(a.amount_atomic);
  const what = a.kind === "attack" ? `Attack payout ${amt} to ${a.recipient}` : `Payout ${amt} (${a.request_id})`;
  switch (a.state) {
    case "held":
      return `${what} is held for the representative's approval.`;
    case "processing":
      return `${what} is approved and moving.`;
    case "paid":
      return `${what} settled to ${a.recipient}.${a.tx_hash ? ` Tx ${a.tx_hash}.` : ""}`;
    case "refused":
      return `${what} was refused by the platform (${a.code}). Nothing was sent.`;
    case "rejected":
      return `${what} was rejected by the representative. Nothing was sent.`;
    case "failed":
      return `${what} failed${a.failure_code ? ` (${a.failure_code})` : ""}. It stays counted until the representative checks the evidence.`;
    case "unknown":
      return `${what}: no answer from the platform. Paperwork will ask for its status; it is never sent under a new id.`;
    case "waiting":
      return `${what} waits (${a.code}); the same request id will be asked again.`;
    case "blocked":
      return `${what} is blocked (${a.code}).`;
    case "dropped":
      return `${what} was dropped by the representative while blocked (${a.code}). The platform never recorded it.`;
    default:
      return `${what}: ${a.state}.`;
  }
}
