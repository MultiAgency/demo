import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
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
    expect(db.query("SELECT * FROM market_assignments").get()).toEqual({ assignment_id: "legacy-assignment", seen_at: "2026-11-10", deliverable: "already sent", submit_state: "unknown", agency_id: null });
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
    await expect(ctx.m.worker.poll()).rejects.toThrow(/no verified agency ownership/);
    const raw = created();
    await expect(ctx.m.worker.receive(signed(raw), raw)).rejects.toThrow(/ownership differs or is unproven/);
    expect(posts).toBe(0);
    expect(ctx.db.query("SELECT * FROM market_assignments").get()).toEqual(before);
    expect(ctx.db.query("SELECT agency_id FROM market_deliveries").get()).toEqual({ agency_id: null });
  });
});

describe("worker submit outcome", () => {
  for (const pendingState of ["unknown", "submitting"] as const) for (const confirmedState of ["submitted", "accepted"] as const) {
    test(`stale ${pendingState} becomes unknown when versions cannot be read; ${confirmedState} confirms assignment arrival`, async () => {
      let now = NOW;
      let status = "in_progress";
      let posts = 0;
      const ctx = context((async (url, init) => {
        if (init?.method === "POST") { posts++; throw new TypeError("Lost response after the original submission may have executed"); }
        if (isVersions(url)) return new Response("{}", { status: 503 });
        return Response.json({ assignments: [item("a1", status)] });
      }) as typeof fetch, () => new Date(now));
      await ctx.m.worker.poll();
      await ctx.m.worker.submit("a1", "Original deliverable retained across uncertainty");
      if (pendingState === "submitting") {
        // Simulate the durable row left by a process stopping after its write-ahead record, before reply handling.
        ctx.db.query("UPDATE market_assignments SET submit_state = 'submitting' WHERE assignment_id = ?").run("a1");
      }
      await ctx.m.agencies.deposit(ctx.agency.id);
      now += 3 * 60 * 60_000; // Time and in-progress status alone do not replace the versions read.
      const reloaded = new Market({ ...ctx.m.d });
      for (let poll = 0; poll < 2; poll++) {
        await expect(reloaded.worker.poll()).rejects.toThrow(/503/);
        expect(reloaded.worker.row("a1")).toMatchObject({ agency_id: ctx.agency.id, assignment_id: "a1", job_id: "job-a1", status: "in_progress", submit_state: "unknown", deliverable: "Original deliverable retained across uncertainty" });
        await expect(reloaded.worker.submit("a1", "Replacement must not be sent")).rejects.toThrow(/waiting for the market/);
      }
      expect(posts).toBe(1);
      status = confirmedState;
      await reloaded.worker.poll();
      const confirmed = reloaded.worker.row("a1");
      expect(confirmed).toMatchObject({ agency_id: ctx.agency.id, assignment_id: "a1", job_id: "job-a1", status: confirmedState, submit_state: "submitted", deliverable: "Original deliverable retained across uncertainty" });
      expect(confirmed.accepted_at).toBe(confirmedState === "accepted" ? new Date(now).toISOString() : null);
      expect(confirmed.deposit_address).toBe(confirmedState === "accepted" ? "deposit.near" : null);
      expect(posts).toBe(1);
    });
  }

  for (const body of ["not json", "null", "{}", '{"status":"in_progress"}', '{"status":"submitted","assignmentId":"different-job"}']) {
    test(`a malformed successful reply ${body} stays unknown without another POST`, async () => {
      let status = "in_progress";
      let posts = 0;
      const ctx = context((async (url, init) => {
        if (init?.method === "POST") { posts++; return new Response(body, { status: 200 }); }
        if (isVersions(url)) return new Response("{}", { status: 503 });
        return Response.json({ assignments: [item("a1", status)] });
      }) as typeof fetch);
      await ctx.m.worker.poll();
      const submitted = await ctx.m.worker.submit("a1", "The original report");
      expect(submitted).toMatchObject({ assignment_id: "a1", agency_id: ctx.agency.id, deliverable: "The original report", status: "in_progress", submit_state: "unknown" });
      await expect(ctx.m.worker.submit("a1", "A replacement report")).rejects.toThrow(/waiting for the market/);
      await expect(ctx.m.worker.poll()).rejects.toThrow(/503/);
      expect(ctx.m.worker.row("a1").submit_state).toBe("unknown");
      status = "submitted";
      await ctx.m.worker.poll();
      expect(ctx.m.worker.row("a1")).toMatchObject({ assignment_id: "a1", deliverable: "The original report", submit_state: "submitted", status: "submitted", accepted_at: null, deposit_address: null });
      expect(posts).toBe(1);
    });
  }

  test("empty versions enables a later explicit resend under the same encoded assignment; polling sends nothing", async () => {
    const id = "original/assignment ?#";
    const calls: { path: string; method: string; auth: string | null; body: unknown }[] = [];
    let posts = 0;
    const ctx = context((async (url, init) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      calls.push({ path, method, auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === "POST") {
        posts++;
        if (posts === 1) throw new TypeError("response lost");
        return Response.json({ assignmentId: id, status: "submitted" });
      }
      return Response.json(isVersions(url) ? { versions: [] } : { assignments: [item(id)] });
    }) as typeof fetch);
    await ctx.m.worker.poll();
    await ctx.m.worker.submit(id, "Original report");
    expect(ctx.m.worker.row(id).submit_state).toBe("unknown");
    await ctx.m.worker.poll();
    expect(ctx.m.worker.row(id)).toMatchObject({ assignment_id: id, agency_id: ctx.agency.id, job_id: `job-${id}`, status: "in_progress", submit_state: "none", deliverable: "Original report", accepted_at: null, deposit_address: null });
    expect(posts).toBe(1);
    expect(calls.filter(c => c.path.endsWith("/deliverable/versions"))).toEqual([{ path: `/v1/assignments/${encodeURIComponent(id)}/deliverable/versions`, method: "GET", auth: "Bearer aat_test", body: null }]);
    const resent = await ctx.m.worker.submit(id, "The builder explicitly resends this report");
    expect(resent).toMatchObject({ assignment_id: id, agency_id: ctx.agency.id, status: "submitted", submit_state: "submitted", deliverable: "The builder explicitly resends this report" });
    expect(posts).toBe(2);
    expect(calls.filter(c => c.method === "POST").map(c => ({ path: c.path, auth: c.auth, body: c.body }))).toEqual([
      { path: `/v1/assignments/${encodeURIComponent(id)}/submit`, auth: "Bearer aat_test", body: { deliverableMarkdown: "Original report" } },
      { path: `/v1/assignments/${encodeURIComponent(id)}/submit`, auth: "Bearer aat_test", body: { deliverableMarkdown: "The builder explicitly resends this report" } },
    ]);
    expect(ctx.db.query("SELECT assignment_id FROM market_assignments").all()).toEqual([{ assignment_id: id }]);
  });

  test("any recorded version proves assignment-level arrival while in-progress status still permits explicit rework", async () => {
    let posts = 0;
    let versionReads = 0;
    const ctx = context((async (url, init) => {
      if (init?.method === "POST") {
        posts++;
        if (posts === 1) throw new TypeError("latest report response lost");
        return Response.json({ assignmentId: "a1", status: "submitted" });
      }
      if (isVersions(url)) {
        versionReads++;
        // The selected rule deliberately treats an older version as arrival evidence for the assignment. It does
        // not identify the locally pending report as that version and does not infer acceptance or settlement.
        return Response.json({ versions: [{ ...versions[0], submittedAt: new Date(NOW - 86_400_000).toISOString() }] });
      }
      return Response.json({ assignments: [item("a1")] });
    }) as typeof fetch);
    await ctx.m.worker.poll();
    await ctx.m.worker.submit("a1", "Locally retained report, not matched to a remote version");
    await ctx.m.worker.poll();
    expect(ctx.m.worker.row("a1")).toMatchObject({ assignment_id: "a1", agency_id: ctx.agency.id, status: "in_progress", submit_state: "submitted", deliverable: "Locally retained report, not matched to a remote version", accepted_at: null, deposit_address: null });
    expect(posts).toBe(1);
    expect(versionReads).toBe(1);
    const view = await ctx.m.worker.view();
    expect(view.assignments[0]?.status).toBe("in_progress");
    expect(view.assignments[0]?.accepted_at).toBeNull();
    expect(ctx.stub.calls.filter(([call]) => call === "hire")).toEqual([]);
    await ctx.m.worker.submit("a1", "Explicit revision after the version check");
    expect(posts).toBe(2);
  });

  for (const failure of ["transport", "403", "404", "500", "not-json", "null", "missing-list", "null-list", "bad-entry", "bad-version", "missing-files", "missing-date"] as const) {
    test(`version read ${failure} leaves the original submission unknown and retry disabled`, async () => {
      let posts = 0;
      let reads = 0;
      const ctx = context((async (url, init) => {
        if (init?.method === "POST") { posts++; throw new TypeError("submission response lost"); }
        if (!isVersions(url)) return Response.json({ assignments: [item("a1")] });
        reads++;
        if (failure === "transport") throw new TypeError("versions unavailable");
        if (failure === "403" || failure === "404" || failure === "500") return new Response("{}", { status: Number(failure) });
        if (failure === "not-json") return new Response("not JSON", { status: 200 });
        const body = {
          "null": null, "missing-list": {}, "null-list": { versions: null }, "bad-entry": { versions: [null] },
          "bad-version": { versions: [{ ...versions[0], version: "1" }] },
          "missing-files": { versions: [{ version: 1, submittedAt: new Date(NOW).toISOString() }] },
          "missing-date": { versions: [{ version: 1, files: [] }] },
        }[failure];
        return Response.json(body);
      }) as typeof fetch);
      await ctx.m.worker.poll();
      await ctx.m.worker.submit("a1", "Original pending report");
      await expect(ctx.m.worker.poll()).rejects.toThrow();
      expect(ctx.m.worker.row("a1")).toMatchObject({ assignment_id: "a1", agency_id: ctx.agency.id, submit_state: "unknown", status: "in_progress", deliverable: "Original pending report" });
      expect(ctx.m.worker.row("a1").submit_error).toBeTruthy();
      expect((await ctx.m.worker.view()).last_poll?.error).toBeTruthy();
      await expect(ctx.m.worker.submit("a1", "Must not replace pending report")).rejects.toThrow(/waiting for the market/);
      expect(posts).toBe(1);
      expect(reads).toBe(1);
    });
  }

  test("an active POST skips version recovery and remains non-retryable until its own response resolves", async () => {
    const reply = deferred<Response>();
    const started = deferred<void>();
    let posts = 0;
    let versionReads = 0;
    const ctx = context((async (url, init) => {
      if (init?.method === "POST") { posts++; started.resolve(); return reply.promise; }
      if (isVersions(url)) { versionReads++; return Response.json({ versions: [] }); }
      return Response.json({ assignments: [item("a1")] });
    }) as typeof fetch);
    await ctx.m.worker.poll();
    const posting = ctx.m.worker.submit("a1", "Still in flight");
    try {
      await started.promise;
      await ctx.m.worker.poll();
      expect(ctx.m.worker.row("a1")).toMatchObject({ status: "in_progress", submit_state: "submitting", deliverable: "Still in flight" });
      expect(versionReads).toBe(0);
      await expect(ctx.m.worker.submit("a1", "Do not race the active POST")).rejects.toThrow(/waiting for the market/);
      expect(posts).toBe(1);
    } finally { reply.resolve(Response.json({ assignmentId: "a1", status: "submitted" })); await posting; }
    expect(ctx.m.worker.row("a1").submit_state).toBe("submitted");
  });

  test("submitted then in-progress observations cannot admit rework while the original POST is still active", async () => {
    const replies = [deferred<Response>(), deferred<Response>()];
    const started = [deferred<void>(), deferred<void>()];
    let status = "in_progress";
    let posts = 0;
    let versionReads = 0;
    const ctx = context((async (url, init) => {
      if (init?.method === "POST") {
        const index = posts++;
        started[index]!.resolve();
        return replies[index]!.promise;
      }
      if (isVersions(url)) { versionReads++; return Response.json({ versions: [] }); }
      return Response.json({ assignments: [item("a1", status)] });
    }) as typeof fetch);
    await ctx.m.worker.poll();
    const first = ctx.m.worker.submit("a1", "First delivery is still in flight");
    let second: ReturnType<typeof ctx.m.worker.submit> | undefined;
    try {
      await started[0]!.promise;
      status = "submitted";
      await ctx.m.worker.poll();
      status = "in_progress";
      await ctx.m.worker.poll();
      expect(ctx.m.worker.row("a1")).toMatchObject({ status: "in_progress", submit_state: "submitted" });
      await expect(ctx.m.worker.submit("a1", "Premature revision")).rejects.toThrow(/waiting for the market/);
      expect(posts).toBe(1);
      replies[0]!.resolve(Response.json({ status: "submitted" }));
      await first;
      // A late successful POST must not replace the newer in-progress rework status with its old submitted answer.
      expect(ctx.m.worker.row("a1")).toMatchObject({ status: "in_progress", submit_state: "submitted" });
      second = ctx.m.worker.submit("a1", "Explicit rework after first call finishes");
      await started[1]!.promise;
      await ctx.m.worker.poll();
      expect(ctx.m.worker.row("a1")).toMatchObject({ status: "in_progress", submit_state: "submitting", deliverable: "Explicit rework after first call finishes" });
      await expect(ctx.m.worker.submit("a1", "Do not overlap the new revision either")).rejects.toThrow(/waiting for the market/);
      expect(posts).toBe(2);
      expect(versionReads).toBe(0);
    } finally {
      replies[0]!.resolve(Response.json({ status: "submitted" }));
      replies[1]!.resolve(Response.json({ status: "submitted" }));
      await first;
      await second;
    }
  });

  test("concurrent polls share one version read and release their lock after a failed read", async () => {
    const reply = deferred<Response>();
    const started = deferred<void>();
    let reads = 0;
    let posts = 0;
    const ctx = context((async (url, init) => {
      if (init?.method === "POST") { posts++; throw new TypeError("response lost"); }
      if (isVersions(url)) {
        reads++;
        if (reads === 1) { started.resolve(); return reply.promise; }
        return Response.json({ versions: [] });
      }
      return Response.json({ assignments: [item("a1")] });
    }) as typeof fetch);
    await ctx.m.worker.poll();
    await ctx.m.worker.submit("a1", "Original report");
    const first = ctx.m.worker.poll();
    const second = ctx.m.worker.poll();
    const results = Promise.allSettled([first, second]);
    expect(first).toBe(second);
    try {
      await started.promise;
      expect(reads).toBe(1);
    } finally { reply.resolve(new Response("{}", { status: 503 })); }
    expect((await results).map(r => r.status)).toEqual(["rejected", "rejected"]);
    expect(ctx.m.worker.row("a1").submit_state).toBe("unknown");
    await ctx.m.worker.poll();
    expect(reads).toBe(2);
    expect(ctx.m.worker.row("a1").submit_state).toBe("none");
    expect((await ctx.m.worker.view()).last_poll?.error).toBeNull();
    expect(posts).toBe(1);
  });

  for (const replyKind of ["submitted", "refused"] as const) {
    test(`a queued assignment whose POST becomes ${replyKind} while another version read waits is not recovered from a stale snapshot`, async () => {
      const firstVersions = deferred<Response>();
      const firstReadStarted = deferred<void>();
      const secondPost = deferred<Response>();
      const secondPostStarted = deferred<void>();
      let statusB = "in_progress";
      let postsA = 0;
      let postsB = 0;
      let readsA = 0;
      let readsB = 0;
      const ctx = context((async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (init?.method === "POST") {
          if (path.endsWith("/a/submit")) { postsA++; throw new TypeError("A's response was lost"); }
          postsB++;
          if (postsB === 1) { secondPostStarted.resolve(); return secondPost.promise; }
          return Response.json({ assignmentId: "b", status: "submitted" });
        }
        if (isVersions(url)) {
          if (path.endsWith("/a/deliverable/versions")) {
            readsA++;
            firstReadStarted.resolve();
            return firstVersions.promise;
          }
          readsB++;
          // A realistic failing read, not a contradictory empty list after B's successful submission.
          return new Response("{}", { status: 503 });
        }
        return Response.json({ assignments: [item("a"), item("b", statusB)] });
      }) as typeof fetch);
      await ctx.m.worker.poll();
      await ctx.m.worker.submit("a", "Original A report");
      const posting = ctx.m.worker.submit("b", "Original B report");
      await secondPostStarted.promise;
      const polling = ctx.m.worker.poll();
      const pollResult = polling.then(() => null, (error: unknown) => error);
      try {
        // The original query contains both A (unknown) and B (submitting); only A is being read yet.
        await firstReadStarted.promise;
        statusB = replyKind === "submitted" ? "submitted" : "in_progress";
        secondPost.resolve(replyKind === "submitted"
          ? Response.json({ assignmentId: "b", status: "submitted" })
          : new Response("{}", { status: 409 }));
        await posting;
        const before = ctx.m.worker.row("b");
        expect(before.submit_state).toBe(replyKind === "submitted" ? "submitted" : "none");
        firstVersions.resolve(Response.json({ versions: [] }));
        expect(await pollResult).toBeNull();
        expect(ctx.m.worker.row("b")).toEqual(before);
        expect(readsA).toBe(1);
        expect(readsB).toBe(0);
        expect(postsA).toBe(1);
        expect(postsB).toBe(1);
        expect(ctx.m.worker.row("a")).toMatchObject({ submit_state: "none", deliverable: "Original A report" });
        expect((await ctx.m.worker.view()).last_poll?.error).toBeNull();

        // A successful B can move to buyer-requested rework; a refused B was already eligible for manual retry.
        statusB = "in_progress";
        await ctx.m.worker.poll();
        await ctx.m.worker.submit("b", "Explicit B revision or retry");
        expect(ctx.m.worker.row("b")).toMatchObject({ submit_state: "submitted", status: "submitted", deliverable: "Explicit B revision or retry" });
        expect(postsB).toBe(2);
        expect(readsB).toBe(0);
      } finally {
        firstVersions.resolve(Response.json({ versions: [] }));
        secondPost.resolve(Response.json({ assignmentId: "b", status: "submitted" }));
        await posting;
        await pollResult;
      }
    });
  }

  for (const replyKind of ["success", "lost"] as const) {
    test(`a late POST ${replyKind} cannot undo a concurrent poll's accepted assignment`, async () => {
      let status = "in_progress";
      let posts = 0;
      let versionReads = 0;
      const reply = deferred<Response>();
      const started = deferred<void>();
      const ctx = context((async (url, init) => {
        if (init?.method === "POST") { posts++; started.resolve(); return reply.promise; }
        if (isVersions(url)) { versionReads++; return Response.json({ versions: [] }); }
        return Response.json({ assignments: [item("a1", status)] });
      }) as typeof fetch);
      await ctx.m.worker.poll();
      const posting = ctx.m.worker.submit("a1", "The original delivery");
      try {
        await started.promise;
        status = "accepted";
        await ctx.m.worker.poll();
        expect(ctx.m.worker.row("a1")).toMatchObject({ submit_state: "submitted", status: "accepted", accepted_at: new Date(NOW).toISOString() });
      } finally {
        if (replyKind === "success") reply.resolve(Response.json({ status: "submitted" }));
        else reply.reject(new TypeError("late response lost"));
        await posting;
      }
      expect(ctx.m.worker.row("a1")).toMatchObject({ assignment_id: "a1", submit_state: "submitted", status: "accepted", deliverable: "The original delivery", submit_error: null });
      expect(posts).toBe(1);
      expect(versionReads).toBe(0);
    });
  }
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
