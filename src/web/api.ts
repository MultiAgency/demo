import { toAtomic } from "../shared/money";
import { fixtureApi, fixturesOn } from "./fixtures"; // TEMPORARY (M3): remove with fixtures.ts
import type { AppConfig, NextStep, PayoutView, Signed, SignRequest, VoteAnswer } from "./types";

export class ApiError extends Error {}

export async function api<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (fixturesOn()) return fixtureApi<T>(method, path, body); // TEMPORARY (M3)
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

/** Whether this browser can sign for `account` itself: only the demo wallet (fake platform or local stack). */
export function canDemoSign(config: AppConfig): boolean {
  return config.demo_controls;
}

/**
 * Sign a NEP-413 message. With demo controls the server's demo wallet signs. Wallet signing in remote
 * mode is out this week: the UI shows the message to sign instead (see SignMessage in components).
 */
export async function signMessage(config: AppConfig, req: SignRequest): Promise<Signed> {
  if (!canDemoSign(config)) throw new ApiError(`Sign this message as ${req.account_id} with your NEAR wallet.`);
  return api<Signed>("POST", "/sim/sign", { account_id: req.account_id, message: req.message, nonce: req.nonce, recipient: req.recipient });
}

/** Carry out one onboarding step that needs a signature. Returns the next step. */
export async function completeStep(config: AppConfig, contractId: string, step: NextStep): Promise<NextStep | null> {
  if (step.kind === "sign") {
    const s = await signMessage(config, step.sign);
    return api<NextStep>("POST", `/contracts/${contractId}/onboarding/signed`, { step: step.step, nonce: step.sign.nonce, publicKey: s.public_key, signature: s.signature });
  }
  if (step.kind === "owner_step") {
    if (step.sign) {
      const s = await signMessage(config, step.sign);
      await api("POST", `/owner-steps/${step.correlation_id}/submit`, { publicKey: s.public_key, signature: s.signature });
    } else if (step.confirm && config.demo_controls) {
      await api("POST", "/sim/confirm", { url: step.confirm.url });
    }
    return api<NextStep>("POST", `/contracts/${contractId}/onboarding/next`);
  }
  return api<NextStep>("POST", `/contracts/${contractId}/onboarding/next`);
}

/** Do the proven terms the platform returned for an approval match this payout? */
export function termsMatch(p: PayoutView, t: VoteAnswer["terms"], usdc: string): boolean {
  if (!t) return false;
  const amountOk = t.amount === p.amount_usd || t.amount === toAtomic(p.amount_usd, 6).toString();
  return t.recipient === p.recipient && t.asset === usdc && amountOk && (t.chain === undefined || t.chain === "near");
}

/** Prepare a vote; for approve, refuse to sign unless the platform's proven terms match the payout. */
export async function prepareVote(rid: string, verdict: "approve" | "reject"): Promise<VoteAnswer> {
  return api<VoteAnswer>("POST", `/payouts/${rid}/vote`, { verdict });
}

export async function submitVote(config: AppConfig, v: VoteAnswer): Promise<void> {
  if (v.sign) {
    const s = await signMessage(config, v.sign);
    await api("POST", `/owner-steps/${v.correlation_id}/submit`, { publicKey: s.public_key, signature: s.signature });
  } else if (v.confirm && config.demo_controls) {
    await api("POST", "/sim/confirm", { url: v.confirm.url });
  }
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
