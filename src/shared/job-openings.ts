/** Public discovery only. Applications, accepted terms and payments remain with their owning systems. */
export interface PublishedOpening {
  id: string;
  source: "nearn";
  title: string;
  kind: string;
  budget_amount: string | null;
  budget_token: string | null;
  /** Display metadata from the publisher, never accepted payment terms. Missing means unknown. */
  compensation_type?: string | null;
  minimum_reward?: string | null;
  maximum_reward?: string | null;
  deadline: string | null;
  url: string;
  slug: string;
}

export interface PublicOpenings {
  openings: PublishedOpening[];
  agency: "MultiAgency";
  source_url: string;
  sponsor_slug: string;
  /** Local successful-read time, not a listing publication or payment confirmation. */
  checked_at: string;
}
