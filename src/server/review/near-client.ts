import {
  AttestationClient, InferenceClient, isApiError,
  type AttestationVerificationResult, type FetchedGatewayAttestation,
  type InferenceClientOptions, type VerifiedCompletionResult,
} from "@nearai/inference-sdk/node";
import { NEAR_AI_BASE_URL } from "./types";

export interface NearChatRequest {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  max_tokens: number;
  reasoning_effort: "low";
  stream: false;
}
export interface NearReviewClient {
  verify(model: string): Promise<AttestationVerificationResult>;
  complete(request: NearChatRequest): Promise<unknown>;
  verifyResponse(id: string): Promise<VerifiedCompletionResult>;
  dispose(): void;
}
interface NearSdkPort {
  verify(model: string): Promise<AttestationVerificationResult>;
  complete(request: NearChatRequest): Promise<unknown>;
  verifyResponse(id: string): Promise<VerifiedCompletionResult>;
  clearResponseCache(): void;
}
export interface NearClientDependencies {
  /** Per-instance offline seam; never selected by configuration or an HTTP request. */
  createSdk?: (options: InferenceClientOptions, scope: NearNetworkScope) => NearSdkPort;
}
export type NearFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const COMPLETION_BYTES = 512 * 1024;
const PREFLIGHT_BYTES = 2 * 1024 * 1024;
const STOPPED = () => new DOMException("The NEAR review connection was stopped.", "AbortError");
const RECEIPT_RETRY_STATUSES = new Set([404, 408, 429, 500, 502, 503, 504]);

function retryReceiptLookup(error: unknown): boolean {
  if (!isApiError(error)) return false;
  const failure = error.failure;
  if (failure.code === "api.completion_signature_unavailable") return true;
  if (failure.code === "api.http_status")
    return failure.details.resource === "completion_signature" && RECEIPT_RETRY_STATUSES.has(failure.details.status);
  return failure.code === "api.transport_failed" && failure.details.resource === "completion_signature" && failure.retryable;
}

/** Owns one review's transport budget, preserving the official SDK's TLS and crypto. */
export class NearNetworkScope {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly externalAbort: () => void;
  private completionAttempts = 0;

  constructor(timeoutMs: number, private readonly external: AbortSignal) {
    this.signal = this.controller.signal;
    this.externalAbort = () => this.controller.abort(external.reason ?? STOPPED());
    external.addEventListener("abort", this.externalAbort, { once: true });
    if (external.aborted) this.externalAbort();
    this.timer = setTimeout(() => this.controller.abort(new DOMException("The NEAR review timed out.", "TimeoutError")), timeoutMs);
    this.timer.unref?.();
  }
  active(): void { this.signal.throwIfAborted(); }
  stop(): void {
    clearTimeout(this.timer);
    this.external.removeEventListener("abort", this.externalAbort);
    this.controller.abort(STOPPED());
  }
  wait<T>(operation: Promise<T>): Promise<T> {
    if (this.signal.aborted) return Promise.reject(this.signal.reason);
    return new Promise((resolve, reject) => {
      const abort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", abort, { once: true });
      void operation.then(value => {
        this.signal.removeEventListener("abort", abort);
        if (this.signal.aborted) reject(this.signal.reason); else resolve(value);
      }, error => { this.signal.removeEventListener("abort", abort); reject(error); });
    });
  }
  pause(milliseconds: number): Promise<void> {
    this.active();
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(this.signal.reason); };
      const timer = setTimeout(() => { this.signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
      this.signal.addEventListener("abort", abort, { once: true });
    });
  }
  request(request: Request): Request {
    this.active();
    const url = new URL(request.url);
    const base = new URL(NEAR_AI_BASE_URL);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname + "/"))
      throw new Error("The NEAR transport refused an unexpected destination.");
    return new Request(request, { signal: AbortSignal.any([request.signal, this.signal]), redirect: "error" });
  }
  limited(response: Response, limit: number): Response {
    if (this.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      this.active();
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let bytes = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          this.active();
          const chunk = await this.wait(reader.read());
          if (chunk.done) { controller.close(); reader.releaseLock(); return; }
          bytes += chunk.value.byteLength;
          if (bytes > limit) throw new Error("The NEAR response exceeded its supported size.");
          controller.enqueue(chunk.value);
        } catch (error) {
          void reader.cancel().catch(() => {});
          controller.error(error);
        }
      },
      cancel: reason => { void reader.cancel(reason).catch(() => {}); },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  wrap(send: NearFetch): NearFetch {
    return async (input, init) => {
      const request = this.request(new Request(input, init));
      const completion = request.method === "POST" && new URL(request.url).pathname === new URL(NEAR_AI_BASE_URL).pathname + "/chat/completions";
      if (completion && ++this.completionAttempts > 1)
        throw new Error("The NEAR review already attempted its model request.");
      const pending = send(request);
      // A noncooperating transport must not retain a late body after cancellation.
      void pending.then(response => {
        if (this.signal.aborted) void response.body?.cancel().catch(() => {});
      }, () => {});
      const response = await this.wait(pending);
      return this.limited(response, completion ? COMPLETION_BYTES : PREFLIGHT_BYTES);
    };
  }
}

class BoundedAttestationClient extends AttestationClient {
  constructor(options: InferenceClientOptions, private readonly scope: NearNetworkScope) { super(options); }
  protected override async requestGatewayAttestation(request: Request, capturePeerSpkiFingerprint: boolean) {
    const pending = super.requestGatewayAttestation(this.scope.request(request), capturePeerSpkiFingerprint);
    void pending.then(value => {
      if (this.scope.signal.aborted) void value.response.body?.cancel().catch(() => {});
    }, () => {});
    const result = await this.scope.wait(pending);
    return { ...result, response: this.scope.limited(result.response, PREFLIGHT_BYTES) };
  }
}

class BoundedInferenceClient extends InferenceClient {
  private readonly gateway: BoundedAttestationClient;
  constructor(options: InferenceClientOptions, private readonly scope: NearNetworkScope) {
    super(options);
    this.gateway = new BoundedAttestationClient(options, scope);
  }
  protected override fetchGatewayAttestation(): Promise<FetchedGatewayAttestation> {
    this.scope.active();
    return this.gateway.fetchGatewayAttestation({ signingAlgo: "ed25519", includeSpkiFingerprint: true });
  }
  protected override createPinnedTlsFetch(fingerprint: string): typeof globalThis.fetch {
    // Delegate peer/hostname/certificate checks unchanged to the official Node transport.
    return this.scope.wrap(super.createPinnedTlsFetch(fingerprint)) as typeof globalThis.fetch;
  }
}

const defaultSdk = (options: InferenceClientOptions, scope: NearNetworkScope): NearSdkPort => {
  const client = new BoundedInferenceClient(options, scope);
  return {
    verify: model => client.verify(model),
    complete: request => client.chat.completions.create(request, { signal: scope.signal, maxRetries: 0 }),
    verifyResponse: id => client.verifyResponse(id),
    clearResponseCache: () => client.clearResponseCache(),
  };
};

/** Fresh client per review: explicit verification, one inference attempt, bounded lifetime. */
export function createNearReviewClient(
  options: { apiKey: string; timeoutMs: number }, signal: AbortSignal,
  dependencies: NearClientDependencies = {},
): NearReviewClient {
  if (!options.apiKey || /[\s\x00-\x1f\x7f]/.test(options.apiKey) || options.apiKey.length > 4096 ||
      !Number.isFinite(options.timeoutMs) || !Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 300_000)
    throw new Error("The NEAR review client configuration is invalid.");
  const scope = new NearNetworkScope(options.timeoutMs, signal);
  let sdk: NearSdkPort | undefined;
  let attempted = false;
  let responseCacheCleared = false;
  try {
    scope.active();
    sdk = (dependencies.createSdk ?? defaultSdk)({
      baseUrl: NEAR_AI_BASE_URL, apiKey: options.apiKey, e2ee: true, ohttp: false, signingAlgo: "ed25519",
      gatewayVerification: { includeSpkiFingerprint: true, policy: { acceptedTcbStatuses: ["UpToDate"] } },
      modelVerification: { policy: { acceptedTcbStatuses: ["UpToDate"], gpuEvidence: "required" } },
      attestationCacheTimeToLiveMs: options.timeoutMs,
      responseCacheTimeToLiveMs: options.timeoutMs,
    }, scope);
  } catch (error) { scope.stop(); throw error; }
  const activeSdk = (): NearSdkPort => {
    scope.active();
    if (!sdk) throw STOPPED();
    return sdk;
  };
  const releaseResponseCache = (): void => {
    if (responseCacheCleared) return;
    responseCacheCleared = true;
    sdk?.clearResponseCache();
  };
  return {
    verify: model => scope.wait(activeSdk().verify(model)),
    complete: request => {
      const client = activeSdk();
      if (attempted) return Promise.reject(new Error("The NEAR review already attempted its model request."));
      attempted = true;
      // Only the bounded review surface is forwarded; callers cannot add tools.
      return scope.wait(client.complete({ model: request.model, messages: request.messages,
        max_tokens: request.max_tokens, reasoning_effort: "low", stream: false }));
    },
    verifyResponse: async id => {
      try {
        for (let attempt = 0; ; attempt++) {
          try { return await scope.wait(activeSdk().verifyResponse(id)); }
          catch (error) {
            scope.active();
            if (attempt >= 2 || !retryReceiptLookup(error)) throw error;
            // Only observe the same response again. Never repeat inference or preflight.
            await scope.pause(attempt === 0 ? 200 : 600);
          }
        }
      } finally { releaseResponseCache(); }
    },
    dispose: () => { scope.stop(); releaseResponseCache(); sdk = undefined; },
  };
}
