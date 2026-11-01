/** Guide text for every wizard step. Used by the step panels and the in-app guide page. */

export type StepId = "draft" | "rep-sign" | "contractor-sign" | "wallet" | "grant" | "fund" | "pay" | "verify" | "attack";

export interface StepGuide {
  id: StepId;
  n: number;
  title: string;
  who: "Representative" | "Contractor" | "Agent" | "Anyone";
  short: string;
  what: string[];
  enforced: string[];
  check: string[];
}

export const STEPS: StepGuide[] = [
  {
    id: "draft",
    n: 1,
    title: "Draft the work order",
    who: "Representative",
    short: "Write down who gets paid, how much, for what, and until when.",
    what: [
      "You fill in the terms: payee account, monthly cap, rate per accepted pull request, start and end dates, repositories and scope.",
      "Covenant turns the terms into canonical JSON and hashes it (sha256). That hash is what both people sign.",
    ],
    enforced: ["Nothing yet. A draft is only text until both parties sign it."],
    check: ["The payee account is right. Money can only ever go there.", "The monthly cap is the most this contract can ever pay in a month."],
  },
  {
    id: "rep-sign",
    n: 2,
    title: "Representative signs",
    who: "Representative",
    short: "The company's representative signs the terms hash with their NEAR wallet.",
    what: [
      "Your wallet signs the message “Covenant work order sha256:<hash>” (NEP-413, an off-chain signature; no gas, no transaction).",
      "Covenant checks the signature and that the key is a full-access key of your NEAR account.",
    ],
    enforced: ["Changing any term changes the hash, so the signature no longer matches."],
    check: ["The hash in your wallet popup matches the hash shown on this page."],
  },
  {
    id: "contractor-sign",
    n: 3,
    title: "Contractor signs",
    who: "Contractor",
    short: "The contractor opens their private link and signs the same hash.",
    what: [
      "Send the contractor their signing link. They read the terms in plain language and sign the same hash with their own wallet.",
      "Both signatures are stored with the contract and can be re-checked by anyone at any time.",
    ],
    enforced: ["The contract wallet can only be created after both signatures verify."],
    check: ["Contractor: the payee address is yours, and the cap and dates are what you agreed."],
  },
  {
    id: "wallet",
    n: 4,
    title: "Create the contract wallet",
    who: "Representative",
    short: "One NEAR Intents agent wallet for this one contract, with the contract compiled into its policy.",
    what: [
      "Covenant compiles the signed terms into an agent policy: withdraw only, USDC only, only to the payee, per-payment and monthly limits equal to the cap, and a cancel window (timelock).",
      "Your wallet signs agent_create. The server never holds your owner key.",
      "The policy is never edited afterwards. Changing a contract means signing a new one.",
    ],
    enforced: [
      "Destination: only the payee.",
      "Amount: at most the cap per payment and per month, plus a USD budget backstop.",
      "Timelock: every payment waits in a queue so you can cancel it.",
    ],
    check: ["The policy preview lists only the payee and the cap you signed."],
  },
  {
    id: "grant",
    n: 5,
    title: "Give the agent its permission",
    who: "Representative",
    short: "Issue a grant to the Covenant agent that expires exactly when the contract ends.",
    what: [
      "A grant is the revocable credential the agent uses to ask for payments. It is issued by an owner signature and stored encrypted.",
      "Its expiry is the contract end date, so the term clause needs no reminder and no later action.",
    ],
    enforced: ["After the end date the grant has expired, so NEAR Intents refuses every payout request from the agent."],
    check: ["The grant expiry shown equals the contract end (23:59:59 UTC on the end date)."],
  },
  {
    id: "fund",
    n: 6,
    title: "Fund the wallet",
    who: "Representative",
    short: "Deposit USDC into the contract wallet.",
    what: [
      "Deposit at least one month's cap. In the simulator this is a button; on mainnet it is a deposit to the agent's address.",
      "Funds sit in this contract's wallet only. Other contracts have their own wallets and limits.",
    ],
    enforced: ["The wallet can never pay more than the policy allows, however much it holds."],
    check: ["Contractor: the Verify page shows the wallet covers this month's remaining cap."],
  },
  {
    id: "pay",
    n: 7,
    title: "The agent pays",
    who: "Agent",
    short: "At period end the agent reviews merged PRs, decides, and sends the payout on its own.",
    what: [
      "Evidence: pull requests by the contractor, merged by someone else, in the contract's repos, inside the period.",
      "The scorer decides which PRs count and whether to pay or escalate. Code computes the amount: rate × accepted, never above what is left under the cap.",
      "The payout goes to NEAR Intents and waits out the timelock. You can cancel it in that window. Otherwise it dispatches.",
    ],
    enforced: ["Whatever the agent decides, the provider only lets it pay the payee, within the cap, before the end date."],
    check: ["Escalations (for example a PR that tries to instruct the reviewer) wait for your approval and are never sent automatically."],
  },
  {
    id: "verify",
    n: 8,
    title: "Contractor verifies",
    who: "Contractor",
    short: "Anyone with the link can check the live wallet against the signed contract.",
    what: [
      "Re-checks the terms hash and both signatures, reads the live policy from the provider, and compares it field by field with the policy compiled from the signed terms.",
      "Shows the grant expiry, the frozen state and the funded balance.",
    ],
    enforced: ["This page proves what the provider reports. It is a comparison, not a cryptographic proof."],
    check: ["All checks green. Any difference is listed field by field."],
  },
  {
    id: "attack",
    n: 9,
    title: "Try to break it",
    who: "Anyone",
    short: "Pretend our server is compromised and watch NEAR Intents refuse the bad payouts.",
    what: [
      "App-side checks are switched off. Each scenario sends a request straight to the provider with the agent's real grant.",
      "Overpay, redirect to a stranger, pay after the end date, and a prompt-injected PR that fools the AI into asking for $5,000.",
      "By default these are dry runs, so nothing can move. Each refusal is shown next to the contract clause it enforces.",
    ],
    enforced: ["The AI can be fooled; the wallet can't."],
    check: ["Every scenario ends refused, never allowed."],
  },
];

export function guideFor(id: StepId): StepGuide {
  return STEPS.find((s) => s.id === id)!;
}
