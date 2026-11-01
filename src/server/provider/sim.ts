import type { Policy } from "@near-intents-agent-api/sdk";
import { hashCanonical, sha256Hex } from "../../shared/canonical";
import type { Layer } from "../../shared/clauses";
import { fromAtomic, toAtomic } from "../../shared/money";
import { USDC_DECIMALS } from "../../shared/terms";
import { nonceFromString, nonceToString, randomNonce, verifyNep413 } from "../nep413";
import {
  type AgentInfo,
  type DryResult,
  type DryWarning,
  type ExecStatus,
  type ExecutionView,
  type GrantInfo,
  type IntentOutcome,
  type KeyRegistry,
  type OwnerIntent,
  type PolicyView,
  type PreparedIntent,
  type Provider,
  ProviderRefusal,
  type WithdrawAccepted,
  type WithdrawRequest,
} from "./port";

/**
 * In-memory stand-in for the NEAR Intents Agent API, for the keyless demo and tests.
 *
 * It enforces only the policy features Covenant uses, with shapes and codes taken from
 * SDK 0.7.3 (Policy, ErrorDocument layers, dry-run warning codes). Two codes are the
 * simulator's own guesses until spikes SP3/SP4 record the real ones: `grant_expired`
 * (layer grant) and `agent_frozen` (layer policy). Tx hashes start with SIMULATED-.
 */

const SIM_RECIPIENT = "covenant-sim";

interface SimAgent {
  id: string;
  name: string;
  owner: { account_id: string; public_key: string };
  policy: Policy;
  revision: number;
  available: bigint;
  reserved: bigint;
  grants: Map<string, SimGrant>;
}

interface SimGrant {
  grant_id: string;
  credential: string;
  label: string;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

interface SimExecution {
  agent_id: string;
  correlation_id: string;
  status: ExecStatus;
  amount: bigint;
  recipient: string;
  chain: string;
  created_at: Date;
  dispatch_at: Date | null;
  tx_hash: string | null;
  failure_reason: string | null;
}

interface PendingIntent {
  prepared: PreparedIntent;
  intent: OwnerIntent;
}

export class SimProvider implements Provider {
  readonly mode = "sim" as const;
  private offsetMs = 0;
  private agents = new Map<string, SimAgent>();
  private intents = new Map<string, PendingIntent>();
  private executions = new Map<string, SimExecution>();
  private idempotency = new Map<string, { bodyHash: string; correlationId: string }>();
  private seq = 0;

  constructor(
    private keys: KeyRegistry,
    private clockStart: number = Date.now(),
    private bootedAt: number = Date.now(),
  ) {}

  // ---------- clock (simulator only) ----------

  now(): Date {
    return new Date(this.clockStart + (Date.now() - this.bootedAt) + this.offsetMs);
  }

  advance(ms: number): Date {
    this.offsetMs += ms;
    return this.now();
  }

  setNow(at: Date): Date {
    const current = this.now().getTime();
    if (at.getTime() > current) this.offsetMs += at.getTime() - current;
    return this.now();
  }

  /** Simulated deposit to an agent's (public) balance. */
  fund(agentId: string, atomic: bigint): AgentInfo {
    const a = this.agent(agentId);
    a.available += atomic;
    return this.info(a);
  }

  // ---------- owner intents ----------

  async prepareIntent(intent: OwnerIntent): Promise<PreparedIntent> {
    const signer = intent.type === "agent_create" ? intent.owner.account_id : this.agent(intent.agent_id).owner.account_id;
    const correlation_id = this.id("intent");
    const credential = intent.type === "grant_issue" ? `grant_${sha256Hex(randomNonce()).slice(0, 40)}` : undefined;
    const body = credential ? { ...intent, credential_commitment: sha256Hex(credential) } : intent;
    const prepared: PreparedIntent = {
      correlation_id,
      type: intent.type,
      // The real API uses nep366 (delegate action) for agent_create/agent_freeze. The simulator
      // asks for nep413 for everything; the live adapter reports the real standard.
      standard: "nep413",
      signer,
      message: `Covenant owner intent ${intent.type} sha256:${hashCanonical(body)}`,
      nonce: nonceToString(randomNonce()),
      recipient: SIM_RECIPIENT,
      credential,
    };
    this.intents.set(correlation_id, { prepared, intent });
    return prepared;
  }

  async submitIntent(correlationId: string, signed: { public_key: string; signature: string }): Promise<IntentOutcome> {
    const pending = this.intents.get(correlationId);
    if (!pending) throw this.refuse(404, "request", "intent_not_found", "No such intent");
    const { prepared, intent } = pending;
    const ok = verifyNep413(
      { message: prepared.message, nonce: nonceFromString(prepared.nonce), recipient: prepared.recipient },
      signed,
    );
    if (!ok) throw this.refuse(401, "auth", "owner_signature_invalid", "The owner signature does not verify");
    if (!(await this.keys.isFullAccessKey(prepared.signer, signed.public_key)))
      throw this.refuse(401, "auth", "owner_key_not_full_access", "That key is not a full-access key of the owner account");
    this.intents.delete(correlationId);
    const now = this.now();

    switch (intent.type) {
      case "agent_create": {
        const id = this.id("agent");
        this.agents.set(id, {
          id,
          name: intent.name,
          owner: { account_id: intent.owner.account_id, public_key: signed.public_key },
          policy: structuredClone(intent.policy),
          revision: 1,
          available: 0n,
          reserved: 0n,
          grants: new Map(),
        });
        return { type: "agent_create", agent_id: id };
      }
      case "grant_issue": {
        const a = this.agent(intent.agent_id);
        this.requireOwnerKey(a, signed.public_key);
        const expires = new Date(intent.expires_at);
        if (expires.getTime() <= now.getTime())
          throw this.refuse(400, "request", "grant_expiry_in_past", "Grant expiry must be in the future");
        const grant: SimGrant = {
          grant_id: this.id("grant"),
          credential: prepared.credential!,
          label: intent.label,
          issued_at: now,
          expires_at: expires,
          revoked_at: null,
        };
        a.grants.set(grant.grant_id, grant);
        return { type: "grant_issue", grant_id: grant.grant_id, expires_at: expires.toISOString() };
      }
      case "execution_cancel": {
        const a = this.agent(intent.agent_id);
        this.requireOwnerKey(a, signed.public_key);
        this.settle();
        const ex = this.executions.get(intent.correlation_id);
        if (!ex || ex.agent_id !== a.id) throw this.refuse(404, "request", "execution_not_found", "No such execution");
        if (ex.status !== "QUEUED")
          throw this.refuse(409, "request", "execution_not_cancellable", `Execution is ${ex.status}, not in its timelock`);
        ex.status = "FAILED";
        ex.failure_reason = "cancelled_by_owner";
        a.reserved -= ex.amount;
        a.available += ex.amount;
        return { type: "execution_cancel", correlation_id: ex.correlation_id };
      }
      case "agent_freeze": {
        const a = this.agent(intent.agent_id);
        this.requireOwnerKey(a, signed.public_key);
        a.policy.frozen = true;
        a.revision += 1;
        return { type: "agent_freeze", agent_id: a.id };
      }
    }
  }

  // ---------- reads ----------

  async getAgent(agentId: string): Promise<AgentInfo> {
    this.settle();
    return this.info(this.agent(agentId));
  }

  async getPolicy(agentId: string): Promise<PolicyView> {
    const a = this.agent(agentId);
    return {
      agent_id: a.id,
      status: "APPLIED",
      provider_policy_synced: true,
      policy: structuredClone(a.policy),
      policy_hash: hashCanonical(a.policy),
      revision: a.revision,
    };
  }

  async getGrant(agentId: string, grantId: string): Promise<GrantInfo> {
    const g = this.agent(agentId).grants.get(grantId);
    if (!g) throw this.refuse(404, "request", "grant_not_found", "No such grant");
    return {
      grant_id: g.grant_id,
      label: g.label,
      issued_at: g.issued_at.toISOString(),
      expires_at: g.expires_at.toISOString(),
      revoked_at: g.revoked_at?.toISOString() ?? null,
    };
  }

  async getExecution(agentId: string, correlationId: string): Promise<ExecutionView> {
    this.settle();
    const ex = this.executions.get(correlationId);
    if (!ex || ex.agent_id !== agentId) throw this.refuse(404, "request", "execution_not_found", "No such execution");
    return view(ex);
  }

  async listScheduled(agentId: string): Promise<ExecutionView[]> {
    this.settle();
    return [...this.executions.values()].filter((e) => e.agent_id === agentId && e.status === "QUEUED").map(view);
  }

  // ---------- withdraw ----------

  async withdraw(credential: string, agentId: string, req: WithdrawRequest, opts: { idempotencyKey: string }): Promise<WithdrawAccepted> {
    this.settle();
    const bodyHash = hashCanonical({ agentId, req });
    const prior = this.idempotency.get(opts.idempotencyKey);
    if (prior) {
      if (prior.bodyHash !== bodyHash)
        throw this.refuse(409, "request", "idempotency_conflict", "This idempotency key was used with a different request");
      const ex = this.executions.get(prior.correlationId)!;
      return { correlation_id: ex.correlation_id, status: ex.status, dispatch_at: iso(ex.dispatch_at), idempotency_key: opts.idempotencyKey, replayed: true };
    }

    const a = this.agent(agentId);
    this.checkGrant(a, credential);
    const amount = this.parseAmount(req);
    const problems = this.evaluate(a, req, amount);
    const first = problems[0];
    if (first) throw this.refuse(403, first.layer, first.code, first.detail);

    const now = this.now();
    const delay = a.policy.timelock_ms;
    const ex: SimExecution = {
      agent_id: a.id,
      correlation_id: this.id("exec"),
      status: delay > 0 ? "QUEUED" : "SUCCESS",
      amount,
      recipient: req.recipient.toLowerCase(),
      chain: req.chain,
      created_at: now,
      dispatch_at: delay > 0 ? new Date(now.getTime() + delay) : now,
      tx_hash: delay > 0 ? null : simTx(),
      failure_reason: null,
    };
    a.available -= amount;
    if (delay > 0) a.reserved += amount;
    this.executions.set(ex.correlation_id, ex);
    this.idempotency.set(opts.idempotencyKey, { bodyHash, correlationId: ex.correlation_id });
    return { correlation_id: ex.correlation_id, status: ex.status, dispatch_at: iso(ex.dispatch_at), idempotency_key: opts.idempotencyKey, replayed: false };
  }

  /** Dry run: same checks, but policy/budget/balance problems come back as warnings and nothing moves. */
  async withdrawDry(credential: string, agentId: string, req: WithdrawRequest, _opts: { idempotencyKey: string }): Promise<DryResult> {
    this.settle();
    const a = this.agent(agentId);
    this.checkGrant(a, credential); // auth/grant problems are errors even in a dry run
    const amount = this.parseAmount(req);
    return { dry: true, amount_usd: fromAtomic(amount, USDC_DECIMALS), warnings: this.evaluate(a, req, amount) };
  }

  // ---------- internals ----------

  /** Every policy rule the request breaks, in the order the provider evaluates them. */
  private evaluate(a: SimAgent, req: WithdrawRequest, amount: bigint): DryWarning[] {
    const p = a.policy;
    const out: DryWarning[] = [];
    const w = (layer: Layer, code: string, detail: string) => out.push({ layer, code, detail });

    if (p.frozen) w("policy", "agent_frozen", "The owner froze this agent");
    if (!p.actions.includes("withdraw")) w("policy", "policy_action_denied", "Withdraw is not an allowed action");
    if (p.assets !== "any" && !p.assets.map((x) => x.toLowerCase()).includes(req.asset.toLowerCase()))
      w("policy", "policy_asset_denied", `Asset ${req.asset} is not allowed`);

    const dest = p.destinations;
    const listed = dest.list.some(
      (d) => d.action === "withdraw" && d.chain === req.chain && d.address.toLowerCase() === req.recipient.toLowerCase(),
    );
    if ((dest.mode === "only" && !listed) || (dest.mode === "except" && listed))
      w("policy", "policy_destination_denied", `${req.recipient} on ${req.chain} is not an allowed destination`);

    const perTx = p.limits.per_transaction?.[req.asset];
    if (perTx !== undefined && amount > BigInt(perTx))
      w("policy", "policy_transaction_limit_exceeded", `Amount is above the per-transaction limit of ${fromAtomic(BigInt(perTx), USDC_DECIMALS)}`);

    const monthly = p.limits.monthly?.[req.asset];
    const spent = this.spentThisMonth(a);
    if (monthly !== undefined && spent + amount > BigInt(monthly))
      w("policy", "policy_limit_exceeded", `This would take the month to ${fromAtomic(spent + amount, USDC_DECIMALS)}, above the monthly limit of ${fromAtomic(BigInt(monthly), USDC_DECIMALS)}`);

    const budget = p.budget.monthly_usd;
    if (budget !== null && spent + amount > toAtomic(budget, USDC_DECIMALS))
      w("budget", "spend_budget_exceeded", `This would exceed the monthly USD budget of ${budget}`);

    if (p.max_actions_per_hour !== null && this.actionsLastHour(a) >= p.max_actions_per_hour)
      w("policy", "policy_action_limit_exceeded", `More than ${p.max_actions_per_hour} actions in an hour`);

    if (amount > a.available) w("balance", "insufficient_balance", "The agent's available balance is too low");
    return out;
  }

  private checkGrant(a: SimAgent, credential: string) {
    const grant = [...a.grants.values()].find((g) => g.credential === credential);
    if (!grant) throw this.refuse(401, "auth", "grant_invalid", "Unknown grant credential");
    if (grant.revoked_at) throw this.refuse(401, "grant", "grant_revoked", "This grant was revoked");
    if (this.now().getTime() >= grant.expires_at.getTime())
      throw this.refuse(401, "grant", "grant_expired", `This grant expired at ${grant.expires_at.toISOString()}`);
  }

  private parseAmount(req: WithdrawRequest): bigint {
    if (!/^\d+$/.test(req.amount) || req.amount === "0")
      throw this.refuse(400, "request", "invalid_amount", "Amount must be a positive integer in atomic units");
    return BigInt(req.amount);
  }

  /** Dispatch timelocked executions whose window has passed. */
  private settle() {
    const now = this.now().getTime();
    for (const ex of this.executions.values()) {
      if (ex.status === "QUEUED" && ex.dispatch_at && ex.dispatch_at.getTime() <= now) {
        const a = this.agents.get(ex.agent_id)!;
        a.reserved -= ex.amount;
        if (a.policy.frozen) {
          // Work held by a timelock is judged when it dispatches.
          ex.status = "FAILED";
          ex.failure_reason = "agent_frozen";
          a.available += ex.amount;
        } else {
          ex.status = "SUCCESS";
          ex.tx_hash = simTx();
        }
      }
    }
  }

  private spentThisMonth(a: SimAgent): bigint {
    const month = this.now().toISOString().slice(0, 7);
    let total = 0n;
    for (const ex of this.executions.values()) {
      if (ex.agent_id !== a.id) continue;
      if (ex.status === "FAILED" || ex.status === "REFUNDED") continue;
      if (ex.created_at.toISOString().slice(0, 7) === month) total += ex.amount;
    }
    return total;
  }

  private actionsLastHour(a: SimAgent): number {
    const since = this.now().getTime() - 3_600_000;
    return [...this.executions.values()].filter((e) => e.agent_id === a.id && e.created_at.getTime() > since).length;
  }

  private requireOwnerKey(a: SimAgent, publicKey: string) {
    if (a.owner.public_key !== publicKey) throw this.refuse(403, "auth", "not_owner", "Only the agent's owner key can sign this");
  }

  private agent(id: string): SimAgent {
    const a = this.agents.get(id);
    if (!a) throw this.refuse(404, "request", "agent_not_found", "No such agent");
    return a;
  }

  private info(a: SimAgent): AgentInfo {
    return {
      agent_id: a.id,
      name: a.name,
      owner_account: a.owner.account_id,
      frozen: a.policy.frozen,
      available: a.available.toString(),
      deposit_address: `sim-deposit-${a.id}`,
    };
  }

  private refuse(http: number, layer: Layer, code: string, title: string): ProviderRefusal {
    return new ProviderRefusal(http, [{ status: String(http), code, layer, title }], this.id("req"));
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}_sim_${this.seq.toString().padStart(4, "0")}`;
  }
}

function view(ex: SimExecution): ExecutionView {
  return {
    correlation_id: ex.correlation_id,
    status: ex.status,
    amount: ex.amount.toString(),
    recipient: ex.recipient,
    dispatch_at: iso(ex.dispatch_at),
    tx_hash: ex.tx_hash,
    failure_reason: ex.failure_reason,
  };
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function simTx(): string {
  return `SIMULATED-${sha256Hex(randomNonce()).slice(0, 44)}`;
}

/** Key registry for the simulator: only keys the demo wallet registered count as full-access. */
export class SimKeyRegistry implements KeyRegistry {
  private keys = new Map<string, Set<string>>();
  register(accountId: string, publicKey: string) {
    const set = this.keys.get(accountId) ?? new Set();
    set.add(publicKey);
    this.keys.set(accountId, set);
  }
  async isFullAccessKey(accountId: string, publicKey: string): Promise<boolean> {
    return this.keys.get(accountId)?.has(publicKey) ?? false;
  }
}
