import { z } from "zod";
import { canonicalJson, sha256Hex } from "./canonical";
import { fromAtomic, isDecimal, normalizeDecimal, toAtomic } from "./money";

/** USDC on NEAR as a NEAR Intents asset id (native Circle USDC, 6 decimals). The one USDC id in the codebase. */
export const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const USDC_DECIMALS = 6;

const nearAccount = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$|^[0-9a-f]{64}$/, "Not a valid NEAR account id")
  .min(2)
  .max(64);

const usdAmount = z
  .string()
  .trim()
  .refine(isDecimal, "Use a plain decimal like 50 or 12.50")
  .transform(normalizeDecimal)
  .refine((v) => Number(v) > 0, "Must be more than 0");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const repo = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z\d][a-z\d-]*\/[a-z\d._-]+$/, "Use owner/name");

const deliverable = z
  .object({
    id: z.string().regex(/^d([1-9]|10)$/, "Deliverable ids are d1 to d10"),
    title: z.string().trim().min(3).max(120),
    criteria: z.string().trim().min(3).max(400),
    value_usd: usdAmount,
  })
  .strict();

const github = z.string().trim().toLowerCase().regex(/^[a-z\d](?:[a-z\d-]{0,38})$/, "Not a GitHub username");
const contractor = z.object({ name: z.string().trim().min(1).max(80), github, near_account: nearAccount });

const termsBase = z
  .object({
    company: z.string().trim().min(1).max(80),
    representative: z.object({ near_account: nearAccount }),
    contractor,
    payee: z.object({ chain: z.literal("near"), address: nearAccount }),
    asset: z.literal(USDC_NEAR),
    /** The signed scope: what the work is, and what each part is worth. */
    scope: z.array(deliverable).min(1).max(10),
    start: isoDate,
    end: isoDate,
    repos: z.array(repo).min(1).max(10),
  })
  .strict();

/** These clauses are signed, not inferred from whichever UI happens to be deployed. */
export const JOB_PAYMENT_TERMS = {
  calculation: "scope_completion_less_committed",
  invoice: "cap",
  approval: "explicit_agency",
  settlement: "platform_usdc_near",
  due: "after_approval",
} as const;

/**
 * Market-settled clauses: the Agent Market pays its awarded price when the agency accepts there (or when its acceptance
 * window lapses). Paperwork reviews the work and never requests a platform payment for such a job.
 */
export const MARKET_PAYMENT_TERMS = {
  calculation: "market_awarded_price",
  invoice: "cap",
  approval: "agency_accepts_on_market",
  settlement: "agent_market",
  due: "on_market_acceptance",
} as const;

const marketSource = z.object({ job_id: z.uuid() }).strict();
/** Optional fields are absent from the canonical terms when unset, so earlier v3 hashes are unchanged. */
const reportAndInvoice = {
  v: z.literal(3),
  title: z.string().trim().min(3).max(120).optional(),
  description: z.string().trim().min(3).max(2000).optional(),
  /** Code identity is supporting evidence here, not the acceptance rule, so both are optional. */
  contractor: contractor.extend({ github: github.optional() }),
  repos: z.array(repo).min(1).max(10).optional(),
  agency_owner: z.object({ type: z.literal("dao"), account_id: nearAccount }).strict().optional(),
  acceptance: z.literal("report_and_invoice"),
};
const v2Terms = termsBase.extend({ v: z.literal(2), acceptance: z.literal("merged_to_default_branch_by_other") });
const platformV3Terms = termsBase.extend({
  ...reportAndInvoice,
  /**
   * The Agent Market job this offer was sourced from. The signed clause: this job is paid only through the platform,
   * so the Market job must be closed without a live award before platform setup or funding.
   */
  market_source: marketSource.optional(),
  payment_terms: z.object({
    calculation: z.literal(JOB_PAYMENT_TERMS.calculation),
    invoice: z.literal(JOB_PAYMENT_TERMS.invoice),
    approval: z.literal(JOB_PAYMENT_TERMS.approval),
    settlement: z.literal(JOB_PAYMENT_TERMS.settlement),
    due: z.literal(JOB_PAYMENT_TERMS.due),
    /** Signed per-payment cap. Absent: the largest deliverable, as every earlier job signed it. */
    per_payment: z.literal("scope_total").optional(),
    /** Signed days after the end date in which a payout may still be requested. Absent: none. Work is due by the end date either way. */
    review_days: z.number().int().min(1).max(60).optional(),
  }).strict(),
});
/** No NEAR payee or asset: the Market pays its own worker account. The awarded Market job is required and signed. */
const marketV3Terms = termsBase.omit({ payee: true, asset: true }).extend({
  ...reportAndInvoice,
  market_source: marketSource,
  payment_terms: z.object({
    calculation: z.literal(MARKET_PAYMENT_TERMS.calculation),
    invoice: z.literal(MARKET_PAYMENT_TERMS.invoice),
    approval: z.literal(MARKET_PAYMENT_TERMS.approval),
    settlement: z.literal(MARKET_PAYMENT_TERMS.settlement),
    due: z.literal(MARKET_PAYMENT_TERMS.due),
  }).strict(),
});

export const termsSchema = z.union([v2Terms, platformV3Terms, marketV3Terms])
  .refine((t) => t.start <= t.end, { message: "End date must be on or after the start date", path: ["end"] })
  .refine((t) => daysBetween(t.start, t.end) <= 365, { message: "Contracts can last at most 365 days", path: ["end"] })
  .refine((t) => new Set(t.scope.map((d) => d.id)).size === t.scope.length, { message: "Deliverable ids must be unique", path: ["scope"] });

export type Terms = z.infer<typeof termsSchema>;
/** Terms paid through the platform's held payouts. Only these may reach setup, policy, funding or payout code. */
export type PlatformTerms = z.infer<typeof v2Terms> | z.infer<typeof platformV3Terms>;
export type MarketTerms = z.infer<typeof marketV3Terms>;
/** Pay on merge: the only terms whose acceptance rule reads the GitHub identity and repositories. */
export type MergeTerms = z.infer<typeof v2Terms>;
export type MergeTermsInput = z.input<typeof v2Terms>;
export type PlatformTermsInput = z.input<typeof v2Terms> | z.input<typeof platformV3Terms>;

export function isMarketSettled(terms: Terms): terms is MarketTerms {
  return terms.v === 3 && terms.payment_terms.settlement === MARKET_PAYMENT_TERMS.settlement;
}
export type TermsInput = z.input<typeof termsSchema>;
export type Deliverable = Terms["scope"][number];

export function parseTerms(input: unknown): Terms {
  const terms = termsSchema.parse(input);
  return terms.repos ? { ...terms, repos: [...new Set(terms.repos)].sort() } : terms;
}

/** The job's own signed title; null for terms signed without one. */
export function titleOf(terms: Terms): string | null {
  return terms.v === 3 ? terms.title ?? null : null;
}

/** The signed NEAR payee, or null when the Agent Market pays its own worker account. */
export function payeeOf(terms: Terms): string | null {
  return isMarketSettled(terms) ? null : terms.payee.address;
}

/** Parses terms that must be paid through the platform: fixtures, scripts and other platform-only callers. */
export function parsePlatformTerms(input: unknown): PlatformTerms {
  const terms = parseTerms(input);
  if (isMarketSettled(terms)) throw new Error("Expected platform-settled terms.");
  return terms;
}

/** Total value of the scope, as a decimal string. */
export function scopeTotal(terms: Pick<Terms, "scope">): string {
  return fromAtomic(terms.scope.reduce((n, d) => n + toAtomic(d.value_usd, USDC_DECIMALS), 0n), USDC_DECIMALS);
}

/** Largest single deliverable: the per-payment cap of terms that sign no other. */
export function largestDeliverable(terms: Pick<Terms, "scope">): string {
  return fromAtomic(terms.scope.reduce((m, d) => (toAtomic(d.value_usd, USDC_DECIMALS) > m ? toAtomic(d.value_usd, USDC_DECIMALS) : m), 0n), USDC_DECIMALS);
}

/** What the cap reads: the scope, and the signed per-payment clause when the terms carry one. */
export type CapTerms = Pick<Terms, "scope"> & { payment_terms?: { settlement: string; per_payment?: "scope_total" } };

/** One invoice, one approval: true when the terms sign a per-payment cap of the whole scope. */
export function capsAtScope(terms: CapTerms): boolean {
  return terms.payment_terms?.per_payment === "scope_total";
}

/** The signed per-payment cap: the most any one payment can be. */
export function perPaymentCap(terms: CapTerms): string {
  return capsAtScope(terms) ? scopeTotal(terms) : largestDeliverable(terms);
}

export function termsHash(terms: Terms): string {
  return sha256Hex(canonicalJson(terms));
}

/** The NEP-413 recipient for term signatures. */
export const TERMS_RECIPIENT = "multiagency-paperwork";
export type TermsRecipient = typeof TERMS_RECIPIENT | "covenant";

/** New jobs use Paperwork; each stored job pins its original signing domain across renames. */
export function termsSigningMessage(hash: string, recipient: TermsRecipient = TERMS_RECIPIENT): string {
  if (recipient === "covenant") return `Covenant work order sha256:${hash}`;
  if (recipient !== TERMS_RECIPIENT) throw new Error("Unsupported job signing domain");
  return `Paperwork terms sha256:${hash}`;
}

/** Contract end is inclusive: the last instant of the end date, UTC. */
export function endInstant(terms: Pick<Terms, "end">): string {
  return `${terms.end}T23:59:59.000Z`;
}

/** What the payout window reads: the end date, and the signed review window when the terms carry one. */
export type WindowTerms = Pick<Terms, "end"> & { payment_terms?: { settlement: string; review_days?: number } };

/** The last instant Paperwork may request a payout: the end date plus any signed review window. */
export function payoutEndInstant(terms: WindowTerms): string {
  return new Date(Date.parse(endInstant(terms)) + (terms.payment_terms?.review_days ?? 0) * 86_400_000).toISOString();
}

export function startInstant(terms: Pick<Terms, "start">): string {
  return `${terms.start}T00:00:00.000Z`;
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
}
