import { z } from "zod";

const text = z.string().max(20_000);
export const jobDraftSchema = z.object({
  workflow: z.enum(["report_and_invoice", "merged_to_default_branch_by_other"]),
  title: text.default(""), description: text.default(""), company: text, rep: text, dao: text, contractorName: text, github: text,
  contractorAccount: text, payee: text, start: text, end: text, reviewDays: text.default(""), repos: text,
  scope: z.array(z.object({ id: text, title: text, criteria: text, value_usd: text })).max(10),
  /** An imported Agent Market job, signed into the terms as the offer's source. */
  marketJobId: z.string().max(64).optional(),
  /** With a Market source: true when the Market (already awarded) settles the job instead of the platform. */
  marketSettled: z.boolean().optional(),
});
export type JobDraft = z.infer<typeof jobDraftSchema>;

/** Origin and tab isolation come from sessionStorage; the key also isolates signed-in accounts. */
export function jobDraftKey(account: string): string {
  return `paperwork.job-draft.v1:${encodeURIComponent(account)}`;
}

export function readJobDraft(storage: Pick<Storage, "getItem">, key: string): JobDraft | null {
  try {
    const raw = storage.getItem(key);
    if (!raw || raw.length > 256_000) return null;
    const result = jobDraftSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch { return null; }
}

export function saveJobDraft(storage: Pick<Storage, "setItem">, key: string, draft: JobDraft): boolean {
  try {
    const parsed = jobDraftSchema.safeParse(draft);
    if (!parsed.success) return false;
    const raw = JSON.stringify(parsed.data);
    if (raw.length > 256_000) return false;
    storage.setItem(key, raw);
    return true;
  } catch { return false; }
}
