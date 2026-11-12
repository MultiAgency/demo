import { expect, test } from "bun:test";
import { SdkPlatform } from "../src/server/platform/client";

test("DAO replies preserve proposal transactions and cannot become wallet-signable intents", async () => {
  const dao = { owner: "derived-owner", transaction: { receiverId: "v1.signer", actions: [] },
    proposal: { receiverId: "agency.sputnik-dao.near", actions: [] }, proposalAndVote: null };
  const platform = new SdkPlatform({ url: "https://platform.invalid", credential: "tap_offline_fixture", deployment: "multiagency-paperwork",
    fetch: (async () => Response.json({ json: { correlationId: "original-dao-step", expiresAt: "2026-11-20T12:05:00Z", preview: { summary: "Payout grant" }, digest: null, dao } })) as unknown as typeof fetch });
  const agent = platform.agent("fixture-job", "fixture-agent");
  expect(await agent.ownerPrepare({ type: "grant_issue", label: "payout" }, "dao")).toEqual({ ok: true, value: {
    correlationId: "original-dao-step", expiresAt: "2026-11-20T12:05:00Z", summary: "Payout grant", dao,
  } });
  expect(await agent.ownerPrepare({ type: "grant_issue", label: "payout" }, "wallet"))
    .toMatchObject({ ok: false, code: "unreadable_intent" });
});

test("DAO payout preparation omits wallet ownership and preserves the DAO grant label", async () => {
  const requests: Record<string, any>[] = [];
  const platform = new SdkPlatform({ url: "https://platform.invalid", credential: "tap_offline_fixture", deployment: "multiagency-paperwork", grantLabel: "invoices",
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      // A definite refusal is sufficient here to inspect exactly what crossed the real SDK boundary.
      return Response.json({ code: "fixture_refusal", error: "offline" }, { status: 403 });
    }) as unknown as typeof fetch });
  const agent = platform.agent("fixture-job", "fixture-agent");
  await agent.ownerPrepare({ type: "agent_create", role: "payout", owner: { type: "near", account_id: "member.demo", public_key: "unused" } }, "dao");
  await agent.ownerPrepare({ type: "grant_issue", label: "payout" }, "dao");
  expect(requests[0]?.json).toEqual({ signer: "dao", action: { type: "agent_create", role: "payout" } });
  expect(requests[1]?.json).toEqual({ signer: "dao", action: { type: "grant_issue", label: "payout" } });
});
