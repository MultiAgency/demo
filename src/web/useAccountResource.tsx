import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { AccountResource } from "./account-resource";
import { useSession } from "./session";
import { Alert, Button, PageLoading } from "./components/ui";

export function useAccountResource<T>(key: string, read: () => Promise<T>, { refreshMs = 0 } = {}) {
  const session = useSession();
  const actor = session.required ? session.loading || !session.account ? null : session.account : "demo";
  const scope = actor === null ? null : `${key}:${actor}`;
  const resource = useMemo(() => new AccountResource<T>(), [key]);
  useSyncExternalStore(resource.subscribe, resource.getSnapshot);
  useEffect(() => {
    resource.setScope(scope);
    if (scope !== null) void resource.load(scope, read);
    return () => resource.invalidate();
  }, [resource, scope, read]);
  useEffect(() => {
    if (scope === null || refreshMs <= 0) return;
    const refresh = () => {
      if (document.visibilityState !== "hidden") void resource.refresh(scope, read);
    };
    const timer = window.setInterval(refresh, refreshMs);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [resource, scope, read, refreshMs]);
  const reload = useCallback(async () => {
    if (scope !== null) await resource.load(scope, read);
  }, [resource, scope, read]);
  return { ...resource.forScope(scope), reload, enabled: scope !== null };
}

/** The party's account is private until the protected record can be read. */
export function AccountReadGate({ className = "page" }: { className?: string }) {
  const session = useSession();
  if (session.loading) return <PageLoading />;
  return <div className={className}><div className="stack">
    <Alert tone="info">Sign in with NEAR to view this job and its private submissions.</Alert>
    <Button icon="key" onClick={session.signIn}>Sign in with NEAR</Button>
    {session.error ? <Alert tone="danger">{session.error}</Alert> : null}
  </div></div>;
}
