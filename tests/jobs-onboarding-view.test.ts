import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JobsOnboarding } from "../src/web/pages/JobsOnboarding";

// Optional guide rendering only. No account, application, wallet, message or payment action is invoked.
const render = () => renderToStaticMarkup(createElement(JobsOnboarding));

test("onboarding links to real existing actions without collecting data or forcing sign-in", () => {
  const html = render();
  expect(html).toContain("Get started with Paperwork");
  expect(html).toContain('href="#/openings"');
  expect(html).toContain('href="https://multiagency.ai/apply"');
  expect(html).toContain('href="#/my-jobs"');
  expect(html).toContain('href="#/new"');
  expect(html).toContain("Assigned to me");
  expect(html).toContain('href="https://market.near.ai/jobs"');
  expect(html.match(/<li>/g)).toHaveLength(3);
  expect(html).not.toContain("<form");
  expect(html).not.toContain("<input");
  expect(html).not.toContain("<textarea");
  expect(html).not.toContain("<button");
});

test("internal guide actions stay on the current origin without carrying invitation parameters", () => {
  const html = render();
  const links = [...html.matchAll(/<a\b([^>]*)>/g)].map((match) => match[1]!);
  const internal = links.filter((attributes) => attributes.includes('href="#/'));
  expect(internal).toHaveLength(3);
  for (const attributes of internal) {
    expect(attributes).not.toContain("target=");
    expect(attributes).not.toContain("?t=");
  }
  const external = links.filter((attributes) => attributes.includes('href="https://'));
  expect(external).toHaveLength(2);
  for (const attributes of external) expect(attributes).toContain('rel="noopener noreferrer"');
});

test("the guide starts with published openings and separates applications from accepted terms and confirmed payment", () => {
  const html = render();
  expect(html).toContain("published MultiAgency openings");
  expect(html).not.toContain("active projects");
  expect(html).toContain("An application does not promise hiring or payment");
  expect(html).toContain("Signing is free and off-chain");
  expect(html).toContain("find the offer under Assigned to me");
  expect(html).toContain("The agency explicitly approves the payout or requests changes");
  expect(html).toContain("confirmed settlement");
  expect(html).toContain("Paperwork sign-in does not sign you in to Market");
});
