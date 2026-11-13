import { expect, test } from "bun:test";
import { GitHubEvidence } from "../src/server/evidence/github";

/** Scripted GitHub responses only; no network. */
function github(total: number, options: { incomplete?: boolean } = {}) {
  const urls: string[] = [];
  const send = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const search = url.match(/search\/issues\?.*page=(\d+)/);
    if (search) {
      const page = Number(search[1]);
      const items = Array.from({ length: Math.max(0, Math.min(100, total - (page - 1) * 100)) }, (_, i) => ({ number: (page - 1) * 100 + i + 1 }));
      return Response.json({ total_count: total, incomplete_results: options.incomplete ?? false, items });
    }
    const number = Number(url.split("/").pop());
    return Response.json({ number, title: `PR ${number}`, body: null, html_url: `https://github.invalid/${number}`, user: { login: "Maria-Dev" }, merged_by: { login: "acme-lead" }, merged_at: "2026-11-10T00:00:00Z" });
  }) as typeof fetch;
  return { source: new GitHubEvidence(undefined, send), urls };
}
const query = { repos: ["acme/app"], author: "maria-dev", since: "2026-11-01T00:00:00Z", until: "2026-11-30T00:00:00Z" };

test("merged pull requests are read across every search page", async () => {
  const { source, urls } = github(234);
  const prs = await source.mergedPullRequests(query);
  expect(prs).toHaveLength(234);
  expect(new Set(prs.map((pr) => pr.number)).size).toBe(234);
  expect(urls.filter((url) => url.includes("search/issues"))).toHaveLength(3);
});

test("incomplete or over-limit searches refuse instead of judging a partial list", async () => {
  await expect(github(10, { incomplete: true }).source.mergedPullRequests(query)).rejects.toThrow("incomplete search results");
  await expect(github(1001).source.mergedPullRequests(query)).rejects.toThrow("More than 1000");
});
