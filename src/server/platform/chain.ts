import { REGISTRATION_GAS, type RegistrationQuote } from "../../shared/registration";
import type { ChainReader } from "./port";

/** A NEP-141 asset id (`nep141:<contract>`) as its token contract account. */
export function tokenContract(token: string): string {
  return token.startsWith("nep141:") ? token.slice("nep141:".length) : token;
}

/**
 * NEAR JSON-RPC reads: whether a key is a full-access key of an account (to check a term signature's key), and whether
 * an account is registered on a token (NEP-145 `storage_balance_of`), which a withdrawal's recipient must be.
 * In remote mode against the local stack, `rpcUrl` is `state.chain.rpc` (the stack's simulated chain).
 */
export class RpcChain implements ChainReader {
  private id = 0;
  constructor(
    private readonly rpcUrl: string,
    private readonly send: typeof fetch = fetch,
  ) {}

  private async query(params: Record<string, unknown>): Promise<{ result?: any; error?: any }> {
    const res = await this.send(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: `paperwork-${++this.id}`, method: "query", params: { finality: "final", ...params } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`RPC answered ${res.status}`);
    return (await res.json()) as { result?: any; error?: any };
  }

  async isFullAccessKey(account: string, publicKey: string): Promise<boolean> {
    try {
      const { result, error } = await this.query({ request_type: "view_access_key", account_id: account, public_key: publicKey });
      if (error || !result) return false;
      return result.permission === "FullAccess";
    } catch {
      return false;
    }
  }

  async registrationQuote(token: string, account: string): Promise<RegistrationQuote> {
    const call = async (method: string, args: object) => {
      const { result, error } = await this.query({ request_type: "call_function", account_id: tokenContract(token), method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
      if (error || !Array.isArray(result?.result)) throw new Error("Token registration could not be verified. Try checking again.");
      return JSON.parse(Buffer.from(result.result).toString());
    };
    const balance = await call("storage_balance_of", { account_id: account });
    const registered = balance !== null;
    if (registered && (typeof balance?.total !== "string" || !/^\d+$/.test(balance.total) || BigInt(balance.total) <= 0n))
      throw new Error("The token returned an invalid storage balance.");
    if (registered) return { account, token: tokenContract(token), registered: true, deposit_yocto: "0", gas: REGISTRATION_GAS, gas_estimate_yocto: "0", expires_at: new Date(Date.now() + 60_000).toISOString() };
    const bounds = await call("storage_balance_bounds", {});
    if (!registered && (typeof bounds?.min !== "string" || !/^\d+$/.test(bounds.min) || BigInt(bounds.min) <= 0n))
      throw new Error("The token returned an invalid storage minimum.");
    const res = await this.send(this.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: `paperwork-${++this.id}`, method: "gas_price", params: [null] }), signal: AbortSignal.timeout(10_000) });
    const price = await res.json() as { result?: { gas_price?: string } };
    const gasPrice = price.result?.gas_price;
    if (!res.ok || typeof gasPrice !== "string" || !/^\d+$/.test(gasPrice) || BigInt(gasPrice) <= 0n) throw new Error("Gas cost could not be quoted. Try checking again.");
    return { account, token: tokenContract(token), registered, deposit_yocto: registered ? "0" : bounds.min, gas: REGISTRATION_GAS, gas_estimate_yocto: (BigInt(gasPrice) * BigInt(REGISTRATION_GAS)).toString(), expires_at: new Date(Date.now() + 60_000).toISOString() };
  }

  async isRegistered(token: string, account: string): Promise<boolean | null> {
    try {
      const args = Buffer.from(JSON.stringify({ account_id: account })).toString("base64");
      const { result, error } = await this.query({
        request_type: "call_function",
        account_id: tokenContract(token),
        method_name: "storage_balance_of",
        args_base64: args,
      });
      if (error || !result || !Array.isArray(result.result)) return null;
      const value = JSON.parse(Buffer.from(result.result as number[]).toString() || "null");
      return value !== null;
    } catch {
      return null;
    }
  }
}

/**
 * The fake chain: full-access keys and token registrations held in memory. Replaces the old `SimKeyRegistry`.
 * Accounts are registered on every token unless marked otherwise, as most NEAR accounts holding USDC are.
 */
export class SimChain implements ChainReader {
  private keys = new Map<string, Set<string>>();
  private unregistered = new Set<string>();
  private unknownAccounts = new Set<string>();
  private everywhere = new Set<string>();

  /**
   * `publicKey` is a full-access key of every account, as the platform stack's fixture key is on all its accounts. The
   * fake's dev signer uses one key for the owner and the contractor alike.
   */
  trustKey(publicKey: string): void {
    this.everywhere.add(publicKey);
  }
  /** `publicKey` is no longer a key of `account` (a removed key ends the consents it signed). */
  removeKey(account: string, publicKey: string): void {
    this.keys.get(account)?.delete(publicKey);
    this.removed.add(`${account}\n${publicKey}`);
  }
  private removed = new Set<string>();

  /** `publicKey` becomes a full-access key of `account`. */
  addKey(account: string, publicKey: string): void {
    this.removed.delete(`${account}\n${publicKey}`);
    const set = this.keys.get(account) ?? new Set<string>();
    set.add(publicKey);
    this.keys.set(account, set);
  }
  /** Mark `account` (not) registered on every token. */
  setRegistered(account: string, registered: boolean): void {
    if (registered) this.unregistered.delete(account);
    else this.unregistered.add(account);
  }
  /** Mark `account` as not existing on NEAR (`recipient_not_found`). */
  setMissing(account: string, missing: boolean): void {
    if (missing) this.unknownAccounts.add(account);
    else this.unknownAccounts.delete(account);
  }
  exists(account: string): boolean {
    return !this.unknownAccounts.has(account);
  }

  async isFullAccessKey(account: string, publicKey: string): Promise<boolean> {
    if (this.removed.has(`${account}\n${publicKey}`)) return false;
    return this.everywhere.has(publicKey) || (this.keys.get(account)?.has(publicKey) ?? false);
  }
  async isRegistered(_token: string, account: string): Promise<boolean | null> {
    if (!this.exists(account)) return false;
    return !this.unregistered.has(account);
  }
}
