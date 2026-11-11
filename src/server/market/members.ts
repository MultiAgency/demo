// Who may act for an agency in Covenant. A wallet owner: that account. A DAO: its members, by the DAO's own roles read
// from chain (the platform admits Covenant, not the member). Reading needs any member; filing a vote needs one whose
// role may add proposals. Presenting a control never authorizes: the platform and the DAO's vote still decide.
import { accessOf, type DaoPolicy } from "@multiagency/sdk";
import { UserError } from "../engine";
import type { AgencyRow } from "./db";

export type DaoPolicyReader = (dao: string) => Promise<DaoPolicy | null>;

/** The DAO's `get_policy` view over NEAR JSON-RPC, cached for a minute. */
export function rpcDaoPolicy(rpcUrl: string, send: typeof fetch = fetch): DaoPolicyReader {
  const cache = new Map<string, { at: number; policy: DaoPolicy | null }>();
  return async (dao) => {
    const hit = cache.get(dao);
    if (hit && Date.now() - hit.at < 60_000) return hit.policy;
    let policy: DaoPolicy | null = null;
    try {
      const res = await send(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "covenant-dao", method: "query", params: { finality: "final", request_type: "call_function", account_id: dao, method_name: "get_policy", args_base64: "" } }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json()) as { result?: { result?: number[] } };
      if (Array.isArray(body.result?.result)) policy = JSON.parse(Buffer.from(body.result.result).toString()) as DaoPolicy;
    } catch {
      policy = null;
    }
    cache.set(dao, { at: Date.now(), policy });
    return policy;
  };
}

/**
 * Throws unless `account` may do `need` for the agency. With sign-in off (stand-in and local stack), anyone may, as for
 * contracts.
 */
export async function requireMember(a: AgencyRow, account: string | null, need: "read" | "propose", required: boolean, daoPolicy: DaoPolicyReader) {
  if (!required) return;
  if (!account) throw new UserError(`Sign in with NEAR as ${a.signer === "dao" ? `a member of ${a.owner}` : a.owner} to act for ${a.name}.`, 401);
  if (a.signer === "wallet") {
    if (account !== a.owner) throw new UserError(`You're signed in as ${account}. Only ${a.owner} can act for ${a.name}.`, 403);
    return;
  }
  const policy = await daoPolicy(a.owner);
  if (!policy) throw new UserError(`Couldn't read ${a.owner}'s roles. Try again.`, 503);
  const access = accessOf(account, { account: a.owner, policy, signer: a.owner });
  if (!access) throw new UserError(`${account} is not a member of ${a.owner}.`, 403);
  if (need === "propose" && !access.canPropose) throw new UserError(`${account}'s role in ${a.owner} can't file proposals.`, 403);
}
