import { ed25519 } from "@noble/curves/ed25519.js";
import { base64 } from "@scure/base";
import { formatPublicKey, nep413Hash, type Nep413Payload, type SignedMessage } from "../shared/nep413";
export * from "../shared/nep413";

/**
 * Simulated wallet for the keyless demo only. Holds throwaway keys generated at boot.
 * config.ts refuses to start PROVIDER=live while this is enabled.
 */
export class DevWallet {
  private keys = new Map<string, Uint8Array>();

  addAccount(accountId: string): string {
    const sk = ed25519.utils.randomSecretKey();
    this.keys.set(accountId, sk);
    return formatPublicKey(ed25519.getPublicKey(sk));
  }

  has(accountId: string): boolean {
    return this.keys.has(accountId);
  }

  accounts(): { account_id: string; public_key: string }[] {
    return [...this.keys].map(([account_id, sk]) => ({ account_id, public_key: formatPublicKey(ed25519.getPublicKey(sk)) }));
  }

  sign(accountId: string, payload: Nep413Payload): SignedMessage {
    const sk = this.keys.get(accountId);
    if (!sk) throw new Error(`The demo wallet has no key for ${accountId}`);
    return {
      account_id: accountId,
      public_key: formatPublicKey(ed25519.getPublicKey(sk)),
      signature: base64.encode(ed25519.sign(nep413Hash(payload), sk)),
    };
  }
}
