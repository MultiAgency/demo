import { expect, test } from "bun:test";
import type { BoardJob, OpenJobsPage } from "../src/shared/market-board";
import { INITIAL_BOARD_QUERY, MarketBoardResource, type BoardQuery } from "../src/web/market-board-resource";

// Public-feed state only. Reads are controlled promises; no browser, auth, upstream API or payment is used.
const checked = "2026-11-11T12:00:00.000Z";
const job = (n: number): BoardJob => ({
  job_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, title: `Job ${n}`, description: "Public description",
  budget_amount: "100", budget_token: "USDC", kind: "standard", status: "open", tags: [], posted_at: checked,
  creator_name: null, slots_available: 1, max_slots: 1, acceptance_window_days: 3, minimum_verification: "none", entries_close_at: null,
});
const page = (jobs: BoardJob[], offset = 0, next_offset: number | null = null): OpenJobsPage => ({ jobs, offset, next_offset, checked_at: checked });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("pagination reaches beyond 100 public jobs and deduplicates overlapping pages by stable job ID", async () => {
  const reads: { query: BoardQuery; offset: number }[] = [];
  const resource = new MarketBoardResource(async (query, offset) => {
    reads.push({ query, offset });
    if (offset === 0) return page(Array.from({ length: 50 }, (_, i) => job(i + 1)), 0, 50);
    if (offset === 50) return page([{ ...job(50), title: "Updated job 50" }, ...Array.from({ length: 49 }, (_, i) => job(i + 51))], 50, 100);
    return page(Array.from({ length: 24 }, (_, i) => job(i + 100)), 100);
  });
  await resource.search({ q: " CSV ", kind: "standard", sort: "budget" });
  await resource.more();
  await resource.more();
  await resource.more();
  const state = resource.getSnapshot();
  expect(state.jobs).toHaveLength(123);
  expect(state.jobs.find((item) => item.job_id === job(50).job_id)?.title).toBe("Updated job 50");
  expect(state.jobs.at(-1)?.job_id).toBe(job(123).job_id);
  expect(state.next_offset).toBeNull();
  expect(reads).toEqual([0, 50, 100].map((offset) => ({ query: { q: "CSV", kind: "standard", sort: "budget" }, offset })));
});

test("a failed later page preserves loaded jobs, the previous checked time and the original next offset for retry", async () => {
  let failed = false;
  const offsets: number[] = [];
  const resource = new MarketBoardResource(async (_query, offset) => {
    offsets.push(offset);
    if (!offset) return page([job(1)], 0, 50);
    if (!failed) { failed = true; throw new Error("Market temporarily unavailable"); }
    return page([job(2)], 50);
  });
  await resource.search();
  await resource.more();
  expect(resource.getSnapshot()).toMatchObject({ jobs: [job(1)], checked_at: checked, next_offset: 50, loaded: true, loading: false, error: "Market temporarily unavailable" });
  await resource.more();
  expect(resource.getSnapshot().jobs).toEqual([job(1), job(2)]);
  expect(resource.getSnapshot().error).toBeNull();
  expect(offsets).toEqual([0, 50, 50]);
});

test("a failed first read is unknown availability, not a successfully loaded empty board", async () => {
  const resource = new MarketBoardResource(async () => { throw new Error("Server market connection is missing"); });
  await resource.search();
  expect(resource.getSnapshot()).toMatchObject({ jobs: [], loaded: false, loading: false, checked_at: null, error: "Server market connection is missing" });
});

test("a newer search wins over both a delayed old result and a delayed old error", async () => {
  for (const fail of [false, true]) {
    const old = deferred<OpenJobsPage>();
    const resource = new MarketBoardResource(async (query) => query.q === "old" ? old.promise : page([job(2)]));
    const pending = resource.search({ ...INITIAL_BOARD_QUERY, q: "old" });
    await resource.search({ ...INITIAL_BOARD_QUERY, q: "new" });
    if (fail) old.reject(new Error("Private stale diagnostic must not overwrite the new result"));
    else old.resolve(page([job(1)]));
    await pending;
    expect(resource.getSnapshot()).toMatchObject({ query: { ...INITIAL_BOARD_QUERY, q: "new" }, jobs: [job(2)], error: null, loading: false });
  }
});

test("concurrent load-more clicks share the active read and an old page cannot append to a new search", async () => {
  const old = deferred<OpenJobsPage>();
  let reads = 0;
  const resource = new MarketBoardResource(async (query, offset) => {
    reads++;
    if (query.q === "new") return page([job(3)]);
    return offset ? old.promise : page([job(1)], 0, 50);
  });
  await resource.search();
  const pending = resource.more();
  await resource.more();
  expect(reads).toBe(2);
  await resource.search({ ...INITIAL_BOARD_QUERY, q: "new" });
  old.resolve(page([job(2)], 50));
  await pending;
  expect(resource.getSnapshot().jobs).toEqual([job(3)]);
  expect(resource.getSnapshot().next_offset).toBeNull();
});

test("refresh replaces the loaded pages only on success and preserves them when the refresh fails", async () => {
  let refreshFails = false;
  let refreshed = false;
  const resource = new MarketBoardResource(async (_query, offset) => {
    if (refreshFails) throw new Error("Refresh unavailable");
    if (refreshed) return page([job(9)]);
    return offset ? page([job(2)], offset) : page([job(1)], 0, 50);
  });
  await resource.search(); await resource.more();
  refreshFails = true;
  await resource.search();
  expect(resource.getSnapshot().jobs).toEqual([job(1), job(2)]);
  refreshFails = false; refreshed = true;
  await resource.search();
  expect(resource.getSnapshot().jobs).toEqual([job(9)]);
});

test("malformed non-advancing pagination keeps the previous page instead of looping or claiming no results", async () => {
  const resource = new MarketBoardResource(async (_query, offset) => offset ? page([job(2)], 50, 50) : page([job(1)], 0, 50));
  await resource.search(); await resource.more();
  expect(resource.getSnapshot()).toMatchObject({ jobs: [job(1)], next_offset: 50, loaded: true, loading: false });
  expect(resource.getSnapshot().error).toContain("invalid pagination");
});

test("unmount invalidation ignores a late read", async () => {
  const late = deferred<OpenJobsPage>();
  const resource = new MarketBoardResource(() => late.promise);
  const pending = resource.search();
  resource.invalidate();
  late.resolve(page([job(1)]));
  await pending;
  expect(resource.getSnapshot().loaded).toBe(false);
  expect(resource.getSnapshot().jobs).toEqual([]);
});
