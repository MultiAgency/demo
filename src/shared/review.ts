import { z } from "zod";

/** Model output is a draft; citations resolve only against this submission's supplied data. */
export const reviewResultSchema = z.object({
  summary: z.string().trim().min(1).max(1200),
  findings: z.array(z.object({
    deliverable_id: z.string().min(1).max(200),
    status: z.enum(["supported", "needs_clarification", "missing_evidence"]),
    comment: z.string().trim().min(1).max(1500),
    report_quotes: z.array(z.string().min(1).max(800)).max(5),
    evidence_indices: z.array(z.number().int().min(0).max(29)).max(30),
  }).strict()).min(1).max(100),
  feedback: z.string().trim().max(2000),
}).strict();

export type ReviewResult = z.infer<typeof reviewResultSchema>;

export interface ReviewContext {
  submission_id: string;
  terms_hash: string;
  revision: number;
  scope: { id: string; title: string; criteria: string }[];
  report: string;
  evidence: { deliverable_id: string; url: string; label: string }[];
  invoice: { number: string; amount_usd: string };
}

export type ReviewProgress =
  | { type: "status"; stage: "connecting" | "reviewing" | "validating" }
  | { type: "complete"; review: ReviewResult; verification?: ReviewVerification };

/** Compact server observation; the browser does not receive credentials or raw attestation reports. */
export interface ReviewVerification {
  backend: "near";
  model: string;
  signature_kind: "provider_tee";
  encrypted: true;
  gateway_tls_bound: true;
  record_sha256: string;
}

export interface ReviewState {
  progress: string;
  result?: ReviewResult;
  verification?: ReviewVerification;
}
