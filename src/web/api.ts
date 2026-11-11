import { toAtomic } from "../shared/money";
import type { AppConfig, NextStep, PayoutView, Signed, SignRequest, VoteAnswer } from "./types";
import type { WorkflowSigner } from "./wallet-signing";

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export async function api<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error ?? `Request failed (${res.status})`, res.status);
  return json as T;
}

/** Whether this browser can sign for `account` itself: only the demo wallet (fake platform or local stack). */
export function canDemoSign(config: AppConfig): boolean {
  return config.demo_controls;
}

/** The demo signer and the session's wallet signer both preserve the server-issued payload. */
export async function signMessage(config: AppConfig, req: SignRequest, walletSigner?: WorkflowSigner): Promise<Signed> {
  if (!canDemoSign(config)) {
    if (!walletSigner) throw new ApiError("Sign in with NEAR before signing this job.");
    return walletSigner(req);
  }
  return api<Signed>("POST", "/sim/sign", { account_id: req.account_id, message: req.message, nonce: req.nonce, recipient: req.recipient });
}

/** Carry out one onboarding step that needs a signature. Returns the next step. */
export async function completeStep(config: AppConfig, contractId: string, step: NextStep, walletSigner?: WorkflowSigner): Promise<NextStep | null> {
  if (step.kind === "sign") {
    const s = await signMessage(config, step.sign, walletSigner);
    return api<NextStep>("POST", `/contracts/${contractId}/onboarding/signed`, { step: step.step, nonce: step.sign.nonce, publicKey: s.public_key, signature: s.signature });
  }
  if (step.kind === "owner_step") {
    if (step.sign) {
      const s = await signMessage(config, step.sign, walletSigner);
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

export async function submitVote(config: AppConfig, v: VoteAnswer, walletSigner?: WorkflowSigner): Promise<void> {
  if (v.sign) {
    const s = await signMessage(config, v.sign, walletSigner);
    await api("POST", `/owner-steps/${v.correlation_id}/submit`, { publicKey: s.public_key, signature: s.signature });
  } else if (v.confirm && config.demo_controls) {
    await api("POST", "/sim/confirm", { url: v.confirm.url });
  }
}

/** Current links use Paperwork; legacy links remain readable without changing their private token. */
export const links = {
  save(id: string, token: string) {
    try {
      localStorage.setItem(`paperwork.link.${id}`, token);
    } catch {
      /* storage unavailable */
    }
  },
  get(id: string): string | null {
    try {
      return localStorage.getItem(`paperwork.link.${id}`) ?? localStorage.getItem(`covenant.link.${id}`);
    } catch {
      return null;
    }
  },
};
