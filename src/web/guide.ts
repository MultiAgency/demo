import type { IconName } from "./components/icons";

export type StepId = "rep-sign" | "contractor-sign" | "wallet" | "grant" | "fund";
export type Phase = "agree" | "wallet" | "live";

export interface SetupStep {
  id: StepId;
  phase: Phase;
  icon: IconName;
  title: string;
  short: string;
  help: string[];
}

/** Setup checklist. One line each; the help bullets open on demand. */
export const SETUP: SetupStep[] = [
  {
    id: "rep-sign",
    phase: "agree",
    icon: "pen",
    title: "Representative signs",
    short: "Sign the terms hash with your NEAR wallet.",
    help: ["An off-chain NEP-413 signature: no gas, no transaction.", "Changing any term changes the hash, so the signature stops matching."],
  },
  {
    id: "contractor-sign",
    phase: "agree",
    icon: "user",
    title: "Contractor signs",
    short: "Send the private link. They sign the same hash.",
    help: ["They see the terms in plain language and sign with their own wallet.", "Both keys are checked as full-access keys of the named accounts."],
  },
  {
    id: "wallet",
    phase: "wallet",
    icon: "wallet",
    title: "Create the contract wallet",
    short: "One agent wallet whose policy is compiled from these terms.",
    help: ["Only the payee, at most the cap, with a cancel window. Never edited later.", "Your wallet signs it. Covenant never holds the owner key."],
  },
  {
    id: "grant",
    phase: "wallet",
    icon: "key",
    title: "Give the agent permission",
    short: "A grant that expires exactly at the contract end.",
    help: ["After the end date the grant is dead, so NEAR refuses every payout.", "Stored encrypted. Revocable by the owner."],
  },
  {
    id: "fund",
    phase: "wallet",
    icon: "coins",
    title: "Fund the wallet",
    short: "Deposit at least one month's cap in USDC.",
    help: ["Funds sit in this contract's wallet only.", "However much it holds, it can never pay more than the policy allows."],
  },
];

export const PHASES: { id: Phase; label: string }[] = [
  { id: "agree", label: "Agree" },
  { id: "wallet", label: "Set up wallet" },
  { id: "live", label: "Live" },
];
