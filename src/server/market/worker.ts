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
/** Bound the complete envelope before parsing or storing it; the HMAC still covers its exact received bytes. */
export const MAX_WEBHOOK_BODY = 1024 * 1024;
export const WEBHOOK_PATH = "/api/market/webhook";

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
  if (!timestamp || !signature || !/^\d+$/.test(timestamp) || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > TIMESTAMP_SKEW_S) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  const given = Buffer.from(signature.slice(7), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);

export class Worker {
  private lastPoll: { agencyId: string; at: string; error: string | null } | null = null;
  private polling: Promise<void> | null = null;
  private submitting = new Set<string>();
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

  row(id: string, agencyId = this.cfg().agencyId): AssignmentRow {
    const r = this.d.db.query("SELECT * FROM market_assignments WHERE assignment_id = ?").get(id) as AssignmentRow | null;
    if (!r) throw new UserError("No such job.", 404);
    if (r.agency_id === null) throw new UserError("This historical job has no verified agency ownership; preserve it for operator reconciliation.", 409);
    if (r.agency_id !== agencyId) throw new UserError("No such job for this agency.", 404);
    return r;
  }

  private set(id: string, fields: Partial<Omit<AssignmentRow, "assignment_id">>) {
    update(this.d.db, "market_assignments", "assignment_id", id, fields as Record<string, string | null>, this.iso());
  }

  /**
   * One webhook delivery. Answers 401 unless signed; a delivery seen before is dropped (`X-Market-Delivery`). A
   * `hire.created` records the job; any other event re-reads the assignments, since deliveries can arrive out of order.
   */
  async receive(headers: Headers, rawBody: Uint8Array): Promise<{ status: 200 | 401 | 413; duplicate?: boolean }> {
    const cfg = this.cfg();
    if (rawBody.byteLength > MAX_WEBHOOK_BODY) return { status: 413 };
    if (!verifySignature(cfg.secret, headers.get("x-market-timestamp"), headers.get("x-market-signature"), rawBody, this.d.now().getTime())) return { status: 401 };
    const delivery = headers.get("x-market-delivery");
    const event = headers.get("x-market-event") ?? "";
    if (!delivery) return { status: 200 };
    const known = this.d.db.query("SELECT agency_id FROM market_deliveries WHERE delivery_id = ?").get(delivery) as { agency_id: string | null } | null;
    if (known) {
      if (known.agency_id !== cfg.agencyId) throw new UserError("This delivery's agency ownership differs or is unproven; preserve it for operator reconciliation.", 409);
      return { status: 200, duplicate: true };
    }
    let payload: any = null;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      this.recordDelivery(delivery, event, cfg.agencyId);
      return { status: 200 };
    }
    if (event === "hire.created" && payload?.assignment_id) {
      // A colliding/unbound job must refuse the delivery without acknowledging and dropping that delivery identity.
      this.d.db.transaction(() => {
        this.upsert({
          assignmentId: String(payload.assignment_id),
          jobId: String(payload.job_id ?? ""),
          status: "in_progress",
          escrowAmount: payload.amount != null ? String(payload.amount) : null,
          escrowToken: payload.token != null ? String(payload.token) : null,
          slaDeadlineAt: payload.sla_deadline_at ?? null,
          title: String(payload.title ?? ""),
          description: String(payload.description ?? ""),
        }, false, cfg.agencyId);
        this.recordDelivery(delivery, event, cfg.agencyId);
      })();
    } else {
      this.recordDelivery(delivery, event, cfg.agencyId);
      void this.poll().catch(() => {});
    }
    return { status: 200 };
  }

  private recordDelivery(delivery: string, event: string, agencyId: string) {
    this.d.db.query("INSERT INTO market_deliveries (delivery_id, agency_id, event, received_at) VALUES (?, ?, ?, ?)").run(delivery, agencyId, event, this.iso());
  }

  /**
   * Records what the market says about one job. A webhook never moves a job's status backwards (`fromPoll` false); a
   * poll is the market's current word. On acceptance, the agency's current deposit address is recorded beside it.
   */
  private upsert(m: MarketAssignment, fromPoll: boolean, agencyId: string) {
    const now = this.iso();
    const known = this.d.db.query("SELECT * FROM market_assignments WHERE assignment_id = ?").get(m.assignmentId) as AssignmentRow | null;
    if (known) this.row(m.assignmentId, agencyId);
    if (!known) {
      this.d.db
        .query(
          `INSERT INTO market_assignments (assignment_id, agency_id, job_id, title, description, status, escrow_amount, escrow_token, sla_deadline_at, seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(m.assignmentId, agencyId, m.jobId, clip(m.title), clip(m.description), m.status, m.escrowAmount, m.escrowToken, m.slaDeadlineAt, now, now);
    } else if (fromPoll) {
      const fields: Partial<AssignmentRow> = { status: m.status, escrow_amount: m.escrowAmount ?? known.escrow_amount, escrow_token: m.escrowToken ?? known.escrow_token, sla_deadline_at: m.slaDeadlineAt ?? known.sla_deadline_at };
      // A stale in-progress observation alone says nothing about delivery. The versions read below resolves an
      // unanswered submission; an already submitted/accepted assignment supplies direct confirmation.
      if ((known.submit_state === "unknown" || known.submit_state === "submitting") && (m.status === "submitted" || m.status === "accepted"))
        Object.assign(fields, { submit_state: "submitted", submit_error: null });
      this.set(m.assignmentId, fields);
    }
    const row = this.row(m.assignmentId, agencyId);
    if (row.status === "accepted" && !row.accepted_at) {
      const a = this.d.agencies.row(agencyId);
      this.set(m.assignmentId, { accepted_at: now, deposit_address: this.d.agencies.depositAddress(a)?.address ?? null });
    }
  }

  /** Reads every assignment of the agency's listed agent: the backstop for lost or reordered webhooks. */
  poll(): Promise<void> {
    // Timer, webhook and manual polls share one read: an older empty result must not undo newer confirmation.
    if (!this.polling) this.polling = this.pollOnce().finally(() => { this.polling = null; });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    const cfg = this.cfg();
    try {
      for (const m of await this.d.api.assignments()) this.upsert(m, true, cfg.agencyId);
      const pending = this.d.db.query("SELECT * FROM market_assignments WHERE agency_id = ? AND submit_state IN ('unknown', 'submitting')").all(cfg.agencyId) as AssignmentRow[];
      let failed: Error | null = null;
      for (const row of pending) {
        // A live POST may still arrive after an empty read. A restarted process has no live local call to wait for.
        if (this.submitting.has(row.assignment_id)) continue;
        try {
          const arrived = await this.d.api.hasDeliverableVersions(row.assignment_id);
          this.set(row.assignment_id, { submit_state: arrived ? "submitted" : "none", submit_error: null });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.set(row.assignment_id, { submit_state: "unknown", submit_error: error.message });
          failed ??= error;
        }
      }
      if (failed) throw failed;
      this.lastPoll = { agencyId: cfg.agencyId, at: this.iso(), error: null };
    } catch (err) {
      this.lastPoll = { agencyId: cfg.agencyId, at: this.iso(), error: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  /**
   * Submits the deliverable an agency member wrote. The text is saved first; an unanswered submit stays `unknown`
   * until a poll reads the assignment's deliverable versions. Recovery never resends automatically.
   */
  async submit(assignmentId: string, markdown: string): Promise<AssignmentRow> {
    const cfg = this.cfg();
    const r = this.row(assignmentId, cfg.agencyId);
    const text = markdown.trim();
    if (!text) throw new UserError("Write the deliverable first.");
    if (new TextEncoder().encode(text).length > MAX_TEXT) throw new UserError("A deliverable is at most 256 KiB.");
    if (r.status !== "in_progress") throw new UserError(`This job is ${r.status}: there is nothing to submit.`, 409);
    if (this.submitting.has(assignmentId) || r.submit_state === "submitting" || r.submit_state === "unknown") throw new UserError("A submission is waiting for the market's answer: check the jobs again first.", 409);
    this.set(assignmentId, { deliverable: text, submit_state: "submitting", submit_error: null });
    this.submitting.add(assignmentId);
    try {
      const res = await this.d.api.submit(assignmentId, text);
      // A poll can already have observed acceptance or subsequent rework while this older reply was pending.
      if (this.row(assignmentId, cfg.agencyId).submit_state !== "submitted")
        this.set(assignmentId, { submit_state: "submitted", status: res.status });
    } catch (err) {
      const lost = !(err instanceof MarketHttpError) || err.status === 0 || (err.status >= 200 && err.status < 300) || err.status >= 500;
      // A concurrent poll may already have confirmed arrival while this response was being lost.
      if (this.row(assignmentId, cfg.agencyId).submit_state !== "submitted")
        this.set(assignmentId, { submit_state: lost ? "unknown" : "none", submit_error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.submitting.delete(assignmentId);
    }
    return this.row(assignmentId, cfg.agencyId);
  }

  async view(): Promise<WorkerView> {
    const cfg = this.d.config;
    const rows = cfg ? this.d.db.query("SELECT * FROM market_assignments WHERE agency_id = ? ORDER BY seen_at DESC").all(cfg.agencyId) as AssignmentRow[] : [];
    const deposit = cfg ? await this.d.agencies.depositView(this.d.agencies.row(cfg.agencyId)) : null;
    const lastPoll = cfg && this.lastPoll?.agencyId === cfg.agencyId ? { at: this.lastPoll.at, error: this.lastPoll.error } : null;
    return { configured: !!cfg, agency_id: cfg?.agencyId ?? null, webhook_path: WEBHOOK_PATH, assignments: rows.map(assignmentView), deposit, last_poll: lastPoll };
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
