import { appClient, consentMessage, setupMessage } from "@multiagency/sdk";
import { z } from "zod";
import { map, toFail } from "../platform/client";
import type { DaoHireInput, DaoRequest, DaoState, FiledDaoHire, HireAnswer, HireTerms, MarketAccount, MarketAgent, MarketOwnerAction, MarketPlatform, MemberTransaction, OwnerPrepared, Res, Signed413 } from "./port";

/**
 * `MarketPlatform` over `@multiagency/sdk` `appClient` (0.5.6): the `market` area, the `market` consent scope, and the
 * DAO routes (`dao-setups`, `dao-consents`, `dao-hires`). Like `SdkPlatform`, it maps every answer to the port's shapes
 * and failure kinds and never retries: the callers decide. The credential stays inside the client.
 */
type SdkResult<A> = Parameters<typeof map<A, unknown>>[0];
type SdkAgentClient = ReturnType<ReturnType<typeof appClient>["agent"]>;

/** A DAO request route: 410 means the vote didn't pass before `votingUntil` (or what it signed expired). */
const daoState = <A, B>(r: SdkResult<A>, done: (v: A) => B | null): Res<DaoState<B>> => {
  if (!r.ok && r.kind === "refused" && r.status === 410) return { ok: true, value: { state: "expired" } };
  return map(r, (v) => {
    const d = done(v);
    return d === null ? { state: "pending" as const } : { state: "done" as const, ...d };
  });
};
const signedHash = z.object({ request: z.object({ payload_v2: z.object({ Eddsa: z.string() }) }) });
const tx = (t: MemberTransaction | null | undefined): MemberTransaction | null => (t ? { receiverId: t.receiverId, actions: t.actions } : null);
const daoRequest = (v: { request: Omit<DaoRequest, "proposal" | "proposalAndVote">; transactions?: { proposal?: MemberTransaction | null; proposalAndVote?: MemberTransaction | null } }): DaoRequest => ({
  id: v.request.id,
  hash: v.request.hash,
  description: v.request.description,
  votingUntil: v.request.votingUntil,
  proposal: tx(v.transactions?.proposal),
  proposalAndVote: tx(v.transactions?.proposalAndVote),
});
const hireAnswer = (v: Pick<HireAnswer, "requestId" | "state"> & { [K in "code" | "taskId" | "taskState" | "deliverable"]?: string | null }): HireAnswer => ({
  requestId: v.requestId,
  state: v.state,
  code: v.code ?? null,
  taskId: v.taskId ?? null,
  taskState: v.taskState ?? null,
  deliverable: v.deliverable ?? null,
});

// Platform 0.5.7 (#76) returns a matching retained request before checking this deadline. 0.5.6, and a 0.5.7 host
// with no reusable request, refuse the expired deadline before filing. A future deadline could create another vote
// after an unsigned vote lapsed; this read-like call must never do that. No SDK/host version is assumed.
const RECOVERY_DEADLINE = "1970-01-01T00:00:00.000Z";
const sameTerms = (a: Record<string, unknown>, b: HireTerms) => {
  const keys = Object.keys(b) as (keyof HireTerms)[];
  return Object.keys(a).length === keys.length && keys.every((key) => a[key] === b[key]);
};

export class SdkMarket implements MarketPlatform {
  readonly host: string;
  readonly deployment: string;
  private readonly app: ReturnType<typeof appClient>;

  constructor(o: { url: string; credential: string; deployment: string; fetch?: typeof fetch }) {
    const base = o.url.replace(/\/+$/, "");
    this.host = new URL(base).host;
    this.deployment = o.deployment;
    this.app = appClient({ base: base as `https://${string}`, credential: o.credential, ...(o.fetch && { fetch: o.fetch }) });
  }

  setupMessage(i: { organization: string; owner: string; expiresAt: string }) {
    return setupMessage({ host: this.host, deployment: this.deployment, area: "market", ...i });
  }
  consentMessage(i: { organization: string; owner: string; agent: string; agentId: string; scopes: string[]; expiresAt: string }) {
    return consentMessage({ host: this.host, deployment: this.deployment, ...i, scopes: i.scopes as never });
  }
  async identity(agent: string) {
    return map(await this.app.identity(agent), (v) => ({ agentId: v.agentId, created: v.created, owner: v.owner, signer: v.signer === "dao" ? ("dao" as const) : ("wallet" as const) }));
  }
  async setup(s: Signed413) {
    return map(await this.app.setup(s), (v) => ({ agent: v.agent }));
  }
  async reservations(organization: string, owner: string) {
    const r = await this.app.reservations({ organization, owner, area: "market" });
    return map(r, (v) => v.agents.filter((a) => a.area === "market").map((a) => ({ agent: a.agent, owner: a.owner, released: a.released === true })));
  }
  async submitConsent(s: Signed413) {
    return map(await this.app.consents.submit(s), (v) => ({ id: v.consent.id, expiresAt: new Date(v.consent.expiresAt).toISOString() }));
  }

  readonly daoSetup = {
    file: async (message: string) => map((await this.app.daoSetups.file(message)), daoRequest),
    state: async (id: string) => daoState((await this.app.daoSetups.state(id)), (v) => (v.state === "reserved" ? { agent: v.agent } : null)),
  };
  readonly daoConsent = {
    file: async (message: string) => map((await this.app.daoConsents.file(message)), daoRequest),
    state: async (id: string) =>
      daoState((await this.app.daoConsents.state(id)), (v) => (v.state === "signed" ? { consentId: v.consent.id, expiresAt: new Date(v.consent.expiresAt).toISOString() } : null)),
  };
  readonly daoHire = {
    file: async (i: { organization: string; agent: string; requestId: string; brief: string; approved: HireTerms; validUntil: string }) =>
      map((await this.app.daoHires.file(i)), (v) => ({ ...daoRequest(v), validUntil: v.request.validUntil })),
    recover: async (i: DaoHireInput & { owner: string; agentId: string }): Promise<Res<FiledDaoHire>> => {
      const { organization, agent, requestId, brief, approved } = i;
      const result = await this.app.daoHires.file({ organization, agent, requestId, brief, approved, validUntil: RECOVERY_DEADLINE });
      if (!result.ok) {
        if (result.kind === "refused" && result.code === "expires_too_soon")
          return { ok: false, kind: "refused", code: "dao_filing_recovery_unavailable" };
        return toFail(result);
      }
      const { request, transactions } = result.value;
      if (request.organization !== organization || request.agent !== agent || request.requestId !== requestId ||
        request.dao !== i.owner || request.agentId !== i.agentId || !sameTerms(request.approved, approved) ||
        !/^[a-f0-9]{64}$/.test(request.id) || request.hash !== request.id ||
        !Number.isFinite(request.votingUntil) || !Number.isFinite(Date.parse(request.validUntil)) ||
        transactions.proposal !== null || transactions.proposalAndVote !== null)
        return { ok: false, kind: "unavailable", detail: "The retained DAO approval did not match the original job identity and terms." };
      return { ok: true, value: { ...daoRequest(result.value), validUntil: request.validUntil } };
    },
    state: async (id: string) => daoState((await this.app.daoHires.state(id)), (v) => (v.state === "relayed" ? { hireState: String(v.hireState) } : null)),
  };

  agent(organization: string, agent: string): MarketAgent {
    const client = this.app.agent(organization, agent);
    return new SdkMarketAgent(client.call.bind(client));
  }
}

class SdkMarketAgent implements MarketAgent {
  constructor(private readonly call: SdkAgentClient["call"]) {}

  /** The action as each signer's published input; null when a wallet-owned agent is asked for without its owner. */
  private async prepare(a: MarketOwnerAction, signer: "wallet" | "dao") {
    // DAO ownership comes from setup; member wallet keys never become the provider owner.
    if (signer === "dao") return this.call("owner/prepare", { signer, action: a.type === "agent_create" ? { type: a.type, role: a.role } : a });
    if (a.type !== "agent_create") return this.call("owner/prepare", { signer, action: a });
    return a.owner ? this.call("owner/prepare", { signer, action: { ...a, owner: a.owner } }) : null;
  }

  async ownerPrepare(action: MarketOwnerAction, signer: "wallet" | "dao"): Promise<Res<OwnerPrepared>> {
    const r = await this.prepare(action, signer);
    if (!r) return { ok: false, kind: "refused", code: "wallet_owner_required" };
    return map(r, (v): OwnerPrepared => {
      const p: OwnerPrepared = { correlationId: v.correlationId, expiresAt: v.expiresAt, summary: v.preview?.summary ?? "" };
      if (v.dao) {
        // The hash the DAO's vote signs; absent, the caller refuses the step.
        const signed = signedHash.safeParse(v.dao.transaction?.actions?.[0]?.params?.args);
        p.dao = { hash: signed.success ? signed.data.request.payload_v2.Eddsa : "", proposal: tx(v.dao.proposal), proposalAndVote: tx(v.dao.proposalAndVote) };
      } else if (v.intent?.standard === "nep413") {
        const pl = v.intent.payload;
        p.intent = { standard: "nep413", payload: { message: pl.message, recipient: pl.recipient, nonce: pl.nonce } };
      } else if (v.confirm) p.confirm = { url: v.confirm.url, expiresAt: v.confirm.expiresAt };
      return p;
    });
  }
  async ownerSubmit(correlationId: string, intent: NonNullable<OwnerPrepared["intent"]>, s: { publicKey: string; signature: string }) {
    return map(await this.call("owner/submit", { correlationId, signedData: { ...intent, public_key: s.publicKey, signature: s.signature } }), (v) => ({ status: String(v.status) }));
  }
  async ownerStatus(correlationId: string) {
    return map(await this.call("owner/status", { correlationId }), (v) => ({ stage: String(v.stage), status: v.status ?? null, failureCode: v.failureCode ?? null }));
  }
  async ownerPending() {
    return map(await this.call("owner/pending"), (v) =>
      v.map((p) => ({
        correlationId: p.correlationId,
        type: p.type,
        hash: p.hash ?? null,
        expiresAt: p.expiresAt,
        intent: p.intent?.standard === "nep413" ? { standard: "nep413" as const, payload: { message: p.intent.payload.message, recipient: p.intent.payload.recipient, nonce: p.intent.payload.nonce } } : null,
      })),
    );
  }
  async deposit() {
    return map(await this.call("deposit"), (v) => ({ address: v.address, memo: v.memo ?? null, minAmount: v.minAmount ?? null, expiresAt: v.expiresAt ?? null }));
  }
  async account(): Promise<Res<MarketAccount>> {
    return map(await this.call("market/account"), (v) => ({ account: v.account, registered: v.registered, opened: v.opened, usdc: String(v.usdc), registration: tx(v.registration) }));
  }
  async frozen(): Promise<Res<boolean>> {
    return map(await this.call("overview"), (v) => v.policy?.policy?.frozen === true);
  }
  async quote(handle: string, brief: string): Promise<Res<HireTerms>> {
    return map(await this.call("market/quote", { handle, brief }), (v) => ({ ...v }));
  }
  async hire(requestId: string, brief: string, approved: HireTerms) {
    return map(await this.call("market/hire", { requestId, brief, approved }), hireAnswer);
  }
  async status(requestId: string) {
    return map(await this.call("market/status", { requestId }), hireAnswer);
  }
}
