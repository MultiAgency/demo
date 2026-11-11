import { nonceFromString, nonceToString, verifyNep413 } from "../shared/nep413";
import type { Signed, SignRequest } from "./types";

export type WorkflowSigner = (req: SignRequest) => Promise<Signed>;

export interface WalletSigningSession {
  account: string | null;
  loading: boolean;
  version: number;
}

type Network = "mainnet" | "testnet";
interface WalletState { accountId: string | null; publicKey: string | null; networkId: string }
interface MessagePayload { message: string; recipient: string; nonce: Uint8Array }

/** Only the installed client's wallet-message APIs are exposed: no sends, relays or key import. */
export interface WalletSigningDependencies {
  near: {
    ensureConnected: () => Promise<boolean>;
    getState: () => WalletState | null;
    isWalletConnected: () => boolean;
    getNetwork: () => Network;
    getNearClient: (network: Network) => {
      signMessage: (payload: MessagePayload, options?: { signerId?: string }) => Promise<unknown>;
    };
  };
  session: () => WalletSigningSession;
  readAccount: () => Promise<string | null>;
  network: Network;
  /** A timed-out request stays guarded until its underlying wallet/read promise has settled. */
  timeoutMs?: number;
}

class SigningError extends Error {}
function refuse(message: string): never { throw new SigningError(message); }

/** One explicit, account-bound NEP-413 prompt. Returning a signature never submits or settles anything. */
export class WorkflowWalletSigner {
  private pending = false;
  private readonly timeoutMs: number;
  constructor(private readonly deps: WalletSigningDependencies) {
    this.timeoutMs = deps.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647)
      refuse("The wallet signing deadline is invalid. Reload the app before signing.");
  }

  sign: WorkflowSigner = async (req) => {
    if (this.pending) refuse("A wallet signing request is already open. Finish or cancel it before trying again.");
    this.pending = true;
    const deadline = { expired: false, at: Date.now() + this.timeoutMs };
    let timer: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        deadline.expired = true;
        reject(new SigningError("Wallet signing timed out. Finish or cancel the open request before trying again."));
      }, this.timeoutMs);
    });
    const work = this.perform(req, deadline).finally(() => {
      clearTimeout(timer);
      this.pending = false;
    });
    // The deadline can settle the caller, but cannot release a still-open prompt or use its late signature.
    return Promise.race([work, timedOut]);
  };

  private async perform(req: SignRequest, deadline: { expired: boolean; at: number }): Promise<Signed> {
    try {
      // Snapshot strings before any await, so a changed caller object cannot change the signed request.
      const request = Object.freeze({ account_id: req.account_id, message: req.message, recipient: req.recipient, nonce: req.nonce });
      let nonce: Uint8Array;
      try {
        nonce = nonceFromString(request.nonce);
        if (nonceToString(nonce) !== request.nonce) refuse("This signing request has an invalid nonce. Reload the work order before signing.");
      } catch { refuse("This signing request has an invalid nonce. Reload the work order before signing."); }
      if (![request.account_id, request.message, request.recipient].every((value) => typeof value === "string" && value.trim().length > 0))
        refuse("This signing request is incomplete. Reload the work order before signing.");

      this.assertDeadline(deadline);
      const initial = { ...this.deps.session() };
      this.assertSession(initial, request.account_id);
      this.assertNetwork();
      await this.checkAccount(request.account_id, deadline);
      this.assertSession(initial, request.account_id);
      this.assertNetwork();

      let connected: boolean;
      try { connected = await this.deps.near.ensureConnected(); }
      catch { this.assertDeadline(deadline); refuse("Wallet connection was cancelled or unavailable. Reconnect your NEAR wallet and try again."); }
      this.assertDeadline(deadline);
      if (!connected) refuse("Wallet connection was cancelled. Connect your NEAR wallet before signing.");
      this.assertSession(initial, request.account_id);
      this.assertNetwork();
      const before = this.assertWallet(request.account_id);

      let result: unknown;
      try {
        result = await this.deps.near.getNearClient(this.deps.network).signMessage({
          message: request.message,
          recipient: request.recipient,
          // Give the wallet its own array; verification retains the original nonce bytes.
          nonce: new Uint8Array(nonce),
        }, { signerId: request.account_id });
      } catch {
        this.assertDeadline(deadline);
        // near-kit can mask a rejection as NO_KEY_FOUND. No key fallback or automatic retry is added here.
        refuse("Wallet signing was cancelled or unavailable. Reconnect your NEAR wallet and try again.");
      }
      this.assertDeadline(deadline);
      if (!result || typeof result !== "object") refuse("The wallet returned no usable signature. Reconnect your NEAR wallet and try again.");
      const signed = result as { accountId?: unknown; publicKey?: unknown; signature?: unknown };
      if (typeof signed.accountId !== "string" || typeof signed.publicKey !== "string" || typeof signed.signature !== "string" || !signed.publicKey || !signed.signature)
        refuse("The wallet returned no usable signature. Reconnect your NEAR wallet and try again.");
      if (signed.accountId !== request.account_id) refuse(`The wallet signed as another account. Connect ${request.account_id} and review the request again.`);
      if (signed.publicKey.includes(":") && !signed.publicKey.startsWith("ed25519:")) refuse("This workflow requires an ed25519 NEAR wallet signature.");
      if (!verifyNep413({ message: request.message, recipient: request.recipient, nonce }, { public_key: signed.publicKey, signature: signed.signature }))
        refuse("The wallet signature does not match this request. Reload the work order and try again.");

      this.assertSession(initial, request.account_id);
      this.assertNetwork();
      this.assertWallet(request.account_id, signed.publicKey, before.publicKey);
      await this.checkAccount(request.account_id, deadline);
      // The session or wallet may also change while the final authenticated read is pending.
      this.assertSession(initial, request.account_id);
      this.assertNetwork();
      this.assertWallet(request.account_id, signed.publicKey, before.publicKey);
      this.assertDeadline(deadline);
      return { account_id: signed.accountId, public_key: signed.publicKey, signature: signed.signature, nonce: request.nonce };
    } catch (error) {
      if (error instanceof SigningError) throw error;
      throw new SigningError("The wallet is unavailable. Reconnect your NEAR wallet and review the request again.");
    }
  }

  private assertDeadline(deadline: { expired: boolean; at: number }) {
    if (deadline.expired || Date.now() >= deadline.at) {
      deadline.expired = true;
      refuse("Wallet signing timed out. Finish or cancel the open request before trying again.");
    }
  }

  private assertSession(initial: WalletSigningSession, expected: string) {
    const current = this.deps.session();
    if (initial.loading || !initial.account || initial.account !== expected || !Number.isSafeInteger(initial.version))
      refuse(`Sign in as ${expected} and wait for sign-in to finish before signing.`);
    if (current.loading || current.account !== expected || current.version !== initial.version)
      refuse("Your sign-in changed while signing. Review this request and try again.");
  }

  private assertNetwork() {
    if (this.deps.near.getNetwork() !== this.deps.network) refuse(`Switch your NEAR wallet to ${this.deps.network} before signing.`);
  }

  private assertWallet(expected: string, signedKey?: string, beforeKey?: string | null): WalletState {
    if (!this.deps.near.isWalletConnected()) refuse("Your wallet disconnected. Reconnect it before signing.");
    const state = this.deps.near.getState();
    if (!state || state.accountId !== expected) refuse(`Connect the NEAR wallet for ${expected} before signing.`);
    if (state.networkId !== this.deps.network) refuse(`Switch your NEAR wallet to ${this.deps.network} before signing.`);
    if (signedKey && ((state.publicKey && state.publicKey !== signedKey) || (beforeKey && beforeKey !== signedKey)))
      refuse("The active wallet key changed while signing. Reconnect the expected wallet and review this request again.");
    return { ...state };
  }

  private async checkAccount(expected: string, deadline: { expired: boolean; at: number }) {
    let account: string | null;
    try { account = await this.deps.readAccount(); }
    catch { this.assertDeadline(deadline); refuse("Your session could not be verified. Sign in again before signing."); }
    this.assertDeadline(deadline);
    if (account !== expected) refuse(`Your session is no longer signed in as ${expected}. Sign in again before signing.`);
  }
}
