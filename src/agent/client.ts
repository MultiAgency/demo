import { agentIntentSchema, agentPreparedSchema, agentSignatureSchema, agentSignRequestSchema, agentVoteSchema,
  agentOperationId, agentJobId, type AgentIntentInput, type AgentPrepared, type AgentSignature } from "../shared/agent-contracts";
import type { Engine } from "../server/engine";
import type { JobSubmissionView } from "../shared/jobs";
import type { ContractView } from "../shared/views";
import { sha256Hex } from "../shared/canonical";

export type AgentTransport = (path: string, init?: RequestInit) => Promise<Response>;
export type AgentSnapshot = ReturnType<Engine["recordedJobSnapshot"]>;
export interface AgentFollow {
  operation_id: string;
  source: "stored_records";
  live_status_checked: false;
  snapshot: AgentSnapshot;
  submission: JobSubmissionView | null;
  /** Only authoritative recorded paid states count; manual resolutions remain distinct in snapshot. */
  payout: AgentSnapshot["payments"][number] | null;
}
export type AgentSubmitResult =
  | { kind: "offer"; operation_id: string; result: { id: string; contractor_link: string; contractor_token: string } }
  | { kind: "report"; operation_id: string; result: JobSubmissionView }
  | { kind: "accept" | "propose"; operation_id: string; result: ContractView }
  | { kind: "decision"; operation_id: string; result: Awaited<ReturnType<Engine["submitOwnerStep"]>> };
export class AgentApiError extends Error {
  constructor(readonly status: number, readonly body: unknown, readonly retryAfter: string | null) {
    super(`Agent API request failed (${status}); follow the original operation before retrying.`);
  }
}
const enc = encodeURIComponent;
/** No automatic retries, wallet access, arbitrary remote paths, or implicit provider reconciliation. */
export class AgentClient {
  constructor(private readonly transport: AgentTransport = (path, init) => fetch(path, { ...init, credentials: "same-origin" })) {}
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.transport(`/api${path}`, body === undefined ? { method: "GET", cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store",
    });
    const data: unknown = await response.json();
    if (!response.ok) throw new AgentApiError(response.status, data, response.headers.get("retry-after"));
    return data as T;
  }
  async prepare(input: AgentIntentInput): Promise<AgentPrepared> {
    const intent = agentIntentSchema.parse(input);
    const job_id = agentJobId(intent);
    let preparation: AgentPrepared["preparation"] = { kind: "ready" };
    if (intent.kind !== "offer") {
      const snapshot = await this.request<AgentSnapshot>(`/jobs/${enc(job_id)}/snapshot`);
      if (intent.kind === "accept") {
        const response = await this.request<unknown>(`/contracts/${enc(job_id)}/signing-request?role=${intent.role}`);
        preparation = { kind: "signature", sign: agentSignRequestSchema.parse(
          // The existing endpoint additionally returns its role.
          (({ account_id, message, recipient, nonce }) => ({ account_id, message, recipient, nonce }))(response as import("../shared/views").SignRequest)) };
      }
      if (intent.kind === "propose") {
        await this.request<JobSubmissionView>(`/contracts/${enc(job_id)}/submissions/${enc(intent.submission_id)}`);
      }
      if (intent.kind === "decision") {
        if (!snapshot.payments.some((p) => p.request_id === intent.payout_request_id)) throw Error("Payout does not belong to this job");
        preparation = { kind: "decision", vote: agentVoteSchema.parse(await this.request(
          `/payouts/${enc(intent.payout_request_id)}/vote`, { verdict: intent.verdict })) };
      }
    }
    return { schema_version: 1, operation_id: agentOperationId(intent), intent, job_id, preparation };
  }
  private prepared(input: AgentPrepared): AgentPrepared {
    const p = agentPreparedSchema.parse(input);
    if (p.operation_id !== agentOperationId(p.intent) || p.job_id !== agentJobId(p.intent)) throw Error("Prepared intent identity changed");
    const expected = p.intent.kind === "accept" ? "signature" : p.intent.kind === "decision" ? "decision" : "ready";
    if (p.preparation.kind !== expected) throw Error("Wrong preparation for this operation");
    return p;
  }
  async submit(input: AgentPrepared, authority: { signature?: AgentSignature; contractor_token?: string } = {}): Promise<AgentSubmitResult> {
    const p = this.prepared(input), i = p.intent, operation_id = p.operation_id;
    switch (i.kind) {
      case "offer": return { kind: i.kind, operation_id, result: await this.request("/contracts", i.terms) };
      case "report": return { kind: i.kind, operation_id, result: await this.request(`/contracts/${enc(p.job_id)}/submissions`, {
        ...i.submission, ...(authority.contractor_token ? { contractor_token: authority.contractor_token } : {}),
      }) };
      case "propose": {
        if (!(await this.follow(p)).submission) throw Error("Submission does not belong to this job");
        return { kind: i.kind, operation_id, result: await this.request(`/submissions/${enc(i.submission_id)}/propose`, {}) };
      }
      case "accept": {
        if (p.preparation.kind !== "signature") throw Error("Missing signing request");
        const signature = agentSignatureSchema.parse(authority.signature);
        return { kind: i.kind, operation_id, result: await this.request(`/contracts/${enc(p.job_id)}/signatures`, {
          role: i.role, signed: { account_id: p.preparation.sign.account_id, nonce: p.preparation.sign.nonce,
            public_key: signature.publicKey, signature: signature.signature }, contractor_token: authority.contractor_token,
        }) };
      }
      case "decision": {
        if (p.preparation.kind !== "decision" || !p.preparation.vote.sign) throw Error("Complete the original external confirmation or DAO flow; no wallet submission is available");
        const signature = agentSignatureSchema.parse(authority.signature);
        if (!(await this.follow(p)).payout) throw Error("Payout does not belong to this job");
        // This existing endpoint reconciles only the original owner step. It may contact the provider.
        const step = await this.request<Awaited<ReturnType<Engine["getOwnerStep"]>>>(`/owner-steps/${enc(p.preparation.vote.correlation_id)}`);
        if (step.request_id !== i.payout_request_id || step.verdict !== i.verdict) throw Error("Owner step does not match the explicit payout decision");
        return { kind: i.kind, operation_id, result: await this.request(`/owner-steps/${enc(p.preparation.vote.correlation_id)}/submit`, signature) };
      }
    }
  }
  async follow(input: AgentPrepared): Promise<AgentFollow> {
    const p = this.prepared(input), i = p.intent;
    const snapshot = await this.request<AgentSnapshot>(`/jobs/${enc(p.job_id)}/snapshot`);
    let submission: JobSubmissionView | null = null;
    if (i.kind === "report" || i.kind === "propose") {
      // Server submission identity derives from the original job and client request ID.
      const sid = i.kind === "propose" ? i.submission_id : `s_${sha256Hex(`${p.job_id}:${i.submission.client_request_id}`).slice(0, 24)}`;
      try { submission = await this.request<JobSubmissionView>(`/contracts/${enc(p.job_id)}/submissions/${enc(sid)}`); }
      catch (error) { if (!(error instanceof AgentApiError) || error.status !== 404) throw error; }
    }
    return { operation_id: p.operation_id, source: "stored_records", live_status_checked: false, snapshot, submission,
      payout: i.kind === "decision" ? snapshot.payments.find((v) => v.request_id === i.payout_request_id) ?? null : null };
  }
}
