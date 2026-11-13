import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { buildApp, type Runtime } from "../src/server/app";
import type { Auth } from "../src/server/auth";
import { Engine } from "../src/server/engine";
import { RulesJudge } from "../src/server/judge";
import { DEMO_TERMS, JOB_DEMO_TERMS } from "../src/shared/demo";
import { activate, setup, type Ctx } from "./support/harness";

const DESK = "https://desk.paperwork.test";
const OLD_JOBS = "https://jobs.paperwork.test";
const agency = "acme.demo";
const builder = "maria.demo";
const dbOf = (rt: Runtime) => (rt.engine as unknown as { d: { db: Database } }).d.db;
async function close(ctx: Ctx) { await (await ctx.rt.auth.$context).checkSchema?.(); dbOf(ctx.rt).close(); }

function otherRoles(ctx: Ctx) {
  const c = ctx.rt.engine;
  const asBuilder = c.createContract({ ...DEMO_TERMS, company: "Another agency", representative: { near_account: "another.demo" },
    contractor: { ...DEMO_TERMS.contractor, near_account: agency }, payee: { chain: "near", address: agency } });
  const both = c.createContract({ ...JOB_DEMO_TERMS, company: "Both named roles", contractor: { ...JOB_DEMO_TERMS.contractor, near_account: agency } });
  const unrelated = c.createContract({ ...JOB_DEMO_TERMS, company: "Unrelated private agency", representative: { near_account: "outsider.demo" },
    contractor: { ...JOB_DEMO_TERMS.contractor, near_account: "elsewhere.demo" }, payee: { chain: "near", address: agency } });
  return { asBuilder, both, unrelated };
}

/** Named fixture sessions exercise real HTTP guards; no wallet authentication is claimed. */
function appAs(ctx: Ctx, account: string | null, required = true) {
  const auth = { handler: async () => new Response("fixture auth"), api: { getSession: async () => account ? { user: { id: account } } : null }, nearAccountFor: (id: string) => id } as unknown as Auth;
  return buildApp({ ...ctx.rt, auth, config: { ...ctx.rt.config, auth: { ...ctx.rt.config.auth, required, publicUrl: DESK, enforcePublicHost: true } } });
}

test("My jobs matches only the exact named agency/builder account and retains both roles", async () => {
  const ctx = await setup(JOB_DEMO_TERMS);
  try {
    const ids = otherRoles(ctx);
    const mine = ctx.rt.engine.jobsFor(agency);
    expect(mine).toHaveLength(3);
    expect(mine.find((job) => job.id === ctx.id)?.roles).toEqual(["agency"]);
    expect(mine.find((job) => job.id === ids.asBuilder.id)?.roles).toEqual(["builder"]);
    expect(mine.find((job) => job.id === ids.asBuilder.id)?.workflow).toBe("pay_on_merge");
    expect(mine.find((job) => job.id === ids.both.id)?.roles).toEqual(["agency", "builder"]);
    expect(mine.find((job) => job.id === ctx.id)).toMatchObject({ title: JOB_DEMO_TERMS.scope[0]!.title, company: JOB_DEMO_TERMS.company,
      builder_name: JOB_DEMO_TERMS.contractor.name, scope_usd: "300", start: JOB_DEMO_TERMS.start, end: JOB_DEMO_TERMS.end,
      stage: "needs_signatures", builder_accepted: false, workflow: "report_invoice" });
    // Being the payee of an unrelated job, or matching a name/partial/case variant, grants no discovery role.
    expect(mine.some((job) => job.id === ids.unrelated.id)).toBe(false);
    for (const account of ["", "acme", "ACME.DEMO", "not-a-party.demo", DEMO_TERMS.contractor.github])
      expect(ctx.rt.engine.jobsFor(account)).toEqual([]);
    expect(ctx.rt.engine.jobsFor(builder).map((job) => job.id)).toEqual([ctx.id]);
  } finally { await close(ctx); }
});

test("discovering an unsigned job preserves the invitation requirement and reports acceptance only after signing", async () => {
  const ctx = await setup(JOB_DEMO_TERMS);
  try {
    const c = ctx.rt.engine;
    expect(c.jobsFor(builder)[0]!.builder_accepted).toBe(false);
    const rep = c.signingRequest(ctx.id, "representative");
    const repSignature = ctx.stub.sign(rep);
    await c.addSignature(ctx.id, "representative", { account_id: rep.account_id, nonce: rep.nonce, public_key: repSignature.publicKey, signature: repSignature.signature });
    expect(c.jobsFor(builder)[0]!.builder_accepted).toBe(false);
    const req = c.signingRequest(ctx.id, "contractor");
    const sig = ctx.stub.sign(req);
    const signed = { account_id: req.account_id, nonce: req.nonce, public_key: sig.publicKey, signature: sig.signature };
    await expect(c.addSignature(ctx.id, "contractor", signed)).rejects.toThrow("signing link");
    expect(c.jobsFor(builder)[0]!.builder_accepted).toBe(false);
    await c.addSignature(ctx.id, "contractor", signed, ctx.token);
    expect(c.jobsFor(builder)[0]).toMatchObject({ id: ctx.id, builder_accepted: true, stage: "needs_setup" });
    expect(ctx.stub.calls.requestPayout).toBe(0);
  } finally { await close(ctx); }
});

test("local discovery makes no SDK read, nonce preparation or write while preserving held and ended job identities", async () => {
  const ctx = await activate("300", JOB_DEMO_TERMS);
  const db = dbOf(ctx.rt);
  try {
    const submission = await ctx.rt.engine.submitJob(ctx.id, { client_request_id: "private-original-submission", report: "PRIVATE-REPORT: CSV export and tests are complete.",
      evidence: [{ deliverable_id: "d1", label: "Private evidence", url: "https://private.invalid/evidence" }], invoice: { number: "PRIVATE-INVOICE", amount_usd: "300" } }, builder);
    const proposed = await ctx.rt.engine.proposeJob(submission.id);
    const payout = proposed.payouts[0]!;
    expect(payout.state).toBe("held");
    const tables = ["contracts", "events", "platform_agents", "owner_steps", "payout_attempts", "payout_lines", "judgments", "job_submissions", "job_invoices"];
    const snapshot = () => Object.fromEntries(tables.map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = snapshot();
    const requests = ctx.stub.calls.requestPayout;
    let externalCalls = 0;
    const forbidden = () => { externalCalls++; throw new Error("Discovery must not call the SDK, chain or prepare a nonce."); };
    const platform = new Proxy(ctx.rt.kit.platform, { get(target, key, receiver) { const value = Reflect.get(target, key, receiver); return typeof value === "function" ? forbidden : value; } });
    const reader = new Engine({ db, platform, chain: { isFullAccessKey: async () => forbidden(), isRegistered: async () => forbidden() }, evidence: ctx.rt.evidence,
      judge: new RulesJudge(), config: ctx.rt.config, now: ctx.rt.clock.now, attacker: "attacker.demo", log: forbidden });
    reader.signingRequest = forbidden;
    await (await ctx.rt.auth.$context).checkSchema?.();
    db.exec("PRAGMA query_only = ON");
    const first = reader.jobsFor(builder);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: ctx.id, roles: ["builder"], stage: "active", builder_accepted: true });
    expect(first[0]!.attention).toMatchObject({ state: "waiting", summary: "Waiting for agency payout review", actions: [] });
    expect(Object.keys(first[0]!).sort()).toEqual(["attention", "builder_accepted", "builder_name", "company", "end", "id", "roles", "scope_usd", "stage", "start", "title", "workflow"]);
    expect(reader.jobsFor(builder)).toEqual(first);
    const serialized = JSON.stringify(first);
    for (const secret of [ctx.token, proposed.hash, payout.request_id, "PRIVATE-REPORT", "PRIVATE-INVOICE", "private.invalid", "contractor_link_hash", "paid", "nonce"])
      expect(serialized).not.toContain(secret);
    // Ended work remains discoverable; setup progress never turns a held payout into confirmed settlement.
    ctx.rt.clock.set(new Date("2026-12-01T12:00:00Z"));
    expect(reader.jobsFor(builder)[0]).toMatchObject({ id: ctx.id, stage: "ended", builder_accepted: true });
    expect(reader.jobsFor(agency)[0]!.roles).toEqual(["agency"]);
    expect(reader.jobsFor(agency)[0]!.attention.actions).toEqual([{ role: "agency", label: "Review payout proposal" }]);
    expect(externalCalls).toBe(0);
    expect(ctx.stub.calls.requestPayout).toBe(requests);
    expect(snapshot()).toEqual(before);
  } finally { db.exec("PRAGMA query_only = OFF"); await close(ctx); }
});

test("My jobs returns every matching local record beyond one hundred without publishing unrelated records", async () => {
  const ctx = await setup(JOB_DEMO_TERMS);
  try {
    const expected = [ctx.id];
    for (let i = 1; i < 105; i++) expected.push(ctx.rt.engine.createContract({ ...JOB_DEMO_TERMS, company: `Fixture job ${i}` }).id);
    ctx.rt.engine.createContract({ ...JOB_DEMO_TERMS, company: "Not mine", representative: { near_account: "outsider.demo" }, contractor: { ...JOB_DEMO_TERMS.contractor, near_account: "another.demo" } });
    const jobs = ctx.rt.engine.jobsFor(builder);
    expect(jobs).toHaveLength(105);
    expect(jobs.map((job) => job.id).sort()).toEqual(expected.sort());
    expect(new Set(jobs.map((job) => job.id)).size).toBe(105);
    expect(ctx.stub.calls.requestPayout).toBe(0);
  } finally { await close(ctx); }
});

test("the My jobs HTTP route requires its own session and ignores a caller-selected account in independent Desk sessions", async () => {
  const ctx = await setup(JOB_DEMO_TERMS);
  try {
    const ids = otherRoles(ctx);
    for (const tab of [appAs(ctx, agency), appAs(ctx, agency)]) {
      const anonymous = await appAs(ctx, null).request(`${DESK}/api/jobs/mine?account=${agency}`);
      expect(anonymous.status).toBe(401);
      expect(await anonymous.text()).not.toContain(JOB_DEMO_TERMS.company);
      const mine = await tab.request(`${DESK}/api/jobs/mine?account=outsider.demo`);
      expect(mine.status).toBe(200);
      const body = await mine.json();
      expect(body.demo).toBe(false);
      expect(body.jobs.map((job: { id: string }) => job.id).sort()).toEqual([ctx.id, ids.asBuilder.id, ids.both.id].sort());
      expect(JSON.stringify(body)).not.toContain(ctx.token);
      expect(body.jobs.some((job: { id: string }) => job.id === ids.unrelated.id)).toBe(false);
      const unrelated = await appAs(ctx, "nobody.demo").request(`${DESK}/api/jobs/mine?account=${builder}`);
      expect(unrelated.status).toBe(200);
      expect(await unrelated.json()).toEqual({ jobs: [], demo: false });
    }
    expect(ctx.stub.calls.requestPayout).toBe(0);
  } finally { await close(ctx); }
});

test("the agency list selects the actual representative while the default list retains both named roles", async () => {
  const ctx = await setup(JOB_DEMO_TERMS);
  try {
    const ids = otherRoles(ctx);
    const app = appAs(ctx, agency);
    const all = await app.request(`${DESK}/api/contracts`);
    expect(all.status).toBe(200);
    expect((await all.json()).map((job: { id: string }) => job.id).sort()).toEqual([ctx.id, ids.asBuilder.id, ids.both.id].sort());
    const own = await app.request(`${DESK}/api/contracts?role=agency&account=outsider.demo`);
    expect(own.status).toBe(200);
    const ownBody = await own.json();
    expect(ownBody.map((job: { id: string }) => job.id).sort()).toEqual([ctx.id, ids.both.id].sort());
    expect(JSON.stringify(ownBody)).not.toContain(ctx.token);
    const builderApp = appAs(ctx, builder);
    expect((await (await builderApp.request(`${DESK}/api/contracts`)).json()).map((job: { id: string }) => job.id)).toEqual([ctx.id]);
    expect(await (await builderApp.request(`${DESK}/api/contracts?role=agency`)).json()).toEqual([]);
    expect(await (await appAs(ctx, null).request(`${DESK}/api/contracts?role=agency`)).json()).toEqual([]);
    expect(ctx.stub.calls.requestPayout).toBe(0);
  } finally { await close(ctx); }
});

test("private My jobs reads reject the retired Jobs host and foreign origins before session or local discovery", async () => {
  const ctx = await setup(JOB_DEMO_TERMS);
  try {
    let sessions = 0;
    let reads = 0;
    const auth = { handler: async () => new Response("fixture auth"), api: { getSession: async () => {
      sessions++; return { user: { id: agency } };
    } }, nearAccountFor: (id: string) => id } as unknown as Auth;
    const app = buildApp({ ...ctx.rt, auth, config: { ...ctx.rt.config, auth: { ...ctx.rt.config.auth,
      required: true, publicUrl: DESK, enforcePublicHost: true } } });
    const jobsFor = ctx.rt.engine.jobsFor.bind(ctx.rt.engine);
    ctx.rt.engine.jobsFor = (account) => { reads++; return jobsFor(account); };
    for (const host of [OLD_JOBS, "https://outside.paperwork.test"])
      expect((await app.request(`${host}/api/jobs/mine`, { headers: { origin: DESK, "x-forwarded-host": new URL(DESK).host } })).status).toBe(421);
    for (const origin of [OLD_JOBS, "https://outside.paperwork.test"])
      expect((await app.request(`${DESK}/api/jobs/mine`, { headers: { origin } })).status).toBe(403);
    expect(sessions).toBe(0);
    expect(reads).toBe(0);
    const allowed = await app.request(`${DESK}/api/jobs/mine`, { headers: { origin: DESK } });
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).jobs.map((job: { id: string }) => job.id)).toEqual([ctx.id]);
    expect(sessions).toBe(1);
    expect(reads).toBe(1);
  } finally { await close(ctx); }
});

test("anonymous demo My jobs chooses its fixed builder fixture instead of accepting a query or exposing every draft", async () => {
  const ctx = await setup(JOB_DEMO_TERMS);
  try {
    otherRoles(ctx);
    const response = await appAs(ctx, null, false).request(`${DESK}/api/jobs/mine?account=${agency}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.demo).toBe(true);
    expect(body.jobs.map((job: { id: string }) => job.id)).toEqual([ctx.id]);
    expect(body.jobs[0].roles).toEqual(["builder"]);
    expect(JSON.stringify(body)).not.toContain(ctx.token);
  } finally { await close(ctx); }
});
