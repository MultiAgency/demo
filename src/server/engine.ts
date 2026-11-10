import type { Database } from "bun:sqlite";
import { clauseFor } from "../shared/clauses";
import { canonicalJson, sha256Hex } from "../shared/canonical";
import { fromAtomic, toAtomic } from "../shared/money";
import { expectations, largestAtomic, policyDifferences, policyProblem, totalAtomic } from "../shared/policy-request";
import { endInstant, parseTerms, scopeTotal, startInstant, type Terms, TERMS_RECIPIENT, termsHash, termsSigningMessage, USDC_DECIMALS } from "../shared/terms";
import type { AttemptState, ContractView, EventView, JudgmentOutcome, NextStep, PayoutView, ScopeRow, SetupStage, VerifyView } from "../shared/views";
import type { Config } from "./config";
import type { AttemptRow, ContractRow, EventRow, JudgmentRow, LineRow, OwnerStepRow, PlatformAgentRow, SignatureRecord } from "./db";
import { type EvidenceSource, injectedPullRequest } from "./evidence/github";
import type { Judge, Judgment, Level } from "./judge";
import { nonceFromString, nonceToString, randomNonce, verifyNep413 } from "./nep413";
import { failError, Onboarding, stepView } from "./onboarding";
import {
  attackIdFor,
  classifyFailed,
  fromAnswer,
  fromFail,
  isCommitted,
  isOpen,
  isPaid,
  judgmentStep,
  KeyedMutex,
  latestAttempt,
  type Line,
  owedFor,
  planPayout,
  requestIdFor,
  neverRecorded,
  OPEN_STATES,
  sumLines,
  type Transition,
} from "./payouts";
import type { ChainReader, Overview, PayoutAnswer, Platform, Res } from "./platform/port";

export class UserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type Role = "representative" | "contractor";
export type Scenario = "overpay" | "redirect" | "after_end" | "injected";
export const SCENARIOS: Scenario[] = ["overpay", "redirect", "after_end", "injected"];

/** No new payout request this close to the end: a lost reply must still be followable under the payout consent. */
const END_MARGIN_MS = 10 * 60_000;
/** The payout grant must outlive a request by this much. The platform issues it for 30 days; contracts run up to 365. */
export const GRANT_MARGIN_MS = 24 * 3_600_000;

export interface Deps {
  db: Database;
  platform: Platform;
  chain: ChainReader;
  evidence: EvidenceSource;
  judge: Judge;
  config: Config;
  now: () => Date;
  /** Account used by the redirect attack (fake/stack only). */
  attacker: string;
  log?: (msg: string) => void;
}

export interface RunResult {
  outcome: "requested" | "nothing" | "deferred";
  judgment: (Judgment & { id: string; outcome: JudgmentOutcome }) | null;
  open_judgment: ContractView["open_judgment"];
  payouts: PayoutView[];
}

export interface AttackReport {
  scenario: Scenario;
  ready: boolean;
  story: string;
  hint?: string;
  request?: { recipient: string; amount_usd: string };
  outcome?: "refused" | "forbidden" | "held" | "blocked" | "allowed" | "unknown";
  code?: string | null;
  clause?: ReturnType<typeof clauseFor>;
  note?: string;
  payout?: PayoutView;
  pull_request?: unknown;
}

export class Covenant {
  readonly onboarding: Onboarding;
  private mutex = new KeyedMutex();
  private log: (msg: string) => void;

  constructor(private d: Deps) {
    this.log = d.log ?? ((m) => console.error(m));
    this.onboarding = new Onboarding({
      db: d.db,
      platform: d.platform,
      now: d.now,
      graceDays: d.config.consentGraceDays,
      event: (id, kind, text) => this.event(id, kind, text),
      contract: (id) => {
        const row = this.row(id);
        return { row, terms: this.terms(row) };
      },
    });
  }

  // ================================================================ contracts

  createContract(input: unknown): { id: string; contractorToken: string } {
    let terms: Terms;
    try {
      terms = parseTerms(input);
    } catch (err) {
      throw new UserError(formatZod(err));
    }
    const hash = termsHash(terms);
    if (this.d.db.query("SELECT 1 FROM contracts WHERE hash = ?").get(hash)) throw new UserError("A contract with exactly these terms already exists.", 409);
    const id = `c_${hash.slice(0, 12)}`;
    const contractorToken = sha256Hex(randomNonce()).slice(0, 32);
    this.d.db
      .query("INSERT INTO contracts (id, terms, hash, created_at, contractor_link_hash, organization) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, canonicalJson(terms), hash, this.nowIso(), sha256Hex(contractorToken), orgFor(id));
    this.event(id, "draft", `Draft created: ${terms.company} funds ${terms.scope.length} deliverables worth $${scopeTotal(terms)} for ${terms.contractor.name}, until ${terms.end}.`);
    return { id, contractorToken };
  }

  parties(id: string): { representative: string; contractor: string } {
    const t = this.terms(this.row(id));
    return { representative: t.representative.near_account, contractor: t.contractor.near_account };
  }

  /** Contracts the merge watcher runs: set up and not ended. A frozen one is re-read each time, so an unfreeze resumes it. */
  activeContractIds(): string[] {
    const rows = this.d.db.query("SELECT c.* FROM contracts c JOIN platform_agents a ON a.organization = c.organization WHERE a.stage = 'ready'").all() as ContractRow[];
    const now = this.d.now().getTime();
    return rows.filter((r) => now < Date.parse(endInstant(this.terms(r)))).map((r) => r.id);
  }

  /** Contracts with a live payout or attack to follow on the status timer. */
  followUpIds(): string[] {
    const rows = this.d.db.query("SELECT DISTINCT contract_id FROM payout_attempts WHERE state IN (" + OPEN_STATES.map((s) => `'${s}'`).join(",") + ")").all() as { contract_id: string }[];
    return rows.map((r) => r.contract_id);
  }

  listContracts(account?: string) {
    const all = this.d.db.query("SELECT * FROM contracts ORDER BY created_at DESC").all() as ContractRow[];
    return all
      .filter((r) => {
        if (!account) return true;
        const t = this.terms(r);
        return t.representative.near_account === account || t.contractor.near_account === account;
      })
      .map((r) => {
        const terms = this.terms(r);
        const attempts = this.attempts(r.id);
        return {
          id: r.id,
          company: terms.company,
          contractor: terms.contractor.name,
          payee: terms.payee.address,
          total: scopeTotal(terms),
          paid: usdOf(attempts.filter(isPaid).reduce((n, a) => n + BigInt(a.amount_atomic), 0n)),
          start: terms.start,
          end: terms.end,
          stage: this.stageOf(r, this.onboarding.agentRow(r.organization), null),
        };
      });
  }

  /** The view only: no follow-up, so no payout is planned or sent. */
  async viewContract(id: string): Promise<ContractView> {
    this.row(id);
    return this.view(id);
  }

  async getContract(id: string): Promise<ContractView> {
    this.row(id);
    await this.mutex.run(id, async () => {
      try {
        await this.followUpLocked(id);
      } catch (err) {
        this.log(`follow-up ${id}: ${errText(err)}`);
      }
    });
    return this.view(id);
  }

  // ================================================================ term signatures (NEP-413)

  signingRequest(id: string, role: Role) {
    const row = this.row(id);
    const terms = this.terms(row);
    return {
      role,
      account_id: role === "representative" ? terms.representative.near_account : terms.contractor.near_account,
      message: termsSigningMessage(row.hash),
      recipient: TERMS_RECIPIENT,
      nonce: nonceToString(randomNonce()),
    };
  }

  async addSignature(id: string, role: Role, signed: { account_id: string; public_key: string; signature: string; nonce: string }, contractorToken?: string) {
    const row = this.row(id);
    const terms = this.terms(row);
    const expected = role === "representative" ? terms.representative.near_account : terms.contractor.near_account;
    if (role === "contractor" && sha256Hex(contractorToken ?? "") !== row.contractor_link_hash) throw new UserError("This signing link is not valid for the contractor.", 403);
    if ((role === "representative" ? row.rep_sig : row.contractor_sig) !== null) throw new UserError(`The ${role} already signed.`, 409);
    if (signed.account_id.toLowerCase() !== expected) throw new UserError(`The ${role} must sign as ${expected}, not ${signed.account_id}.`, 403);
    const ok = verifyNep413({ message: termsSigningMessage(row.hash), nonce: nonceFromString(signed.nonce), recipient: TERMS_RECIPIENT }, signed);
    if (!ok) throw new UserError("The signature does not match these terms.", 400);
    if (!(await this.d.chain.isFullAccessKey(expected, signed.public_key))) throw new UserError(`${signed.public_key} is not a full-access key of ${expected}.`, 403);
    const record: SignatureRecord = { ...signed, account_id: expected, signed_at: this.nowIso() };
    this.d.db.query(`UPDATE contracts SET ${role === "representative" ? "rep_sig" : "contractor_sig"} = ? WHERE id = ?`).run(JSON.stringify(record), id);
    this.event(id, "signed", `${role === "representative" ? "Representative" : "Contractor"} ${expected} signed the terms hash.`);
    if (role === "contractor") {
      const registered = await this.d.chain.isRegistered(terms.asset, terms.payee.address).catch(() => null);
      this.d.db.query("UPDATE contracts SET payee_registered = ? WHERE id = ?").run(registered === null ? null : registered ? 1 : 0, id);
      if (registered === false) this.event(id, "warning", `${terms.payee.address} is not registered on the USDC token yet; payouts to it will be blocked until it registers.`);
    }
    return this.getContract(id);
  }

  // ================================================================ onboarding and owner steps

  async next(id: string): Promise<NextStep> {
    return this.mutex.run(id, async () => {
      await this.refreshFrozen(id);
      return this.onboarding.next(id);
    });
  }

  async signed(id: string, body: { step: "setup" | "consent_payout" | "consent_owner"; nonce: string; publicKey: string; signature: string }): Promise<NextStep> {
    return this.mutex.run(id, () => this.onboarding.signed(id, body));
  }

  ownerStepContract(correlationId: string): string | null {
    return this.onboarding.step(correlationId).contract_id;
  }

  async submitOwnerStep(correlationId: string, sig: { publicKey: string; signature: string }) {
    const contractId = this.ownerStepContract(correlationId);
    const work = async () => {
      const s = await this.onboarding.submitStep(correlationId, sig);
      if (s.kind === "approval_vote" && s.request_id && (s.state === "submitted" || s.state === "unknown")) {
        // The vote is recorded as soon as owner/submit answered (or its reply was lost): a later FAILED with no tx
        // is then provably our reject. The payout itself is followed through payouts/status, not owner/status.
        const att = this.attempt(s.request_id);
        this.setAttempt(att.request_id, { vote: s.verdict as "approve" | "reject" });
        this.event(att.contract_id, "vote", `The representative signed ${s.verdict === "approve" ? "an approval" : "a rejection"} of ${usdText(att.amount_atomic)} (${att.request_id}).`);
        await this.followAttempt(this.attempt(att.request_id));
        if (att.kind === "payout") await this.advanceJudgment(att.contract_id);
      }
      return this.ownerStepView(this.onboarding.step(correlationId));
    };
    return contractId ? this.mutex.run(contractId, work) : work();
  }

  async getOwnerStep(correlationId: string) {
    const contractId = this.ownerStepContract(correlationId);
    const work = async () => this.ownerStepView(await this.onboarding.pollStep(correlationId));
    return contractId ? this.mutex.run(contractId, work) : work();
  }

  private ownerStepView(s: OwnerStepRow) {
    return {
      correlation_id: s.correlation_id,
      kind: s.kind,
      state: s.state,
      failure_code: s.failure_code,
      request_id: s.request_id,
      verdict: s.verdict,
      summary: s.summary,
      expires_at: s.expires_at,
      confirm_url: s.confirm_url,
    };
  }

  async deposit(id: string) {
    const a = this.readyAgent(id);
    const res = await this.onboarding.handle(a).deposit();
    if (!res.ok) throw failError(res, "the deposit request");
    this.onboarding.setAgent(a.organization, { deposit: JSON.stringify(res.value) });
    return res.value;
  }

  // ================================================================ the agent's run

  async run(id: string): Promise<RunResult> {
    return this.mutex.run(id, () => this.runLocked(id));
  }

  private async runLocked(id: string): Promise<RunResult> {
    await this.refreshFrozen(id);
    const row = this.row(id);
    const terms = this.terms(row);
    this.requireActive(row, terms);
    await this.followUpLocked(id);
    const open = this.openJudgment(id);
    if (open) {
      this.event(id, "deferred", "Agent run deferred: the previous judgment is still open (waiting on its payout). Nothing was judged or requested.");
      return { outcome: "deferred", judgment: null, open_judgment: this.openJudgmentView(id, terms), payouts: [] };
    }

    const window = this.window(terms);
    const reviews = this.prReviews(id);
    const prs = (await this.d.evidence.mergedPullRequests({ repos: terms.repos, author: terms.contractor.github, since: window.since, until: window.until })).filter(
      (p) => reviews.get(`${p.repo}#${p.number}`) !== "rejected",
    );
    const judgment = await this.d.judge.judge(terms, prs, this.acceptedCompletion(id), window);
    const openFlags = judgment.prs.filter((p) => p.eligible && p.flags.length > 0 && reviews.get(p.key) !== "approved");
    if (judgment.decision === "escalate" && openFlags.length === 0 && judgment.prs.some((p) => p.flags.length > 0)) {
      judgment.decision = "pay";
      judgment.summary = `${judgment.deliverables.filter((x) => x.completion > 0).length} of ${terms.scope.length} deliverables have merged work (flags already reviewed).`;
    }

    const runId = `r_${sha256Hex(randomNonce()).slice(0, 12)}`;
    const now = this.nowIso();
    const plan = planPayout(terms, completionOf(judgment), this.committedBy(id));
    if (!plan) {
      this.d.db.query("INSERT INTO judgments (id, contract_id, at, json, outcome, closed_at) VALUES (?, ?, ?, ?, 'nothing', ?)").run(runId, id, now, JSON.stringify(judgment), now);
      this.event(id, "run", `Agent run: nothing new is owed. ${judgment.summary}`);
      return { outcome: "nothing", judgment: { ...judgment, id: runId, outcome: "nothing" }, open_judgment: null, payouts: [] };
    }
    const seq = this.nextSeq(id, "payout");
    const rid = requestIdFor(row.hash, seq, 1);
    this.d.db.transaction(() => {
      this.d.db.query("INSERT INTO judgments (id, contract_id, at, json, outcome) VALUES (?, ?, ?, ?, 'pending')").run(runId, id, now, JSON.stringify(judgment));
      this.insertAttempt({ request_id: rid, kind: "payout", contract_id: id, seq, attempt: 1, run_id: runId, recipient: terms.payee.address, amount: plan.amount, lines: plan.lines });
    })();
    const flagged = openFlags.length ? ` Flagged for the approver: ${openFlags.map((p) => `${p.key} (${p.flags.join(", ")})`).join("; ")}.` : "";
    this.event(id, "run", `Agent judged the merged work and requests ${usdText(plan.amount)} for ${plan.lines.map((l) => l.deliverable_id).join(", ")}. The platform holds it for the representative's approval.${flagged}`);
    await this.send(rid);
    return {
      outcome: "requested",
      judgment: { ...judgment, id: runId, outcome: this.judgmentRow(runId)!.outcome },
      open_judgment: this.openJudgmentView(id, terms),
      payouts: this.attempts(id).filter((a) => a.run_id === runId).map((a) => this.payoutView(a)),
    };
  }

  /** Rep: after a recorded refusal, attempt+1 (re-planned); for a blocked/waiting attempt, re-ask the same id now. */
  async retry(id: string) {
    return this.mutex.run(id, async () => {
      const j = this.openJudgment(id);
      if (!j) throw new UserError("There is no open judgment to retry.", 409);
      const last = latestAttempt(this.attempts(id).filter((a) => a.run_id === j.id && a.kind === "payout"));
      if (!last) throw new UserError("The open judgment has no payout yet.", 409);
      if (last.state === "refused") {
        this.event(id, "retry", `The representative retries after the refusal (${last.code}).`);
        await this.newAttempt(j, last.seq, last.attempt + 1, false);
      } else if ((last.state === "blocked" && last.code !== "request_conflict") || last.state === "waiting") {
        await this.send(last.request_id);
        await this.advanceJudgment(id);
      } else throw new UserError(`The latest payout is ${last.state}; there is nothing to retry.`, 409);
      return this.view(id);
    });
  }

  /** Rep: close the open judgment as dropped. Its PRs are judged again next run. */
  async drop(id: string) {
    return this.mutex.run(id, async () => {
      const j = this.openJudgment(id);
      if (!j) throw new UserError("There is no open judgment to drop.", 409);
      const open = this.attempts(id).filter((a) => a.run_id === j.id && isOpen(a));
      if (open.some((a) => !neverRecorded(a))) throw new UserError("A payout of this judgment is still live. Reject it in the approval instead.", 409);
      // Blocked before the platform recorded anything: nothing was sent under these ids, so they free their amounts.
      for (const a of open) this.setAttempt(a.request_id, { state: "dropped", retry_at: null });
      this.closeJudgment(j, "dropped");
      return this.view(id);
    });
  }

  /** Rep: resolve a failed payout after checking the evidence. */
  async resolve(requestId: string, outcome: "arrived" | "reowe" | "rejected") {
    const att = this.attempt(requestId);
    return this.mutex.run(att.contract_id, async () => {
      const a = this.attempt(requestId);
      if (a.kind !== "payout" || a.state !== "failed" || a.resolution !== null) throw new UserError("Only an unresolved failed payout can be resolved.", 409);
      this.setAttempt(requestId, { resolution: outcome });
      const text = { arrived: "the money arrived; it stays paid", reowe: "nothing arrived; it is owed again", rejected: "it was rejected; its work is excluded" }[outcome];
      this.event(a.contract_id, "resolve", `The representative resolved the failed payout ${requestId}: ${text}.`);
      if (outcome === "rejected" && a.run_id) {
        const j = this.judgmentRow(a.run_id);
        if (j?.outcome === "pending") this.closeJudgment(j, "rejected");
      }
      await this.advanceJudgment(a.contract_id);
      return this.view(a.contract_id);
    });
  }

  // ================================================================ approval votes

  async vote(requestId: string, verdict: "approve" | "reject") {
    const first = this.attempt(requestId);
    return this.mutex.run(first.contract_id, async () => {
      let att = this.attempt(requestId);
      if (att.state !== "held") throw new UserError(`This payout is ${att.state}, not waiting for approval.`, 409);
      if (!att.approval_id) {
        await this.fillHeld(att);
        att = this.attempt(requestId);
      }
      if (!att.approval_id || !att.correlation_id) throw new UserError("The platform has not shown this approval yet. Try again shortly.", 409);
      const row = this.row(att.contract_id);
      const terms = this.terms(row);
      const a = this.onboarding.agentRow(row.organization)!;
      const step = await this.onboarding.prepare(att.contract_id, a, { type: "approval_vote", approvalId: att.approval_id, verdict, correlationId: att.correlation_id }, { request_id: requestId, verdict });
      const payment = step.payment_terms ? (JSON.parse(step.payment_terms) as { terms: { recipient: string; asset: string; amount: string; chain?: string } | null }) : null;
      const t = payment?.terms ?? null;
      if (verdict === "approve") {
        const ok = !!t && t.recipient === terms.payee.address && t.recipient === att.recipient && t.asset === terms.asset && t.amount === att.amount_atomic && (t.chain === undefined || t.chain === "near");
        if (!ok) {
          this.d.db.query("UPDATE owner_steps SET state = 'failed', failure_code = 'terms_mismatch', updated_at = ? WHERE correlation_id = ?").run(this.nowIso(), step.correlation_id);
          this.event(att.contract_id, "alert", `Refused to approve ${requestId}: the platform's proven terms ${t ? `${t.amount} to ${t.recipient}` : "(none)"} don't match ${att.amount_atomic} to ${terms.payee.address}.`);
          this.log(`ALERT approve-terms mismatch for ${requestId}`);
          throw new UserError("The platform's terms for this approval don't match the payout. Not approving.", 409);
        }
      }
      this.setAttempt(requestId, { vote_correlation_id: step.correlation_id });
      const view = stepView(step, a.owner, verdict === "approve" ? "Approve this payout" : "Reject this payout");
      return {
        correlation_id: step.correlation_id,
        sign: view.kind === "owner_step" ? (view.sign ?? null) : null,
        confirm: view.kind === "owner_step" ? (view.confirm ?? null) : null,
        terms: t,
        flags: this.payoutView(this.attempt(requestId)).prs.filter((p) => p.flags.length > 0),
        summary: step.summary,
      };
    });
  }

  // ================================================================ request, follow-up, judgment lifecycle

  /** Ask the platform for this attempt's request id. Rows are always written before this is called. */
  private async send(requestId: string) {
    const att = this.attempt(requestId);
    const row = this.row(att.contract_id);
    const terms = this.terms(row);
    const a = this.onboarding.agentRow(row.organization);
    if (!a?.agent) return this.transition(att, { state: "blocked", code: "setup", failKind: "blocked", retryAfterMs: this.d.config.statusPollMs });
    let expected: { revision: number; digest: string } | null = null;
    if (att.kind === "payout") {
      const pre = await this.preflight(row, terms, a);
      if ("state" in pre) {
        if (pre.alert && att.state === pre.state && att.code === pre.code) delete pre.alert; // said once, not on every re-check
        return this.transition(att, pre);
      }
      expected = pre.expected;
    } else {
      // Attacks: a compromised server skips Covenant's checks; only the platform stands in the way.
      const o = await this.onboarding.handle(a).overview();
      expected = o.ok && o.value.revision !== null && o.value.digest !== null ? { revision: o.value.revision, digest: o.value.digest } : { revision: a.policy_revision ?? 0, digest: a.policy_digest ?? "" };
    }
    const res = await this.onboarding.handle(a).requestPayout({ requestId, recipient: att.recipient, amount: att.amount_atomic, expectedPolicy: expected });
    await this.apply(att, res);
  }

  /**
   * Before every payout request: active, not near the end, and the whole live policy matches what Covenant signed.
   * Any other policy, whichever revision it is, blocks the request (`policy_mismatch`) until it matches again.
   */
  private async preflight(row: ContractRow, terms: Terms, a: PlatformAgentRow): Promise<{ expected: { revision: number; digest: string } } | Transition> {
    const blocked = (code: string): Transition => ({ state: "blocked", code, failKind: "blocked", retryAfterMs: this.d.config.statusPollMs });
    if (a.stage === "needs_grant" && a.policy_revision !== null) return blocked("grant_expired"); // waiting for the re-issued grant
    if (a.stage !== "ready") return blocked("setup");
    if (this.d.now().getTime() >= Date.parse(endInstant(terms)) - END_MARGIN_MS) return blocked("contract_ending");
    const o = await this.onboarding.handle(a).overview();
    if (!o.ok) return row.frozen ? blocked("frozen") : { state: "waiting", code: "overview_unavailable", failKind: null, retryAfterMs: 60_000 };
    this.syncFrozen(row, o.value);
    const problem = policyProblem(o.value, terms);
    if (problem) {
      if (problem.code === "policy_mismatch") return { ...blocked(problem.code), alert: `${problem.detail} Nothing is requested until it matches again.` };
      return problem.waiting ? { state: "waiting", code: problem.code, failKind: null, retryAfterMs: 60_000 } : blocked(problem.code);
    }
    if (o.value.revision === null || o.value.digest === null) return { state: "waiting", code: "policy_not_in_force", failKind: null, retryAfterMs: 60_000 };
    if (!liveGrant(o.value, this.d.now().getTime() + GRANT_MARGIN_MS)) {
      this.onboarding.grantExpired(row.id, a);
      return blocked("grant_expired");
    }
    if (o.value.revision !== a.policy_revision || o.value.digest !== a.policy_digest) {
      // A new revision that still matches the signed terms in full: record it as the reviewed one.
      this.onboarding.setAgent(a.organization, { policy_revision: o.value.revision, policy_digest: o.value.digest });
      this.event(row.id, "policy", `Policy revision ${o.value.revision} still matches the signed terms in full; Covenant continues under it.`);
    }
    return { expected: { revision: o.value.revision, digest: o.value.digest } };
  }

  private async apply(att: AttemptRow, res: Res<PayoutAnswer>) {
    if (!res.ok) return this.transition(att, fromFail(res, this.d.config.statusPollMs));
    const t = fromAnswer(res.value);
    if (t.reask) return this.send(att.request_id); // never recorded: the same id again
    await this.transition(att, t);
  }

  /** Record a transition, then fetch what the new state needs (approval id, evidence). */
  private async transition(att: AttemptRow, t: Transition) {
    const fields: Partial<AttemptRow> = {
      state: t.state,
      code: t.code,
      fail_kind: t.failKind,
      retry_at: t.retryAfterMs !== undefined ? new Date(this.d.now().getTime() + t.retryAfterMs).toISOString() : null,
    };
    if (t.correlationId) fields.correlation_id = t.correlationId;
    this.setAttempt(att.request_id, fields);
    let cur = this.attempt(att.request_id);
    const h = this.handleFor(cur);
    if (cur.state === "held" && !cur.approval_id) await this.fillHeld(cur);
    if ((cur.state === "paid" || cur.state === "failed") && cur.correlation_id && h) {
      const ps = await h.paymentStatus(cur.correlation_id);
      const ev = ps.ok ? ps.value.evidence : null;
      const patch: Partial<AttemptRow> = { tx_hash: ev?.txHash ?? null, refund_tx_hash: ev?.refundTxHash ?? null, failure_code: ps.ok ? ps.value.failureCode : null };
      if (cur.state === "failed") {
        if (!ps.ok) patch.state = "failed"; // can't prove nothing moved without the evidence
        else patch.state = classifyFailed(cur.vote, ev?.txHash ?? null);
      }
      this.setAttempt(cur.request_id, patch);
      cur = this.attempt(cur.request_id);
    }
    if (t.alert) {
      this.event(cur.contract_id, "alert", t.alert);
      this.log(`ALERT ${cur.request_id}: ${t.alert}`);
    }
    if (cur.state !== att.state || cur.code !== att.code) this.event(cur.contract_id, eventKind(cur.state), this.stateText(cur));
  }

  private async fillHeld(att: AttemptRow) {
    const h = this.handleFor(att);
    if (!h || !att.correlation_id) return;
    const held = await h.held();
    const mine = held.ok ? held.value.find((x) => x.correlationId === att.correlation_id) : undefined;
    const ps = await h.paymentStatus(att.correlation_id);
    const approvalId = mine?.approvalId ?? (ps.ok ? ps.value.approvalId : null);
    this.setAttempt(att.request_id, { approval_id: approvalId ?? null, approval_expires_at: ps.ok ? ps.value.expiresAt : null });
  }

  /** Follow every live attempt of a contract, then move its open judgment along. Caller holds the mutex. */
  private async followUpLocked(id: string) {
    for (const att of this.attempts(id)) {
      if (OPEN_STATES.includes(att.state)) {
        try {
          await this.followAttempt(att);
        } catch (err) {
          this.log(`follow ${att.request_id}: ${errText(err)}`);
        }
      }
    }
    await this.advanceJudgment(id);
  }

  private async followAttempt(att: AttemptRow) {
    const h = this.handleFor(att);
    if (!h) return;
    const now = this.d.now().getTime();
    if (att.state === "waiting" || att.state === "blocked") {
      if (att.code === "request_conflict") return;
      if (att.retry_at && Date.parse(att.retry_at) > now) return;
      return this.send(att.request_id); // the same id, never a new one
    }
    const st = await h.payoutStatus(att.request_id);
    if (st.ok) {
      if (st.value.state === "not_found") return this.send(att.request_id);
      const mapped = fromAnswer(st.value).state;
      if (mapped === att.state && (mapped === "held" || mapped === "processing" || mapped === "unknown")) {
        if (att.state === "held" && !att.approval_id) await this.fillHeld(att);
        return;
      }
      return this.apply(att, st);
    }
    // payouts/status needs the payout scope; after the end only `read` is left, so follow the payment by correlation.
    if (st.kind === "forbidden" && att.correlation_id) {
      const ps = await h.paymentStatus(att.correlation_id);
      if (!ps.ok) return;
      if (ps.value.status === "SUCCESS") return this.transition(att, { state: "paid", code: null, failKind: null });
      if (ps.value.status === "FAILED" || ps.value.status === "REFUNDED") return this.transition(att, { state: "failed", code: ps.value.failureCode, failKind: null });
    }
  }

  /** Move the open judgment: close it, request the next seq, re-ask after reowe, or one automatic retry. */
  private async advanceJudgment(id: string) {
    for (let guard = 0; guard < 5; guard++) {
      const j = this.openJudgment(id);
      if (!j) return;
      const terms = this.terms(this.row(id));
      const mine = this.attempts(id).filter((a) => a.run_id === j.id && a.kind === "payout");
      const owed = this.owedTotal(id, terms, j);
      const step = judgmentStep(mine, owed);
      const last = latestAttempt(mine);
      switch (step.kind) {
        case "wait":
        case "rep":
          return;
        case "close":
          this.closeJudgment(j, step.outcome);
          return;
        case "next_seq":
          if (!(await this.newAttempt(j, this.nextSeq(id, "payout"), 1, false))) return;
          break;
        case "reowe":
          if (!(await this.newAttempt(j, last!.seq, last!.attempt + 1, false))) return;
          break;
        case "auto_retry":
          this.event(id, "retry", `The platform refused with ${last!.code}; Covenant re-read the policy and retries once.`);
          if (!(await this.newAttempt(j, last!.seq, last!.attempt + 1, true))) return;
          break;
      }
    }
  }

  /** Plan and write a new attempt for the open judgment (rows first), then send it. False when nothing is owed. */
  private async newAttempt(j: JudgmentRow, seq: number, attempt: number, auto: boolean): Promise<boolean> {
    const row = this.row(j.contract_id);
    const terms = this.terms(row);
    const plan = planPayout(terms, completionOf(JSON.parse(j.json) as Judgment), this.committedBy(j.contract_id));
    if (!plan) {
      const mine = this.attempts(j.contract_id).filter((a) => a.run_id === j.id);
      this.closeJudgment(j, mine.some(isPaid) ? "approved" : "nothing");
      return false;
    }
    const rid = requestIdFor(row.hash, seq, attempt);
    this.d.db.transaction(() => {
      this.insertAttempt({ request_id: rid, kind: "payout", contract_id: j.contract_id, seq, attempt, run_id: j.id, recipient: terms.payee.address, amount: plan.amount, lines: plan.lines, auto });
    })();
    this.event(j.contract_id, "request", `Requesting ${usdText(plan.amount)} for ${plan.lines.map((l) => l.deliverable_id).join(", ")} (${rid}).`);
    await this.send(rid);
    return true;
  }

  private closeJudgment(j: JudgmentRow, outcome: "approved" | "rejected" | "dropped" | "nothing") {
    const now = this.nowIso();
    this.d.db.query("UPDATE judgments SET outcome = ?, closed_at = ? WHERE id = ? AND outcome = 'pending'").run(outcome, now, j.id);
    const judgment = JSON.parse(j.json) as Judgment;
    const eligible = judgment.prs.filter((p) => p.eligible);
    if (outcome === "approved") {
      for (const p of eligible)
        this.d.db.query("INSERT INTO pr_reviews (contract_id, pr_key, verdict, at) VALUES (?, ?, 'approved', ?) ON CONFLICT(contract_id, pr_key) DO UPDATE SET verdict = 'approved', at = excluded.at").run(j.contract_id, p.key, now);
      this.event(j.contract_id, "judgment", "Judgment approved: every payout of it was approved and paid. Its completion now carries forward.");
    } else if (outcome === "rejected") {
      const excluded: string[] = [];
      for (const p of eligible) {
        const r = this.d.db.query("INSERT INTO pr_reviews (contract_id, pr_key, verdict, at) VALUES (?, ?, 'rejected', ?) ON CONFLICT(contract_id, pr_key) DO NOTHING").run(j.contract_id, p.key, now);
        if (r.changes > 0) excluded.push(p.key);
      }
      this.event(j.contract_id, "judgment", `Judgment rejected. ${excluded.length ? `Excluded from future runs: ${excluded.join(", ")}.` : "No new pull requests to exclude."} Money already paid stays paid.`);
    } else if (outcome === "dropped") {
      this.event(j.contract_id, "judgment", "Judgment dropped by the representative. Its pull requests will be judged again on the next run.");
    }
  }

  // ================================================================ contractor verification

  async verify(id: string): Promise<VerifyView> {
    const row = this.row(id);
    const terms = this.terms(row);
    const expected = expectations(terms);
    const checks: VerifyView["checks"] = [];
    checks.push({ id: "terms", label: "Terms hash matches the terms", ok: termsHash(terms) === row.hash });
    for (const role of ["representative", "contractor"] as const) {
      const s = sig(role === "representative" ? row.rep_sig : row.contractor_sig);
      const ok = !!s && verifyNep413({ message: termsSigningMessage(row.hash), nonce: nonceFromString(s.nonce), recipient: TERMS_RECIPIENT }, s) && (await this.d.chain.isFullAccessKey(s.account_id, s.public_key));
      checks.push({ id: `sig-${role}`, label: `${role === "representative" ? "Representative" : "Contractor"} signature verifies with a full-access key`, ok, detail: s?.account_id });
    }
    const a = this.onboarding.agentRow(row.organization);
    let observed: Overview | null = null;
    let consents: VerifyView["consents"] = [];
    if (a?.agent && a.agent_id) {
      const h = this.onboarding.handle(a);
      const o = await h.overview();
      observed = o.ok ? o.value : null;
      const cs = await this.d.platform.listConsents(row.organization);
      consents = cs.ok ? cs.value.filter((c) => c.agentId === a.agent_id) : []; // the setup consent is listed too ("unborn")
    }
    if (!observed) {
      return { overall: "incomplete", checks: [...checks, { id: "platform", label: "The platform agent is set up", ok: false, detail: a?.agent_id ? "The platform did not answer." : "Not set up yet." }], expected, observed, consents };
    }
    const p = observed.policy;
    const now = this.d.now().getTime();
    const largest = largestAtomic(terms);
    const payoutConsent = consents.find((c) => c.id === a!.payout_consent_id) ?? consents.find((c) => c.scopes.includes("payout") && !c.revoked);
    const grant = liveGrant(observed, now);
    checks.push(
      { id: "applied", label: "Policy is applied, synced and in force", ok: observed.status === "APPLIED" && observed.synced && observed.notInForce === null, detail: observed.notInForce ?? undefined },
      { id: "actions", label: "The agent can only withdraw", ok: !!p && p.actions.length === 1 && p.actions[0] === "withdraw", detail: p ? p.actions.join(", ") : undefined },
      { id: "assets", label: "USDC is the only asset", ok: !!p && Array.isArray(p.assets) && p.assets.length === 1 && p.assets[0] === terms.asset },
      { id: "payee", label: `Withdrawals go only to ${terms.payee.address}`, ok: !!p && p.withdrawals.length === 1 && p.withdrawals[0]?.toLowerCase() === terms.payee.address, detail: p?.withdrawals.join(", ") },
      { id: "cap", label: "No single payment above the largest deliverable", ok: p?.limits.per_transaction?.[terms.asset] === largest, detail: p?.limits.per_transaction?.[terms.asset] },
      { id: "approval", label: "Every payout waits for the representative's approval", ok: !!p?.owner_approval },
      { id: "frozen", label: "The agent is not frozen", ok: !!p && !p.frozen },
      { id: "grant", label: "A live payout grant exists", ok: !!grant, detail: grant ? `The platform chose its expiry: ${grant.expiresAt}` : undefined },
      {
        id: "consent",
        label: "Covenant's payout access ends at or before the contract end",
        ok: !!payoutConsent && !payoutConsent.revoked && Date.parse(payoutConsent.expiresAt) > now && Date.parse(payoutConsent.expiresAt) <= Date.parse(endInstant(terms)),
        detail: payoutConsent?.expiresAt,
      },
    );
    const paid = this.attempts(id).filter(isPaid).reduce((n, x) => n + BigInt(x.amount_atomic), 0n);
    const balance = BigInt(observed.usdc || "0");
    checks.push(
      { id: "funded", label: "Paid plus balance is within the funded scope total", ok: paid + balance <= BigInt(totalAtomic(terms)), info: true, detail: `paid ${usdText(paid)} + balance ${usdText(balance)} of ${usdText(totalAtomic(terms))}` },
      { id: "signed", label: "The whole live policy matches what both parties signed (limits and USD budget included)", ok: !!p && policyDifferences(p, terms).length === 0, detail: p ? policyDifferences(p, terms).join("; ") || undefined : undefined },
      { id: "relay", label: "Covenant relays the platform's read of the policy", ok: true, info: true },
    );
    const real = checks.filter((c) => !c.info);
    return { overall: real.every((c) => c.ok) ? "green" : "red", checks, expected, observed, consents };
  }

  // ================================================================ "compromised server" attack panel

  async attack(id: string, scenario: Scenario): Promise<AttackReport> {
    if (!SCENARIOS.includes(scenario)) throw new UserError("Unknown scenario", 404);
    if (this.d.platform.mode === "remote" && !this.d.config.stackDir) throw new UserError("Attacks run only against the platform stand-in or a local stack, never a real deployment.", 403);
    return this.mutex.run(id, async () => {
      const row = this.row(id);
      const terms = this.terms(row);
      const a = this.onboarding.agentRow(row.organization);
      if (!a || a.stage !== "ready") throw new UserError("Set up the contract's agent first.");
      const largest = BigInt(largestAtomic(terms));
      const one = toAtomic("1", USDC_DECIMALS);
      let recipient = terms.payee.address;
      let amount = one;
      let story: string;
      let extra: Partial<AttackReport> = {};
      switch (scenario) {
        case "redirect":
          recipient = this.d.attacker;
          story = `Send $1.00 to ${this.d.attacker} instead of the payee.`;
          break;
        case "overpay":
          amount = largest + one;
          story = `Pay ${usdText(amount)} in one payment; the largest deliverable is worth ${usdText(largest)}.`;
          break;
        case "after_end":
          if (this.d.now().getTime() <= Date.parse(endInstant(terms)))
            return { scenario, ready: false, story: "Pay $1.00 after the contract ended.", hint: "Fast-forward the clock past the end date, then try again." };
          story = `Pay $1.00 on ${this.nowIso().slice(0, 10)}, after the contract ended on ${terms.end}.`;
          break;
        case "injected": {
          const o = await this.onboarding.handle(a).overview();
          const balance = o.ok ? BigInt(o.value.usdc || "0") : 0n;
          amount = balance < largest ? balance : largest;
          if (amount <= 0n) return { scenario, ready: false, story: "A fooled judge asks for an in-cap payment.", hint: "The wallet has no balance left to attack." };
          story = `A pull request hides instructions for the AI reviewer. Suppose the judge is fooled and asks for ${usdText(amount)}, inside every limit.`;
          extra = { pull_request: injectedPullRequest(terms.repos[0]!, terms.contractor.github, this.nowIso()) };
          break;
        }
      }
      const seq = this.nextSeq(id, "attack");
      const rid = attackIdFor(scenario, sha256Hex(randomNonce()));
      this.d.db.transaction(() => {
        this.insertAttempt({ request_id: rid, kind: "attack", contract_id: id, seq, attempt: 1, run_id: null, recipient, amount, lines: [], scenario });
      })();
      await this.send(rid);
      const att = this.attempt(rid);
      const outcome: AttackReport["outcome"] =
        att.state === "refused" ? "refused" : att.fail_kind === "forbidden" ? "forbidden" : att.state === "held" ? "held" : att.state === "blocked" ? "blocked" : att.state === "unknown" ? "unknown" : "allowed";
      const view = this.payoutView(att);
      const note = outcome === "held" ? "NOT STOPPED by policy — the approval is the second layer. Reject it." : undefined;
      this.event(id, "attack", `Attack "${scenario}": ${outcome === "held" ? "NOT STOPPED by policy; held for the representative's approval" : outcome === "allowed" ? "NOT STOPPED" : `stopped (${att.code})`}.`);
      return { scenario, ready: true, story, request: { recipient, amount_usd: usdOf(amount) }, outcome, code: att.code, clause: view.clause, note, payout: view, ...extra };
    });
  }

  // ================================================================ views

  private async view(id: string): Promise<ContractView> {
    const row = this.row(id);
    const terms = this.terms(row);
    const a = this.onboarding.agentRow(row.organization);
    let ov: Overview | null = null;
    if (a?.agent && a.agent_id) {
      const o = await this.onboarding.handle(a).overview();
      ov = o.ok ? o.value : null;
      if (ov) this.syncFrozen(row, ov);
    }
    const attempts = this.attempts(id);
    const payoutsOnly = attempts.filter((x) => x.kind === "payout");
    const paid = payoutsOnly.filter(isPaid).reduce((n, x) => n + BigInt(x.amount_atomic), 0n);
    const committed = payoutsOnly.filter(isCommitted).reduce((n, x) => n + BigInt(x.amount_atomic), 0n);
    const open = this.openJudgmentView(id, terms);
    const latest = this.d.db.query("SELECT * FROM judgments WHERE contract_id = ? ORDER BY rowid DESC LIMIT 1").get(id) as JudgmentRow | null;
    const stage = this.stageOf(this.row(id), a, ov);
    return {
      id: row.id,
      hash: row.hash,
      terms,
      organization: row.organization,
      now: this.nowIso(),
      stage,
      next_step: this.peekNext(a, stage),
      payee_registered: row.payee_registered === null ? null : row.payee_registered === 1,
      signatures: { representative: sigView(row.rep_sig), contractor: sigView(row.contractor_sig) },
      platform: {
        mode: this.d.platform.mode,
        host: this.d.platform.host,
        agent: a?.agent ?? null,
        agent_id: a?.agent_id ?? null,
        consents: a?.payout_consent_expires_at && a.owner_consent_expires_at ? { payout_expires_at: a.payout_consent_expires_at, owner_expires_at: a.owner_consent_expires_at } : null,
        policy: ov && ov.revision !== null ? { revision: ov.revision, digest: ov.digest, applied: ov.status === "APPLIED" && ov.synced && ov.notInForce === null } : null,
        balance_usd: ov ? usdOf(ov.usdc || "0") : null,
        deposit: a?.deposit ? JSON.parse(a.deposit) : null,
      },
      total_usd: scopeTotal(terms),
      paid_usd: usdOf(paid),
      committed_usd: usdOf(committed),
      owed_usd: open?.owed_usd ?? "0",
      scope: this.scopeView(id, terms, attempts),
      judgment: latest ? { ...(JSON.parse(latest.json) as Judgment), id: latest.id, at: latest.at, outcome: latest.outcome } : null,
      open_judgment: open,
      payouts: attempts.map((x) => this.payoutView(x)),
      events: this.events(id),
    };
  }

  /** The next step without side effects: a stored sign request or a prepared owner step. POST onboarding/next makes new ones. */
  private peekNext(a: PlatformAgentRow | null, stage: SetupStage): NextStep | null {
    if (!a || stage === "needs_signatures" || stage === "active" || stage === "needs_funding" || stage === "ended" || stage === "frozen") return null;
    if (a.pending_sign) {
      const p = JSON.parse(a.pending_sign) as { step: "setup" | "consent_payout" | "consent_owner"; message: string; nonce: string; recipient: string };
      return { kind: "sign", step: p.step, label: "Sign in your wallet", sign: { account_id: a.owner, message: p.message, recipient: p.recipient, nonce: p.nonce } };
    }
    const s = this.d.db.query("SELECT * FROM owner_steps WHERE organization = ? AND kind != 'approval_vote' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(a.organization) as OwnerStepRow | null;
    if (s && s.state === "prepared") return stepView(s, a.owner, "Sign in your wallet");
    return null;
  }

  private payoutView(p: AttemptRow): PayoutView {
    const terms = this.terms(this.row(p.contract_id));
    const lines = this.d.db.query("SELECT * FROM payout_lines WHERE request_id = ?").all(p.request_id) as LineRow[];
    const j = p.run_id ? this.judgmentOf(p.run_id) : null;
    const ids = new Set(lines.map((l) => l.deliverable_id));
    const prs =
      p.kind === "attack" && p.scenario === "injected"
        ? [{ ...pick(injectedPullRequest(terms.repos[0]!, terms.contractor.github, p.created_at)), flags: ["possible_prompt_injection"] }]
        : (j?.prs ?? []).filter((x) => x.eligible && ((x.deliverable && ids.has(x.deliverable)) || x.flags.length > 0)).map((x) => ({ key: x.key, title: x.title, url: x.url, flags: x.flags }));
    const state: AttemptState = p.state === "failed" && p.resolution !== null ? "resolved" : p.state;
    return {
      request_id: p.request_id,
      kind: p.kind,
      seq: p.seq,
      attempt: p.attempt,
      state,
      amount_usd: usdOf(p.amount_atomic),
      recipient: p.recipient,
      lines: lines.map((l) => ({ deliverable_id: l.deliverable_id, title: terms.scope.find((d) => d.id === l.deliverable_id)?.title ?? l.deliverable_id, amount_usd: usdOf(l.amount_atomic) })),
      code: p.code,
      clause: this.clauseOf(p, terms),
      approval: p.approval_id ? { approval_id: p.approval_id, expires_at: p.approval_expires_at } : null,
      vote: p.vote,
      resolution: p.resolution,
      judge: j ? { kind: j.judge, model: j.model ?? null, decision: j.decision, summary: j.summary } : null,
      prs,
      tx_hash: p.tx_hash,
      refund_tx_hash: p.refund_tx_hash,
      failure_code: p.failure_code,
      created_at: p.created_at,
    };
  }

  private clauseOf(p: AttemptRow, terms: Terms) {
    const now = this.d.now();
    if (p.state === "held") return clauseFor({ kind: "held", code: null }, terms, now);
    if (p.state === "refused") return clauseFor({ kind: "refused", code: p.code }, terms, now);
    if ((p.state === "blocked" || p.state === "waiting") && p.code) {
      const kind = p.fail_kind === "forbidden" ? "forbidden" : p.fail_kind === "session" ? "session" : "blocked";
      return clauseFor({ kind, code: p.code }, terms, now);
    }
    return null;
  }

  private scopeView(id: string, terms: Terms, attempts: AttemptRow[]): ScopeRow[] {
    const lines = this.allLines(id);
    const paid = sumLines(attempts, lines, isPaid);
    const committed = sumLines(attempts, lines, isCommitted);
    const accepted = this.acceptedCompletion(id);
    const latest = this.d.db.query("SELECT json FROM judgments WHERE contract_id = ? ORDER BY rowid DESC LIMIT 1").get(id) as { json: string } | null;
    const prs = latest ? (JSON.parse(latest.json) as Judgment).prs : [];
    return terms.scope.map((d) => ({
      ...d,
      completion: accepted[d.id] ?? 0,
      paid_usd: usdOf(paid.get(d.id) ?? 0n),
      committed_usd: usdOf(committed.get(d.id) ?? 0n),
      prs: prs.filter((p) => p.deliverable === d.id).map((p) => ({ key: p.key, title: p.title, url: p.url, flagged: p.flags.length > 0 })),
    }));
  }

  private openJudgmentView(id: string, terms: Terms): ContractView["open_judgment"] {
    const j = this.openJudgment(id);
    if (!j) return null;
    const paid = this.attempts(id)
      .filter((a) => a.run_id === j.id && isPaid(a))
      .reduce((n, a) => n + BigInt(a.amount_atomic), 0n);
    return { id: j.id, outcome: j.outcome, owed_usd: usdOf(this.owedTotal(id, terms, j)), paid_usd: usdOf(paid) };
  }

  private stageOf(row: ContractRow, a: PlatformAgentRow | null, ov: Overview | null): SetupStage {
    const terms = this.terms(row);
    if (ov?.policy ? ov.policy.frozen : row.frozen) return "frozen";
    if (!row.rep_sig || !row.contractor_sig) return "needs_signatures";
    if (!a || a.stage === "needs_setup") return "needs_setup";
    if (this.d.now().getTime() > Date.parse(endInstant(terms)) && a.agent_id) return "ended";
    if (a.stage !== "ready") return a.stage;
    const hasPayouts = (this.d.db.query("SELECT 1 FROM payout_attempts WHERE contract_id = ? AND kind = 'payout' LIMIT 1").get(row.id) as unknown) !== null;
    if (ov && BigInt(ov.usdc || "0") === 0n && !hasPayouts) return "needs_funding";
    return "active";
  }

  // ================================================================ helpers

  /**
   * A freeze is reversible: contracts.frozen follows the platform's read. Frozen, nothing is requested; once the
   * owner unfreezes, the flag clears and payouts continue (re-checked against the whole signed policy first).
   */
  private syncFrozen(row: ContractRow, ov: Overview) {
    if (!ov.policy) return;
    const frozen = ov.policy.frozen ? 1 : 0;
    if (frozen === row.frozen) return;
    this.d.db.query("UPDATE contracts SET frozen = ? WHERE id = ?").run(frozen, row.id);
    row.frozen = frozen;
    this.event(row.id, "freeze", frozen ? "The owner froze the contract's agent. Nothing pays until they unfreeze it." : "The owner unfroze the contract's agent. Payouts continue.");
  }

  /** Read the platform's freeze state into contracts.frozen (no-op before the agent exists or when it doesn't answer). */
  private async refreshFrozen(id: string) {
    const row = this.row(id);
    const a = this.onboarding.agentRow(row.organization);
    if (!a?.agent || !a.agent_id) return;
    const o = await this.onboarding.handle(a).overview();
    if (o.ok) this.syncFrozen(row, o.value);
  }

  private handleFor(att: AttemptRow) {
    const row = this.row(att.contract_id);
    const a = this.onboarding.agentRow(row.organization);
    return a?.agent ? this.onboarding.handle(a) : null;
  }

  private readyAgent(id: string): PlatformAgentRow {
    const row = this.row(id);
    const a = this.onboarding.agentRow(row.organization);
    if (!a?.agent_id) throw new UserError("Set up the contract's agent first.");
    return a;
  }

  private insertAttempt(i: { request_id: string; kind: "payout" | "attack"; contract_id: string; seq: number; attempt: number; run_id: string | null; recipient: string; amount: bigint; lines: Line[]; auto?: boolean; scenario?: string }) {
    const now = this.nowIso();
    this.d.db
      .query(
        "INSERT INTO payout_attempts (request_id, kind, contract_id, seq, attempt, run_id, recipient, amount_atomic, state, auto_retry, scenario, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
      )
      .run(i.request_id, i.kind, i.contract_id, i.seq, i.attempt, i.run_id, i.recipient, i.amount.toString(), i.auto ? 1 : 0, i.scenario ?? null, now, now);
    for (const l of i.lines) this.d.db.query("INSERT INTO payout_lines (request_id, deliverable_id, amount_atomic) VALUES (?, ?, ?)").run(i.request_id, l.deliverable_id, l.amount.toString());
  }

  private nextSeq(id: string, kind: "payout" | "attack"): number {
    const r = this.d.db.query("SELECT MAX(seq) AS m FROM payout_attempts WHERE contract_id = ? AND kind = ?").get(id, kind) as { m: number | null };
    return (r.m ?? 0) + 1;
  }

  private attempts(id: string): AttemptRow[] {
    return this.d.db.query("SELECT * FROM payout_attempts WHERE contract_id = ? ORDER BY created_at DESC, rowid DESC").all(id) as AttemptRow[];
  }

  attempt(requestId: string): AttemptRow {
    const a = this.d.db.query("SELECT * FROM payout_attempts WHERE request_id = ?").get(requestId) as AttemptRow | null;
    if (!a) throw new UserError("No such payout.", 404);
    return a;
  }

  payoutContract(requestId: string): string {
    return this.attempt(requestId).contract_id;
  }

  private setAttempt(requestId: string, fields: Partial<Omit<AttemptRow, "request_id">>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.d.db
      .query(`UPDATE payout_attempts SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE request_id = ?`)
      .run(...(Object.values(fields) as (string | number | null)[]), this.nowIso(), requestId);
  }

  private allLines(id: string): LineRow[] {
    return this.d.db.query("SELECT l.* FROM payout_lines l JOIN payout_attempts a ON a.request_id = l.request_id WHERE a.contract_id = ?").all(id) as LineRow[];
  }

  private committedBy(id: string): Map<string, bigint> {
    return sumLines(this.attempts(id), this.allLines(id), isCommitted);
  }

  private owedTotal(id: string, terms: Terms, j: JudgmentRow): bigint {
    return owedFor(terms, completionOf(JSON.parse(j.json) as Judgment), this.committedBy(id)).reduce((n, l) => n + l.amount, 0n);
  }

  private openJudgment(id: string): JudgmentRow | null {
    return this.d.db.query("SELECT * FROM judgments WHERE contract_id = ? AND outcome = 'pending'").get(id) as JudgmentRow | null;
  }

  private judgmentRow(runId: string): JudgmentRow | null {
    return this.d.db.query("SELECT * FROM judgments WHERE id = ?").get(runId) as JudgmentRow | null;
  }

  private judgmentOf(runId: string): Judgment | null {
    const r = this.judgmentRow(runId);
    return r ? (JSON.parse(r.json) as Judgment) : null;
  }

  /** Completion carried into the next run: only from judgments whose payouts were approved and paid. */
  private acceptedCompletion(id: string): Record<string, Level> {
    const rows = this.d.db.query("SELECT json FROM judgments WHERE contract_id = ? AND outcome = 'approved' ORDER BY rowid ASC").all(id) as { json: string }[];
    const out: Record<string, Level> = {};
    for (const r of rows) for (const x of (JSON.parse(r.json) as Judgment).deliverables) if (x.completion > (out[x.id] ?? 0)) out[x.id] = x.completion;
    return out;
  }

  private prReviews(id: string): Map<string, "approved" | "rejected"> {
    const rows = this.d.db.query("SELECT pr_key, verdict FROM pr_reviews WHERE contract_id = ?").all(id) as { pr_key: string; verdict: "approved" | "rejected" }[];
    return new Map(rows.map((r) => [r.pr_key, r.verdict]));
  }

  private window(terms: Terms) {
    const now = this.nowIso();
    return { since: startInstant(terms), until: [now, endInstant(terms)].sort()[0]! };
  }

  private requireActive(row: ContractRow, terms: Terms) {
    const a = this.onboarding.agentRow(row.organization);
    if (a?.stage === "needs_grant" && a.policy_revision !== null) throw new UserError("The agent's payout grant has expired. Issue it again (the next setup step), then run the agent.", 409);
    if (!a || a.stage !== "ready") throw new UserError("The contract's agent is not set up yet.");
    if (row.frozen) throw new UserError("The owner froze this contract's agent. Nothing pays until they unfreeze it.", 409);
    if (this.d.now().getTime() > Date.parse(endInstant(terms))) throw new UserError("The contract has ended.");
    if (this.d.now().getTime() < Date.parse(startInstant(terms))) throw new UserError(`The contract starts ${terms.start}.`);
  }

  private stateText(a: AttemptRow): string {
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
        return `${what}: no answer from the platform. Covenant will ask for its status; it is never sent under a new id.`;
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

  private events(contractId: string): EventView[] {
    return (this.d.db.query("SELECT * FROM events WHERE contract_id = ? ORDER BY id DESC LIMIT 100").all(contractId) as EventRow[]).map((e) => ({ id: e.id, at: e.at, kind: e.kind, text: e.text }));
  }

  private event(contractId: string, kind: string, text: string) {
    this.d.db.query("INSERT INTO events (contract_id, at, kind, text) VALUES (?, ?, ?, ?)").run(contractId, this.nowIso(), kind, text);
  }

  private row(id: string): ContractRow {
    const row = this.d.db.query("SELECT * FROM contracts WHERE id = ?").get(id) as ContractRow | null;
    if (!row) throw new UserError("No such contract.", 404);
    return row;
  }

  private terms(row: ContractRow): Terms {
    return JSON.parse(row.terms) as Terms;
  }

  private nowIso(): string {
    return this.d.now().toISOString();
  }

  // ---------------------------------------------------------------- timers

  async followUpAll() {
    for (const id of this.followUpIds()) {
      await this.mutex.run(id, () => this.followUpLocked(id)).catch((err) => this.log(`status timer ${id}: ${errText(err)}`));
    }
  }
}

/** One platform Organization per contract. One agent per company would change this and the policy's payee list. */
export function orgFor(contractId: string): string {
  return contractId;
}

/** A live payout grant (label `payout`, or `invoices` on the local stack: platform-gaps G9) that lasts past `until`. */
function liveGrant(o: Overview, until: number) {
  return o.grants.find((g) => (g.label === "payout" || g.label === "invoices") && !g.revoked && Date.parse(g.expiresAt) > until) ?? null;
}

function completionOf(j: Judgment): Record<string, number> {
  return Object.fromEntries(j.deliverables.map((x) => [x.id, x.completion]));
}

function pick(pr: { repo: string; number: number; title: string; url: string }) {
  return { key: `${pr.repo}#${pr.number}`, title: pr.title, url: pr.url };
}

function eventKind(state: AttemptState): string {
  return state === "paid" ? "paid" : state === "held" ? "held" : state === "refused" ? "refused" : state === "rejected" ? "reject" : state === "failed" ? "failed" : "payout";
}

function sig(json: string | null): SignatureRecord | null {
  return json ? (JSON.parse(json) as SignatureRecord) : null;
}

function sigView(json: string | null) {
  const s = sig(json);
  return s ? { account_id: s.account_id, public_key: s.public_key, signature: s.signature, signed_at: s.signed_at } : null;
}

function usdOf(atomic: bigint | string): string {
  return fromAtomic(BigInt(atomic), USDC_DECIMALS);
}

export function usdText(atomic: bigint | string): string {
  const [w, f = ""] = fromAtomic(BigInt(atomic), USDC_DECIMALS).split(".");
  return `$${w}.${(f + "00").slice(0, 2)}`;
}

function errText(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export function toUserError(err: unknown): UserError {
  if (err instanceof UserError) return err;
  return new UserError(errText(err), 500);
}

function formatZod(err: unknown): string {
  const issues = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues;
  if (!issues) return String(err);
  return issues.map((i) => `${i.path.join(".") || "terms"}: ${i.message}`).join("; ");
}
