import { describe, expect, test } from "bun:test";
import type { ReviewContext, ReviewProgress, ReviewResult } from "../src/shared/review";
import { reviewWithHermes, validateReviewResult, type HermesReviewConfig, type ReviewFetch } from "../src/server/review/hermes";

const CONFIG: HermesReviewConfig = {
  url: "http://hermes-review.invalid", apiKey: "fixture-hermes-secret", timeoutMs: 1000,
  provider: "custom:near", model: "fixture-confidential-model",
};
const CONTEXT: ReviewContext = {
  submission_id: "submission-private-1", terms_hash: "terms-private-1", revision: 1,
  scope: [{ id: "export", title: "CSV export", criteria: "Export all visible rows." }, { id: "tests", title: "Acceptance tests", criteria: "Cover empty and populated tables." }],
  report: "The CSV export is ready. Empty-table tests still need an example.",
  evidence: [{ deliverable_id: "export", url: "https://evidence.invalid/export", label: "Export demonstration" }],
  invoice: { number: "INV-1", amount_usd: "100" },
};
const RESULT: ReviewResult = {
  summary: "The export is described; the acceptance-test evidence needs clarification.",
  findings: [
    { deliverable_id: "export", status: "supported", comment: "The report describes an export and supplies an unverified reference.", report_quotes: ["The CSV export is ready."], evidence_indices: [0] },
    { deliverable_id: "tests", status: "missing_evidence", comment: "No acceptance-test evidence was supplied.", report_quotes: ["Empty-table tests still need an example."], evidence_indices: [] },
  ],
  feedback: "Please add evidence covering empty and populated tables.",
};
const RUN = "run_fixture1";
const complete = (output: unknown = RESULT) => ({ event: "run.completed", run_id: RUN, completed: true, partial: false, interrupted: false, output: typeof output === "string" ? output : JSON.stringify(output) });
const capabilities = () => Response.json({ auth: { required: true }, features: { run_submission: true, run_events_sse: true, run_stop: true } });
const toolsets = (enabled = false) => Response.json({ object: "list", platform: "api_server", data: [{ name: "terminal", enabled, configured: true, tools: ["terminal"] }] });

function sse(events: unknown[], split = false): Response {
  const text = `: open\r\n\r\n${events.map((event, i) => `id: ${i}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("")}: stream closed\r\n\r\n`;
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    // Byte-by-byte chunks exercise CRLF and UTF-8 boundaries, rather than one convenient frame.
    if (split) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}

function fixture(options: { events?: unknown[]; enabledTools?: boolean; stream?: () => Response; override?: ReviewFetch } = {}) {
  const requests: { path: string; init?: RequestInit }[] = [];
  const send: ReviewFetch = async (input, init) => {
    const path = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname;
    requests.push({ path, init });
    if (options.override) return options.override(input, init);
    if (path === "/v1/capabilities") return capabilities();
    if (path === "/v1/toolsets") return toolsets(options.enabledTools);
    if (path === "/v1/runs") return Response.json({ run_id: RUN, status: "started" }, { status: 202 });
    if (path === `/v1/runs/${RUN}/events`) return options.stream?.() ?? sse(options.events ?? [complete()]);
    if (path === `/v1/runs/${RUN}/stop`) return Response.json({ status: "stopping" });
    throw new Error(`Unexpected fixture path ${path}`);
  };
  return { send, requests };
}
async function collect(send: ReviewFetch, config = CONFIG, signal = new AbortController().signal): Promise<ReviewProgress[]> {
  const events: ReviewProgress[] = [];
  for await (const event of reviewWithHermes(config, CONTEXT, signal, send)) events.push(event);
  return events;
}

describe("Hermes report-review transport (offline API fixtures)", () => {
  test("returns only validated draft and fixed progress, sends scoped context and explicit NEAR provider", async () => {
    const f = fixture({ events: [
      { event: "message.delta", run_id: RUN, delta: "unvalidated intermediate prose" },
      { event: "reasoning.delta", run_id: RUN, delta: "private reasoning" },
      complete(),
    ] });
    expect(await collect(f.send)).toEqual([
      { type: "status", stage: "connecting" }, { type: "status", stage: "reviewing" },
      { type: "status", stage: "validating" }, { type: "complete", review: RESULT },
    ]);
    const admission = f.requests.find((request) => request.path === "/v1/runs")!;
    const headers = new Headers(admission.init?.headers);
    const body = JSON.parse(String(admission.init?.body));
    expect(headers.get("authorization")).toBe(`Bearer ${CONFIG.apiKey}`);
    expect(headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.get("x-hermes-session-key")).toBe(body.session_id);
    expect(body.session_id).toMatch(/^paperwork-review-[0-9a-f-]{36}$/);
    expect(body.session_id).not.toContain(CONTEXT.submission_id);
    expect(body).toMatchObject({ input: JSON.stringify(CONTEXT), provider: "custom:near", model: CONFIG.model });
    expect(body.instructions).toContain("Do not use tools");
    expect(body.instructions).toContain("untrusted data");
    expect(admission.init?.redirect).toBe("error");
    expect(f.requests.some((request) => request.path.endsWith("/stop"))).toBe(false);
  });

  test("parses UTF-8, CRLF and SSE frames split at every byte", async () => {
    const result = { ...RESULT, summary: "Résumé: evidence needs clarification." };
    const f = fixture({ stream: () => sse([complete(result)], true) });
    expect((await collect(f.send)).at(-1)).toEqual({ type: "complete", review: result });
  });

  test("fresh reviews never reuse a shared private conversation", async () => {
    const f = fixture();
    await collect(f.send);
    await collect(f.send);
    const bodies = f.requests.filter((request) => request.path === "/v1/runs").map((request) => JSON.parse(String(request.init?.body)));
    expect(bodies[0].session_id).not.toBe(bodies[1].session_id);
  });

  test("refuses tool-enabled or incompatible profiles before submitting private context", async () => {
    const enabled = fixture({ enabledTools: true });
    await expect(collect(enabled.send)).rejects.toThrow("all API toolsets disabled");
    expect(enabled.requests.map((request) => request.path)).toEqual(["/v1/capabilities", "/v1/toolsets"]);
    const incompatible = fixture({ override: async () => Response.json({ auth: { required: false }, features: {} }) });
    await expect(collect(incompatible.send)).rejects.toThrow("does not support authenticated");
    expect(incompatible.requests).toHaveLength(1);
  });

  test("rejects unknown deliverables, invented report quotes, foreign evidence and incomplete coverage", () => {
    const modified = () => structuredClone(RESULT);
    const unknown = modified(); unknown.findings[0]!.deliverable_id = "foreign";
    expect(() => validateReviewResult(unknown, CONTEXT)).toThrow("unknown or repeated deliverable");
    const duplicate = modified(); duplicate.findings[1]!.deliverable_id = "export";
    expect(() => validateReviewResult(duplicate, CONTEXT)).toThrow("unknown or repeated deliverable");
    const quote = modified(); quote.findings[0]!.report_quotes = ["The agency approved everything."];
    expect(() => validateReviewResult(quote, CONTEXT)).toThrow("text absent from this report");
    const foreign = modified(); foreign.findings[1]!.evidence_indices = [0];
    expect(() => validateReviewResult(foreign, CONTEXT)).toThrow("evidence absent from this deliverable");
    const missing = modified(); missing.findings.pop();
    expect(() => validateReviewResult(missing, CONTEXT)).toThrow("omitted a signed deliverable");
    const ungrounded = modified(); ungrounded.findings[0]!.evidence_indices = []; ungrounded.findings[0]!.report_quotes = [];
    expect(() => validateReviewResult(ungrounded, CONTEXT)).toThrow("needs a report quote or evidence reference");
  });

  test("requires a successful completed run, not partial text, EOF or partial terminal output", async () => {
    for (const events of [
      [{ event: "message.delta", run_id: RUN, delta: JSON.stringify(RESULT) }],
      [{ ...complete(), partial: true }],
      [{ ...complete(), completed: false }],
      [{ ...complete(), partial: undefined }],
      [{ ...complete(), interrupted: "false" }],
      [{ event: "run.failed", run_id: RUN, error: "secret provider diagnostic" }],
      [{ event: "run.completed", run_id: "run_foreign", completed: true, output: JSON.stringify(RESULT) }],
    ]) {
      const f = fixture({ events });
      await expect(collect(f.send)).rejects.toThrow();
      expect(f.requests.filter((request) => request.path === `/v1/runs/${RUN}/stop`)).toHaveLength(1);
    }
  });

  test("tool and approval events fail without exposing previews or pretending they are frontend calls", async () => {
    for (const name of ["tool.started", "tool.completed", "approval.request", "clarify.request", "subagent.start"]) {
      const f = fixture({ events: [{ event: name, run_id: RUN, preview: CONFIG.apiKey }, complete()] });
      let message = "";
      try { await collect(f.send); } catch (error) { message = String(error); }
      expect(message).toContain("attempted a tool or approval action");
      expect(message).not.toContain(CONFIG.apiKey);
      expect(f.requests.filter((request) => request.path.endsWith("/stop"))).toHaveLength(1);
    }
  });

  test("upstream errors stay generic and admission is never retried automatically", async () => {
    let admissions = 0;
    const f = fixture({ override: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/capabilities") return capabilities();
      if (path === "/v1/toolsets") return toolsets();
      admissions++;
      throw new Error(`private upstream failure ${CONFIG.apiKey}`);
    } });
    await expect(collect(f.send)).rejects.toThrow("review service is unavailable");
    expect(admissions).toBe(1);
  });

  test("bounds a fetch that ignores abort and does not submit a run after its deadline", async () => {
    const f = fixture({ override: () => new Promise<Response>(() => {}) });
    const started = Date.now();
    await expect(collect(f.send, { ...CONFIG, timeoutMs: 15 })).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(500);
    expect(f.requests).toHaveLength(1);
  });

  test("bounds an idle SSE body and best-effort stops only the admitted run", async () => {
    const f = fixture({ stream: () => new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } }) });
    await expect(collect(f.send, { ...CONFIG, timeoutMs: 15 })).rejects.toThrow("timed out");
    expect(f.requests.filter((request) => request.path.endsWith("/stop")).map((request) => request.path)).toEqual([`/v1/runs/${RUN}/stop`]);
  });

  test("external cancellation stops original run and discards the draft", async () => {
    const controller = new AbortController();
    const f = fixture({ stream: () => {
      queueMicrotask(() => controller.abort());
      return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    } });
    await expect(collect(f.send, CONFIG, controller.signal)).rejects.toThrow("was stopped");
    expect(f.requests.filter((request) => request.path.endsWith("/stop"))).toHaveLength(1);
  });

  test("refuses oversized streams before treating a final response as usable", async () => {
    const f = fixture({ stream: () => new Response(`data: ${"x".repeat(512 * 1024 + 1)}\n\n`, { headers: { "content-type": "text/event-stream" } }) });
    await expect(collect(f.send)).rejects.toThrow("more review data than supported");
    expect(f.requests.some((request) => request.path.endsWith("/stop"))).toBe(true);
  });
});
