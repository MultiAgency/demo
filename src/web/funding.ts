import { fundingTransaction } from "@multiagency/sdk";
import { fundingPlanHash, validateRecoveryPlan, type FundingRecoveryView } from "../shared/funding-recovery";
import { toAtomic } from "../shared/money";
import { isMarketSettled, scopeTotal, USDC_NEAR } from "../shared/terms";
import type { ContractView, Deposit, VerifyView } from "./types";

export interface FundingRequest {
  job: string; hash: string; agent: string; sender: string; token: string;
  amount: string; address: string; memo: string | null; minimum: string | null; expires: string | null;
  recovery?: { reconciliation_id: string; plan_hash: string; credited_atomic: string; target_atomic: string; fee_atomic: string };
}
export function fundingRecoveryRequest(c: ContractView, view: FundingRecoveryView, now = Date.now()): FundingRequest {
  if (view.state !== "ready" || isMarketSettled(c.terms) || (c.terms.v === 3 && c.terms.agency_owner) ||
      c.platform.mode !== "remote" || !c.platform.policy?.applied || !c.platform.agent_id || c.stage === "frozen" || c.stage === "ended")
    throw Error("This job has no verified funding recovery to review.");
  const { plan_hash, ...plan } = view.plan;
  const binding = { job_id: c.id, terms_hash: c.hash, deployment: plan.deployment, platform_host: c.platform.host,
    app_origin: plan.app_origin, organization: c.organization, owner: c.terms.representative.near_account,
    agent_id: c.platform.agent_id, target_atomic: toAtomic(scopeTotal(c.terms), 6).toString() };
  if (fundingPlanHash(plan) !== plan_hash || validateRecoveryPlan(plan, binding, now).state !== "ready")
    throw Error("Funding recovery changed or expired. Review a fresh platform result.");
  return recoveryTransferRequest(view.plan, now);
}
function recoveryTransferRequest(input: Extract<FundingRecoveryView, { state: "ready" }>["plan"], now = Date.now()): FundingRequest {
  const { plan_hash, ...plan } = input;
  const binding = { job_id: plan.job_id, terms_hash: plan.terms_hash, deployment: plan.deployment, platform_host: plan.platform_host,
    app_origin: plan.app_origin, organization: plan.organization, owner: plan.owner, agent_id: plan.agent_id, target_atomic: plan.target_atomic };
  if (fundingPlanHash(plan) !== plan_hash || validateRecoveryPlan(plan, binding, now).state !== "ready")
    throw Error("Funding recovery changed or expired. Review a fresh platform result.");
  const q: FundingRequest = { job: plan.job_id, hash: plan.terms_hash, agent: plan.agent_id, sender: plan.owner,
    token: USDC_NEAR.slice(7), amount: plan.transfer_atomic, address: plan.destination.address, memo: null,
    minimum: plan.destination.minimum_atomic, expires: new Date(Math.min(Date.parse(plan.expires_at), Date.parse(plan.destination.expires_at))).toISOString(),
    recovery: { reconciliation_id: plan.reconciliation_id, plan_hash, credited_atomic: plan.credited_atomic,
      target_atomic: plan.target_atomic, fee_atomic: plan.fee_atomic } };
  validateFunding(q, q.sender, now);
  return q;
}
/** Recovery preflight deliberately avoids both allocating deposit and reconciliation-capable contract GET routes. */
export async function refreshRecoveryFunding(q: FundingRequest, request: <T>(method: "GET" | "POST", path: string, body?: unknown) => Promise<T>): Promise<FundingRequest> {
  validateFunding(q, q.sender);
  if (!q.recovery) throw Error("A recovery result is required.");
  const path = `/contracts/${encodeURIComponent(q.job)}`;
  const review = await request<FundingRecoveryView>("GET", `${path}/funding-recovery`);
  if (review.state !== "ready") throw Error(review.message);
  const fresh = recoveryTransferRequest(review.plan);
  if (JSON.stringify(fresh) !== JSON.stringify(q)) throw Error("Funding recovery changed. Review the current result again.");
  assertFundingVerification(fresh, await request<VerifyView>("GET", `${path}/verify`));
  await request("POST", `${path}/funding-recovery/prepare`, { reconciliation_id: q.recovery.reconciliation_id, plan_hash: q.recovery.plan_hash });
  return fresh;
}
export function fundingRequest(c: ContractView, d: Deposit): FundingRequest {
  if (c.terms.v === 3 && c.terms.agency_owner?.type === "dao") throw Error("DAO funding must be reviewed through its treasury; a member wallet cannot fund as the DAO here.");
  if (isMarketSettled(c.terms)) throw Error("This job settles on the Agent Market; it is not funded through the platform.");
  if (c.platform.mode !== "remote" || c.stage !== "needs_funding" || !c.platform.policy?.applied || !c.platform.agent_id || c.terms.asset !== USDC_NEAR)
    throw Error("Refresh status: this job is not ready for USDC funding.");
  const q = { job: c.id, hash: c.hash, agent: c.platform.agent_id, sender: c.terms.representative.near_account,
    token: USDC_NEAR.slice(7), amount: toAtomic(scopeTotal(c.terms), 6).toString(), address: d.address, memo: d.memo, minimum: d.minAmount, expires: d.expiresAt };
  validateFunding(q, q.sender);
  return q;
}
export function validateFunding(q: FundingRequest, account: string, now = Date.now()) {
  if (!q.job || !q.hash || !q.agent || q.sender !== account || q.token !== USDC_NEAR.slice(7) || !/^[1-9]\d*$/.test(q.amount) ||
      !/^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$/.test(q.address) || q.address.length < 2 || q.address.length > 64 ||
      (q.minimum !== null && (!/^\d+$/.test(q.minimum) || BigInt(q.amount) < BigInt(q.minimum))) ||
      (q.expires !== null && (!Number.isFinite(Date.parse(q.expires)) || Date.parse(q.expires) <= now)) ||
      q.memo !== null) throw Error("Funding instructions changed, expired or are invalid. Refresh and review them again.");
  if (q.recovery) {
    const r = q.recovery;
    if (!r.reconciliation_id || !/^[a-f0-9]{64}$/.test(r.plan_hash) ||
        ![r.credited_atomic, r.target_atomic, r.fee_atomic].every(v => /^(0|[1-9]\d*)$/.test(v)) ||
        BigInt(r.credited_atomic) <= 0n || BigInt(r.credited_atomic) >= BigInt(r.target_atomic) ||
        BigInt(q.amount) !== BigInt(r.target_atomic) - BigInt(r.credited_atomic) + BigInt(r.fee_atomic))
      throw Error("The recovery credit, fee and exact transfer do not reconcile.");
  }
}
/** Reuse the pinned SDK's registration + transfer transaction; no extra calls or amount conversion. */
export function fundingTransactionFor(q: FundingRequest) {
  validateFunding(q, q.sender);
  const tx = fundingTransaction("USDC", q.address, q.amount);
  if (tx.receiverId !== q.token || tx.actions.length !== 2 || tx.actions.some(a => a.params.gas !== "30000000000000"))
    throw Error("The SDK funding transaction changed. Review it before sending.");
  return tx;
}
export function assertFundingVerification(q: FundingRequest, v: VerifyView) {
  validateFunding(q, q.sender);
  if (v.overall !== "green" || v.observed?.agentId !== q.agent || v.observed.usdc !== (q.recovery?.credited_atomic ?? "0") || v.expected?.total !== (q.recovery?.target_atomic ?? q.amount) ||
      !["signed", "applied", "approval", "grant", "consent", "sig-representative", "sig-contractor"].every(id => v.checks.some(c => c.id === id && c.ok)))
    throw Error("The job policy, authority or required balance could not be verified. Refresh status before funding.");
}
interface Dependencies {
  network: string;
  session(): { account: string | null; loading: boolean; version: number };
  connect(): Promise<boolean>;
  readAccount(): Promise<string | null>;
  wallet(): { account: string | null; network: string; connected: boolean };
  fresh(q: FundingRequest): Promise<FundingRequest>;
  exclusive<T>(key: string, work: () => Promise<T>): Promise<T>;
  storage: Pick<Storage, "getItem" | "setItem">;
  send(q: FundingRequest): Promise<unknown>;
}
export const fundingKey = (q: FundingRequest) => `paperwork.funding:${q.job}:${q.sender}`;
/** Explicit wallet send only. Keep an unresolved marker across reloads; never retry an interrupted transfer. */
export class FundingWallet {
  private pending = false;
  constructor(private readonly d: Dependencies) {}
  async fund(input: FundingRequest): Promise<void> {
    if (this.pending) throw Error("A funding request is already open.");
    const q = Object.freeze({ ...input, ...(input.recovery ? { recovery: Object.freeze({ ...input.recovery }) } : {}) });
    const initial = { ...this.d.session() };
    const check = () => {
      if (this.d.network !== "mainnet") throw Error("USDC funding is supported on mainnet only.");
      validateFunding(q, initial.account ?? "");
      const current = this.d.session();
      if (initial.loading || !initial.account || current.loading || current.account !== initial.account || current.version !== initial.version)
        throw Error("Your sign-in changed. Review funding again.");
    };
    check(); this.pending = true;
    try {
      await this.d.exclusive(fundingKey(q), async () => {
        if (this.d.storage.getItem(fundingKey(q))) throw Error("A prior funding request may have been sent. Check the wallet transaction and agent balance; do not send again.");
        if (!await this.d.connect()) throw Error("Wallet connection cancelled.");
        check();
        if (await this.d.readAccount() !== initial.account) throw Error("Your session changed. Sign in again.");
        const fresh = await this.d.fresh(q);
        if (JSON.stringify(fresh) !== JSON.stringify(q)) throw Error("Funding instructions or job status changed. Refresh and review again.");
        check();
        const wallet = this.d.wallet();
        if (!wallet.connected || wallet.account !== initial.account || wallet.network !== "mainnet") throw Error(`Connect the mainnet wallet for ${initial.account}.`);
        // Must persist before entering wallet send. Failure to store refuses the transaction.
        this.d.storage.setItem(fundingKey(q), JSON.stringify({ request: q, state: "wallet_outcome_unknown", at: new Date().toISOString() }));
        await this.d.send(q);
      });
    } finally { this.pending = false; }
  }
}
