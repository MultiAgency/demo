import { usd } from "./money";
import { endInstant, largestDeliverable, scopeTotal, type Terms } from "./terms";

// Shared by server and web.
export type ClauseId = "payee" | "cap" | "budget" | "withdraw-only" | "funding" | "term" | "termination" | "approval" | "setup" | "platform";
export interface Clause {
  id: ClauseId;
  title: string;
  text: string;
}

/** Map a platform answer to the contract clause it actually identifies; null = "The policy refused it." */
export function clauseFor(r: { kind: "refused" | "forbidden" | "session" | "held" | "blocked"; code: string | null }, terms: Terms, now: Date): Clause | null {
  if (r.kind === "held") return approvalClause(terms);
  if (r.kind === "session") return setupClause("credential", terms);
  const code = r.code;
  // Gateway answers (403): the consent no longer covers the path. After the end that is the term; before, a setup step.
  if (r.kind === "forbidden" || (code !== null && CONSENT_CODES.has(code))) {
    if (code !== null && TERM_CODES.has(code) && now.getTime() >= Date.parse(endInstant(terms)))
      return { id: "term", title: "Term clause", text: `The contract ended ${terms.end}. The agent's permission to pay ended with it.` };
    return setupClause(code ?? "forbidden", terms);
  }
  if (code === null) return null;
  switch (code) {
    case "payee_not_agreed":
    case "recipient_not_found":
      return { id: "payee", title: "Payee clause", text: `Payments go only to ${terms.payee.address} on NEAR.` };
    case "per_transaction_exceeded":
      return { id: "cap", title: "Scope clause", text: `No payment above ${usd(largestDeliverable(terms))}, the largest deliverable.` };
    case "spend_budget_exceeded":
      return { id: "budget", title: "Budget", text: `The policy's USD budget, sized from the ${usd(scopeTotal(terms))} scope, is used up for this window.` };
    case "withdraw_not_allowed":
    case "asset_not_allowed":
      return { id: "withdraw-only", title: "Payment clause", text: "The agent can only withdraw USDC on NEAR to the payee." };
    case "insufficient_balance":
      return { id: "funding", title: "Funding", text: `Funded with exactly the ${usd(scopeTotal(terms))} scope; it can't pay what it doesn't hold.` };
    case "frozen":
    case "agent_frozen":
      return { id: "termination", title: "Termination clause", text: `${terms.representative.near_account} froze this contract's agent. It can't pay anything.` };
    case "contract_ending":
      return { id: "term", title: "Term clause", text: `The contract ends ${terms.end}; Covenant stops requesting payouts in its last minutes.` };
    case "policy_mismatch":
    case "setup":
    case "grant_missing":
    case "grant_purpose_denied":
    case "policy_not_in_force":
    case "recipient_not_registered":
    case "credential":
      return setupClause(code, terms);
    case "duplicate_held_payout":
      return { id: "platform", title: "Platform rule", text: "Platform rule: one held payout per payee, asset and amount at a time." };
    case "reviewed_policy_changed":
      return { id: "platform", title: "Platform rule", text: "Platform rule: the policy changed after Covenant read it, so nothing was sent." };
    case "request_conflict":
      return { id: "platform", title: "Platform rule", text: "Platform rule: this request id was already used with different terms." };
    default:
      return null; // bare policy_denied and unknown codes name no rule: "The policy refused it."
  }
}

const TERM_CODES = new Set(["scope", "no_consent", "access_ended"]);
const CONSENT_CODES = new Set(["scope", "no_consent", "access_ended", "consent_revoked"]);

function approvalClause(terms: Terms): Clause {
  return { id: "approval", title: "Approval clause", text: `Every payout waits for ${terms.representative.near_account} to approve it before money moves.` };
}

function setupClause(code: string, terms: Terms): Clause {
  const text: Record<string, string> = {
    grant_missing: "The agent's payout grant is missing. Issue it again.",
    grant_purpose_denied: "The agent's grant doesn't cover payouts. Issue a payout grant.",
    policy_not_in_force: "The signed policy isn't in force yet.",
    policy_mismatch: "The live policy no longer matches the signed contract. Covenant won't request payouts until it does.",
    setup: "The contract's agent isn't fully set up yet.",
    recipient_not_registered: `${terms.payee.address} isn't registered on the USDC contract yet.`,
    credential: "The platform refused Covenant's app credential. The operator has to fix it.",
    consent_revoked: "The representative revoked the app's consent. Sign a new consent.",
  };
  return { id: "setup", title: "Setup", text: text[code] ?? "The app's consent doesn't cover this request. Sign a new consent." };
}
