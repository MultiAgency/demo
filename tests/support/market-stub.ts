// A scripted stand-in for Covenant's market port (src/server/market/port.ts), for unit tests of Covenant's own state
// machines: what it records before a call, and how it follows lost answers and DAO votes. It is not a simulated
// market or platform: each test sets the answers. The platform behaviour itself is exercised by `demo:market`.
import { Database } from "bun:sqlite";
import { Agencies } from "../../src/server/market/agencies";
import type { DaoHireInput, DaoRequest, DaoState, FiledDaoHire, HireAnswer, HireTerms, MarketAccount, MarketAgent, MarketOwnerAction, MarketPlatform, OwnerPrepared, Res, Signed413 } from "../../src/server/market/port";
import { Market } from "../../src/server/market";
import { MarketApi } from "../../src/server/market/api";
import type { WorkerConfig } from "../../src/server/market/worker";
import type { ChainReader } from "../../src/server/platform/port";

export const TERMS: HireTerms = {
  handle: "writer",
  brief: "a".repeat(64),
  network: "near:mainnet",
  asset: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  payTo: "ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc",
  amount: "500000",
  maxTimeoutSeconds: 1200,
};

const ok = <T>(value: T): Res<T> => ({ ok: true, value });
const request = (id: string): DaoRequest => ({ id, hash: id.padEnd(64, "0"), description: `* Proposal Action: ${id}`, votingUntil: Date.parse("2026-11-20T00:00:00Z"), proposal: null, proposalAndVote: null });

export class StubMarket implements MarketPlatform {
  readonly host = "platform.test";
  readonly deployment = "covenant";
  /** Every agent call, in order: [method, ...args]. */
  calls: unknown[][] = [];
  hireAnswers: Res<HireAnswer>[] = [];
  statusAnswers: Res<HireAnswer>[] = [];
  prepareAnswers: Res<OwnerPrepared>[] = [];
  pending: { correlationId: string; type: string; hash: string | null; expiresAt: string; intent: OwnerPrepared["intent"] | null }[] = [];
  daoHireStates: Res<DaoState<{ hireState: string }>>[] = [];
  daoHireRecoveryAnswers: Res<FiledDaoHire>[] = [];
  account: MarketAccount = { account: "f".repeat(64), registered: true, opened: false, usdc: "0", registration: null };
  isFrozen = false;
  /** Overrides: set to script one answer each (tests of Covenant's handling). */
  frozenAnswer: Res<boolean> | null = null;
  identityAnswer: Res<{ agentId: string | null; created: boolean; owner: string; signer: "wallet" | "dao" }> | null = null;
  setupAnswer: Res<{ agent: string }> | null = null;
  reservationsAnswer: Res<{ agent: string; owner: string; released: boolean }[]> = ok([]);
  daoConsentStates: Res<DaoState<{ consentId: string; expiresAt: string }>>[] = [];

  setupMessage(i: { organization: string; owner: string; expiresAt: string }) {
    return `setup ${i.organization} ${i.owner}`;
  }
  consentMessage(i: { organization: string; scopes: string[] }) {
    return `consent ${i.organization} ${i.scopes.join(",")}`;
  }
  async identity() {
    return this.identityAnswer ?? ok({ agentId: "agent-id", created: true, owner: "acme.near", signer: "wallet" as const });
  }
  async setup(_s: Signed413) {
    this.calls.push(["setup"]);
    return this.setupAnswer ?? ok({ agent: "own-1" });
  }
  async reservations() {
    return this.reservationsAnswer;
  }
  async submitConsent() {
    return ok({ id: "consent-1", expiresAt: "2027-02-01T00:00:00.000Z" });
  }
  readonly daoSetup = { file: async () => ok(request("setup")), state: async () => ok<DaoState<{ agent: string }>>({ state: "done", agent: "own-1" }) };
  readonly daoConsent = {
    file: async () => {
      this.calls.push(["daoConsent.file"]);
      return ok(request(`consent-${this.calls.length}`));
    },
    state: async () => this.daoConsentStates.shift() ?? ok<DaoState<{ consentId: string; expiresAt: string }>>({ state: "done", consentId: "c-dao", expiresAt: "2027-02-01T00:00:00.000Z" }),
  };
  readonly daoHire = {
    file: async (i: { requestId: string; validUntil: string }) => {
      this.calls.push(["daoHire.file", i.requestId]);
      // The platform answers the validUntil it filed, which may be shorter than asked: here, always 2026-11-12.
      return ok({ ...request(`hire-vote-${this.calls.length}`), validUntil: "2026-11-12T00:00:00.000Z" });
    },
    recover: async (i: DaoHireInput & { owner: string; agentId: string }): Promise<Res<FiledDaoHire>> => {
      this.calls.push(["daoHire.recover", i.requestId]);
      return this.daoHireRecoveryAnswers.shift() ?? { ok: false, kind: "refused", code: "dao_filing_recovery_unavailable" };
    },
    state: async () => this.daoHireStates.shift() ?? ok<DaoState<{ hireState: string }>>({ state: "pending" }),
  };

  agent(): MarketAgent {
    const s = this;
    return {
      async ownerPrepare(action: MarketOwnerAction, signer: "wallet" | "dao") {
        s.calls.push(["ownerPrepare", action.type, signer]);
        return s.prepareAnswers.shift() ?? { ok: false, kind: "unavailable" };
      },
      async ownerSubmit() {
        return ok({ status: "SUCCESS" });
      },
      async ownerStatus() {
        return ok({ stage: "submitted", status: "SUCCESS", failureCode: null });
      },
      async ownerPending() {
        return ok(s.pending);
      },
      async deposit() {
        return ok({ address: "deposit.near", memo: null, minAmount: "1", expiresAt: "2026-12-01T00:00:00.000Z" });
      },
      async account() {
        return ok(s.account);
      },
      async frozen() {
        return s.frozenAnswer ?? ok(s.isFrozen);
      },
      async quote(handle: string) {
        s.calls.push(["quote", handle]);
        return ok({ ...TERMS, handle });
      },
      async hire(requestId: string) {
        s.calls.push(["hire", requestId]);
        return s.hireAnswers.shift() ?? { ok: false, kind: "unknown" };
      },
      async status(requestId: string) {
        s.calls.push(["status", requestId]);
        return s.statusAnswers.shift() ?? ok({ requestId, state: "unknown", code: null, taskId: null, taskState: null, deliverable: null });
      },
    };
  }
}

export const answer = (requestId: string, state: HireAnswer["state"], extra: Partial<HireAnswer> = {}): Res<HireAnswer> =>
  ok({ requestId, state, code: null, taskId: "task-1", taskState: null, deliverable: null, ...extra });

export const registeredChain: ChainReader = { isFullAccessKey: async () => true, isRegistered: async () => true };

/** A Market on an in-memory database and the stub, with one agency at `ready` (wallet or DAO). */
export function marketWith(o: { signer?: "wallet" | "dao"; fetch?: typeof fetch; worker?: WorkerConfig | null; now?: () => Date } = {}) {
  const db = new Database(":memory:");
  const stub = new StubMarket();
  const now = o.now ?? (() => new Date("2026-11-11T12:00:00Z"));
  const m = new Market({ db, market: stub, controls: null, chain: registeredChain, api: new MarketApi("https://market.test", "aat_test", o.fetch ?? (fetch as typeof fetch)), worker: o.worker ?? null, daoPolicy: async () => null, now });
  const a = m.agencies.create({ name: "Acme", owner: o.signer === "dao" ? "council.sputnik-dao.near" : "acme.near", signer: o.signer ?? "wallet" });
  db.query("UPDATE market_agencies SET stage = 'ready', agent = 'own-1', agent_id = 'agent-id' WHERE id = ?").run(a.id);
  return { db, stub, m, agency: m.agencies.row(a.id) };
}

export { Agencies };
