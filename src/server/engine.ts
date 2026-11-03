import type { Database } from "bun:sqlite";
import { type Clause, clauseFor, type Layer } from "../shared/clauses";
import { canonicalJson, hashCanonical, sha256Hex } from "../shared/canonical";
import { type CompiledContract, compileContract, diffPolicy, type PolicyDiff } from "../shared/compile";
import { fromAtomic, minBig, toAtomic } from "../shared/money";
import {
  endInstant,
  parseTerms,
  startInstant,
  type Terms,
  TERMS_RECIPIENT,
  termsHash,
  termsSigningMessage,
  USDC_DECIMALS,
} from "../shared/terms";
import type { Config } from "./config";
import type { SecretBox } from "./crypto";
import type { ContractRow, EventRow, IntentRow, PayoutRow, PayoutStatus, SignatureRecord } from "./db";
import { type EvidenceSource, injectedPullRequest } from "./evidence/github";
import { nonceFromString, nonceToString, randomNonce, verifyNep413 } from "./nep413";
import {
  type IntentOutcome,
  type KeyRegistry,
  type OwnerIntent,
  type PreparedIntent,
  type Provider,
  ProviderRefusal,
  type WithdrawRequest,
} from "./provider/port";
import type { ScoreResult, Scorer } from "./scorer";

export class UserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type Role = "representative" | "contractor";
export type Stage = "needs_signatures" | "needs_wallet" | "needs_grant" | "needs_funding" | "active" | "ended" | "frozen";
export type Scenario = "overpay" | "redirect" | "after_end" | "injected";

export interface AttackReport {
  scenario: Scenario;
  ready: boolean;
  story: string;
  hint?: string;
  mode?: "dry" | "live";
  request?: WithdrawRequest;
  outcome?: "refused" | "would_refuse" | "allowed";
  findings?: { code: string; layer: Layer; detail: string; clause: Clause }[];
  raw?: unknown;
  app_checks?: "off";
  pull_request?: unknown;
  fooled_ai_output?: unknown;
}

export interface Deps {
  db: Database;
  provider: Provider;
  keys: KeyRegistry;
  evidence: EvidenceSource;
  scorer: Scorer;
  box: SecretBox;
  config: Config;
}

export class Covenant {
  constructor(private d: Deps) {}

  // ================= contracts =================

  createContract(input: unknown): { id: string; contractorToken: string } {
    let terms: Terms;
    try {
      terms = parseTerms(input);
    } catch (err) {
      throw new UserError(formatZod(err));
    }
    const hash = termsHash(terms);
    if (this.d.db.query("SELECT 1 FROM contracts WHERE hash = ?").get(hash))
      throw new UserError("A contract with exactly these terms already exists.", 409);
    const id = `c_${hash.slice(0, 12)}`;
    const contractorToken = sha256Hex(randomNonce()).slice(0, 32);
    this.d.db
      .query("INSERT INTO contracts (id, terms, hash, created_at, contractor_link_hash) VALUES (?, ?, ?, ?, ?)")
      .run(id, canonicalJson(terms), hash, this.nowIso(), sha256Hex(contractorToken));
    this.event(id, "draft", `Draft created: ${terms.company} pays ${terms.contractor.name} up to $${terms.monthly_cap_usd}/month until ${terms.end}.`);
    return { id, contractorToken };
  }

  /** Who may act on a contract: the representative (company side) and the contractor. */
  parties(id: string): { representative: string; contractor: string } {
    const t = this.terms(this.row(id));
    return { representative: t.representative.near_account, contractor: t.contractor.near_account };
  }

  payoutContract(payoutId: string): string {
    return this.payout(payoutId).contract_id;
  }

  /** All contracts, or only those where `account` is a party. */
  listContracts(account?: string) {
    const all = this.d.db.query("SELECT * FROM contracts ORDER BY created_at DESC").all() as ContractRow[];
    const rows = account
      ? all.filter((r) => {
          const t = this.terms(r);
          return t.representative.near_account === account || t.contractor.near_account === account;
        })
      : all;
    return rows.map((r) => {
      const terms = JSON.parse(r.terms) as Terms;
      const cap = toAtomic(terms.monthly_cap_usd, USDC_DECIMALS);
      const used = cap - this.remainingCap(r.id, terms, this.period(terms).month);
      return {
        id: r.id,
        company: terms.company,
        contractor: terms.contractor.name,
        payee: terms.payee.address,
        cap: terms.monthly_cap_usd,
        used: fromAtomic(used, USDC_DECIMALS),
        start: terms.start,
        end: terms.end,
        stage: this.stageOf(r),
      };
    });
  }

  async getContract(id: string) {
    const row = this.row(id);
    const terms = this.terms(row);
    const compiled = this.compile(row);
    let agent = null as null | { agent_id: string; frozen: boolean; available_usd: string; deposit_address: string };
    if (row.agent_id) {
      const a = await this.d.provider.getAgent(row.agent_id);
      agent = { agent_id: a.agent_id, frozen: a.frozen, available_usd: fromAtomic(BigInt(a.available), USDC_DECIMALS), deposit_address: a.deposit_address };
      if (a.frozen && !row.frozen) this.d.db.query("UPDATE contracts SET frozen = 1 WHERE id = ?").run(id);
    }
    await this.refresh(id);
    const period = this.period(terms);
    return {
      id: row.id,
      hash: row.hash,
      terms,
      compiled,
      created_at: row.created_at,
      now: this.nowIso(),
      provider: this.d.provider.mode,
      signatures: { representative: sig(row.rep_sig), contractor: sig(row.contractor_sig) },
      agent,
      grant: row.grant_id ? { grant_id: row.grant_id, expires_at: row.grant_expires_at } : null,
      stage: this.stageOf(this.row(id), agent?.available_usd),
      period,
      remaining_cap_usd: fromAtomic(this.remainingCap(id, terms, period.month), USDC_DECIMALS),
      payouts: this.payouts(id),
      events: this.events(id),
    };
  }

  // ================= term signatures (NEP-413) =================

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

  async addSignature(
    id: string,
    role: Role,
    signed: { account_id: string; public_key: string; signature: string; nonce: string },
    contractorToken?: string,
  ) {
    const row = this.row(id);
    const terms = this.terms(row);
    const expected = role === "representative" ? terms.representative.near_account : terms.contractor.near_account;
    if (role === "contractor" && sha256Hex(contractorToken ?? "") !== row.contractor_link_hash)
      throw new UserError("This signing link is not valid for the contractor.", 403);
    if ((role === "representative" ? row.rep_sig : row.contractor_sig) !== null) throw new UserError(`The ${role} already signed.`, 409);
    if (signed.account_id.toLowerCase() !== expected)
      throw new UserError(`The ${role} must sign as ${expected}, not ${signed.account_id}.`, 403);
    const ok = verifyNep413(
      { message: termsSigningMessage(row.hash), nonce: nonceFromString(signed.nonce), recipient: TERMS_RECIPIENT },
      signed,
    );
    if (!ok) throw new UserError("The signature does not match these terms.", 400);
    if (!(await this.d.keys.isFullAccessKey(expected, signed.public_key)))
      throw new UserError(`${signed.public_key} is not a full-access key of ${expected}.`, 403);
    const record: SignatureRecord = { ...signed, account_id: expected, signed_at: this.nowIso() };
    this.d.db.query(`UPDATE contracts SET ${role === "representative" ? "rep_sig" : "contractor_sig"} = ? WHERE id = ?`).run(JSON.stringify(record), id);
    this.event(id, "signed", `${role === "representative" ? "Representative" : "Contractor"} ${expected} signed the terms hash.`);
    return this.getContract(id);
  }

  // ================= owner intents (signed in the representative's wallet) =================

  async prepareIntent(id: string, type: OwnerIntent["type"], payoutId?: string): Promise<Omit<PreparedIntent, "credential">> {
    const row = this.row(id);
    const terms = this.terms(row);
    let intent: OwnerIntent;
    switch (type) {
      case "agent_create": {
        if (!row.rep_sig || !row.contractor_sig) throw new UserError("Both parties must sign the terms first.");
        if (row.agent_id) throw new UserError("This contract already has its wallet.", 409);
        const rep = JSON.parse(row.rep_sig) as SignatureRecord;
        const c = this.compile(row);
        intent = { type, owner: { type: "near", account_id: rep.account_id, public_key: rep.public_key }, name: c.name, policy: c.policy };
        break;
      }
      case "grant_issue": {
        if (!row.agent_id) throw new UserError("Create the contract wallet first.");
        if (row.grant_id) throw new UserError("The agent already has its grant.", 409);
        const now = this.d.provider.now().getTime();
        if (now < Date.parse(startInstant(terms))) throw new UserError(`The contract starts ${terms.start}; the grant can only be issued from then.`);
        if (now >= Date.parse(endInstant(terms))) throw new UserError("The contract has already ended.");
        const c = this.compile(row);
        intent = { type, agent_id: row.agent_id, label: c.grant.label, expires_at: c.grant.expires_at };
        break;
      }
      case "execution_cancel": {
        const p = payoutId ? this.payout(payoutId) : undefined;
        if (!p || p.contract_id !== id) throw new UserError("Unknown payout.", 404);
        if (p.status !== "queued" || !p.correlation_id) throw new UserError("Only a payout waiting in its timelock can be cancelled.");
        intent = { type, agent_id: row.agent_id!, correlation_id: p.correlation_id };
        break;
      }
      case "agent_freeze": {
        if (!row.agent_id) throw new UserError("There is no contract wallet to freeze.");
        intent = { type, agent_id: row.agent_id };
        break;
      }
    }
    const prepared = await this.call(() => this.d.provider.prepareIntent(intent));
    const { credential, ...publicPart } = prepared;
    this.d.db
      .query("INSERT INTO intents (correlation_id, contract_id, type, prepared, credential_enc, payout_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?)")
      .run(prepared.correlation_id, id, type, JSON.stringify(publicPart), credential ? await this.d.box.seal(credential) : null, payoutId ?? null, this.nowIso());
    return publicPart;
  }

  async submitIntent(correlationId: string, signed: { public_key: string; signature: string }) {
    const intent = this.d.db.query("SELECT * FROM intents WHERE correlation_id = ?").get(correlationId) as IntentRow | null;
    if (!intent) throw new UserError("Unknown intent.", 404);
    if (intent.status !== "prepared") throw new UserError(`This intent is already ${intent.status}.`, 409);
    let outcome: IntentOutcome;
    try {
      outcome = await this.d.provider.submitIntent(correlationId, signed);
    } catch (err) {
      this.d.db.query("UPDATE intents SET status = 'failed', error = ? WHERE correlation_id = ?").run(String(err), correlationId);
      throw toUserError(err);
    }
    this.d.db.query("UPDATE intents SET status = 'submitted' WHERE correlation_id = ?").run(correlationId);
    const id = intent.contract_id;
    switch (outcome.type) {
      case "agent_create":
        this.d.db.query("UPDATE contracts SET agent_id = ? WHERE id = ?").run(outcome.agent_id, id);
        this.event(id, "wallet", `Contract wallet created: agent ${outcome.agent_id}, with the compiled policy.`);
        break;
      case "grant_issue":
        this.d.db
          .query("UPDATE contracts SET grant_id = ?, grant_expires_at = ?, credential_enc = ? WHERE id = ?")
          .run(outcome.grant_id, outcome.expires_at, intent.credential_enc, id);
        this.event(id, "grant", `Grant issued to the Covenant agent. It expires ${outcome.expires_at} (the contract end).`);
        break;
      case "execution_cancel":
        if (intent.payout_id) this.setPayout(intent.payout_id, { status: "cancelled" });
        this.event(id, "cancel", "The representative cancelled a payout during its timelock.");
        break;
      case "agent_freeze":
        this.d.db.query("UPDATE contracts SET frozen = 1 WHERE id = ?").run(id);
        this.event(id, "freeze", "The representative froze the contract wallet. Nothing more can be paid.");
        break;
    }
    return this.getContract(id);
  }

  // ================= the agent's payout run =================

  async run(id: string) {
    const row = this.row(id);
    const terms = this.terms(row);
    this.requireActive(row, terms);
    const period = this.period(terms);
    const prs = await this.d.evidence.mergedPullRequests({ repos: terms.repos, author: terms.contractor.github, since: period.since, until: period.until });
    const paidKeys = this.paidPrKeys(id);
    const fresh = prs.filter((p) => !paidKeys.has(`${p.repo}#${p.number}`));
    const score = await this.d.scorer.score(terms, fresh, period);
    const amount = this.amountFor(terms, score, id, period.month);

    if (amount === 0n) {
      this.event(id, "run", `Agent run: nothing to pay. ${score.summary}`);
      return { payout: null, score, amount_usd: "0" };
    }
    const payoutId = `p_${sha256Hex(randomNonce()).slice(0, 12)}`;
    const now = this.nowIso();
    this.d.db
      .query("INSERT INTO payouts (id, contract_id, period, score, amount_atomic, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(payoutId, id, period.month, JSON.stringify(score), amount.toString(), score.decision === "escalate" ? "escalated" : "persisted", now, now);

    if (score.decision === "escalate") {
      this.event(id, "escalate", `Agent escalated instead of paying: ${score.summary}`);
      return { payout: this.payoutView(this.payout(payoutId)), score, amount_usd: fromAtomic(amount, USDC_DECIMALS) };
    }
    this.event(id, "run", `Agent decided to pay ${usdText(amount)} for ${score.prs.filter((p) => p.accepted).length} accepted pull requests.`);
    await this.send(payoutId);
    return { payout: this.payoutView(this.payout(payoutId)), score, amount_usd: fromAtomic(amount, USDC_DECIMALS) };
  }

  /** The representative resolves an escalation. This gate is Covenant's, not the provider's. */
  async resolveEscalation(payoutId: string, approve: boolean) {
    const p = this.payout(payoutId);
    if (p.status !== "escalated") throw new UserError("This payout is not waiting for a decision.");
    const row = this.row(p.contract_id);
    if (!approve) {
      this.setPayout(payoutId, { status: "rejected" });
      this.event(p.contract_id, "reject", "The representative rejected the escalated payout.");
      return this.getContract(p.contract_id);
    }
    const terms = this.terms(row);
    this.requireActive(row, terms);
    // Re-check the amount against the cap now, in case anything was paid since.
    const score = JSON.parse(p.score) as ScoreResult;
    const amount = this.amountFor(terms, score, p.contract_id, p.period, payoutId);
    if (amount === 0n) throw new UserError("Nothing left under the cap for this period.");
    this.setPayout(payoutId, { status: "persisted", amount_atomic: amount.toString() });
    this.event(p.contract_id, "approve", `The representative approved ${usdText(amount)} (flagged pull requests stay excluded).`);
    await this.send(payoutId);
    return this.getContract(p.contract_id);
  }

  /**
   * Persist-then-send. The request and idempotency key are written before the call, so a crash or a
   * timeout can be recovered by asking the provider, never by blindly sending again.
   */
  private async send(payoutId: string) {
    const p = this.payout(payoutId);
    const row = this.row(p.contract_id);
    const terms = this.terms(row);
    const req: WithdrawRequest = {
      asset: terms.asset,
      amount: p.amount_atomic,
      chain: terms.payee.chain,
      recipient: terms.payee.address,
      memo: `covenant ${row.hash.slice(0, 16)} ${p.period}`,
    };
    const idem = p.idem_key ?? `covenant-${payoutId}`;
    this.setPayout(payoutId, { idem_key: idem, request: JSON.stringify(req) });
    if (this.d.provider.mode === "live" && !this.d.config.allowWrites) {
      this.setPayout(payoutId, { status: "needs_review", error: JSON.stringify({ code: "writes_disabled", detail: "ALLOW_WRITES is not true; nothing was sent." }) });
      return;
    }
    const credential = await this.credential(row);
    try {
      const res = await this.d.provider.withdraw(credential, row.agent_id!, req, { idempotencyKey: idem });
      this.setPayout(payoutId, { status: res.status === "SUCCESS" ? "paid" : "queued", correlation_id: res.correlation_id, dispatch_at: res.dispatch_at });
      this.event(p.contract_id, "sent", res.status === "QUEUED" ? `Payout accepted by NEAR Intents; it dispatches at ${res.dispatch_at} unless cancelled.` : "Payout sent.");
      await this.refresh(p.contract_id);
    } catch (err) {
      if (err instanceof ProviderRefusal) {
        this.setPayout(payoutId, { status: "refused", error: JSON.stringify({ ...err.first, request_id: err.requestId }) });
        this.event(p.contract_id, "refused", `NEAR Intents refused the payout: ${err.first.code}.`);
      } else {
        this.setPayout(payoutId, { status: "needs_review", error: JSON.stringify({ code: "unknown_outcome", detail: String(err) }) });
        this.event(p.contract_id, "review", "The payout outcome is unknown. It will not be resent automatically.");
      }
    }
  }

  /** Pull the latest status of payouts that are in flight. */
  async refresh(id: string) {
    const row = this.row(id);
    if (!row.agent_id) return;
    const inflight = this.d.db
      .query("SELECT * FROM payouts WHERE contract_id = ? AND status = 'queued' AND correlation_id IS NOT NULL")
      .all(id) as PayoutRow[];
    for (const p of inflight) {
      const ex = await this.d.provider.getExecution(row.agent_id, p.correlation_id!);
      if (ex.status === "SUCCESS") {
        this.setPayout(p.id, { status: "paid", tx_hash: ex.tx_hash });
        this.event(id, "paid", `Paid ${usdText(BigInt(p.amount_atomic))} to ${ex.recipient}. Tx ${ex.tx_hash}.`);
      } else if (ex.status === "FAILED" || ex.status === "REFUNDED") {
        const cancelled = ex.failure_reason === "cancelled_by_owner";
        this.setPayout(p.id, { status: cancelled ? "cancelled" : "failed", error: ex.failure_reason ? JSON.stringify({ code: ex.failure_reason }) : null });
      } else if (ex.status === "UNCERTAIN" || ex.status === "NEEDS_REVIEW") {
        this.setPayout(p.id, { status: "needs_review" });
      }
    }
  }

  // ================= contractor verification =================

  async verify(id: string) {
    const row = this.row(id);
    const terms = this.terms(row);
    const hashOk = termsHash(terms) === row.hash;
    const signatures = [];
    for (const role of ["representative", "contractor"] as const) {
      const s = sig(role === "representative" ? row.rep_sig : row.contractor_sig);
      if (!s) {
        signatures.push({ role, account_id: null, ok: false, full_access: false });
        continue;
      }
      const ok = verifyNep413({ message: termsSigningMessage(row.hash), nonce: nonceFromString(s.nonce), recipient: TERMS_RECIPIENT }, s);
      signatures.push({ role, account_id: s.account_id, ok, full_access: await this.d.keys.isFullAccessKey(s.account_id, s.public_key) });
    }

    const compiled = this.compile(row);
    let policy = null as null | { status: string; synced: boolean; equal: boolean; diffs: PolicyDiff[]; policy_hash: string };
    let grant = null as null | { expires_at: string; matches_end: boolean; revoked: boolean };
    let funds = null as null | { available_usd: string; cap_usd: string; covers_cap: boolean; frozen: boolean };
    if (row.agent_id) {
      const live = await this.d.provider.getPolicy(row.agent_id);
      const expected = { ...compiled.policy, frozen: live.policy.frozen }; // freezing is a lawful owner action, shown separately
      const diffs = diffPolicy(expected, live.policy);
      policy = { status: live.status, synced: live.provider_policy_synced, equal: diffs.length === 0, diffs, policy_hash: live.policy_hash };
      const a = await this.d.provider.getAgent(row.agent_id);
      const cap = toAtomic(terms.monthly_cap_usd, USDC_DECIMALS);
      funds = { available_usd: fromAtomic(BigInt(a.available), USDC_DECIMALS), cap_usd: terms.monthly_cap_usd, covers_cap: BigInt(a.available) >= this.remainingCap(id, terms, this.period(terms).month) && cap > 0n, frozen: a.frozen };
    }
    if (row.agent_id && row.grant_id) {
      const g = await this.d.provider.getGrant(row.agent_id, row.grant_id);
      grant = { expires_at: g.expires_at, matches_end: Date.parse(g.expires_at) === Date.parse(compiled.grant.expires_at), revoked: g.revoked_at !== null };
    }

    const checks = [
      { id: "terms", label: "Terms hash matches the terms", ok: hashOk },
      ...signatures.map((s) => ({ id: `sig-${s.role}`, label: `${s.role === "representative" ? "Representative" : "Contractor"} signature verifies with a full-access key`, ok: s.ok && s.full_access })),
      { id: "applied", label: "Policy is applied and synced at the provider", ok: !!policy && policy.status === "APPLIED" && policy.synced },
      { id: "policy", label: "Live policy equals the policy compiled from these terms", ok: !!policy?.equal },
      { id: "grant", label: "The agent's permission expires exactly at the contract end", ok: !!grant && grant.matches_end && !grant.revoked },
      // Informational: funding is not a mismatch with the signed terms, so it never turns the verdict red.
      { id: "funded", label: "The wallet holds enough USDC for this month's remaining cap", ok: !!funds?.covers_cap, info: true },
    ];
    const matches = checks.filter((c) => !("info" in c));
    const overall = !row.agent_id || !row.grant_id ? "incomplete" : matches.every((c) => c.ok) ? "green" : "red";
    return { id, hash: row.hash, terms, compiled, checks, overall, signatures, policy, grant, funds, agent_id: row.agent_id, frozen: funds?.frozen ?? false };
  }

  // ================= "compromised server" attack panel =================

  async attack(id: string, scenario: Scenario, mode: "dry" | "live"): Promise<AttackReport> {
    const row = this.row(id);
    const terms = this.terms(row);
    if (!row.agent_id || !row.grant_id) throw new UserError("Create, grant and fund the contract wallet first.");
    if (mode === "live" && this.d.provider.mode === "live") throw new UserError("Live attacks against mainnet are run once by hand and recorded in docs/evidence.md.");
    const cap = toAtomic(terms.monthly_cap_usd, USDC_DECIMALS);
    const one = toAtomic("1", USDC_DECIMALS);
    const base = { asset: terms.asset, chain: terms.payee.chain, recipient: terms.payee.address };
    let req: WithdrawRequest;
    let story: string;
    let extra: Record<string, unknown> = {};
    switch (scenario) {
      case "overpay":
        req = { ...base, amount: (cap + one).toString() };
        story = `Pay ${usdText(cap + one)} on a ${usdText(cap)} contract.`;
        break;
      case "redirect":
        req = { ...base, amount: one.toString(), recipient: "attacker.near" };
        story = "Send $1.00 to attacker.near instead of the payee.";
        break;
      case "after_end": {
        const ended = this.d.provider.now().getTime() > Date.parse(endInstant(terms));
        if (!ended)
          return { scenario, ready: false, story: "Pay $1.00 after the contract ended.", hint: this.d.provider.mode === "sim" ? "Fast-forward the simulated clock past the end date, then try again." : "Use the short-lived contract once it has ended." };
        req = { ...base, amount: one.toString() };
        story = `Pay $1.00 on ${this.d.provider.now().toISOString().slice(0, 10)}, after the contract ended on ${terms.end}.`;
        break;
      }
      case "injected": {
        const pr = injectedPullRequest(terms.repos[0]!, terms.contractor.github, this.nowIso());
        const fooled = toAtomic("5000", USDC_DECIMALS);
        req = { ...base, amount: fooled.toString() };
        story = "A pull request hides instructions for the AI reviewer. Suppose the AI is fooled and asks for $5,000.";
        extra = { pull_request: pr, fooled_ai_output: { label: "FIXTURE: what a fooled model might return", accepted_prs: 500, amount_usd: "5000" } };
        break;
      }
    }

    const credential = await this.credential(row);
    const idem = `attack-${scenario}-${sha256Hex(randomNonce()).slice(0, 10)}`;
    let outcome: "refused" | "would_refuse" | "allowed";
    let findings: { code: string; layer: Layer; detail: string; clause: Clause }[] = [];
    let raw: unknown;
    try {
      if (mode === "dry") {
        const res = await this.d.provider.withdrawDry(credential, row.agent_id, req, { idempotencyKey: idem });
        raw = res;
        findings = res.warnings.map((w) => ({ ...w, clause: clauseFor(w.code, w.layer, terms) }));
        outcome = findings.length ? "would_refuse" : "allowed";
      } else {
        raw = await this.d.provider.withdraw(credential, row.agent_id, req, { idempotencyKey: idem });
        outcome = "allowed";
      }
    } catch (err) {
      if (!(err instanceof ProviderRefusal)) throw err;
      raw = { errors: err.errors, meta: { request_id: err.requestId } };
      findings = err.errors.map((e) => ({ code: e.code, layer: e.layer, detail: e.title, clause: clauseFor(e.code, e.layer, terms) }));
      outcome = "refused";
    }
    this.event(id, "attack", `Attack "${scenario}" (${mode}): ${outcome === "allowed" ? "NOT STOPPED" : `stopped by ${findings.map((f) => f.code).join(", ")}`}.`);
    return { scenario, ready: true, mode, story, request: req, outcome, findings, raw, app_checks: "off", ...extra };
  }

  // ================= helpers =================

  private amountFor(terms: Terms, score: ScoreResult, id: string, month: string, excludePayout?: string): bigint {
    const accepted = score.prs.filter((p) => p.accepted).length;
    const rate = toAtomic(terms.rate_per_accepted_pr_usd, USDC_DECIMALS);
    return minBig(rate * BigInt(accepted), this.remainingCap(id, terms, month, excludePayout));
  }

  private remainingCap(id: string, terms: Terms, month: string, excludePayout?: string): bigint {
    const cap = toAtomic(terms.monthly_cap_usd, USDC_DECIMALS);
    const rows = this.d.db
      .query("SELECT id, amount_atomic FROM payouts WHERE contract_id = ? AND period = ? AND status IN ('persisted','queued','paid','needs_review')")
      .all(id, month) as { id: string; amount_atomic: string }[];
    const used = rows.filter((r) => r.id !== excludePayout).reduce((n, r) => n + BigInt(r.amount_atomic), 0n);
    return cap > used ? cap - used : 0n;
  }

  private paidPrKeys(id: string): Set<string> {
    const rows = this.d.db
      .query("SELECT score FROM payouts WHERE contract_id = ? AND status IN ('persisted','queued','paid','needs_review','escalated')")
      .all(id) as { score: string }[];
    const keys = new Set<string>();
    for (const r of rows) for (const pr of (JSON.parse(r.score) as ScoreResult).prs) if (pr.accepted) keys.add(pr.key);
    return keys;
  }

  private period(terms: Terms) {
    const now = this.d.provider.now();
    const month = now.toISOString().slice(0, 7);
    const monthStart = `${month}-01T00:00:00.000Z`;
    const since = [monthStart, startInstant(terms)].sort().at(-1)!;
    const until = [now.toISOString(), endInstant(terms)].sort()[0]!;
    return { month, since, until };
  }

  private requireActive(row: ContractRow, terms: Terms) {
    if (!row.agent_id || !row.grant_id) throw new UserError("The contract wallet is not set up yet.");
    if (row.frozen) throw new UserError("The contract wallet is frozen.");
    if (this.d.provider.now().getTime() > Date.parse(endInstant(terms))) throw new UserError("The contract has ended.");
  }

  private stageOf(row: ContractRow, availableUsd?: string): Stage {
    const terms = this.terms(row);
    if (row.frozen) return "frozen";
    if (this.d.provider.now().getTime() > Date.parse(endInstant(terms)) && row.agent_id) return "ended";
    if (!row.rep_sig || !row.contractor_sig) return "needs_signatures";
    if (!row.agent_id) return "needs_wallet";
    if (!row.grant_id) return "needs_grant";
    if (availableUsd !== undefined && Number(availableUsd) <= 0 && this.payouts(row.id).length === 0) return "needs_funding";
    return "active";
  }

  private compile(row: ContractRow): CompiledContract {
    return compileContract(this.terms(row), row.hash, { timelockMs: this.d.config.timelockMs });
  }

  private async credential(row: ContractRow): Promise<string> {
    if (!row.credential_enc) throw new UserError("The agent has no grant yet.");
    return this.d.box.open(row.credential_enc);
  }

  private row(id: string): ContractRow {
    const row = this.d.db.query("SELECT * FROM contracts WHERE id = ?").get(id) as ContractRow | null;
    if (!row) throw new UserError("No such contract.", 404);
    return row;
  }

  private terms(row: ContractRow): Terms {
    return JSON.parse(row.terms) as Terms;
  }

  private payout(id: string): PayoutRow {
    const p = this.d.db.query("SELECT * FROM payouts WHERE id = ?").get(id) as PayoutRow | null;
    if (!p) throw new UserError("No such payout.", 404);
    return p;
  }

  private payouts(contractId: string) {
    return (this.d.db.query("SELECT * FROM payouts WHERE contract_id = ? ORDER BY created_at DESC, rowid DESC").all(contractId) as PayoutRow[]).map((p) => this.payoutView(p));
  }

  private payoutView(p: PayoutRow) {
    return {
      id: p.id,
      period: p.period,
      status: p.status,
      amount_usd: fromAtomic(BigInt(p.amount_atomic), USDC_DECIMALS),
      score: JSON.parse(p.score) as ScoreResult,
      correlation_id: p.correlation_id,
      dispatch_at: p.dispatch_at,
      tx_hash: p.tx_hash,
      error: p.error ? JSON.parse(p.error) : null,
      created_at: p.created_at,
    };
  }

  private setPayout(id: string, fields: Partial<Omit<PayoutRow, "id">> & { status?: PayoutStatus }) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    this.d.db.query(`UPDATE payouts SET ${sets}, updated_at = ? WHERE id = ?`).run(...(Object.values(fields) as (string | null)[]), this.nowIso(), id);
  }

  private events(contractId: string) {
    return this.d.db.query("SELECT * FROM events WHERE contract_id = ? ORDER BY id DESC LIMIT 100").all(contractId) as EventRow[];
  }

  private event(contractId: string, kind: string, text: string) {
    this.d.db.query("INSERT INTO events (contract_id, at, kind, text) VALUES (?, ?, ?, ?)").run(contractId, this.nowIso(), kind, text);
  }

  private nowIso(): string {
    return this.d.provider.now().toISOString();
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toUserError(err);
    }
  }
}

function sig(json: string | null): SignatureRecord | null {
  return json ? (JSON.parse(json) as SignatureRecord) : null;
}

function usdText(atomic: bigint): string {
  const [w, f = ""] = fromAtomic(atomic, USDC_DECIMALS).split(".");
  return `$${w}.${(f + "00").slice(0, 2)}`;
}

export function toUserError(err: unknown): UserError {
  if (err instanceof UserError) return err;
  if (err instanceof ProviderRefusal) return new UserError(`NEAR Intents refused: ${err.first.code} (${err.first.layer}). ${err.first.title}`, err.httpStatus);
  return new UserError(err instanceof Error ? err.message : String(err), 500);
}

function formatZod(err: unknown): string {
  const issues = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues;
  if (!issues) return String(err);
  return issues.map((i) => `${i.path.join(".") || "terms"}: ${i.message}`).join("; ");
}

export { hashCanonical };
