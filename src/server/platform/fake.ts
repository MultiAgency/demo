import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appScopesCover, consentMessage, parseConsentMessage, parseSetupMessage, setupMessage } from "@multiagency/sdk";
import { nonceFromString, verifyNep413 } from "../nep413";
import type { SimChain } from "./chain";
import {
  type AgentHandle,
  type Caps,
  type Consent,
  type DemoControls,
  type Deposit,
  type Fail,
  type Held,
  type Intent413,
  type Overview,
  type OwnerAction,
  type OwnerPrepared,
  type OwnerStatus,
  type PaymentStatus,
  type Platform,
  type PayoutAnswer,
  type PolicyChanges,
  type Res,
  type Reviewed,
  type Signed413,
  USDC,
} from "./port";

/**
 * A platform stand-in for the keyless demo and the tests. It reproduces the MultiAgency rules Paperwork depends on,
 * as read from platform 96a0bb6 and observed on its local stack: NEP-413 setup and consents checked
 * against the owner's full-access key, consent scopes and expiry on its own clock, one hosted agent per setup, owner
 * actions signed by the owner's key, the payout `authorize` rules (recorded refusals vs refusals thrown before
 * recording), requestId idempotency, held payouts released only by an `approval_vote`, and the failure modes the
 * controls inject. Nothing here moves money.
 */

type Scope = "owner" | "payout" | "read";
type PolicyStatus = "NONE" | "SIGNED" | "APPLIED" | "FAILED";
interface Policy {
  frozen: boolean;
  actions: string[];
  confidential: boolean;
  owner_approval: boolean;
  assets: string[] | "any";
  limits: Caps;
  max_actions_per_hour: number | null;
  destinations: { mode: "only"; list: ({ action: "transfer"; address: string; confidential: boolean } | { action: "withdraw"; chain: string; address: string; memo: string | null })[] };
  budget: { daily_usd: string | null; weekly_usd: string | null; monthly_usd: string | null };
  timelock_ms: number;
}
interface StoredConsent {
  id: string;
  organization: string;
  owner: string;
  agent: string;
  agentId: string;
  scopes: Scope[];
  expiresAtMs: number;
  publicKey: string;
  revoked: boolean;
  signedBody: string;
}
interface Grant {
  label: string;
  expiresAtMs: number;
  revoked: boolean;
}
interface Payment {
  correlationId: string;
  approvalId: string;
  agent: string;
  recipient: string;
  amount: bigint;
  status: "PENDING_APPROVAL" | "PROCESSING" | "SUCCESS" | "FAILED";
  failureCode: string | null;
  at: number;
  approvalExpiresAtMs: number;
  processingReads: number;
  failAfterApproval: string | null;
  txHash: string | null;
}
interface Op {
  requestId: string;
  recipient: string;
  amount: string;
  refused: string | null;
  correlationId: string | null;
}
interface OwnerIntent {
  correlationId: string;
  agent: string;
  action: OwnerAction;
  intent?: Intent413;
  confirmToken?: string;
  expiresAtMs: number;
  submitted: { status: string; failureCode: string | null } | null;
  paymentCorrelation?: string;
  grantLabel?: string;
  policy?: Policy;
}
interface Agent {
  name: string;
  organization: string;
  owner: string;
  setupKey: string;
  ownerKey: string | null;
  agentId: string | null;
  revision: number;
  status: PolicyStatus;
  synced: boolean;
  policy: Policy | null;
  grants: Grant[];
  funded: bigint;
  ops: Map<string, Op>;
}

export interface FakeOptions {
  deployment: string;
  host?: string;
  now: () => Date;
  chain: SimChain;
  /**
   * `after-read` (default): an approved payout reads `processing` once, then `succeeded`, so the demo needs no settle
   * step. `manual`: it stays `processing` until `controls.settle`.
   */
  autoSettle?: "after-read" | "manual";
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SETUP_MAX_MS = HOUR;
const CONSENT_MAX_MS = 366 * DAY;
const INTENT_TTL_MS = 15 * 60_000;
const GRANT_TTL_MS = 30 * DAY;
const APPROVAL_TTL_MS = DAY;
const FOLLOW_CREATION = new Set(["owner/status"]);
const PAYOUT_GRANTS = new Set(["payout", "invoices"]);

const fail = {
  forbidden: (code: string): Fail => ({ ok: false, kind: "forbidden", code }),
  refused: (code: string): Fail => ({ ok: false, kind: "refused", code }),
  unavailable: (): Fail => ({ ok: false, kind: "unavailable", detail: "fake platform outage (setUnavailable)" }),
  unknown: (detail: string): Fail => ({ ok: false, kind: "unknown", detail }),
};
const ok = <T>(value: T): Res<T> => ({ ok: true, value });
const hex = (n: number) => randomBytes(n).toString("hex");
const digestOf = (p: Policy) => `sha256:${createHash("sha256").update(JSON.stringify(p)).digest("hex")}`;
const clone = <T>(v: T): T => structuredClone(v);

/** The policy a hosted payout agent is created with (as the stack creates it): transfers on, no payees. */
function createdPolicy(): Policy {
  return {
    frozen: false,
    actions: ["transfer"],
    confidential: true,
    owner_approval: true,
    assets: [USDC],
    limits: { per_transaction: { [USDC]: "25000000" }, daily: { [USDC]: "50000000" }, monthly: { [USDC]: "200000000" } },
    max_actions_per_hour: 10,
    destinations: { mode: "only", list: [] },
    budget: { daily_usd: "50", weekly_usd: null, monthly_usd: "200" },
    timelock_ms: 0,
  };
}

/** `owner-requests.ts policyChange`: the current policy with the changes applied, exactly as the platform builds it. */
export function applyChanges(policy: Policy, changes: PolicyChanges): Policy {
  const { withdrawals, ...asked } = changes;
  const fields = Object.fromEntries(Object.entries(asked).filter(([, v]) => v !== undefined));
  const transfers = policy.destinations.list.filter((d) => d.action === "transfer");
  const nearWithdrawal = (d: Policy["destinations"]["list"][number]) => d.action === "withdraw" && d.chain === "near" && d.memo === null;
  const toNear = withdrawals ?? policy.destinations.list.filter(nearWithdrawal).map((d) => ({ address: d.address }));
  const others = policy.destinations.list.filter((d) => d.action !== "transfer" && !nearWithdrawal(d));
  const withdraws = withdrawals === undefined ? policy.actions.includes("withdraw") : toNear.length > 0 || others.some((d) => d.action === "withdraw");
  const swaps = policy.actions.includes("swap");
  return {
    ...policy,
    ...(fields as Partial<Policy>),
    actions: [
      ...policy.actions.filter((a) => a !== "swap" && a !== "transfer" && a !== "withdraw"),
      ...(swaps ? ["swap"] : []),
      ...(transfers.length ? ["transfer"] : []),
      ...(withdraws ? ["withdraw"] : []),
    ],
    destinations: {
      mode: "only",
      list: [...others, ...transfers, ...toNear.map(({ address }) => ({ action: "withdraw" as const, chain: "near", address, memo: null }))],
    },
  };
}

const agreedWithdrawals = (p: Policy) =>
  new Set(p.destinations.list.flatMap((d) => (d.action === "withdraw" && d.chain === "near" && d.memo === null ? [d.address] : [])));

export class FakePlatform implements Platform {
  readonly mode = "fake" as const;
  readonly host: string;
  readonly deployment: string;
  readonly controls: FakeControls;
  private readonly baseNow: () => Date;
  readonly chain: SimChain;
  private readonly autoSettle: "after-read" | "manual";
  /** @internal shared with FakeControls */
  state = {
    offsetMs: 0,
    unavailable: false,
    dropNextReply: false,
    failAfterApproval: null as string | null,
    agents: new Map<string, Agent>(),
    setups: new Map<string, { agent: string; consentId: string }>(),
    consents: new Map<string, StoredConsent>(),
    payments: new Map<string, Payment>(),
    intents: new Map<string, OwnerIntent>(),
    /** Every payout request body as the fake received it, for assertions (no memo, delivery, terms). */
    requests: [] as Record<string, unknown>[],
  };

  constructor(o: FakeOptions) {
    this.deployment = o.deployment;
    this.host = o.host ?? "fake.multiagency.local";
    this.baseNow = o.now;
    this.chain = o.chain;
    this.autoSettle = o.autoSettle ?? "after-read";
    this.controls = new FakeControls(this);
  }

  /** The fake's own clock: the configured clock plus `controls.advance`. */
  now(): number {
    return this.baseNow().getTime() + this.state.offsetMs;
  }

  setupMessage(i: { organization: string; owner: string; expiresAt: string }): string {
    return setupMessage({ host: this.host, deployment: this.deployment, organization: i.organization, owner: i.owner, area: "payables", expiresAt: i.expiresAt });
  }

  consentMessage(i: { organization: string; owner: string; agent: string; agentId: string; scopes: Scope[]; expiresAt: string }): string {
    return consentMessage({ host: this.host, deployment: this.deployment, ...i });
  }

  private async verify(s: Signed413, owner: string): Promise<Fail | null> {
    let nonce: Uint8Array;
    try {
      nonce = nonceFromString(s.nonce);
    } catch {
      return fail.refused("invalid_nonce");
    }
    if (!verifyNep413({ message: s.message, nonce, recipient: this.host }, { public_key: s.publicKey, signature: s.signature })) return fail.refused("signature_invalid");
    if (!(await this.chain.isFullAccessKey(owner, s.publicKey))) return fail.forbidden("owner_key");
    return null;
  }

  private consentView(c: StoredConsent): Consent {
    return { id: c.id, agentId: c.agentId, scopes: [...c.scopes], expiresAt: new Date(c.expiresAtMs).toISOString(), publicKey: c.publicKey, revoked: c.revoked };
  }

  async identity(agent: string): Promise<Res<{ agentId: string | null; created: boolean; owner: string }>> {
    if (this.state.unavailable) return fail.unavailable();
    const a = this.state.agents.get(agent);
    if (!a) return fail.refused("not_found");
    return ok({ agentId: a.agentId, created: a.agentId !== null, owner: a.owner });
  }

  async setup(s: Signed413): Promise<Res<{ agent: string; consent: Consent }>> {
    if (this.state.unavailable) return fail.unavailable();
    const body = JSON.stringify(s);
    const known = this.state.setups.get(body);
    if (known) return ok({ agent: known.agent, consent: this.consentView(this.state.consents.get(known.consentId)!) });
    const parsed = parseSetupMessage(s.message);
    if (!parsed) return fail.refused("invalid_setup");
    if (parsed.host !== this.host || parsed.deployment !== this.deployment) return fail.refused("wrong_host");
    if (parsed.area !== "payables") return fail.forbidden("area_not_allowed");
    const expires = Date.parse(parsed.expiresAt);
    if (!(expires > this.now())) return fail.refused("expired");
    if (expires - this.now() > SETUP_MAX_MS) return fail.refused("too_long");
    const bad = await this.verify(s, parsed.owner);
    if (bad) return bad;
    // One hosted agent per Organization, owner and area: a new setup finds the same agent until it is created.
    const reserved = [...this.state.agents.values()].find((x) => x.organization === parsed.organization && x.owner === parsed.owner);
    if (reserved?.agentId) return fail.refused("already_created");
    const name = reserved?.name ?? `own-${hex(12)}`;
    if (reserved) reserved.setupKey = s.publicKey;
    else
      this.state.agents.set(name, {
        name, organization: parsed.organization, owner: parsed.owner, setupKey: s.publicKey, ownerKey: null, agentId: null,
        revision: 0, status: "NONE", synced: false, policy: null, grants: [], funded: 0n, ops: new Map(),
      });
    const consent: StoredConsent = {
      id: hex(32), organization: parsed.organization, owner: parsed.owner, agent: name, agentId: "unborn", scopes: ["owner"],
      expiresAtMs: expires, publicKey: s.publicKey, revoked: false, signedBody: body,
    };
    this.state.consents.set(consent.id, consent);
    this.state.setups.set(body, { agent: name, consentId: consent.id });
    return this.takeDroppedReply() ? fail.unknown("reply lost (dropNextReply)") : ok({ agent: name, consent: this.consentView(consent) });
  }

  async reservations(organization: string, owner: string): Promise<Res<{ agent: string; owner: string; released: boolean }[]>> {
    if (this.state.unavailable) return fail.unavailable();
    return ok([...this.state.agents.values()].filter((a) => a.organization === organization && a.owner === owner).map((a) => ({ agent: a.name, owner: a.owner, released: false })));
  }

  async submitConsent(s: Signed413): Promise<Res<Consent>> {
    if (this.state.unavailable) return fail.unavailable();
    const body = JSON.stringify(s);
    const same = [...this.state.consents.values()].find((c) => c.signedBody === body);
    if (same) return ok(this.consentView(same));
    const parsed = parseConsentMessage(s.message);
    if (!parsed) return fail.refused("invalid_consent");
    if (parsed.host !== this.host || parsed.deployment !== this.deployment) return fail.refused("wrong_host");
    const a = this.state.agents.get(parsed.agent);
    if (!a || a.organization !== parsed.organization) return fail.refused("not_found");
    if (a.owner !== parsed.owner) return fail.forbidden("not_owner");
    if (a.agentId === null || a.agentId !== parsed.agentId) return fail.refused("agent_mismatch");
    if (parsed.scopes.some((x) => x !== "owner" && x !== "payout" && x !== "read")) return fail.refused("scope_not_allowed");
    const expires = Date.parse(parsed.expiresAt);
    if (!(expires > this.now())) return fail.refused("expired");
    if (expires - this.now() > CONSENT_MAX_MS) return fail.refused("too_long");
    const bad = await this.verify(s, parsed.owner);
    if (bad) return bad;
    const consent: StoredConsent = {
      id: hex(32), organization: parsed.organization, owner: parsed.owner, agent: parsed.agent, agentId: parsed.agentId,
      scopes: [...parsed.scopes] as Scope[], expiresAtMs: expires, publicKey: s.publicKey, revoked: false, signedBody: body,
    };
    this.state.consents.set(consent.id, consent);
    return ok(this.consentView(consent));
  }

  async listConsents(organization: string): Promise<Res<Consent[]>> {
    if (this.state.unavailable) return fail.unavailable();
    return ok([...this.state.consents.values()].filter((c) => c.organization === organization).map((c) => this.consentView(c)));
  }

  agent(organization: string, agent: string): AgentHandle {
    return new FakeAgent(this, organization, agent);
  }

  // ---- shared by FakeAgent ----

  /** The gateway's consent check (`app-routes.ts`): live, naming the agent's current id, scopes covering, key still held. */
  async access(organization: string, name: string, path: string): Promise<{ agent: Agent } | Fail> {
    const a = this.state.agents.get(name);
    const now = this.now();
    const live = a && a.organization === organization
      ? [...this.state.consents.values()].filter((c) => c.organization === organization && c.agent === name && c.owner === a.owner && !c.revoked && c.expiresAtMs > now)
      : [];
    if (!a || !live.length) return fail.forbidden("no_consent");
    const current = a.agentId ?? "unborn";
    const named = live.filter((c) => c.agentId === current || (c.agentId === "unborn" && a.agentId !== null && FOLLOW_CREATION.has(path)));
    if (!named.length) return fail.forbidden("agent_changed");
    const consent = named.find((c) => appScopesCover(c.scopes, path));
    if (!consent) return fail.forbidden("scope");
    if (!(await this.chain.isFullAccessKey(a.owner, consent.publicKey))) {
      consent.revoked = true;
      return fail.forbidden("consent_revoked");
    }
    return { agent: a };
  }

  /** The next mutation's reply is lost: it takes effect, and the caller sees `unknown`. */
  takeDroppedReply(): boolean {
    if (!this.state.dropNextReply) return false;
    this.state.dropNextReply = false;
    return true;
  }

  /** Moves an approved payout along under `after-read`. */
  touch(p: Payment) {
    if (p.status !== "PROCESSING" || this.autoSettle !== "after-read") return;
    p.processingReads++;
    if (p.processingReads > 1) this.finish(p);
  }

  /** Ends an approved payout: SUCCESS (the money leaves), or FAILED under `failAfterApproval`. */
  finish(p: Payment) {
    if (p.status !== "PROCESSING") return;
    p.txHash = `FAKE-${hex(16)}`;
    if (p.failAfterApproval) {
      p.status = "FAILED";
      p.failureCode = p.failAfterApproval;
    } else p.status = "SUCCESS";
  }

  spent(a: Agent) {
    return [...this.state.payments.values()].filter((p) => p.agent === a.name && p.status === "SUCCESS").reduce((s, p) => s + p.amount, 0n);
  }
  heldOf(a: Agent) {
    return [...this.state.payments.values()].filter((p) => p.agent === a.name && p.status === "PENDING_APPROVAL");
  }
  balance(a: Agent) {
    return a.funded - this.spent(a);
  }
  /** Funds a payout could still spend: confidential balance less payouts held for approval (authorize.ts `available`). */
  available(a: Agent) {
    return this.balance(a) - this.heldOf(a).reduce((s, p) => s + p.amount, 0n);
  }
  existsOnChain(account: string) {
    return this.chain.exists(account);
  }
  registered(account: string) {
    return this.chain.isRegistered(USDC, account);
  }
  notInForce(a: Agent): string | null {
    if (!a.policy) return "no policy is applied";
    if (a.status !== "APPLIED") return `revision ${a.revision} is not applied (${a.status})`;
    if (!a.synced) return `revision ${a.revision} is not yet synchronized with the provider`;
    if (a.policy.frozen) return "the agent is frozen";
    return null;
  }
  /** USD spent or committed in the last `windowMs` (USDC counted at $1). */
  usdIn(a: Agent, windowMs: number) {
    const since = this.now() - windowMs;
    const atomic = [...this.state.payments.values()]
      .filter((p) => p.agent === a.name && p.status !== "FAILED" && p.at >= since)
      .reduce((s, p) => s + p.amount, 0n);
    return Number(atomic) / 1e6;
  }
}

class FakeAgent implements AgentHandle {
  constructor(
    private readonly p: FakePlatform,
    private readonly organization: string,
    private readonly name: string,
  ) {}

  private async enter(path: string, mutation: boolean): Promise<{ agent: Agent } | Fail> {
    if (this.p.state.unavailable) return mutation ? fail.unknown("fake platform outage (setUnavailable)") : fail.unavailable();
    return this.p.access(this.organization, this.name, path);
  }

  async ownerPrepare(action: OwnerAction): Promise<Res<OwnerPrepared>> {
    const e = await this.enter("owner/prepare", true);
    if ("ok" in e) return e;
    const a = e.agent;
    const now = this.p.now();
    const correlationId = randomUUID();
    const expiresAtMs = now + INTENT_TTL_MS;
    const intentFor = (body: Record<string, unknown>): Intent413 => ({
      standard: "nep413",
      payload: { message: JSON.stringify(body), recipient: "fake-provider", nonce: randomBytes(32).toString("base64") },
    });
    const store = (o: Omit<OwnerIntent, "correlationId" | "agent" | "expiresAtMs" | "submitted">) => {
      this.p.state.intents.set(correlationId, { correlationId, agent: a.name, expiresAtMs, submitted: null, ...o });
    };
    const base = { correlationId, expiresAt: new Date(expiresAtMs).toISOString() };
    switch (action.type) {
      case "agent_create": {
        if (a.agentId !== null) return fail.refused("agent_exists");
        if (!action.owner || action.owner.account_id !== a.owner) return fail.forbidden("not_owner");
        if (action.owner.public_key !== a.setupKey) return fail.forbidden("setup_key");
        const intent = intentFor({ type: "agent_create", owner: action.owner, role: action.role });
        store({ action, intent });
        return ok({ ...base, summary: "Create the payout agent", intent });
      }
      case "grant_issue": {
        if (a.agentId === null) return fail.refused("agent_not_created");
        const intent = intentFor({ type: "grant_issue", agent_id: a.agentId, label: action.label, expires_at: new Date(now + GRANT_TTL_MS).toISOString() });
        store({ action, intent, grantLabel: action.label });
        return ok({ ...base, summary: `Authorize the "${action.label}" grant`, intent });
      }
      case "policy_update": {
        if (!a.policy) return fail.refused("policy_not_applied");
        if (action.expectedPolicy.revision !== a.revision || action.expectedPolicy.digest !== digestOf(a.policy)) return fail.refused("reviewed_policy_changed");
        const next = applyChanges(a.policy, action.changes);
        const intent = intentFor({ type: "policy_update", agent_id: a.agentId, expected_revision: a.revision, policy: next });
        store({ action, intent, policy: next });
        return ok({ ...base, summary: "Change the agent's policy", intent });
      }
      case "approval_vote": {
        const pay = this.p.state.payments.get(action.correlationId);
        if (!pay || pay.agent !== a.name || pay.approvalId !== action.approvalId) return fail.refused("approval_not_found");
        if (pay.status !== "PENDING_APPROVAL") return fail.refused("approval_not_pending");
        if (action.verdict === "approve") {
          const refusal = this.approvalRefusal(a, pay);
          if (refusal) return fail.refused(refusal);
        }
        const intent = intentFor({ type: "approval_vote", agent_id: a.agentId, approval_id: action.approvalId, verdict: action.verdict });
        store({ action, intent, paymentCorrelation: pay.correlationId });
        return ok({
          ...base,
          summary: `${action.verdict === "approve" ? "Approve" : "Reject"} the held payout`,
          intent,
          payment: {
            correlationId: pay.correlationId,
            verdict: action.verdict,
            terms: action.verdict === "approve" ? { recipient: pay.recipient, asset: USDC, amount: pay.amount.toString(), chain: "near" } : null,
          },
        });
      }
      case "agent_freeze": {
        // NEP-366 on the platform: the app gets only the platform's confirm link (FakeControls.completeConfirm signs it).
        const token = randomBytes(16).toString("base64url");
        store({ action, confirmToken: token });
        return ok({ ...base, summary: "Freeze the agent", confirm: { url: `https://${this.p.host}/confirm/${token}`, expiresAt: base.expiresAt } });
      }
    }
  }

  /** `authorize` for purpose `approval`: what the policy no longer allows at the vote. */
  private approvalRefusal(a: Agent, pay: Payment): string | null {
    if (this.p.notInForce(a)) return "policy_not_in_force";
    const policy = a.policy!;
    if (!policy.actions.includes("withdraw")) return "action_not_allowed";
    if (policy.assets !== "any" && !policy.assets.includes(USDC)) return "asset_not_allowed";
    if (!agreedWithdrawals(policy).has(pay.recipient)) return "payee_not_agreed";
    const cap = policy.limits.per_transaction?.[USDC];
    if (cap !== undefined && pay.amount > BigInt(cap)) return "per_transaction_exceeded";
    return null;
  }

  async ownerSubmit(correlationId: string, intent: Intent413, s: { publicKey: string; signature: string }): Promise<Res<{ status: string; failureCode: string | null }>> {
    const e = await this.enter("owner/submit", true);
    if ("ok" in e) return e;
    const a = e.agent;
    const it = this.p.state.intents.get(correlationId);
    if (!it || it.agent !== a.name || !it.intent) return fail.refused("not_found");
    if (it.submitted) return ok(it.submitted);
    if (this.p.now() > it.expiresAtMs) return fail.refused("expired");
    if (JSON.stringify(intent) !== JSON.stringify(it.intent)) return fail.refused("intent_mismatch");
    const expectedKey = it.action.type === "agent_create" ? a.setupKey : a.ownerKey;
    const p = intent.payload;
    let nonce: Uint8Array;
    try {
      nonce = nonceFromString(p.nonce);
    } catch {
      return fail.refused("invalid_nonce");
    }
    if (s.publicKey !== expectedKey || !verifyNep413({ message: p.message, recipient: p.recipient, nonce }, { public_key: s.publicKey, signature: s.signature }))
      return fail.refused("signature_invalid");
    const result = this.apply(a, it);
    if ("refused" in result) return fail.refused(result.refused);
    it.submitted = result;
    if (this.p.takeDroppedReply()) return fail.unknown("reply lost (dropNextReply)");
    return ok(result);
  }

  private apply(a: Agent, it: OwnerIntent): { status: string; failureCode: string | null } | { refused: string } {
    const action = it.action;
    switch (action.type) {
      case "agent_create":
        a.agentId = hex(32);
        a.ownerKey = action.owner!.public_key;
        a.policy = createdPolicy();
        a.revision = 1;
        a.status = "APPLIED";
        a.synced = true;
        return { status: "SUCCESS", failureCode: null };
      case "grant_issue":
        a.grants.push({ label: it.grantLabel!, expiresAtMs: this.p.now() + GRANT_TTL_MS, revoked: false });
        return { status: "SUCCESS", failureCode: null };
      case "policy_update":
        if (action.expectedPolicy.revision !== a.revision) return { refused: "reviewed_policy_changed" };
        a.policy = it.policy!;
        a.revision += 1;
        return { status: "SUCCESS", failureCode: null };
      case "approval_vote": {
        const pay = this.p.state.payments.get(it.paymentCorrelation!)!;
        if (pay.status !== "PENDING_APPROVAL") return { refused: "approval_not_pending" };
        if (action.verdict === "reject") {
          pay.status = "FAILED";
          pay.failureCode = "rejected_by_owner";
          return { status: "FAILED", failureCode: "rejected_by_owner" };
        }
        const refusal = this.approvalRefusal(a, pay);
        if (refusal) return { refused: refusal };
        pay.status = "PROCESSING";
        pay.failAfterApproval = this.p.state.failAfterApproval;
        this.p.state.failAfterApproval = null;
        return { status: "PROCESSING", failureCode: null };
      }
      case "agent_freeze":
        return { refused: "confirm_page" };
    }
  }

  async ownerStatus(correlationId: string): Promise<Res<OwnerStatus>> {
    const e = await this.enter("owner/status", false);
    if ("ok" in e) return e;
    const it = this.p.state.intents.get(correlationId);
    if (!it || it.agent !== e.agent.name) return fail.refused("not_found");
    if (!it.submitted) return ok({ stage: "prepared", status: this.p.now() > it.expiresAtMs ? "EXPIRED" : "PENDING_SIGNATURE", failureCode: null });
    if (it.action.type === "approval_vote") {
      // As observed on the stack: an approve vote reads `submitting` with no status; a reject reads FAILED.
      const pay = this.p.state.payments.get(it.paymentCorrelation!)!;
      if (it.action.verdict === "reject") return ok({ stage: "submitted", status: "FAILED", failureCode: "rejected_by_owner" });
      return ok({ stage: "submitting", status: null, failureCode: pay.status === "FAILED" ? pay.failureCode : null });
    }
    return ok({ stage: "submitted", status: it.submitted.status, failureCode: it.submitted.failureCode });
  }

  async overview(): Promise<Res<Overview>> {
    const e = await this.enter("overview", false);
    if ("ok" in e) return e;
    const a = e.agent;
    const p = a.policy;
    return ok({
      agentId: a.agentId ?? "",
      revision: a.policy ? a.revision : null,
      digest: p ? digestOf(p) : null,
      status: a.status,
      synced: a.synced,
      notInForce: this.p.notInForce(a),
      usdc: this.p.balance(a).toString(),
      policy: p
        ? {
            actions: [...p.actions],
            assets: p.assets === "any" ? "any" : [...p.assets],
            owner_approval: p.owner_approval,
            frozen: p.frozen,
            limits: clone(p.limits),
            budget: { ...p.budget },
            withdrawals: [...agreedWithdrawals(p)],
          }
        : null,
      grants: a.grants.map((g) => ({ label: g.label, revoked: g.revoked, expiresAt: new Date(g.expiresAtMs).toISOString() })),
    });
  }

  async deposit(): Promise<Res<Deposit>> {
    const e = await this.enter("deposit", true);
    if ("ok" in e) return e;
    return ok({ address: `${e.agent.name}.fake-wallet.near`, memo: null, minAmount: "1", expiresAt: null });
  }

  private answer(op: Op): PayoutAnswer {
    const base = { requestId: op.requestId, correlationId: op.correlationId, code: op.refused };
    if (op.refused) return { ...base, state: "refused", status: null };
    const pay = this.p.state.payments.get(op.correlationId!)!;
    this.p.touch(pay);
    const state = pay.status === "PENDING_APPROVAL" ? "held" : pay.status === "PROCESSING" ? "processing" : pay.status === "SUCCESS" ? "succeeded" : "failed";
    return { ...base, state, status: pay.status, ...(state === "failed" && {
      failureCode: pay.failureCode,
      // This simulator owns the payment state; only its completed rejection proves non-execution.
      neverExecuted: pay.failureCode === "rejected_by_owner" && !pay.txHash,
    }) };
  }

  async requestPayout(i: { requestId: string; recipient: string; amount: string; expectedPolicy: Reviewed }): Promise<Res<PayoutAnswer>> {
    this.p.state.requests.push(clone(i) as unknown as Record<string, unknown>);
    const e = await this.enter("payouts/request", true);
    if ("ok" in e) return e;
    const a = e.agent;
    if ("memo" in (i as object)) return fail.refused("memo_not_allowed");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(i.requestId)) return fail.refused("invalid_request");
    if (!/^[1-9][0-9]{0,39}$/.test(i.amount)) return fail.refused("invalid_request");
    const existing = a.ops.get(i.requestId);
    if (existing) {
      if (existing.recipient !== i.recipient || existing.amount !== i.amount) return fail.refused("request_conflict");
      const answer = this.answer(existing);
      return this.p.takeDroppedReply() ? fail.unknown("reply lost (dropNextReply)") : ok(answer);
    }
    // Thrown before anything is recorded: the same requestId may be asked again once fixed.
    if (!this.p.existsOnChain(i.recipient)) return fail.refused("recipient_not_found");
    const reg = await this.p.registered(i.recipient);
    if (reg === null) return fail.refused("recipient_unchecked");
    if (!reg) return fail.refused("recipient_not_registered");
    // Recorded, then judged (agent.ts dispatch → authorize).
    const op: Op = { requestId: i.requestId, recipient: i.recipient, amount: i.amount, refused: null, correlationId: null };
    a.ops.set(i.requestId, op);
    const refusal = this.payoutRefusal(a, i);
    if (refusal) op.refused = refusal;
    else {
      const now = this.p.now();
      const pay: Payment = {
        correlationId: randomUUID(), approvalId: randomUUID(), agent: a.name, recipient: i.recipient, amount: BigInt(i.amount),
        status: a.policy!.owner_approval ? "PENDING_APPROVAL" : "PROCESSING", failureCode: null, at: now,
        approvalExpiresAtMs: now + APPROVAL_TTL_MS, processingReads: 0, failAfterApproval: null, txHash: null,
      };
      this.p.state.payments.set(pay.correlationId, pay);
      op.correlationId = pay.correlationId;
    }
    const answer = this.answer(op);
    return this.p.takeDroppedReply() ? fail.unknown("reply lost (dropNextReply)") : ok(answer);
  }

  /** `authorize` for purpose `payout` on a withdrawal to chain near, plus the provider's budget window. */
  private payoutRefusal(a: Agent, i: { recipient: string; amount: string; expectedPolicy: Reviewed }): string | null {
    if (!a.policy || i.expectedPolicy.revision !== a.revision || i.expectedPolicy.digest !== digestOf(a.policy)) return "reviewed_policy_changed";
    if (this.p.notInForce(a)) return "policy_not_in_force";
    const now = this.p.now();
    const grant = a.grants.find((g) => !g.revoked && g.expiresAtMs > now);
    if (!grant) return "grant_missing";
    if (!PAYOUT_GRANTS.has(grant.label)) return "grant_purpose_denied";
    const policy = a.policy;
    if (policy.assets !== "any" && !policy.assets.includes(USDC)) return "asset_not_allowed";
    if (!agreedWithdrawals(policy).has(i.recipient)) return "payee_not_agreed";
    if (!policy.actions.includes("withdraw")) return "withdraw_not_allowed";
    const amount = BigInt(i.amount);
    const cap = policy.limits.per_transaction?.[USDC];
    if (cap !== undefined && amount > BigInt(cap)) return "per_transaction_exceeded";
    if (amount > this.p.available(a)) return "insufficient_balance";
    if (this.p.heldOf(a).some((h) => h.recipient === i.recipient && h.amount === amount)) return "duplicate_held_payout";
    const usd = Number(amount) / 1e6;
    const windows: [string | null, number][] = [[policy.budget.daily_usd, DAY], [policy.budget.weekly_usd, 7 * DAY], [policy.budget.monthly_usd, 30 * DAY]];
    for (const [limit, ms] of windows) if (limit !== null && this.p.usdIn(a, ms) + usd > Number(limit)) return "spend_budget_exceeded";
    return null;
  }

  async payoutStatus(requestId: string): Promise<Res<PayoutAnswer>> {
    const e = await this.enter("payouts/status", false);
    if ("ok" in e) return e;
    const op = e.agent.ops.get(requestId);
    if (!op) return ok({ requestId, state: "not_found", status: null, correlationId: null, code: null });
    return ok(this.answer(op));
  }

  async held(): Promise<Res<Held[]>> {
    const e = await this.enter("held", false);
    if ("ok" in e) return e;
    return ok(
      this.p.heldOf(e.agent).map((h) => ({
        correlationId: h.correlationId,
        approvalId: h.approvalId,
        request: { asset: USDC, amount: h.amount.toString(), chain: "near", recipient: h.recipient, confidential: true },
        at: new Date(h.at).toISOString(),
      })),
    );
  }

  async paymentStatus(correlationId: string): Promise<Res<PaymentStatus>> {
    const e = await this.enter("paymentStatus", false);
    if ("ok" in e) return e;
    const pay = this.p.state.payments.get(correlationId);
    if (!pay || pay.agent !== e.agent.name) return fail.refused("not_a_payment");
    this.p.touch(pay);
    return ok({
      status: pay.status,
      failureCode: pay.failureCode,
      approvalId: pay.approvalId,
      expiresAt: new Date(pay.approvalExpiresAtMs).toISOString(),
      evidence: { txHash: pay.txHash, destinationTxHash: pay.status === "SUCCESS" ? pay.txHash : null, refundTxHash: null, refundTo: null, refundedAmount: null },
    });
  }
}

/** Controls for the fake: the `DemoControls` the scenario uses, plus test hooks. */
export class FakeControls implements DemoControls {
  constructor(private readonly p: FakePlatform) {}

  async fund(agentId: string, atomic: string): Promise<void> {
    const a = [...this.p.state.agents.values()].find((x) => x.agentId === agentId);
    if (!a) throw new Error(`No created agent ${agentId}`);
    a.funded += BigInt(atomic);
  }
  async settle(correlationId: string): Promise<void> {
    const pay = this.p.state.payments.get(correlationId);
    if (!pay) throw new Error(`No payment ${correlationId}`);
    if (pay.status === "SUCCESS" || pay.status === "FAILED") return;
    if (pay.status !== "PROCESSING") throw new Error("Not approved");
    this.p.finish(pay);
  }
  async transfers(): Promise<{ recipient: string; amount: string; status: string }[]> {
    return [...this.p.state.payments.values()].map((x) => ({ recipient: x.recipient, amount: x.amount.toString(), status: x.status }));
  }
  async completeConfirm(url: string): Promise<void> {
    const token = url.split("/confirm/")[1];
    const it = [...this.p.state.intents.values()].find((x) => x.confirmToken === token);
    if (!it) throw new Error("No such confirm link");
    if (it.submitted) return;
    if (this.p.now() > it.expiresAtMs) throw new Error("The confirm link expired");
    const a = this.p.state.agents.get(it.agent)!;
    if (it.action.type === "agent_freeze" && a.policy) {
      a.policy.frozen = true;
      a.revision += 1;
    }
    it.submitted = { status: "SUCCESS", failureCode: null };
  }
  dropNextReply(): void {
    this.p.state.dropNextReply = true;
  }
  setUnavailable(on: boolean): void {
    this.p.state.unavailable = on;
  }
  failAfterApproval(code: string): void {
    this.p.state.failAfterApproval = code;
  }
  advance(ms: number): void {
    this.p.state.offsetMs += ms;
  }

  // ---- test hooks beyond DemoControls ----
  /** The fake chain: `setRegistered`, `setMissing`, `removeKey`, `addKey`. */
  get chain(): SimChain {
    return this.p.chain;
  }
  /** Payout request bodies exactly as received. */
  requests(): Record<string, unknown>[] {
    return clone(this.p.state.requests);
  }
  /** The policy as the fake holds it (for asserting the signed edit). */
  policyOf(agentId: string): Policy | null {
    const a = [...this.p.state.agents.values()].find((x) => x.agentId === agentId);
    return a?.policy ? clone(a.policy) : null;
  }
  /** Mark the policy not applied / not synced (status SIGNED), or back. */
  setPolicyStatus(agentId: string, status: PolicyStatus, synced: boolean): void {
    const a = [...this.p.state.agents.values()].find((x) => x.agentId === agentId);
    if (!a) throw new Error(`No created agent ${agentId}`);
    a.status = status;
    a.synced = synced;
  }
  /** Change the live policy as an owner edit or a platform-side change would: the revision goes up. */
  editPolicy(agentId: string, edit: (p: Policy) => void): void {
    const a = [...this.p.state.agents.values()].find((x) => x.agentId === agentId);
    if (!a?.policy) throw new Error(`No policy for ${agentId}`);
    edit(a.policy);
    a.revision += 1;
  }
  /** The owner's key removed from their account: consents it signed end (`consent_revoked`) at the next call. */
  revokeGrants(agentId: string): void {
    const a = [...this.p.state.agents.values()].find((x) => x.agentId === agentId);
    for (const g of a?.grants ?? []) g.revoked = true;
  }
}
