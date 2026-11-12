import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BoardJob } from "../src/shared/market-board";
import { INITIAL_BOARD_QUERY, type BoardSnapshot } from "../src/web/market-board-resource";
import { marketJobUrl, OpenJobCard, OpenJobs, OpenJobsContent } from "../src/web/pages/OpenJobs";

// Presentation only: no sign-in, browser, network read, bid, hire or payment is performed.
const job: BoardJob = {
  job_id: "37fcb804-6311-4195-9359-deed2eaa570d", title: "CSV export", description: "Public job description",
  budget_amount: "300", budget_token: "USDC", kind: "standard", status: "open", tags: ["TypeScript"],
  posted_at: "2026-11-11T12:00:00.000Z", creator_name: "Agency", slots_available: 2, max_slots: 3,
  acceptance_window_days: 3, minimum_verification: "none", entries_close_at: null,
};
const initial = (): BoardSnapshot => ({ query: { ...INITIAL_BOARD_QUERY }, loaded_query: null, jobs: [], next_offset: null, checked_at: null, loaded: false, loading: false, error: null });
function render(state: Partial<BoardSnapshot>) {
  return renderToStaticMarkup(createElement(OpenJobsContent, { snapshot: { ...initial(), ...state }, search: async () => {}, refresh: async () => {}, more: async () => {} }));
}

test("the public Market source can render outside any account session and does not display a false empty result", () => {
  const html = renderToStaticMarkup(createElement(OpenJobs));
  expect(html).toContain("Search open jobs");
  expect(html).toContain("Job type");
  expect(html).toContain("Sort jobs");
  expect(html).not.toContain("Sign in");
  expect(html).not.toContain("No open jobs");
});

test("failed or incomplete reads do not claim that there are no open jobs", () => {
  const firstFailure = render({ error: "Connection unavailable" });
  expect(firstFailure).toContain("Open jobs could not be loaded");
  expect(firstFailure).not.toContain("No open jobs");
  const stale = render({ loaded: true, loaded_query: { ...INITIAL_BOARD_QUERY }, jobs: [job], next_offset: 50, error: "Market unavailable" });
  expect(stale).toContain("Showing the last loaded results");
  expect(stale).toContain("CSV export");
  expect(stale).toContain("1 job loaded");
  expect(stale).toContain("Load more");
  expect(stale).not.toContain("No open jobs");
  const unread = render({ loaded: true, loaded_query: { ...INITIAL_BOARD_QUERY }, next_offset: 50 });
  expect(unread).toContain("Load more");
  expect(unread).not.toContain("No open jobs");
});

test("only a successful complete empty search shows an empty state", () => {
  expect(render({ loaded: true, loaded_query: { ...INITIAL_BOARD_QUERY } })).toContain("No open jobs match these filters");
  expect(render({ loaded: true, loading: true })).not.toContain("No open jobs");
});

test("public job content stays escaped and arbitrary text never becomes a link", () => {
  const html = renderToStaticMarkup(createElement(OpenJobCard, { job: { ...job,
    title: '<img src=x onerror="pay()">', description: "<script>bid()</script> https://evil.invalid/collect",
    creator_name: "<svg onload=steal()>", tags: ["<iframe>"] } }));
  expect(html).toContain("&lt;img");
  expect(html).toContain("&lt;script&gt;bid()");
  expect(html).toContain("&lt;svg");
  expect(html).toContain("&lt;iframe&gt;");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script");
  expect(html).not.toContain('href="https://evil.invalid');
  expect(html).toContain(`href="https://market.near.ai/jobs/${job.job_id}"`);
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('title="Copy"');
  expect(html).not.toContain("Approve and hire");
  expect(html).not.toContain("<form");
});

test("job links use only a fixed Market origin and a UUID, with a safe generic fallback", () => {
  expect(marketJobUrl(job.job_id)).toBe(`https://market.near.ai/jobs/${job.job_id}`);
  for (const id of ["javascript:alert(1)", "https://evil.invalid/job", "../private", `${job.job_id}?token=secret`, `${job.job_id}/more`])
    expect(marketJobUrl(id)).toBe("https://market.near.ai/jobs");
});
