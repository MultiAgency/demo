import { expect, test } from "bun:test";
import { AgentClient, AgentApiError, type AgentTransport } from "../src/agent/client";
import { agentIntentSchema } from "../src/shared/agent-contracts";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { activate, setup, type Ctx } from "./support/harness";
import type { Deps } from "../src/server/engine";

const transport = (ctx: Ctx): AgentTransport => async (path, init) => ctx.rt.app.request(`http://localhost${path}`, init);
async function close(ctx: Ctx) { await (await ctx.rt.auth.$context).checkSchema?.(); (ctx.rt.engine as unknown as { d: Deps }).d.db.close(); }
const report = { client_request_id: "agent-report-original", report: "CSV export and acceptance tests are complete.",
  evidence: [{ deliverable_id: "d1", label: "Tests", url: "https://example.invalid/tests" }], invoice: { number: "AGENT-001", amount_usd: "300" } };

test("agent contracts validate intent and publish additive machine discovery", async () => {
  expect(agentIntentSchema.safeParse({ kind: "decision", job_id: "c_1", payout_request_id: "p_1", verdict: "approve" }).success).toBe(false);
  expect(agentIntentSchema.safeParse({ kind: "report", job_id: "c_1", submission: { ...report, client_request_id: "" } }).success).toBe(false);
  expect(agentIntentSchema.safeParse({ kind: "inspect", path: "https://evil.invalid" }).success).toBe(false);
  const ctx = await setup(JOB_DEMO_TERMS);
  try {
    const response = await ctx.rt.app.request("http://localhost/api/agent/contracts");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ schema_version: 1, intent_schema: { oneOf: expect.any(Array) } });
  } finally { await close(ctx); }
});

test("lost report response follows and replays the original invoice after client restart", async () => {
  const ctx = await activate("300", JOB_DEMO_TERMS);
  try {
    let lose = true;
    const client = new AgentClient(async (path, init) => {
      const response = await transport(ctx)(path, init);
      if (lose && init?.method === "POST" && path.endsWith("/submissions")) { lose = false; throw Error("response lost"); }
      return response;
    });
    const prepared = await client.prepare({ kind: "report", job_id: ctx.id, submission: report });
    await expect(client.submit(prepared, { contractor_token: ctx.token })).rejects.toThrow("response lost");
    const saved = JSON.parse(JSON.stringify(prepared));
    const restarted = new AgentClient(transport(ctx));
    const followed = await restarted.follow(saved);
    expect(followed.submission?.invoice.number).toBe("AGENT-001");
    const result = await restarted.submit(saved, { contractor_token: ctx.token });
    expect(result.kind).toBe("report");
    if (result.kind !== "report") throw Error("wrong result");
    expect(result.result.id).toBe(followed.submission!.id);
    expect(ctx.rt.engine.jobSubmissions(ctx.id)).toHaveLength(1);
    const changed = await restarted.prepare({ kind: "report", job_id: ctx.id, submission: { ...report, report: "Changed content under the same identifier" } });
    await expect(restarted.submit(changed, { contractor_token: ctx.token })).rejects.toBeInstanceOf(AgentApiError);
    expect((await restarted.follow(saved)).snapshot.payments).toHaveLength(0);
  } finally { await close(ctx); }
});

test("proposal replay retains payout identity; decision requires explicit signature and follows without paying", async () => {
  const ctx = await activate("300", JOB_DEMO_TERMS);
  try {
    const client = new AgentClient(transport(ctx));
    const submission = await ctx.rt.engine.submitJob(ctx.id, report, "maria.demo");
    const proposal = await client.prepare({ kind: "propose", job_id: ctx.id, submission_id: submission.id });
    await client.submit(proposal);
    const first = await client.follow(proposal);
    await client.submit(JSON.parse(JSON.stringify(proposal)));
    const second = await client.follow(proposal);
    expect(first.submission?.payout_request_ids).toEqual(second.submission?.payout_request_ids);
    expect(second.snapshot.payments).toHaveLength(1);
    const rid = second.snapshot.payments[0]!.request_id;
    const intent = { kind: "decision", job_id: ctx.id, payout_request_id: rid, verdict: "approve", authorization: "explicit" } as const;
    const decision = await client.prepare(intent);
    const replay = await client.prepare(intent);
    expect(decision).toEqual(replay);
    await expect(client.submit(decision)).rejects.toThrow();
    expect((await client.follow(decision)).payout?.state).toBe("held");
    if (decision.preparation.kind !== "decision") throw Error("wrong preparation");
    const wrong = structuredClone(decision);
    if (wrong.preparation.kind !== "decision") throw Error("wrong preparation");
    wrong.intent = { ...intent, verdict: "reject" };
    await expect(client.submit(wrong, { signature: ctx.stub.sign(decision.preparation.vote.sign!) })).rejects.toThrow("identity changed");
    await client.submit(decision, { signature: ctx.stub.sign(decision.preparation.vote.sign!) });
    expect((await client.follow(decision)).payout?.request_id).toBe(rid);
    expect((await client.follow(decision)).payout?.state).not.toBe("paid");
  } finally { await close(ctx); }
});

test("acceptance requires original invitation and signature; prepared envelope cannot choose an arbitrary path", async () => {
  const ctx = await setup(JOB_DEMO_TERMS);
  try {
    const client = new AgentClient(transport(ctx));
    const p = await client.prepare({ kind: "accept", job_id: ctx.id, role: "contractor" });
    await expect(client.submit(p)).rejects.toThrow();
    if (p.preparation.kind !== "signature") throw Error("wrong preparation");
    const signature = ctx.stub.sign(p.preparation.sign);
    await expect(client.submit(p, { signature })).rejects.toBeInstanceOf(AgentApiError);
    await client.submit(p, { signature, contractor_token: ctx.token });
    const tampered = { ...p, path: "https://evil.invalid", job_id: "other-job" };
    await expect(client.follow(tampered)).rejects.toThrow();
    expect(JSON.stringify(await client.follow(p))).not.toContain(ctx.token);
  } finally { await close(ctx); }
});

test("stored follow remains read-only even when every provider operation is unavailable", async () => {
  const ctx = await activate("300", JOB_DEMO_TERMS);
  try {
    const client = new AgentClient(transport(ctx));
    const p = await client.prepare({ kind: "report", job_id: ctx.id, submission: report });
    await client.submit(p, { contractor_token: ctx.token });
    const deps = (ctx.rt.engine as unknown as { d: Deps }).d;
    const { Engine } = await import("../src/server/engine");
    const { buildApp } = await import("../src/server/app");
    let providerCalls = 0;
    const platform = new Proxy(deps.platform, { get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? () => { providerCalls++; throw Error("offline"); } : value;
    } });
    const app = buildApp({ ...ctx.rt, engine: new Engine({ ...deps, platform }) });
    const offline = new AgentClient(async (path, init) => app.request(`http://localhost${path}`, init));
    deps.db.exec("PRAGMA query_only = ON");
    try {
      expect((await offline.follow(p)).submission?.invoice.number).toBe("AGENT-001");
      expect(providerCalls).toBe(0);
    } finally { deps.db.exec("PRAGMA query_only = OFF"); }
  } finally { await close(ctx); }
});

test("switching accounts cannot submit a previously prepared builder report", async () => {
  const ctx = await activate("300", JOB_DEMO_TERMS);
  try {
    const { buildApp } = await import("../src/server/app");
    let account = "maria.demo";
    const auth = { handler: async () => new Response("fixture"),
      api: { getSession: async () => ({ user: { id: account } }) }, nearAccountFor: (id: string) => id,
    } as unknown as import("../src/server/auth").Auth;
    const app = buildApp({ ...ctx.rt, auth, config: { ...ctx.rt.config,
      auth: { ...ctx.rt.config.auth, required: true, publicUrl: "https://paperwork.test", enforcePublicHost: true } } });
    const client = new AgentClient(async (path, init) => app.request(`https://paperwork.test${path}`, init));
    const p = await client.prepare({ kind: "report", job_id: ctx.id, submission: report });
    account = "acme.demo";
    await expect(client.submit(p)).rejects.toMatchObject({ status: 403 });
    account = "outsider.demo";
    await expect(client.follow(p)).rejects.toMatchObject({ status: 403 });
    expect(ctx.rt.engine.jobSubmissions(ctx.id)).toHaveLength(0);
    account = "maria.demo";
    expect((await client.submit(p)).kind).toBe("report");
  } finally { await close(ctx); }
});

test("offer preparation predicts the original job ID and follow never recovers the private invitation", async () => {
  const ctx = await setup(JOB_DEMO_TERMS);
  try {
    const client = new AgentClient(transport(ctx));
    const prepared = await client.prepare({ kind: "offer", terms: { ...JOB_DEMO_TERMS, company: "Agent offered work order" } });
    const result = await client.submit(prepared);
    if (result.kind !== "offer") throw Error("wrong result");
    expect(result.result.id).toBe(prepared.job_id);
    const followed = await client.follow(JSON.parse(JSON.stringify(prepared)));
    expect(followed.snapshot.job.id).toBe(prepared.job_id);
    expect(JSON.stringify(followed)).not.toContain(result.result.contractor_token);
    await expect(client.submit(prepared)).rejects.toMatchObject({ status: 409 });
  } finally { await close(ctx); }
});
