// Onboarding: the next-step orchestrator (plan 04 §5 rows 1–5) and the owner steps every owner action goes
// through (prepare → store a row before returning → wallet signs or confirm link → submit → status).
import type { Database } from "bun:sqlite";
import type { Fail, OwnerAction, OwnerPrepared, Platform, Signed413 } from "./platform/port";
import type { NextStep } from "../shared/views";
import { policyChanges, policyProblem } from "../shared/policy-request";
import { endInstant, type Terms } from "../shared/terms";
import type { ContractRow, OwnerStepRow, PlatformAgentRow } from "./db";
import { UserError } from "./engine";
import { nonceToString, randomNonce } from "./nep413";

const SETUP_TTL_MS = 30 * 60_000;
const MAX_CONSENT_MS = 366 * 86_400_000;
const WAIT_MS = 2_000;

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
      .run(row.organization, terms.representative.near_account, now, now);
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

  // ---------------------------------------------------------------- next step

  async next(id: string): Promise<NextStep> {
    const { row, terms } = this.d.contract(id);
    if (!row.rep_sig || !row.contractor_sig) throw new UserError("Both parties must sign the terms first.");
    if (row.frozen) throw new UserError("The contract wallet is frozen.");
    const a = this.ensureAgent(row, terms);
    const now = this.d.now();
    switch (a.stage) {
      case "needs_setup": {
        const expiresAt = new Date(now.getTime() + SETUP_TTL_MS).toISOString();
        const message = this.d.platform.setupMessage({ organization: a.organization, owner: a.owner, expiresAt });
        return this.signRequest(a, "setup", message, expiresAt, "Set up the contract's platform agent");
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
        return this.ownerStepFor(id, a, "agent_create", "Create the contract's agent", () => ({
          type: "agent_create",
          owner: { type: "near", account_id: a.owner, public_key: a.owner_public_key! },
          role: "payout",
        }));
      }
      case "needs_consent": {
        const end = Date.parse(endInstant(terms));
        if (end <= now.getTime() + 2 * 60_000) throw new UserError("The contract ends too soon to give Covenant access.");
        const cap = now.getTime() + MAX_CONSENT_MS;
        if (!a.payout_consent_id) {
          const expiresAt = new Date(Math.min(end, cap)).toISOString();
          const message = this.d.platform.consentMessage({ organization: a.organization, owner: a.owner, agent: a.agent!, agentId: a.agent_id!, scopes: ["payout"], expiresAt });
          return this.signRequest(a, "consent_payout", message, expiresAt, `Let Covenant request payouts until ${expiresAt.slice(0, 10)} (the contract end)`);
        }
        const expiresAt = new Date(Math.min(end + this.d.graceDays * 86_400_000, cap)).toISOString();
        const message = this.d.platform.consentMessage({ organization: a.organization, owner: a.owner, agent: a.agent!, agentId: a.agent_id!, scopes: ["owner", "read"], expiresAt });
        return this.signRequest(a, "consent_owner", message, expiresAt, `Let Covenant prepare your approvals and read the agent until ${expiresAt.slice(0, 10)}`);
      }
      case "needs_grant":
        return this.ownerStepFor(id, a, "grant_issue", "Issue the agent's payout grant", () => ({ type: "grant_issue", label: "payout" }));
      case "needs_policy":
        return this.ownerStepFor(id, a, "policy_update", "Agree the payee and limits", async () => {
          const o = await this.handle(a).overview();
          if (!o.ok || o.value.status !== "APPLIED" || o.value.revision === null || o.value.digest === null) return null;
          return { type: "policy_update", expectedPolicy: { revision: o.value.revision, digest: o.value.digest }, changes: policyChanges(terms) };
        });
      case "policy_pending": {
        const o = await this.handle(a).overview();
        if (!o.ok) return wait("Waiting for the platform to read the policy");
        const ov = o.value;
        if (ov.status === "FAILED") {
          this.setAgent(a.organization, { stage: "needs_policy" });
          this.d.event(id, "policy", "The policy edit failed at the platform. Sign it again.");
          return this.next(id);
        }
        if (ov.notInForce !== null || !ov.synced || ov.status !== "APPLIED") return wait("Waiting for the policy to be in force");
        const problem = policyProblem(ov, terms);
        if (problem) throw new UserError(`The applied policy does not match the terms: ${problem.detail}`, 409);
        this.setAgent(a.organization, { stage: "ready", policy_revision: ov.revision, policy_digest: ov.digest });
        this.d.event(id, "policy", `Policy in force (revision ${ov.revision}): only ${terms.payee.address}, owner approval on every payout, at most the largest deliverable per payment.`);
        return { kind: "done" };
      }
      case "ready":
        return { kind: "done" };
    }
  }

  private signRequest(a: PlatformAgentRow, step: SignStep, message: string, expiresAt: string, label: string): NextStep {
    const pending: PendingSign = { step, message, nonce: nonceToString(randomNonce()), recipient: this.d.platform.host, expires_at: expiresAt };
    this.setAgent(a.organization, { pending_sign: JSON.stringify(pending) });
    return { kind: "sign", step, label, sign: { account_id: a.owner, message, recipient: pending.recipient, nonce: pending.nonce } };
  }

  async signed(id: string, body: { step: SignStep; nonce: string; publicKey: string; signature: string }): Promise<NextStep> {
    const { row } = this.d.contract(id);
    const a = this.agentRow(row.organization);
    const pending = a?.pending_sign ? (JSON.parse(a.pending_sign) as PendingSign) : null;
    if (!a || !pending || pending.step !== body.step || pending.nonce !== body.nonce) throw new UserError("This signature doesn't answer the current step. Ask for the next step again.", 409);
    const s: Signed413 = { message: pending.message, nonce: pending.nonce, publicKey: body.publicKey, signature: body.signature };
    if (body.step === "setup") {
      let res = await this.d.platform.setup(s);
      for (let i = 0; i < 2 && !res.ok && res.kind === "unavailable"; i++) res = await this.d.platform.setup(s); // resend the same body
      if (!res.ok) throw failError(res, "setup");
      this.setAgent(a.organization, { agent: res.value.agent, setup_consent_id: res.value.consent.id, owner_public_key: body.publicKey, stage: "needs_create", pending_sign: null });
      this.d.event(id, "setup", `Platform agent ${res.value.agent} reserved for organization ${a.organization}.`);
    } else {
      const res = await this.d.platform.submitConsent(s);
      if (!res.ok) throw failError(res, "consent");
      if (body.step === "consent_payout") {
        this.setAgent(a.organization, { payout_consent_id: res.value.id, payout_consent_expires_at: res.value.expiresAt, pending_sign: null });
        this.d.event(id, "consent", `Covenant may request payouts until ${res.value.expiresAt} (the contract end).`);
      } else {
        this.setAgent(a.organization, { owner_consent_id: res.value.id, owner_consent_expires_at: res.value.expiresAt, pending_sign: null, stage: "needs_grant" });
        this.d.event(id, "consent", `Covenant may prepare approvals and read the agent until ${res.value.expiresAt}.`);
      }
    }
    return this.next(id);
  }

  // ---------------------------------------------------------------- owner steps

  private latestStep(organization: string, kind: string): OwnerStepRow | null {
    return this.d.db.query("SELECT * FROM owner_steps WHERE organization = ? AND kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(organization, kind) as OwnerStepRow | null;
  }

  private async ownerStepFor(id: string, a: PlatformAgentRow, kind: "agent_create" | "grant_issue" | "policy_update", label: string, build: () => OwnerAction | null | Promise<OwnerAction | null>): Promise<NextStep> {
    let s = this.latestStep(a.organization, kind);
    if (s && s.state === "prepared" && s.expires_at && Date.parse(s.expires_at) <= this.d.now().getTime() && !s.confirm_url) {
      this.setStep(s.correlation_id, { state: "expired" });
      s = this.step(s.correlation_id);
    }
    if (s && (s.state === "submitted" || s.state === "unknown" || (s.state === "prepared" && s.confirm_url))) s = await this.pollStep(s.correlation_id);
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
    const res = await this.handle(a).ownerPrepare(action);
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
        p.intent ? "nep413" : "nep366",
        p.intent ? JSON.stringify(p.intent) : null,
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
   * status, never by signing again. Votes are not followed through owner/status (the payout is followed instead).
   */
  async submitStep(correlationId: string, sig: { publicKey: string; signature: string }): Promise<OwnerStepRow> {
    const s = this.step(correlationId);
    if (s.state !== "prepared") throw new UserError(`This step is already ${s.state}.`, 409);
    if (!s.intent) throw new UserError("This step is confirmed on the platform's page, not signed here.");
    const a = this.agentRow(s.organization);
    if (!a) throw new UserError("Unknown organization.", 404);
    const res = await this.handle(a).ownerSubmit(correlationId, JSON.parse(s.intent), sig);
    if (!res.ok) {
      if (res.kind === "unavailable" || res.kind === "unknown" || res.kind === "provider") {
        this.setStep(correlationId, { state: "unknown" });
        return this.step(correlationId);
      }
      this.setStep(correlationId, { state: "failed", failure_code: failCode(res) });
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
    const live = s.state === "submitted" || s.state === "unknown" || (s.state === "prepared" && !!s.confirm_url);
    if (!live || s.kind === "approval_vote") return s;
    const a = this.agentRow(s.organization);
    if (!a) return s;
    const res = await this.handle(a).ownerStatus(correlationId);
    if (!res.ok) return s;
    const { stage, status, failureCode } = res.value;
    if (status === "SUCCESS") {
      this.setStep(correlationId, { state: "success" });
      await this.applySuccess(this.step(correlationId));
    } else if (status === "FAILED" || status === "REFUNDED" || stage === "failed") {
      this.setStep(correlationId, { state: "failed", failure_code: failureCode });
    } else if (stage === "expired") {
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
        this.setAgent(a.organization, { grant_ok: 1, stage: "needs_policy" });
        this.d.event(s.contract_id, "grant", "Payout grant issued to the agent.");
        return;
      case "policy_update":
        if (a.stage !== "needs_policy") return;
        this.setAgent(a.organization, { stage: "policy_pending" });
        this.d.event(s.contract_id, "policy", "Policy edit signed: payee, owner approval, per-payment cap, daily/monthly limits and budget.");
        return;
    }
  }

  private iso() {
    return this.d.now().toISOString();
  }
}

function wait(label: string): NextStep {
  return { kind: "wait", label, retry_ms: WAIT_MS };
}

export function stepView(s: OwnerStepRow, owner: string, label: string): NextStep {
  const intent = s.intent ? (JSON.parse(s.intent) as { payload: { message: string; recipient: string; nonce: string } }) : null;
  return {
    kind: "owner_step",
    correlation_id: s.correlation_id,
    action: s.kind as NextStep extends { action: infer A } ? A : never,
    label,
    summary: s.summary ?? "",
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
