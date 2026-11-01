export class ApiError extends Error {}

export async function api<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

export interface SignRequest {
  account_id?: string;
  signer?: string;
  message: string;
  nonce: string;
  recipient: string;
}

export interface Signed {
  account_id: string;
  public_key: string;
  signature: string;
  nonce: string;
  simulated?: boolean;
}

/**
 * Sign a NEP-413 message. In the simulator this uses the demo wallet on the server.
 * Live mode will call the user's wallet through near-connect (signMessage / signDelegateActions).
 */
export async function signMessage(provider: "sim" | "live", req: SignRequest): Promise<Signed> {
  const account_id = req.account_id ?? req.signer;
  if (!account_id) throw new ApiError("Missing signer account");
  if (provider === "sim") return api<Signed>("POST", "/sim/sign", { account_id, message: req.message, nonce: req.nonce, recipient: req.recipient });
  throw new ApiError("Wallet signing for mainnet lands after the Nov 2–3 spikes.");
}

/** Prepare an owner action, sign it, submit it. Returns the updated contract. */
export async function ownerAction(provider: "sim" | "live", contractId: string, type: string, payoutId?: string) {
  const prepared = await api("POST", `/contracts/${contractId}/intents`, { type, payout_id: payoutId });
  const signed = await signMessage(provider, prepared);
  return api("POST", `/intents/${prepared.correlation_id}/submit`, { public_key: signed.public_key, signature: signed.signature });
}

/** Per-browser memory of contractor links (only a convenience; safe to lose). */
export const links = {
  save(id: string, token: string) {
    try {
      localStorage.setItem(`covenant.link.${id}`, token);
    } catch {
      /* storage unavailable */
    }
  },
  get(id: string): string | null {
    try {
      return localStorage.getItem(`covenant.link.${id}`);
    } catch {
      return null;
    }
  },
};
