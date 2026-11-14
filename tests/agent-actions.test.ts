import { expect, test } from "bun:test";
import { buildApp } from "../src/server/app";
import type { Auth } from "../src/server/auth";
import { Engine, type Deps } from "../src/server/engine";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { jobActionPlan } from "../src/shared/job-actions";
import { activate, setup, type Ctx } from "./support/harness";

const origin = "https://paperwork.test";
function appAs(ctx: Ctx, account: string | null, engine = ctx.rt.engine) {
  const auth = { handler: async () => new Response("fixture"),
    api: { getSession: async () => account ? { user: { id: account } } : null }, nearAccountFor: (id: string) => id } as unknown as Auth;
  return buildApp({ ...ctx.rt, engine, auth, config: { ...ctx.rt.config,
    auth: { ...ctx.rt.config.auth, required: true, publicUrl: origin, enforcePublicHost: true } } });
}
const depsOf = (ctx: Ctx) => (ctx.rt.engine as unknown as { d: Deps }).d;
async function close(ctx: Ctx) { await ctx.rt.close(); }

test("agent discovery enforces account/host scope and exposes inspect-only actions without invitations", async () => {
  const ctx = await setup(JOB_DEMO_TERMS);
  try {
    expect((await appAs(ctx, null).request(`${origin}/api/agent`)).status).toBe(200);
    expect((await appAs(ctx, null).request(`${origin}/api/jobs/mine/actions?account=acme.demo`)).status).toBe(401);
    const mine = await appAs(ctx, "maria.demo").request(`${origin}/api/jobs/mine/actions?account=acme.demo`);
    expect(mine.headers.get("cache-control")).toBe("no-store");
    const body = await mine.json();
    expect(body).toMatchObject({ schema_version: 1, source: "stored_records", live_status_checked: false, demo: false });
    expect(body.jobs[0]).toMatchObject({ job_id: ctx.id, reason_code: "acceptance_required",
      actions: [{ id: `${ctx.id}:acceptance_required:builder`, actor: "builder", kind: "inspect", authority: "read_only", method: "GET" }] });
    expect(JSON.stringify(body)).not.toContain(ctx.token);
    expect(body.jobs[0].actions[0].ui_href).toBe(`#/c/${ctx.id}/sign`);
    expect((await (await appAs(ctx, "outsider.demo").request(`${origin}/api/jobs/mine/actions`)).json()).jobs).toEqual([]);
    for (const actor of [null, "outsider.demo"])
      expect((await appAs(ctx, actor).request(`${origin}/api/jobs/${ctx.id}/snapshot`)).status).toBe(actor ? 403 : 401);
    expect((await appAs(ctx, "maria.demo").request(`https://wrong.test/api/jobs/mine/actions`)).status).toBe(421);
  } finally { await close(ctx); }
});

test("agent plans and snapshots neither call providers nor write records for an active job", async () => {
  const ctx = await activate("300", JOB_DEMO_TERMS);
  const deps = depsOf(ctx), db = deps.db;
  try {
    const submission = await ctx.rt.engine.submitJob(ctx.id, { client_request_id: "agent-original-submission", report: "CSV export and acceptance tests are complete.",
      evidence: [{ deliverable_id: "d1", label: "Tests", url: "https://example.invalid/tests" }], invoice: { number: "AGENT-001", amount_usd: "300" } }, "maria.demo");
    const proposed = await ctx.rt.engine.proposeJob(submission.id);
    const payout = proposed.payouts[0]!;
    expect(payout.state).toBe("held");
    let calls = 0;
    const forbidden = () => { calls++; throw Error("Agent discovery cannot call a provider"); };
    const platform = new Proxy(deps.platform, { get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver); return typeof value === "function" ? forbidden : value;
    } });
    const engine = new Engine({ ...deps, platform,
      chain: { isFullAccessKey: async () => forbidden(), isRegistered: async () => forbidden() } });
    const app = appAs(ctx, "acme.demo", engine);
    const before = db.query("SELECT total_changes() AS count").get();
    db.exec("PRAGMA query_only = ON");
    for (let i = 0; i < 2; i++) {
      expect((await app.request(`${origin}/api/jobs/mine/actions`)).status).toBe(200);
      const response = await app.request(`${origin}/api/jobs/${ctx.id}/snapshot`);
      expect(response.status).toBe(200);
      const snapshot = await response.json();
      expect(snapshot).toMatchObject({ source: "stored_records", live_status_checked: false,
        job: { id: ctx.id, attention: { reason_code: "payout_review" } },
        payments: [{ request_id: payout.request_id, state: "held", amount_usd: "300", recipient: "maria.demo" }] });
      expect(snapshot.terms.payee.address).toBe("maria.demo");
      expect(snapshot.terms_hash).toHaveLength(64);
      expect(JSON.stringify(snapshot)).not.toMatch(/contractor_token|confirm_url|public_key|signature/);
    }
    expect(calls).toBe(0);
    expect(db.query("SELECT total_changes() AS count").get()).toEqual(before);
  } finally { db.exec("PRAGMA query_only = OFF"); await close(ctx); }
});

test("waiting plans cannot turn labels or unrelated roles into execution authority", async () => {
  const ctx = await setup(JOB_DEMO_TERMS);
  try {
    const job = ctx.rt.engine.jobsFor("maria.demo")[0]!;
    const waiting = jobActionPlan({ ...job, attention: { state: "waiting", reason_code: "payment_evidence_pending", summary: "Approve now", detail: "untrusted text", actions: [] } });
    expect(waiting.actions).toEqual([]);
    expect(waiting.reason_code).toBe("payment_evidence_pending");
    expect(jobActionPlan({ ...job, attention: { ...job.attention, actions: [{ role: "agency", label: "Approve" }] } }).actions).toEqual([]);
  } finally { await close(ctx); }
});
