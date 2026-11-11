import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { DaoPolicy } from "@multiagency/sdk";
import type { SessionInfo } from "../src/server/auth";
import { UserError } from "../src/server/engine";
import { migrateMarket } from "../src/server/market/db";
import { Market } from "../src/server/market";
import { marketRoutes } from "../src/server/market/routes";
import { MAX_WEBHOOK_BODY, type WorkerConfig } from "../src/server/market/worker";
import { marketWith } from "./support/market-stub";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const SECRET = "isolated-webhook-fixture";
const enc = new TextEncoder();
const item = (id: string, status = "in_progress") => ({
  assignment: { assignmentId: id, jobId: `job-${id}`, status, escrowAmount: "500000", escrowToken: "X402", slaDeadlineAt: null },
  job: { title: `Title ${id}`, description: `Private brief ${id}` },
});
const versions = [{ version: 1, files: [], submittedAt: new Date(NOW).toISOString() }];
const isVersions = (url: string | URL | Request) => new URL(typeof url === "string" || url instanceof URL ? url : url.url).pathname.endsWith("/deliverable/versions");
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function context(send: typeof fetch = (async () => Response.json({ assignments: [] })) as unknown as typeof fetch, now = () => new Date(NOW)) {
  const cfg: WorkerConfig = { token: "aat_fixture", secret: SECRET, agencyId: "" };
  const ctx = marketWith({ worker: cfg, fetch: send, now });
  cfg.agencyId = ctx.agency.id;
  return { ...ctx, cfg };
}

function signed(raw: Uint8Array, delivery = "delivery-original", event = "hire.created") {
  const timestamp = String(NOW / 1000);
  return new Headers({
    "content-type": "application/json", "x-market-timestamp": timestamp, "x-market-delivery": delivery,
    "x-market-event": event, "x-market-signature": `sha256=${createHmac("sha256", SECRET).update(`${timestamp}.`).update(raw).digest("hex")}`,
  });
}
const created = (id = "assignment-original") => enc.encode(JSON.stringify({ assignment_id: id, job_id: `job-${id}`, title: `Private ${id}`, description: "Private agency evidence" }));
const observe = (ctx: ReturnType<typeof context>, id = "assignment-original", delivery = "delivery-original") => {
  const raw = created(id);
  return ctx.m.worker.receive(signed(raw, delivery), raw);
};

/** Real market HTTP handlers, with an explicit fixture session supplied by middleware; no wallet or external server. */
function routes(m: Market) {
  const app = new Hono<{ Variables: { session: SessionInfo | null } }>().basePath("/api");
  app.use("*", async (c, next) => {
    const account = c.req.header("x-fixture-account");
    c.set("session", account ? { accountId: account, userId: account } : null);
    await next();
  });
  app.onError((error, c) => c.json({ error: error.message }, error instanceof UserError ? error.status as 400 : 500));
  marketRoutes(app, m, { authRequired: true, controls: null });
  return app;
}

function request(app: ReturnType<typeof routes>, method: "GET" | "POST", path: string, account?: string, body?: unknown) {
  return app.request(`/api${path}`, { method, headers: { ...(account && { "x-fixture-account": account }), ...(body !== undefined && { "content-type": "application/json" }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
}

describe("worker historical ownership", () => {
  test("migration keeps legacy assignment and delivery identities unbound instead of adopting the configured owner", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE market_assignments (assignment_id TEXT PRIMARY KEY, seen_at TEXT, deliverable TEXT, submit_state TEXT);
      CREATE TABLE market_deliveries (delivery_id TEXT PRIMARY KEY, event TEXT NOT NULL, received_at TEXT NOT NULL);
      INSERT INTO market_assignments VALUES ('legacy-assignment', '2026-11-10', 'already sent', 'unknown');
      INSERT INTO market_deliveries VALUES ('legacy-delivery', 'hire.created', '2026-11-10');`);
    migrateMarket(db);
    migrateMarket(db);
    expect(db.query("SELECT * FROM market_assignments").get()).toEqual({ assignment_id: "legacy-assignment", seen_at: "2026-11-10", deliverable: "already sent", submit_state: "unknown", agency_id: null,
      submit_attempt_id: null, submit_started_at: null, submit_phase: null, submit_baseline: null });
    expect(db.query("SELECT * FROM market_deliveries").get()).toEqual({ delivery_id: "legacy-delivery", event: "hire.created", received_at: "2026-11-10", agency_id: null });
    db.close();
  });

  test("removing/replacing worker configuration never exposes or reassigns historical jobs", async () => {
    let assignments: ReturnType<typeof item>[] = [];
    const ctx = context((async () => Response.json({ assignments })) as unknown as typeof fetch);
    await observe(ctx);
    const original = ctx.db.query("SELECT * FROM market_assignments").get();
    const disabled = new Market({ ...ctx.m.d, worker: null });
    const disabledView = await (await request(routes(disabled), "GET", "/market/worker")).json();
    expect(disabledView).toMatchObject({ configured: false, agency_id: null, assignments: [], deposit: null, last_poll: null });

    const other = ctx.m.agencies.create({ name: "Other agency", owner: "other.near", signer: "wallet" });
    const replacement = new Market({ ...ctx.m.d, worker: { ...ctx.cfg, agencyId: other.id } });
    const replacementApp = routes(replacement);
    expect((await request(replacementApp, "GET", "/market/worker", "acme.near")).status).toBe(403);
    const otherView = await (await request(replacementApp, "GET", "/market/worker", "other.near")).json();
    expect(otherView).toMatchObject({ configured: true, agency_id: other.id, assignments: [] });
    await expect(replacement.worker.submit("assignment-original", "New owner must not send this")).rejects.toThrow(/No such job for this agency/);
    const raw = created();
    await expect(replacement.worker.receive(signed(raw), raw)).rejects.toThrow(/ownership differs or is unproven/);
    await expect(replacement.worker.receive(signed(raw, "new-delivery"), raw)).rejects.toThrow(/No such job for this agency/);
    assignments = [item("assignment-original", "accepted")];
    await expect(replacement.worker.poll()).rejects.toThrow(/No such job for this agency/);
    expect(ctx.db.query("SELECT * FROM market_assignments").get()).toEqual(original);
    expect(ctx.db.query("SELECT delivery_id, agency_id FROM market_deliveries ORDER BY delivery_id").all()).toEqual([{ delivery_id: "delivery-original", agency_id: ctx.agency.id }]);

    const restored = new Market({ ...ctx.m.d, worker: ctx.cfg });
    const restoredView = await (await request(routes(restored), "GET", "/market/worker", "acme.near")).json();
    expect(restoredView.assignments).toHaveLength(1);
    expect(restoredView.assignments[0].assignment_id).toBe("assignment-original");
  });

  test("unproven legacy jobs/deliveries stay inaccessible and cannot be rebound by polling or redelivery", async () => {
    let posts = 0;
    const ctx = context((async (_url, init) => {
      if (init?.method === "POST") posts++;
      return Response.json({ assignments: [item("assignment-original")] });
    }) as typeof fetch);
    await observe(ctx);
    ctx.db.exec("UPDATE market_assignments SET agency_id = NULL; UPDATE market_deliveries SET agency_id = NULL");
    const before = ctx.db.query("SELECT * FROM market_assignments").get();
    expect((await ctx.m.worker.view()).assignments).toEqual([]);
    await expect(ctx.m.worker.submit("assignment-original", "Do not replay a legacy submission")).rejects.toThrow(/no verified agency ownership/);
    await ctx.m.worker.poll();
    const raw = created();
    await expect(ctx.m.worker.receive(signed(raw), raw)).rejects.toThrow(/ownership differs or is unproven/);
    expect(posts).toBe(0);
    expect(ctx.db.query("SELECT * FROM market_assignments").get()).toEqual(before);
    expect(ctx.db.query("SELECT agency_id FROM market_deliveries").get()).toEqual({ agency_id: null });
  });

  for (const legacyFirst of [true, false]) {
    test(`a quarantined historical assignment ${legacyFirst ? "before" : "after"} a healthy assignment cannot stop its poll`, async () => {
      let status = "in_progress";
      const ctx = context((async (_url: string | URL | Request, _init?: RequestInit) => {
        const list = [item("legacy", "accepted"), item("healthy", status)];
        return Response.json({ assignments: legacyFirst ? list : list.reverse() });
      }) as typeof fetch);
      await observe(ctx, "legacy", "legacy-delivery");
      ctx.db.query("UPDATE market_assignments SET agency_id = NULL WHERE assignment_id = ?").run("legacy");
      const original = ctx.db.query("SELECT * FROM market_assignments WHERE assignment_id = ?").get("legacy");
      await ctx.m.worker.poll();
      expect(ctx.m.worker.row("healthy").status).toBe("in_progress");
      status = "accepted";
      await ctx.m.worker.poll();
      expect(ctx.m.worker.row("healthy").status).toBe("accepted");
      const view = await ctx.m.worker.view();
      expect(view.assignments.map(a => a.assignment_id)).toEqual(["healthy"]);
      expect(view.last_poll?.error).toBeNull();
      expect(ctx.db.query("SELECT * FROM market_assignments WHERE assignment_id = ?").get("legacy")).toEqual(original);
      await expect(ctx.m.worker.submit("legacy", "Do not adopt this work")).rejects.toThrow(/no verified agency ownership/);
    });
  }
});

describe("worker submit outcome", () => {
  const version = (n: number, at = NOW + n * 1000) => ({ version: n, files: [], submittedAt: new Date(at).toISOString() });
  function workflow(initial = [] as ReturnType<typeof version>[], now = () => new Date(NOW)) {
    const state = {
      history: initial, status: "in_progress", raw: new Map<number, string>(), posts: [] as string[],
      reads: 0, rawReads: [] as number[],
      rawRequests: [] as { path: string; authorization: string | null; accept: string | null }[],
      list: null as null | (() => Promise<Response>),
      post: async (_text: string): Promise<Response> => { throw new TypeError("submission response lost"); },
      rawFailure: false,
    };
    const ctx = context((async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST") {
        const text = JSON.parse(String(init.body)).deliverableMarkdown as string;
        state.posts.push(text);
        return state.post(text);
      }
      if (isVersions(url)) { state.reads++; return state.list ? state.list() : Response.json({ versions: state.history }); }
      const raw = path.match(/\/deliverable\/versions\/(\d+)\/raw$/);
      if (raw) {
        const n = Number(raw[1]); state.rawReads.push(n);
        const headers = new Headers(init?.headers);
        state.rawRequests.push({ path, authorization: headers.get("authorization"), accept: headers.get("accept") });
        return state.rawFailure ? new Response("", { status: 503 }) : new Response(state.raw.get(n) ?? "different report");
      }
      return Response.json({ assignments: [item("a1", state.status)] });
    }) as typeof fetch, now);
    return { ...ctx, state };
  }

  test("baseline and attempt identity are durable before POST; unchanged history permits only an explicit original-payload retry", async () => {
    const ctx = workflow([version(1, NOW - 1000)]);
    await ctx.m.worker.poll();
    ctx.state.post = async () => {
      expect(ctx.m.worker.row("a1")).toMatchObject({ submit_phase: "posting", submit_state: "submitting", submit_started_at: new Date(NOW).toISOString() });
      expect(JSON.parse(ctx.m.worker.row("a1").submit_baseline!)).toEqual([{ version: 1, submittedAt: version(1, NOW - 1000).submittedAt }]);
      throw new TypeError("lost report response");
    };
    await ctx.m.worker.submit("a1", "New rework report");
    const original = ctx.m.worker.row("a1");
    expect(original.submit_attempt_id).toEqual(expect.any(String));
    const reloaded = new Market({ ...ctx.m.d });
    await reloaded.worker.poll();
    expect(reloaded.worker.row("a1")).toMatchObject({ submit_state: "none", submit_phase: "not_arrived", submit_attempt_id: original.submit_attempt_id, deliverable: "New rework report" });
    expect(ctx.state.rawReads).toEqual([]); // The old version cannot confirm the new attempt.
    await expect(reloaded.worker.submit("a1", "Changed payload cannot replace an uncertain attempt")).rejects.toThrow(/original saved Markdown/);
    ctx.state.post = async () => Response.json({ assignmentId: "a1", status: "submitted" });
    await reloaded.worker.submit("a1", "New rework report");
    expect(reloaded.worker.row("a1")).toMatchObject({ submit_state: "submitted", submit_attempt_id: original.submit_attempt_id, submit_started_at: original.submit_started_at });
    expect(ctx.state.posts).toEqual(["New rework report", "New rework report"]);
  });

  test("a matching newer server version confirms rework after reload, preserving actual in-progress status and local clock independence", async () => {
    const ctx = workflow([version(1, NOW - 1000)], () => new Date(NOW + 86_400_000));
    await ctx.m.worker.poll();
    await ctx.m.worker.submit("a1", "New rework report");
    const attempt = ctx.m.worker.row("a1");
    ctx.state.history.push(version(2)); ctx.state.raw.set(2, "New rework report");
    const reloaded = new Market({ ...ctx.m.d });
    await reloaded.worker.poll();
    expect(reloaded.worker.row("a1")).toMatchObject({ submit_state: "submitted", status: "in_progress", submit_attempt_id: attempt.submit_attempt_id, accepted_at: null, deposit_address: null });
    expect(ctx.state.rawReads).toEqual([2]);
    expect(ctx.state.rawRequests).toEqual([{ path: "/v1/assignments/a1/deliverable/versions/2/raw", authorization: "Bearer aat_test", accept: "text/markdown" }]);
    expect(ctx.state.posts).toEqual(["New rework report"]);
    ctx.state.post = async () => Response.json({ status: "submitted" });
    await reloaded.worker.submit("a1", "A later explicit revision");
    expect(reloaded.worker.row("a1").submit_attempt_id).not.toBe(attempt.submit_attempt_id);
  });

  test("attempt start and baseline survive a physical database reopen without inventing a replacement", async () => {
    const ctx = workflow([version(1, NOW - 1000)]); await ctx.m.worker.poll();
    await ctx.m.worker.submit("a1", "Persisted rework report");
    const original = ctx.m.worker.row("a1");
    const dir = mkdtempSync(join(tmpdir(), "covenant-worker-reopen-"));
    const path = join(dir, "worker.sqlite");
    let disk: Database | undefined;
    try {
      ctx.db.query("VACUUM INTO ?").run(path);
      disk = new Database(path);
      const reopened = new Market({ ...ctx.m.d, db: disk });
      expect(reopened.worker.row("a1")).toEqual(original);
      ctx.state.history.push(version(2)); ctx.state.raw.set(2, "Persisted rework report");
      await reopened.worker.poll();
      expect(reopened.worker.row("a1")).toMatchObject({ submit_state: "submitted", submit_attempt_id: original.submit_attempt_id,
        submit_started_at: original.submit_started_at, submit_baseline: original.submit_baseline });
      expect(ctx.state.posts).toEqual(["Persisted rework report"]);
    } finally { disk?.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  for (const evidence of ["different Markdown", "older timestamp", "history missing", "raw failure"] as const) {
    test(`${evidence} cannot confirm or release the pending rework attempt`, async () => {
      const ctx = workflow([version(1, NOW - 1000)]);
      await ctx.m.worker.poll(); await ctx.m.worker.submit("a1", "Original pending rework");
      const original = ctx.m.worker.row("a1");
      ctx.state.history = evidence === "history missing" ? [version(2)] : [version(1, NOW - 1000), version(2, evidence === "older timestamp" ? NOW - 2000 : NOW + 1000)];
      ctx.state.raw.set(2, evidence === "different Markdown" ? "Another report" : "Original pending rework");
      ctx.state.rawFailure = evidence === "raw failure";
      await expect(ctx.m.worker.poll()).rejects.toThrow();
      expect(ctx.m.worker.row("a1")).toMatchObject({ submit_state: "unknown", submit_attempt_id: original.submit_attempt_id, submit_baseline: original.submit_baseline, deliverable: "Original pending rework" });
      await expect(ctx.m.worker.submit("a1", "Replacement")).rejects.toThrow(/waiting/);
      expect(ctx.state.posts).toHaveLength(1);
    });
  }

  test("retry notices a matching arrival since its empty read and never sends the POST again", async () => {
    const ctx = workflow(); await ctx.m.worker.poll();
    await ctx.m.worker.submit("a1", "Original report");
    const id = ctx.m.worker.row("a1").submit_attempt_id;
    await ctx.m.worker.poll();
    expect(ctx.m.worker.row("a1").submit_phase).toBe("not_arrived");
    ctx.state.history.push(version(1)); ctx.state.raw.set(1, "Original report");
    await ctx.m.worker.submit("a1", "Original report");
    expect(ctx.m.worker.row("a1")).toMatchObject({ submit_state: "submitted", submit_attempt_id: id });
    expect(ctx.state.posts).toEqual(["Original report"]);
  });

  for (const body of ["not json", "null", "{}", '{"status":"in_progress"}', '{"status":"submitted","assignmentId":"different-job"}']) {
    test(`malformed POST success ${body} remains unknown until a matching new version is read`, async () => {
      const ctx = workflow(); await ctx.m.worker.poll();
      ctx.state.post = async () => new Response(body, { status: 200 });
      await ctx.m.worker.submit("a1", "Original report");
      const attempt = ctx.m.worker.row("a1");
      expect(attempt.submit_state).toBe("unknown");
      await expect(ctx.m.worker.submit("a1", "Replacement")).rejects.toThrow(/waiting/);
      ctx.state.list = async () => new Response("{}", { status: 503 });
      await expect(ctx.m.worker.poll()).rejects.toThrow(/503/);
      ctx.state.list = null; ctx.state.history.push(version(1)); ctx.state.raw.set(1, "Original report");
      await ctx.m.worker.poll();
      expect(ctx.m.worker.row("a1")).toMatchObject({ submit_state: "submitted", submit_attempt_id: attempt.submit_attempt_id, deliverable: "Original report" });
      expect(ctx.state.posts).toEqual(["Original report"]);
    });
  }

  for (const failure of ["transport", "403", "404", "500", "not-json", "null", "missing-list", "null-list", "bad-entry", "missing-files", "missing-date", "bad-date", "bad-version", "duplicate-version"] as const) {
    test(`failed/malformed ${failure} version read retains uncertainty after POST and reload`, async () => {
      const ctx = workflow(); await ctx.m.worker.poll();
      await ctx.m.worker.submit("a1", "Original report");
      const original = ctx.m.worker.row("a1");
      ctx.state.list = async () => {
        if (failure === "transport") throw new TypeError("version read failed");
        if (["403", "404", "500"].includes(failure)) return new Response("{}", { status: Number(failure) });
        if (failure === "not-json") return new Response("bad json");
        const malformed: Record<string, unknown> = {
          "null": null, "missing-list": {}, "null-list": { versions: null }, "bad-entry": { versions: [null] },
          "missing-files": { versions: [{ version: 1, submittedAt: version(1).submittedAt }] },
          "missing-date": { versions: [{ version: 1, files: [] }] },
          "bad-date": { versions: [{ ...version(1), submittedAt: "not a date" }] },
          "bad-version": { versions: [{ ...version(1), version: "1" }] },
          "duplicate-version": { versions: [version(1), version(1)] },
        };
        return Response.json(malformed[failure]);
      };
      const reloaded = new Market({ ...ctx.m.d });
      await expect(reloaded.worker.poll()).rejects.toThrow();
      expect(reloaded.worker.row("a1")).toMatchObject({ submit_state: "unknown", submit_attempt_id: original.submit_attempt_id, deliverable: "Original report" });
      await expect(reloaded.worker.submit("a1", "Replacement")).rejects.toThrow(/waiting/);
      expect(ctx.state.posts).toHaveLength(1);
    });
  }

  test("preflight failure sends no POST and can be retried; two clicks serialize before the baseline await", async () => {
    const ctx = workflow(); await ctx.m.worker.poll();
    const read = deferred<Response>(), started = deferred<void>();
    ctx.state.list = async () => { started.resolve(); return read.promise; };
    const sending = ctx.m.worker.submit("a1", "Saved report");
    await started.promise;
    expect(ctx.m.worker.row("a1")).toMatchObject({ submit_state: "submitting", submit_phase: "preflight", submit_baseline: null });
    await expect(ctx.m.worker.submit("a1", "Second click")).rejects.toThrow(/waiting/);
    read.resolve(new Response("{}", { status: 503 })); await sending;
    expect(ctx.m.worker.row("a1")).toMatchObject({ submit_state: "none", submit_phase: "preflight", submit_baseline: null, submit_error: expect.stringContaining("no submission POST was started") });
    expect(ctx.state.posts).toEqual([]);
    ctx.state.list = null; ctx.state.post = async () => Response.json({ status: "submitted" });
    await ctx.m.worker.submit("a1", "Saved report");
    expect(ctx.state.posts).toEqual(["Saved report"]);
  });

  test("legacy pending NULL metadata is not backfilled or confirmed by historical versions or assignment status", async () => {
    const ctx = workflow([version(1)]); await ctx.m.worker.poll();
    ctx.db.query("UPDATE market_assignments SET submit_state='unknown', deliverable='Historical report' WHERE assignment_id='a1'").run();
    ctx.state.raw.set(1, "Historical report"); ctx.state.status = "submitted";
    const reloaded = new Market({ ...ctx.m.d });
    await expect(reloaded.worker.poll()).rejects.toThrow(/no proven attempt baseline/);
    expect(reloaded.worker.row("a1")).toMatchObject({ submit_state: "unknown", submit_attempt_id: null, submit_started_at: null, submit_baseline: null, deliverable: "Historical report" });
    ctx.state.status = "in_progress";
    await expect(reloaded.worker.poll()).rejects.toThrow(/no proven attempt baseline/);
    await expect(reloaded.worker.submit("a1", "Do not replace unproven historical work")).rejects.toThrow(/waiting/);
    expect(ctx.state.reads).toBe(0); expect(ctx.state.rawReads).toEqual([]); expect(ctx.state.posts).toEqual([]);
  });

  test("a saved preflight interrupted before a baseline cannot be confused with a posted historical attempt", async () => {
    const ctx = workflow(); await ctx.m.worker.poll();
    const attemptId = crypto.randomUUID();
    ctx.db.query(`UPDATE market_assignments SET submit_state='submitting', deliverable='Saved preflight report',
      submit_attempt_id=?, submit_started_at=?, submit_phase='preflight', submit_baseline=NULL WHERE assignment_id='a1'`)
      .run(attemptId, new Date(NOW).toISOString());
    const reloaded = new Market({ ...ctx.m.d }); await reloaded.worker.poll();
    expect(reloaded.worker.row("a1")).toMatchObject({ submit_state: "none", submit_attempt_id: attemptId, submit_baseline: null,
      submit_error: expect.stringContaining("no submission POST was started") });
    expect(ctx.state.reads).toBe(0); expect(ctx.state.posts).toEqual([]);
  });

  test("an active POST skips recovery while its own success remains proof, and newer assignment rework status survives", async () => {
    const ctx = workflow([version(1, NOW - 1000)]); await ctx.m.worker.poll();
    const reply = deferred<Response>(), started = deferred<void>();
    ctx.state.post = async () => { started.resolve(); return reply.promise; };
    const sending = ctx.m.worker.submit("a1", "New rework report"); await started.promise;
    ctx.state.status = "submitted"; await ctx.m.worker.poll();
    ctx.state.status = "in_progress"; await ctx.m.worker.poll();
    expect(ctx.m.worker.row("a1")).toMatchObject({ submit_state: "submitting", status: "in_progress" });
    expect(ctx.state.reads).toBe(1);
    await expect(ctx.m.worker.submit("a1", "Overlapping rework")).rejects.toThrow(/waiting/);
    reply.resolve(Response.json({ status: "submitted" })); await sending;
    expect(ctx.m.worker.row("a1")).toMatchObject({ submit_state: "submitted", status: "in_progress", deliverable: "New rework report" });
  });

  test("a bare accepted status cannot confirm an unanswered attempt; a matching version can", async () => {
    const ctx = workflow([version(1, NOW - 1000)]); await ctx.m.worker.poll();
    await ctx.m.worker.submit("a1", "New report");
    ctx.state.status = "accepted"; ctx.state.list = async () => new Response("{}", { status: 503 });
    await expect(ctx.m.worker.poll()).rejects.toThrow(/503/);
    expect(ctx.m.worker.row("a1")).toMatchObject({ submit_state: "unknown", status: "accepted" });
    ctx.state.list = null; ctx.state.history.push(version(2)); ctx.state.raw.set(2, "New report");
    await ctx.m.worker.poll();
    expect(ctx.m.worker.row("a1")).toMatchObject({ submit_state: "submitted", status: "accepted" });
    expect(ctx.state.posts).toEqual(["New report"]);
  });

  test("concurrent polls share one recovery read and release their lock after failure", async () => {
    const ctx = workflow(); await ctx.m.worker.poll(); await ctx.m.worker.submit("a1", "Original report");
    const reply = deferred<Response>(), started = deferred<void>();
    ctx.state.list = async () => { started.resolve(); return reply.promise; };
    const first = ctx.m.worker.poll(), second = ctx.m.worker.poll();
    const results = Promise.allSettled([first, second]);
    expect(first).toBe(second); await started.promise;
    reply.resolve(new Response("{}", { status: 503 }));
    expect((await results).map(r => r.status)).toEqual(["rejected", "rejected"]);
    ctx.state.list = null; await ctx.m.worker.poll();
    expect(ctx.m.worker.row("a1")).toMatchObject({ submit_state: "none", submit_phase: "not_arrived" });
    expect(ctx.state.posts).toHaveLength(1); expect(ctx.state.reads).toBe(3);
  });

  for (const replyKind of ["submitted", "refused"] as const) test(`a queued B ${replyKind} reply while A versions waits is not downgraded by a stale recovery snapshot`, async () => {
    const aRead = deferred<Response>(), aStarted = deferred<void>(), bReply = deferred<Response>(), bStarted = deferred<void>();
    let readsA = 0, readsB = 0, statusB = "in_progress";
    const ctx = context((async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init?.method === "POST") {
        if (path.endsWith("/a/submit")) throw new TypeError("A response lost");
        bStarted.resolve(); return bReply.promise;
      }
      if (isVersions(url)) {
        if (path.endsWith("/a/deliverable/versions")) {
          if (++readsA === 1) return Response.json({ versions: [] });
          aStarted.resolve(); return aRead.promise;
        }
        if (++readsB === 1) return Response.json({ versions: [] });
        return new Response("{}", { status: 503 });
      }
      return Response.json({ assignments: [item("a"), item("b", statusB)] });
    }) as typeof fetch);
    await ctx.m.worker.poll(); await ctx.m.worker.submit("a", "Original A");
    const postingB = ctx.m.worker.submit("b", "Original B"); await bStarted.promise;
    const polling = ctx.m.worker.poll(); const result = polling.then(() => null, (error: unknown) => error);
    await aStarted.promise;
    statusB = replyKind === "submitted" ? "submitted" : "in_progress";
    bReply.resolve(replyKind === "submitted" ? Response.json({ status: "submitted" }) : new Response("{}", { status: 409 }));
    await postingB;
    const confirmed = ctx.m.worker.row("b");
    aRead.resolve(Response.json({ versions: [] })); expect(await result).toBeNull();
    expect(ctx.m.worker.row("b")).toEqual(confirmed); expect(readsB).toBe(1);
    expect(ctx.m.worker.row("a")).toMatchObject({ submit_state: "none", submit_phase: "not_arrived" });
  });
});

describe("market HTTP authorization and webhook bounds", () => {
  test("worker and agency reads authorize before private views; wallet mutation requires that owner", async () => {
    const ctx = context();
    await observe(ctx);
    let views = 0;
    const original = ctx.m.worker.view.bind(ctx.m.worker);
    ctx.m.worker.view = async () => { views++; return original(); };
    let agencyViews = 0;
    const originalAgency = ctx.m.view.bind(ctx.m);
    ctx.m.view = async (id) => { agencyViews++; return originalAgency(id); };
    const app = routes(ctx.m);
    for (const [account, expected] of [[undefined, 401], ["other.near", 403]] as const) {
      expect((await request(app, "GET", "/market/worker", account)).status).toBe(expected);
      expect((await request(app, "GET", `/market/agencies/${ctx.agency.id}`, account)).status).toBe(expected);
      expect((await request(app, "POST", "/market/worker/poll", account)).status).toBe(expected);
      expect((await request(app, "POST", "/market/worker/jobs/assignment-original/submit", account, { markdown: "unauthorized" })).status).toBe(expected);
      expect((await request(app, "POST", `/market/agencies/${ctx.agency.id}/quote`, account, { handle: "writer", brief: "unauthorized" })).status).toBe(expected);
      expect(views).toBe(0);
      expect(agencyViews).toBe(0);
    }
    const allowed = await request(app, "GET", "/market/worker", "acme.near");
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).assignments).toHaveLength(1);
    expect(views).toBe(1);
    expect((await request(app, "GET", `/market/agencies/${ctx.agency.id}`, "acme.near")).status).toBe(200);
    expect(agencyViews).toBe(1);
    expect(ctx.stub.calls.filter(([call]) => call === "hire" || call === "quote")).toEqual([]);
  });

  test("a DAO member can read while only a proposer can mutate; public proposal rights admit no outsider", async () => {
    const ctx = context();
    const dao = ctx.m.agencies.create({ name: "Council", owner: "council.sputnik-dao.near", signer: "dao" });
    ctx.cfg.agencyId = dao.id;
    const policy: DaoPolicy = { proposal_bond: "1", default_vote_policy: { threshold: [1, 2] }, roles: [
      { name: "Readers", kind: { Group: ["reader.near"] }, permissions: [], vote_policy: {} },
      { name: "Proposers", kind: { Group: ["proposer.near"] }, permissions: ["call:AddProposal"], vote_policy: {} },
    ] };
    ctx.m.d.daoPolicy = async () => policy;
    const app = routes(ctx.m);
    for (const [account, expected] of [[undefined, 401], ["outsider.near", 403], ["reader.near", 200], ["proposer.near", 200]] as const)
      expect((await request(app, "GET", "/market/worker", account)).status).toBe(expected);
    expect((await request(app, "POST", "/market/worker/poll", "reader.near")).status).toBe(403);
    expect((await request(app, "POST", "/market/worker/poll", "proposer.near")).status).toBe(200);
    policy.roles.push({ name: "Public", kind: "Everyone", permissions: ["call:AddProposal"], vote_policy: {} });
    expect((await request(app, "POST", "/market/worker/poll", "outsider.near")).status).toBe(403);
  });

  test("streamed bytes retain exact HMAC and oversized envelopes never record a delivery", async () => {
    const ctx = context();
    const app = routes(ctx.m);
    const raw = enc.encode('{ "assignment_id": "utf8-job", "title": "café ☕", "description": "exact bytes" }\n');
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (let offset = 0; offset < raw.length; offset += 7) controller.enqueue(raw.slice(offset, offset + 7));
      controller.close();
    } });
    expect((await app.request("/api/market/webhook", { method: "POST", headers: signed(raw), body: stream })).status).toBe(200);
    expect(ctx.m.worker.row("utf8-job").title).toBe("café ☕");
    const tampered = new Uint8Array([...raw, 32]);
    expect((await app.request("/api/market/webhook", { method: "POST", headers: signed(raw, "tampered-delivery"), body: tampered })).status).toBe(401);
    const oversized = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(MAX_WEBHOOK_BODY)); controller.enqueue(new Uint8Array([32])); controller.close();
    } });
    const oversizedHeaders = signed(raw, "oversized-delivery");
    oversizedHeaders.set("content-length", "1"); // A small declared length cannot bypass the streamed-byte bound.
    expect((await app.request("/api/market/webhook", { method: "POST", headers: oversizedHeaders, body: oversized })).status).toBe(413);
    const declaredHeaders = signed(raw, "declared-oversized");
    declaredHeaders.set("content-length", String(MAX_WEBHOOK_BODY + 1));
    expect((await app.request("/api/market/webhook", { method: "POST", headers: declaredHeaders, body: raw })).status).toBe(413);
    expect(ctx.db.query("SELECT delivery_id FROM market_deliveries").all()).toEqual([{ delivery_id: "delivery-original" }]);
    expect(ctx.db.query("SELECT assignment_id FROM market_assignments").all()).toEqual([{ assignment_id: "utf8-job" }]);
  });
});
