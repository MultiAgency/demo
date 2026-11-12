import { describe, expect, test } from "bun:test";
import { checkHostedReview, hostedReviewConfig, HostedReviewCheckError, SYNTHETIC_REVIEW_CONTEXT } from "../scripts/check-review-live";
import type { ReviewFetch } from "../src/server/review/hermes";
import type { ReviewResult } from "../src/shared/review";

const ENV = {
  PAPERWORK_HERMES_URL: "https://review.example.invalid/p/synthetic",
  PAPERWORK_HERMES_API_KEY: "fixture-hosted-review-secret",
  PAPERWORK_HERMES_PROVIDER: "custom:near",
  PAPERWORK_HERMES_MODEL: "fixture/near-model",
};
const RUN = "run_synthetic_fixture";
const RESULT: ReviewResult = {
  summary: "The synthetic report claims the required CSV columns; the reference is unverified.",
  findings: [{ deliverable_id: "synthetic-csv", status: "supported", comment: "Only the supplied synthetic claim and reference were reviewed.",
    report_quotes: [SYNTHETIC_REVIEW_CONTEXT.report], evidence_indices: [0] }],
  feedback: "",
};
const RUNTIME = { provider: "custom", model: ENV.PAPERWORK_HERMES_MODEL, route_source: "raw_request",
  requested: { provider: "custom:near", model: ENV.PAPERWORK_HERMES_MODEL } } as const;

function fixture(options: { runtime?: unknown; result?: ReviewResult; status?: Partial<Record<string, unknown>>; failAdmission?: boolean; streamEvents?: unknown[] } = {}) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const send: ReviewFetch = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname.replace("/p/synthetic", "");
    calls.push({ path, init });
    if (path === "/v1/capabilities") return Response.json({ auth: { required: true }, features: { run_submission: true, run_events_sse: true, run_stop: true } });
    if (path === "/v1/toolsets") return Response.json({ object: "list", platform: "api_server", data: [] });
    if (path === "/v1/runs") {
      if (options.failAdmission) throw new Error(`private upstream detail ${ENV.PAPERWORK_HERMES_API_KEY} ${ENV.PAPERWORK_HERMES_URL}?secret=yes`);
      return Response.json({ run_id: RUN, status: "started" });
    }
    if (path === `/v1/runs/${RUN}/events`) {
      const events = options.streamEvents ?? [{ event: "message.delta", run_id: RUN, delta: "private intermediate text" },
        { event: "run.completed", run_id: RUN, completed: true, partial: false, interrupted: false, output: JSON.stringify(options.result ?? RESULT) }];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    if (path === `/v1/runs/${RUN}`) return Response.json({ object: "hermes.run", run_id: RUN, status: "completed", completed: true, partial: false,
      interrupted: false, model: ENV.PAPERWORK_HERMES_MODEL, runtime: options.runtime ?? RUNTIME,
      output: "status output is deliberately not used", ...options.status });
    if (path === `/v1/runs/${RUN}/stop`) return Response.json({ status: "stopping" });
    throw new Error("Unexpected offline fixture path.");
  };
  return { send, calls };
}

describe("manual hosted synthetic review check (offline fixtures only)", () => {
  test("submits only fixed synthetic data once and reports validated result plus served custom metadata", async () => {
    const f = fixture();
    const receipt = await checkHostedReview(hostedReviewConfig(ENV), f.send);
    expect(receipt).toEqual({ outcome: "pass", synthetic: true, runtime: RUNTIME,
      calls: { capabilities: 1, toolsets: 1, run_submissions: 1, event_streams: 1, run_status_reads: 1, stop_requests: 0 }, review: RESULT });
    const admission = f.calls.find((call) => call.path === "/v1/runs")!;
    const body = JSON.parse(String(admission.init?.body));
    expect(JSON.parse(body.input)).toEqual(SYNTHETIC_REVIEW_CONTEXT);
    expect(body.provider).toBe("custom:near");
    expect(body.model).toBe(ENV.PAPERWORK_HERMES_MODEL);
    expect(JSON.stringify(receipt)).not.toContain("private intermediate text");
    expect(JSON.stringify(receipt)).not.toContain(ENV.PAPERWORK_HERMES_API_KEY);
    const status = f.calls.find((call) => call.path === `/v1/runs/${RUN}`)!;
    expect(new Headers(status.init?.headers).get("authorization")).toBe(`Bearer ${ENV.PAPERWORK_HERMES_API_KEY}`);
    expect(status.init?.redirect).toBe("error");
  });

  test("requires all four explicit settings and rejects unsafe endpoint forms before any call", () => {
    for (const key of Object.keys(ENV)) expect(() => hostedReviewConfig({ ...ENV, [key]: undefined })).toThrow(HostedReviewCheckError);
    for (const url of ["http://review.example.invalid", "https://user:secret@review.example.invalid", "https://review.example.invalid/?secret=value", "https://review.example.invalid/#secret", "https://review.example.invalid/v1"])
      expect(() => hostedReviewConfig({ ...ENV, PAPERWORK_HERMES_URL: url })).toThrow(HostedReviewCheckError);
    expect(() => hostedReviewConfig({ ...ENV, PAPERWORK_HERMES_PROVIDER: "auto" })).toThrow(HostedReviewCheckError);
    expect(() => hostedReviewConfig({ ...ENV, PAPERWORK_HERMES_MODEL: undefined, NEARAI_MODEL: ENV.PAPERWORK_HERMES_MODEL })).toThrow(HostedReviewCheckError);
  });

  test("verifies the served runtime rather than trusting the request echo", async () => {
    for (const runtime of [
      {}, { ...RUNTIME, provider: "openrouter" }, { ...RUNTIME, provider: "custom:near" },
      { ...RUNTIME, model: "different/served-model" }, { ...RUNTIME, route_source: "model_routes" },
      { ...RUNTIME, requested: { provider: "custom:other", model: ENV.PAPERWORK_HERMES_MODEL } },
    ]) {
      const f = fixture({ runtime });
      await expect(checkHostedReview(hostedReviewConfig(ENV), f.send)).rejects.toMatchObject({ code: "runtime_unverified" });
      expect(f.calls.filter((call) => call.path === "/v1/runs")).toHaveLength(1);
    }
    const f = fixture({ status: { run_id: "run_other" } });
    await expect(checkHostedReview(hostedReviewConfig(ENV), f.send)).rejects.toMatchObject({ code: "runtime_unverified" });
    for (const status of ["running", "failed", "cancelled"])
      await expect(checkHostedReview(hostedReviewConfig(ENV), fixture({ status: { status } }).send)).rejects.toMatchObject({ code: "runtime_unverified" });
  });

  test("accepts committed status runtime when the durable projection omits completion flags", async () => {
    const f = fixture({ status: { completed: undefined, partial: undefined, interrupted: undefined } });
    expect((await checkHostedReview(hostedReviewConfig(ENV), f.send)).runtime).toEqual(RUNTIME);
    // Status compatibility does not relax the transport's SSE completion contract.
    const partial = fixture({ streamEvents: [{ event: "run.completed", run_id: RUN, completed: true, partial: true,
      interrupted: false, output: JSON.stringify(RESULT) }] });
    await expect(checkHostedReview(hostedReviewConfig(ENV), partial.send)).rejects.toMatchObject({ code: "review_failed" });
    expect(partial.calls.filter((call) => call.path === `/v1/runs/${RUN}`)).toHaveLength(0);
  });

  test("invented citations fail existing validation and stop the admitted run without a status read", async () => {
    const result = structuredClone(RESULT);
    result.findings[0]!.report_quotes = ["The real agency approved payment."];
    const f = fixture({ result });
    await expect(checkHostedReview(hostedReviewConfig(ENV), f.send)).rejects.toMatchObject({ code: "review_failed" });
    expect(f.calls.filter((call) => call.path.endsWith("/stop"))).toHaveLength(1);
    expect(f.calls.filter((call) => call.path === `/v1/runs/${RUN}`)).toHaveLength(0);
  });

  test("requires an exact report quote and never retries when output is insufficient", async () => {
    const result = structuredClone(RESULT);
    result.findings[0]!.report_quotes = [];
    const f = fixture({ result });
    await expect(checkHostedReview(hostedReviewConfig(ENV), f.send)).rejects.toMatchObject({ code: "quote_missing" });
    expect(f.calls.filter((call) => call.path === "/v1/runs")).toHaveLength(1);
    result.findings[0]!.report_quotes = ["date, project, and amount columns"];
    expect((await checkHostedReview(hostedReviewConfig(ENV), fixture({ result }).send)).review).toEqual(result);
  });

  test("bounds the separate status observation and refuses oversized status bodies", async () => {
    const f = fixture();
    const send: ReviewFetch = (input, init) => String(input).endsWith(`/v1/runs/${RUN}`)
      ? Promise.resolve(new Response(new ReadableStream<Uint8Array>(), { headers: { "content-type": "application/json" } }))
      : f.send(input, init);
    const started = Date.now();
    await expect(checkHostedReview(hostedReviewConfig(ENV), send)).rejects.toMatchObject({ code: "runtime_unverified" });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(f.calls.filter((call) => call.path === "/v1/runs")).toHaveLength(1);
    const oversized = fixture({ status: { diagnostic: "x".repeat(64 * 1024) } });
    await expect(checkHostedReview(hostedReviewConfig(ENV), oversized.send)).rejects.toMatchObject({ code: "runtime_unverified" });
  });

  test("upstream exceptions and attempted secret echoes never become printable output", async () => {
    const f = fixture({ failAdmission: true });
    let caught: unknown;
    try { await checkHostedReview(hostedReviewConfig(ENV), f.send); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(HostedReviewCheckError);
    expect(String(caught)).not.toContain(ENV.PAPERWORK_HERMES_API_KEY);
    expect(String(caught)).not.toContain(ENV.PAPERWORK_HERMES_URL);
    expect(f.calls.filter((call) => call.path === "/v1/runs")).toHaveLength(1);
    const result = { ...RESULT, summary: ENV.PAPERWORK_HERMES_API_KEY };
    await expect(checkHostedReview(hostedReviewConfig(ENV), fixture({ result }).send)).rejects.toMatchObject({ code: "output_refused" });
  });
});
