import type { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { siwn } from "better-near-auth";

/**
 * Sign in with NEAR, the same way everything.dev apps do it: Better-Auth + the `siwn` plugin from
 * better-near-auth (NEP-413). The wallet signs "Sign in to <recipient>"; the server checks the
 * signature and that the key is a full-access key of the account, then issues a session cookie.
 */
export interface AuthOptions {
  db: Database;
  secret: string;
  baseURL: string;
  recipient: string;
  trustedOrigins?: string[];
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;

export async function createAuth(o: AuthOptions) {
  const options = {
    database: o.db,
    secret: o.secret,
    baseURL: o.baseURL,
    basePath: "/api/auth",
    trustedOrigins: o.trustedOrigins ?? [new URL(o.baseURL).origin],
    // Keep origin checks active in fixtures too; never derive an auth origin from untrusted proxy headers.
    advanced: { disableOriginCheck: false, trustedProxyHeaders: false },
    plugins: [siwn({ recipient: o.recipient, requireFullAccessKey: true })],
  };
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  const auth = betterAuth(options);
  return Object.assign(auth, { nearAccountFor: (userId: string) => primaryNearAccount(o.db, userId) });
}

/** The signed-in user's primary NEAR account, from better-near-auth's nearAccount table. */
function primaryNearAccount(db: Database, userId: string): string | null {
  const row = db
    .query('SELECT accountId FROM nearAccount WHERE userId = ? ORDER BY isPrimary DESC, createdAt ASC LIMIT 1')
    .get(userId) as { accountId: string } | null;
  return row?.accountId ?? null;
}

export interface SessionInfo {
  userId: string;
  accountId: string;
}

/** Read the session from request headers. Null when nobody is signed in. */
export async function sessionFrom(auth: Auth, headers: Headers, request?: Request): Promise<SessionInfo | null> {
  const s = await auth.api.getSession({ headers, request, asResponse: false });
  if (!s) return null;
  const accountId = auth.nearAccountFor(s.user.id);
  return accountId ? { userId: s.user.id, accountId } : null;
}
