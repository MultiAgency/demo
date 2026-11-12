import { expect, test } from "bun:test";
import { buildApp, type Runtime } from "../src/server/app";
import type { Auth } from "../src/server/auth";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { activate } from "./support/harness";

function asAccount(rt: Runtime, account: string | null) {
  const auth = {
    handler: async () => new Response("fixture auth"),
    api: { getSession: async () => account ? { user: { id: account } } : null },
    nearAccountFor: (id: string) => id,
  } as unknown as Auth;
  return buildApp({ ...rt, auth, config: { ...rt.config, auth: { ...rt.config.auth, required: true } } });
}

test("owner-step reads protect owner metadata and never poll for another party", async () => {
  const ctx = await activate("300", JOB_DEMO_TERMS);
  const submission = await ctx.rt.engine.submitJob(ctx.id, {
    client_request_id: "owner-metadata-proof", report: "CSV export and test results are ready for review.",
    evidence: [{ deliverable_id: "d1", label: "CSV export tests", url: "https://evidence.invalid/export" }],
    invoice: { number: "OWNER-METADATA", amount_usd: "300" },
  }, JOB_DEMO_TERMS.contractor.near_account);
  const proposed = await ctx.rt.engine.proposeJob(submission.id);
  const step = await ctx.rt.engine.vote(proposed.payouts[0]!.request_id, "approve");
  const original = ctx.rt.engine.getOwnerStep.bind(ctx.rt.engine);
  let polls = 0;
  ctx.rt.engine.getOwnerStep = async (id) => { polls++; return original(id); };
  for (const [account, expected] of [[null, 401], ["attacker.demo", 403], ["maria.demo", 403]] as const) {
    const response = await asAccount(ctx.rt, account).request(`/api/owner-steps/${step.correlation_id}`);
    expect(response.status).toBe(expected);
    expect(polls).toBe(0);
  }
  const allowed = await asAccount(ctx.rt, "acme.demo").request(`/api/owner-steps/${step.correlation_id}`);
  expect(allowed.status).toBe(200);
  expect((await allowed.json()).correlation_id).toBe(step.correlation_id);
  expect(polls).toBe(1);
  expect(ctx.stub.transfers).toHaveLength(0);
});

test("a private work order rejects unrelated readers before a platform view is fetched", async () => {
  const ctx = await activate("300", JOB_DEMO_TERMS);
  const original = ctx.rt.engine.viewContract.bind(ctx.rt.engine);
  let reads = 0;
  ctx.rt.engine.viewContract = async (id) => { reads++; return original(id); };
  for (const [account, expected] of [[null, 401], ["attacker.demo", 403]] as const) {
    expect((await asAccount(ctx.rt, account).request(`/api/contracts/${ctx.id}`)).status).toBe(expected);
    expect(reads).toBe(0);
  }
  expect((await asAccount(ctx.rt, "maria.demo").request(`/api/contracts/${ctx.id}`)).status).toBe(200);
  expect(reads).toBe(1);
});
