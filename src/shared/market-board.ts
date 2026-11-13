/** Public discovery only. No participant jobs, assignments, account identifiers or actionable payment data. */
export type BoardJobKind = "standard" | "instant" | "competition";

export interface BoardQuery {
  q?: string;
  kind?: BoardJobKind;
  sort?: "recent" | "budget";
  offset?: number;
}

export interface BoardJob {
  job_id: string;
  title: string;
  description: string;
  budget_amount: string | null;
  budget_token: string;
  kind: BoardJobKind;
  status: "open" | "filling";
  tags: string[];
  posted_at: string;
  creator_name: string | null;
  slots_available: number;
  max_slots: number;
  acceptance_window_days: number;
  minimum_verification: "none" | "verified" | "identity_verified";
  entries_close_at: string | null;
}

export interface OpenJobsPage {
  jobs: BoardJob[];
  offset: number;
  next_offset: number | null;
  /** Local successful-read timestamp, not a Market event time or verification claim. */
  checked_at: string;
}

/**
 * One public Market job read for an offer import or a source check. A job sourced from the Market is paid only through
 * the platform, so it must reach `closed` (any award refunded) before platform setup or funding.
 */
export interface MarketJobSource {
  job_id: string;
  title: string;
  description: string;
  budget_amount: string | null;
  budget_token: string;
  kind: BoardJobKind;
  status: "open" | "filling" | "in_progress" | "completed" | "closed";
  acceptance_window_days: number;
  checked_at: string;
}
