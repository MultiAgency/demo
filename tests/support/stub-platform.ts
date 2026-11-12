// A scripted stand-in for the Platform port, smaller than FakePlatform.
// It models only what Paperwork's engine depends on: NEP-413 checks, consent scopes on its own clock,
// owner steps, the authorize rules Paperwork maps, requestId idempotency, held → vote → settle, and
// hooks to script failures. It is not the platform; tests that need the real rules use FakePlatform.
import { ed25519 } from "@noble/curves/ed25519.js";
import { base64 } from "@scure/base";
import { formatPublicKey, nep413Hash, nonceFromString, randomNonce, nonceToString, verifyNep413 } from "../../src/server/nep413";
import {
  type AgentHandle,
  type Consent,
  type DemoControls,
  type Fail,
  type OwnerAction,
  type Overview,
  type PayoutAnswer,
  type Platform,
  type PlatformKit,
  type Res,
  type Signed413,
  USDC,
} from "../../src/server/platform/port";

const ok = <T>(value: T): Res<T> => ({ ok: true, value });
const refused = (code: string): Fail => ({ ok: false, kind: "refused", code });

interface Agent {
  name: string;
  org: string;
  owner: string;
  ownerPk: string;
  agentId: string | null;
  frozen: boolean;
  revision: number;
  digest: string;
  policy: NonNullable<Overview["policy"]>;
  grants: Overview["grants"];
  balance: bigint;
}
interface Payout {
  requestId: string;
  agent: string;
  recipient: string;
  amount: string;
  state: PayoutAnswer["state"];
  status: string;
  code: string | null;
  correlationId: string;
  approvalId: string | null;
  failureCode: string | null;
  txHash: string | null;
}
interface Step {
  agent: string;
  action: OwnerAction;
  message: string;
  nonce: string;
  status: string;
  payment?: string; // correlationId of the payment for votes
}

export class StubPlatform implements Platform {
  readonly mode = "fake" as const;
  readonly host = "stub.multiagency.test";
  readonly deployment = "multiagency-paperwork";
  private sk = ed25519.utils.randomSecretKey();
  readonly publicKey = formatPublicKey(ed25519.getPublicKey(this.sk));
  agents = new Map<string, Agent>();
  consents: (Consent & { org: string })[] = [];
  payouts = new Map<string, Payout>();
  steps = new Map<string, Step>();
  transfers: { recipient: string; amount: string; status: string }[] = [];
  /** Scripting hooks. */
  script = {
    requestFails: [] as Fail[], // returned by the next requestPayout calls, before anything is recorded
    recordedRefusals: [] as string[], // the next requests are recorded as refused with these codes
    unregistered: new Set<string>(),
    tamperVoteTerms: false,
    dropNextReply: false,
    unavailable: false,
    failAfterApproval: null as string | null,
  };
  calls = { requestPayout: 0, bodies: [] as Record<string, unknown>[] };
  private n = 0;

  constructor(readonly now: () => Date) {}

  // ------------------------------------------------------------ kit
  kit(): PlatformKit {
    const signer = { sign413: async (p: { message: string; recipient: string; nonce: string }) => this.sign(p) };
    const controls: DemoControls = {
      fund: async (agentId, atomic) => {
        const a = [...this.agents.values()].find((x) => x.agentId === agentId);
        if (!a) throw new Error(`no agent ${agentId}`);
        a.balance += BigInt(atomic);
      },
      settle: async (cid) => this.settle(cid),
      transfers: async () => [...this.transfers],
      dropNextReply: () => void (this.script.dropNextReply = true),
      setUnavailable: (on) => void (this.script.unavailable = on),
      failAfterApproval: (code) => void (this.script.failAfterApproval = code),
    };
    return {
      platform: this,
      chain: { isFullAccessKey: async (_acct, pk) => pk === this.publicKey, isRegistered: async (_t, acct) => !this.script.unregistered.has(acct) },
      controls,
      devSigner: signer,
    };
  }

  sign(p: { message: string; recipient: string; nonce: string }) {
    const sig = ed25519.sign(nep413Hash({ message: p.message, recipient: p.recipient, nonce: nonceFromString(p.nonce) }), this.sk);
    return { publicKey: this.publicKey, signature: base64.encode(sig) };
  }

  private id(prefix: string) {
    this.n += 1;
    return `${prefix}-${this.n}`;
  }

  private verify(s: Signed413, recipient = this.host): boolean {
    return verifyNep413({ message: s.message, nonce: nonceFromString(s.nonce), recipient }, { public_key: s.publicKey, signature: s.signature });
  }

  // ------------------------------------------------------------ Platform
  setupMessage(i: { organization: string; owner: string; expiresAt: string }) {
    return `MultiAgency setup\n${JSON.stringify({ deployment: this.deployment, area: "payables", ...i })}`;
  }
  consentMessage(i: { organization: string; owner: string; agent: string; agentId: string; scopes: ("owner" | "payout" | "read")[]; expiresAt: string }) {
    return `MultiAgency consent\n${JSON.stringify({ deployment: this.deployment, ...i })}`;
  }
  async identity(agent: string) {
    const a = this.agents.get(agent);
    if (!a) return { ok: false, kind: "refused", code: "agent_not_found" } as Fail;
    return ok({ agentId: a.agentId, created: a.agentId !== null, owner: a.owner });
  }
  async reservations(organization: string, owner: string) {
    if (this.script.unavailable) return { ok: false, kind: "unavailable" } as Fail;
    return { ok: true as const, value: [...this.agents.values()].filter((a) => a.org === organization && a.owner === owner).map((a) => ({ agent: a.name, owner: a.owner, released: false })) };
  }

  async setup(s: Signed413) {
    if (this.script.unavailable) return { ok: false, kind: "unavailable" } as Fail;
    if (!this.verify(s)) return refused("bad_signature");
    const m = JSON.parse(s.message.split("\n")[1]!) as { organization: string; owner: string; expiresAt: string };
    const name = `agt_${m.organization}`;
    if (!this.agents.has(name))
      this.agents.set(name, {
        name,
        org: m.organization,
        owner: m.owner,
        ownerPk: s.publicKey,
        agentId: null,
        frozen: false,
        revision: 0,
        digest: "",
        policy: { actions: [], assets: [], owner_approval: false, frozen: false, limits: {}, budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, withdrawals: [] },
        grants: [],
        balance: 0n,
      });
    const consent = { id: this.id("consent"), org: m.organization, agentId: "", scopes: ["owner"], expiresAt: m.expiresAt, publicKey: s.publicKey, revoked: false };
    this.consents.push(consent);
    return ok({ agent: name, consent });
  }
  async submitConsent(s: Signed413) {
    if (!this.verify(s)) return refused("bad_signature");
    const m = JSON.parse(s.message.split("\n")[1]!) as { organization: string; agentId: string; scopes: string[]; expiresAt: string };
    const consent = { id: this.id("consent"), org: m.organization, agentId: m.agentId, scopes: m.scopes, expiresAt: m.expiresAt, publicKey: s.publicKey, revoked: false };
    this.consents.push(consent);
    return ok(consent);
  }
  async listConsents(organization: string) {
    return ok(this.consents.filter((c) => c.org === organization).map(({ org: _o, ...c }) => c));
  }

  /** The gateway picks whichever live consent covers the path. */
  private gate(org: string, scope: "owner" | "payout" | "read"): Fail | null {
    if (this.script.unavailable) return { ok: false, kind: "unavailable" };
    const live = this.consents.filter((c) => c.org === org && !c.revoked && Date.parse(c.expiresAt) > this.now().getTime());
    if (live.some((c) => c.scopes.includes(scope) || (scope === "read" && c.scopes.includes("owner")))) return null;
    return { ok: false, kind: "forbidden", code: live.length ? "scope" : "no_consent" };
  }

  agent(organization: string, agent: string): AgentHandle {
    const a = () => {
      const x = this.agents.get(agent);
      if (!x || x.org !== organization) throw new Error(`stub: unknown agent ${agent}`);
      return x;
    };
    const answer = (p: Payout): PayoutAnswer => ({ requestId: p.requestId, state: p.state, status: p.status, correlationId: p.correlationId, code: p.code, ...(p.state === "failed" && { failureCode: p.failureCode, neverExecuted: p.failureCode === "rejected_by_owner" && !p.txHash }) });
    return {
      ownerPrepare: async (action) => {
        const g = this.gate(organization, "owner");
        if (g) return g;
        const cid = this.id("own");
        const nonce = nonceToString(randomNonce());
        const message = `MultiAgency owner action ${cid}: ${JSON.stringify(action)}`;
        let payment;
        if (action.type === "approval_vote") {
          const p = [...this.payouts.values()].find((x) => x.correlationId === action.correlationId && x.approvalId === action.approvalId && x.state === "held");
          if (!p) return refused("approval_not_found");
          payment = {
            correlationId: p.correlationId,
            verdict: action.verdict,
            terms: { recipient: p.recipient, asset: USDC, amount: this.script.tamperVoteTerms ? (BigInt(p.amount) + 1n).toString() : p.amount, chain: "near" },
          };
          this.steps.set(cid, { agent, action, message, nonce, status: "PREPARED", payment: p.correlationId });
        } else this.steps.set(cid, { agent, action, message, nonce, status: "PREPARED" });
        return ok({ correlationId: cid, expiresAt: new Date(this.now().getTime() + 15 * 60_000).toISOString(), summary: `${action.type} for ${agent}`, intent: { standard: "nep413" as const, payload: { message, recipient: this.host, nonce } }, payment });
      },
      ownerSubmit: async (cid, intent, s) => {
        const g = this.gate(organization, "owner");
        if (g) return g;
        const step = this.steps.get(cid);
        if (!step) return refused("unknown_correlation");
        if (!this.verify({ message: intent.payload.message, nonce: intent.payload.nonce, publicKey: s.publicKey, signature: s.signature }) || s.publicKey !== a().ownerPk) return refused("bad_signature");
        const x = a();
        const act = step.action;
        if (act.type === "agent_create") {
          x.agentId = this.id("agent");
          x.revision = 1;
          x.digest = "dg-1";
          x.policy = { ...x.policy, actions: ["withdraw"], assets: [USDC] };
        } else if (act.type === "grant_issue") x.grants.push({ label: "payout", revoked: false, expiresAt: new Date(this.now().getTime() + 90 * 86_400_000).toISOString() });
        else if (act.type === "policy_update") {
          if (act.expectedPolicy.revision !== x.revision || act.expectedPolicy.digest !== x.digest) {
            step.status = "FAILED";
            return ok({ status: "FAILED", failureCode: "reviewed_policy_changed" });
          }
          const c = act.changes;
          x.policy = {
            ...x.policy,
            withdrawals: c.withdrawals ? c.withdrawals.map((w) => w.address) : x.policy.withdrawals,
            owner_approval: c.owner_approval ?? x.policy.owner_approval,
            limits: c.limits ?? x.policy.limits,
            budget: c.budget ?? x.policy.budget,
          };
          x.revision += 1;
          x.digest = `dg-${x.revision}`;
        } else if (act.type === "approval_vote") {
          const p = [...this.payouts.values()].find((y) => y.correlationId === step.payment)!;
          if (act.verdict === "approve") Object.assign(p, { state: "processing", status: "PROCESSING" });
          else Object.assign(p, { state: "failed", status: "FAILED", failureCode: "rejected_by_owner" });
          step.status = p.status;
          return ok({ status: p.status, failureCode: p.failureCode });
        } else if (act.type === "agent_freeze") x.policy.frozen = true;
        step.status = "SUCCESS";
        return ok({ status: "SUCCESS", failureCode: null });
      },
      ownerStatus: async (cid) => {
        const step = this.steps.get(cid);
        if (!step) return refused("unknown_correlation");
        const p = step.payment ? [...this.payouts.values()].find((y) => y.correlationId === step.payment) : undefined;
        return ok({ stage: "submitted", status: p ? p.status : step.status, failureCode: p?.failureCode ?? null });
      },
      overview: async () => {
        const g = this.gate(organization, "read");
        if (g) return g;
        const x = a();
        if (!x.agentId) return refused("agent_not_created");
        return ok({ agentId: x.agentId, revision: x.revision, digest: x.digest, status: "APPLIED" as const, synced: true, notInForce: null, usdc: x.balance.toString(), policy: structuredClone(x.policy), grants: [...x.grants] });
      },
      deposit: async () => ok({ address: `deposit.${a().agentId}`, memo: null, minAmount: "1000000", expiresAt: null }),
      requestPayout: async (i) => {
        this.calls.requestPayout += 1;
        this.calls.bodies.push({ ...i });
        const g = this.gate(organization, "payout");
        if (g) return g;
        const scripted = this.script.requestFails.shift();
        if (scripted) return scripted;
        const prior = this.payouts.get(i.requestId);
        if (prior) return prior.recipient === i.recipient && prior.amount === i.amount ? ok(answer(prior)) : refused("request_conflict");
        if (this.script.unregistered.has(i.recipient)) return refused("recipient_not_registered");
        const x = a();
        const p: Payout = { requestId: i.requestId, agent, recipient: i.recipient, amount: i.amount, state: "refused", status: "REFUSED", code: null, correlationId: this.id("pay"), approvalId: null, failureCode: null, txHash: null };
        const reserved = [...this.payouts.values()].filter((y) => y.agent === agent && (y.state === "held" || y.state === "processing")).reduce((n, y) => n + BigInt(y.amount), 0n);
        const cap = x.policy.limits.per_transaction?.[USDC];
        const code =
          this.script.recordedRefusals.shift() ??
          (!x.grants.some((gr) => gr.label === "payout" && !gr.revoked)
            ? "grant_missing"
            : i.expectedPolicy.revision !== x.revision || i.expectedPolicy.digest !== x.digest
              ? "reviewed_policy_changed"
              : !x.policy.withdrawals.includes(i.recipient)
                ? "payee_not_agreed"
                : cap !== undefined && BigInt(i.amount) > BigInt(cap)
                  ? "per_transaction_exceeded"
                  : x.balance - reserved < BigInt(i.amount)
                    ? "insufficient_balance"
                    : [...this.payouts.values()].some((y) => y.agent === agent && y.state === "held" && y.recipient === i.recipient && y.amount === i.amount)
                      ? "duplicate_held_payout"
                      : null);
        if (code) p.code = code;
        else if (x.policy.owner_approval) Object.assign(p, { state: "held", status: "PENDING_APPROVAL", approvalId: this.id("appr") });
        else Object.assign(p, { state: "processing", status: "PROCESSING" });
        this.payouts.set(i.requestId, p);
        if (this.script.dropNextReply) {
          this.script.dropNextReply = false;
          return { ok: false, kind: "unknown" };
        }
        return ok(answer(p));
      },
      payoutStatus: async (rid) => {
        const g = this.gate(organization, "read");
        if (g) return g;
        const p = this.payouts.get(rid);
        return ok(p ? answer(p) : { requestId: rid, state: "not_found" as const, status: null, correlationId: null, code: null });
      },
      held: async () => {
        const g = this.gate(organization, "read");
        if (g) return g;
        return ok([...this.payouts.values()].filter((p) => p.agent === agent && p.state === "held").map((p) => ({ correlationId: p.correlationId, approvalId: p.approvalId!, request: { recipient: p.recipient, amount: p.amount }, at: this.now().toISOString() })));
      },
      paymentStatus: async (cid) => {
        const g = this.gate(organization, "read");
        if (g) return g;
        const p = [...this.payouts.values()].find((y) => y.correlationId === cid);
        if (!p) return refused("not_found");
        return ok({
          status: p.status,
          failureCode: p.failureCode,
          approvalId: p.approvalId,
          expiresAt: p.state === "held" ? new Date(this.now().getTime() + 7 * 86_400_000).toISOString() : null,
          evidence: { txHash: p.txHash, destinationTxHash: null, refundTxHash: null, refundTo: null, refundedAmount: null },
        });
      },
    };
  }

  settle(cid: string) {
    const p = [...this.payouts.values()].find((y) => y.correlationId === cid);
    if (!p || p.state !== "processing") throw new Error(`stub: ${cid} is not processing`);
    const a = this.agents.get(p.agent)!;
    p.txHash = this.id("SIMTX");
    if (this.script.failAfterApproval) {
      Object.assign(p, { state: "failed", status: "FAILED", failureCode: this.script.failAfterApproval });
      this.script.failAfterApproval = null;
      this.transfers.push({ recipient: p.recipient, amount: p.amount, status: "FAILED" });
      return;
    }
    a.balance -= BigInt(p.amount);
    Object.assign(p, { state: "succeeded", status: "SUCCESS" });
    this.transfers.push({ recipient: p.recipient, amount: p.amount, status: "SUCCESS" });
  }
}
