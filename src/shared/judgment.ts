import { z } from "zod";

/** Completion levels a judge may give a deliverable. Coarse on purpose: easy to audit, hard to game. */
export const LEVELS = [0, 0.25, 0.5, 0.75, 1] as const;
export type Level = (typeof LEVELS)[number];

const prReviewSchema = z.object({
  key: z.string(), // repo#number
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  merged_at: z.string(),
  eligible: z.boolean(),
  deliverable: z.string().nullable(),
  reason: z.string(),
  flags: z.array(z.string()),
});

const deliverableJudgmentSchema = z.object({
  id: z.string(),
  completion: z.literal(LEVELS),
  prs: z.array(z.string()),
  reason: z.string(),
});

/**
 * One assessment as a judge returns it and as it is stored (`judgments.json`, `job_submissions.assessment`).
 * Completion becomes money, so a stored record is read back through this schema and never coerced.
 */
export const judgmentSchema = z.object({
  judge: z.enum(["rules", "near-ai"]),
  model: z.string().optional(),
  completion_id: z.string().optional(),
  decision: z.enum(["pay", "escalate"]),
  summary: z.string(),
  prs: z.array(prReviewSchema),
  deliverables: z.array(deliverableJudgmentSchema),
});

export type PrReview = z.infer<typeof prReviewSchema>;
export type DeliverableJudgment = z.infer<typeof deliverableJudgmentSchema>;
export type Judgment = z.infer<typeof judgmentSchema>;
