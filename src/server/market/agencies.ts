// An agency's market agent: one per agency, owned by a wallet or a DAO, set up through the platform's `market` area.
// Wallet: setup → create → consent (read, owner, market) → market grant → the payment key's USDC registration.
// DAO: the same steps, each a vote the platform files (setup, creation, consent with read and market, the grant).
import type { Database } from "bun:sqlite";
import { registrationTransaction } from "@multiagency/sdk";
import type { AgencyNext, DaoVoteView, DepositView } from "../../shared/market";
import { USDC_NEAR } from "../../shared/terms";
import { UserError } from "../engine";
import { nonceToString, randomNonce } from "../nep413";
import { failCode, failError } from "../onboarding";
import type { ChainReader } from "../platform/port";
import { type AgencyRow, type AgencyStage, type DaoVoteRow, type MarketStepRow, update } from "./db";
import type { DaoRequest, Fail, MarketAgent, MarketOwnerAction, MarketPlatform, OwnerPrepared } from "./port";

const SETUP_TTL_MS = 30 * 60_000;
/** A DAO's setup may last at most 7 days (the platform's limit); two leaves room for a vote. */
const DAO_SETUP_TTL_MS = 2 * 86_400_000;
const CONSENT_MS = 90 * 86_400_000;
/** Setup refusals after which the agent may exist: the body expired before a resend, or the agent was created. */
const RECOVERABLE_SETUP_CODES = new Set(["already_created", "expired", "signed_expired"]);
/** How long a text issued for the wallet stays the one to sign: a second request for the step answers it again. */
const SIGN_REUSE_MS = 10 * 60_000;
const WAIT_MS = 2_000;
/** The consent the user decided for a DAO owner (2026-11-09): reads and hires, nothing else. */
export const DAO_SCOPES = ["read", "market"] as const;
export const WALLET_SCOPES = ["read", "owner", "market"] as const;

export interface AgenciesDeps {
  db: Database;
  market: MarketPlatform;
  chain: ChainReader;
  now: () => Date;
}

interface PendingSign {
  step: "setup" | "consent";
  message: string;
  nonce: string;
  recipient: string;
  issued_at?: string;
}

const wait = (label: string): AgencyNext => ({ kind: "wait", label, retry_ms: WAIT_MS });
/**
 * A DAO request the platform answered with a refusal rather than a transient failure: it ended (a DAO stop ends pending
 * consent requests, 409; a finished one is removed after 30 days, 404). Filed again rather than waited on.
 */
export const ended = (f: Fail) => f.kind === "refused" || f.kind === "forbidden";
const STEP_SUMMARY: Record<MarketStepRow["kind"], string> = {
  agent_create: "Create the agency's market agent",
  grant_issue: "Issue the market agent's grant",
  agent_freeze: "Freeze the market agent",
  agent_unfreeze: "Unfreeze the market agent",
};

export class Agencies {
  constructor(private d: AgenciesDeps) {}

  private iso() {
    return this.d.now().toISOString();
  }

  // ---------------------------------------------------------------- rows

  create(i: { name: string; owner: string; signer: "wallet" | "dao" }): AgencyRow {
    const name = i.name.trim();
    const owner = i.owner.trim().toLowerCase();
    if (!name || name.length > 80) throw new UserError("Give the agency a name (at most 80 characters).");
    if (!/^[a-z0-9._-]{2,64}$/.test(owner)) throw new UserError("The owner must be a NEAR account.");
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const now = this.iso();
    this.d.db
      .query("INSERT INTO market_agencies (id, name, organization, owner, signer, stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'needs_setup', ?, ?)")
      .run(id, name, `agency-${id}`, owner, i.signer, now, now);
    return this.row(id);
  }

  row(id: string): AgencyRow {
    const r = this.d.db.query("SELECT * FROM market_agencies WHERE id = ?").get(id) as AgencyRow | null;
    if (!r) throw new UserError("No such agency.", 404);
    return r;
  }

  list(): AgencyRow[] {
    return this.d.db.query("SELECT * FROM market_agencies ORDER BY created_at DESC").all() as AgencyRow[];
  }

  private set(id: string, fields: Partial<Omit<AgencyRow, "id">>) {
    update(this.d.db, "market_agencies", "id", id, fields as Record<string, string | number | null>, this.iso());
  }

  agent(a: AgencyRow): MarketAgent {
    if (!a.agent) throw new UserError("The agency's market agent is not set up yet.", 409);
    return this.d.market.agent(a.organization, a.agent);
  }

  ready(id: string): AgencyRow {
    const a = this.row(id);
    if (a.stage !== "ready") throw new UserError("Finish setting up the agency's market agent first.", 409);
    return a;
  }

  // ---------------------------------------------------------------- DAO votes

  vote(id: string): DaoVoteRow {
    const v = this.d.db.query("SELECT * FROM market_dao_votes WHERE id = ?").get(id) as DaoVoteRow | null;
    if (!v) throw new UserError("No such vote.", 404);
    return v;
  }

  private latestVote(agencyId: string, kind: DaoVoteRow["kind"], ref: string | null = null): DaoVoteRow | null {
    return this.d.db
      .query("SELECT * FROM market_dao_votes WHERE agency_id = ? AND kind = ? AND (? IS NULL OR ref = ?) ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(agencyId, kind, ref, ref) as DaoVoteRow | null;
  }

  /** Records a request the platform filed for the DAO's vote, before anything is shown. */
  recordVote(agencyId: string, kind: DaoVoteRow["kind"], ref: string | null, r: Pick<DaoRequest, "id" | "hash" | "description" | "votingUntil" | "proposal" | "proposalAndVote"> & { validUntil?: string }): DaoVoteRow {
    const now = this.iso();
    this.d.db
      .query(
        `INSERT INTO market_dao_votes (id, agency_id, kind, ref, hash, description, voting_until, valid_until, proposal, proposal_and_vote, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(r.id, agencyId, kind, ref, r.hash, r.description, r.votingUntil, r.validUntil ?? null, r.proposal ? JSON.stringify(r.proposal) : null, r.proposalAndVote ? JSON.stringify(r.proposalAndVote) : null, now, now);
    return this.vote(r.id);
  }

  setVote(id: string, state: DaoVoteRow["state"]) {
    update(this.d.db, "market_dao_votes", "id", id, { state }, this.iso());
  }

  voteView(v: DaoVoteRow): DaoVoteView {
    return {
      id: v.id,
      kind: v.kind,
      hash: v.hash,
      description: v.description,
      voting_until: new Date(v.voting_until).toISOString(),
      valid_until: v.valid_until,
      check_url: `https://${this.d.market.host}/confirm/dao/${v.hash}`,
      proposal: v.proposal ? JSON.parse(v.proposal) : null,
      proposal_and_vote: v.proposal_and_vote ? JSON.parse(v.proposal_and_vote) : null,
      state: v.state,
    };
  }

  // ---------------------------------------------------------------- next step

  async next(id: string): Promise<AgencyNext> {
    const a = this.row(id);
    switch (a.stage) {
      case "needs_setup":
        return a.signer === "wallet" ? this.signRequest(a, "setup", this.d.market.setupMessage({ organization: a.organization, owner: a.owner, expiresAt: new Date(this.d.now().getTime() + SETUP_TTL_MS).toISOString() }), "Set up the agency's market agent") : this.daoSetup(a);
      case "needs_create": {
        const who = await this.d.market.identity(a.agent!);
        if (who.ok && who.value.created && who.value.agentId) {
          this.set(a.id, { agent_id: who.value.agentId, stage: "needs_consent" });
          return this.next(id);
        }
        const action: MarketOwnerAction =
          a.signer === "wallet" ? { type: "agent_create", role: "market", owner: { type: "near", account_id: a.owner, public_key: a.owner_public_key! } } : { type: "agent_create", role: "market" };
        return this.ownerStep(a, action, "Create the agency's market agent");
      }
      case "needs_consent":
        return a.signer === "wallet" ? this.walletConsent(a) : this.daoConsent(a);
      case "needs_grant":
        return this.ownerStep(a, { type: "grant_issue", label: "market" }, "Issue the market agent's grant");
      case "needs_registration": {
        const acct = await this.agent(a).account();
        if (!acct.ok) return wait("Waiting for the platform to read the payment key");
        if (acct.value.registered) {
          this.set(a.id, { stage: "ready" });
          return { kind: "done" };
        }
        return {
          kind: "register",
          label: "Register the agent's payment key on USDC (once)",
          account: acct.value.account,
          transaction: acct.value.registration ?? registrationTransaction(acct.value.account),
        };
      }
      case "ready":
        return { kind: "done" };
    }
  }

  private signRequest(a: AgencyRow, step: PendingSign["step"], message: string, label: string): AgencyNext {
    // A second request for the same step (another tab, a reload) answers the text already issued, so the wallet's
    // signature over it is still the one accepted.
    const issued = a.pending_sign ? (JSON.parse(a.pending_sign) as PendingSign) : null;
    const fresh = issued?.step === step && issued.issued_at && this.d.now().getTime() - Date.parse(issued.issued_at) < SIGN_REUSE_MS;
    const pending: PendingSign = fresh ? issued! : { step, message, nonce: nonceToString(randomNonce()), recipient: this.d.market.host, issued_at: this.iso() };
    if (!fresh) this.set(a.id, { pending_sign: JSON.stringify(pending) });
    message = pending.message;
    return { kind: "sign", step, label, sign: { account_id: a.owner, message, recipient: pending.recipient, nonce: pending.nonce } };
  }

  private walletConsent(a: AgencyRow): AgencyNext {
    const expiresAt = new Date(this.d.now().getTime() + CONSENT_MS).toISOString();
    const message = this.d.market.consentMessage({ organization: a.organization, owner: a.owner, agent: a.agent!, agentId: a.agent_id!, scopes: [...WALLET_SCOPES], expiresAt });
    return this.signRequest(a, "consent", message, `Let Covenant quote and hire on the market for this agency until ${expiresAt.slice(0, 10)}`);
  }

  /** The wallet's NEP-413 signature over the setup or consent text Covenant issued last. */
  async signed(id: string, body: { step: PendingSign["step"]; nonce: string; publicKey: string; signature: string }): Promise<AgencyNext> {
    const a = this.row(id);
    const pending = a.pending_sign ? (JSON.parse(a.pending_sign) as PendingSign) : null;
    if (a.signer !== "wallet" || !pending || pending.step !== body.step || pending.nonce !== body.nonce) throw new UserError("This signature doesn't answer the current step. Ask for the next step again.", 409);
    const s = { message: pending.message, nonce: pending.nonce, publicKey: body.publicKey, signature: body.signature };
    if (body.step === "setup") {
      // Resending the same unexpired body answers the same agent; a lost reply is found through reservations.
      let res = await this.d.market.setup(s);
      if (!res.ok && (res.kind === "unavailable" || res.kind === "unknown")) res = await this.d.market.setup(s);
      let agent = res.ok ? res.value.agent : null;
      // Only a lost reply, or a refusal that means the agent may exist already, is looked up in the reservations: a
      // refused signature never binds the key it named.
      const lost = !res.ok && (res.kind === "unavailable" || res.kind === "unknown" || (res.kind === "refused" && RECOVERABLE_SETUP_CODES.has(res.code)));
      if (!res.ok && !lost) throw failError(res, "the setup");
      if (!res.ok) {
        const listed = await this.d.market.reservations(a.organization, a.owner);
        const live = listed.ok ? listed.value.filter((x) => !x.released && x.owner === a.owner) : [];
        if (live.length !== 1) throw failError(res, "the setup");
        agent = live[0]!.agent;
      }
      this.set(a.id, { agent, owner_public_key: body.publicKey, stage: "needs_create", pending_sign: null });
    } else {
      const res = await this.d.market.submitConsent(s);
      if (!res.ok) throw failError(res, "the consent");
      this.set(a.id, { consent_id: res.value.id, consent_expires_at: res.value.expiresAt, stage: "needs_grant", pending_sign: null });
    }
    return this.next(id);
  }

  private async daoSetup(a: AgencyRow): Promise<AgencyNext> {
    const label = "The DAO votes to set up its market agent";
    let v = this.latestVote(a.id, "setup");
    if (v && v.state === "pending") {
      const st = await this.d.market.daoSetup.state(v.id);
      if (!st.ok && !ended(st)) return wait("Waiting for the platform to read the DAO's vote");
      if (st.ok && st.value.state === "done") {
        this.setVote(v.id, "done");
        this.set(a.id, { agent: st.value.agent, stage: "needs_create" });
        return this.next(a.id);
      }
      if (st.ok && st.value.state === "pending") return { kind: "dao_vote", label, vote: this.voteView(v) };
      this.setVote(v.id, "expired");
    }
    const message = this.d.market.setupMessage({ organization: a.organization, owner: a.owner, expiresAt: new Date(this.d.now().getTime() + DAO_SETUP_TTL_MS).toISOString() });
    const filed = await this.d.market.daoSetup.file(message);
    if (!filed.ok) throw failError(filed, "the DAO's setup request");
    v = this.recordVote(a.id, "setup", null, filed.value);
    return { kind: "dao_vote", label, vote: this.voteView(v) };
  }

  private async daoConsent(a: AgencyRow): Promise<AgencyNext> {
    const label = "The DAO votes to let Covenant quote and hire for it (read, market)";
    let v = this.latestVote(a.id, "consent");
    if (v && v.state === "pending") {
      const st = await this.d.market.daoConsent.state(v.id);
      if (!st.ok && !ended(st)) return wait("Waiting for the platform to read the DAO's vote");
      if (st.ok && st.value.state === "done") {
        this.setVote(v.id, "done");
        this.set(a.id, { consent_id: st.value.consentId, consent_expires_at: st.value.expiresAt, stage: "needs_grant" });
        return this.next(a.id);
      }
      if (st.ok && st.value.state === "pending") return { kind: "dao_vote", label, vote: this.voteView(v) };
      this.setVote(v.id, "expired");
    }
    const expiresAt = new Date(this.d.now().getTime() + CONSENT_MS).toISOString();
    const filed = await this.d.market.daoConsent.file(this.d.market.consentMessage({ organization: a.organization, owner: a.owner, agent: a.agent!, agentId: a.agent_id!, scopes: [...DAO_SCOPES], expiresAt }));
    if (!filed.ok) throw failError(filed, "the DAO's consent request");
    v = this.recordVote(a.id, "consent", null, filed.value);
    return { kind: "dao_vote", label, vote: this.voteView(v) };
  }

  // ---------------------------------------------------------------- owner steps (wallet signature or DAO vote)

  step(correlationId: string): MarketStepRow {
    const s = this.d.db.query("SELECT * FROM market_steps WHERE correlation_id = ?").get(correlationId) as MarketStepRow | null;
    if (!s) throw new UserError("No such owner step.", 404);
    return s;
  }

  private setStep(correlationId: string, fields: Partial<Omit<MarketStepRow, "correlation_id">>) {
    update(this.d.db, "market_steps", "correlation_id", correlationId, fields as Record<string, string | null>, this.iso());
  }

  private latestStep(agencyId: string, kind: MarketStepRow["kind"]): MarketStepRow | null {
    return this.d.db.query("SELECT * FROM market_steps WHERE agency_id = ? AND kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(agencyId, kind) as MarketStepRow | null;
  }

  /**
   * One owner action, prepared once and followed to its end. `repeatable` actions (freeze, unfreeze) may run again
   * later, so an earlier success is history, not this request's answer.
   */
  private async ownerStep(a: AgencyRow, action: MarketOwnerAction, label: string, repeatable = false): Promise<AgencyNext> {
    const kind = action.type;
    let s = this.latestStep(a.id, kind);
    if (repeatable && s?.state === "success") s = null;
    if (s && s.state === "prepared" && Date.parse(s.expires_at) <= this.d.now().getTime()) {
      this.setStep(s.correlation_id, { state: "expired" });
      s = this.step(s.correlation_id);
    }
    const waitsOnOthers = s && (s.state === "submitted" || s.state === "unknown" || (s.state === "prepared" && (a.signer === "dao" || !!s.confirm_url)));
    if (s && waitsOnOthers) s = await this.pollStep(s.correlation_id);
    if (s?.state === "success") {
      // The step succeeded but the platform may not show its effect yet (say, the agent not yet created): wait for the
      // next call rather than asking again at once, which would recurse without end.
      if (!repeatable && this.row(a.id).stage === a.stage) return wait("Waiting for the platform to show the change");
      return this.next(a.id);
    }
    if (s && (s.state === "submitted" || s.state === "unknown")) return wait("Waiting for the platform to apply the signed step");
    if (s && s.state === "prepared") return this.stepView(a, s, label);
    const prepared = await this.agent(a).ownerPrepare(action, a.signer);
    if (!prepared.ok) {
      // A lost prepare reply leaves an open action on the agent, and preparing again is refused (without a code)
      // until it ends: `owner/pending` is the way back to it.
      const open = await this.recoverOpen(a, kind);
      if (open) return this.stepView(a, open, label);
      if (prepared.kind === "forbidden" && prepared.code === "scope" && a.signer === "dao")
        return {
          kind: "blocked",
          label,
          detail:
            kind === "grant_issue"
              ? "The platform reaches a DAO's owner actions only under a `treasury` consent, and the DAO's consent here carries `read` and `market` (decided 2026-11-09). So the DAO can't issue its market agent's grant through Covenant, and the agent can't hire. Reported to the platform (docs/platform-gaps.md, M2; MultiAgency/platform#67)."
              : `The platform doesn't yet let a DAO's \`market\` consent ask for a ${kind === "agent_freeze" ? "freeze" : "unfreeze"} (MultiAgency/platform#67). Until it does, the DAO's own stop page cuts Covenant off without a time limit: ${this.daoStopUrl(a)}. It doesn't stop the agent at the provider.`,
        };
      if (prepared.kind === "unknown" || prepared.kind === "unavailable") return wait("The platform did not answer; preparing the step again shortly");
      throw failError(prepared, kind);
    }
    return this.stepView(a, this.storeStep(a, kind, prepared.value), label);
  }

  private storeStep(a: AgencyRow, kind: MarketStepRow["kind"], p: OwnerPrepared): MarketStepRow {
    // Checked before anything is stored: a prepared DAO step without its vote would be shown as nothing to vote on.
    if (p.dao && !p.dao.hash) throw new UserError("The platform's DAO proposal named no hash to vote on.", 502);
    const now = this.iso();
    this.d.db
      .query(
        `INSERT INTO market_steps (correlation_id, agency_id, kind, intent, confirm_url, expires_at, summary, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
      )
      .run(p.correlationId, a.id, kind, p.intent ? JSON.stringify(p.intent) : null, p.confirm?.url ?? null, p.confirm?.expiresAt ?? p.expiresAt, p.summary, now, now);
    if (p.dao) {
      this.recordVote(a.id, kind, p.correlationId, { id: `step:${p.correlationId}`, hash: p.dao.hash, description: p.summary, votingUntil: Date.parse(p.expiresAt), proposal: p.dao.proposal, proposalAndVote: p.dao.proposalAndVote });
    }
    return this.step(p.correlationId);
  }

  private async recoverOpen(a: AgencyRow, kind: MarketStepRow["kind"]): Promise<MarketStepRow | null> {
    const pending = await this.agent(a).ownerPending();
    if (!pending.ok) return null;
    const open = pending.value.find((p) => p.type === kind);
    if (!open || (a.signer === "dao" && !open.hash)) return null;
    const known = this.d.db.query("SELECT * FROM market_steps WHERE correlation_id = ?").get(open.correlationId) as MarketStepRow | null;
    if (known) return known;
    return this.storeStep(a, kind, {
      correlationId: open.correlationId,
      expiresAt: open.expiresAt,
      summary: STEP_SUMMARY[kind],
      ...(open.intent && a.signer === "wallet" ? { intent: open.intent } : {}),
      ...(a.signer === "dao" ? { dao: { hash: open.hash ?? "", proposal: null, proposalAndVote: null } } : {}),
    });
  }

  private stepView(a: AgencyRow, s: MarketStepRow, label: string): AgencyNext {
    if (a.signer === "dao") {
      const v = this.latestVote(a.id, s.kind, s.correlation_id);
      if (!v) throw new UserError("The DAO's vote for this step is missing.", 500);
      return { kind: "dao_vote", label: `${label}: the DAO votes before ${s.expires_at.slice(11, 16)} UTC`, vote: this.voteView(v) };
    }
    const intent = s.intent ? (JSON.parse(s.intent) as NonNullable<OwnerPrepared["intent"]>) : null;
    return {
      kind: "owner_step",
      correlation_id: s.correlation_id,
      label,
      summary: s.summary,
      ...(intent ? { sign: { account_id: a.owner, ...intent.payload } } : {}),
      ...(s.confirm_url ? { confirm: { url: s.confirm_url, expires_at: s.expires_at } } : {}),
    };
  }

  /** The wallet's signature over a prepared owner step. A lost reply leaves it `unknown`, followed by status. */
  async submitStep(correlationId: string, sig: { publicKey: string; signature: string }): Promise<AgencyNext> {
    const s = this.step(correlationId);
    if (s.state !== "prepared" || !s.intent) throw new UserError(`This step is ${s.state === "prepared" ? "confirmed elsewhere" : `already ${s.state}`}.`, 409);
    const a = this.row(s.agency_id);
    const res = await this.agent(a).ownerSubmit(correlationId, JSON.parse(s.intent), sig);
    if (!res.ok) {
      if (res.kind === "unavailable" || res.kind === "unknown" || res.kind === "provider") this.setStep(correlationId, { state: "unknown" });
      else {
        this.setStep(correlationId, { state: "failed", failure_code: failCode(res) });
        throw failError(res, s.kind);
      }
    } else this.setStep(correlationId, { state: "submitted" });
    await this.pollStep(correlationId);
    return this.next(a.id);
  }

  private async pollStep(correlationId: string): Promise<MarketStepRow> {
    const s = this.step(correlationId);
    const a = this.row(s.agency_id);
    const res = await this.agent(a).ownerStatus(correlationId);
    if (!res.ok) return s;
    const { stage, status, failureCode } = res.value;
    if (status === "SUCCESS") {
      this.setStep(correlationId, { state: "success" });
      this.voteDone(a.id, s.kind, correlationId);
      await this.applySuccess(a, s.kind);
    } else if (status === "FAILED" || status === "REFUNDED" || stage === "failed") this.setStep(correlationId, { state: "failed", failure_code: failureCode });
    else if (stage === "expired") this.setStep(correlationId, { state: "expired", failure_code: failureCode });
    return this.step(correlationId);
  }

  private voteDone(agencyId: string, kind: MarketStepRow["kind"], correlationId: string) {
    const v = this.latestVote(agencyId, kind, correlationId);
    if (v) this.setVote(v.id, "done");
  }

  private async applySuccess(a: AgencyRow, kind: MarketStepRow["kind"]) {
    if (kind === "agent_create" && a.stage === "needs_create") {
      const who = await this.d.market.identity(a.agent!);
      if (who.ok && who.value.agentId) this.set(a.id, { agent_id: who.value.agentId, stage: "needs_consent" });
    } else if (kind === "grant_issue" && a.stage === "needs_grant") this.set(a.id, { stage: "needs_registration" as AgencyStage });
  }

  // ---------------------------------------------------------------- freeze

  /**
   * Freezes or unfreezes the agency's market agent: the owner's wallet signs it on the platform's confirm page, or the
   * DAO votes on it. A freeze stops every provider send of the agent; it doesn't reach funds already on the payment key,
   * so Covenant also approves no hire while the agent is frozen (Hires.approve).
   */
  async stop(id: string, kind: "agent_freeze" | "agent_unfreeze"): Promise<AgencyNext> {
    // Only the created agent is needed, not a finished setup: an owner may stop an agent whose grant never came.
    const a = this.row(id);
    if (!a.agent_id) throw new UserError("The agency's market agent isn't created yet: there is nothing to freeze.", 409);
    const frozen = await this.agent(a).frozen();
    if (frozen.ok && frozen.value === (kind === "agent_freeze")) return { kind: "done" };
    return this.ownerStep(a, { type: kind }, kind === "agent_freeze" ? "Freeze the market agent" : "Unfreeze the market agent", true);
  }

  /** The DAO's own stop page: ends every app's consent for the agent, with no time limit. It doesn't freeze the agent. */
  daoStopUrl(a: AgencyRow): string {
    return `https://${this.d.market.host}/confirm/dao/stop/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.agent ?? "")}`;
  }

  // ---------------------------------------------------------------- funding and earnings

  /** A one-time address crediting the agency's market agent: funding for hires, and where market earnings return. */
  async deposit(id: string): Promise<DepositView> {
    const a = this.ready(id);
    const res = await this.agent(a).deposit();
    if (!res.ok) throw failError(res, "the deposit request");
    this.set(a.id, { deposit: JSON.stringify({ address: res.value.address, expiresAt: res.value.expiresAt, at: this.iso() }) });
    return (await this.depositView(this.row(id)))!;
  }

  depositAddress(a: AgencyRow): { address: string; expiresAt: string | null } | null {
    return a.deposit ? (JSON.parse(a.deposit) as { address: string; expiresAt: string | null }) : null;
  }

  /** The stored deposit address, with whether it is registered on USDC (the market won't withdraw to it otherwise). */
  async depositView(a: AgencyRow): Promise<DepositView | null> {
    const d = this.depositAddress(a);
    if (!d) return null;
    return { address: d.address, expires_at: d.expiresAt, registered: await this.d.chain.isRegistered(USDC_NEAR, d.address), registration: registrationTransaction(d.address) };
  }
}

export type { Fail };
