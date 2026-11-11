import { describe, expect, test } from "bun:test";
import { SdkPlatform } from "../src/server/platform/client";

const credential = "tap_fixture_not_a_live_credential";

/** Exercise the installed SDK's RPC/output parsing as well as Covenant's adapter; no network is used. */
function platform(answer: Record<string, unknown>) {
  const paths: string[] = [];
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    paths.push(new URL(String(input)).pathname);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
    return Response.json({ json: answer });
  }) as typeof fetch;
  return { send, paths };
}

describe("SDK payout non-execution proof mapping — injected HTTP fixtures", () => {
  for (const fixture of [
    { name: "explicit proof", fields: { failureCode: "rejected", neverExecuted: true }, expectedCode: "rejected", expectedProof: true },
    { name: "explicit uncertainty", fields: { failureCode: "delivery_outcome_unknown", neverExecuted: false }, expectedCode: "delivery_outcome_unknown", expectedProof: false },
    { name: "rejection code without proof", fields: { failureCode: "rejected" }, expectedCode: "rejected", expectedProof: false },
    { name: "older response without either field", fields: {}, expectedCode: null, expectedProof: false },
  ]) {
    test(`${fixture.name} is preserved on both payout request and status`, async () => {
      const answer = { requestId: "fixture-payout-001", state: "failed", status: "FAILED", correlationId: "fixture-correlation", code: null, ...fixture.fields };
      const { send, paths } = platform(answer);
      const sdk = new SdkPlatform({ url: "https://platform.invalid", credential, deployment: "fixture", fetch: send });
      const agent = sdk.agent("fixture-order", "fixture-agent");
      const requested = await agent.requestPayout({ requestId: answer.requestId, recipient: "builder.demo", amount: "300000000", expectedPolicy: { revision: 2, digest: `sha256:${"0".repeat(64)}` } });
      const observed = await agent.payoutStatus(answer.requestId);
      for (const result of [requested, observed]) {
        expect(result).toEqual({ ok: true, value: {
          requestId: answer.requestId, state: "failed", status: "FAILED", correlationId: answer.correlationId, code: null,
          failureCode: fixture.expectedCode, neverExecuted: fixture.expectedProof,
        } });
        expect(JSON.stringify(result)).not.toContain(credential);
      }
      expect(paths).toEqual([
        "/apps/v1/o/fixture-order/a/fixture-agent/rpc/payouts/request",
        "/apps/v1/o/fixture-order/a/fixture-agent/rpc/payouts/status",
      ]);
    });
  }

  test("a malformed truthy proof is refused by SDK parsing rather than promoted to non-execution", async () => {
    const { send } = platform({ requestId: "fixture-payout-001", state: "failed", status: "FAILED", correlationId: "fixture-correlation", code: null, failureCode: "rejected", neverExecuted: "true" });
    const sdk = new SdkPlatform({ url: "https://platform.invalid", credential, deployment: "fixture", fetch: send });
    expect(await sdk.agent("fixture-order", "fixture-agent").payoutStatus("fixture-payout-001")).toMatchObject({ ok: false, kind: "unavailable" });
  });
});
