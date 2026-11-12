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

const termsBase = z
  .object({
    company: z.string().trim().min(1).max(80),
    representative: z.object({ near_account: nearAccount }),
    contractor: z.object({
      name: z.string().trim().min(1).max(80),
      github: z.string().trim().toLowerCase().regex(/^[a-z\d](?:[a-z\d-]{0,38})$/, "Not a GitHub username"),
      near_account: nearAccount,
    }),
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

export const termsSchema = z.discriminatedUnion("v", [
  termsBase.extend({ v: z.literal(2), acceptance: z.literal("merged_to_default_branch_by_other") }),
  termsBase.extend({
    v: z.literal(3),
    agency_owner: z.object({ type: z.literal("dao"), account_id: nearAccount }).strict().optional(),
    acceptance: z.literal("report_and_invoice"),
    payment_terms: z.object({
      calculation: z.literal(JOB_PAYMENT_TERMS.calculation),
      invoice: z.literal(JOB_PAYMENT_TERMS.invoice),
      approval: z.literal(JOB_PAYMENT_TERMS.approval),
      settlement: z.literal(JOB_PAYMENT_TERMS.settlement),
      due: z.literal(JOB_PAYMENT_TERMS.due),
    }).strict(),
  }),
])
  .refine((t) => t.start <= t.end, { message: "End date must be on or after the start date", path: ["end"] })
  .refine((t) => daysBetween(t.start, t.end) <= 365, { message: "Contracts can last at most 365 days", path: ["end"] })
  .refine((t) => new Set(t.scope.map((d) => d.id)).size === t.scope.length, { message: "Deliverable ids must be unique", path: ["scope"] });

export type Terms = z.infer<typeof termsSchema>;
export type TermsInput = z.input<typeof termsSchema>;
export type Deliverable = Terms["scope"][number];

export function parseTerms(input: unknown): Terms {
  const terms = termsSchema.parse(input);
  return { ...terms, repos: [...new Set(terms.repos)].sort() };
}

/** Total value of the scope, as a decimal string. */
export function scopeTotal(terms: Pick<Terms, "scope">): string {
  return fromAtomic(terms.scope.reduce((n, d) => n + toAtomic(d.value_usd, USDC_DECIMALS), 0n), USDC_DECIMALS);
}

/** Largest single deliverable: the most any one payment can be. */
export function largestDeliverable(terms: Pick<Terms, "scope">): string {
  return fromAtomic(terms.scope.reduce((m, d) => (toAtomic(d.value_usd, USDC_DECIMALS) > m ? toAtomic(d.value_usd, USDC_DECIMALS) : m), 0n), USDC_DECIMALS);
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

export function startInstant(terms: Pick<Terms, "start">): string {
  return `${terms.start}T00:00:00.000Z`;
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
}
