import { usd } from "./money";
import { largestDeliverable, scopeTotal, type Terms } from "./terms";

// ---------------------------------------------------------------------------------------------
// FROZEN signature (orchestrator, M0). Track C writes the body of clauseFor and removes the legacy
// section below once track B no longer calls legacyClauseFor.
// ---------------------------------------------------------------------------------------------
export type ClauseId = "payee" | "cap" | "budget" | "withdraw-only" | "funding" | "term" | "termination" | "approval" | "setup" | "platform";
export interface Clause {
  id: ClauseId;
  title: string;
  text: string;
}

/** Map a platform answer to the contract clause it actually identifies; null = "The policy refused it." */
export function clauseFor(_r: { kind: "refused" | "forbidden" | "session" | "held" | "blocked"; code: string | null }, _terms: Terms, _now: Date): Clause | null {
  return null; // track C implements (plan 04 §3 table)
}

// ----------------------------------------- legacy (provider adapter era; removed by track C at M2)
export type Layer = "request" | "auth" | "grant" | "policy" | "budget" | "balance" | "provider" | "api";

export interface LegacyClause {
  id: "payee" | "cap" | "term" | "termination" | "withdraw-only" | "funding" | "other";
  title: string;
  text: string;
}

export function legacyClauseFor(code: string, layer: Layer | undefined, terms: Terms): LegacyClause {
  const largest = usd(largestDeliverable(terms));
  const total = usd(scopeTotal(terms));
  if (code === "policy_destination_denied" || code === "invalid_address")
    return { id: "payee", title: "Payee clause", text: `Payments go only to ${terms.payee.address} on ${terms.payee.chain}.` };
  if (code === "policy_transaction_limit_exceeded" || code === "policy_limit_exceeded" || code === "spend_budget_exceeded" || code === "policy_denied" || layer === "budget")
    return { id: "cap", title: "Scope clause", text: `No payment above ${largest} (the largest deliverable); ${total} in total.` };
  if (layer === "grant" || layer === "auth" || code.startsWith("grant_"))
    return { id: "term", title: "Term clause", text: `The contract ends ${terms.end}. After that the agent's permission has expired.` };
  if (code === "agent_frozen" || code === "wallet_frozen")
    return { id: "termination", title: "Termination clause", text: "The representative froze this contract wallet." };
  if (code === "policy_action_denied" || code === "policy_asset_denied")
    return { id: "withdraw-only", title: "Payment clause", text: "The wallet can only withdraw USDC to the payee." };
  if (code === "insufficient_balance" || layer === "balance") return { id: "funding", title: "Funding", text: "The contract wallet does not hold enough USDC." };
  return { id: "other", title: "Provider rule", text: `Refused by the ${layer ?? "provider"} layer.` };
}
