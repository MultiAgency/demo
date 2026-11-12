import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssignmentView, WorkerView } from "../src/shared/market";
import { JobsPage } from "../src/web/pages/Jobs";
import { WorkerContent } from "../src/web/pages/Market";
import type { AppConfig } from "../src/web/types";

// Presentation fixtures only: no auth session, market call, browser, wallet or payment is exercised.
const config: AppConfig = {
  platform: "remote", stack: false, host: "platform.invalid", demo_controls: false, demo_accounts: null,
  now: "2026-11-20T12:00:00.000Z", judge: { kind: "rules", model: null },
  auth: { required: true, recipient: "agency.demo", network: "mainnet" },
  market: { enabled: false, worker: false, owner: null, dao: null },
};
const assignment = (extra: Partial<AssignmentView> = {}): AssignmentView => ({
  assignment_id: "original-assignment", job_id: "original-market-job", title: "CSV export",
  description: "The original buyer brief", status: "in_progress", escrow_amount: null, escrow_token: null,
  sla_deadline_at: null, deliverable: "The original saved deliverable", submit_state: "none", submit_error: null,
  deposit_address: null, accepted_at: null, ...extra,
});
const renderAssignments = (a: AssignmentView) => {
  const w: WorkerView = { configured: true, agency_id: "original-agency", webhook_path: "/api/market/webhook", assignments: [a], deposit: null, last_poll: null };
  return renderToStaticMarkup(createElement(WorkerContent, { w, load: async () => {} }));
};

test("agent assignments stay within Paperwork and link to the native market without creating a hire", () => {
  const html = renderToStaticMarkup(createElement(JobsPage, { config, view: "assignments" }));
  expect(html).toContain("Agent assignments");
  expect(html).toContain("your agency&#x27;s listed agent");
  expect(html).toContain('aria-label="Agency tools"');
  expect(html).toContain('href="#/agency">Back to Agency</a>');
  expect(html).not.toContain('aria-label="Work sources"');
  expect(html).not.toContain('href="#/openings"');
  expect(html).not.toContain('href="#/market-jobs"');
  expect(html).not.toContain('href="#/start"');
  expect(html).not.toContain("paperwork.example");
  expect(html).toContain('href="https://market.near.ai/jobs"');
  expect(html).toContain('rel="noreferrer"');
  expect(html).toContain("The market connection is unavailable");
  expect(html).not.toContain("Create agency");
  expect(html).not.toContain("Approve and hire");
  expect(html).not.toContain("<form");
});

test("public source navigation excludes private agent assignment tools", () => {
  for (const view of ["openings", "market"] as const) {
    const html = renderToStaticMarkup(createElement(JobsPage, { config, view }));
    expect(html).toContain('aria-label="Work sources"');
    expect(html).toContain('href="#/openings"');
    expect(html).toContain('href="#/market-jobs"');
    expect(html).not.toContain('href="#/assignments"');
    expect(html).not.toContain('aria-label="Agency tools"');
    expect(html).not.toContain("Agency operators review buyer briefs");
  }
});

test("an unconfigured worker gives an explicit empty state instead of displaying another agency's history", () => {
  const html = renderToStaticMarkup(createElement(JobsPage, { config: { ...config, market: { ...config.market, enabled: true } }, view: "assignments" }));
  expect(html).toContain("No listed agent is connected");
  expect(html).toContain("Existing assignments stay with their original agency");
  expect(html).not.toContain("Submit the deliverable");
});

for (const submit_state of ["unknown", "submitting"] as const) {
  test(`${submit_state} delivery retains its saved report and identities while preventing another submission`, () => {
    const html = renderAssignments(assignment({ submit_state }));
    expect(html).toContain("original-assignment");
    expect(html).toContain("original-market-job");
    expect(html).toContain("The original saved deliverable");
    expect(html).toMatch(/<textarea\b[^>]*disabled=""/);
    expect(html).toMatch(/<button\b[^>]*disabled=""/);
    expect(html).toContain("Submit the deliverable");
    expect(html).not.toContain("Confirmed settlement");
  });
}

test("recorded delivery with in-progress status requires an explicit revision and keeps its record identities", () => {
  const html = renderAssignments(assignment({ submit_state: "submitted" }));
  expect(html).toContain("Delivery recorded");
  expect(html).toContain("Review the buyer&#x27;s requested changes");
  expect(html).toContain("Submit a revision");
  expect(html).not.toContain("Submit the deliverable");
  expect(html).not.toMatch(/<textarea\b[^>]*disabled=/);
  expect(html).toContain("original-assignment");
  expect(html).toContain("original-market-job");
});

test("accepted is a market observation with an earnings destination, not confirmed receipt of money", () => {
  const html = renderAssignments(assignment({ status: "accepted", submit_state: "submitted", accepted_at: config.now, deposit_address: "original-agency-deposit" }));
  expect(html).toContain("Accepted");
  expect(html).toContain("Check the market&#x27;s payout records and owner balance");
  expect(html).toContain("original-agency-deposit");
  expect(html).not.toContain("Submit the deliverable");
  expect(html).not.toContain("Confirmed settlement");
  expect(html).not.toContain("Payment complete");
});

test("a cleared unknown attempt offers an explicit exact-body retry with its retained identity", () => {
  const html = renderAssignments(assignment({ submit_state: "none", submit_phase: "not_arrived", submit_attempt_id: "original-attempt" }));
  expect(html).toContain("Retry saved deliverable");
  expect(html).toContain("original-attempt");
  expect(html).toContain("The original saved deliverable");
  expect(html).toMatch(/<textarea\b[^>]*disabled=""/);
  expect(html).toContain("Any unsent draft in this tab is kept separately");
});

test("buyer briefs and delivered text remain escaped data", () => {
  const html = renderAssignments(assignment({ status: "submitted", submit_state: "submitted", description: '<img src=x onerror="alert(1)">', deliverable: "<script>moveFunds()</script>" }));
  expect(html).toContain("&lt;img");
  expect(html).toContain("&lt;script&gt;moveFunds()");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script");
});
