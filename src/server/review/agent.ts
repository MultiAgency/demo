import "./privacy";
import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { AgentRunner, ThreadAlreadyRunningError, type AgentRunnerConnectRequest, type AgentRunnerIsRunningRequest, type AgentRunnerRunRequest, type AgentRunnerStopRequest, type LocalThreadEndpointScope } from "@copilotkit/runtime/v2";
import { Observable, Subject, type Subscription } from "rxjs";
import type { ReviewContext } from "../../shared/review";
import { HermesReviewError, reviewWithHermes, type ReviewFetch } from "./hermes";
import { reviewWithNear, type NearReviewClientFactory } from "./near";
import type { ReviewServiceConfig } from "./types";

interface ReviewAgentOptions {
  config: ReviewServiceConfig;
  context: ReviewContext;
  signal: AbortSignal;
  assertFresh: () => Promise<void>;
  fetch?: ReviewFetch;
  nearClient?: NearReviewClientFactory;
}

const PROGRESS = {
  connecting: "Connecting to the review service…",
  reviewing: "Comparing the report with the signed deliverables…",
  validating: "Checking the review’s source references…",
};

/** This agent receives an authorized server projection, never model instructions from the client. */
export class ReviewAgent extends AbstractAgent {
  constructor(private readonly options: ReviewAgentOptions) {
    super({ agentId: "review", description: "Prepare a source-backed report-review draft." });
  }

  override clone(): ReviewAgent { return new ReviewAgent(this.options); }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((observer) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      this.options.signal.addEventListener("abort", abort, { once: true });
      if (this.options.signal.aborted) abort();
      observer.next({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
      void (async () => {
        try {
          const progressStream = this.options.config.backend === "near"
            ? reviewWithNear(this.options.config, this.options.context, controller.signal, this.options.nearClient)
            : reviewWithHermes(this.options.config, this.options.context, controller.signal, this.options.fetch);
          for await (const progress of progressStream) {
            if (observer.closed || controller.signal.aborted) return;
            if (progress.type === "status") {
              observer.next({ type: EventType.STATE_SNAPSHOT, snapshot: { progress: PROGRESS[progress.stage] } });
              continue;
            }
            await this.options.assertFresh();
            if (observer.closed || controller.signal.aborted) return;
            observer.next({ type: EventType.STATE_SNAPSHOT, snapshot: { progress: "Review ready", result: progress.review,
              ...(progress.verification && { verification: progress.verification }) } });
            const messageId = crypto.randomUUID();
            observer.next({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
            observer.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: progress.review.summary });
            observer.next({ type: EventType.TEXT_MESSAGE_END, messageId });
            observer.next({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
          }
        } catch (error) {
          if (observer.closed) return;
          const message = error instanceof HermesReviewError ? error.message : "The review could not finish. Refresh the submission and try again.";
          observer.next({ type: EventType.STATE_SNAPSHOT, snapshot: { progress: message } });
          observer.next({ type: EventType.RUN_ERROR, message, code: controller.signal.aborted ? "STOPPED" : "REVIEW_FAILED" });
        } finally {
          this.options.signal.removeEventListener("abort", abort);
          observer.complete();
        }
      })();
      return () => {
        this.options.signal.removeEventListener("abort", abort);
        controller.abort();
      };
    });
  }
}

interface ActiveReview {
  runId: string;
  threadId: string;
  events: Subject<BaseEvent>;
  source: Subscription | null;
  stop: () => void;
}

// Count all mounted review runners in this process; never allocate an unbounded admission queue.
let activeReviewCount = 0;
const MAX_ACTIVE_REVIEWS = 4;

/** Keeps only active streams. Completed results, messages and client state are never retained. */
export class EphemeralReviewRunner extends AgentRunner {
  private readonly active = new Map<string, ActiveReview>();

  private key(ownerId: string | undefined, threadId: string): string {
    return JSON.stringify([ownerId ?? "", threadId]);
  }

  isThreadAccessible(_threadId: string, scope: LocalThreadEndpointScope): boolean {
    // Thread ids live inside an owner namespace. A foreign id therefore names no data here.
    return !!scope.ownerId;
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    return new Observable((observer) => {
      const key = this.key(request.ownerId, request.threadId);
      if (this.active.has(key)) { observer.error(new ThreadAlreadyRunningError()); return; }
      if (activeReviewCount >= MAX_ACTIVE_REVIEWS) {
        observer.next({ type: EventType.RUN_ERROR, message: "The review service is busy. Try again shortly.", code: "REVIEW_BUSY" });
        observer.complete();
        return;
      }
      const events = new Subject<BaseEvent>();
      const subscriber = events.subscribe(observer);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        this.active.delete(key);
        activeReviewCount--;
        entry.source?.unsubscribe();
        events.complete();
      };
      const entry: ActiveReview = {
        runId: request.input.runId, threadId: request.threadId, events, source: null,
        stop: () => {
          events.next({ type: EventType.STATE_SNAPSHOT, snapshot: { progress: "Review stopped" } });
          events.next({ type: EventType.RUN_ERROR, message: "Review stopped", code: "STOPPED" });
          finish();
        },
      };
      this.active.set(key, entry);
      activeReviewCount++;
      try {
        entry.source = request.agent.run(request.input).subscribe({
          next: (event) => events.next(event),
          error: () => {
            events.next({ type: EventType.RUN_ERROR, message: "The review could not finish.", code: "REVIEW_FAILED" });
            finish();
          },
          complete: finish,
        });
      } catch {
        events.next({ type: EventType.RUN_ERROR, message: "The review could not start.", code: "REVIEW_FAILED" });
        finish();
      }
      if (finished) entry.source?.unsubscribe();
      return () => { subscriber.unsubscribe(); finish(); };
    });
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    // Live attachment only: there is deliberately no replay, history store or result cache.
    return this.active.get(this.key(request.ownerId, request.threadId))?.events.asObservable()
      ?? new Observable((observer) => observer.complete());
  }

  async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    return this.active.has(this.key(request.ownerId, request.threadId));
  }

  async stop(request: AgentRunnerStopRequest): Promise<boolean> {
    const entry = this.active.get(this.key(request.ownerId, request.threadId));
    if (!entry || (request.runId && entry.runId !== request.runId)) return false;
    entry.stop();
    return true;
  }
}
