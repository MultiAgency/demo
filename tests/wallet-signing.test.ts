import { expect, test } from "bun:test";
import { DevWallet } from "../src/server/nep413";
import { nonceFromString, nonceToString, verifyNep413 } from "../src/shared/nep413";
import { WorkflowWalletSigner, type WalletSigningDependencies, type WalletSigningSession } from "../src/web/wallet-signing";
import type { SignRequest } from "../src/web/types";

type Network = "mainnet" | "testnet";
type Payload = { message: string; recipient: string; nonce: Uint8Array };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Actual NEP-413 signatures from throwaway offline keys; these fixtures never connect a real wallet. */
function fixture(timeoutMs?: number) {
  const account = "agency.near";
  const other = "another.near";
  const wallet = new DevWallet();
  const publicKey = wallet.addAccount(account);
  wallet.addAccount(other);
  const request: SignRequest = {
    account_id: account, message: "Paperwork terms sha256:fixture\nReview café export criteria.",
    recipient: "multiagency-paperwork", nonce: nonceToString(Uint8Array.from({ length: 32 }, (_, i) => i)),
  };
  const response = (owner: string, payload: Payload) => {
    const signed = wallet.sign(owner, payload);
    return { accountId: owner, publicKey: signed.public_key, signature: signed.signature };
  };
  const ctx = {
    session: { account, loading: false, version: 1 } as WalletSigningSession,
    network: "mainnet" as Network,
    state: { accountId: account, publicKey, networkId: "mainnet" } as { accountId: string | null; publicKey: string | null; networkId: string } | null,
    connected: true,
    readAccount: async (): Promise<string | null> => account,
    connect: async (): Promise<boolean> => true,
    sign: async (payload: Payload): Promise<unknown> => response(account, payload),
    calls: { session: 0, read: 0, connect: 0, sign: 0, state: 0, networks: [] as Network[] },
    received: [] as { payload: Payload; options?: { signerId?: string } }[],
  };
  const deps: WalletSigningDependencies = {
    network: "mainnet", timeoutMs,
    session: () => { ctx.calls.session++; return ctx.session; },
    readAccount: async () => { ctx.calls.read++; return ctx.readAccount(); },
    near: {
      ensureConnected: async () => { ctx.calls.connect++; return ctx.connect(); },
      getState: () => { ctx.calls.state++; return ctx.state; },
      isWalletConnected: () => ctx.connected,
      getNetwork: () => ctx.network,
      getNearClient: (network) => {
        ctx.calls.networks.push(network);
        return { signMessage: async (payload, options) => { ctx.calls.sign++; ctx.received.push({ payload, options }); return ctx.sign(payload); } };
      },
    },
  };
  return Object.assign(ctx, { account, other, wallet, publicKey, request, response, deps, signer: new WorkflowWalletSigner(deps) });
}

test("the shared signer returns a real signature for the exact supplied payload without callbacks or extra wallet authority", async () => {
  const ctx = fixture();
  const signed = await ctx.signer.sign(ctx.request);
  expect(signed.account_id).toBe(ctx.account);
  expect(signed.nonce).toBe(ctx.request.nonce);
  expect(verifyNep413({ message: ctx.request.message, recipient: ctx.request.recipient, nonce: nonceFromString(ctx.request.nonce) }, signed)).toBe(true);
  expect(ctx.calls.read).toBe(2);
  expect(ctx.calls.connect).toBe(1);
  expect(ctx.calls.sign).toBe(1);
  expect(ctx.calls.networks).toEqual(["mainnet"]);
  expect(Object.keys(ctx.received[0]!.payload).sort()).toEqual(["message", "nonce", "recipient"]);
  expect(ctx.received[0]!.payload.message).toBe(ctx.request.message);
  expect(ctx.received[0]!.payload.recipient).toBe(ctx.request.recipient);
  expect(ctx.received[0]!.payload.nonce).toEqual(nonceFromString(ctx.request.nonce));
  expect(ctx.received[0]!.options).toEqual({ signerId: ctx.account });
});

test("malformed, wrong-length or noncanonical nonces fail before session reads or wallet prompts", async () => {
  for (const nonce of ["not base64", nonceToString(new Uint8Array(31)), nonceToString(new Uint8Array(33)), fixture().request.nonce.replace(/=$/, ""), ` ${fixture().request.nonce}`]) {
    const ctx = fixture();
    await expect(ctx.signer.sign({ ...ctx.request, nonce })).rejects.toThrow("invalid nonce");
    expect([ctx.calls.session, ctx.calls.read, ctx.calls.connect, ctx.calls.sign]).toEqual([0, 0, 0, 0]);
    // A local validation failure must not leave the shared prompt guard locked.
    expect((await ctx.signer.sign(ctx.request)).account_id).toBe(ctx.account);
  }
});

test("wrong or loading local sessions and a wrong active network never prompt the wallet", async () => {
  for (const fault of ["account", "loading", "version", "network"] as const) {
    const ctx = fixture();
    if (fault === "account") ctx.session.account = ctx.other;
    if (fault === "loading") ctx.session.loading = true;
    if (fault === "version") ctx.session.version = Number.NaN;
    if (fault === "network") ctx.network = "testnet";
    await expect(ctx.signer.sign(ctx.request)).rejects.toThrow();
    expect([ctx.calls.read, ctx.calls.connect, ctx.calls.sign]).toEqual([0, 0, 0]);
  }
});

test("expired, changed or unavailable server sessions fail closed before connecting", async () => {
  for (const account of [null, "another.near"] as const) {
    const ctx = fixture();
    ctx.readAccount = async () => account;
    await expect(ctx.signer.sign(ctx.request)).rejects.toThrow("session");
    expect([ctx.calls.read, ctx.calls.connect, ctx.calls.sign]).toEqual([1, 0, 0]);
  }
  const ctx = fixture();
  ctx.readAccount = async () => { throw new Error("bearer fixture-secret-must-not-be-shown"); };
  const error = await ctx.signer.sign(ctx.request).catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("session could not be verified");
  expect((error as Error).message).not.toContain("fixture-secret");
  expect(ctx.calls.connect).toBe(0);
});

test("connection refusal and mismatched or disconnected actual wallets never sign", async () => {
  for (const fault of ["refused", "account", "network", "disconnected", "missing"] as const) {
    const ctx = fixture();
    if (fault === "refused") ctx.connect = async () => false;
    if (fault === "account") ctx.state!.accountId = ctx.other;
    if (fault === "network") ctx.state!.networkId = "testnet";
    if (fault === "disconnected") ctx.connected = false;
    if (fault === "missing") ctx.state = null;
    await expect(ctx.signer.sign(ctx.request)).rejects.toThrow();
    expect([ctx.calls.connect, ctx.calls.sign]).toEqual([1, 0]);
  }
});

test("wallet connection and signing errors are safe, actionable and never retried", async () => {
  const ctx = fixture();
  ctx.connect = async () => { throw new Error("connection-secret"); };
  const connectionError = await ctx.signer.sign(ctx.request).catch((e: Error) => e);
  expect((connectionError as Error).message).toContain("Reconnect");
  expect((connectionError as Error).message).not.toContain("connection-secret");
  expect(ctx.calls.connect).toBe(1);
  expect(ctx.calls.sign).toBe(0);
  ctx.connect = async () => true;
  ctx.sign = async () => { throw new Error("NO_KEY_FOUND private-key-or-server-secret"); };
  const signingError = await ctx.signer.sign(ctx.request).catch((e: Error) => e);
  expect((signingError as Error).message).toContain("cancelled or unavailable");
  expect((signingError as Error).message).not.toMatch(/NO_KEY_FOUND|private-key|server-secret/);
  expect(ctx.calls.sign).toBe(1);
  expect(ctx.calls.read).toBe(2); // one before each explicit attempt; none after the cancelled prompt
});

test("missing or malformed wallet responses cannot become app signatures", async () => {
  for (const result of [undefined, null, "signed", {}, { accountId: "agency.near", publicKey: 5, signature: "x" }, { accountId: "agency.near", publicKey: "ed25519:x", signature: "" }]) {
    const ctx = fixture();
    ctx.sign = async () => result;
    await expect(ctx.signer.sign(ctx.request)).rejects.toThrow("usable signature");
    expect(ctx.calls.read).toBe(1);
    expect(ctx.calls.sign).toBe(1);
  }
});

test("a valid signature returned for another account is rejected despite signerId being requested", async () => {
  const ctx = fixture();
  ctx.sign = async (payload) => ctx.response(ctx.other, payload);
  await expect(ctx.signer.sign(ctx.request)).rejects.toThrow("another account");
  expect(ctx.received[0]!.options).toEqual({ signerId: ctx.account });
  expect(ctx.calls.read).toBe(1);
});

test("actual signatures over a changed message, recipient, nonce or callback URL fail exact-payload verification", async () => {
  for (const field of ["message", "recipient", "nonce", "callbackUrl"] as const) {
    const ctx = fixture();
    ctx.sign = async (payload) => {
      const changed = { ...payload, nonce: new Uint8Array(payload.nonce) };
      if (field === "message") changed.message += " changed";
      if (field === "recipient") changed.recipient = "another-recipient";
      if (field === "nonce") changed.nonce[0] = 255;
      const signed = ctx.wallet.sign(ctx.account, { ...changed, ...(field === "callbackUrl" ? { callbackUrl: "https://example.test/redirect" } : {}) });
      return { accountId: ctx.account, publicKey: signed.public_key, signature: signed.signature };
    };
    await expect(ctx.signer.sign(ctx.request)).rejects.toThrow("does not match this request");
    expect(ctx.calls.read).toBe(1);
  }
});

test("a key different from the exposed active wallet key is refused even with a valid signature", async () => {
  const ctx = fixture();
  ctx.sign = async (payload) => ({ ...ctx.response(ctx.other, payload), accountId: ctx.account });
  await expect(ctx.signer.sign(ctx.request)).rejects.toThrow("wallet key changed");
  expect(ctx.calls.read).toBe(1);
});

test("wallets without a pre-exposed public key can return a valid ed25519 signature", async () => {
  const ctx = fixture();
  ctx.state!.publicKey = null;
  expect((await ctx.signer.sign(ctx.request)).public_key).toBe(ctx.publicKey);
});

test("signout, account switch-back, wallet network change or disconnect during a prompt invalidates its result", async () => {
  for (const fault of ["signout", "switch-back", "network", "disconnect", "wallet-account"] as const) {
    const ctx = fixture();
    ctx.sign = async (payload) => {
      const signed = ctx.response(ctx.account, payload);
      if (fault === "signout") { ctx.session.account = null; ctx.session.version++; }
      if (fault === "switch-back") { ctx.session.account = ctx.other; ctx.session.version++; ctx.session.account = ctx.account; }
      if (fault === "network") ctx.network = "testnet";
      if (fault === "disconnect") ctx.connected = false;
      if (fault === "wallet-account") ctx.state!.accountId = ctx.other;
      return signed;
    };
    await expect(ctx.signer.sign(ctx.request)).rejects.toThrow();
    expect(ctx.calls.read).toBe(1);
  }
});

test("the final fresh session read and changes during that read are checked before returning a signature", async () => {
  for (const fault of ["expired", "account", "version", "network"] as const) {
    const ctx = fixture();
    ctx.readAccount = async () => {
      if (ctx.calls.read === 2) {
        if (fault === "expired") return null;
        if (fault === "account") ctx.session.account = ctx.other;
        if (fault === "version") ctx.session.version++;
        if (fault === "network") ctx.network = "testnet";
      }
      return ctx.account;
    };
    await expect(ctx.signer.sign(ctx.request)).rejects.toThrow();
    expect([ctx.calls.sign, ctx.calls.read]).toEqual([1, 2]);
  }
});

test("caller mutation during an authenticated read cannot change the later wallet payload or original nonce", async () => {
  const ctx = fixture();
  const original = { ...ctx.request };
  const firstRead = deferred<string | null>();
  ctx.readAccount = () => ctx.calls.read === 1 ? firstRead.promise : Promise.resolve(ctx.account);
  const pending = ctx.signer.sign(ctx.request);
  Object.assign(ctx.request, { account_id: ctx.other, message: "Changed caller message", recipient: "changed", nonce: nonceToString(new Uint8Array(32)) });
  firstRead.resolve(ctx.account);
  const signed = await pending;
  expect(signed.account_id).toBe(original.account_id);
  expect(signed.nonce).toBe(original.nonce);
  expect(ctx.received[0]!.payload.message).toBe(original.message);
  expect(ctx.received[0]!.payload.recipient).toBe(original.recipient);
  expect(verifyNep413({ message: original.message, recipient: original.recipient, nonce: nonceFromString(original.nonce) }, signed)).toBe(true);
});

test("wallet mutation of the passed nonce array cannot change verification's retained nonce", async () => {
  const ctx = fixture();
  const original = ctx.request.nonce;
  ctx.sign = async (payload) => { payload.nonce.fill(255); return ctx.response(ctx.account, payload); };
  await expect(ctx.signer.sign(ctx.request)).rejects.toThrow("does not match this request");
  expect(ctx.request.nonce).toBe(original);
});

test("only one prompt can be pending and explicit signing is available again after it settles", async () => {
  const ctx = fixture();
  const entered = deferred<Payload>();
  const answer = deferred<unknown>();
  ctx.sign = async (payload) => { entered.resolve(payload); return answer.promise; };
  const first = ctx.signer.sign(ctx.request);
  const payload = await entered.promise;
  await expect(ctx.signer.sign(ctx.request)).rejects.toThrow("already open");
  expect(ctx.calls.sign).toBe(1);
  answer.resolve(ctx.response(ctx.account, payload));
  expect((await first).account_id).toBe(ctx.account);
  ctx.sign = async (next) => ctx.response(ctx.account, next);
  expect((await ctx.signer.sign(ctx.request)).account_id).toBe(ctx.account);
  expect(ctx.calls.sign).toBe(2);
});

test("a timed-out prompt stays guarded and its late valid signature causes no further reads or usable result", async () => {
  const ctx = fixture(50);
  const entered = deferred<Payload>();
  const answer = deferred<unknown>();
  ctx.sign = async (payload) => { entered.resolve(payload); return answer.promise; };
  const outcome = ctx.signer.sign(ctx.request).then(() => "unexpected signature", (error: Error) => error);
  const payload = await entered.promise;
  const error = await outcome;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("timed out");
  await expect(ctx.signer.sign(ctx.request)).rejects.toThrow("already open");
  const reads = { session: ctx.calls.session, account: ctx.calls.read, state: ctx.calls.state };
  answer.resolve(ctx.response(ctx.account, payload));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect({ session: ctx.calls.session, account: ctx.calls.read, state: ctx.calls.state }).toEqual(reads);
  expect(ctx.calls.read).toBe(1);
  ctx.sign = async (next) => ctx.response(ctx.account, next);
  expect((await ctx.signer.sign(ctx.request)).account_id).toBe(ctx.account);
});
