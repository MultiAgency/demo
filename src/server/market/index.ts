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

/** Covenant on the agent market: agencies that hire listed agents (client) and work the market's jobs (worker). */
export class Market {
  readonly agencies: Agencies;
  readonly hires: Hires;
  readonly worker: Worker;
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
    if (a.stage === "ready" || a.stage === "needs_registration") {
      const r = await this.agencies.agent(a).account();
      if (r.ok) account = { account: r.value.account, registered: r.value.registered, opened: r.value.opened, usdc_usd: fromAtomic(BigInt(r.value.usdc), USDC_DECIMALS) };
    }
    return {
      id: a.id,
      name: a.name,
      organization: a.organization,
      owner: a.owner,
      signer: a.signer,
      agent: a.agent,
      agent_id: a.agent_id,
      stage: a.stage,
      consent_expires_at: a.consent_expires_at,
      account,
      deposit: await this.agencies.depositView(a),
      hires: this.hires.forAgency(a.id).map((h) => this.hires.view(h)),
      worker: this.d.worker?.agencyId === a.id,
    };
  }

  /** The server's timer: live hires and DAO votes, and the worker's backstop poll. */
  async tick() {
    await this.hires.followAll();
    if (this.worker.configured) await this.worker.poll().catch(() => {});
  }
}
