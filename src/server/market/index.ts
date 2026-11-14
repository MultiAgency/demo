import type { Database } from "bun:sqlite";
import type { AgencyView } from "../../shared/market";
import { fromAtomic } from "../../shared/money";
import { USDC_DECIMALS } from "../../shared/terms";
import type { ChainReader } from "../platform/port";
import { Agencies } from "./agencies";
import { MarketApi } from "./api";
import { migrateMarket } from "./db";
import { Hires } from "./hires";
import type { DaoPolicyReader } from "./members";
import type { MarketControls, MarketPlatform } from "./port";
import { Worker, type WorkerConfig } from "./worker";

export interface MarketDeps {
  db: Database;
  market: MarketPlatform;
  controls: MarketControls | null;
  chain: ChainReader;
  api: MarketApi;
  worker: WorkerConfig | null;
  daoPolicy: DaoPolicyReader;
  now: () => Date;
}

/** Paperwork on the agent market: agencies that hire listed agents (client) and work the market's jobs (worker). */
export class Market {
  readonly agencies: Agencies;
  readonly hires: Hires;
  readonly worker: Worker;
  private pollError: string | null = null;
  constructor(readonly d: MarketDeps) {
    migrateMarket(d.db);
    this.agencies = new Agencies({ db: d.db, market: d.market, chain: d.chain, now: d.now });
    this.hires = new Hires({ db: d.db, market: d.market, agencies: this.agencies, now: d.now });
    this.worker = new Worker({ db: d.db, api: d.api, agencies: this.agencies, config: d.worker, now: d.now });
  }

  async view(id: string): Promise<AgencyView> {
    await this.hires.followAll(id);
    const a = this.agencies.row(id);
    let account: AgencyView["account"] = null;
    let frozen: boolean | null = null;
    const live = a.stage === "ready" || a.stage === "needs_registration";
    const [f, r, deposit] = await Promise.all([
      live ? this.agencies.agent(a).frozen() : null,
      live ? this.agencies.agent(a).account() : null,
      this.agencies.depositView(a),
    ]);
    if (f?.ok) frozen = f.value;
    if (r?.ok) account = { account: r.value.account, registered: r.value.registered, opened: r.value.opened, usdc_usd: fromAtomic(BigInt(r.value.usdc), USDC_DECIMALS) };
    return {
      id: a.id,
      name: a.name,
      organization: a.organization,
      owner: a.owner,
      signer: a.signer,
      agent: a.agent,
      agent_id: a.agent_id,
      stage: a.stage,
      frozen,
      dao_stop_url: a.signer === "dao" && a.agent ? this.agencies.daoStopUrl(a) : null,
      consent_expires_at: a.consent_expires_at,
      account,
      deposit,
      hires: this.hires.forAgency(a.id).map((h) => this.hires.view(h)),
      worker: this.d.worker?.agencyId === a.id,
    };
  }

  /**
   * Startup refusal: a worker bound to no agency would keep reading the market as the listed agent, which the market
   * counts as presence and answers callers with a price, while nobody could see or deliver the work.
   */
  requireWorkerAgency() {
    const id = this.d.worker?.agencyId;
    if (id !== undefined && !this.agencies.list().some((a) => a.id === id))
      throw new Error("MARKET_WORKER_AGENCY names no agency in this database. Create the agency in Paperwork first, then set its id.");
  }

  /** The server's timer: live hires and DAO votes, and the worker's backstop poll. */
  async tick(log: (msg: string) => void = () => {}) {
    // Start worker observation independently of slow buyer-side status reads.
    await Promise.all([this.hires.followAll(), this.pollWorker(log)]);
  }

  private async pollWorker(log: (msg: string) => void) {
    if (!this.worker.configured) return;
    const error = await this.worker.poll().then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err)));
    // Only changes are logged: the first failure, each different failure, and the recovery.
    if (error !== this.pollError) log(error === null ? "market worker: assignment poll recovered" : `market worker: assignment poll failed: ${error}`);
    this.pollError = error;
  }
}
