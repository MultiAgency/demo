import { expect, test } from "bun:test";
import { MultiAgencyOpenings } from "../src/server/jobs/openings";

// Anonymous public-source fixtures. These checks do not contact MultiAgency or NEARN.
const checked = "2026-11-11T12:00:00.000Z";
const future = "2026-12-01T00:00:00.000Z";
const rawOpening = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: "build-something", title: "Build something", type: "project", status: "OPEN",
  isPublished: true, isPrivate: false, isWinnersAnnounced: false,
  rewardAmount: 125.5, token: "USDC", deadline: future,
  sponsor: { slug: "multiagency", name: "MultiAgency", logo: "https://never-fetch.invalid/avatar" },
  ...patch,
});

function client(bounties: unknown = [rawOpening()], settings: unknown = { nearnAccountId: "multiagency" }) {
  return new MultiAgencyOpenings((async (input: string | URL | Request) =>
    Response.json(String(input).includes("/api/settings") ? settings : { bounties })) as unknown as typeof fetch,
  () => new Date(checked));
}

test("reads the official sponsor from public settings and requests every listing type once without credentials", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const api = new MultiAgencyOpenings((async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init: init! });
    return Response.json(requests.length === 1 ? { nearnAccountId: "multiagency", orgAccountId: "NOT_A_CATALOG_SELECTOR" } : {
      bounties: [rawOpening({
        description: "UNPROJECTED_HTML", applicationLink: "https://untrusted.invalid", id: "IGNORED_UUID",
        privateKey: "NOT_PUBLIC", sponsorId: "NOT_PUBLIC", sequentialId: 2,
      })],
    });
  }) as unknown as typeof fetch, () => new Date(checked));
  const result = await api.list();
  expect(requests.map((r) => r.url)).toEqual(["https://multiagency.ai/api/settings", "https://nearn.io/api/listings/sponsor/"]);
  expect(requests[0]!.init.method).toBe("GET");
  expect(requests[0]!.init.body).toBeUndefined();
  expect(requests[1]!.init.method).toBe("POST");
  expect(JSON.parse(String(requests[1]!.init.body))).toEqual({
    sponsor: "multiagency", type: { in: ["bounty", "project", "hackathon", "sponsorship"] },
  });
  for (const { init } of requests) {
    expect(init.credentials).toBe("omit"); expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.has("authorization")).toBe(false); expect(headers.has("cookie")).toBe(false);
    expect(headers.get("accept")).toBe("application/json"); expect(init.signal).toBeInstanceOf(AbortSignal);
  }
  expect(result).toEqual({
    agency: "MultiAgency", sponsor_slug: "multiagency", source_url: "https://nearn.io/multiagency", checked_at: checked,
    openings: [{
      id: "nearn:multiagency:build-something", source: "nearn", title: "Build something", slug: "build-something",
      kind: "project", budget_amount: "125.5", budget_token: "USDC", deadline: future,
      url: "https://nearn.io/listing/build-something",
    }],
  });
  expect(JSON.stringify(result)).not.toMatch(/NOT_PUBLIC|UNPROJECTED_HTML|untrusted|IGNORED_UUID|NOT_A_CATALOG_SELECTOR/);
});

test("public compensation metadata preserves a range and variable cap without changing payment authority", async () => {
  const result = await client([
    rawOpening({ slug: "range-work", compensationType: "range", minRewardAsk: 100, maxRewardAsk: 300 }),
    rawOpening({ slug: "variable-work", type: "sponsorship", compensationType: "variable", rewardAmount: 500 }),
  ]).list();
  expect(result.openings[0]).toMatchObject({ compensation_type: "range", minimum_reward: "100", maximum_reward: "300" });
  expect(result.openings[1]).toMatchObject({ compensation_type: "variable", budget_amount: "500" });
  await expect(client([rawOpening({ compensationType: "range", minRewardAsk: 300, maxRewardAsk: 100 })]).list()).rejects.toThrow("Published MultiAgency openings could not be read");
});

test("an honest valid empty feed is distinguishable from read or schema failure", async () => {
  expect(await client([]).list()).toEqual({
    openings: [], agency: "MultiAgency", sponsor_slug: "multiagency", source_url: "https://nearn.io/multiagency", checked_at: checked,
  });
});

test("explicit private, unpublished, closed, inactive, archived, completed and expired records never escape", async () => {
  const privateFields = { title: "PRIVATE_BODY", slug: "../../secret", token: { secret: "PRIVATE_BODY" } };
  const records = [
    { ...privateFields, isPrivate: true }, { ...privateFields, isPublished: false },
    { ...privateFields, status: "CLOSED" }, { ...privateFields, status: "REVIEW" },
    { ...privateFields, isActive: false }, { ...privateFields, isArchived: true },
    { ...privateFields, isWinnersAnnounced: true },
    rawOpening({ slug: "expired", deadline: "2026-11-11T11:59:59.999Z" }),
    rawOpening({ slug: "deadline-equals-now", deadline: checked }),
    rawOpening(),
  ];
  const result = await client(records).list();
  expect(result.openings).toHaveLength(1);
  expect(result.openings[0]!.slug).toBe("build-something");
  expect(JSON.stringify(result)).not.toContain("PRIVATE_BODY");
});

test("null deadlines are evergreen; optional source-filtered flags and metadata need not be present", async () => {
  const row = rawOpening({ deadline: null, rewardAmount: null, token: null });
  delete row.sponsor; delete row.isWinnersAnnounced;
  const result = await client([row]).list();
  expect(result.openings[0]).toMatchObject({ deadline: null, budget_amount: null, budget_token: null });
  expect((await client([rawOpening({ isActive: true, isArchived: false })]).list()).openings).toHaveLength(1);
});

test("the full unpaginated sponsor feed is preserved beyond 100 openings, with stable identities", async () => {
  const records = Array.from({ length: 137 }, (_, i) => rawOpening({ slug: `opening-${i}`, type: ["bounty", "project", "hackathon", "sponsorship"][i % 4] }));
  let calls = 0;
  const api = new MultiAgencyOpenings((async () => {
    calls++;
    return Response.json(calls % 2 ? { nearnAccountId: "multiagency" } : { bounties: records });
  }) as unknown as typeof fetch, () => new Date(checked));
  const first = await api.list(); const second = await api.list();
  expect(first.openings).toHaveLength(137); expect(new Set(first.openings.map((r) => r.id)).size).toBe(137);
  expect(first.openings).toEqual(second.openings); expect(calls).toBe(4);
  expect(first).not.toHaveProperty("next_offset"); expect(first).not.toHaveProperty("total");
});

test("the public settings sponsor is validated and used, never the treasury identifier", async () => {
  const result = await client([rawOpening({ sponsor: { slug: "agency-two" } })], { nearnAccountId: "agency-two", orgAccountId: "another.sputnik-dao.near" }).list();
  expect(result.source_url).toBe("https://nearn.io/agency-two");
  expect(result.openings[0]!.id).toBe("nearn:agency-two:build-something");
});

for (const amount of [0, 1e-7, 1e21, 1.25e-9]) {
  test(`budget ${amount} is a decimal display string without exponent notation`, async () => {
    const result = await client([rawOpening({ rewardAmount: amount })]).list();
    expect(result.openings[0]!.budget_amount).toMatch(/^\d+(?:\.\d+)?$/);
    expect(Number(result.openings[0]!.budget_amount)).toBe(amount);
  });
}

for (const settings of [null, {}, { nearnAccountId: null }, { nearnAccountId: "" }, { nearnAccountId: "../private" },
  { nearnAccountId: "https://evil.invalid" }, { nearnAccountId: "agency?x=1" }, { nearnAccountId: "agency#fragment" }]) {
  test(`invalid public sponsor settings fail without a NEARN request: ${JSON.stringify(settings)}`, async () => {
    let calls = 0;
    const api = new MultiAgencyOpenings((async () => { calls++; return Response.json(settings); }) as unknown as typeof fetch);
    await expect(api.list()).rejects.toThrow("Published MultiAgency openings could not be read."); expect(calls).toBe(1);
  });
}

for (const patch of [
  { isPublished: undefined }, { isPublished: "true" }, { isPrivate: undefined }, { isPrivate: 0 },
  { status: null }, { isActive: "true" }, { isArchived: "false" }, { isWinnersAnnounced: null },
  { title: "  " }, { title: null }, { type: "other" }, { slug: "../secret" }, { slug: "https://evil.invalid" },
  { slug: "x?y" }, { slug: "x#y" }, { slug: "x%2fy" }, { slug: "x\\y" },
  { rewardAmount: "125" }, { rewardAmount: -1 }, { token: {} }, { token: "" },
  { deadline: "yesterday" }, { deadline: "2026-13-99T00:00:00Z" }, { deadline: undefined },
  { sponsor: { slug: "different-sponsor" } },
]) {
  test(`malformed eligible public fields reject the feed: ${JSON.stringify(patch)}`, async () => {
    await expect(client([rawOpening(patch)]).list()).rejects.toThrow("Published MultiAgency openings could not be read.");
  });
}

test("duplicate source slugs fail rather than producing unstable or conflicting identities", async () => {
  await expect(client([rawOpening(), rawOpening({ title: "Different title" })]).list()).rejects.toThrow();
});

for (const envelope of [null, [], {}, { bounties: null }, { bounties: "rows" }, { bounties: [null] }, { bounties: [3] }]) {
  test(`malformed envelopes are errors, never fabricated empty feeds: ${JSON.stringify(envelope)}`, async () => {
    const api = new MultiAgencyOpenings((async (url: string | URL | Request) => Response.json(String(url).includes("/api/settings") ? { nearnAccountId: "multiagency" } : envelope)) as unknown as typeof fetch);
    await expect(api.list()).rejects.toThrow("Published MultiAgency openings could not be read.");
  });
}

for (const stage of ["settings", "listings"] as const) {
  for (const failure of ["transport", "json", 401, 403, 429, 500] as const) {
    test(`${stage} ${failure} failures expose no upstream body or private transport detail`, async () => {
      const api = new MultiAgencyOpenings((async (url: string | URL | Request) => {
        const current = String(url).includes("/api/settings") ? "settings" : "listings";
        if (current !== stage) return Response.json({ nearnAccountId: "multiagency" });
        if (failure === "transport") throw new Error("SECRET_NETWORK_DETAIL");
        if (failure === "json") return new Response("SECRET_UPSTREAM_BODY");
        return new Response("SECRET_UPSTREAM_BODY", { status: failure });
      }) as unknown as typeof fetch);
      try { await api.list(); throw new Error("Expected failure"); }
      catch (error) { expect((error as Error).message).toBe("Published MultiAgency openings could not be read."); }
    });
  }
}

test("an invalid local clock cannot classify expired openings or fabricate a successful check", async () => {
  const api = new MultiAgencyOpenings((async (url: string | URL | Request) => Response.json(String(url).includes("/api/settings") ? { nearnAccountId: "multiagency" } : { bounties: [] })) as unknown as typeof fetch, () => new Date("invalid"));
  await expect(api.list()).rejects.toThrow("Published MultiAgency openings could not be read.");
});
