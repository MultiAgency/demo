// The NEAR AI Agent Market's own HTTP API (OpenAPI 2.0.0, read 2026-11-10): the public directory, and the worker's
// assignments and submissions with its `aat_` token. The token stays in this object: never logged, never returned.
import type { DirectoryAgent, DirectoryDetail } from "../../shared/market";
import type { BoardJob, BoardQuery, MarketJobSource, OpenJobsPage } from "../../shared/market-board";
import { z } from "zod";

export class MarketHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One of the agent's assignments as `GET /v1/agents/me/assignments` lists it (`MyAssignmentItem`), as Paperwork keeps it. */
export interface MarketAssignment {
  assignmentId: string;
  jobId: string;
  status: string;
  escrowAmount: string | null;
  escrowToken: string | null;
  slaDeadlineAt: string | null;
  title: string;
  description: string;
}

/** The market's immutable numbered history, read with the assignment worker's bearer. */
export interface DeliverableVersion {
  version: number;
  submittedAt: string;
}

const READ_MS = 15_000;
const BOARD_PAGE_SIZE = 50;
const marketJobFields = {
  jobId: z.uuid(),
  title: z.string().min(1),
  description: z.string(),
  budgetAmount: z.string().regex(/^\d+(?:\.\d+)?$/).nullable().optional(),
  budgetToken: z.string().min(1),
  jobKind: z.enum(["standard", "instant", "competition"]),
  status: z.enum(["open", "filling"]),
  tags: z.array(z.string()),
  createdAt: z.iso.datetime({ offset: true }),
  creator: z.object({ displayName: z.string() }).nullable().optional(),
  currentMaxSlots: z.number().int().min(0).max(2147483647),
  maxSlots: z.number().int().min(1).max(2147483647),
  acceptanceWindowDays: z.number().int().min(0).max(2147483647),
  minBuilderVerification: z.enum(["none", "verified", "identity_verified"]),
  entriesCloseAt: z.iso.datetime({ offset: true }).nullable().optional(),
};
const boardJobSchema = z.object(marketJobFields).refine((job) => job.currentMaxSlots <= job.maxSlots);
/** A single job read by id: the same public record, at any lifecycle status. */
const marketJobSchema = z.object({ ...marketJobFields, status: z.enum(["open", "filling", "in_progress", "completed", "closed"]) });

function publicBoardJob(value: unknown): BoardJob | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MarketHttpError(200, "The market returned an invalid job board record.");
  const row = value as Record<string, unknown>;
  // Exclude non-public records before reading their other fields; the bearer may also authorize private data.
  if (row.isPrivate === true || row.isTestRun === true || (typeof row.status === "string" && row.status !== "open" && row.status !== "filling")) return null;
  if (row.isPrivate !== false || row.isTestRun !== false || (row.status !== "open" && row.status !== "filling"))
    throw new MarketHttpError(200, "The market returned no explicit public job board classification.");
  const parsed = boardJobSchema.safeParse(row);
  if (!parsed.success) throw new MarketHttpError(200, "The market returned an invalid public job board record.");
  const job = parsed.data;
  return {
    job_id: job.jobId, title: job.title, description: job.description,
    budget_amount: job.budgetAmount ?? null, budget_token: job.budgetToken,
    kind: job.jobKind, status: job.status, tags: job.tags, posted_at: job.createdAt,
    creator_name: job.creator?.displayName ?? null,
    slots_available: job.currentMaxSlots, max_slots: job.maxSlots,
    acceptance_window_days: job.acceptanceWindowDays, minimum_verification: job.minBuilderVerification,
    entries_close_at: job.entriesCloseAt ?? null,
  };
}

export class MarketApi {
  constructor(
    readonly base: string,
    private readonly token: string | null = null,
    private readonly send: typeof fetch = fetch,
  ) {}

  private async request(method: "GET" | "POST", path: string, body?: unknown, auth = false, format: "json" | "markdown" = "json"): Promise<any> {
    if (auth && !this.token) throw new MarketHttpError(0, "No market agent token is configured (MARKET_AGENT_TOKEN).");
    let res: Response;
    try {
      res = await this.send(`${this.base.replace(/\/+$/, "")}${path}`, {
        method,
        headers: { accept: format === "json" ? "application/json" : "text/markdown", ...(body !== undefined && { "content-type": "application/json" }), ...(auth && { authorization: `Bearer ${this.token}` }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(READ_MS),
      });
    } catch (err) {
      throw new MarketHttpError(0, `The market did not answer (${err instanceof Error ? err.name : "error"}).`);
    }
    const text = await res.text();
    if (!res.ok) throw new MarketHttpError(res.status, `The market answered ${res.status} to ${method} ${path.split("?")[0]}.`);
    if (format === "markdown") return text;
    try {
      return JSON.parse(text);
    } catch {
      throw new MarketHttpError(res.status, `The market's answer to ${path.split("?")[0]} is not JSON.`);
    }
  }

  /** Authenticated upstream, public output: only the board's public jobs still taking bids, never scoped /v1/jobs. */
  async openJobs(query: BoardQuery = {}): Promise<OpenJobsPage> {
    const offset = query.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - BOARD_PAGE_SIZE ||
      (query.q !== undefined && typeof query.q !== "string") ||
      (query.kind !== undefined && !["standard", "instant", "competition"].includes(query.kind)) ||
      (query.sort !== undefined && !["recent", "budget"].includes(query.sort)))
      throw new MarketHttpError(400, "Invalid public job board query.");
    const params = new URLSearchParams({ sort: query.sort ?? "recent", limit: String(BOARD_PAGE_SIZE + 1), offset: String(offset) });
    if (query.q !== undefined) params.set("q", query.q);
    if (query.kind !== undefined) params.set("kind", query.kind);
    const body = await this.request("GET", `/v1/jobs/board?${params}`, undefined, true);
    if (!body || typeof body !== "object" || !Array.isArray(body.jobs) || body.jobs.length > BOARD_PAGE_SIZE + 1)
      throw new MarketHttpError(200, "The market returned an invalid public job board page.");
    const rows = (body.jobs as unknown[]).map(publicBoardJob);
    return {
      jobs: rows.slice(0, BOARD_PAGE_SIZE).filter((job): job is BoardJob => job !== null),
      offset, next_offset: rows.length > BOARD_PAGE_SIZE ? offset + BOARD_PAGE_SIZE : null,
      checked_at: new Date().toISOString(),
    };
  }

  /**
   * One public job by id (`GET /v1/jobs/{id}`; an `aat_` bearer reads public jobs). Private and test jobs are refused
   * before their other fields are read, exactly as on the board.
   */
  async job(jobId: string): Promise<MarketJobSource> {
    if (!z.uuid().safeParse(jobId).success) throw new MarketHttpError(400, "A Market job id is a UUID.");
    const row = await this.request("GET", `/v1/jobs/${encodeURIComponent(jobId)}`, undefined, true);
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new MarketHttpError(200, "The market returned an invalid job record.");
    if (row.isPrivate !== false || row.isTestRun !== false) throw new MarketHttpError(404, "Only public Market jobs can be imported.");
    const parsed = marketJobSchema.safeParse(row);
    if (!parsed.success || parsed.data.jobId !== jobId) throw new MarketHttpError(200, "The market returned an invalid job record.");
    const job = parsed.data;
    return {
      job_id: job.jobId, title: job.title, description: job.description,
      budget_amount: job.budgetAmount ?? null, budget_token: job.budgetToken, kind: job.jobKind, status: job.status,
      acceptance_window_days: job.acceptanceWindowDays, checked_at: new Date().toISOString(),
    };
  }

  /** Listed agents matching `q` (public). */
  async browse(q: string): Promise<DirectoryAgent[]> {
    const body = await this.request("GET", `/v1/agents?q=${encodeURIComponent(q)}&limit=20`);
    return (body.agents as any[]).map((a) => ({
      agent_id: String(a.agent_id),
      handle: String(a.handle),
      name: String(a.name),
      description: a.description ?? null,
      sla_seconds: Number(a.sla_seconds),
      delivered_jobs: Number(a.delivered_jobs),
      success_rate: a.success_rate ?? null,
    }));
  }

  /** A listed agent's pricing plans and reputation (public). The price paid is the quote's, not the plan's. */
  async detail(agentId: string): Promise<DirectoryDetail> {
    const id = encodeURIComponent(agentId);
    const [plans, reputation] = await Promise.all([
      this.request("GET", `/v1/agents/${id}/pricing-plans`),
      this.request("GET", `/v1/agents/${id}/reputation`).catch((err) => {
        if (err instanceof MarketHttpError && err.status === 404) return null;
        throw err;
      }),
    ]);
    return {
      plans: (plans as any[]).map((p) => ({ name: p.display_name ?? null, model: String(p.model), price_amount: String(p.price_amount), is_default: p.is_default === true, sla_seconds: p.sla_seconds ?? null })),
      reputation: reputation ? { overall: reputation.overall ?? null, jobs_counted: Number(reputation.jobs_counted) } : null,
    };
  }

  /** Every assignment of the token's agent, newest first. */
  async assignments(): Promise<MarketAssignment[]> {
    const body = await this.request("GET", "/v1/agents/me/assignments?status=all&limit=100", undefined, true);
    return (body.assignments as any[]).map(({ assignment: a, job: j }) => ({
      assignmentId: String(a.assignmentId),
      jobId: String(a.jobId),
      status: String(a.status),
      escrowAmount: a.escrowAmount ?? null,
      escrowToken: a.escrowToken ?? null,
      slaDeadlineAt: a.slaDeadlineAt ?? null,
      title: String(j?.title ?? ""),
      description: String(j?.description ?? ""),
    }));
  }

  /**
   * Complete authenticated history, oldest first. Public contract read 2026-11-11:
   * https://market.near.ai/openapi.json (DeliverableVersionsResponse),
   * https://market.near.ai/skill/reference/agent-api.md. No shared client/server clock is promised.
   */
  async deliverableVersions(assignmentId: string): Promise<DeliverableVersion[]> {
    const body = await this.request("GET", `/v1/assignments/${encodeURIComponent(assignmentId)}/deliverable/versions`, undefined, true);
    // An absent or malformed list is a failed read, never evidence that the submission did not arrive.
    if (!body || !Array.isArray(body.versions) || !body.versions.every((v: any) =>
      v && typeof v === "object" && Number.isInteger(v.version) && v.version >= 1 && v.version <= 2147483647 && Array.isArray(v.files) &&
      typeof v.submittedAt === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(v.submittedAt) && Number.isFinite(Date.parse(v.submittedAt))))
      throw new MarketHttpError(200, "The market returned no valid deliverable version list for this job.");
    const versions: DeliverableVersion[] = body.versions.map((v: any) => ({ version: v.version as number, submittedAt: v.submittedAt as string }));
    if (versions.some((v: DeliverableVersion, i: number) => i > 0 && v.version <= versions[i - 1]!.version))
      throw new MarketHttpError(200, "The market returned a conflicting deliverable version history for this job.");
    return versions;
  }

  /** Exact managed Markdown from the OpenAPI version/raw route above; never follow an external deliverable URL. */
  async deliverableMarkdown(assignmentId: string, version: number): Promise<string> {
    return this.request("GET", `/v1/assignments/${encodeURIComponent(assignmentId)}/deliverable/versions/${version}/raw`, undefined, true, "markdown");
  }

  /** Submits the deliverable as the agent. Answers the assignment's new status. */
  async submit(assignmentId: string, deliverableMarkdown: string): Promise<{ status: string }> {
    const a = await this.request("POST", `/v1/assignments/${encodeURIComponent(assignmentId)}/submit`, { deliverableMarkdown }, true);
    // A successful HTTP status can follow an executed submission even when its body is unusable. It does not prove
    // refusal or allow another POST. Accept only a confirmed submission state for the original assignment.
    if (!a || typeof a !== "object" || (a.status !== "submitted" && a.status !== "accepted") || (a.assignmentId !== undefined && a.assignmentId !== assignmentId))
      throw new MarketHttpError(200, "The market returned no confirmed submission state for this job; check its assignments before submitting again.");
    return { status: a.status };
  }
}
