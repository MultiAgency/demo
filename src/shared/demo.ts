import { type TermsInput, USDC_NEAR } from "./terms";

/** The demo work order. Fake account names so nobody mistakes them for real accounts. */
export const DEMO_TERMS: TermsInput = {
  v: 2,
  company: "Acme Labs",
  representative: { near_account: "acme.demo" },
  contractor: { name: "Maria Lopez", github: "maria-dev", near_account: "maria.demo" },
  payee: { chain: "near", address: "maria.demo" },
  asset: USDC_NEAR,
  scope: [
    { id: "d1", title: "CSV export for monthly reports", criteria: "Users can download any monthly report as CSV; covered by tests.", value_usd: "300" },
    { id: "d2", title: "Scheduler timezone handling", criteria: "The payout scheduler runs on UTC and handles daylight-saving changes.", value_usd: "200" },
    { id: "d3", title: "Rate limiting on the public API", criteria: "Per-IP token bucket on public routes, configurable, documented.", value_usd: "500" },
  ],
  start: "2026-11-01",
  end: "2026-11-30",
  repos: ["acme/app"],
  acceptance: "merged_to_default_branch_by_other",
};
