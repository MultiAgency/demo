import { z } from "zod";
import type { PublicOpenings, PublishedOpening } from "../../shared/job-openings";

const SETTINGS_URL = "https://multiagency.ai/api/settings";
const LISTINGS_URL = "https://nearn.io/api/listings/sponsor/";
const READ_MS = 15_000;
const slug = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/);
const listing = z.object({
  slug,
  title: z.string().trim().min(1),
  type: z.enum(["bounty", "project", "hackathon", "sponsorship"]),
  status: z.literal("OPEN"),
  isPublished: z.literal(true),
  isPrivate: z.literal(false),
  // The public sponsor handler filters these fields but does not select them.
  isActive: z.literal(true).optional(),
  isArchived: z.literal(false).optional(),
  isWinnersAnnounced: z.boolean().optional(),
  rewardAmount: z.number().finite().min(0).nullable(),
  token: z.string().trim().min(1).nullable(),
  compensationType: z.string().nullable().optional(),
  minRewardAsk: z.number().finite().min(0).nullable().optional(),
  maxRewardAsk: z.number().finite().min(0).nullable().optional(),
  deadline: z.iso.datetime({ offset: true }).nullable(),
  sponsor: z.object({ slug }).optional(),
}).refine((value) => value.compensationType !== "range" || value.minRewardAsk == null || value.maxRewardAsk == null || value.minRewardAsk <= value.maxRewardAsk);

function invalid(): Error {
  return new Error("Published MultiAgency openings could not be read.");
}

/** NEARN's anonymous sponsor catalog is a read-only POST, unpaginated across the requested types.
 * Official source: NEAR-DevHub/nearn, prod 0aa3a0f659c858a4b5486f77b1e021198cb93292,
 * src/pages/api/listings/sponsor.ts. Public project activity is not an opening.
 */
export class MultiAgencyOpenings {
  constructor(
    private readonly send: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async read(url: string, body?: unknown): Promise<unknown> {
    try {
      const response = await this.send(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) },
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(READ_MS),
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw invalid();
      return await response.json();
    } catch {
      // Neither upstream bodies nor transport errors are safe public error messages.
      throw invalid();
    }
  }

  async list(): Promise<PublicOpenings> {
    const settings = z.object({ nearnAccountId: slug }).safeParse(await this.read(SETTINGS_URL));
    if (!settings.success) throw invalid();
    const sponsor = settings.data.nearnAccountId;
    const response = await this.read(LISTINGS_URL, {
      sponsor,
      type: { in: ["bounty", "project", "hackathon", "sponsorship"] },
    });
    if (!response || typeof response !== "object" || Array.isArray(response) ||
      !Array.isArray((response as Record<string, unknown>).bounties)) throw invalid();
    const checkedAt = this.now();
    if (!Number.isFinite(checkedAt.getTime())) throw invalid();
    const openings: PublishedOpening[] = [];
    const seen = new Set<string>();
    for (const value of (response as { bounties: unknown[] }).bounties) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
      const row = value as Record<string, unknown>;
      // Drop explicitly ineligible rows before inspecting any of their potentially private fields.
      if (row.isPublished === false || row.isPrivate === true || row.isArchived === true || row.isActive === false ||
        row.isWinnersAnnounced === true || (typeof row.status === "string" && row.status !== "OPEN")) continue;
      const parsed = listing.safeParse(row);
      if (!parsed.success) throw invalid();
      const item = parsed.data;
      if (item.sponsor && item.sponsor.slug !== sponsor) throw invalid();
      if (item.deadline !== null && Date.parse(item.deadline) <= checkedAt.getTime()) continue;
      if (seen.has(item.slug)) throw invalid();
      seen.add(item.slug);
      openings.push({
        id: `nearn:${sponsor}:${item.slug}`,
        source: "nearn",
        slug: item.slug,
        title: item.title,
        kind: item.type,
        budget_amount: item.rewardAmount === null ? null : decimal(item.rewardAmount),
        budget_token: item.token,
        ...(item.compensationType !== undefined && { compensation_type: item.compensationType }),
        ...(item.minRewardAsk !== undefined && { minimum_reward: item.minRewardAsk === null ? null : decimal(item.minRewardAsk) }),
        ...(item.maxRewardAsk !== undefined && { maximum_reward: item.maxRewardAsk === null ? null : decimal(item.maxRewardAsk) }),
        deadline: item.deadline,
        // Official /listing/[slug] is a permanent redirect to the current sponsor/listing route.
        url: `https://nearn.io/listing/${encodeURIComponent(item.slug)}`,
      });
    }
    return {
      openings, agency: "MultiAgency", sponsor_slug: sponsor,
      source_url: `https://nearn.io/${encodeURIComponent(sponsor)}`,
      checked_at: checkedAt.toISOString(),
    };
  }
}

/** Expand scientific notation only for display. This catalog never authorizes or calculates a payment. */
function decimal(value: number): string {
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const [coefficient, exponentText] = text.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [whole, fraction = ""] = coefficient!.split(".");
  const digits = whole! + fraction;
  const point = whole!.length + exponent;
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}
