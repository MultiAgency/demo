import { JOB_PAYMENT_TERMS, type MergeTermsInput, type PlatformTermsInput, USDC_NEAR } from "./terms";

/** The demo job. Fake account names so nobody mistakes them for real accounts. */
export const DEMO_TERMS: MergeTermsInput = {
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

/** One agency, one builder, one report/invoice job. All identities are fixtures. */
export const JOB_DEMO_TERMS: PlatformTermsInput = {
  ...DEMO_TERMS,
  v: 3,
  acceptance: "report_and_invoice",
  payment_terms: JOB_PAYMENT_TERMS,
  scope: [DEMO_TERMS.scope[0]!],
};
