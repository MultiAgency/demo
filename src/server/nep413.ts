import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";

/**
 * NEP-413 off-chain message signing (https://github.com/near/NEPs/blob/master/neps/nep-0413.md).
 * signature = ed25519(sha256(borsh(u32 tag) ++ borsh({message, nonce[32], recipient, callbackUrl?})))
 */
const NEP413_TAG = 2 ** 31 + 413;

export interface Nep413Payload {
  message: string;
  nonce: Uint8Array; // exactly 32 bytes
  recipient: string;
  callbackUrl?: string | null;
}

export interface SignedMessage {
  account_id: string;
  public_key: string; // "ed25519:<base58>"
  signature: string; // base64 (wallet standard); base58 or "ed25519:<base58>" also accepted
}

export function nep413Hash(p: Nep413Payload): Uint8Array {
  if (p.nonce.length !== 32) throw new Error("NEP-413 nonce must be 32 bytes");
  const parts: Uint8Array[] = [u32(NEP413_TAG), str(p.message), p.nonce, str(p.recipient)];
  parts.push(p.callbackUrl ? concat([new Uint8Array([1]), str(p.callbackUrl)]) : new Uint8Array([0]));
  return sha256(concat(parts));
}

export function verifyNep413(payload: Nep413Payload, signed: Pick<SignedMessage, "public_key" | "signature">): boolean {
  try {
    const pk = parsePublicKey(signed.public_key);
    const sig = parseSignature(signed.signature);
    return ed25519.verify(sig, nep413Hash(payload), pk);
  } catch {
    return false;
  }
}

export function parsePublicKey(key: string): Uint8Array {
  const [curve, data] = key.includes(":") ? key.split(":") : ["ed25519", key];
  if (curve !== "ed25519" || !data) throw new Error("Only ed25519 keys are supported");
  const bytes = base58.decode(data);
  if (bytes.length !== 32) throw new Error("Bad ed25519 public key length");
  return bytes;
}

export function parseSignature(sig: string): Uint8Array {
  const raw = sig.startsWith("ed25519:") ? sig.slice(8) : sig;
  for (const decode of [(s: string) => base64.decode(s), (s: string) => base58.decode(s)]) {
    try {
      const bytes = decode(raw);
      if (bytes.length === 64) return bytes;
    } catch {
      // try the next encoding
    }
  }
  throw new Error("Signature is not a 64-byte base64 or base58 value");
}

export function formatPublicKey(pk: Uint8Array): string {
  return `ed25519:${base58.encode(pk)}`;
}

export function randomNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function nonceToString(nonce: Uint8Array): string {
  return base64.encode(nonce);
}

export function nonceFromString(nonce: string): Uint8Array {
  const bytes = base64.decode(nonce);
  if (bytes.length !== 32) throw new Error("Nonce must be 32 bytes, base64");
  return bytes;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function str(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return concat([u32(bytes.length), bytes]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

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
