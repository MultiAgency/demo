import type { DaoRequest } from "./market/port";
// Onboarding: what the representative does next (setup, create, consents, grant, policy), and the owner steps every owner action goes
// through (prepare → store a row before returning → wallet signs or confirm link → submit → status).
import type { Database } from "bun:sqlite";
import type { Fail, OwnerAction, OwnerPrepared, Platform, Res, Signed413 } from "./platform/port";
import type { NextStep } from "../shared/views";
import { policyChanges, policyProblem } from "../shared/policy-request";
import { endInstant, type Terms } from "../shared/terms";
import type { ContractRow, OwnerStepRow, PlatformAgentRow } from "./db";
import { UserError } from "./engine";
import { nonceToString, randomNonce } from "./nep413";

const SETUP_TTL_MS = 30 * 60_000;
const MAX_CONSENT_MS = 366 * 86_400_000;
const WAIT_MS = 2_000;
/** Setup refusals after which the agent may still exist: the body expired before a resend, or the agent was created. */
const RECOVERABLE_SETUP_CODES = new Set(["already_created", "expired", "signed_expired"]);

export interface OnboardingDeps {
  db: Database;
  platform: Platform;
  now: () => Date;
  graceDays: number;
  event: (contractId: string, kind: string, text: string) => void;
  contract: (id: string) => { row: ContractRow; terms: Terms };
}

type SignStep = "setup" | "consent_payout" | "consent_owner";
interface PendingSign {
  step: SignStep;
  message: string;
  nonce: string;
  recipient: string;
  expires_at: string;
}

export class Onboarding {
  constructor(private d: OnboardingDeps) {}

  // ---------------------------------------------------------------- rows

  agentRow(organization: string): PlatformAgentRow | null {
    return this.d.db.query("SELECT * FROM platform_agents WHERE organization = ?").get(organization) as PlatformAgentRow | null;
  }

  private ensureAgent(row: ContractRow, terms: Terms): PlatformAgentRow {
    const existing = this.agentRow(row.organization);
    if (existing) return existing;
    const now = this.iso();
    this.d.db
      .query("INSERT INTO platform_agents (organization, owner, stage, created_at, updated_at) VALUES (?, ?, 'needs_setup', ?, ?)")
      .run(row.organization, terms.v === 3 && terms.agency_owner ? terms.agency_owner.account_id : terms.representative.near_account, now, now);
    return this.agentRow(row.organization)!;
  }

  setAgent(organization: string, fields: Partial<Omit<PlatformAgentRow, "organization">>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.d.db
      .query(`UPDATE platform_agents SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE organization = ?`)
      .run(...(Object.values(fields) as (string | number | null)[]), this.iso(), organization);
  }

  step(correlationId: string): OwnerStepRow {
    const s = this.d.db.query("SELECT * FROM owner_steps WHERE correlation_id = ?").get(correlationId) as OwnerStepRow | null;
    if (!s) throw new UserError("No such owner step.", 404);
    return s;
  }

  private setStep(correlationId: string, fields: Partial<Omit<OwnerStepRow, "correlation_id">>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.d.db
      .query(`UPDATE owner_steps SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE correlation_id = ?`)
      .run(...(Object.values(fields) as (string | null)[]), this.iso(), correlationId);
  }

  handle(a: PlatformAgentRow) {
    if (!a.agent) throw new UserError("The platform agent is not set up yet.");
    return this.d.platform.agent(a.organization, a.agent);
  }

  private isDao(id: string): boolean { const t = this.d.contract(id).terms; return t.v === 3 && t.agency_owner?.type === "dao"; }

  // ---------------------------------------------------------------- next step

  async next(id: string): Promise<NextStep> {
    const { row, terms } = this.d.contract(id);
    if (!row.rep_sig || !row.contractor_sig) throw new UserError("Both parties must sign the terms first.");
    if (row.frozen) throw new UserError("The owner froze this job's agent. Nothing pays until they unfreeze it.", 409);
    const a = this.ensureAgent(row, terms);
    const now = this.d.now();
    switch (a.stage) {
      case "needs_setup": {
        if (this.isDao(id)) return this.daoAccess(id, a, "setup");
        const expiresAt = new Date(now.getTime() + SETUP_TTL_MS).toISOString();
        return this.signRequest(a, "setup", (expiry) => this.d.platform.setupMessage({ organization: a.organization, owner: a.owner, expiresAt: expiry }), expiresAt, "Set up the job's platform agent");
      }
      case "needs_create": {
        const pending = this.latestStep(a.organization, "agent_create");
        if (!pending || pending.state === "failed" || pending.state === "expired") {
          // The setup reply must be visible first: the agent exists, not yet created.
          const who = await this.d.platform.identity(a.agent!);
          if (!who.ok) return wait("Waiting for the platform to record the setup");
          if (who.value.created && who.value.agentId) {
            this.setAgent(a.organization, { agent_id: who.value.agentId, stage: "needs_consent" });
            return this.next(id);
          }
        }
        return this.ownerStepFor(id, a, "agent_create", "Create the job's agent", () => ({
          type: "agent_create",
          ...(!this.isDao(id) && { owner: { type: "near" as const, account_id: a.owner, public_key: a.owner_public_key! } }),
          role: "payout",
        }));
      }
      case "needs_consent": {
        if (this.isDao(id)) return this.daoAccess(id, a, "consent");
        const end = Date.parse(endInstant(terms));
        if (end <= now.getTime() + 2 * 60_000) throw new UserError("The job ends too soon to give Paperwork access.");
        const cap = now.getTime() + MAX_CONSENT_MS;
        if (!a.payout_consent_id) {
          const expiresAt = new Date(Math.min(end, cap)).toISOString();
          return this.signRequest(a, "consent_payout", (expiry) => this.d.platform.consentMessage({ organization: a.organization, owner: a.owner, agent: a.agent!, agentId: a.agent_id!, scopes: ["payout"], expiresAt: expiry }), expiresAt, `Let Paperwork request payouts until ${expiresAt.slice(0, 10)} (the job end)`);
        }
        const expiresAt = new Date(Math.min(end + this.d.graceDays * 86_400_000, cap)).toISOString();
        return this.signRequest(a, "consent_owner", (expiry) => this.d.platform.consentMessage({ organization: a.organization, owner: a.owner, agent: a.agent!, agentId: a.agent_id!, scopes: ["owner", "read"], expiresAt: expiry }), expiresAt, `Let Paperwork prepare your approvals and read the agent until ${expiresAt.slice(0, 10)}`);
      }
      case "needs_grant":
        return this.ownerStepFor(id, a, "grant_issue", "Issue the agent's payout grant", () => ({ type: "grant_issue", label: "payout" }));
      case "needs_policy":
        return this.ownerStepFor(id, a, "policy_update", "Agree the payee and limits", async () => {
          const o = await this.handle(a).overview();
          if (!o.ok || o.value.status !== "APPLIED" || o.value.revision === null || o.value.digest === null) return null;
          return { type: "policy_update", expectedPolicy: { revision: o.value.revision, digest: o.value.digest }, changes: policyChanges(terms) };
        });
      case "policy_pending":
        return this.observePolicy(id, a, terms);
      case "ready":
        return { kind: "done" };
    }
  }

  private async observePolicy(id: string, a: PlatformAgentRow, terms: Terms): Promise<NextStep> {
    const o = await this.handle(a).overview();
    if (!o.ok) return wait("Waiting for the platform to read the policy");
    const ov = o.value;
    if (ov.status === "FAILED") {
      // Stop and tell the owner; don't prepare a new edit. The platform relays the provider's FAILED without a
      // recovery rule, and a new policy_update needs the owner's signature against the current revision anyway.
      const signed = this.latestStep(a.organization, "policy_update");
      if (signed && signed.state !== "failed") {
        this.setStep(signed.correlation_id, { state: "failed", failure_code: "policy_failed" });
        this.d.event(id, "alert", `The platform reports the policy edit FAILED (revision ${ov.revision}). Nothing can be paid until a revision applies.`);
      }
      throw new UserError(`The platform reports the policy edit FAILED (revision ${ov.revision}). Nothing can be paid until a revision applies; check the agent's policy history before signing a new edit.`, 409);
    }
    if (ov.notInForce !== null || !ov.synced || ov.status !== "APPLIED") return wait("Waiting for the policy to be in force");
    // An earlier revision still in force must not end the wait: the signed edit has to land above the one it was prepared against.
    const preparedAt = preparedRevision(this.latestStep(a.organization, "policy_update"));
    if (preparedAt !== null && (ov.revision === null || ov.revision <= preparedAt)) return wait("Waiting for the signed policy revision to apply");
    const problem = policyProblem(ov, terms);
    if (problem) throw new UserError(`The applied policy does not match the terms: ${problem.detail}`, 409);
    this.setAgent(a.organization, { stage: "ready", policy_revision: ov.revision, policy_digest: ov.digest });
    this.d.event(id, "policy", `Policy in force (revision ${ov.revision}): only ${terms.payee.address}, owner approval on every payout, at most the largest deliverable per payment.`);
    return { kind: "done" };
  }

  /** Observe only saved work. Never prepare, file, sign or submit a new action during a status read. */
  async reconcile(id: string): Promise<void> {
    const { row } = this.d.contract(id);
    let a = this.agentRow(row.organization);
    if (!a || !row.rep_sig || !row.contractor_sig || row.frozen) return;
    if (this.isDao(id) && a.pending_sign) {
      const saved = JSON.parse(a.pending_sign);
      if (saved.request && (saved.kind === "setup" || saved.kind === "consent"))
        await this.daoAccess(id, a, saved.kind, true);
    }
    a = this.agentRow(row.organization)!;
    const kind = a.stage === "needs_create" ? "agent_create" : a.stage === "needs_grant" ? "grant_issue" : a.stage === "needs_policy" ? "policy_update" : null;
    if (kind) {
      const saved = this.latestStep(a.organization, kind);
      if (saved) {
        const observed = await this.pollStep(saved.correlation_id);
        // A successful creation can precede the identity becoming readable. Reapply locally, without resubmission.
        if (observed.state === "success") await this.applySuccess(observed);
      }
    }
    a = this.agentRow(row.organization)!;
    if (a.stage === "policy_pending") await this.observePolicy(id, a, this.d.contract(id).terms);
  }

  private async daoAccess(id: string, a: PlatformAgentRow, kind: "setup" | "consent", observeOnly = false): Promise<NextStep> {
    const platform = this.d.platform;
    if (!platform.daoSetup || !platform.daoConsent) throw new UserError("This platform does not support DAO payout access.", 409);
    const terms = this.d.contract(id).terms;
    const readOnly = kind === "consent" && !!a.payout_consent_id;
    const expiresAt = kind === "setup" ? new Date(this.d.now().getTime() + SETUP_TTL_MS).toISOString()
      : new Date(Math.min(Date.parse(endInstant(terms)) + (readOnly ? this.d.graceDays * 86_400_000 : 0), this.d.now().getTime() + MAX_CONSENT_MS)).toISOString();
    if (!observeOnly && Date.parse(expiresAt) <= this.d.now().getTime() + 120_000) throw new UserError("The job ends too soon for DAO consent.", 409);
    let saved = a.pending_sign ? JSON.parse(a.pending_sign) as { kind: string; request?: DaoRequest; message: string } : null;
    const api = kind === "setup" ? platform.daoSetup : platform.daoConsent;
    if (saved && saved.kind !== kind) throw new UserError("A different DAO access request is unresolved.", 409);
    if (observeOnly && !saved?.request) return wait("Waiting for an existing DAO request");
    if (!saved) {
      const message = kind === "setup" ? platform.setupMessage({ organization: a.organization, owner: a.owner, expiresAt })
        : platform.consentMessage({ organization: a.organization, owner: a.owner, agent: a.agent!, agentId: a.agent_id!, scopes: readOnly ? ["read"] : ["read", "payout"], expiresAt });
      saved = { kind, message };
      this.setAgent(a.organization, { pending_sign: JSON.stringify(saved) });
    }
    if (!saved.request) {
      const filed = await api.file(saved.message);
      if (!filed.ok) throw failError(filed, "dao_" + kind);
      saved.request = filed.value;
      this.setAgent(a.organization, { pending_sign: JSON.stringify(saved) });
    }
    const observed = kind === "setup" ? await platform.daoSetup.state(saved.request.id) : await platform.daoConsent.state(saved.request.id);
    if (!observed.ok) throw failError(observed, "dao_" + kind);
    if (observed.value.state === "expired") {
      this.setAgent(a.organization, { pending_sign: null });
      return wait("The original DAO access vote expired; prepare a fresh vote.");
    }
    if (observed.value.state === "pending") return { kind: "dao_vote", retry_ms: WAIT_MS, label: kind === "setup" ? "Vote to set up the job agent" : readOnly ? "Vote to retain read access after payout consent ends" : "Vote to consent to job payouts", request: saved.request };
    const result = observed.value;
    if (kind === "setup" && "agent" in result && typeof result.agent === "string") this.setAgent(a.organization, { agent: result.agent, setup_consent_id: result.consent.id, stage: "needs_create", pending_sign: null });
    else if (readOnly) this.setAgent(a.organization, { owner_consent_id: result.consent.id, owner_consent_expires_at: result.consent.expiresAt, stage: "needs_grant", pending_sign: null });
    else this.setAgent(a.organization, { payout_consent_id: result.consent.id, payout_consent_expires_at: result.consent.expiresAt, stage: "needs_consent", pending_sign: null });
    return observeOnly ? { kind: "done" } : this.next(id);
  }

  private signRequest(a: PlatformAgentRow, step: SignStep, messageFor: (expiresAt: string) => string, expiresAt: string, label: string): NextStep {
    const saved = a.pending_sign ? JSON.parse(a.pending_sign) as PendingSign : null;
    const reuse = saved && saved.step === step && saved.recipient === this.d.platform.host &&
      Date.parse(saved.expires_at) > this.d.now().getTime() && Date.parse(saved.expires_at) <= Date.parse(expiresAt) &&
      saved.message === messageFor(saved.expires_at);
    const pending: PendingSign = reuse ? saved : { step, message: messageFor(expiresAt), nonce: nonceToString(randomNonce()), recipient: this.d.platform.host, expires_at: expiresAt };
    if (!reuse) this.setAgent(a.organization, { pending_sign: JSON.stringify(pending) });
    return { kind: "sign", step, label, sign: { account_id: a.owner, message: pending.message, recipient: pending.recipient, nonce: pending.nonce } };
  }

  async signed(id: string, body: { step: SignStep; nonce: string; publicKey: string; signature: string }): Promise<NextStep> {
    if (this.isDao(id)) throw new UserError("DAO access is authorized by its proposal, not a member signature.", 409);
    const { row } = this.d.contract(id);
    const a = this.agentRow(row.organization);
    const pending = a?.pending_sign ? (JSON.parse(a.pending_sign) as PendingSign) : null;
    if (!a || !pending || pending.step !== body.step || pending.nonce !== body.nonce) throw new UserError("This signature doesn't answer the current step. Ask for the next step again.", 409);
    if (Date.parse(pending.expires_at) <= this.d.now().getTime()) throw new UserError("This signing request has expired. Ask for the next step again.", 409);
    const s: Signed413 = { message: pending.message, nonce: pending.nonce, publicKey: body.publicKey, signature: body.signature };
    if (body.step === "setup") {
      // Resending the same body while it is unexpired answers the same agent and consent and reserves nothing new.
      let res = await this.d.platform.setup(s);
      for (let i = 0; i < 2 && !res.ok && (res.kind === "unavailable" || res.kind === "unknown"); i++) res = await this.d.platform.setup(s);
      if (res.ok) {
        this.setAgent(a.organization, { agent: res.value.agent, setup_consent_id: res.value.consent.id, owner_public_key: body.publicKey, stage: "needs_create", pending_sign: null });
        this.d.event(id, "setup", `Platform agent ${res.value.agent} reserved for organization ${a.organization}.`);
      } else {
        const agent = await this.reservedAgent(a, res);
        if (!agent) throw failError(res, "setup");
        this.setAgent(a.organization, { agent, setup_consent_id: null, owner_public_key: body.publicKey, stage: "needs_create", pending_sign: null });
        this.d.event(id, "setup", `The setup reply was lost (${failCode(res)}); the platform lists agent ${agent} as reserved for organization ${a.organization}.`);
      }
    } else {
      const res = await this.d.platform.submitConsent(s);
      if (!res.ok) throw failError(res, "consent");
      if (body.step === "consent_payout") {
        this.setAgent(a.organization, { payout_consent_id: res.value.id, payout_consent_expires_at: res.value.expiresAt, pending_sign: null });
        this.d.event(id, "consent", `Paperwork may request payouts until ${res.value.expiresAt} (the job end).`);
      } else {
        this.setAgent(a.organization, { owner_consent_id: res.value.id, owner_consent_expires_at: res.value.expiresAt, pending_sign: null, stage: "needs_grant" });
        this.d.event(id, "consent", `Paperwork may prepare approvals and read the agent until ${res.value.expiresAt}.`);
      }
    }
    return this.next(id);
  }

  /**
   * The agent a setup reserved when its reply was lost, the signed setup expired before it could be resent, or the
   * platform answered `already_created`: `reservations` lists this deployment's agents for the Organization and owner.
   * Null when the platform names none, or more than one, or predates 0.5.5 (refused 404).
   */
  private async reservedAgent(a: PlatformAgentRow, f: Fail): Promise<string | null> {
    const code = "code" in f ? f.code : undefined;
    const lost = f.kind === "unknown" || f.kind === "unavailable";
    if (!lost && !(code && RECOVERABLE_SETUP_CODES.has(code))) return null;
    const r = await this.d.platform.reservations(a.organization, a.owner);
    if (!r.ok) return null;
    const live = r.value.filter((x) => !x.released && x.owner === a.owner);
    return live.length === 1 ? live[0]!.agent : null;
  }

  // ---------------------------------------------------------------- owner steps

  private latestStep(organization: string, kind: string): OwnerStepRow | null {
    return this.d.db.query("SELECT * FROM owner_steps WHERE organization = ? AND kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(organization, kind) as OwnerStepRow | null;
  }

  private async ownerStepFor(id: string, a: PlatformAgentRow, kind: "agent_create" | "grant_issue" | "policy_update", label: string, build: () => OwnerAction | null | Promise<OwnerAction | null>): Promise<NextStep> {
    let s = this.latestStep(a.organization, kind);
    if (s && s.state === "prepared" && s.expires_at && Date.parse(s.expires_at) <= this.d.now().getTime() && !s.confirm_url && s.standard !== "dao") {
      this.setStep(s.correlation_id, { state: "expired" });
      s = this.step(s.correlation_id);
    }
    if (s && (s.state === "submitted" || s.state === "unknown" || (s.state === "prepared" && (s.confirm_url || s.standard === "dao")))) s = await this.pollStep(s.correlation_id);
    if (s?.state === "success") {
      await this.applySuccess(s);
      return this.agentRow(a.organization)!.stage === a.stage ? wait("Waiting for the platform to show the change") : this.next(id);
    }
    if (s && (s.state === "submitted" || s.state === "unknown")) return wait("Waiting for the platform to apply the signed step");
    if (s && s.state === "prepared") return stepView(s, a.owner, label);
    const action = await build();
    if (!action) return wait("Waiting for the agent's current policy to apply");
    try {
      return stepView(await this.prepare(id, a, action), a.owner, label);
    } catch (err) {
      // A failed ownerPrepare answers `unknown`/`unavailable`: nothing was stored, so simply prepare again later.
      if (err instanceof UserError && err.status === 503) return wait("The platform did not answer; preparing the step again shortly");
      throw err;
    }
  }

  /** ownerPrepare, then store the row before anything is returned. */
  async prepare(contractId: string, a: PlatformAgentRow, action: OwnerAction, extra: { request_id?: string; verdict?: string } = {}): Promise<OwnerStepRow> {
    const res = await this.handle(a).ownerPrepare(action, this.isDao(contractId) ? "dao" : "wallet");
    if (!res.ok) throw failError(res, action.type);
    const p: OwnerPrepared = res.value;
    const now = this.iso();
    this.d.db
      .query(
        `INSERT INTO owner_steps (correlation_id, organization, contract_id, kind, action, standard, intent, confirm_url, expires_at, summary, payment_terms, request_id, verdict, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
      )
      .run(
        p.correlationId,
        a.organization,
        contractId,
        action.type,
        JSON.stringify(action),
        p.dao ? "dao" : p.intent ? "nep413" : "nep366",
        p.dao ? JSON.stringify({ dao: p.dao }) : p.intent ? JSON.stringify(p.intent) : null,
        p.confirm?.url ?? null,
        p.confirm?.expiresAt ?? p.expiresAt,
        p.summary,
        p.payment ? JSON.stringify(p.payment) : null,
        extra.request_id ?? null,
        extra.verdict ?? null,
        now,
        now,
      );
    return this.step(p.correlationId);
  }

  /**
   * Submit the wallet's NEP-413 signature. A lost reply leaves the step `unknown` and is answered by reading the
   * status, never by signing again. Confirmation links also need their owner-intent status; money follows payout status.
   */
  async submitStep(correlationId: string, sig: { publicKey: string; signature: string }): Promise<OwnerStepRow> {
    const s = this.step(correlationId);
    if (s.state !== "prepared") throw new UserError(`This step is already ${s.state}.`, 409);
    if (s.standard === "dao" || !s.intent) throw new UserError("This step is confirmed on the platform's page, not signed here.");
    const a = this.agentRow(s.organization);
    if (!a) throw new UserError("Unknown organization.", 404);
    // Claim before external I/O. A crash, a thrown transport error or a lost reply must never leave this signable.
    this.d.db.transaction(() => {
      if (s.kind === "approval_vote" && s.request_id) {
        const other = this.d.db.query("SELECT correlation_id FROM owner_steps WHERE request_id = ? AND kind = 'approval_vote' AND correlation_id != ? AND state IN ('submitted', 'unknown') LIMIT 1")
          .get(s.request_id, correlationId) as { correlation_id: string } | null;
        if (other) throw new UserError("A vote for this payout is already submitted or uncertain. Follow its original identity before preparing another.", 409);
      }
      const claimed = this.d.db.query("UPDATE owner_steps SET state = 'unknown', updated_at = ? WHERE correlation_id = ? AND state = 'prepared'").run(this.iso(), correlationId);
      if (claimed.changes !== 1) throw new UserError("This owner step was already submitted. Follow its original identity.", 409);
      if (s.kind === "approval_vote" && s.request_id && (s.verdict === "approve" || s.verdict === "reject"))
        this.d.db.query("UPDATE payout_attempts SET vote = ?, vote_correlation_id = ?, updated_at = ? WHERE request_id = ?").run(s.verdict, correlationId, this.iso(), s.request_id);
    })();
    let res: Res<{ status: string; failureCode: string | null }>;
    try { res = await this.handle(a).ownerSubmit(correlationId, JSON.parse(s.intent), sig); }
    catch { return this.step(correlationId); }
    if (!res.ok) {
      if (res.kind === "unavailable" || res.kind === "unknown" || res.kind === "provider") {
        this.setStep(correlationId, { state: "unknown" });
        return this.step(correlationId);
      }
      this.d.db.transaction(() => {
        this.setStep(correlationId, { state: "failed", failure_code: failCode(res) });
        // The durable claim guards an uncertain submission. A definite refusal did not record the owner's decision;
        // retain the failed owner-step identity but remove only this attempt's tentative decision/link.
        if (s.kind === "approval_vote" && s.request_id)
          this.d.db.query("UPDATE payout_attempts SET vote = NULL, vote_correlation_id = NULL, updated_at = ? WHERE request_id = ? AND vote_correlation_id = ?")
            .run(this.iso(), s.request_id, correlationId);
      })();
      throw failError(res, s.kind);
    }
    const status = res.value.status;
    if (status === "SUCCESS" && s.kind !== "approval_vote") {
      this.setStep(correlationId, { state: "success" });
      await this.applySuccess(this.step(correlationId));
      return this.step(correlationId);
    }
    if ((status === "FAILED" || status === "REFUNDED") && s.kind !== "approval_vote") {
      this.setStep(correlationId, { state: "failed", failure_code: res.value.failureCode });
      return this.step(correlationId);
    }
    this.setStep(correlationId, { state: "submitted" });
    return s.kind === "approval_vote" ? this.step(correlationId) : this.pollStep(correlationId);
  }

  /** Read owner/status for a submitted (or confirm-link) step and apply its effect on success. */
  async pollStep(correlationId: string): Promise<OwnerStepRow> {
    const s = this.step(correlationId);
    const live = s.state === "submitted" || s.state === "unknown" || (s.state === "prepared" && (!!s.confirm_url || s.standard === "dao"));
    if (!live || (s.kind === "approval_vote" && !s.confirm_url && s.standard !== "dao")) return s;
    const a = this.agentRow(s.organization);
    if (!a) return s;
    const res = await this.handle(a).ownerStatus(correlationId);
    if (!res.ok) return s;
    const { stage, status, failureCode } = res.value;
    if (s.kind === "approval_vote") {
      // A local link deadline is not proof: the owner may have signed elsewhere. Read the original platform intent.
      // Its authoritative expired phase is available in SDK 0.5.6; legacy explicit unsubmitted expiry is also safe.
      const submitted = res.value.phase === "submitted" || res.value.phase === "settled" || stage === "submitted" || stage === "submitting" || status === "SUCCESS";
      const expired = !submitted && (res.value.phase === "expired" || (!res.value.phase && (stage === "expired" || (stage === "prepared" && status === "EXPIRED"))));
      this.d.db.transaction(() => {
        if (expired) {
          this.setStep(correlationId, { state: "expired", failure_code: "unsubmitted_expired" });
          if (s.request_id) this.d.db.query("UPDATE payout_attempts SET vote = NULL, vote_correlation_id = NULL, updated_at = ? WHERE request_id = ? AND vote_correlation_id = ?")
            .run(this.iso(), s.request_id, correlationId);
        } else if (submitted || stage === "failed" || status === "FAILED" || status === "REFUNDED") {
          this.setStep(correlationId, { state: submitted ? "submitted" : "unknown", failure_code: failureCode });
          if (s.request_id && (s.verdict === "approve" || s.verdict === "reject"))
            this.d.db.query("UPDATE payout_attempts SET vote = ?, vote_correlation_id = ?, updated_at = ? WHERE request_id = ?")
              .run(s.verdict, correlationId, this.iso(), s.request_id);
        }
      })();
      return this.step(correlationId);
    }
    if (status === "SUCCESS") {
      this.setStep(correlationId, { state: "success" });
      await this.applySuccess(this.step(correlationId));
    } else if (status === "FAILED" || status === "REFUNDED" || stage === "failed") {
      this.setStep(correlationId, { state: "failed", failure_code: failureCode });
    } else if (stage === "expired" || res.value.phase === "expired") {
      this.setStep(correlationId, { state: "expired", failure_code: failureCode });
    }
    return this.step(correlationId);
  }

  private async applySuccess(s: OwnerStepRow) {
    const a = this.agentRow(s.organization);
    if (!a || !s.contract_id) return;
    switch (s.kind) {
      case "agent_create": {
        if (a.agent_id) return;
        const who = await this.d.platform.identity(a.agent!);
        if (who.ok && who.value.agentId) {
          this.setAgent(a.organization, { agent_id: who.value.agentId, stage: "needs_consent" });
          this.d.event(s.contract_id, "wallet", `Agent ${who.value.agentId} created, owned by ${a.owner}.`);
        }
        return;
      }
      case "grant_issue":
        if (a.grant_ok) return;
        // A re-issued grant (the first one expired) returns straight to ready: the policy is already in force.
        this.setAgent(a.organization, { grant_ok: 1, stage: a.policy_revision !== null ? "ready" : "needs_policy" });
        this.d.event(s.contract_id, "grant", a.policy_revision !== null ? "Payout grant issued to the agent again. Payouts continue." : "Payout grant issued to the agent.");
        return;
      case "policy_update":
        if (a.stage !== "needs_policy") return;
        this.setAgent(a.organization, { stage: "policy_pending" });
        this.d.event(s.contract_id, "policy", "Policy edit signed: payee, owner approval, per-payment cap, daily/monthly limits and budget.");
        return;
    }
  }

  /**
   * The payout grant is gone or about to expire (the platform issues it for 30 days): back to the grant_issue step,
   * so the representative issues it again. The old step is marked expired so it isn't taken for the new one.
   */
  grantExpired(contractId: string, a: PlatformAgentRow) {
    if (a.stage === "needs_grant") return;
    const old = this.latestStep(a.organization, "grant_issue");
    if (old && old.state === "success") this.setStep(old.correlation_id, { state: "expired" });
    this.setAgent(a.organization, { grant_ok: 0, stage: "needs_grant" });
    this.d.event(contractId, "alert", "The agent's payout grant has expired or expires within a day. Nothing is requested until the representative issues it again (next setup step).");
  }

  private iso() {
    return this.d.now().toISOString();
  }
}

/** The policy revision a signed policy_update was prepared against, from its stored action. */
function preparedRevision(s: OwnerStepRow | null): number | null {
  if (!s || s.state !== "success") return null;
  try {
    const r = JSON.parse(s.action)?.expectedPolicy?.revision;
    return typeof r === "number" ? r : null;
  } catch {
    return null;
  }
}

function wait(label: string): NextStep {
  return { kind: "wait", label, retry_ms: WAIT_MS };
}

export function stepView(s: OwnerStepRow, owner: string, label: string): NextStep {
  const intent = s.standard !== "dao" && s.intent ? (JSON.parse(s.intent) as { payload: { message: string; recipient: string; nonce: string } }) : null;
  return {
    kind: "owner_step",
    correlation_id: s.correlation_id,
    action: s.kind as NextStep extends { action: infer A } ? A : never,
    label,
    summary: s.summary ?? "",
    ...(s.standard === "dao" && s.intent ? { dao: JSON.parse(s.intent).dao } : {}),
    ...(intent ? { sign: { account_id: owner, message: intent.payload.message, recipient: intent.payload.recipient, nonce: intent.payload.nonce } } : {}),
    ...(s.confirm_url ? { confirm: { url: s.confirm_url, expires_at: s.expires_at ?? "" } } : {}),
  };
}

export function failCode(f: Fail): string {
  if (f.kind === "refused") return f.code;
  if (f.kind === "forbidden") return f.code ?? "forbidden";
  if (f.kind === "session") return "credential";
  return f.kind;
}

/** A platform failure as a user-facing error. Never includes the credential (the platform never echoes it). */
export function failError(f: Fail, what: string): UserError {
  const code = failCode(f);
  const status = f.kind === "forbidden" ? 403 : f.kind === "refused" ? (code === "request_conflict" ? 409 : 400) : f.kind === "session" ? 502 : 503;
  return new UserError(`The platform did not accept ${what}: ${code}.`, status);
}
