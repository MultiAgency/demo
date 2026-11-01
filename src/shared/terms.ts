import { z } from "zod";
import { canonicalJson, sha256Hex } from "./canonical";
import { isDecimal, normalizeDecimal } from "./money";

/**
 * USDC on NEAR as a NEAR Intents asset id (native Circle USDC, 6 decimals).
 * Confirm against getTokens() in spike SP0 before the first live contract.
 */
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

export const termsSchema = z
  .object({
    v: z.literal(1),
    company: z.string().trim().min(1).max(80),
    representative: z.object({ near_account: nearAccount }),
    contractor: z.object({
      name: z.string().trim().min(1).max(80),
      github: z.string().trim().toLowerCase().regex(/^[a-z\d](?:[a-z\d-]{0,38})$/, "Not a GitHub username"),
      near_account: nearAccount,
    }),
    payee: z.object({ chain: z.literal("near"), address: nearAccount }),
    asset: z.literal(USDC_NEAR),
    monthly_cap_usd: usdAmount,
    rate_per_accepted_pr_usd: usdAmount,
    start: isoDate,
    end: isoDate,
    repos: z.array(repo).min(1).max(10),
    scope: z.string().trim().min(10).max(1000),
    acceptance: z.literal("merged_to_default_branch_by_other"),
  })
  .strict()
  .refine((t) => t.start <= t.end, { message: "End date must be on or after the start date", path: ["end"] })
  .refine((t) => daysBetween(t.start, t.end) <= 365, { message: "Contracts can last at most 365 days", path: ["end"] });

export type Terms = z.infer<typeof termsSchema>;
export type TermsInput = z.input<typeof termsSchema>;

export function parseTerms(input: unknown): Terms {
  const terms = termsSchema.parse(input);
  return { ...terms, repos: [...new Set(terms.repos)].sort() };
}

export function termsHash(terms: Terms): string {
  return sha256Hex(canonicalJson(terms));
}

/** The exact text both parties sign with their NEAR wallet (NEP-413 message field). */
export function termsSigningMessage(hash: string): string {
  return `Covenant work order sha256:${hash}`;
}

/** The NEP-413 recipient for term signatures. */
export const TERMS_RECIPIENT = "covenant";

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
