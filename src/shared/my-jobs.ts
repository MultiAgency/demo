import type { SetupStage } from "./views";

export interface JobAttention {
  state: "needs_action" | "waiting" | "completed";
  summary: string;
  detail: string;
  /** Navigation to an existing authorized view only; never prepares or submits an action. */
  actions: { role: "agency" | "builder"; label: string }[];
}

/** Private account-scoped discovery of existing Paperwork records, never a public job posting. */
export interface MyJob {
  /** Original contract/job identity; discovery creates no new record or invitation. */
  id: string;
  title: string;
  company: string;
  builder_name: string;
  scope_usd: string;
  start: string;
  end: string;
  /** Stored setup progress, not a submission, approval or confirmed-payment state. */
  stage: SetupStage;
  roles: ("agency" | "builder")[];
  builder_accepted: boolean;
  workflow: "report_invoice" | "pay_on_merge";
  attention: JobAttention;
}
