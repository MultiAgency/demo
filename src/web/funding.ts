import { fundingTransaction } from "@multiagency/sdk";
import { toAtomic } from "../shared/money";
import { scopeTotal, USDC_NEAR } from "../shared/terms";
import type { ContractView, Deposit, VerifyView } from "./types";

export interface FundingRequest {
  job: string; hash: string; agent: string; sender: string; token: string;
  amount: string; address: string; memo: string | null; minimum: string | null; expires: string | null;
}
export function fundingRequest(c: ContractView, d: Deposit): FundingRequest {
  if (c.terms.v === 3 && c.terms.agency_owner?.type === "dao") throw Error("DAO funding must be reviewed through its treasury; a member wallet cannot fund as the DAO here.");
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
  if (v.overall !== "green" || v.observed?.agentId !== q.agent || v.observed.usdc !== "0" || v.expected.total !== q.amount ||
      !["signed", "applied", "approval", "grant", "consent", "sig-representative", "sig-contractor"].every(id => v.checks.some(c => c.id === id && c.ok)))
    throw Error("The job policy, authority or zero balance could not be verified. Refresh status before funding.");
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
    const q = Object.freeze({ ...input });
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
