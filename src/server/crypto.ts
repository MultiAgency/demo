import { base64 } from "@scure/base";
import { hexToBytes } from "@noble/hashes/utils.js";

/** AES-256-GCM for secrets at rest (the grant credential). */
export class SecretBox {
  private constructor(private key: CryptoKey) {}

  static async fromHex(hex: string): Promise<SecretBox> {
    const raw = hexToBytes(hex);
    if (raw.length !== 32) throw new Error("SECRET_KEY must be 32 bytes of hex (64 characters)");
    return new SecretBox(await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  }

  static async random(): Promise<SecretBox> {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    return new SecretBox(await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  }

  async seal(plain: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, new TextEncoder().encode(plain)));
    return `v1.${base64.encode(iv)}.${base64.encode(ct)}`;
  }

  async open(sealed: string): Promise<string> {
    const [v, iv, ct] = sealed.split(".");
    if (v !== "v1" || !iv || !ct) throw new Error("Unknown sealed format");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(base64.decode(iv)) },
      this.key,
      new Uint8Array(base64.decode(ct)),
    );
    return new TextDecoder().decode(plain);
  }
}
