import { CopilotRuntime, createCopilotRuntimeHandler } from "@copilotkit/runtime/v2";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { sha256Hex } from "../../shared/canonical";
import type { ReviewContext } from "../../shared/review";
import type { SessionInfo } from "../auth";
import type { Config } from "../config";
import { type Engine, UserError } from "../engine";
import { EphemeralReviewRunner, ReviewAgent } from "./agent";
import { HermesReviewError, type ReviewFetch } from "./hermes";

const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const snapshotSchema = z.object({
  terms_hash: z.string().min(1).max(200), revision: z.number().int().positive(),
  state: z.enum(["submitted", "proposed", "changes_pending", "changes_requested", "settled", "closed", "disputed"]),
  judgment_id: z.string().max(200).nullable(),
});
const runSchema = z.object({ threadId: opaqueId, runId: opaqueId, forwardedProps: snapshotSchema });
const connectSchema = z.object({ threadId: opaqueId, runId: opaqueId.optional() });

interface ReviewDependencies {
  engine: Engine;
  config: Config;
  asRepresentative: (session: SessionInfo | null, contractId: string) => void;
  fetch?: ReviewFetch;
}

export function reviewRoutes(app: Hono<{ Variables: { session: SessionInfo | null } }>, dependencies: ReviewDependencies): void {
  const path = "/submissions/:sid/review/copilotkit";
  const runner = new EphemeralReviewRunner();
  app.use(`${path}/*`, bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: "The review request is too large." }, 413) }));
  app.all(`${path}/*`, async (c) => {
    const { engine, config, asRepresentative } = dependencies;
    const sid = c.req.param("sid");
    const contractId = engine.jobContract(sid);
    const session = c.get("session");
    asRepresentative(session, contractId);
    const basePath = `/api/submissions/${encodeURIComponent(sid)}/review/copilotkit`;
    const tail = new URL(c.req.url).pathname.slice(basePath.length);
    const isRun = c.req.method === "POST" && tail === "/agent/review/run";
    const isConnect = c.req.method === "POST" && tail === "/agent/review/connect";
    const isStop = c.req.method === "POST" && /^\/agent\/review\/stop\/[A-Za-z0-9_-]{1,200}$/.test(tail);
    const isInfo = c.req.method === "GET" && tail === "/info";
    if (!isRun && !isConnect && !isStop && !isInfo) return c.json({ error: "Review endpoint not found." }, 404);
    if (!config.review) return c.json({ error: "The Hermes review service is not configured." }, 503);
    if (c.req.method === "POST") {
      if (c.req.header("origin") && c.req.header("origin") !== config.auth.publicUrl || c.req.header("sec-fetch-site") === "cross-site")
        return c.json({ error: "This origin is not configured for Paperwork." }, 403);
      if (c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
        return c.json({ error: "Use JSON for review requests." }, 415);
    }
    let request = c.req.raw;
    let context: ReviewContext | null = null;
    let fingerprint: string | null = null;
    let runIdentity: { threadId: string; runId: string } | null = null;
    if (isRun || isConnect) {
      let body: unknown;
      try { body = await request.clone().json(); }
      catch { return c.json({ error: "The review request is not valid JSON." }, 400); }
      if (isRun) {
        const parsed = runSchema.safeParse(body);
        if (!parsed.success) return c.json({ error: "The review request needs the current submission identity." }, 400);
        const expected = parsed.data.forwardedProps;
        const input = engine.reviewInput(sid);
        if (JSON.stringify(input.snapshot) !== JSON.stringify(expected))
          throw new UserError("This submission changed. Refresh it before starting another review.", 409);
        context = input.context;
        fingerprint = input.fingerprint;
        runIdentity = { threadId: parsed.data.threadId, runId: parsed.data.runId };
        // Discard arbitrary browser messages, tools, model settings, state and context.
        request = new Request(request, { body: JSON.stringify({ threadId: parsed.data.threadId, runId: parsed.data.runId, messages: [], tools: [], context: [], state: {}, forwardedProps: expected }) });
      } else {
        const parsed = connectSchema.safeParse(body);
        if (!parsed.success) return c.json({ error: "The review connection identity is invalid." }, 400);
        request = new Request(request, { body: JSON.stringify({ threadId: parsed.data.threadId, runId: parsed.data.runId ?? crypto.randomUUID(), messages: [], tools: [], context: [], state: {} }) });
      }
    }
    const ownerId = sha256Hex(JSON.stringify([config.deployment, session?.accountId ?? engine.parties(contractId).representative, sid]));
    const fallbackContext: ReviewContext = { submission_id: sid, terms_hash: "", revision: 0, scope: [], report: "", evidence: [], invoice: { number: "", amount_usd: "0" } };
    const agent = new ReviewAgent({
      config: config.review, context: context ?? fallbackContext, signal: request.signal, fetch: dependencies.fetch,
      assertFresh: async () => {
        if (!fingerprint) throw new HermesReviewError("Refresh this submission before reviewing.");
        try {
          if (engine.reviewInput(sid).fingerprint !== fingerprint) throw new Error("changed");
        }
        catch { throw new HermesReviewError("This submission changed during review. Refresh it before using another draft."); }
      },
    });
    const runtime = new CopilotRuntime({
      agents: { review: agent }, runner, identifyUser: () => ({ id: ownerId, name: "Paperwork reviewer" }),
      threads: { access: "owner" }, generativeUI: false, openGenerativeUI: false, exposeMemoryRoutes: false, debug: false,
      // Bun closes idle responses after 10s; inference can be silent for much longer.
      sseKeepAliveIntervalSeconds: 5,
      // This workflow sends private records only to its configured Hermes service.
      ɵtelemetry: { capture: async () => {} },
    });
    const response = await createCopilotRuntimeHandler({ runtime, basePath, activateChannels: false })(request);
    response.headers.set("cache-control", "no-store");
    if (runIdentity && response.body) {
      const identity = runIdentity;
      const reader = response.body.getReader();
      let finished = false;
      let abortStream: () => void = () => {};
      const stop = async () => {
        await runner.stop({ ownerId, threadId: identity.threadId, runId: identity.runId });
        await reader.cancel(new DOMException("The review connection closed.", "AbortError")).catch(() => {});
      };
      // Also stop when only the response reader detaches; do not rely exclusively on request.signal.
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          abortStream = () => {
            if (finished) return;
            finished = true;
            void stop();
            controller.close();
          };
          request.signal.addEventListener("abort", abortStream, { once: true });
          if (request.signal.aborted) abortStream();
        },
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (finished) return;
            if (chunk.done) {
              finished = true;
              request.signal.removeEventListener("abort", abortStream);
              controller.close();
            }
            else controller.enqueue(chunk.value);
          } catch {
            if (finished) return;
            finished = true;
            request.signal.removeEventListener("abort", abortStream);
            controller.error(new Error("The review connection closed."));
          }
        },
        async cancel() {
          finished = true;
          request.signal.removeEventListener("abort", abortStream);
          await stop();
        },
      }), { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    return response;
  });
}
