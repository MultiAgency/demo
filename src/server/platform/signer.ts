import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { formatPublicKey, nep413Hash, nonceFromString } from "../nep413";
import type { OwnerSigner } from "./port";

/**
 * Dev-only NEP-413 signers. Never used with real money: `makePlatform` hands one out only in fake mode or against a
 * local platform stack (`stackDir`), and config refuses `stackDir` in production.
 */

/**
 * The MultiAgency platform's published, unfunded fixture key (`test/e2e/provider.mjs` `TEST_KEY`). Every account on
 * the local stack (owner, payees, builder) carries it as a full-access key, so it stands in for their wallets.
 */
export const STACK_TEST_KEY =
  "ed25519:vbKRaNtGLifEXMGHhMgHEnHyuLjX1Hb6VdEDQJ4NkARFxCcx4AYdyeLRLuLsoGbuDtwUZBHKtJkzM5RzBRafzNk";

/** A NEAR `ed25519:<base58>` secret key (64 bytes seed‖pub, or a bare 32-byte seed) as its 32-byte seed. */
export function seedOf(secretKey: string): Uint8Array {
  const raw = base58.decode(secretKey.startsWith("ed25519:") ? secretKey.slice(8) : secretKey);
  if (raw.length !== 64 && raw.length !== 32) throw new Error("An ed25519 secret key is 32 or 64 bytes");
  return raw.slice(0, 32);
}

/** One key signing NEP-413 messages: the stack's fixture key, or a throwaway one in fake mode. */
export class KeySigner implements OwnerSigner {
  readonly publicKey: string;
  private readonly seed: Uint8Array;
  constructor(seed: Uint8Array) {
    this.seed = seed;
    this.publicKey = formatPublicKey(ed25519.getPublicKey(seed));
  }
  static fromSecretKey(secretKey: string) {
    return new KeySigner(seedOf(secretKey));
  }
  static random() {
    return new KeySigner(ed25519.utils.randomSecretKey());
  }
  async sign413(p: { message: string; recipient: string; nonce: string }) {
    const hash = nep413Hash({ message: p.message, recipient: p.recipient, nonce: nonceFromString(p.nonce) });
    return { publicKey: this.publicKey, signature: base64.encode(ed25519.sign(hash, this.seed)) };
  }
}

/** The local stack's signer for any of its accounts: they all carry the fixture key. */
export function stackSigner(): KeySigner {
  return KeySigner.fromSecretKey(STACK_TEST_KEY);
}
