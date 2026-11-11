// The NEAR AI Agent Market's own HTTP API (OpenAPI 2.0.0, read 2026-11-10): the public directory, and the worker's
// assignments and submissions with its `aat_` token. The token stays in this object: never logged, never returned.
import type { DirectoryAgent, DirectoryDetail } from "../../shared/market";

export class MarketHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One of the agent's assignments as `GET /v1/agents/me/assignments` lists it (`MyAssignmentItem`), as Covenant keeps it. */
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

const READ_MS = 15_000;

export class MarketApi {
  constructor(
    readonly base: string,
    private readonly token: string | null = null,
    private readonly send: typeof fetch = fetch,
  ) {}

  private async request(method: "GET" | "POST", path: string, body?: unknown, auth = false): Promise<any> {
    if (auth && !this.token) throw new MarketHttpError(0, "No market agent token is configured (MARKET_AGENT_TOKEN).");
    let res: Response;
    try {
      res = await this.send(`${this.base.replace(/\/+$/, "")}${path}`, {
        method,
        headers: { accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }), ...(auth && { authorization: `Bearer ${this.token}` }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(READ_MS),
      });
    } catch (err) {
      throw new MarketHttpError(0, `The market did not answer (${err instanceof Error ? err.name : "error"}).`);
    }
    const text = await res.text();
    if (!res.ok) throw new MarketHttpError(res.status, `The market answered ${res.status} to ${method} ${path.split("?")[0]}.`);
    try {
      return JSON.parse(text);
    } catch {
      throw new MarketHttpError(res.status, `The market's answer to ${path.split("?")[0]} is not JSON.`);
    }
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

  /** Submits the deliverable as the agent. Answers the assignment's new status. */
  async submit(assignmentId: string, deliverableMarkdown: string): Promise<{ status: string }> {
    const a = await this.request("POST", `/v1/assignments/${encodeURIComponent(assignmentId)}/submit`, { deliverableMarkdown }, true);
    return { status: String(a.status) };
  }
}
