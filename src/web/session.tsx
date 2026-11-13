import { RegistrationWallet } from "./registration";
import type { RegistrationQuote } from "../shared/registration";
import { createAuthClient } from "better-auth/react";
import { siwnClient } from "better-near-auth/client";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { AuthOperationGate, signInAndRefresh } from "./auth-lifecycle";
import type { AppConfig } from "./types";
import { WorkflowWalletSigner, type WalletSigningSession, type WorkflowSigner } from "./wallet-signing";

/**
 * Sign in with NEAR in the browser: Better-Auth's client with better-near-auth's siwnClient,
 * the same pairing everything.dev's host uses. The wallet (via near-connect) signs
 * "Sign in to <recipient>"; the server verifies it and sets a session cookie.
 */
function makeClient(cfg: AppConfig) {
  return createAuthClient({
    baseURL: window.location.origin,
    basePath: "/api/auth",
    fetchOptions: { credentials: "include" },
    plugins: [siwnClient({ recipient: cfg.auth.recipient, networkId: cfg.auth.network })],
  });
}

interface SessionValue {
  account: string | null;
  loading: boolean;
  required: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  signWorkflow: WorkflowSigner;
  registerUsdc: (quote: RegistrationQuote) => Promise<void>;
  error: string | null;
}

const Ctx = createContext<SessionValue>({
  account: null,
  loading: true,
  required: false,
  signIn: async () => undefined,
  signOut: async () => undefined,
  signWorkflow: async () => { throw new Error("Sign in with NEAR before signing this job."); },
  registerUsdc: async () => { throw new Error("Sign in before registering."); },
  error: null,
});

export function SessionProvider({ config, children }: { config: AppConfig; children: ReactNode }) {
  const client = useMemo(() => makeClient(config), [config]);
  const [account, setAccount] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshVersion = useRef(0);
  const operation = useRef(0);
  const authOperations = useRef(new AuthOperationGate());
  const signingSession = useRef<WalletSigningSession>({ account, loading, version: operation.current });
  signingSession.current = { account, loading, version: operation.current };
  const walletSigner = useMemo(() => new WorkflowWalletSigner({
    near: client.near,
    network: config.auth.network,
    session: () => ({ ...signingSession.current, version: operation.current }),
    readAccount: async () => (await api<{ session: { accountId: string } | null }>("GET", "/me")).session?.accountId ?? null,
  }), [client, config.auth.network]);
  const signWorkflow = useCallback<WorkflowSigner>((request) => walletSigner.sign(request), [walletSigner]);

  const registrationWallet = useMemo(() => new RegistrationWallet({
    network: config.auth.network,
    session: () => ({ ...signingSession.current, version: operation.current }),
    connect: () => client.near.ensureConnected(),
    readAccount: async () => (await api<{ session: { accountId: string } | null }>("GET", "/me")).session?.accountId ?? null,
    wallet: () => {
      const state = client.near.getState();
      return { account: state?.accountId ?? null, network: state?.networkId === config.auth.network ? client.near.getNetwork() : "mismatch", connected: client.near.isWalletConnected() };
    },
    send: (quote) => client.near.getNearClient(config.auth.network).transaction(quote.account)
      .functionCall(quote.token, "storage_deposit", { account_id: quote.account, registration_only: true }, { gas: "30 Tgas", attachedDeposit: BigInt(quote.deposit_yocto) }).send(),
  }), [client, config.auth.network]);
  const registerUsdc = useCallback((quote: RegistrationQuote) => registrationWallet.register(quote), [registrationWallet]);

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const me = await api<{ session: { accountId: string } | null }>("GET", "/me");
      if (version === refreshVersion.current) { setAccount(me.session?.accountId ?? null); setError(null); }
    } catch (e) {
      if (version === refreshVersion.current) { setAccount(null); setError((e as Error).message); }
    } finally {
      if (version === refreshVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(() => authOperations.current.signIn(async () => {
    const current = ++operation.current;
    signingSession.current = { account: null, loading: true, version: current };
    refreshVersion.current++;
    setAccount(null);
    setLoading(true);
    setError(null);
    await signInAndRefresh(
      (callbacks) => client.signIn.near(callbacks),
      async () => { if (operation.current === current) await refresh(); },
      (e) => { if (operation.current === current) setError(e.message || "Sign-in failed"); },
    );
    if (operation.current === current) setLoading(false);
  }), [client, refresh]);

  const signOut = useCallback(() => authOperations.current.signOut(async () => {
    const current = ++operation.current;
    signingSession.current = { account: null, loading: true, version: current };
    refreshVersion.current++;
    // Hide private views before wallet and session network calls finish.
    setAccount(null);
    setLoading(true);
    setError(null);
    try {
      try {
        await client.near.disconnect();
      } catch {
        /* wallet may already be disconnected */
      }
      const result = await client.signOut();
      if (result.error) throw new Error(result.error.message || "Sign-out failed");
    } catch (e) { if (operation.current === current) setError((e as Error).message); }
    finally { if (operation.current === current) setLoading(false); }
  }), [client]);

  const value = useMemo(() => ({ account, loading, required: config.auth.required, signIn, signOut, signWorkflow, registerUsdc, error }), [account, loading, config, signIn, signOut, signWorkflow, registerUsdc, error]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  return useContext(Ctx);
}
