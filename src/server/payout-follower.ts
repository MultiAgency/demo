import { policyProblem } from "../shared/policy-request";
import { payoutEndInstant, type PlatformTerms } from "../shared/terms";
import type { AttemptRow, ContractRow, PlatformAgentRow } from "./db";
import { attemptText, type Ledger } from "./ledger";
import type { Onboarding } from "./onboarding";
import { classifyFailed, fromAnswer, fromFail, type Transition } from "./payouts";
import type { AgentHandle, Overview, PaymentStatus, PayoutAnswer, Res } from "./platform/port";

/** No new payout request this close to the end: a lost reply must still be followable under the payout consent. */
const END_MARGIN_MS = 10 * 60_000;
/** The payout grant must outlive a request by this much. The platform issues it for 30 days; contracts run up to 365. */
export const GRANT_MARGIN_MS = 24 * 3_600_000;

/** A live payout grant (label `payout`, or `invoices` on the local stack: platform-gaps G9) that lasts past `until`. */
export function liveGrant(o: Overview, until: number) {
  return o.grants.find((g) => (g.label === "payout" || g.label === "invoices") && !g.revoked && Date.parse(g.expiresAt) > until) ?? null;
}

function eventKind(state: AttemptRow["state"]): string {
  return state === "paid" ? "paid" : state === "held" ? "held" : state === "refused" ? "refused" : state === "rejected" ? "reject" : state === "failed" ? "failed" : "payout";
}

export interface FollowerDeps {
  onboarding: Onboarding;
  statusPollMs: number;
  now: () => Date;
  log: (msg: string) => void;
}

/**
 * The payout request and observation state machine. Every request reuses the attempt's saved identity; every platform
 * answer, including failures and their non-execution proof, is recorded here. Callers hold the contract's mutex.
 */
export class PayoutFollower {
  constructor(private l: Ledger, private d: FollowerDeps) {}

  handleFor(att: AttemptRow) {
    const row = this.l.row(att.contract_id);
    const a = this.d.onboarding.agentRow(row.organization);
    return a?.agent ? this.d.onboarding.handle(a) : null;
  }

  /** Ask the platform for this attempt's request id. Rows are always written before this is called. */
  async send(requestId: string) {
    const att = this.l.attempt(requestId);
    const row = this.l.row(att.contract_id);
    const terms = this.l.platformTerms(row);
    // A change request may stop a request only before sending or after status proved not_found.
    if (this.l.jobForJudgment(att.run_id)?.changes) return this.transition(att, { state: "dropped", code: "changes_requested", failKind: null });
    const a = this.d.onboarding.agentRow(row.organization);
    if (!a?.agent) return this.transition(att, { state: "blocked", code: "setup", failKind: "blocked", retryAfterMs: this.d.statusPollMs });
    let expected: { revision: number; digest: string } | null = null;
    if (att.kind === "payout") {
      const pre = await this.preflight(row, terms, a);
      if ("state" in pre) {
        // Said once per distinct problem, not on every re-check.
        if (pre.alert && att.state === pre.state && att.code === pre.code && this.l.lastAlert(att.contract_id) === pre.alert) delete pre.alert;
        return this.transition(att, pre);
      }
      expected = pre.expected;
    } else {
      // Attacks: a compromised server skips Paperwork's checks; only the platform stands in the way.
      const o = await this.d.onboarding.handle(a).overview();
      expected = o.ok && o.value.revision !== null && o.value.digest !== null ? { revision: o.value.revision, digest: o.value.digest } : { revision: a.policy_revision ?? 0, digest: a.policy_digest ?? "" };
    }
    const res = await this.d.onboarding.handle(a).requestPayout({ requestId, recipient: att.recipient, amount: att.amount_atomic, expectedPolicy: expected });
    await this.apply(att, res);
  }

  /**
   * Before every payout request: active, not near the end, and the whole live policy matches what Paperwork signed.
   * Any other policy, whichever revision it is, blocks the request (`policy_mismatch`) until it matches again.
   */
  private async preflight(row: ContractRow, terms: PlatformTerms, a: PlatformAgentRow): Promise<{ expected: { revision: number; digest: string } } | Transition> {
    const blocked = (code: string): Transition => ({ state: "blocked", code, failKind: "blocked", retryAfterMs: this.d.statusPollMs });
    if (a.stage === "needs_grant" && a.policy_revision !== null) return blocked("grant_expired"); // waiting for the re-issued grant
    if (a.stage !== "ready") return blocked("setup");
    if (this.d.now().getTime() >= Date.parse(payoutEndInstant(terms)) - END_MARGIN_MS) return blocked("contract_ending");
    const o = await this.d.onboarding.handle(a).overview();
    if (!o.ok) return row.frozen ? blocked("frozen") : { state: "waiting", code: "overview_unavailable", failKind: null, retryAfterMs: 60_000 };
    this.l.syncFrozen(row, o.value);
    const problem = policyProblem(o.value, terms);
    if (problem) {
      if (problem.code === "policy_mismatch") return { ...blocked(problem.code), alert: `${problem.detail} Nothing is requested until it matches again.` };
      return problem.waiting ? { state: "waiting", code: problem.code, failKind: null, retryAfterMs: 60_000 } : blocked(problem.code);
    }
    if (o.value.revision === null || o.value.digest === null) return { state: "waiting", code: "policy_not_in_force", failKind: null, retryAfterMs: 60_000 };
    if (!liveGrant(o.value, this.d.now().getTime() + GRANT_MARGIN_MS)) {
      this.d.onboarding.grantExpired(row.id, a);
      return blocked("grant_expired");
    }
    if (o.value.revision !== a.policy_revision || o.value.digest !== a.policy_digest) {
      // A new revision that still matches the signed terms in full: record it as the reviewed one.
      this.d.onboarding.setAgent(a.organization, { policy_revision: o.value.revision, policy_digest: o.value.digest });
      this.l.event(row.id, "policy", `Policy revision ${o.value.revision} still matches the signed terms in full; Paperwork continues under it.`);
    }
    return { expected: { revision: o.value.revision, digest: o.value.digest } };
  }

  private async apply(att: AttemptRow, res: Res<PayoutAnswer>) {
    if (!res.ok) return this.transition(att, fromFail(res, this.d.statusPollMs));
    if (res.value.requestId !== att.request_id ||
      (att.correlation_id !== null && res.value.correlationId !== null && res.value.correlationId !== att.correlation_id)) {
      this.d.log(`ALERT ${att.request_id}: ignored payout answer with mismatched request or payment identity`);
      return;
    }
    // A recorded payment cannot become an unsent request. Observe its original correlation;
    // a regressed request record is neither non-execution proof nor permission to send again.
    if (att.correlation_id && (res.value.state === "refused" || res.value.state === "not_found")) {
      const payment = await this.handleFor(att)?.paymentStatus(att.correlation_id);
      if (payment?.ok && payment.value.status === "SUCCESS")
        return this.transition(att, { state: "paid", code: null, failKind: null }, payment);
      if (payment?.ok && (payment.value.status === "FAILED" || payment.value.status === "REFUNDED"))
        return this.transition(att, { state: "failed", code: payment.value.failureCode, failKind: null, neverExecuted: false }, payment);
      return;
    }
    const t = fromAnswer(res.value);
    if (t.reask) return this.send(att.request_id); // never recorded: the same id again
    await this.transition(att, t);
  }

  /** Record a transition, then fetch what the new state needs (approval id, evidence). */
  private async transition(att: AttemptRow, t: Transition, observedPayment?: Res<PaymentStatus>) {
    const fields: Partial<AttemptRow> = {
      state: t.state,
      code: t.code,
      fail_kind: t.failKind,
      retry_at: t.retryAfterMs !== undefined ? new Date(this.d.now().getTime() + t.retryAfterMs).toISOString() : null,
    };
    if (t.correlationId) fields.correlation_id = t.correlationId;
    // Proof is granted only below, after a successful payment read; this write can only revoke it before further I/O.
    const claimed = t.neverExecuted ?? att.never_executed === 1;
    if (!claimed || t.state === "paid") fields.never_executed = 0;
    if (t.failureCode !== undefined) fields.failure_code = t.failureCode;
    this.l.setAttempt(att.request_id, fields);
    let cur = this.l.attempt(att.request_id);
    const h = this.handleFor(cur);
    if (cur.state === "held" && !cur.approval_id) await this.fillHeld(cur);
    if ((cur.state === "paid" || cur.state === "failed") && cur.correlation_id && h) {
      const ps = observedPayment ?? await h.paymentStatus(cur.correlation_id);
      const ev = ps.ok ? ps.value.evidence : null;
      const txHash = ev?.txHash ?? ev?.destinationTxHash ?? cur.tx_hash;
      const refundTxHash = ev?.refundTxHash ?? cur.refund_tx_hash;
      // Once observed, refund counterevidence must survive omitted fields and unavailable later reads.
      const refundedAmount = cur.refunded_amount ?? ev?.refundedAmount ?? null;
      const patch: Partial<AttemptRow> = { tx_hash: txHash, refund_tx_hash: refundTxHash, refunded_amount: refundedAmount, failure_code: (ps.ok ? ps.value.failureCode : null) ?? cur.failure_code };
      if (cur.state === "failed") {
        if (ps.ok && ps.value.status === "SUCCESS") {
          patch.state = "paid";
          patch.never_executed = 0;
        } else {
          // A refunded payment moved money even when its evidence omits the refund; retain that through every later read.
          const counterevidence = cur.counterevidence ?? (ps.ok && ps.value.status === "REFUNDED" ? "payment status REFUNDED" : null);
          // Only this read can hold proof: an unavailable one withdraws it until a later successful FAILED read.
          const consistent = ps.ok && ps.value.status === "FAILED";
          const proof = claimed && consistent && counterevidence === null && txHash === null && refundTxHash === null && refundedAmount === null;
          patch.never_executed = proof ? 1 : 0;
          patch.counterevidence = counterevidence;
          // A disputed closure keeps its monetary hold until the agency explicitly reviews newly arrived
          // non-execution evidence. A later successful payment is handled above under the same original identity.
          patch.state = cur.resolution === "disputed" ? "failed" : classifyFailed(cur.vote, txHash, proof);
        }
      }
      this.l.setAttempt(cur.request_id, patch);
      cur = this.l.attempt(cur.request_id);
    }
    if (t.alert) {
      this.l.event(cur.contract_id, "alert", t.alert);
      this.d.log(`ALERT ${cur.request_id}: ${t.alert}`);
    }
    if (cur.state !== att.state || cur.code !== att.code) this.l.event(cur.contract_id, eventKind(cur.state), attemptText(cur));
    if (cur.state === "blocked" && cur.code === "request_conflict" && h) await this.readConflict(cur, h);
  }

  /**
   * request_conflict: the platform recorded this id with other terms. Read what that record became and show it.
   * Information only: the attempt stays blocked and committed, and is never re-sent.
   */
  private async readConflict(att: AttemptRow, h: AgentHandle) {
    const st = await h.payoutStatus(att.request_id);
    this.l.setAttempt(att.request_id, { retry_at: new Date(this.d.now().getTime() + this.d.statusPollMs).toISOString() });
    if (!st.ok) return;
    const record = `${st.value.state}${st.value.status ? ` (${st.value.status})` : ""}`;
    if (record === att.platform_record) return;
    this.l.setAttempt(att.request_id, { platform_record: record });
    this.l.event(att.contract_id, "payout", `The platform's own record under ${att.request_id} (other terms) reads ${record}. Paperwork keeps its amount counted and never re-sends this id.`);
  }

  async fillHeld(att: AttemptRow) {
    const h = this.handleFor(att);
    if (!h || !att.correlation_id) return;
    const held = await h.held();
    const mine = held.ok ? held.value.find((x) => x.correlationId === att.correlation_id) : undefined;
    const ps = await h.paymentStatus(att.correlation_id);
    const approvalId = mine?.approvalId ?? (ps.ok ? ps.value.approvalId : null);
    this.l.setAttempt(att.request_id, { approval_id: approvalId ?? null, approval_expires_at: ps.ok ? ps.value.expiresAt : null });
  }

  /** Observe one live or unresolved attempt under its original identity and record what the platform answers. */
  /** Record a successful payout status read. The timer and a release decision observe the same answer the same way. */
  private async observe(att: AttemptRow, st: Extract<Res<PayoutAnswer>, { ok: true }>) {
    const changedBinding = st.value.requestId !== att.request_id ||
      (att.correlation_id !== null && st.value.correlationId !== null && st.value.correlationId !== att.correlation_id);
    if (att.state === "failed" && (changedBinding || (st.value.state !== "failed" && st.value.state !== "succeeded"))) {
      // A recorded failure cannot regress to a pre-execution refusal or missing/live record and free its hold.
      // Revoke stale proof and observe the original payment correlation; late success can still settle it.
      return this.transition(att, { state: "failed", code: att.code, failKind: null, neverExecuted: false });
    }
    if (changedBinding || (att.correlation_id && (st.value.state === "refused" || st.value.state === "not_found"))) return this.apply(att, st);
    if (st.value.state === "not_found") return this.send(att.request_id);
    const mapped = fromAnswer(st.value).state;
    if (mapped === att.state && (mapped === "held" || mapped === "processing" || mapped === "unknown")) {
      if (att.state === "held" && !att.approval_id) await this.fillHeld(att);
      return;
    }
    return this.apply(att, st);
  }

  /**
   * A confirmation made now that a failed payout never executed: the payout record must claim it under this attempt's
   * own request and payment identity, and the payment read that follows must agree. Whatever these reads show is
   * recorded through the normal transition, so counterevidence is kept even when the answer is no.
   */
  async confirmNeverExecuted(requestId: string): Promise<boolean> {
    const att = this.l.attempt(requestId);
    // Only a recorded failure is confirmed here; observing one never sends or re-sends a request.
    if (att.state !== "failed") return false;
    const st = await this.handleFor(att)?.payoutStatus(requestId);
    if (!st?.ok) return false;
    await this.observe(att, st);
    const claimed = st.value.requestId === requestId && st.value.state === "failed" && st.value.neverExecuted === true &&
      att.correlation_id !== null && (st.value.correlationId === null || st.value.correlationId === att.correlation_id);
    const cur = this.l.attempt(requestId);
    return claimed && cur.state === "failed" && cur.never_executed === 1 && cur.counterevidence === null &&
      cur.tx_hash === null && cur.refund_tx_hash === null && cur.refunded_amount === null;
  }

  async follow(att: AttemptRow) {
    // A DAO signature may have been submitted outside this app or while its process was stopped.
    for (const correlationId of this.l.pendingDaoSteps(att.request_id)) await this.d.onboarding.pollStep(correlationId);
    att = this.l.attempt(att.request_id);
    const h = this.handleFor(att);
    if (!h) return;
    const now = this.d.now().getTime();
    if (att.state === "blocked" && att.code === "request_conflict") {
      if (!att.retry_at || Date.parse(att.retry_at) <= now) await this.readConflict(att, h);
      return; // Other terms under this identity must never become this job's payment or cancellation.
    }
    if (this.l.jobForJudgment(att.run_id)?.changes && (att.state === "blocked" || att.state === "waiting")) {
      // Even preflight failures are observed first: no cancellation inference from an error or timeout.
      const status = await h.payoutStatus(att.request_id);
      if (status.ok) return this.apply(att, status);
      return;
    }
    if (att.state === "waiting" || att.state === "blocked") {
      if (att.retry_at && Date.parse(att.retry_at) > now) return;
      return this.send(att.request_id); // the same id, never a new one
    }
    const st = await h.payoutStatus(att.request_id);
    if (st.ok) return this.observe(att, st);
    // SDK 0.5.6 reads payouts/status under read; this fallback follows older/incompatible gateways by correlation.
    if (st.kind === "forbidden" && att.correlation_id) {
      const ps = await h.paymentStatus(att.correlation_id);
      if (!ps.ok) return;
      if (ps.value.status === "SUCCESS") return this.transition(att, { state: "paid", code: null, failKind: null }, ps);
      if (att.state === "failed" && ps.value.status !== "FAILED")
        return this.transition(att, { state: "failed", code: ps.value.failureCode, failKind: null, neverExecuted: false }, ps);
      if (ps.value.status === "FAILED" || ps.value.status === "REFUNDED") return this.transition(att, { state: "failed", code: ps.value.failureCode, failKind: null }, ps);
    }
  }
}
