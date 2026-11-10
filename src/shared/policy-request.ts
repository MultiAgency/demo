// What Covenant asks the platform to enforce, and what Verify expects to read back, both compiled from
// the signed terms. Pure: same terms, same output. Replaces the provider-era compile.ts.
import type { Budget, Overview, PolicyChanges } from "../server/platform/port";
import type { Expectations } from "./views";
import { fromAtomic, toAtomic } from "./money";
import { endInstant, largestDeliverable, scopeTotal, type Terms, USDC_DECIMALS } from "./terms";

export function largestAtomic(terms: Pick<Terms, "scope">): string {
  return toAtomic(largestDeliverable(terms), USDC_DECIMALS).toString();
}

export function totalAtomic(terms: Pick<Terms, "scope">): string {
  return toAtomic(scopeTotal(terms), USDC_DECIMALS).toString();
}

/** USD budget windows: the scope total plus 5% headroom for price noise. Not what caps the contract. */
export function budgetFor(terms: Pick<Terms, "scope">): Budget {
  const total = BigInt(totalAtomic(terms));
  const usd = fromAtomic((total * 105n) / 100n, USDC_DECIMALS);
  return { daily_usd: usd, weekly_usd: null, monthly_usd: usd };
}

/**
 * The one policy edit made at onboarding: the full withdrawals list (only the payee), owner approval on,
 * per-payment cap = the largest deliverable, daily and monthly = the scope total, and the USD budget.
 */
export function policyChanges(terms: Terms): PolicyChanges {
  const asset = terms.asset;
  const total = totalAtomic(terms);
  return {
    withdrawals: [{ address: terms.payee.address }],
    owner_approval: true,
    limits: { per_transaction: { [asset]: largestAtomic(terms) }, daily: { [asset]: total }, monthly: { [asset]: total } },
    budget: budgetFor(terms),
  };
}

export function expectations(terms: Terms): Expectations {
  return {
    payee: terms.payee.address,
    asset: terms.asset,
    per_transaction: largestAtomic(terms),
    owner_approval: true,
    withdrawals: [terms.payee.address],
    payout_consent_expires_by: endInstant(terms),
    total: totalAtomic(terms),
  };
}

/**
 * The policy facts every payout request depends on. Returns the first problem, or null when the platform's
 * read matches the terms: in force, owner approval on, withdrawals == [payee], per-payment cap == largest.
 */
export function policyProblem(o: Overview | null, terms: Terms): { code: string; waiting: boolean; detail: string } | null {
  if (!o || !o.policy) return { code: "policy_not_in_force", waiting: true, detail: "No policy read yet." };
  const p = o.policy;
  // Before notInForce: the platform reports a frozen agent as not in force too, and a freeze is not a wait.
  if (p.frozen) return { code: "frozen", waiting: false, detail: "The agent is frozen." };
  if (o.notInForce !== null) return { code: "policy_not_in_force", waiting: true, detail: `Policy not in force: ${o.notInForce}.` };
  if (!p.owner_approval) return { code: "policy_mismatch", waiting: false, detail: "Owner approval is off." };
  const w = [...p.withdrawals].map((a) => a.toLowerCase());
  if (w.length !== 1 || w[0] !== terms.payee.address) return { code: "policy_mismatch", waiting: false, detail: `Withdrawals are [${w.join(", ")}], not [${terms.payee.address}].` };
  const cap = p.limits.per_transaction?.[terms.asset];
  if (cap !== largestAtomic(terms)) return { code: "policy_mismatch", waiting: false, detail: `Per-payment cap is ${cap ?? "unset"}, not ${largestAtomic(terms)}.` };
  return null;
}
