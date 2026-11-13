import { expect, spyOn, test } from "bun:test";
import { buildApp } from "../src/server/app";
import type { Auth } from "../src/server/auth";
import type { Deps } from "../src/server/engine";
import { AgentClient } from "../src/agent/client";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { activate } from "./support/harness";

test("single-submission reads enforce named parties and job binding without enumerating report history", async () => {
  const ctx = await activate("300", JOB_DEMO_TERMS);
  const { d } = ctx.rt.engine as unknown as { d: Deps };
  let account: string | null = "maria.demo";
  const origin = "https://paperwork.test";
  const auth = { handler: async () => new Response("fixture"), api: { getSession: async () => account ? { user: { id: account } } : null }, nearAccountFor: (id: string) => id } as unknown as Auth;
  const app = buildApp({ ...ctx.rt, auth, config: { ...ctx.rt.config, auth: { ...ctx.rt.config.auth, required: true, publicUrl: origin, enforcePublicHost: true } } });
  const client = new AgentClient(async (path, init) => app.request(`${origin}${path}`, init));
  const report = { client_request_id: "original-one-report", report: "CSV export and acceptance tests are complete.", evidence: [{ deliverable_id: "d1", label: "Tests", url: "https://example.invalid/tests" }], invoice: { number: "SINGLE-001", amount_usd: "300" } };
  try {
    const prepared = await client.prepare({ kind: "report", job_id: ctx.id, submission: report });
    expect((await client.follow(prepared)).submission).toBeNull();
    const s = await ctx.rt.engine.submitJob(ctx.id, report, "maria.demo");
    const other = ctx.rt.engine.createContract({ ...JOB_DEMO_TERMS, company: "Another owned job" });
    const enumerate = spyOn(ctx.rt.engine, "jobSubmissions").mockImplementation(() => { throw Error("Must not enumerate reports"); });
    try {
      d.db.exec("PRAGMA query_only = ON");
      for (const actor of ["maria.demo", "acme.demo"]) {
        account = actor;
        const result = await app.request(`${origin}/api/contracts/${ctx.id}/submissions/${s.id}`);
        expect(result.status).toBe(200);
        expect(await result.json()).toEqual(s);
        expect((await client.follow(prepared)).submission?.id).toBe(s.id);
      }
      expect((await app.request(`${origin}/api/contracts/${other.id}/submissions/${s.id}`)).status).toBe(404);
      for (const actor of [null, "outsider.demo"]) {
        account = actor;
        expect((await app.request(`${origin}/api/contracts/${ctx.id}/submissions/${s.id}`)).status).toBe(actor ? 403 : 401);
        await expect(client.follow(prepared)).rejects.toMatchObject({ status: actor ? 403 : 401 });
      }
      expect(enumerate).not.toHaveBeenCalled();
    } finally { d.db.exec("PRAGMA query_only = OFF"); enumerate.mockRestore(); }
  } finally { await (await ctx.rt.auth.$context).checkSchema?.(); d.db.close(); }
});
