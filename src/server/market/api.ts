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
/** Any JSON object, before its own fields are trusted. */
const recordSchema = z.record(z.string(), z.unknown());
// The fields Paperwork keeps from `AgentPublic`, `PricingPlan`, `ReputationResponse` and `MyAssignmentItem`
// (OpenAPI 2.0.0, read 2026-11-14). Identity, price and status must be present as published; nothing is coerced.
const directorySchema = z.object({ agents: z.array(z.object({
  agent_id: z.string().min(1), handle: z.string().min(1), name: z.string(), description: z.string().nullish(),
  sla_seconds: z.number().int(), delivered_jobs: z.number().int(), success_rate: z.number().nullish(),
})) });
const plansSchema = z.array(z.object({
  display_name: z.string().nullish(), model: z.string().min(1), price_amount: z.string().min(1),
  is_default: z.boolean().optional(), sla_seconds: z.number().int().nullish(),
}));
const reputationSchema = z.object({ overall: z.number().nullish(), jobs_counted: z.number().int() });
const assignmentsSchema = z.object({ assignments: z.array(z.object({
  assignment: z.object({
    assignmentId: z.string().min(1), jobId: z.string().min(1), status: z.string().min(1),
    escrowAmount: z.string().nullish(), escrowToken: z.string().nullish(), slaDeadlineAt: z.string().nullish(),
  }),
  job: z.object({ title: z.string().optional(), description: z.string().optional() }).nullish(),
})) });
const versionsSchema = z.object({ versions: z.array(z.object({
  version: z.number().int().min(1).max(2147483647), files: z.array(z.unknown()),
  submittedAt: z.string().regex(/T.*(?:Z|[+-]\d\d:\d\d)$/).refine((at) => Number.isFinite(Date.parse(at))),
})) });
const submittedSchema = z.object({ status: z.enum(["submitted", "accepted"]), assignmentId: z.string().optional() });

/** A 2xx answer that does not match what the Market publishes is a failed read. */
function read<T>(schema: z.ZodType<T>, body: unknown, message: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new MarketHttpError(200, message);
  return parsed.data;
}

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

  private async answer(method: "GET" | "POST", path: string, body?: unknown, auth = false, format: "json" | "markdown" = "json"): Promise<{ status: number; text: string }> {
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
    return { status: res.status, text };
  }

  /** The parsed answer, untrusted until its caller reads it through a schema. */
  private async request(method: "GET" | "POST", path: string, body?: unknown, auth = false): Promise<unknown> {
    const { status, text } = await this.answer(method, path, body, auth);
    try {
      return JSON.parse(text);
    } catch {
      throw new MarketHttpError(status, `The market's answer to ${path.split("?")[0]} is not JSON.`);
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
    const body = read(z.object({ jobs: z.array(z.unknown()).max(BOARD_PAGE_SIZE + 1) }), await this.request("GET", `/v1/jobs/board?${params}`, undefined, true),
      "The market returned an invalid public job board page.");
    const rows = body.jobs.map(publicBoardJob);
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
    const row = read(recordSchema, await this.request("GET", `/v1/jobs/${encodeURIComponent(jobId)}`, undefined, true), "The market returned an invalid job record.");
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
    const body = read(directorySchema, await this.request("GET", `/v1/agents?q=${encodeURIComponent(q)}&limit=20`), "The market returned an invalid agent directory.");
    return body.agents.map((a) => ({
      agent_id: a.agent_id,
      handle: a.handle,
      name: a.name,
      description: a.description ?? null,
      sla_seconds: a.sla_seconds,
      delivered_jobs: a.delivered_jobs,
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
    const rep = reputation === null ? null : read(reputationSchema, reputation, "The market returned an invalid agent reputation.");
    return {
      plans: read(plansSchema, plans, "The market returned invalid pricing plans for this agent.")
        .map((p) => ({ name: p.display_name ?? null, model: p.model, price_amount: p.price_amount, is_default: p.is_default === true, sla_seconds: p.sla_seconds ?? null })),
      reputation: rep ? { overall: rep.overall ?? null, jobs_counted: rep.jobs_counted } : null,
    };
  }

  /** Every assignment of the token's agent, newest first. */
  async assignments(): Promise<MarketAssignment[]> {
    const body = read(assignmentsSchema, await this.request("GET", "/v1/agents/me/assignments?status=all&limit=100", undefined, true),
      "The market returned an invalid assignment list for this agent.");
    return body.assignments.map(({ assignment: a, job: j }) => ({
      assignmentId: a.assignmentId,
      jobId: a.jobId,
      status: a.status,
      escrowAmount: a.escrowAmount ?? null,
      escrowToken: a.escrowToken ?? null,
      slaDeadlineAt: a.slaDeadlineAt ?? null,
      title: j?.title ?? "",
      description: j?.description ?? "",
    }));
  }

  /**
   * Complete authenticated history, oldest first. Public contract read 2026-11-11:
   * https://market.near.ai/openapi.json (DeliverableVersionsResponse),
   * https://market.near.ai/skill/reference/agent-api.md. No shared client/server clock is promised.
   */
  async deliverableVersions(assignmentId: string): Promise<DeliverableVersion[]> {
    // An absent or malformed list is a failed read, never evidence that the submission did not arrive.
    const body = read(versionsSchema, await this.request("GET", `/v1/assignments/${encodeURIComponent(assignmentId)}/deliverable/versions`, undefined, true),
      "The market returned no valid deliverable version list for this job.");
    const versions: DeliverableVersion[] = body.versions.map((v) => ({ version: v.version, submittedAt: v.submittedAt }));
    if (versions.some((v, i) => i > 0 && v.version <= versions[i - 1]!.version))
      throw new MarketHttpError(200, "The market returned a conflicting deliverable version history for this job.");
    return versions;
  }

  /** Exact managed Markdown from the OpenAPI version/raw route above; never follow an external deliverable URL. */
  async deliverableMarkdown(assignmentId: string, version: number): Promise<string> {
    return (await this.answer("GET", `/v1/assignments/${encodeURIComponent(assignmentId)}/deliverable/versions/${version}/raw`, undefined, true, "markdown")).text;
  }

  /** Submits the deliverable as the agent. Answers the assignment's new status. */
  async submit(assignmentId: string, deliverableMarkdown: string): Promise<{ status: string }> {
    const unconfirmed = "The market returned no confirmed submission state for this job; check its assignments before submitting again.";
    // A successful HTTP status can follow an executed submission even when its body is unusable. It does not prove
    // refusal or allow another POST. Accept only a confirmed submission state for the original assignment.
    const a = read(submittedSchema, await this.request("POST", `/v1/assignments/${encodeURIComponent(assignmentId)}/submit`, { deliverableMarkdown }, true), unconfirmed);
    if (a.assignmentId !== undefined && a.assignmentId !== assignmentId) throw new MarketHttpError(200, unconfirmed);
    return { status: a.status };
  }
}
