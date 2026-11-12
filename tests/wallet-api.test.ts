import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api, completeStep, signMessage, submitVote } from "../src/web/api";
import type { AppConfig, NextStep, Signed, SignRequest, VoteAnswer } from "../src/web/types";

// HTTP/signing-port wiring only. No wallet, RPC, hosted service or real fetch is invoked.
const remote: AppConfig = {
  platform: "remote", stack: false, host: "platform.invalid", demo_controls: false, demo_accounts: null,
  now: "2026-11-11T12:00:00.000Z", judge: { kind: "rules", model: null },
  auth: { required: true, recipient: "siwn.invalid", network: "mainnet" },
  market: { enabled: false, worker: false, owner: null, dao: null },
};
const originalNonce = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => [0, 1, 127, 128, 255][i % 5]!)).toString("base64");
const request: SignRequest = {
  account_id: "agency.demo", message: "Paperwork terms sha256:fixture\nKeep the exact message.",
  recipient: "multiagency-paperwork", nonce: originalNonce,
};
const signed: Signed = { account_id: "agency.demo", public_key: "fixture-public-key", signature: "fixture-signature", nonce: originalNonce };
const onboarding: NextStep = { kind: "sign", step: "consent_owner", label: "Consent", sign: { ...request, recipient: "platform.invalid" } };
const ownerStep: NextStep = {
  kind: "owner_step", correlation_id: "owner-step-original", action: "grant_issue", label: "Issue grant", summary: "Original prepared grant",
  sign: { ...request, recipient: "platform.invalid", message: "Sign the original prepared intent." },
};
const vote: VoteAnswer = {
  correlation_id: "approval-original", sign: { ...request, recipient: "platform.invalid", message: "approve:original-payment:fixture-hash" },
  terms: { recipient: "builder.demo", asset: "fixture-usdc", amount: "300000000", chain: "near" }, flags: [],
};
interface Call { path: string; method: string; body: unknown }
let originalFetch: typeof fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

function fetchRecorder(handler: (call: Call) => Response | Promise<Response> = () => Response.json({ kind: "done" })) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      path: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return calls;
}
function signerRecorder(result: Signed = signed) {
  const requests: SignRequest[] = [];
  return { requests, sign: async (req: SignRequest) => { requests.push(structuredClone(req)); return result; } };
}

describe("workflow API helpers — injected wallet and HTTP fixtures", () => {
  test("remote message signing forwards the exact server-issued request without a demo endpoint", async () => {
    const calls = fetchRecorder();
    const wallet = signerRecorder();
    expect(await signMessage(remote, request, wallet.sign)).toEqual(signed);
    expect(wallet.requests).toEqual([request]);
    expect(wallet.requests[0]!.nonce).toBe(originalNonce);
    expect(wallet.requests[0]!.recipient).toBe("multiagency-paperwork");
    expect(wallet.requests[0]!.recipient).not.toBe(remote.auth.recipient);
    expect(calls).toEqual([]);
  });

  test("onboarding submits the original step and nonce with the injected signature", async () => {
    const calls = fetchRecorder();
    // The prepared step owns its nonce; a signer result must not replace that protocol identity.
    const wallet = signerRecorder({ ...signed, nonce: "not-the-server-issued-nonce" });
    expect(await completeStep(remote, "contract-original", onboarding, wallet.sign)).toEqual({ kind: "done" });
    expect(wallet.requests).toEqual([onboarding.sign]);
    expect(calls).toEqual([{
      path: "/api/contracts/contract-original/onboarding/signed", method: "POST",
      body: { step: "consent_owner", nonce: originalNonce, publicKey: signed.public_key, signature: signed.signature },
    }]);
  });

  test("a readable owner step submits its original correlation, then observes the next step", async () => {
    const calls = fetchRecorder();
    const wallet = signerRecorder();
    await completeStep(remote, "contract-original", ownerStep, wallet.sign);
    expect(wallet.requests).toEqual([ownerStep.sign!]);
    expect(calls).toEqual([
      { path: "/api/owner-steps/owner-step-original/submit", method: "POST", body: { publicKey: signed.public_key, signature: signed.signature } },
      { path: "/api/contracts/contract-original/onboarding/next", method: "POST", body: undefined },
    ]);
    expect(calls.some((c) => c.path.includes("/sim/"))).toBe(false);
  });

  test("an approval uses the original prepared vote and correlation even when a confirm link also exists", async () => {
    const calls = fetchRecorder(() => Response.json({ state: "submitted" }));
    const wallet = signerRecorder();
    await submitVote(remote, { ...vote, confirm: { url: "https://platform.invalid/confirm/original", expires_at: "2026-11-11T12:10:00Z" } }, wallet.sign);
    expect(wallet.requests).toEqual([vote.sign!]);
    expect(calls).toEqual([{
      path: "/api/owner-steps/approval-original/submit", method: "POST", body: { publicKey: signed.public_key, signature: signed.signature },
    }]);
  });

  test("missing wallet signer fails before any remote signing or submission request", async () => {
    const calls = fetchRecorder();
    await expect(signMessage(remote, request)).rejects.toThrow("Sign in");
    await expect(completeStep(remote, "contract-original", onboarding)).rejects.toThrow("Sign in");
    await expect(submitVote(remote, vote)).rejects.toThrow("Sign in");
    expect(calls).toEqual([]);
  });

  test("cancellation and identity/network refusals propagate without a workflow POST", async () => {
    const calls = fetchRecorder();
    for (const message of ["Wallet cancelled", "Connected account does not match agency.demo", "Wallet network does not match mainnet"]) {
      let signatures = 0;
      const rejectingSigner = async (_req: SignRequest): Promise<Signed> => { signatures++; throw new Error(message); };
      await expect(signMessage(remote, request, rejectingSigner)).rejects.toThrow(message);
      await expect(completeStep(remote, "contract-original", onboarding, rejectingSigner)).rejects.toThrow(message);
      await expect(submitVote(remote, vote, rejectingSigner)).rejects.toThrow(message);
      expect(signatures).toBe(3);
    }
    expect(calls).toEqual([]);
  });

  test("a confirm-only owner action cannot invoke wallet signing, owner submission or demo controls", async () => {
    const calls = fetchRecorder();
    const wallet = signerRecorder();
    const confirm = { url: "https://platform.invalid/confirm/nep366-original", expires_at: "2026-11-11T12:10:00Z" };
    await completeStep(remote, "contract-original", {
      kind: "owner_step", correlation_id: "nep366-original", action: "agent_create", label: "Create agent", summary: "Sign on platform", confirm,
    }, wallet.sign);
    // It can read/prepare the existing onboarding view; it never signs or submits the NEP-366 action itself.
    expect(calls).toEqual([{ path: "/api/contracts/contract-original/onboarding/next", method: "POST", body: undefined }]);
    calls.length = 0;
    await submitVote(remote, { correlation_id: "confirm-vote-original", confirm, terms: null, flags: [] }, wallet.sign);
    expect(wallet.requests).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a lost approval-submit response is not replayed and the original correlation remains readable", async () => {
    let submitted = false;
    const calls = fetchRecorder((call) => {
      if (call.method === "POST") {
        expect(call.path).toBe("/api/owner-steps/approval-original/submit");
        submitted = true;
        throw new TypeError("Fixture response lost after submit");
      }
      expect(call.path).toBe("/api/owner-steps/approval-original");
      return Response.json({ correlation_id: "approval-original", kind: "approval_vote", state: submitted ? "submitted" : "prepared", request_id: "payout-original", verdict: "approve" });
    });
    const wallet = signerRecorder();
    await expect(submitVote(remote, vote, wallet.sign)).rejects.toThrow("response lost");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    const observed = await api<{ correlation_id: string; state: string; request_id: string }>("GET", `/owner-steps/${vote.correlation_id}`);
    expect(observed).toMatchObject({ correlation_id: "approval-original", state: "submitted", request_id: "payout-original" });
    expect(wallet.requests).toHaveLength(1);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  test("a lost owner-step submit response does not advance or sign another onboarding identity", async () => {
    const calls = fetchRecorder((call) => {
      if (call.method === "POST") throw new TypeError("Fixture grant reply lost after submit");
      return Response.json({ correlation_id: "owner-step-original", state: "submitted", kind: "grant_issue" });
    });
    const wallet = signerRecorder();
    await expect(completeStep(remote, "contract-original", ownerStep, wallet.sign)).rejects.toThrow("reply lost");
    expect(calls).toEqual([{
      path: "/api/owner-steps/owner-step-original/submit", method: "POST", body: { publicKey: signed.public_key, signature: signed.signature },
    }]);
    expect(wallet.requests).toEqual([ownerStep.sign!]);
    expect(await api("GET", "/owner-steps/owner-step-original")).toMatchObject({ correlation_id: "owner-step-original", state: "submitted" });
    expect(calls.some((c) => c.path.endsWith("/onboarding/next"))).toBe(false);
    expect(wallet.requests).toHaveLength(1);
  });
});
