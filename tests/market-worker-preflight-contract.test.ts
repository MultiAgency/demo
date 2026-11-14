import { expect, test } from "bun:test";
import { Market } from "../src/server/market";
import { MarketApi, MarketHttpError } from "../src/server/market/api";
import { marketWith } from "./support/market-stub";
import contract from "./fixtures/market-deliverable-contract.json";

// Reproduced exact simulator response; fixture bearer only, never a live Market request.
test("provider contract path is authenticated GET; a generic 404 never becomes a worker baseline or submission", async () => {
  const id = "3fc59a52-8cbb-4e42-84ca-e1fddf1d2613";
  const token = "aat_preflight_contract_fixture";
  const requests: { method: string; path: string; authMatches: boolean; accept: string | null }[] = [];
  let sends = 0;
  const send = Object.assign((async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const method = init?.method ?? "GET";
    if (method === "POST") { sends++; throw new Error("Unexpected submission after failed preflight"); }
    if (path.endsWith("/deliverable/versions")) {
      const headers = new Headers(init?.headers);
      requests.push({ method, path, authMatches: headers.get("authorization") === `Bearer ${token}`, accept: headers.get("accept") });
      return Response.json({ error: "not found" }, { status: 404 });
    }
    return Response.json({ assignments: [{ assignment: { assignmentId: id, jobId: "fixture-job", status: "in_progress" }, job: { title: "Fixture" } }] });
  }) as unknown as typeof fetch, { preconnect: fetch.preconnect });
  const ctx = marketWith();
  const api = new MarketApi("http://market.fixture.invalid", token, send);
  const m = new Market({ ...ctx.m.d, api, worker: { token, secret: "fixture_secret", agencyId: ctx.agency.id } });
  try {
    await m.worker.poll();
    await m.worker.submit(id, "Original report");
    const original = m.worker.row(id);
    expect(requests).toEqual([{ method: contract.versionsMethod, path: contract.versionsPath.replace("{id}", id), authMatches: true, accept: "application/json" }]);
    expect(original).toMatchObject({ deliverable: "Original report", submit_state: "none", submit_phase: "preflight", submit_baseline: null });
    expect(original.submit_attempt_id).toBeTruthy();
    expect(original.submit_error).toContain("no submission POST was started");
    const reloaded = new Market(m.d);
    expect(reloaded.worker.row(id)).toMatchObject({ submit_attempt_id: original.submit_attempt_id, deliverable: original.deliverable, submit_baseline: null });
    expect(sends).toBe(0);
    expect(ctx.stub.calls).toEqual([]);
  } finally { ctx.db.close(); }
});

test("404 retains its status and cannot be reinterpreted as successful empty history", async () => {
  const send = Object.assign((async () => Response.json({ error: "not found" }, { status: 404 })) as unknown as typeof fetch, { preconnect: fetch.preconnect });
  const api = new MarketApi("http://market.fixture.invalid", "aat_fixture", send);
  let error: unknown;
  try { await api.deliverableVersions("fixture-id"); } catch (err) { error = err; }
  expect(error).toBeInstanceOf(MarketHttpError);
  expect((error as MarketHttpError).status).toBe(404);
});
