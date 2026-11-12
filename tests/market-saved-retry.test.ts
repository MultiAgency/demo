import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { SessionInfo } from "../src/server/auth";
import { UserError } from "../src/server/engine";
import { marketRoutes } from "../src/server/market/routes";
import { marketWith } from "./support/market-stub";

// Real Worker, HTTP route and disposable records; all Market responses are local transport fixtures.
const at = "2026-11-11T12:00:00.000Z";
const assignmentId = "saved-retry-assignment";
const report = "# Completed export\nCSV export and acceptance tests are ready.";
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

async function fixture() {
  const transport = { versions: false, status: "in_progress", posts: [] as string[], reads: 0 };
  const worker = { token: "aat_offline_saved_retry", secret: "offline-saved-retry-fixture", agencyId: "" };
  const f = marketWith({ worker, now: () => new Date(at), fetch: (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/submit")) {
      transport.posts.push(JSON.parse(String(init?.body)).deliverableMarkdown);
      if (transport.posts.length === 1) throw new TypeError("Offline fixture: first submission response lost");
      return Response.json({ assignmentId, status: "submitted" });
    }
    transport.reads++;
    if (path.endsWith("/deliverable/versions")) return Response.json({ versions: transport.versions ? [{ version: 1, submittedAt: at, files: [] }] : [] });
    if (path.endsWith("/deliverable/versions/1/raw")) return new Response(report);
    if (path.endsWith("/agents/me/assignments")) return Response.json({ assignments: [{
      assignment: { assignmentId, jobId: "saved-retry-job", status: transport.status, escrowAmount: "1000000", escrowToken: "USDC", slaDeadlineAt: null },
      job: { title: "Offline saved retry", description: "Local fixture, no hosted job or payment." },
    }] });
    throw new Error(`Unexpected fixture request: ${path}`);
  }) as typeof fetch });
  databases.push(f.db);
  worker.agencyId = f.agency.id;
  await f.m.worker.poll();
  const pending = await f.m.worker.submit(assignmentId, report);
  expect(pending.submit_state).toBe("unknown");
  expect(pending.submit_attempt_id).toBeTruthy();
  expect(transport.posts).toEqual([report]);
  return { ...f, transport, attemptId: pending.submit_attempt_id! };
}

for (const status of ["in_progress", "accepted"]) {
  test(`a stale saved retry observes an already confirmed ${status} attempt without mutation or another POST`, async () => {
    const f = await fixture();
    f.transport.versions = true;
    f.transport.status = status;
    await f.m.worker.poll();
    const confirmed = f.m.worker.row(assignmentId);
    expect(confirmed.submit_state).toBe("submitted");
    expect(confirmed.status).toBe(status);
    const reads = f.transport.reads;
    expect(await f.m.worker.submit(assignmentId, report, f.attemptId)).toEqual(confirmed);
    expect(f.m.worker.row(assignmentId)).toEqual(confirmed);
    expect(f.transport.reads).toBe(reads);
    expect(f.transport.posts).toEqual([report]);
  });
}

test("a proven-absent saved retry sends the exact body under the original attempt ID", async () => {
  const f = await fixture();
  await f.m.worker.poll();
  const retryable = f.m.worker.row(assignmentId);
  expect(retryable).toMatchObject({ submit_state: "none", submit_phase: "not_arrived", submit_attempt_id: f.attemptId });
  await expect(f.m.worker.submit(assignmentId, "Changed report", f.attemptId)).rejects.toMatchObject({ status: 409 });
  expect(f.m.worker.row(assignmentId)).toEqual(retryable);
  const retried = await f.m.worker.submit(assignmentId, report, f.attemptId);
  expect(retried).toMatchObject({ submit_state: "submitted", submit_attempt_id: f.attemptId, deliverable: report });
  expect(retried.submit_started_at).toBe(retryable.submit_started_at);
  expect(retried.submit_baseline).toBe(retryable.submit_baseline);
  expect(f.transport.posts).toEqual([report, report]);
});

test("another attempt ID refuses a saved retry without replacing confirmed or retryable records", async () => {
  const f = await fixture();
  await f.m.worker.poll();
  for (const confirmed of [false, true]) {
    if (confirmed) { f.transport.versions = true; await f.m.worker.submit(assignmentId, report, f.attemptId); }
    const before = f.m.worker.row(assignmentId);
    await expect(f.m.worker.submit(assignmentId, report, "different-attempt")).rejects.toMatchObject({ status: 409 });
    expect(f.m.worker.row(assignmentId)).toEqual(before);
    expect(f.transport.posts).toEqual([report]);
  }
});

test("pending saved attempts and a none/preflight state are not eligible for retry", async () => {
  const f = await fixture();
  for (const [state, phase] of [["unknown", "posting"], ["submitting", "posting"], ["none", "preflight"]] as const) {
    f.db.query("UPDATE market_assignments SET submit_state = ?, submit_phase = ? WHERE assignment_id = ?").run(state, phase, assignmentId);
    const before = f.m.worker.row(assignmentId);
    await expect(f.m.worker.submit(assignmentId, report, f.attemptId)).rejects.toMatchObject({ status: 409 });
    expect(f.m.worker.row(assignmentId)).toEqual(before);
    expect(f.transport.posts).toEqual([report]);
  }
});

test("the HTTP retry field is enforced and an already confirmed retry returns its existing view", async () => {
  const f = await fixture();
  f.transport.versions = true;
  await f.m.worker.poll();
  const before = f.m.worker.row(assignmentId);
  const app = new Hono<{ Variables: { session: SessionInfo | null } }>().basePath("/api");
  app.use("*", async (c, next) => { c.set("session", { userId: "fixture-agency", accountId: f.agency.owner }); await next(); });
  app.onError((error, c) => c.json({ error: error.message }, error instanceof UserError ? error.status as 409 : 400));
  marketRoutes(app, f.m, { authRequired: true, controls: null });
  const post = (id: string) => app.request(`/api/market/worker/jobs/${assignmentId}/submit`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ markdown: report, retry_attempt_id: id }),
  });
  expect((await post("different-attempt")).status).toBe(409);
  const response = await post(f.attemptId);
  expect(response.status).toBe(200);
  expect((await response.json()).assignments[0]).toMatchObject({ submit_attempt_id: f.attemptId, submit_state: "submitted" });
  expect(f.m.worker.row(assignmentId)).toEqual(before);
  expect(f.transport.posts).toEqual([report]);
});

test("an explicit ordinary revision retains the existing two-argument behavior", async () => {
  const f = await fixture();
  f.transport.versions = true;
  await f.m.worker.poll();
  const revised = await f.m.worker.submit(assignmentId, "# New requested revision\nUpdated CSV export tests.");
  expect(revised.submit_state).toBe("submitted");
  expect(revised.submit_attempt_id).not.toBe(f.attemptId);
  expect(f.transport.posts).toEqual([report, "# New requested revision\nUpdated CSV export tests."]);
});
