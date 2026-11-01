import type { KeyRegistry } from "./port";

/**
 * Live adapter over @near-intents-agent-api/sdk@0.7.3.
 *
 * Deliberately not wired yet: the exact intent standards, refusal codes, grant-expiry behaviour and
 * timelock/cancel flow are confirmed by spikes SP0-SP4 on Nov 2-3 (see docs/spikes.md) before any
 * live code is written. config.ts refuses PROVIDER=live until this file exports `createLiveProvider`.
 */
export const LIVE_PROVIDER_READY = false;

/** Full-access key check over NEAR RPC (view_access_key). Used by the live provider and term signing. */
export class RpcKeyRegistry implements KeyRegistry {
  constructor(private rpcUrl = "https://rpc.mainnet.fastnear.com") {}

  async isFullAccessKey(accountId: string, publicKey: string): Promise<boolean> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "covenant",
        method: "query",
        params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey },
      }),
    });
    if (!res.ok) throw new Error(`NEAR RPC returned ${res.status}`);
    const body = (await res.json()) as { result?: { permission?: unknown }; error?: unknown };
    return body.result?.permission === "FullAccess";
  }
}
