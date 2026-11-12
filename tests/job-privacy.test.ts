import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { buildApp, type Runtime } from "../src/server/app";
import type { Auth } from "../src/server/auth";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { PUBLIC_VERIFICATION_CHECKS } from "../src/shared/views";
import { setup, signTerms } from "./support/harness";

function asAccount(rt: Runtime, account: string | null) {
  const auth = { handler: async () => new Response(), api: { getSession: async () => account ? { user: { id: account } } : null }, nearAccountFor: (id: string) => id } as unknown as Auth;
  return buildApp({ ...rt, auth, config: { ...rt.config, auth: { ...rt.config.auth, required: true } } });
}

for (const version of [2, 3]) {
  test(`v${version}: private reads and own-role signing refuse before platform work`, async () => {
    const ctx = await setup(version === 3 ? JOB_DEMO_TERMS : {});
    await signTerms(ctx); // Existing signed records use the same boundary; no migration or invitation replacement.
    const db = (ctx.rt.engine as unknown as { d: { db: Database } }).d.db;
    const before = db.query("SELECT hash, rep_sig, contractor_sig, contractor_link_hash FROM contracts WHERE id = ?").get(ctx.id);
    let reads = 0;
    ctx.rt.engine.viewContract = async () => { reads++; throw Error("unexpected read"); };
    ctx.rt.engine.getContract = async () => { reads++; throw Error("unexpected reconciliation"); };
    ctx.rt.engine.verify = async () => { reads++; throw Error("unexpected verification"); };
    for (const [account, code] of [[null, 401], ["attacker.demo", 403]] as const) {
      for (const path of ["", "/verify", "/signing-request?role=contractor", "/signing-request?role=representative"]) {
        const response = await asAccount(ctx.rt, account).request(`/api/contracts/${ctx.id}${path}`);
        expect(response.status).toBe(code);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        const body = await response.text();
        expect(body).not.toContain("acme.demo");
        expect(body).not.toContain("maria.demo");
      }
    }
    expect(reads).toBe(0);
    for (const [account, own, other] of [["acme.demo", "representative", "contractor"], ["maria.demo", "contractor", "representative"]]) {
      const app = asAccount(ctx.rt, account!);
      expect((await app.request(`/api/contracts/${ctx.id}/signing-request?role=${own}`)).status).toBe(200);
      expect((await app.request(`/api/contracts/${ctx.id}/signing-request?role=${other}`)).status).toBe(403);
    }
    expect(db.query("SELECT hash, rep_sig, contractor_sig, contractor_link_hash FROM contracts WHERE id = ?").get(ctx.id)).toEqual(before);
  });

  test(`v${version}: builder projection excludes owner preparations and public verification is allowlisted`, async () => {
    const ctx = await setup(version === 3 ? JOB_DEMO_TERMS : {});
    const original = ctx.rt.engine.viewContract.bind(ctx.rt.engine);
    ctx.rt.engine.viewContract = async (id) => {
      const view = await original(id);
      return { ...view, next_step: { kind: "wait", label: "OWNER_PREPARATION_SENTINEL", retry_ms: 10 }, platform: { ...view.platform, deposit: { secret: "DEPOSIT_SENTINEL" } as never } };
    };
    const response = await asAccount(ctx.rt, "maria.demo").request(`/api/contracts/${ctx.id}`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("OWNER_PREPARATION_SENTINEL");
    expect(text).not.toContain("DEPOSIT_SENTINEL");
    const publicResponse = await asAccount(ctx.rt, null).request(`/api/contracts/${ctx.id}/verify/public`);
    expect(publicResponse.status).toBe(200);
    const value = await publicResponse.json();
    expect(Object.keys(value).sort()).toEqual(["checked_at", "checks", "overall", "terms_hash", "workflow_version"]);
    expect(value.workflow_version).toBe(version);
    for (const [id, ok] of Object.entries(value.checks)) {
      expect([...PUBLIC_VERIFICATION_CHECKS] as string[]).toContain(id);
      expect(typeof ok).toBe("boolean");
    }
    expect(JSON.stringify(value)).not.toContain("acme.demo");
    expect(JSON.stringify(value)).not.toContain("maria.demo");
    expect(ctx.stub.transfers).toHaveLength(0);
  });
}
