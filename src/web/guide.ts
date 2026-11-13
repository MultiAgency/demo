import type { IconName } from "./components/icons";
import type { SetupStage } from "./types";

export type StepId = "rep-sign" | "contractor-sign" | "setup" | "create" | "consent" | "grant" | "policy" | "fund";
export type Phase = "agree" | "platform" | "live";

export interface SetupStep {
  id: StepId;
  phase: Phase;
  icon: IconName;
  title: string;
  short: string;
  help: string[];
  /** The step is done once the contract's stage is past this one. */
  stage: SetupStage;
}

/** Order of the server's setup stages; a step is done when the contract has moved past its stage. */
export const STAGE_ORDER: SetupStage[] = ["needs_signatures", "needs_setup", "needs_create", "needs_consent", "needs_grant", "needs_policy", "policy_pending", "needs_funding", "active"];

/** Setup checklist. One line each; the help bullets open on demand. */
export const SETUP: SetupStep[] = [
  {
    id: "rep-sign",
    phase: "agree",
    stage: "needs_signatures",
    icon: "pen",
    title: "Representative signs",
    short: "Sign the terms hash with your NEAR wallet.",
    help: ["An off-chain NEP-413 signature: no gas, no transaction.", "Changing any term changes the hash, so the signature stops matching."],
  },
  {
    id: "contractor-sign",
    phase: "agree",
    stage: "needs_signatures",
    icon: "user",
    title: "Builder signs",
    short: "Send the private link. They sign the same hash.",
    help: ["They see the terms in plain language and sign with their own wallet.", "Both keys are checked as full-access keys of the named accounts."],
  },
  {
    id: "setup",
    phase: "platform",
    stage: "needs_setup",
    icon: "building",
    title: "Set up Paperwork on the platform",
    short: "One platform Organization for this job.",
    help: ["Your wallet signs a setup message for the payables area.", "One Organization per job keeps its payee, balance and limits apart from every other job."],
  },
  {
    id: "create",
    phase: "platform",
    stage: "needs_create",
    icon: "wallet",
    title: "Create the job agent",
    short: "A payout agent you own.",
    help: ["Paperwork never holds the owner key. It holds only its app credential."],
  },
  {
    id: "consent",
    phase: "platform",
    stage: "needs_consent",
    icon: "key",
    title: "Give Paperwork access",
    short: "Payouts until the end date; read and approvals a little longer.",
    help: ["Two consents: payout ends at the job's end date; owner and read run for a grace period so you can still approve or reject.", "You can revoke either on the platform."],
  },
  {
    id: "grant",
    phase: "platform",
    stage: "needs_grant",
    icon: "key",
    title: "Issue the payout grant",
    short: "Lets the agent pay at all.",
    help: ["The platform chooses the grant's expiry; the payout consent is what ends at the job's end date."],
  },
  {
    id: "policy",
    phase: "platform",
    stage: "needs_policy",
    icon: "shield",
    title: "Apply the job's policy",
    short: "Only the payee, no payment above the signed cap, your approval on every payout.",
    help: ["One policy edit, signed by you: withdrawals to the payee, per-payment cap, owner approval, budget.", "Paperwork checks the policy is in force before every payout."],
  },
  {
    id: "fund",
    phase: "platform",
    stage: "needs_funding",
    icon: "coins",
    title: "Fund the agent",
    short: "Deposit the scope total in USDC.",
    help: ["Deposit the agreed scope total. Paperwork keeps payout proposals within the signed job terms.", "For Report and invoice, compensation is proposed from completed scope value, less existing commitments and capped by the invoice. Pay on merge judges merged PRs against the scope."],
  },
];

export const PHASES: { id: Phase; label: string }[] = [
  { id: "agree", label: "Agree" },
  { id: "platform", label: "Set up on the platform" },
  { id: "live", label: "Live" },
];
