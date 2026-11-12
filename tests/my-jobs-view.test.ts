import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MyJob } from "../src/shared/my-jobs";
import { MyJobsContent } from "../src/web/pages/MyJobs";

// Authorized-summary presentation only; account/HTTP authorization is checked separately by the server tests.
const job: MyJob = {
  id: "c_original", title: "CSV export", company: "Acme", builder_name: "Maria", scope_usd: "300",
  start: "2026-11-01", end: "2026-11-30", stage: "active", roles: ["builder"], builder_accepted: true, workflow: "report_invoice",
  attention: { state: "waiting", summary: "Agency review pending", detail: "The report is submitted. Agency approval and confirmed payment are still pending.", actions: [] },
};
const render = (jobs: MyJob[], demo = false, error: string | null = null) => renderToStaticMarkup(createElement(MyJobsContent, { jobs, demo, error, reload: async () => {} }));

test("accepted builder summaries open the existing authenticated view without creating or exposing an invitation", () => {
  const html = render([job]);
  expect(html).toContain("<h1>Assigned to me</h1>");
  expect(html).toContain("Jobs where this account is the named builder or agency representative.");
  expect(html).toContain('href="#/c/c_original/sign"');
  expect(html).toContain("Open builder view");
  expect(html).toContain("Scope $300.00");
  expect(html).toContain("Setup: Active");
  expect(html).toContain("Deadline Nov 30, 2026");
  expect(html).not.toContain("?t=");
  expect(html).not.toContain("Open agency view");
  expect(html).not.toContain("Paid");
  expect(html).not.toContain("Confirmed settlement");
  expect(html).not.toContain("Signed scope");
});

test("an unsigned builder can view terms but must return to the agency's original invitation before acceptance", () => {
  const html = render([{ ...job, builder_accepted: false, stage: "needs_signatures",
    attention: { state: "needs_action", summary: "Review the offered terms", detail: "Acceptance requires the original invitation.", actions: [{ role: "builder", label: "Review offered terms" }] },
  }]);
  expect(html).toContain("original private invitation link");
  expect(html).toContain("That link is still required before you can sign");
  expect(html).toContain('class="btn btn-secondary btn-sm" href="#/c/c_original/sign">View offered terms</a>');
  expect(html).toContain("Setup: Awaiting signatures");
  expect(html).not.toContain("?t=");
  expect(html).not.toContain("Signed scope");
});

test("agency and builder roles keep distinct links to the same retained job", () => {
  const html = render([{ ...job, roles: ["agency", "builder"] }]);
  expect(html).toContain('href="#/c/c_original"');
  expect(html).toContain('href="#/c/c_original/sign"');
  expect(html).toContain("Open agency view");
  expect(html).toContain("Open builder view");
  const agencyOnly = render([{ ...job, roles: ["agency"] }]);
  expect(agencyOnly).toContain("CSV export");
  expect(agencyOnly).toContain("Open agency view");
  expect(agencyOnly).not.toContain("Open builder view");
});

test("the keyless demo still directs an accepted builder to the original invitation for submission", () => {
  const html = render([job], true);
  expect(html).toContain("showing simulated account-scoped jobs");
  expect(html).toContain("original private invitation link, including after acceptance");
  expect(html).not.toContain("?t=");
});

test("attention groups and actions come from the private summary rather than setup status or role guesses", () => {
  const html = render([
    { ...job, id: "c_review", title: "Review this report", stage: "ended", roles: ["agency", "builder"], attention: { state: "needs_action", summary: "Review the builder's report", detail: "Payment is still awaiting agency approval.", actions: [{ role: "agency", label: "Review report" }] } },
    { ...job, id: "c_waiting", title: "Keep observing this job" },
    { ...job, id: "c_complete", title: "Completed signed job", stage: "active", attention: { state: "completed", summary: "Settlement confirmed", detail: "The agreed amount has confirmed payment evidence.", actions: [] } },
  ]);
  const section = (state: string) => html.match(new RegExp(`<section[^>]*aria-labelledby="my-jobs-${state}"[^>]*>([\\s\\S]*?)</section>`))?.[1] ?? "";
  expect(section("needs_action")).toContain("Needs your action");
  expect(section("needs_action")).toContain("Review this report");
  expect(section("needs_action")).toContain('href="#/c/c_review">Review report</a>');
  expect(section("needs_action")).toContain('href="#/c/c_review/sign">Open builder view</a>');
  expect(section("needs_action")).not.toContain("Completed signed job");
  expect(section("waiting")).toContain("Keep observing this job");
  expect(section("waiting")).toContain("Agency review pending");
  expect(section("waiting")).not.toContain("Completed signed job");
  expect(section("completed")).toContain("Completed signed job");
  expect(section("completed")).toContain("Setup: Active");
  expect(section("completed")).not.toContain("Review this report");
});

test("older or malformed attention summaries safely wait with links to the original job", () => {
  const { attention: _attention, ...legacy } = job;
  const oldShape = { ...legacy, stage: "ended", roles: ["agency", "builder"] };
  const invalid = [
    oldShape,
    { ...oldShape, attention: null },
    { ...oldShape, attention: { ...job.attention, state: "funded", summary: "Future action" } },
    { ...oldShape, attention: { state: "completed", summary: "Future action", detail: "Unproven", actions: [{ role: "agency", label: 42 }] } },
  ];
  for (const value of invalid) {
    const html = render([value as unknown as MyJob]);
    expect(html).toContain('id="my-jobs-waiting">Waiting</h2>');
    expect(html).toContain("Open job to check status");
    expect(html).toContain("No next-action information is recorded in this view. Open the existing job to inspect its status.");
    expect(html).toContain('href="#/c/c_original">Open agency view</a>');
    expect(html).toContain('href="#/c/c_original/sign">Open builder view</a>');
    expect(html).not.toContain("my-jobs-completed");
    expect(html).not.toContain("my-jobs-needs_action");
    expect(html).not.toContain("Future action");
    expect(html).not.toContain("?t=");
  }
});

test("empty and failed reads remain different, and a transient error keeps the previous summaries", () => {
  const empty = render([]);
  expect(empty).toContain("No jobs for this account yet");
  expect(empty).toContain('href="#/start"');
  const stale = render([job], false, "Status temporarily unavailable");
  expect(stale).toContain("Showing the last loaded jobs");
  expect(stale).toContain("recorded actions; they may be out of date");
  expect(stale).toContain("CSV export");
  expect(stale).not.toContain("No jobs for this account yet");
  expect(render([], false, "Status unavailable")).not.toContain("No jobs for this account yet");
});

test("summary text is escaped and job identity cannot turn its view link into an external URL", () => {
  const html = render([{ ...job, id: "https://evil.invalid/job?token=secret", title: "<script>pay()</script>", company: "<img src=x>", builder_name: "<svg>",
    attention: { state: "needs_action", summary: "<script>approve()</script>", detail: "<img src=x onerror=pay()>", actions: [{ role: "builder", label: "<svg onload=pay()>" }] },
  }]);
  expect(html).toContain("&lt;script&gt;pay()");
  expect(html).toContain("&lt;script&gt;approve()");
  expect(html).toContain("&lt;img");
  expect(html).toContain("&lt;svg onload=pay()&gt;");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).not.toContain('href="https://evil.invalid');
  expect(html).toContain('href="#/c/https%3A%2F%2Fevil.invalid%2Fjob%3Ftoken%3Dsecret/sign"');
});
