import type { Policy } from "@near-intents-agent-api/sdk";
import { fromAtomic, normalizeDecimal, toAtomic } from "./money";
import { endInstant, largestDeliverable, scopeTotal, type Terms, USDC_DECIMALS } from "./terms";

export type { Policy };

export const DEMO_TIMELOCK_MS = 10 * 60_000; // 10 minutes
export const PRODUCTION_TIMELOCK_MS = 48 * 3_600_000; // 48 hours

export interface CompiledContract {
  /** agent_create.name */
  name: string;
  /** The one agent's whole policy. Never changed after creation. */
  policy: Policy;
  /** The grant our server receives. Its expiry is the contract end date. */
  grant: { label: string; expires_at: string };
}

export interface CompileOptions {
  timelockMs: number;
}

/**
 * Terms -> one agent's policy + grant expiry. Pure function.
 *
 * Every clause the provider can enforce is compiled in:
 *  - payee clause    -> destinations: only [payee]
 *  - scope clause    -> limits.per_transaction = the largest deliverable (one payment per deliverable)
 *                       limits.monthly = the scope total; budget.monthly_usd = total + 5% (USD backstop)
 *                       and the wallet is funded with the total, so it can never pay more than that
 *  - term clause     -> grant.expires_at = end of the end date (the server's only credential stops working)
 *  - withdraw only   -> actions: ["withdraw"], assets: [USDC]
 * Which deliverables are done is judged by Covenant's agent; the provider bounds whatever it decides.
 */
export function compileContract(terms: Terms, hash: string, opts: CompileOptions): CompiledContract {
  const total = toAtomic(scopeTotal(terms), USDC_DECIMALS);
  const largest = toAtomic(largestDeliverable(terms), USDC_DECIMALS);
  const budget = fromAtomic((total * 105n) / 100n, USDC_DECIMALS);
  const short = hash.slice(0, 8);

  const policy: Policy = {
    frozen: false,
    actions: ["withdraw"],
    confidential: false,
    owner_approval: false,
    assets: [terms.asset],
    limits: {
      per_transaction: { [terms.asset]: largest.toString() },
      monthly: { [terms.asset]: total.toString() },
    },
    max_actions_per_hour: Math.min(terms.scope.length + 2, 12),
    destinations: {
      mode: "only",
      list: [{ action: "withdraw", chain: terms.payee.chain, address: terms.payee.address, memo: null }],
    },
    budget: { daily_usd: null, weekly_usd: null, monthly_usd: budget },
    timelock_ms: opts.timelockMs,
  };

  return {
    name: `${terms.company} · ${terms.contractor.name} · ${short}`.slice(0, 64),
    policy,
    grant: { label: `covenant ${short}`, expires_at: endInstant(terms) },
  };
}

/** Normalize a policy so two semantically equal policies compare equal. */
export function canonicalPolicy(p: Policy): Record<string, unknown> {
  const decMap = (m?: Record<string, string>) =>
    m && Object.keys(m).length
      ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k.toLowerCase(), normalizeDecimal(v)]).sort())
      : undefined;
  const dec = (v: string | null) => (v === null ? null : normalizeDecimal(v));
  return {
    frozen: p.frozen,
    actions: [...p.actions].sort(),
    confidential: p.confidential,
    owner_approval: p.owner_approval,
    assets: p.assets === "any" ? "any" : [...p.assets].map((a) => a.toLowerCase()).sort(),
    limits: {
      per_transaction: decMap(p.limits.per_transaction),
      hourly: decMap(p.limits.hourly),
      daily: decMap(p.limits.daily),
      monthly: decMap(p.limits.monthly),
    },
    max_actions_per_hour: p.max_actions_per_hour,
    destinations: {
      mode: p.destinations.mode,
      list: p.destinations.list
        .map((d) =>
          d.action === "withdraw"
            ? { action: d.action, chain: d.chain.toLowerCase(), address: d.address.toLowerCase(), memo: d.memo }
            : { action: d.action, address: d.address.toLowerCase(), confidential: d.confidential },
        )
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    },
    budget: { daily_usd: dec(p.budget.daily_usd), weekly_usd: dec(p.budget.weekly_usd), monthly_usd: dec(p.budget.monthly_usd) },
    timelock_ms: p.timelock_ms,
    schedule: p.schedule,
    native: p.native,
  };
}

export interface PolicyDiff {
  path: string;
  expected: unknown;
  actual: unknown;
}

/** Field-by-field differences between the compiled policy and the one the provider reports. */
export function diffPolicy(expected: Policy, actual: Policy): PolicyDiff[] {
  const out: PolicyDiff[] = [];
  walk(canonicalPolicy(expected), canonicalPolicy(actual), "", out);
  return out;
}

function walk(a: unknown, b: unknown, path: string, out: PolicyDiff[]) {
  if (isObj(a) && isObj(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      walk(a[key], b[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }
  if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out.push({ path, expected: a ?? null, actual: b ?? null });
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
