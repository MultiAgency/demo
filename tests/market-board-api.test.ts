import { expect, test } from "bun:test";
import { MarketApi, MarketHttpError } from "../src/server/market/api";
import type { BoardQuery } from "../src/shared/market-board";

// Public-source fixtures only. No Market account, credential or hosted request is used.
const token = "aat_offline_board_fixture";
const date = "2026-11-11T12:00:00.123Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const job = (n = 1, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  jobId: uuid(n), creatorAccountId: uuid(900), title: `Public job ${n}`, description: "Build the agreed CSV export.",
  budgetAmount: "125.250000", budgetToken: "USDC", jobKind: "standard", status: "open", tags: ["csv", "reporting"],
  currentMaxSlots: 1, maxSlots: 2, acceptanceWindowDays: 3, minBuilderVerification: "none",
  isPrivate: false, isTestRun: false, createdAt: date, updatedAt: date, requiresVerifiable: false,
  entriesCloseAt: null, creator: { accountId: uuid(900), displayName: "Public Agency", avatarUrl: "https://untrusted.invalid/avatar" },
  ...extra,
});
const client = (body: unknown, status = 200) => new MarketApi("https://market.invalid", token, (async () => Response.json(body, { status })) as unknown as typeof fetch);

test("board requests use the server bearer, encoded filters and only the public board path", async () => {
  let sent: { url: URL; init?: RequestInit } | null = null;
  const api = new MarketApi("https://market.invalid/", token, (async (input: string | URL | Request, init?: RequestInit) => {
    sent = { url: new URL(String(input)), init };
    return Response.json({ jobs: [job()] });
  }) as unknown as typeof fetch);
  const page = await api.openJobs({ q: "CSV & status=private/日本語", kind: "competition", sort: "budget", offset: 100 });
  expect(sent).not.toBeNull();
  const request = sent! as { url: URL; init: RequestInit };
  expect(request.url.pathname).toBe("/v1/jobs/board");
  expect(Object.fromEntries(request.url.searchParams)).toEqual({ sort: "budget", limit: "51", offset: "100", q: "CSV & status=private/日本語", kind: "competition" });
  expect(request.url.searchParams.has("status")).toBe(false);
  expect(request.init.method).toBe("GET");
  expect(request.init.body).toBeUndefined();
  expect(new Headers(request.init.headers).get("authorization")).toBe(`Bearer ${token}`);
  expect(page).toMatchObject({ offset: 100, next_offset: null });
  expect(Number.isFinite(Date.parse(page.checked_at))).toBe(true);
});

test("a public board record exposes only whitelisted job fields", async () => {
  const page = await client({ jobs: [job(1, { secret: token, creator: { accountId: uuid(900), displayName: "Public Agency", avatarUrl: "https://untrusted.invalid/avatar", slug: "PRIVATE_LOGIN_HANDLE" } })] }).openJobs();
  expect(page.jobs).toEqual([{
    job_id: uuid(1), title: "Public job 1", description: "Build the agreed CSV export.",
    budget_amount: "125.250000", budget_token: "USDC", kind: "standard", status: "open", tags: ["csv", "reporting"],
    posted_at: date, creator_name: "Public Agency", slots_available: 1, max_slots: 2,
    acceptance_window_days: 3, minimum_verification: "none", entries_close_at: null,
  }]);
  const serialized = JSON.stringify(page);
  for (const hidden of [token, uuid(900), "avatar", "https://untrusted.invalid", "PRIVATE_LOGIN_HANDLE", "creatorAccountId"])
    expect(serialized).not.toContain(hidden);
});

test("pagination traverses more than 100 jobs using one raw-row lookahead without a fabricated total", async () => {
  const all = Array.from({ length: 123 }, (_, i) => job(i + 1));
  const offsets: number[] = [];
  const api = new MarketApi("https://market.invalid", token, (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const offset = Number(url.searchParams.get("offset")); offsets.push(offset);
    return Response.json({ jobs: all.slice(offset, offset + Number(url.searchParams.get("limit"))) });
  }) as unknown as typeof fetch);
  const first = await api.openJobs();
  const second = await api.openJobs({ offset: first.next_offset! });
  const third = await api.openJobs({ offset: second.next_offset! });
  const empty = await api.openJobs({ offset: 150 });
  expect(first.jobs).toHaveLength(50); expect(first.next_offset).toBe(50);
  expect(second.jobs).toHaveLength(50); expect(second.next_offset).toBe(100);
  expect(third.jobs).toHaveLength(23); expect(third.next_offset).toBeNull();
  expect(empty.jobs).toEqual([]); expect(empty.next_offset).toBeNull();
  expect(new Set([...first.jobs, ...second.jobs, ...third.jobs].map((row) => row.job_id)).size).toBe(123);
  expect(offsets).toEqual([0, 50, 100, 150]);
  expect(first).not.toHaveProperty("total");
});

test("exactly 50 raw rows ends the page; private, closed and test rows never escape or shift offsets", async () => {
  expect((await client({ jobs: Array.from({ length: 50 }, (_, i) => job(i + 1)) }).openJobs()).next_offset).toBeNull();
  const privateTitle = "PRIVATE_ONLY_DESCRIPTION";
  const raw = [job(1, { isPrivate: true, title: privateTitle }), job(2, { status: "closed", title: privateTitle }), job(3, { isTestRun: true, title: privateTitle }),
    ...Array.from({ length: 48 }, (_, i) => job(i + 4, { status: i % 2 ? "open" : "filling" }))];
  const page = await client({ jobs: raw }).openJobs({ offset: 50 });
  expect(page.jobs).toHaveLength(47);
  expect(page.next_offset).toBe(100);
  expect(page.jobs.every((row) => row.status === "open" || row.status === "filling")).toBe(true);
  expect(page.jobs.at(-1)?.job_id).toBe(uuid(50));
  expect(JSON.stringify(page)).not.toContain(privateTitle);
  expect((await client({ jobs: [
    { isPrivate: true, description: privateTitle }, { status: "closed", description: privateTitle }, { isTestRun: true, description: privateTitle },
  ] }).openJobs()).jobs).toEqual([]);
});

test("nullable optional public fields remain null rather than inventing metadata", async () => {
  const record = job(1, { budgetAmount: null, creator: null, jobKind: "competition", minBuilderVerification: "identity_verified", entriesCloseAt: date });
  const nullable = await client({ jobs: [record] }).openJobs();
  expect(nullable.jobs[0]).toMatchObject({ budget_amount: null, creator_name: null, kind: "competition", minimum_verification: "identity_verified", entries_close_at: date });
  delete record.budgetAmount; delete record.creator; delete record.entriesCloseAt;
  expect((await client({ jobs: [record] }).openJobs()).jobs[0]).toMatchObject({ budget_amount: null, creator_name: null, entries_close_at: null });
});

for (const body of [null, {}, [], { jobs: null }, { jobs: "jobs" }, { jobs: [null] }, { jobs: Array.from({ length: 52 }, () => job()) }]) {
  test(`a malformed board envelope/row is an error, not an empty feed: ${JSON.stringify(body).slice(0, 50)}`, async () => {
    await expect(client(body).openJobs()).rejects.toBeInstanceOf(MarketHttpError);
  });
}

for (const patch of [
  { isPrivate: undefined }, { isTestRun: undefined }, { isPrivate: "false" }, { isTestRun: 0 }, { status: null },
  { jobId: "https://untrusted.invalid/job" }, { title: null }, { description: {} }, { budgetAmount: "NaN" }, { budgetAmount: -1 },
  { budgetToken: null }, { jobKind: "unknown" }, { tags: [1] }, { createdAt: "yesterday" }, { creator: { displayName: {} } },
  { currentMaxSlots: -1 }, { currentMaxSlots: 3 }, { maxSlots: 0 }, { acceptanceWindowDays: 1.5 },
  { minBuilderVerification: "admin" }, { entriesCloseAt: "never" },
]) {
  test(`an invalid public board field fails the read: ${JSON.stringify(patch)}`, async () => {
    await expect(client({ jobs: [job(1, patch)] }).openJobs()).rejects.toBeInstanceOf(MarketHttpError);
  });
}

test("missing or refused credentials and transport errors never disclose bearer or upstream bodies", async () => {
  let sent = 0;
  const missing = new MarketApi("https://market.invalid", null, (async () => { sent++; return Response.json({ jobs: [] }); }) as unknown as typeof fetch);
  await expect(missing.openJobs()).rejects.toMatchObject({ status: 0 });
  expect(sent).toBe(0);
  for (const status of [401, 403, 429, 500]) {
    try { await client({ error: token, jobs: [job(1, { title: "PRIVATE_UPSTREAM_BODY" })] }, status).openJobs(); throw new Error("Expected refusal"); }
    catch (error) {
      expect(error).toBeInstanceOf(MarketHttpError);
      expect(error).toMatchObject({ status });
      expect((error as Error).message).not.toContain(token);
      expect((error as Error).message).not.toContain("PRIVATE_UPSTREAM_BODY");
    }
  }
  const broken = new MarketApi("https://market.invalid", token, (async () => { throw new Error(token); }) as unknown as typeof fetch);
  await expect(broken.openJobs()).rejects.toMatchObject({ status: 0 });
  const invalidJson = new MarketApi("https://market.invalid", token, (async () => new Response(token)) as unknown as typeof fetch);
  await expect(invalidJson.openJobs()).rejects.toThrow("not JSON");
});

for (const query of [
  { offset: -1 }, { offset: 0.5 }, { offset: Number.NaN }, { offset: Number.POSITIVE_INFINITY }, { offset: Number.MAX_SAFE_INTEGER },
  { kind: "private" }, { sort: "unsafe" }, { q: 12 },
] as unknown as BoardQuery[]) {
  test(`invalid board queries are refused before transport: ${JSON.stringify(query)}`, async () => {
    let calls = 0;
    const api = new MarketApi("https://market.invalid", token, (async () => { calls++; return Response.json({ jobs: [] }); }) as unknown as typeof fetch);
    await expect(api.openJobs(query)).rejects.toMatchObject({ status: 400 });
    expect(calls).toBe(0);
  });
}
