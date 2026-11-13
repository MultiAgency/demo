import { PUBLIC_VERIFICATION_CHECKS, type PublicVerificationView } from "../shared/views";
import type { Database } from "bun:sqlite";
import { clauseFor } from "../shared/clauses";
import { canonicalJson, sha256Hex } from "../shared/canonical";
import { fromAtomic, toAtomic } from "../shared/money";
import { jobSubmissionSchema, type JobSubmissionView } from "../shared/jobs";
import type { MyJob } from "../shared/my-jobs";
import type { ReviewContext } from "../shared/review";
import { expectations, largestAtomic, policyDifferences, policyProblem, totalAtomic } from "../shared/policy-request";
import { endInstant, parseTerms, scopeTotal, startInstant, type Terms, TERMS_RECIPIENT, termsHash, termsSigningMessage, USDC_DECIMALS } from "../shared/terms";
import type { AttemptState, ContractView, EventView, JudgmentOutcome, NextStep, PayoutView, PayoutResolution, ScopeRow, SetupStage, VerifyView } from "../shared/views";
import type { Config } from "./config";
import type { AttemptRow, ContractRow, EventRow, JudgmentRow, LineRow, OwnerStepRow, PlatformAgentRow, SignatureRecord, JobRow, JobInvoiceRow } from "./db";
import { judgeJob } from "./job-judge";
import { jobAttention } from "./jobs/attention";
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
import type { AgentHandle, ChainReader, Deposit, Overview, PaymentStatus, PayoutAnswer, Platform, Res } from "./platform/port";

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

export class Engine {
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
      .query("INSERT INTO contracts (id, terms, hash, created_at, contractor_link_hash, organization, signing_recipient) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, canonicalJson(terms), hash, this.nowIso(), sha256Hex(contractorToken), orgFor(id), TERMS_RECIPIENT);
    this.event(id, "draft", `Draft created: ${terms.company} funds ${terms.scope.length} deliverables worth $${scopeTotal(terms)} for ${terms.contractor.name}, until ${terms.end}.`);
    return { id, contractorToken };
  }

  private lastAlert(contractId: string): string | null {
    const r = this.d.db.query("SELECT text FROM events WHERE contract_id = ? AND kind = 'alert' ORDER BY id DESC LIMIT 1").get(contractId) as { text: string } | null;
    return r?.text ?? null;
  }

  parties(id: string): { representative: string; contractor: string } {
    const t = this.terms(this.row(id));
    return { representative: t.representative.near_account, contractor: t.contractor.near_account };
  }

  requireContractorToken(id: string, token: unknown) {
    if (sha256Hex(typeof token === "string" ? token : "") !== this.row(id).contractor_link_hash)
      throw new UserError("Use the builder's private link to submit this job.", 403);
  }

  /** Contracts the merge watcher runs: set up and not ended. A frozen one is re-read each time, so an unfreeze resumes it. */
  activeContractIds(): string[] {
    const rows = this.d.db.query("SELECT c.* FROM contracts c JOIN platform_agents a ON a.organization = c.organization WHERE a.stage = 'ready'").all() as ContractRow[];
    const now = this.d.now().getTime();
    return rows.filter((r) => this.terms(r).v === 2 && now < Date.parse(endInstant(this.terms(r)))).map((r) => r.id);
  }

  /** Contracts with a live payout or attack to follow on the status timer. */
  followUpIds(): string[] {
    const rows = this.d.db.query("SELECT DISTINCT contract_id FROM payout_attempts WHERE state IN (" + OPEN_STATES.map((s) => `'${s}'`).join(",") + ") OR (state = 'failed' AND (resolution IS NULL OR resolution = 'disputed')) UNION SELECT contract_id FROM judgments WHERE outcome = 'pending'").all() as { contract_id: string }[];
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

  /** Private discovery from local records only: no follow-up, signing preparation or platform reads. */
  jobsFor(account: string): MyJob[] {
    const rows = this.d.db.query("SELECT * FROM contracts ORDER BY created_at DESC").all() as ContractRow[];
    return rows.flatMap<MyJob>((row) => {
      const terms = this.terms(row);
      const roles: MyJob["roles"] = [];
      if (terms.representative.near_account === account) roles.push("agency");
      if (terms.contractor.near_account === account) roles.push("builder");
      if (!roles.length) return [];
      const agent = this.onboarding.agentRow(row.organization);
      const attention = jobAttention({
        terms, roles, row, agent, latestSubmission: this.jobRows(row.id)[0] ?? null,
        payouts: this.attempts(row.id),
        openJudgmentId: this.openJudgment(row.id)?.id ?? null,
        ownerSteps: this.d.db.query("SELECT * FROM owner_steps WHERE contract_id = ? OR (contract_id IS NULL AND organization = ?) ORDER BY created_at DESC, rowid DESC").all(row.id, row.organization) as OwnerStepRow[],
        now: this.d.now(),
      });
      return [{
        id: row.id,
        title: terms.scope[0]?.title || terms.company,
        company: terms.company,
        builder_name: terms.contractor.name,
        scope_usd: scopeTotal(terms),
        start: terms.start,
        end: terms.end,
        stage: this.stageOf(row, agent, null),
        roles,
        builder_accepted: !!row.contractor_sig,
        workflow: terms.v === 3 ? "report_invoice" : "pay_on_merge",
        attention,
      }];
    });
  }

  /** The view only: no follow-up, so no payout is planned or sent. */
  async viewContract(id: string): Promise<ContractView> {
    this.row(id);
    return this.view(id);
  }

  async getContract(id: string): Promise<ContractView> {
    this.row(id);
    let setupError: string | null = null;
    await this.mutex.run(id, async () => {
      try {
        await this.onboarding.reconcile(id);
      } catch (err) {
        this.log(`setup status ${id}: ${errText(err)}`);
        setupError = err instanceof UserError ? err.message : "The platform status check failed. Refresh status to try again.";
        return; // Preserve the saved view and do not advance other work after a failed setup observation.
      }
      try {
        await this.followUpLocked(id);
      } catch (err) {
        this.log(`follow-up ${id}: ${errText(err)}`);
      }
    });
    const view = await this.view(id);
    return setupError ? { ...view, next_step: { kind: "wait", label: "Setup status could not refresh", retry_ms: 5000, error: setupError } } : view;
  }

  // ================================================================ term signatures (NEP-413)

  signingRequest(id: string, role: Role) {
    const row = this.row(id);
    const terms = this.terms(row);
    return {
      role,
      account_id: role === "representative" ? terms.representative.near_account : terms.contractor.near_account,
      message: termsSigningMessage(row.hash, row.signing_recipient),
      recipient: row.signing_recipient,
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
    const ok = verifyNep413({ message: termsSigningMessage(row.hash, row.signing_recipient), nonce: nonceFromString(signed.nonce), recipient: row.signing_recipient }, signed);
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

  // ================================================================ report/invoice jobs (signed v3 terms)

  /** Immutable revisions and idempotent filing. Actor comes from the authenticated route, never the body. */
  async submitJob(id: string, input: unknown, actor: string): Promise<JobSubmissionView> {
    return this.mutex.run(id, async () => {
      const row = this.row(id);
      const terms = this.terms(row);
      if (terms.v !== 3) throw new UserError("This contract uses merged-PR acceptance.", 409);
      if (actor !== terms.contractor.near_account) throw new UserError("Only the agreed builder can submit this job.", 403);
      const parsed = jobSubmissionSchema.safeParse(input);
      if (!parsed.success) throw new UserError(formatZod(parsed.error));
      const body = parsed.data;
      const hash = sha256Hex(canonicalJson(body));
      const prior = this.d.db.query("SELECT * FROM job_submissions WHERE contract_id = ? AND client_request_id = ?").get(id, body.client_request_id) as JobRow | null;
      if (prior) {
        if (prior.content_hash !== hash) throw new UserError("This submission identity already has different content. Retry the original body.", 409);
        return this.jobView(prior);
      }
      if (!row.rep_sig || !row.contractor_sig) throw new UserError("Both parties must accept the job before submission.", 409);
      this.requireActive(row, terms);
      const latest = this.jobRows(id)[0];
      if (latest && ["submitted", "proposed", "changes_pending", "disputed"].includes(latest.state)) throw new UserError("The previous submission has an open or disputed payment. Wait for authoritative evidence before filing another.", 409);
      if (this.attempts(id).some(isOpen)) throw new UserError("A payment outcome is still unresolved; a new submission cannot replace it.", 409);
      if (body.evidence.some((e) => !terms.scope.some((d) => d.id === e.deliverable_id))) throw new UserError("Evidence must reference a deliverable in the accepted scope.");
      if (this.d.db.query("SELECT 1 FROM job_invoices WHERE contract_id = ? AND number = ?").get(id, body.invoice.number)) throw new UserError("That invoice number is already filed. Retry its original submission identity.", 409);
      const amount = toAtomic(body.invoice.amount_usd, USDC_DECIMALS);
      const committed = this.attempts(id).filter(isCommitted).reduce((n, a) => n + BigInt(a.amount_atomic), 0n);
      if (amount > BigInt(totalAtomic(terms)) - committed) throw new UserError("The invoice exceeds the remaining agreed scope budget.", 409);
      const sid = `s_${sha256Hex(`${id}:${body.client_request_id}`).slice(0, 24)}`;
      const invoiceId = `i_${sid.slice(2)}`;
      const now = this.nowIso();
      this.d.db.transaction(() => {
        this.d.db.query("INSERT INTO job_submissions (id, contract_id, client_request_id, content_hash, revision, terms_hash, builder, report, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(sid, id, body.client_request_id, hash, (latest?.revision ?? 0) + 1, row.hash, actor, body.report, JSON.stringify(body.evidence), now);
        this.d.db.query("INSERT INTO job_invoices (id, submission_id, contract_id, number, amount_atomic) VALUES (?, ?, ?, ?, ?)")
          .run(invoiceId, sid, id, body.invoice.number, amount.toString());
        this.event(id, "submission", `Builder ${actor} submitted revision ${(latest?.revision ?? 0) + 1}: ${sid}, invoice ${body.invoice.number} (${invoiceId}) for ${usdText(amount)} under terms ${row.hash}. No approval or payment yet.`);
      })();
      return this.jobView(this.job(sid));
    });
  }

  jobContract(submissionId: string): string { return this.job(submissionId).contract_id; }

  jobSubmissions(id: string): JobSubmissionView[] {
    this.row(id);
    return this.jobRows(id).map((s) => this.jobView(s));
  }

  /** Stored review facts only: no platform reads, frozen-state synchronization or payout follow-up. */
  reviewInput(submissionId: string) {
    const s = this.job(submissionId);
    const row = this.row(s.contract_id);
    const terms = this.terms(row);
    if (terms.v !== 3 || !row.rep_sig || !row.contractor_sig)
      throw new UserError("Review requires an accepted report-and-invoice job.", 409);
    if (s.terms_hash !== row.hash || termsHash(terms) !== row.hash)
      throw new UserError("The submission's accepted terms do not match.", 409);
    const payouts = s.judgment_id ? this.attempts(row.id).filter((a) => a.run_id === s.judgment_id) : [];
    if ((s.state !== "submitted" && s.state !== "proposed") || s.changes || payouts.some((a) => a.vote === "approve" || a.state === "processing" || isPaid(a) || (a.state === "failed" && !a.resolution)))
      throw new UserError("This submission is no longer available for a feedback draft. Refresh the job.", 409);
    const invoice = this.jobInvoice(s.id);
    const context: ReviewContext = {
      submission_id: s.id, terms_hash: row.hash, revision: s.revision,
      scope: terms.scope.map(({ id, title, criteria }) => ({ id, title, criteria })),
      report: s.report, evidence: JSON.parse(s.evidence),
      invoice: { number: invoice.number, amount_usd: usdOf(invoice.amount_atomic) },
    };
    return {
      context,
      snapshot: { terms_hash: row.hash, revision: s.revision, state: s.state, judgment_id: s.judgment_id },
      fingerprint: sha256Hex(canonicalJson({ context, state: s.state, changes: s.changes,
        payouts: payouts.map((a) => ({ request_id: a.request_id, state: a.state, vote: a.vote, resolution: a.resolution })) })),
    };
  }

  /** The proposal and its payment identity are committed together before the SDK sees any request. */
  async proposeJob(submissionId: string): Promise<ContractView> {
    const first = this.job(submissionId);
    return this.mutex.run(first.contract_id, async () => {
      const s = this.job(submissionId);
      // A lost proposal reply is observed, never judged or sent under a second identity.
      if (s.judgment_id) return this.view(s.contract_id);
      if (s.state !== "submitted") throw new UserError("Only an open submission can receive a proposal.", 409);
      const row = this.row(s.contract_id);
      const terms = this.terms(row);
      await this.refreshFrozen(row.id);
      this.requireActive(row, terms);
      if (s.terms_hash !== row.hash || termsHash(terms) !== row.hash) throw new UserError("The submission's accepted terms do not match.", 409);
      if (this.openJudgment(row.id) || this.attempts(row.id).some(isOpen)) throw new UserError("An earlier payment outcome is unresolved.", 409);
      const invoice = this.jobInvoice(s.id);
      const judgment = await judgeJob(this.d.config.judge, terms, {
        client_request_id: s.client_request_id, report: s.report, evidence: JSON.parse(s.evidence),
        invoice: { number: invoice.number, amount_usd: usdOf(invoice.amount_atomic) },
      }, this.acceptedCompletion(row.id));
      const owed = owedFor(terms, completionOf(judgment), this.committedBy(row.id)).reduce((n, l) => n + l.amount, 0n);
      const proposed = owed < BigInt(invoice.amount_atomic) ? owed : BigInt(invoice.amount_atomic);
      const plan = planPayout(terms, completionOf(judgment), this.committedBy(row.id), proposed);
      const runId = `r_${sha256Hex(s.id).slice(0, 24)}`;
      const rid = requestIdFor(row.hash, this.nextSeq(row.id, "payout"), 1);
      const now = this.nowIso();
      this.d.db.transaction(() => {
        this.d.db.query("INSERT INTO judgments (id, contract_id, at, json, outcome, closed_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(runId, row.id, now, JSON.stringify(judgment), plan ? "pending" : "nothing", plan ? null : now);
        this.d.db.query("UPDATE job_submissions SET judgment_id = ?, proposed_atomic = ?, state = ? WHERE id = ?")
          .run(runId, proposed.toString(), plan ? "proposed" : "closed", s.id);
        if (plan) this.insertAttempt({ request_id: rid, kind: "payout", contract_id: row.id, seq: this.nextSeq(row.id, "payout"), attempt: 1, run_id: runId, recipient: terms.payee.address, amount: plan.amount, lines: plan.lines });
        this.event(row.id, "proposal", `Agent proposed ${usdText(proposed)} for submission ${s.id}, invoice ${invoice.id}, judgment ${runId}. ${judgment.summary}`);
      })();
      if (plan) await this.send(rid);
      return this.view(row.id);
    });
  }

  /** Record feedback first. A live/unknown payout must be proven rejected before a revision is allowed. */
  async requestJobChanges(submissionId: string, reason: string): Promise<ContractView> {
    const first = this.job(submissionId);
    return this.mutex.run(first.contract_id, async () => {
      const s = this.job(submissionId);
      const text = reason.trim();
      if (text.length < 3 || text.length > 4000) throw new UserError("Describe the requested changes (3–4000 characters).");
      if (s.changes) {
        if (s.changes !== text) throw new UserError("This revision already has recorded feedback.", 409);
        return this.view(s.contract_id);
      }
      if (s.state !== "submitted" && s.state !== "proposed") throw new UserError("This submission is already closed.", 409);
      const attempts = s.judgment_id ? this.attempts(s.contract_id).filter((a) => a.run_id === s.judgment_id) : [];
      if (attempts.some((a) => a.vote === "approve" || a.state === "processing" || isPaid(a) || (a.state === "failed" && !a.resolution)))
        throw new UserError("A payout was approved or may have moved. Resolve its outcome before requesting changes.", 409);
      this.d.db.query("UPDATE job_submissions SET changes = ?, state = ? WHERE id = ?")
        .run(text, s.judgment_id ? "changes_pending" : "changes_requested", s.id);
      this.event(s.contract_id, "changes", `Agency requested changes on ${s.id}: ${text}${s.judgment_id ? " Any live payout must be rejected and confirmed before resubmission." : ""}`);
      if (s.judgment_id) await this.followUpLocked(s.contract_id);
      return this.view(s.contract_id);
    });
  }

  private job(id: string): JobRow {
    const s = this.d.db.query("SELECT * FROM job_submissions WHERE id = ?").get(id) as JobRow | null;
    if (!s) throw new UserError("No such submission.", 404);
    return s;
  }

  private jobRows(id: string): JobRow[] {
    return this.d.db.query("SELECT * FROM job_submissions WHERE contract_id = ? ORDER BY revision DESC").all(id) as JobRow[];
  }

  private jobForJudgment(runId: string | null): JobRow | null {
    return runId ? this.d.db.query("SELECT * FROM job_submissions WHERE judgment_id = ?").get(runId) as JobRow | null : null;
  }

  private jobInvoice(id: string): JobInvoiceRow {
    return this.d.db.query("SELECT * FROM job_invoices WHERE submission_id = ?").get(id) as JobInvoiceRow;
  }

  private jobView(s: JobRow): JobSubmissionView {
    const invoice = this.jobInvoice(s.id);
    const payouts = s.judgment_id ? this.attempts(s.contract_id).filter((a) => a.run_id === s.judgment_id) : [];
    return {
      id: s.id, revision: s.revision, terms_hash: s.terms_hash, builder: s.builder, report: s.report,
      evidence: JSON.parse(s.evidence), invoice: { id: invoice.id, number: invoice.number, amount_usd: usdOf(invoice.amount_atomic) },
      state: s.state, changes: s.changes, judgment_id: s.judgment_id, proposed_usd: usdOf(s.proposed_atomic),
      paid_usd: usdOf(payouts.filter(isPaid).reduce((n, a) => n + BigInt(a.amount_atomic), 0n)),
      payout_request_ids: payouts.map((a) => a.request_id), created_at: s.created_at,
    };
  }

  private requireJobApproval(att: AttemptRow) {
    const s = this.jobForJudgment(att.run_id);
    if (s?.changes) throw new UserError("Changes were requested. Reject this payout; the previous approval cannot be submitted.", 409);
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
      const prepared = this.onboarding.step(correlationId);
      if (prepared.kind === "approval_vote" && prepared.verdict === "approve" && prepared.request_id) {
        this.requireJobApproval(this.attempt(prepared.request_id));
      }
      const s = await this.onboarding.submitStep(correlationId, sig);
      if (s.kind === "approval_vote" && s.request_id && (s.state === "submitted" || s.state === "unknown")) {
        // The original decision/link was saved before submit I/O. An attempted vote is not its outcome:
        // the payout is followed through payouts/status, with explicit non-execution proof needed for rejection.
        const att = this.attempt(s.request_id);
        this.setAttempt(att.request_id, { vote: s.verdict as "approve" | "reject" });
        this.event(att.contract_id, "vote", `The representative submitted ${s.verdict === "approve" ? "an approval" : "a rejection"} attempt for ${usdText(att.amount_atomic)} (${att.request_id}). ${s.state === "unknown" ? "Its submission outcome is unknown." : "Follow the payout for its outcome."}`);
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

  async deposit(id: string): Promise<Deposit> {
    return this.mutex.run(id, async () => {
      const a = this.readyAgent(id);
      // deposit allocates a one-time address, not a quote/read. Reuse the original accepted response.
      if (a.deposit) {
        const saved = JSON.parse(a.deposit) as Deposit;
        if (!saved.address || (saved.expiresAt !== null && (!Number.isFinite(Date.parse(saved.expiresAt)) || Date.parse(saved.expiresAt) <= this.d.now().getTime())))
          throw new UserError("The saved deposit instructions are invalid or expired. No replacement was requested. Reconcile the original deposit with the platform before allocating another address.", 409);
        return saved;
      }
      // Claim atomically before I/O, including across database connections. A crash cannot become a new request.
      this.d.db.transaction(() => {
        const prior = this.d.db.query("SELECT kind FROM events WHERE contract_id = ? AND kind IN ('deposit_pending','deposit_ready') ORDER BY rowid DESC LIMIT 1").get(id) as { kind: string } | null;
        if (prior)
          throw new UserError("The original deposit-address allocation has an unknown outcome. No new allocation or funding transaction was sent. Reconcile that original request with the platform.", 503);
        this.event(id, "deposit_pending", "Requested deposit instructions; the original allocation is unresolved. This request sends no funds.");
      })();
      let res: Res<Deposit>;
      try { res = await this.onboarding.handle(a).deposit(); }
      catch { throw new UserError("The original deposit-address allocation has an unknown outcome. No funding transaction was sent by this request. Reconcile the original allocation before trying again.", 503); }
      if (!res.ok) throw new UserError("Deposit-address allocation did not complete reliably. No funding transaction was sent by this request. Refresh will not allocate another address; reconcile the original request with the platform.", 503);
      const deposit = res.value;
      if (!deposit.address || (deposit.expiresAt !== null && (!Number.isFinite(Date.parse(deposit.expiresAt)) || Date.parse(deposit.expiresAt) <= this.d.now().getTime())))
        throw new UserError("The platform returned invalid or expired deposit instructions. The original allocation needs reconciliation; no automatic replacement was requested.", 503);
      this.d.db.transaction(() => {
        this.onboarding.setAgent(a.organization, { deposit: JSON.stringify(deposit) });
        this.event(id, "deposit_ready", "Original deposit instructions saved. Refresh reuses them without allocating a new address.");
      })();
      return deposit;
    });
  }

  // ================================================================ the agent's run

  async run(id: string): Promise<RunResult> {
    return this.mutex.run(id, () => this.runLocked(id));
  }

  private async runLocked(id: string): Promise<RunResult> {
    await this.refreshFrozen(id);
    const row = this.row(id);
    const terms = this.terms(row);
    if (terms.v === 3) throw new UserError("This job requires a builder report and invoice. Propose compensation from its submission.", 409);
    this.requireActive(row, terms);
    await this.followUpLocked(id);
    const open = this.openJudgment(id);
    if (open) {
      // Logged once per open judgment: the merge watcher defers on every tick, and events keep only the last 100.
      const said = this.d.db.query("SELECT 1 FROM events WHERE contract_id = ? AND kind = 'deferred' AND text LIKE ?").get(id, `%(${open.id})%`);
      if (!said) this.event(id, "deferred", `Agent run deferred: the previous judgment (${open.id}) is still open (waiting on its payout). Nothing was judged or requested; later runs wait quietly until it closes.`);
      return { outcome: "deferred", judgment: null, open_judgment: this.openJudgmentView(id, terms), payouts: [] };
    }
    if (this.attempts(id).some(isOpen) || this.d.db.query("SELECT 1 FROM judgments WHERE contract_id = ? AND outcome = 'disputed' LIMIT 1").get(id)) {
      // A business review may be closed as disputed while its original money outcome still holds the slot.
      // Partial late settlement does not authorize the merge watcher to open a new judgment for the remainder.
      return { outcome: "deferred", judgment: null, open_judgment: null, payouts: [] };
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
      if (this.jobForJudgment(j.id)?.changes) throw new UserError("Changes are pending. Follow and reject the existing payout; do not retry it.", 409);
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
      // A blocked state can follow an uncertain send and a later preflight failure.
      // Require a fresh, identity-bound absence observation before releasing its commitment.
      for (const a of open) {
        const status = await this.handleFor(a)?.payoutStatus(a.request_id);
        if (a.correlation_id || !status?.ok || status.value.requestId !== a.request_id ||
          status.value.state !== "not_found" || status.value.correlationId !== null)
          throw new UserError("The platform has not confirmed this payout was never recorded. Follow its outcome before dropping it.", 409);
      }
      // All open attempts were confirmed absent before any commitment is released.
      for (const a of open) this.setAttempt(a.request_id, { state: "dropped", retry_at: null });
      this.closeJudgment(j, "dropped");
      return this.view(id);
    });
  }

  /** Rep: resolve a failed payout after checking the evidence. */
  async resolve(requestId: string, outcome: PayoutResolution, reason?: string) {
    const att = this.attempt(requestId);
    return this.mutex.run(att.contract_id, async () => {
      const a = this.attempt(requestId);
      if (a.kind !== "payout" || a.state !== "failed" || (a.resolution !== null && a.resolution !== "disputed")) throw new UserError("Only an unresolved or disputed failed payout can be reviewed.", 409);
      if (outcome === "disputed" && a.resolution === "disputed") return this.view(a.contract_id);
      if (outcome !== "arrived" && outcome !== "disputed" &&
          (a.never_executed !== 1 || a.tx_hash !== null || a.refund_tx_hash !== null || a.refunded_amount !== null)) {
        throw new UserError("This job's failed payment remains committed until the platform proves it never executed. Manual review cannot authorize a replacement or release its budget.", 409);
      }
      this.d.db.transaction(() => {
        this.setAttempt(requestId, { resolution: outcome });
        const text = { arrived: "the money arrived; it stays paid", reowe: "nothing arrived; it is owed again", rejected: "it was rejected; its work is excluded",
          disputed: "review closed as disputed, awaiting evidence; the amount stays committed, is not counted as paid, and no replacement is authorized" }[outcome];
        this.event(a.contract_id, "resolve", `The representative reviewed failed payout ${requestId}: ${text}.${reason ? ` ${reason}` : ""}`);
        if (a.run_id) {
          const j = this.judgmentRow(a.run_id);
          if (j && outcome === "disputed") this.finalizeJudgmentRecords(j, "disputed");
          else if (j && outcome === "rejected" && (j.outcome === "pending" || j.outcome === "disputed")) this.finalizeJudgmentRecords(j, "rejected");
          else if (j?.outcome === "disputed") {
            // A later explicit resolution resumes the same judgment and invoice, never an invented replacement job.
            this.d.db.query("UPDATE judgments SET outcome = 'pending', closed_at = NULL WHERE id = ? AND outcome = 'disputed'").run(j.id);
            const job = this.jobForJudgment(j.id);
            if (job) this.d.db.query("UPDATE job_submissions SET state = 'proposed' WHERE id = ?").run(job.id);
          }
        }
      })();
      await this.advanceJudgment(a.contract_id);
      return this.view(a.contract_id);
    });
  }

  // ================================================================ approval votes

  async vote(requestId: string, verdict: "approve" | "reject") {
    const first = this.attempt(requestId);
    return this.mutex.run(first.contract_id, async () => {
      let att = this.attempt(requestId);
      if (verdict === "approve") this.requireJobApproval(att);
      // An attack payout is never counted against the scope, so it may only be rejected: its money can't move uncounted.
      if (att.kind === "attack" && verdict === "approve") throw new UserError("A demo attack payout can only be rejected.", 409);
      if (att.state !== "held") throw new UserError(`This payout is ${att.state}, not waiting for approval.`, 409);
      if (!att.approval_id) {
        await this.fillHeld(att);
        att = this.attempt(requestId);
      }
      if (!att.approval_id || !att.correlation_id) throw new UserError("The platform has not shown this approval yet. Try again shortly.", 409);
      const row = this.row(att.contract_id);
      const terms = this.terms(row);
      const a = this.onboarding.agentRow(row.organization)!;
      const action = { type: "approval_vote" as const, approvalId: att.approval_id, verdict, correlationId: att.correlation_id };
      // A platform confirmation can be signed outside this app. Reconcile its original owner intent before deciding
      // whether a preparation is still signable, submitted, or positively expired without submission.
      let prior = this.d.db.query("SELECT * FROM owner_steps WHERE request_id = ? AND kind = 'approval_vote' ORDER BY created_at DESC, rowid DESC").all(requestId) as OwnerStepRow[];
      for (const step of prior) if ((step.confirm_url || step.standard === "dao") && ["prepared", "submitted", "unknown"].includes(step.state)) await this.onboarding.pollStep(step.correlation_id);
      prior = this.d.db.query("SELECT * FROM owner_steps WHERE request_id = ? AND kind = 'approval_vote' ORDER BY created_at DESC, rowid DESC").all(requestId) as OwnerStepRow[];
      if (prior.some((s) => s.state === "submitted" || s.state === "unknown"))
        throw new UserError("A vote for this payout is already submitted or uncertain. Follow its original identity before preparing another.", 409);
      const pending = prior.filter((s) => s.state === "prepared");
      if (pending.some((s) => !s.expires_at || !Number.isFinite(Date.parse(s.expires_at))))
        throw new UserError("The prepared vote has no verifiable expiry. Follow its original identity before preparing another.", 409);
      const same = pending.find((s) => s.verdict === verdict && s.action === JSON.stringify(action) && Date.parse(s.expires_at!) > this.d.now().getTime());
      if (pending.some((s) => (s.confirm_url || s.standard === "dao") && s !== same))
        throw new UserError("A platform confirmation may already have been signed. Follow this payout's original identity before preparing another vote.", 409);
      // Only never-submitted preparations can be superseded; stale wallet prompts can no longer submit them here.
      for (const s of pending) if (s !== same)
        this.d.db.query("UPDATE owner_steps SET state = 'expired', failure_code = 'superseded', updated_at = ? WHERE correlation_id = ? AND state = 'prepared'").run(this.nowIso(), s.correlation_id);
      const step = same ?? await this.onboarding.prepare(att.contract_id, a, action, { request_id: requestId, verdict });
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
        dao: view.kind === "owner_step" ? (view.dao ?? null) : null,
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
    // A change request may stop a request only before sending or after status proved not_found.
    if (this.jobForJudgment(att.run_id)?.changes) return this.transition(att, { state: "dropped", code: "changes_requested", failKind: null });
    const a = this.onboarding.agentRow(row.organization);
    if (!a?.agent) return this.transition(att, { state: "blocked", code: "setup", failKind: "blocked", retryAfterMs: this.d.config.statusPollMs });
    let expected: { revision: number; digest: string } | null = null;
    if (att.kind === "payout") {
      const pre = await this.preflight(row, terms, a);
      if ("state" in pre) {
        // Said once per distinct problem, not on every re-check.
        if (pre.alert && att.state === pre.state && att.code === pre.code && this.lastAlert(att.contract_id) === pre.alert) delete pre.alert;
        return this.transition(att, pre);
      }
      expected = pre.expected;
    } else {
      // Attacks: a compromised server skips Paperwork's checks; only the platform stands in the way.
      const o = await this.onboarding.handle(a).overview();
      expected = o.ok && o.value.revision !== null && o.value.digest !== null ? { revision: o.value.revision, digest: o.value.digest } : { revision: a.policy_revision ?? 0, digest: a.policy_digest ?? "" };
    }
    const res = await this.onboarding.handle(a).requestPayout({ requestId, recipient: att.recipient, amount: att.amount_atomic, expectedPolicy: expected });
    await this.apply(att, res);
  }

  /**
   * Before every payout request: active, not near the end, and the whole live policy matches what Paperwork signed.
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
      this.event(row.id, "policy", `Policy revision ${o.value.revision} still matches the signed terms in full; Paperwork continues under it.`);
    }
    return { expected: { revision: o.value.revision, digest: o.value.digest } };
  }

  private async apply(att: AttemptRow, res: Res<PayoutAnswer>) {
    if (!res.ok) return this.transition(att, fromFail(res, this.d.config.statusPollMs));
    if (res.value.requestId !== att.request_id ||
      (att.correlation_id !== null && res.value.correlationId !== null && res.value.correlationId !== att.correlation_id)) {
      this.log(`ALERT ${att.request_id}: ignored payout answer with mismatched request or payment identity`);
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
    if (t.neverExecuted !== undefined) fields.never_executed = t.neverExecuted ? 1 : 0;
    if (t.state === "paid") fields.never_executed = 0;
    if (t.failureCode !== undefined) fields.failure_code = t.failureCode;
    this.setAttempt(att.request_id, fields);
    let cur = this.attempt(att.request_id);
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
          const consistent = !ps.ok || ps.value.status === "FAILED";
          const proof = cur.never_executed === 1 && consistent && txHash === null && refundTxHash === null && refundedAmount === null;
          if (!proof) patch.never_executed = 0;
          // A disputed closure keeps its monetary hold until the agency explicitly reviews newly arrived
          // non-execution evidence. A later successful payment is handled above under the same original identity.
          patch.state = cur.resolution === "disputed" ? "failed" : classifyFailed(cur.vote, txHash, proof);
        }
      }
      this.setAttempt(cur.request_id, patch);
      cur = this.attempt(cur.request_id);
    }
    if (t.alert) {
      this.event(cur.contract_id, "alert", t.alert);
      this.log(`ALERT ${cur.request_id}: ${t.alert}`);
    }
    if (cur.state !== att.state || cur.code !== att.code) this.event(cur.contract_id, eventKind(cur.state), this.stateText(cur));
    if (cur.state === "blocked" && cur.code === "request_conflict" && h) await this.readConflict(cur, h);
  }

  /**
   * request_conflict: the platform recorded this id with other terms. Read what that record became and show it.
   * Information only: the attempt stays blocked and committed, and is never re-sent.
   */
  private async readConflict(att: AttemptRow, h: AgentHandle) {
    const st = await h.payoutStatus(att.request_id);
    this.setAttempt(att.request_id, { retry_at: new Date(this.d.now().getTime() + this.d.config.statusPollMs).toISOString() });
    if (!st.ok) return;
    const record = `${st.value.state}${st.value.status ? ` (${st.value.status})` : ""}`;
    if (record === att.platform_record) return;
    this.setAttempt(att.request_id, { platform_record: record });
    this.event(att.contract_id, "payout", `The platform's own record under ${att.request_id} (other terms) reads ${record}. Paperwork keeps its amount counted and never re-sends this id.`);
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
      if (OPEN_STATES.includes(att.state) || (att.state === "failed" && (att.resolution === null || att.resolution === "disputed"))) {
        try {
          await this.followAttempt(att);
        } catch (err) {
          this.log(`follow ${att.request_id}: ${errText(err)}`);
        }
      }
    }
    await this.advanceJudgment(id);
    this.reconcileDisputedJudgments(id);
  }

  private async followAttempt(att: AttemptRow) {
    // A DAO signature may have been submitted outside this app or while its process was stopped.
    const daoSteps = this.d.db.query("SELECT correlation_id FROM owner_steps WHERE request_id = ? AND standard = 'dao' AND state IN ('prepared','submitted','unknown')")
      .all(att.request_id) as { correlation_id: string }[];
    for (const step of daoSteps) await this.onboarding.pollStep(step.correlation_id);
    att = this.attempt(att.request_id);
    const h = this.handleFor(att);
    if (!h) return;
    const now = this.d.now().getTime();
    if (att.state === "blocked" && att.code === "request_conflict") {
      if (!att.retry_at || Date.parse(att.retry_at) <= now) await this.readConflict(att, h);
      return; // Other terms under this identity must never become this job's payment or cancellation.
    }
    if (this.jobForJudgment(att.run_id)?.changes && (att.state === "blocked" || att.state === "waiting")) {
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
    if (st.ok) {
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

  /** Move the open judgment: close it, request the next seq, re-ask after reowe, or one automatic retry. */
  private async advanceJudgment(id: string) {
    for (let guard = 0; guard < 5; guard++) {
      const j = this.openJudgment(id);
      if (!j) return;
      const terms = this.terms(this.row(id));
      const mine = this.attempts(id).filter((a) => a.run_id === j.id && a.kind === "payout");
      if (this.jobForJudgment(j.id)?.changes) {
        if (mine.some(isOpen)) return;
        // An off-app approval may have raced the cancellation. Never describe money that moved as cancelled.
        if (mine.some(isCommitted)) {
          this.closeJudgment(j, "approved");
          return;
        }
        this.closeJudgment(j, "rejected");
        return;
      }
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
          this.event(id, "retry", `The platform refused with ${last!.code}; Paperwork re-read the policy and retries once.`);
          if (!(await this.newAttempt(j, last!.seq, last!.attempt + 1, true))) return;
          break;
      }
    }
  }

  /** Plan and write a new attempt for the open judgment (rows first), then send it. False when nothing is owed. */
  private async newAttempt(j: JudgmentRow, seq: number, attempt: number, auto: boolean): Promise<boolean> {
    const row = this.row(j.contract_id);
    const terms = this.terms(row);
    const plan = planPayout(terms, completionOf(JSON.parse(j.json) as Judgment), this.committedBy(j.contract_id), this.jobBudgetRemaining(j));
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

  private closeJudgment(j: JudgmentRow, outcome: "approved" | "rejected" | "dropped" | "nothing" | "disputed") {
    // The judgment, submission state and event are one durable outcome. A crash or failed write must leave
    // the pending judgment available to the recovery timer, even if its payout is already terminal.
    this.d.db.transaction(() => this.finalizeJudgmentRecords(j, outcome))();
  }

  private finalizeJudgmentRecords(j: JudgmentRow, outcome: "approved" | "rejected" | "dropped" | "nothing" | "disputed") {
    const now = this.nowIso();
    this.d.db.query("UPDATE judgments SET outcome = ?, closed_at = ? WHERE id = ? AND outcome IN ('pending', 'disputed')").run(outcome, now, j.id);
    const job = this.jobForJudgment(j.id);
    if (job) {
      const mine = this.attempts(j.contract_id).filter((a) => a.run_id === j.id);
      const confirmed = mine.some((a) => a.state === "paid") && mine.filter(isCommitted).every((a) => a.state === "paid");
      const cancelled = !!job.changes && mine.every((a) => !isCommitted(a));
      const state = outcome === "disputed" ? "disputed" : cancelled ? "changes_requested" : outcome === "approved" && confirmed ? "settled" : "closed";
      this.d.db.query("UPDATE job_submissions SET state = ? WHERE id = ?").run(state, job.id);
      this.event(j.contract_id, "submission", `Submission ${job.id}: ${state}. ${cancelled ? "No live payout remains; the builder can submit a new immutable revision." : "Approval and payment evidence remain linked through the judgment and request IDs."}`);
      return;
    }
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

  /** A disputed business review stays closed while its original money identity is observed. Late evidence cannot
   * authorize another sequence: only confirmed payment of the whole proposal can mark the job settled. */
  private reconcileDisputedJudgments(id: string) {
    const rows = this.d.db.query("SELECT * FROM judgments WHERE contract_id = ? AND outcome = 'disputed'").all(id) as JudgmentRow[];
    for (const j of rows) {
      const mine = this.attempts(id).filter(a => a.kind === "payout" && a.run_id === j.id);
      if (!mine.some(a => a.state === "paid") || mine.filter(isCommitted).some(a => a.state !== "paid")) continue;
      const job = this.jobForJudgment(j.id);
      const confirmed = mine.filter(a => a.state === "paid").reduce((n, a) => n + BigInt(a.amount_atomic), 0n);
      const complete = job ? confirmed >= BigInt(job.proposed_atomic) : this.owedTotal(id, this.terms(this.row(id)), j) === 0n;
      if (!complete) continue;
      this.d.db.transaction(() => {
        this.finalizeJudgmentRecords(j, "approved");
        this.event(id, "resolve", `Late platform evidence confirmed the full disputed proposal ${j.id} under its original payment identities. No replacement payment was requested.`);
      })();
    }
  }

  // ================================================================ contractor verification

  async publicVerification(id: string): Promise<PublicVerificationView> {
    const row = this.row(id);
    const result = await this.verify(id);
    const checks: PublicVerificationView["checks"] = {};
    for (const key of PUBLIC_VERIFICATION_CHECKS) {
      const check = result.checks.find((item) => item.id === key);
      if (check) checks[key] = check.ok;
    }
    return { terms_hash: row.hash, workflow_version: this.terms(row).v, overall: result.overall, checks, checked_at: this.d.now().toISOString() };
  }

  async verify(id: string): Promise<VerifyView> {
    const row = this.row(id);
    const terms = this.terms(row);
    const expected = expectations(terms);
    const checks: VerifyView["checks"] = [];
    checks.push({ id: "terms", label: "Terms hash matches the terms", ok: termsHash(terms) === row.hash });
    for (const role of ["representative", "contractor"] as const) {
      const s = sig(role === "representative" ? row.rep_sig : row.contractor_sig);
      const ok = !!s && verifyNep413({ message: termsSigningMessage(row.hash, row.signing_recipient), nonce: nonceFromString(s.nonce), recipient: row.signing_recipient }, s) && (await this.d.chain.isFullAccessKey(s.account_id, s.public_key));
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
      { id: "approval", label: terms.v === 3 && terms.agency_owner ? "Every payout waits for the DAO's approval" : "Every payout waits for the representative's approval", ok: !!p?.owner_approval },
      { id: "frozen", label: "The agent is not frozen", ok: !!p && !p.frozen },
      { id: "grant", label: "A live payout grant exists", ok: !!grant, detail: grant ? `The platform chose its expiry: ${grant.expiresAt}` : undefined },
      {
        id: "consent",
        label: "Paperwork's payout access ends at or before the contract end",
        ok: !!payoutConsent && !payoutConsent.revoked && Date.parse(payoutConsent.expiresAt) > now && Date.parse(payoutConsent.expiresAt) <= Date.parse(endInstant(terms)),
        detail: payoutConsent?.expiresAt,
      },
    );
    const paid = this.attempts(id).filter(isPaid).reduce((n, x) => n + BigInt(x.amount_atomic), 0n);
    const balance = BigInt(observed.usdc || "0");
    checks.push(
      { id: "funded", label: "Paid plus balance against the scope total (information: the company could deposit more)", ok: paid + balance <= BigInt(totalAtomic(terms)), info: true, detail: `paid ${usdText(paid)} + balance ${usdText(balance)} of ${usdText(totalAtomic(terms))}` },
      { id: "signed", label: "The whole live policy matches what both parties signed (limits and USD budget included)", ok: !!p && policyDifferences(p, terms).length === 0, detail: p ? policyDifferences(p, terms).join("; ") || undefined : undefined },
      { id: "relay", label: "Paperwork relays the platform's read of the policy", ok: true, info: true },
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
      submissions: this.jobSubmissions(id),
      events: this.events(id),
    };
  }

  /** The next step without side effects: a stored sign request or a prepared owner step. POST onboarding/next makes new ones. */
  private peekNext(a: PlatformAgentRow | null, stage: SetupStage): NextStep | null {
    if (!a || stage === "needs_signatures" || stage === "active" || stage === "needs_funding" || stage === "ended" || stage === "frozen") return null;
    if (a.pending_sign) {
      const saved = JSON.parse(a.pending_sign);
      if (saved.kind && saved.request) return { kind: "dao_vote", retry_ms: 2000, label: "Waiting for the DAO vote", request: saved.request };
      if (saved.kind) return { kind: "wait", retry_ms: 2000, label: "Recovering the original DAO access request" };
      const p = JSON.parse(a.pending_sign) as { step: "setup" | "consent_payout" | "consent_owner"; message: string; nonce: string; recipient: string };
      return { kind: "sign", step: p.step, label: p.step === "setup" ? "Authorize platform setup" : p.step === "consent_payout" ? "Authorize payout requests until the job ends" : "Authorize owner-action preparation and read access after the job ends", sign: { account_id: a.owner, message: p.message, recipient: p.recipient, nonce: p.nonce } };
    }
    const s = this.d.db.query("SELECT * FROM owner_steps WHERE organization = ? AND kind != 'approval_vote' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(a.organization) as OwnerStepRow | null;
    if (stage === "policy_pending") return { kind: "wait", retry_ms: 2000, label: "Waiting for the signed policy to be in force" };
    if (s && (s.state === "submitted" || s.state === "unknown")) return { kind: "wait", retry_ms: 2000, label: "Checking the original signed action; do not sign again" };
    if (s && s.state === "prepared") return stepView(s, a.owner, s.standard === "dao" ? "Vote in the DAO" : "Sign in your wallet");
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
    const state: AttemptState = p.state === "failed" && p.resolution === "disputed" ? "disputed" : p.state === "failed" && p.resolution !== null ? "resolved" : p.state;
    return {
      request_id: p.request_id,
      payment_correlation_id: p.correlation_id,
      approval_vote_id: p.vote_correlation_id,
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
      never_executed: p.never_executed === 1,
      platform_record: p.platform_record,
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
    const owed = owedFor(terms, completionOf(JSON.parse(j.json) as Judgment), this.committedBy(id)).reduce((n, l) => n + l.amount, 0n);
    const remaining = this.jobBudgetRemaining(j);
    return remaining !== undefined && remaining < owed ? remaining : owed;
  }

  private jobBudgetRemaining(j: JudgmentRow): bigint | undefined {
    const job = this.jobForJudgment(j.id);
    if (!job) return undefined;
    const committed = this.attempts(j.contract_id).filter((a) => a.run_id === j.id && isCommitted(a)).reduce((n, a) => n + BigInt(a.amount_atomic), 0n);
    const left = BigInt(job.proposed_atomic) - committed;
    return left > 0n ? left : 0n;
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
