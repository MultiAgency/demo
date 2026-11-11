// Hiring a listed agent (client side). The requestId is fixed when the terms are quoted and saved before any hire is
// asked, so a lost answer is always followed by `market/status` under the same id, never retried under a new one.
// A wallet owner approves by hiring; a DAO approves by its vote on the exact terms, and the platform pays only then.
import type { Database } from "bun:sqlite";
import type { HireView } from "../../shared/market";
import { fromAtomic } from "../../shared/money";
import { USDC_DECIMALS } from "../../shared/terms";
import { UserError } from "../engine";
import { failCode, failError } from "../onboarding";
import { type Agencies, ended } from "./agencies";
import { type AgencyRow, type HireRow, type HireState, update } from "./db";
import type { Fail, HireAnswer, HireTerms, MarketPlatform, Res } from "./port";

/** How long a DAO's approval may stay valid: two days to vote and pay. The platform caps it at its own maximum. */
const DAO_APPROVAL_MS = 2 * 86_400_000;
const LIVE: HireState[] = ["voting", "hiring", "unknown"];
/** These gateway validation refusals explicitly precede creating a DAO hire request. Other failures prove no outcome. */
const DAO_NOT_FILED = new Set(["invalid_request", "brief_mismatch", "expires_too_soon"]);
const DAO_FILING_UNKNOWN = "dao_filing_unknown";

export interface HiresDeps {
  db: Database;
  market: MarketPlatform;
  agencies: Agencies;
  now: () => Date;
}

export class Hires {
  private approvals = new Set<string>();
  constructor(private d: HiresDeps) {}

  private iso() {
    return this.d.now().toISOString();
  }

  row(requestId: string): HireRow {
    const r = this.d.db.query("SELECT * FROM market_hires WHERE request_id = ?").get(requestId) as HireRow | null;
    if (!r) throw new UserError("No such hire.", 404);
    return r;
  }

  private set(requestId: string, fields: Partial<Omit<HireRow, "request_id">>) {
    update(this.d.db, "market_hires", "request_id", requestId, fields as Record<string, string | null>, this.iso());
  }

  forAgency(agencyId: string): HireRow[] {
    return this.d.db.query("SELECT * FROM market_hires WHERE agency_id = ? ORDER BY quoted_at DESC, rowid DESC").all(agencyId) as HireRow[];
  }

  /** Asks the listed agent's price for this brief. Moves nothing; the terms are stored with the hire's requestId. */
  async quote(agencyId: string, handle: string, brief: string): Promise<HireRow> {
    const a = this.d.agencies.ready(agencyId);
    const h = handle.trim().toLowerCase();
    if (!h) throw new UserError("Pick a listed agent.");
    if (!brief.trim()) throw new UserError("Write the brief first.");
    const q = await this.d.agencies.agent(a).quote(h, brief);
    if (!q.ok) throw failError(q, "the quote");
    const requestId = `hire-${crypto.randomUUID()}`;
    const now = this.iso();
    this.d.db
      .query("INSERT INTO market_hires (request_id, agency_id, handle, brief, terms, state, quoted_at, updated_at) VALUES (?, ?, ?, ?, ?, 'quoted', ?, ?)")
      .run(requestId, a.id, h, brief, JSON.stringify(q.value), now, now);
    return this.row(requestId);
  }

  /** Discards a quote nobody approved. Nothing was sent for it. */
  discard(requestId: string) {
    const r = this.row(requestId);
    if (r.state !== "quoted") throw new UserError(`This hire is ${r.state}: only an unapproved quote can be discarded.`, 409);
    this.d.db.query("DELETE FROM market_hires WHERE request_id = ?").run(requestId);
  }

  /**
   * The owner approves the quoted terms. A wallet owner's hire is asked at once; a DAO's is filed for its vote, and a
   * vote that expired is filed again under the same requestId.
   */
  async approve(requestId: string, actor: string | null): Promise<HireRow> {
    if (this.approvals.has(requestId)) throw new UserError("This hire's approval is already being followed under its original id.", 409);
    this.approvals.add(requestId);
    try { return await this.approveOnce(requestId, actor); }
    finally { this.approvals.delete(requestId); }
  }

  /** Unavailable or thrown policy reads grant no permission to send from an already funded payment key. */
  private async frozen(a: AgencyRow): Promise<boolean | null> {
    try {
      const res = await this.d.agencies.agent(a).frozen();
      return res.ok && typeof res.value === "boolean" ? res.value : null;
    } catch { return null; }
  }

  private requireNoUnknownDaoFiling(agencyId: string, requestId: string) {
    const uncertain = this.d.db.query(`SELECT request_id FROM market_hires WHERE agency_id = ? AND request_id != ?
      AND state = 'unknown' AND dao_vote_id IS NULL LIMIT 1`).get(agencyId, requestId) as { request_id: string } | null;
    if (uncertain) throw new UserError(`DAO hire ${uncertain.request_id} has an uncertain filing. Preserve that original identity before approving another hire.`, 409);
  }

  private async approveOnce(requestId: string, actor: string | null): Promise<HireRow> {
    let r = this.row(requestId);
    const a = this.d.agencies.ready(r.agency_id);
    if (a.signer === "dao") this.requireNoUnknownDaoFiling(a.id, requestId);
    // A freeze stops the agent's provider sends, not a payment from funds already on its payment key: hire nothing.
    const frozen = await this.frozen(a);
    if (frozen === null) throw new UserError("Couldn't confirm whether the market agent is frozen. Check again before approving this job.", 503);
    if (frozen) throw new UserError("The agency's market agent is frozen. Unfreeze it before approving a job.", 409);
    r = this.row(requestId);
    const terms = JSON.parse(r.terms) as HireTerms;
    if (a.signer === "dao") {
      if (r.state !== "quoted" && r.state !== "vote_expired") throw new UserError(`This hire is ${r.state}.`, 409);
      const validUntil = new Date(this.d.now().getTime() + DAO_APPROVAL_MS).toISOString();
      // The platform generates the vote hash. Losing that answer must not leave a remotely filed approval discardable
      // or fileable again. The SDK has no lookup by requestId: retain uncertainty, then observe market/status only.
      this.d.db.transaction(() => {
        this.requireNoUnknownDaoFiling(a.id, requestId);
        const claimed = this.d.db.query(`UPDATE market_hires SET state = 'unknown', dao_vote_id = NULL, code = ?, approved_by = ?, updated_at = ?
          WHERE request_id = ? AND state IN ('quoted', 'vote_expired')`)
          .run(DAO_FILING_UNKNOWN, actor, this.iso(), requestId);
        if (claimed.changes !== 1) throw new UserError("This DAO hire was already filed or is uncertain. Follow its original identity.", 409);
      })();
      let filed: Awaited<ReturnType<MarketPlatform["daoHire"]["file"]>>;
      try { filed = await this.d.market.daoHire.file({ organization: a.organization, agent: a.agent!, requestId, brief: r.brief, approved: terms, validUntil }); }
      catch { return this.row(requestId); }
      if (!filed.ok) {
        if (filed.kind === "refused" && DAO_NOT_FILED.has(filed.code)) {
          if (this.row(requestId).state === "unknown") this.set(requestId, { state: "refused", code: filed.code });
          throw failError(filed, "the DAO's hire request");
        }
        return this.row(requestId);
      }
      const value = filed.value;
      this.d.db.transaction(() => {
        const v = this.d.agencies.recordVote(a.id, "hire", requestId, value);
        const current = this.row(requestId);
        // A concurrent status read may already have confirmed settlement while the filing's answer was in flight.
        this.set(requestId, { state: current.state === "unknown" ? "voting" : current.state, dao_vote_id: v.id,
          code: current.state === "unknown" ? null : current.code });
      })();
      return this.row(requestId);
    }
    if (r.state !== "quoted") throw new UserError(`This hire is ${r.state}.`, 409);
    const claimed = this.d.db.query("UPDATE market_hires SET state = 'hiring', approved_by = ?, updated_at = ? WHERE request_id = ? AND state = 'quoted'")
      .run(actor, this.iso(), requestId);
    if (claimed.changes !== 1) throw new UserError("This hire was already approved. Follow its original identity.", 409);
    return this.ask(requestId);
  }

  /** `market/hire` under the hire's own requestId: paid at most once, only while a fresh quote equals the terms. */
  private async ask(requestId: string): Promise<HireRow> {
    const r = this.row(requestId);
    const a = this.d.agencies.row(r.agency_id);
    // Includes not_found recovery after reload: approval never bypasses a later freeze or an unanswered policy read.
    if (await this.frozen(a) !== false) return this.row(requestId);
    let res: Res<HireAnswer>;
    try { res = await this.d.agencies.agent(a).hire(requestId, r.brief, JSON.parse(r.terms) as HireTerms); }
    catch {
      this.set(requestId, { state: "unknown" });
      return this.row(requestId);
    }
    if (res.ok) this.apply(requestId, res.value);
    else this.failed(requestId, res);
    return this.row(requestId);
  }

  private failed(requestId: string, f: Fail) {
    if (f.kind === "refused" || f.kind === "forbidden") this.set(requestId, { state: "refused", code: failCode(f) });
    // Nothing reached the agent: the same requestId is asked again on the next follow-up.
    else if (f.kind === "rate_limited" || f.kind === "busy" || f.kind === "unresolved") this.set(requestId, { state: "hiring", code: failCode(f) });
    else if (f.kind === "session") throw failError(f, "the hire");
    else this.set(requestId, { state: "unknown", code: failCode(f) });
  }

  private apply(requestId: string, ans: HireAnswer) {
    const current = this.row(requestId);
    const fields: Partial<HireRow> = { task_state: ans.taskState,
      code: ans.code ?? (ans.state === "unknown" && current.code === DAO_FILING_UNKNOWN ? DAO_FILING_UNKNOWN : null) };
    if (ans.taskId) fields.task_id = ans.taskId;
    if (ans.deliverable !== null) fields.deliverable = ans.deliverable;
    if (ans.state === "paid" || ans.state === "not_charged" || ans.state === "refused" || ans.state === "unknown") fields.state = ans.state;
    this.set(requestId, fields);
  }

  /** A relay response can be lost after payment. Observe the original payment before declaring its vote expired. */
  private async terminalStatus(requestId: string): Promise<HireRow | null> {
    const r = this.row(requestId);
    const a = this.d.agencies.row(r.agency_id);
    try {
      const st = await this.d.agencies.agent(a).status(requestId);
      if (st.ok && st.value.requestId === requestId &&
        (st.value.state === "paid" || st.value.state === "not_charged" || st.value.state === "refused")) {
        this.apply(requestId, st.value);
        return this.row(requestId);
      }
    } catch { /* No readable settlement evidence: retain the original vote and its uncertainty. */ }
    return null;
  }

  /** Moves one live hire along: the DAO's vote, then what the platform's journal proves about the payment. */
  async follow(requestId: string): Promise<HireRow> {
    let r = this.row(requestId);
    if (r.state === "voting" && !r.dao_vote_id) {
      this.set(requestId, { state: "unknown", code: DAO_FILING_UNKNOWN });
      r = this.row(requestId);
    }
    if (r.state === "voting") {
      const st = await this.d.market.daoHire.state(r.dao_vote_id!);
      if (!st.ok || st.value.state === "expired") {
        const settled = await this.terminalStatus(requestId);
        if (settled) return settled;
      }
      if (!st.ok && !ended(st, "hire")) return r;
      if (st.ok && st.value.state === "pending") return r;
      if (!st.ok || st.value.state === "expired") {
        this.d.agencies.setVote(r.dao_vote_id!, "expired");
        this.set(requestId, { state: "vote_expired" });
        return this.row(requestId);
      }
      // Relayed: the platform re-quoted and paid, or refused, under this requestId. The journal says which.
      this.d.agencies.setVote(r.dao_vote_id!, "done");
      this.set(requestId, { state: "unknown" });
      r = this.row(requestId);
    }
    if (r.state !== "hiring" && r.state !== "unknown") return r;
    const a = this.d.agencies.row(r.agency_id);
    const st = await this.d.agencies.agent(a).status(requestId);
    if (!st.ok) return r;
    // The platform never recorded the wallet owner's hire (its answer was lost first): ask again under the same id.
    if (st.value.state === "not_found") return a.signer === "wallet" ? this.ask(requestId) : r;
    this.apply(requestId, st.value);
    return this.row(requestId);
  }

  /** Follows every live hire (the server's timer and each page read). */
  async followAll(agencyId?: string) {
    const rows = this.d.db
      .query(`SELECT request_id FROM market_hires WHERE state IN (${LIVE.map(() => "?").join(", ")}) AND (? IS NULL OR agency_id = ?)`)
      .all(...LIVE, agencyId ?? null, agencyId ?? null) as { request_id: string }[];
    for (const { request_id } of rows) {
      try {
        await this.follow(request_id);
      } catch {
        /* the next follow-up reads it again */
      }
    }
  }

  view(r: HireRow): HireView {
    const terms = JSON.parse(r.terms) as HireTerms;
    const vote = r.dao_vote_id ? this.d.agencies.voteView(this.d.agencies.vote(r.dao_vote_id)) : null;
    return {
      request_id: r.request_id,
      handle: r.handle,
      brief: r.brief,
      terms,
      amount_usd: fromAtomic(BigInt(terms.amount), USDC_DECIMALS),
      state: r.state,
      code: r.code,
      task_state: r.task_state,
      deliverable: r.deliverable,
      vote,
      quoted_at: r.quoted_at,
      updated_at: r.updated_at,
    };
  }
}
