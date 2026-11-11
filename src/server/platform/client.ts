import { appClient, consentMessage, setupMessage } from "@multiagency/sdk";
import {
  type AgentHandle,
  type Consent,
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
  type Res,
  type Reviewed,
  type Signed413,
  USDC,
} from "./port";

/**
 * `Platform` over `@multiagency/sdk` `appClient`: the app deployment's routes under `/apps/v1`. The service credential
 * stays inside this object (never logged, never in a result). Every platform answer is mapped to the port's
 * shapes and failure kinds; nothing here retries or decides — the engine does.
 */
export interface SdkPlatformOptions {
  url: string;
  credential: string;
  deployment: string;
  fetch?: typeof fetch;
  /**
   * The label `grant_issue` is sent with. The platform accepts `payout` (and `invoices`) for payout sends; the local
   * stack's provider sim accepts only `invoices` for a created agent (MultiAgency/platform#54), so `makePlatform` passes
   * `"invoices"` when it runs against a stack dir.
   */
  grantLabel?: "payout" | "invoices";
}

type AnyFailure = { ok: false; kind: string; code?: string; error?: string; httpStatus?: number; retryAfterSeconds?: number; status?: number };

/** An SDK failure (app route or owner procedure) as the port's `Fail`. Never includes the credential. */
export function toFail(r: AnyFailure): Fail {
  switch (r.kind) {
    case "session":
      return { ok: false, kind: "session" };
    case "forbidden":
      return r.code ? { ok: false, kind: "forbidden", code: r.code } : { ok: false, kind: "forbidden" };
    case "refused":
      return { ok: false, kind: "refused", code: r.code ?? `http_${r.status ?? "4xx"}` };
    case "unresolved":
      return { ok: false, kind: "unresolved" };
    case "busy":
      return { ok: false, kind: "busy" };
    case "rate_limited":
      return { ok: false, kind: "rate_limited", retryAfterSeconds: r.retryAfterSeconds ?? null };
    case "provider":
      return { ok: false, kind: "provider", detail: r.code ?? r.error ?? "provider" };
    case "unknown":
      return { ok: false, kind: "unknown", detail: r.httpStatus ? `HTTP ${r.httpStatus}` : "no answer" };
    default:
      return { ok: false, kind: "unavailable", detail: r.httpStatus ? `HTTP ${r.httpStatus}` : "no answer" };
  }
}

const map = <A, B>(r: { ok: true; value: A } | AnyFailure, f: (a: A) => B): Res<B> => (r.ok ? { ok: true, value: f(r.value) } : toFail(r));

interface SdkConsent {
  id: string;
  agentId: string;
  scopes: string[];
  expiresAt: number;
  publicKey: string;
  revoked: boolean;
}
/** The platform's consent view (`expiresAt` epoch ms) as the port's (ISO). */
export const toConsent = (c: SdkConsent): Consent => ({
  id: c.id,
  agentId: c.agentId,
  scopes: [...c.scopes],
  expiresAt: new Date(c.expiresAt).toISOString(),
  publicKey: c.publicKey,
  revoked: c.revoked,
});

export class SdkPlatform implements Platform {
  readonly mode = "remote" as const;
  readonly host: string;
  readonly deployment: string;
  private readonly app: ReturnType<typeof appClient>;
  private readonly grantLabel: "payout" | "invoices";

  constructor(o: SdkPlatformOptions) {
    const base = o.url.replace(/\/+$/, "");
    if (!/^https?:\/\//.test(base)) throw new Error("The platform URL must be http(s)");
    this.host = new URL(base).host;
    this.deployment = o.deployment;
    this.grantLabel = o.grantLabel ?? "payout";
    this.app = appClient({ base: base as `https://${string}`, credential: o.credential, ...(o.fetch && { fetch: o.fetch }) });
  }

  setupMessage(i: { organization: string; owner: string; expiresAt: string }): string {
    return setupMessage({ host: this.host, deployment: this.deployment, organization: i.organization, owner: i.owner, area: "payables", expiresAt: i.expiresAt });
  }

  consentMessage(i: { organization: string; owner: string; agent: string; agentId: string; scopes: ("owner" | "payout" | "read")[]; expiresAt: string }): string {
    return consentMessage({ host: this.host, deployment: this.deployment, ...i });
  }

  async identity(agent: string) {
    return map(await this.app.identity(agent), (v) => ({ agentId: v.agentId, created: v.created, owner: v.owner }));
  }

  async setup(s: Signed413) {
    return map(await this.app.setup(s), (v) => ({ agent: v.agent, consent: toConsent(v.consent) }));
  }

  async reservations(organization: string, owner: string) {
    const r = await this.app.reservations({ organization, owner, area: "payables" });
    return map(r, (v) => v.agents.filter((a) => a.area === "payables").map((a) => ({ agent: a.agent, owner: a.owner, released: a.released === true })));
  }

  async submitConsent(s: Signed413) {
    return map(await this.app.consents.submit(s), (v) => toConsent(v.consent));
  }

  async listConsents(organization: string) {
    return map(await this.app.consents.list(organization), (v) => v.consents.map(toConsent));
  }

  agent(organization: string, agent: string): AgentHandle {
    return new SdkAgent(this.app.agent(organization, agent), this.grantLabel);
  }
}

type SdkAgentClient = ReturnType<ReturnType<typeof appClient>["agent"]>;
// The SDK's call() is typed per procedure; its inputs here are built to the published schemas (owner-inputs, inputs).
type Call = (path: string, input?: unknown) => Promise<{ ok: true; value: any } | AnyFailure>;

/**
 * The policy's NEAR withdrawal payees: `destinations.list` entries action=withdraw, chain=near, memo=null.
 * The list only limits payees in mode "only"; any other mode is reported as such, so it never matches the signed payee.
 */
export function withdrawalsOf(policy: { destinations: { mode?: string; list: { action: string; chain?: string; address: string; memo?: string | null }[] } }): string[] {
  const mode = policy.destinations.mode;
  if (mode !== undefined && mode !== "only") return [`(destinations mode "${mode}")`];
  return policy.destinations.list.filter((d) => d.action === "withdraw" && d.chain === "near" && d.memo === null).map((d) => d.address);
}

class SdkAgent implements AgentHandle {
  private readonly call: Call;
  constructor(
    agent: SdkAgentClient,
    private readonly grantLabel: "payout" | "invoices",
  ) {
    this.call = agent.call.bind(agent) as unknown as Call;
  }

  async ownerPrepare(a: OwnerAction): Promise<Res<OwnerPrepared>> {
    const action = a.type === "grant_issue" ? { ...a, label: this.grantLabel } : a;
    const r = await this.call("owner/prepare", { action, signer: "wallet" });
    if (!r.ok) return toFail(r);
    const v = r.value;
    const prepared: OwnerPrepared = {
      correlationId: v.correlationId,
      expiresAt: v.expiresAt,
      summary: v.preview?.summary ?? "",
    };
    if (v.intent?.standard === "nep413") {
      const p = v.intent.payload as { message: string; recipient: string; nonce: string };
      prepared.intent = { standard: "nep413", payload: { message: p.message, recipient: p.recipient, nonce: p.nonce } };
    } else if (v.confirm) prepared.confirm = { url: v.confirm.url, expiresAt: v.confirm.expiresAt };
    else return { ok: false, kind: "refused", code: "unreadable_intent" };
    if (v.payment) {
      const t = v.payment.terms;
      prepared.payment = {
        correlationId: v.payment.correlationId,
        verdict: v.payment.verdict,
        terms: t ? { recipient: t.recipient, asset: t.asset, amount: t.amount, ...(t.chain !== undefined && { chain: t.chain }) } : null,
      };
    }
    return { ok: true, value: prepared };
  }

  async ownerSubmit(correlationId: string, intent: Intent413, s: { publicKey: string; signature: string }) {
    const r = await this.call("owner/submit", { correlationId, signedData: { ...intent, public_key: s.publicKey, signature: s.signature } });
    return map(r, (v: { status: string; failureCode?: string | null }) => ({ status: v.status, failureCode: v.failureCode ?? null }));
  }

  async ownerStatus(correlationId: string): Promise<Res<OwnerStatus>> {
    const r = await this.call("owner/status", { correlationId });
    return map(r, (v: { stage: string; phase?: OwnerStatus["phase"]; status?: string | null; failureCode?: string | null }) => ({ stage: v.stage, ...(v.phase && { phase: v.phase }), status: v.status ?? null, failureCode: v.failureCode ?? null }));
  }

  async overview(): Promise<Res<Overview>> {
    const r = await this.call("overview");
    return map(r, (v: any): Overview => {
      const view = v.policy;
      const p = view.policy;
      const usdc = (v.book as { asset: string; confidential: bigint }[]).find((b) => b.asset === USDC)?.confidential ?? 0n;
      const limits = p?.limits ?? {};
      return {
        agentId: v.agentId,
        revision: view.revision,
        digest: v.digest,
        status: view.status,
        synced: view.provider_policy_synced,
        notInForce: v.notInForce,
        usdc: usdc.toString(),
        policy: p
          ? {
              actions: [...p.actions],
              assets: p.assets === "any" ? "any" : [...p.assets],
              owner_approval: p.owner_approval,
              frozen: p.frozen,
              limits: Object.fromEntries((["per_transaction", "hourly", "daily", "monthly"] as const).filter((k) => limits[k]).map((k) => [k, { ...limits[k] }])),
              budget: { daily_usd: p.budget.daily_usd, weekly_usd: p.budget.weekly_usd, monthly_usd: p.budget.monthly_usd },
              withdrawals: withdrawalsOf(p),
            }
          : null,
        grants: (v.grants as { label: string; revoked_at: string | null; expires_at: string }[]).map((g) => ({ label: g.label, revoked: g.revoked_at !== null, expiresAt: g.expires_at })),
      };
    });
  }

  async deposit(): Promise<Res<Deposit>> {
    const r = await this.call("deposit", { asset: USDC });
    return map(r, (v: any) => ({ address: v.address, memo: v.memo ?? null, minAmount: v.minAmount ?? null, expiresAt: v.expiresAt ?? null }));
  }

  async requestPayout(i: { requestId: string; recipient: string; amount: string; expectedPolicy: Reviewed }): Promise<Res<PayoutAnswer>> {
    // A withdrawal to chain near, from the confidential balance. Never a memo.
    const body = { requestId: i.requestId, asset: USDC, delivery: { chain: "near" }, recipient: i.recipient, amount: i.amount, expectedPolicy: { revision: i.expectedPolicy.revision, digest: i.expectedPolicy.digest } };
    return map(await this.call("payouts/request", body), toAnswer);
  }

  async payoutStatus(requestId: string): Promise<Res<PayoutAnswer>> {
    return map(await this.call("payouts/status", { requestId }), toAnswer);
  }

  async held(): Promise<Res<Held[]>> {
    return map(await this.call("held"), (v: any[]) => v.map((h) => ({ correlationId: h.correlationId, approvalId: h.approvalId, request: { ...h.request }, at: h.at })));
  }

  async paymentStatus(correlationId: string): Promise<Res<PaymentStatus>> {
    return map(await this.call("paymentStatus", { correlationId }), (v: any): PaymentStatus => ({
      status: v.status,
      failureCode: v.failureCode ?? null,
      approvalId: v.approvalId ?? null,
      expiresAt: v.expiresAt ?? null,
      evidence: {
        txHash: v.evidence?.txHash ?? null,
        destinationTxHash: v.evidence?.destinationTxHash ?? null,
        refundTxHash: v.evidence?.refundTxHash ?? null,
        refundTo: v.evidence?.refundTo ?? null,
        refundedAmount: v.evidence?.refundedAmount ?? null,
      },
    }));
  }
}

const toAnswer = (v: any): PayoutAnswer => ({
  requestId: v.requestId,
  state: v.state,
  status: v.status ?? null,
  correlationId: v.correlationId ?? null,
  code: v.code ?? null,
  failureCode: v.failureCode ?? null,
  neverExecuted: v.neverExecuted === true,
});

/** A `fetch` that trusts `caPem` for TLS (Bun's `tls.ca`): the local stack's own self-signed certificate. */
export function caFetch(caPem: string): typeof fetch {
  const f = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, tls: { ca: caPem } } as RequestInit);
  return f as typeof fetch;
}
