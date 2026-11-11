// What Paperwork asks the platform to enforce, and what Verify expects to read back, both compiled from
// the signed terms. Pure: same terms, same output. Replaces the provider-era compile.ts.
import type { Budget, Overview, PolicyChanges } from "../server/platform/port";
import type { Expectations } from "./views";
import { fromAtomic, normalizeDecimal, toAtomic } from "./money";
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

type LivePolicy = NonNullable<Overview["policy"]>;

const usdEq = (a: string | null | undefined, b: string | null) => (a ?? null) === null || b === null ? (a ?? null) === b : normalizeDecimal(String(a)) === normalizeDecimal(b);

/**
 * Every difference between the live policy and what Paperwork signed for these terms, as text; empty when they match.
 * The whole signed policy, not just the payee: actions, assets, owner approval, withdrawals, the per-payment cap,
 * the daily and monthly limits and the USD budget. A revision bump that leaves all of these equal (a freeze and
 * unfreeze, say) is not a difference.
 */
export function policyDifferences(p: LivePolicy, terms: Terms): string[] {
  const out: string[] = [];
  const signed = policyChanges(terms);
  const asset = terms.asset;
  if (p.actions.length !== 1 || p.actions[0] !== "withdraw") out.push(`actions are [${p.actions.join(", ")}], not [withdraw]`);
  if (p.assets === "any" || p.assets.length !== 1 || p.assets[0] !== asset) out.push(`assets are ${p.assets === "any" ? "any" : `[${p.assets.join(", ")}]`}, not [USDC]`);
  if (!p.owner_approval) out.push("owner approval is off");
  const w = [...p.withdrawals].map((a) => a.toLowerCase());
  if (w.length !== 1 || w[0] !== terms.payee.address) out.push(`withdrawals are [${w.join(", ")}], not [${terms.payee.address}]`);
  for (const k of ["per_transaction", "daily", "monthly"] as const) {
    const want = signed.limits![k]![asset]!;
    const got = p.limits[k]?.[asset];
    if (got !== want) out.push(`${k.replace("_", "-")} limit is ${got ?? "unset"}, not ${want}`);
  }
  for (const k of ["daily_usd", "weekly_usd", "monthly_usd"] as const) {
    const want = signed.budget![k];
    if (!usdEq(p.budget[k], want)) out.push(`${k.replace("_usd", "")} USD budget is ${p.budget[k] ?? "unset"}, not ${want ?? "unset"}`);
  }
  return out;
}

/**
 * The policy facts every payout request depends on. Returns the first problem, or null when the platform's
 * read is in force, not frozen, and the whole live policy matches what Paperwork signed (policyDifferences).
 */
export function policyProblem(o: Overview | null, terms: Terms): { code: string; waiting: boolean; detail: string } | null {
  if (!o || !o.policy) return { code: "policy_not_in_force", waiting: true, detail: "No policy read yet." };
  const p = o.policy;
  // Before notInForce: the platform reports a frozen agent as not in force too, and a freeze is not a wait.
  if (p.frozen) return { code: "frozen", waiting: false, detail: "The agent is frozen." };
  if (o.notInForce !== null) return { code: "policy_not_in_force", waiting: true, detail: `Policy not in force: ${o.notInForce}.` };
  const diff = policyDifferences(p, terms);
  if (diff.length) return { code: "policy_mismatch", waiting: false, detail: `The live policy (revision ${o.revision}) differs from the signed terms: ${diff.join("; ")}.` };
  return null;
}
