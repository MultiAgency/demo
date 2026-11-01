import { type TermsInput, USDC_NEAR } from "./terms";

/** The demo work order. Fake account names so nobody mistakes them for real accounts. */
export const DEMO_TERMS: TermsInput = {
  v: 1,
  company: "Acme Labs",
  representative: { near_account: "acme.demo" },
  contractor: { name: "Maria Lopez", github: "maria-dev", near_account: "maria.demo" },
  payee: { chain: "near", address: "maria.demo" },
  asset: USDC_NEAR,
  monthly_cap_usd: "50",
  rate_per_accepted_pr_usd: "10",
  start: "2026-11-01",
  end: "2026-11-30",
  repos: ["acme/app"],
  scope: "Backend features and bug fixes for the Acme app: reports, scheduler, auth and API hardening.",
  acceptance: "merged_to_default_branch_by_other",
};
