import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicOpenings } from "../src/shared/job-openings";
import { JobsPage } from "../src/web/pages/Jobs";
import { publishedOpeningUrl, PublishedOpeningsContent } from "../src/web/pages/PublishedOpenings";
import type { AppConfig } from "../src/web/types";

const data: PublicOpenings = { agency: "MultiAgency", sponsor_slug: "multiagency", source_url: "https://nearn.io/multiagency", checked_at: "2026-11-11T12:00:00Z", openings: [{
  id: "nearn:multiagency:csv-export", source: "nearn", slug: "csv-export", title: "CSV export opening", kind: "project",
  budget_amount: "300", budget_token: "USDC", deadline: null, url: "https://nearn.io/listing/csv-export",
}] };
const render = (value: PublicOpenings | null, error: string | null = null) => renderToStaticMarkup(createElement(PublishedOpeningsContent, { data: value, error, loading: false, refresh: async () => {} }));

test("only a successful read can claim there are no published openings", () => {
  expect(render(null, "Source unavailable")).not.toContain("No published openings right now");
  const stale = render(data, "Source unavailable");
  expect(stale).toContain("Showing the last loaded openings");
  expect(stale).toContain("CSV export opening");
  expect(stale).not.toContain("No published openings right now");
  expect(render({ ...data, openings: [] })).toContain("No published openings right now");
});

test("publication content is escaped and opening links never accept an arbitrary origin or scheme", () => {
  const html = render({ ...data, openings: [{ ...data.openings[0]!, title: "<script>pay()</script>", url: "javascript:pay()" }] });
  expect(html).toContain("&lt;script&gt;pay()");
  expect(html).not.toContain("<script");
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain('href="https://nearn.io/multiagency/"');
  expect(publishedOpeningUrl(data.openings[0]!.url)).toBe(data.openings[0]!.url);
  for (const value of ["https://evil.invalid/listing/work", "https://user:pass@nearn.io/listing/work", "https://nearn.io/listing/work?token=secret", "https://nearn.io/listing/work#private", "https://nearn.io/listing/../api/jobs"])
    expect(publishedOpeningUrl(value)).toBe("https://nearn.io/multiagency/");
});

test("the public openings pane keeps discovery separate from the private workspace and Market source", () => {
  const config: AppConfig = { platform: "remote", stack: false,
    host: "platform.invalid", demo_controls: false, demo_accounts: null, now: data.checked_at, judge: { kind: "rules", model: null },
    auth: { required: true, recipient: "multiagentic.near", network: "mainnet" }, market: { enabled: false, worker: false, owner: null, dao: null } };
  const html = renderToStaticMarkup(createElement(JobsPage, { config }));
  expect(html).toContain("<h1>Openings</h1>");
  expect(html).toContain('href="#/openings" aria-current="page"');
  expect(html).toContain("Published openings");
  expect(html).toContain('href="#/market-jobs"');
  expect(html).not.toContain('href="#/assignments"');
  expect(html).not.toContain('aria-label="Agency tools"');
  expect(html).toContain('href="#/start"');
  expect(html).not.toContain("Search open jobs");
  expect(html).not.toContain("Sign in with NEAR");
  expect(html).not.toContain("No published openings right now");
});

test("listing cards preserve compensation meaning and do not invent an application deadline", () => {
  const fixed = data.openings[0]!;
  const value: PublicOpenings = { ...data, openings: [
    { ...fixed, id: "fixed", compensation_type: "fixed", deadline: "2026-12-01T00:00:00Z" },
    { ...fixed, id: "range", compensation_type: "range", minimum_reward: "100", maximum_reward: "300" },
    { ...fixed, id: "variable", kind: "sponsorship", compensation_type: "variable", budget_amount: "500" },
    { ...fixed, id: "unknown", budget_amount: "999" },
  ] };
  const html = render(value);
  expect(html).toContain("Advertised amount: 300 USDC");
  expect(html).toContain("100–300 USDC");
  expect(html).toContain("Variable · up to 500 USDC");
  expect(html).toContain("See compensation terms in listing");
  expect(html).not.toContain("999 USDC");
  expect(html).toContain("Listing deadline");
  expect(html).not.toContain("Apply by");
  expect(html).toContain("Review listing");
});
