// The agency as a worker: its listed agent's jobs arrive as `hire.*` webhooks (at least once, unordered) and are also
// polled, because a webhook can be lost. A person at the agency writes and submits each deliverable: Covenant never
// hands a buyer's brief to a model or acts on what it says. An x402 job is accepted on delivery; the earnings land in
// the market account, which the owner withdraws to the agency agent's deposit address.
import type { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AssignmentView, WorkerView } from "../../shared/market";
import { UserError } from "../engine";
import type { Agencies } from "./agencies";
import { MarketHttpError, type MarketApi, type MarketAssignment } from "./api";
import { type AssignmentRow, update } from "./db";

/** The market's tolerance for a webhook's timestamp (docs, "Verify the signature"). */
const TIMESTAMP_SKEW_S = 300;
/** Market text kept per job: the market caps deliverables at 256 KiB; briefs are kept to the same bound. */
const MAX_TEXT = 256 * 1024;
export const WEBHOOK_PATH = "/api/market/webhook";
/** A submit still `submitting` after this long was cut off (a crash or restart mid-call). */
const SUBMIT_STALE_MS = 2 * 60_000;

export interface WorkerConfig {
  /** The `aat_` token (server secret). */
  token: string;
  /** The webhook signing secret (server secret). */
  secret: string;
  /** The agency whose listed agent this is: its market agent's deposit receives the earnings. */
  agencyId: string;
}

export interface WorkerDeps {
  db: Database;
  api: MarketApi;
  agencies: Agencies;
  config: WorkerConfig | null;
  now: () => Date;
}

/** `X-Market-Signature` = `sha256=` hex HMAC-SHA256(secret, `<timestamp>.<raw body>`), timestamp within 300 s. */
export function verifySignature(secret: string, timestamp: string | null, signature: string | null, rawBody: Uint8Array, nowMs: number): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > TIMESTAMP_SKEW_S) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  const given = Buffer.from(signature.replace(/^sha256=/, ""), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);

export class Worker {
  private lastPoll: { at: string; error: string | null } | null = null;
  constructor(private d: WorkerDeps) {}

  get configured(): boolean {
    return this.d.config !== null;
  }

  private cfg(): WorkerConfig {
    if (!this.d.config) throw new UserError("The market worker isn't configured (MARKET_AGENT_TOKEN, MARKET_WEBHOOK_SECRET, MARKET_WORKER_AGENCY).", 404);
    return this.d.config;
  }

  private iso() {
    return this.d.now().toISOString();
  }

  row(id: string): AssignmentRow {
    const r = this.d.db.query("SELECT * FROM market_assignments WHERE assignment_id = ?").get(id) as AssignmentRow | null;
    if (!r) throw new UserError("No such job.", 404);
    return r;
  }

  private set(id: string, fields: Partial<Omit<AssignmentRow, "assignment_id">>) {
    update(this.d.db, "market_assignments", "assignment_id", id, fields as Record<string, string | null>, this.iso());
  }

  /**
   * One webhook delivery. Answers 401 unless signed; a delivery seen before is dropped (`X-Market-Delivery`). A
   * `hire.created` records the job; any other event re-reads the assignments, since deliveries can arrive out of order.
   */
  async receive(headers: Headers, rawBody: Uint8Array): Promise<{ status: 200 | 401; duplicate?: boolean }> {
    const cfg = this.cfg();
    if (!verifySignature(cfg.secret, headers.get("x-market-timestamp"), headers.get("x-market-signature"), rawBody, this.d.now().getTime())) return { status: 401 };
    const delivery = headers.get("x-market-delivery");
    const event = headers.get("x-market-event") ?? "";
    if (!delivery) return { status: 200 };
    const inserted = this.d.db.query("INSERT OR IGNORE INTO market_deliveries (delivery_id, event, received_at) VALUES (?, ?, ?)").run(delivery, event, this.iso());
    if (inserted.changes === 0) return { status: 200, duplicate: true };
    let payload: any = null;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return { status: 200 };
    }
    if (event === "hire.created" && payload?.assignment_id) {
      this.upsert({
        assignmentId: String(payload.assignment_id),
        jobId: String(payload.job_id ?? ""),
        status: "in_progress",
        escrowAmount: payload.amount != null ? String(payload.amount) : null,
        escrowToken: payload.token != null ? String(payload.token) : null,
        slaDeadlineAt: payload.sla_deadline_at ?? null,
        title: String(payload.title ?? ""),
        description: String(payload.description ?? ""),
      }, false);
    } else void this.poll().catch(() => {});
    return { status: 200 };
  }

  /**
   * Records what the market says about one job. A webhook never moves a job's status backwards (`fromPoll` false); a
   * poll is the market's current word. On acceptance, the agency's current deposit address is recorded beside it.
   */
  private upsert(m: MarketAssignment, fromPoll: boolean) {
    const now = this.iso();
    const known = this.d.db.query("SELECT * FROM market_assignments WHERE assignment_id = ?").get(m.assignmentId) as AssignmentRow | null;
    if (!known) {
      this.d.db
        .query(
          `INSERT INTO market_assignments (assignment_id, job_id, title, description, status, escrow_amount, escrow_token, sla_deadline_at, seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(m.assignmentId, m.jobId, clip(m.title), clip(m.description), m.status, m.escrowAmount, m.escrowToken, m.slaDeadlineAt, now, now);
    } else if (fromPoll) {
      const fields: Partial<AssignmentRow> = { status: m.status, escrow_amount: m.escrowAmount ?? known.escrow_amount, escrow_token: m.escrowToken ?? known.escrow_token, sla_deadline_at: m.slaDeadlineAt ?? known.sla_deadline_at };
      // A submit left without an answer: a later status shows the market took it; still in progress (and, for one
      // in flight, a while later), it never arrived, so it may be sent again. Resending a deliverable moves no money.
      const stale = known.submit_state === "unknown" || (known.submit_state === "submitting" && this.d.now().getTime() - Date.parse(known.updated_at) > SUBMIT_STALE_MS);
      if (stale && m.status !== "in_progress") fields.submit_state = "submitted";
      else if (stale) Object.assign(fields, { submit_state: "none", submit_error: "The market didn't answer the last submission and still shows the job in progress: submit it again." });
      this.set(m.assignmentId, fields);
    }
    const row = this.row(m.assignmentId);
    if (row.status === "accepted" && !row.accepted_at) {
      const a = this.d.agencies.row(this.cfg().agencyId);
      this.set(m.assignmentId, { accepted_at: now, deposit_address: this.d.agencies.depositAddress(a)?.address ?? null });
    }
  }

  /** Reads every assignment of the agency's listed agent: the backstop for lost or reordered webhooks. */
  async poll(): Promise<void> {
    this.cfg();
    try {
      for (const m of await this.d.api.assignments()) this.upsert(m, true);
      this.lastPoll = { at: this.iso(), error: null };
    } catch (err) {
      this.lastPoll = { at: this.iso(), error: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  /**
   * Submits the deliverable an agency member wrote. The text is saved first; an unanswered submit stays `unknown`
   * until a poll shows whether the market took it.
   */
  async submit(assignmentId: string, markdown: string): Promise<AssignmentRow> {
    this.cfg();
    const r = this.row(assignmentId);
    const text = markdown.trim();
    if (!text) throw new UserError("Write the deliverable first.");
    if (new TextEncoder().encode(text).length > MAX_TEXT) throw new UserError("A deliverable is at most 256 KiB.");
    if (r.status !== "in_progress") throw new UserError(`This job is ${r.status}: there is nothing to submit.`, 409);
    if (r.submit_state === "submitting" || r.submit_state === "unknown") throw new UserError("A submission is waiting for the market's answer: check the jobs again first.", 409);
    this.set(assignmentId, { deliverable: text, submit_state: "submitting", submit_error: null });
    try {
      const res = await this.d.api.submit(assignmentId, text);
      this.set(assignmentId, { submit_state: "submitted", status: res.status });
    } catch (err) {
      const lost = !(err instanceof MarketHttpError) || err.status === 0 || err.status >= 500;
      this.set(assignmentId, { submit_state: lost ? "unknown" : "none", submit_error: err instanceof Error ? err.message : String(err) });
    }
    return this.row(assignmentId);
  }

  async view(): Promise<WorkerView> {
    const cfg = this.d.config;
    const rows = this.d.db.query("SELECT * FROM market_assignments ORDER BY seen_at DESC").all() as AssignmentRow[];
    const deposit = cfg ? await this.d.agencies.depositView(this.d.agencies.row(cfg.agencyId)) : null;
    return { configured: !!cfg, agency_id: cfg?.agencyId ?? null, webhook_path: WEBHOOK_PATH, assignments: rows.map(assignmentView), deposit, last_poll: this.lastPoll };
  }
}

const assignmentView = (r: AssignmentRow): AssignmentView => ({
  assignment_id: r.assignment_id,
  job_id: r.job_id,
  title: r.title,
  description: r.description,
  status: r.status,
  escrow_amount: r.escrow_amount,
  escrow_token: r.escrow_token,
  sla_deadline_at: r.sla_deadline_at,
  deliverable: r.deliverable,
  submit_state: r.submit_state,
  submit_error: r.submit_error,
  deposit_address: r.deposit_address,
  accepted_at: r.accepted_at,
});
