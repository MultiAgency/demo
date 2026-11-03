import { usd } from "./money";
import { largestDeliverable, scopeTotal, type Terms } from "./terms";

export type Layer = "request" | "auth" | "grant" | "policy" | "budget" | "balance" | "provider" | "api";

export interface Clause {
  id: "payee" | "cap" | "term" | "termination" | "withdraw-only" | "funding" | "other";
  title: string;
  text: string;
}

/**
 * Map a provider refusal (code + layer) to the contract clause it enforces.
 * Mapping is by code first, then by layer, because the provider can report a cap breach
 * either as a specific code or as a generic policy_denied.
 */
export function clauseFor(code: string, layer: Layer | undefined, terms: Terms): Clause {
  const largest = usd(largestDeliverable(terms));
  const total = usd(scopeTotal(terms));
  if (code === "policy_destination_denied" || code === "invalid_address")
    return { id: "payee", title: "Payee clause", text: `Payments go only to ${terms.payee.address} on ${terms.payee.chain}.` };
  if (
    code === "policy_transaction_limit_exceeded" ||
    code === "policy_limit_exceeded" ||
    code === "spend_budget_exceeded" ||
    code === "policy_denied" ||
    layer === "budget"
  )
    return { id: "cap", title: "Scope clause", text: `No payment above ${largest} (the largest deliverable); ${total} in total.` };
  if (layer === "grant" || layer === "auth" || code.startsWith("grant_"))
    return { id: "term", title: "Term clause", text: `The contract ends ${terms.end}. After that the agent's permission has expired.` };
  if (code === "agent_frozen" || code === "wallet_frozen")
    return { id: "termination", title: "Termination clause", text: "The representative froze this contract wallet." };
  if (code === "policy_action_denied" || code === "policy_asset_denied")
    return { id: "withdraw-only", title: "Payment clause", text: "The wallet can only withdraw USDC to the payee." };
  if (code === "insufficient_balance" || layer === "balance")
    return { id: "funding", title: "Funding", text: "The contract wallet does not hold enough USDC." };
  return { id: "other", title: "Provider rule", text: `Refused by the ${layer ?? "provider"} layer.` };
}
