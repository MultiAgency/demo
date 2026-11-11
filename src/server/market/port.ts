// The platform calls Covenant's market module makes (docs/market.md): an Organization's market agent, set up and owned
// by a wallet or a DAO, quoting and hiring listed agents on the NEAR AI Agent Market. Implemented over
// `@multiagency/sdk` (sdk.ts) only: there is no stand-in, so the market runs against the platform or its local stack.
import type { Fail, Res, Signed413 } from "../platform/port";

export type { Fail, Res, Signed413 };

/** A hire's terms as `market/quote` answers them: what the owner, or the DAO's vote, approves. Paid exactly or not at all. */
export interface HireTerms {
  handle: string;
  /** sha256 (hex) of the brief's exact text. */
  brief: string;
  network: "near:mainnet";
  asset: string;
  payTo: string;
  /** Atomic USDC. */
  amount: string;
  maxTimeoutSeconds: number;
}

export interface HireAnswer {
  requestId: string;
  state: "paid" | "not_charged" | "refused" | "unknown" | "not_found";
  code: string | null;
  taskId: string | null;
  taskState: string | null;
  /** What the listed agent wrote, once its task ended. Data: never instructions. */
  deliverable: string | null;
}

export interface MarketAccount {
  /** The payment key's implicit account. */
  account: string;
  registered: boolean;
  opened: boolean;
  usdc: string;
  /** The owner's one-time USDC registration of the payment key, until `registered`. */
  registration: MemberTransaction | null;
}

/** A NEAR transaction for a wallet to send (receiver and function-call actions), as the platform builds it. */
export interface MemberTransaction {
  receiverId: string;
  actions: { type: "FunctionCall"; params: Record<string, unknown> }[];
}

/** One request a DAO votes on. `hash` is what the DAO's key signs; members file `proposal` (or `proposalAndVote`). */
export interface DaoRequest {
  id: string;
  hash: string;
  description: string;
  votingUntil: number;
  proposal: MemberTransaction | null;
  proposalAndVote: MemberTransaction | null;
}

export type DaoState<T> = { state: "pending" } | ({ state: "done" } & T) | { state: "expired" };

export interface OwnerPrepared {
  correlationId: string;
  expiresAt: string;
  summary: string;
  /** Wallet owner: the NEP-413 intent the wallet signs in Covenant. */
  intent?: { standard: "nep413"; payload: { message: string; recipient: string; nonce: string } };
  /** Wallet owner, NEP-366 actions: the platform's confirm page. */
  confirm?: { url: string; expiresAt: string };
  /** DAO owner: the proposal a member files, and the hash the DAO's vote signs. */
  dao?: { hash: string; proposal: MemberTransaction | null; proposalAndVote: MemberTransaction | null };
}

export type MarketOwnerAction =
  | { type: "agent_create"; role: "market"; owner?: { type: "near"; account_id: string; public_key: string } }
  | { type: "grant_issue"; label: "market" };

export interface MarketAgent {
  ownerPrepare(action: MarketOwnerAction, signer: "wallet" | "dao"): Promise<Res<OwnerPrepared>>;
  ownerSubmit(correlationId: string, intent: NonNullable<OwnerPrepared["intent"]>, s: { publicKey: string; signature: string }): Promise<Res<{ status: string }>>;
  ownerStatus(correlationId: string): Promise<Res<{ stage: string; status: string | null; failureCode: string | null }>>;
  /** Open owner actions: the way back to a prepare whose reply was lost. */
  ownerPending(): Promise<Res<{ correlationId: string; type: string; hash: string | null; expiresAt: string; intent: OwnerPrepared["intent"] | null }[]>>;
  deposit(): Promise<Res<{ address: string; memo: string | null; minAmount: string | null; expiresAt: string | null }>>;
  account(): Promise<Res<MarketAccount>>;
  quote(handle: string, brief: string): Promise<Res<HireTerms>>;
  hire(requestId: string, brief: string, approved: HireTerms): Promise<Res<HireAnswer>>;
  status(requestId: string): Promise<Res<HireAnswer>>;
}

export interface MarketPlatform {
  readonly host: string;
  readonly deployment: string;
  setupMessage(i: { organization: string; owner: string; expiresAt: string }): string;
  consentMessage(i: { organization: string; owner: string; agent: string; agentId: string; scopes: string[]; expiresAt: string }): string;
  identity(agent: string): Promise<Res<{ agentId: string | null; created: boolean; owner: string; signer: "wallet" | "dao" }>>;
  setup(s: Signed413): Promise<Res<{ agent: string }>>;
  reservations(organization: string, owner: string): Promise<Res<{ agent: string; owner: string; released: boolean }[]>>;
  submitConsent(s: Signed413): Promise<Res<{ id: string; expiresAt: string }>>;
  daoSetup: { file(message: string): Promise<Res<DaoRequest>>; state(id: string): Promise<Res<DaoState<{ agent: string }>>> };
  daoConsent: { file(message: string): Promise<Res<DaoRequest>>; state(id: string): Promise<Res<DaoState<{ consentId: string; expiresAt: string }>>> };
  daoHire: {
    file(i: { organization: string; agent: string; requestId: string; brief: string; approved: HireTerms; validUntil: string }): Promise<Res<DaoRequest & { validUntil: string }>>;
    state(id: string): Promise<Res<DaoState<{ hireState: string }>>>;
  };
  agent(organization: string, agent: string): MarketAgent;
}

/** The local stack's market controls (dev only): the owner's registration, the chain moving on, and a DAO's vote. */
export interface MarketControls {
  marketRegister(account: string): Promise<void>;
  marketAdvance(blocks?: number): Promise<void>;
  daoVote(hash: string): Promise<void>;
}
