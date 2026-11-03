import { useSession } from "../session";
import { Icon } from "./icons";
import { Avatar, Button } from "./ui";

/** Sign in with NEAR / signed-in account, as on everything.dev apps. */
export function AccountBox({ compact = false }: { compact?: boolean }) {
  const { account, loading, signIn, signOut, error } = useSession();
  if (loading) return null;
  if (!account)
    return (
      <div className={`account${compact ? " compact" : ""}`}>
        <Button icon="key" variant={compact ? "secondary" : "primary"} size="sm" full={!compact} onClick={signIn}>
          Sign in with NEAR
        </Button>
        {error && !compact ? <span className="account-error">{error}</span> : null}
      </div>
    );
  return (
    <div className={`account is-signed${compact ? " compact" : ""}`}>
      <Avatar name={account.replace(/\..*$/, "").replace(/[-_]/g, " ")} />
      <div className="account-id">
        <strong title={account}>{account}</strong>
        {!compact ? <span>Signed in with NEAR</span> : null}
      </div>
      <button className="icon-btn" onClick={() => void signOut()} aria-label="Sign out" title="Sign out">
        <Icon name="external" size={15} />
      </button>
    </div>
  );
}

/** Shown where an action needs a specific signed-in account. Renders nothing when access is fine. */
export function SignInGate({ account, role }: { account: string; role: string }) {
  const s = useSession();
  if (!s.required || s.loading || s.account === account) return null;
  return (
    <div className="gate">
      <Icon name="key" size={16} />
      <span>
        {s.account ? (
          <>
            Signed in as <strong>{s.account}</strong>. Only <strong>{account}</strong> can act as the {role}.
          </>
        ) : (
          <>
            Sign in as <strong>{account}</strong> to act as the {role}.
          </>
        )}
      </span>
      {s.account ? (
        <Button size="sm" variant="secondary" onClick={s.signOut}>
          Switch account
        </Button>
      ) : (
        <Button size="sm" icon="key" onClick={s.signIn}>
          Sign in with NEAR
        </Button>
      )}
    </div>
  );
}
