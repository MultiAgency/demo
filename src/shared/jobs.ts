import { z } from "zod";
import { isDecimal, normalizeDecimal } from "./money";

export const jobSubmissionSchema = z.object({
  client_request_id: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/),
  report: z.string().trim().min(10).max(12000),
  evidence: z.array(z.object({
    deliverable_id: z.string(),
    label: z.string().trim().min(3).max(200),
    // References are data. The server never fetches a supplied URL.
    url: z.string().url().max(2000).refine((url) => new URL(url).protocol === "https:", "Use an HTTPS evidence URL"),
  }).strict()).min(1).max(30),
  invoice: z.object({
    number: z.string().trim().min(1).max(100),
    amount_usd: z.string().trim().refine(isDecimal, "Use a plain decimal amount")
      .transform(normalizeDecimal).refine((v) => Number(v) > 0 && (v.split(".")[1]?.length ?? 0) <= 6, "Use a positive amount with at most six decimals"),
  }).strict(),
}).strict();

export type JobSubmissionInput = z.input<typeof jobSubmissionSchema>;
export type JobSubmission = z.infer<typeof jobSubmissionSchema>;
export type JobSubmissionState = "submitted" | "proposed" | "changes_pending" | "changes_requested" | "settled" | "closed";

export interface JobSubmissionView {
  id: string;
  revision: number;
  terms_hash: string;
  builder: string;
  report: string;
  evidence: JobSubmission["evidence"];
  invoice: { id: string; number: string; amount_usd: string };
  state: JobSubmissionState;
  changes: string | null;
  judgment_id: string | null;
  proposed_usd: string;
  paid_usd: string;
  payout_request_ids: string[];
  created_at: string;
}
