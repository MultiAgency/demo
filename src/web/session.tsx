import { createAuthClient } from "better-auth/react";
import { siwnClient } from "better-near-auth/client";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { AppConfig } from "./types";

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
  error: string | null;
}

const Ctx = createContext<SessionValue>({
  account: null,
  loading: true,
  required: false,
  signIn: async () => undefined,
  signOut: async () => undefined,
  error: null,
});

export function SessionProvider({ config, children }: { config: AppConfig; children: ReactNode }) {
  const client = useMemo(() => makeClient(config), [config]);
  const [account, setAccount] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ session: { accountId: string } | null }>("GET", "/me");
      setAccount(me.session?.accountId ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(
    () =>
      new Promise<void>((resolve) => {
        setError(null);
        void client.signIn.near({
          onSuccess: () => {
            void refresh().then(() => resolve());
          },
          onError: (e: { message?: string }) => {
            setError(e?.message ?? "Sign-in failed");
            resolve();
          },
        });
      }),
    [client, refresh],
  );

  const signOut = useCallback(async () => {
    try {
      await client.near.disconnect();
    } catch {
      /* wallet may already be disconnected */
    }
    await client.signOut();
    await refresh();
  }, [client, refresh]);

  const value = useMemo(() => ({ account, loading, required: config.auth.required, signIn, signOut, error }), [account, loading, config, signIn, signOut, error]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  return useContext(Ctx);
}
