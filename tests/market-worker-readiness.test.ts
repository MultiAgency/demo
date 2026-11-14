import { expect, test } from "bun:test";
import { Market } from "../src/server/market";
import { marketWith } from "./support/market-stub";

const worker = (agencyId: string) => ({ token: "aat_fixture", secret: "s".repeat(32), agencyId });

test("startup refuses a worker bound to no agency, and accepts one bound to an agency created in Paperwork", () => {
  const ctx = marketWith();
  expect(() => new Market({ ...ctx.m.d, worker: worker("missing-agency") }).requireWorkerAgency()).toThrow(/MARKET_WORKER_AGENCY names no agency/);
  expect(() => new Market({ ...ctx.m.d, worker: worker(ctx.agency.id) }).requireWorkerAgency()).not.toThrow();
  expect(() => ctx.m.requireWorkerAgency()).not.toThrow(); // no worker configured
});

test("the timer reports a failing assignment poll once, each different failure, and its recovery", async () => {
  let answer: () => Response = () => new Response("{}", { status: 503 });
  const ctx = marketWith({ fetch: (async () => answer()) as unknown as typeof fetch });
  const m = new Market({ ...ctx.m.d, worker: worker(ctx.agency.id) });
  const lines: string[] = [];
  const log = (msg: string) => lines.push(msg);
  await m.tick(log);
  await m.tick(log);
  answer = () => new Response("{}", { status: 401 });
  await m.tick(log);
  answer = () => Response.json({ assignments: [] });
  await m.tick(log);
  await m.tick(log);
  expect(lines).toEqual([
    "market worker: assignment poll failed: The market answered 503 to GET /v1/agents/me/assignments.",
    "market worker: assignment poll failed: The market answered 401 to GET /v1/agents/me/assignments.",
    "market worker: assignment poll recovered",
  ]);
  expect(lines.join("\n")).not.toContain("aat_");
});

test("an agency with no market agent set up can still read and deliver its listed agent's jobs", async () => {
  const posts: string[] = [];
  const send = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "POST") { posts.push(path); return Response.json({ assignmentId: "a1", status: "accepted" }); }
    if (path.endsWith("/deliverable/versions")) return Response.json({ versions: [] });
    return Response.json({ assignments: [{ assignment: { assignmentId: "a1", jobId: "job-a1", status: "in_progress", escrowAmount: "1", escrowToken: "X402", slaDeadlineAt: null }, job: { title: "Acknowledge", description: "Brief" } }] });
  }) as unknown as typeof fetch;
  const ctx = marketWith({ fetch: send });
  const fresh = ctx.m.agencies.create({ name: "Fresh", owner: "fresh.near", signer: "wallet" });
  expect(fresh.stage).toBe("needs_setup");
  const m = new Market({ ...ctx.m.d, worker: worker(fresh.id) });
  m.requireWorkerAgency();
  await m.tick();
  expect((await m.worker.view()).assignments.map((a) => a.assignment_id)).toEqual(["a1"]);
  expect(await m.worker.submit("a1", "Received.")).toMatchObject({ submit_state: "submitted", status: "accepted" });
  expect(posts).toEqual(["/v1/assignments/a1/submit"]);
  expect(ctx.stub.calls).toEqual([]); // no platform call: no agent, grant or deposit is needed to deliver
});


test("worker polls independently while buyer follow-up remains unresolved across timer ticks", async () => {
  let reads = 0;
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => { release = resolve; });
  const ctx = marketWith({ fetch: (async () => {
    reads++;
    return Response.json({ assignments: [] });
  }) as unknown as typeof fetch });
  const m = new Market({ ...ctx.m.d, worker: worker(ctx.agency.id) });
  m.hires.followAll = () => stalled;
  const pending = m.tick();
  try {
    await Bun.sleep(10);
    expect(reads).toBe(1);
    const next = m.tick();
    await Bun.sleep(10);
    expect(reads).toBe(2);
    release();
    await Promise.all([pending, next]);
  } finally {
    release();
    await pending;
    ctx.db.close();
  }
});

test("worker poll still starts when hire follow-up rejects", async () => {
  let reads = 0;
  const ctx = marketWith({ fetch: (async () => {
    reads++;
    return Response.json({ assignments: [] });
  }) as unknown as typeof fetch });
  const m = new Market({ ...ctx.m.d, worker: worker(ctx.agency.id) });
  m.hires.followAll = async () => { throw new Error("fixture failure"); };
  try {
    await expect(m.tick()).rejects.toThrow("fixture failure");
    await Bun.sleep(10);
    expect(reads).toBe(1);
  } finally {
    ctx.db.close();
  }
});
