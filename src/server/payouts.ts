// The payout attempt state machine and payout planning. Pure: no database, no platform calls.
//
// Rules this file encodes:
// - A recorded refusal or rejection with explicit non-execution proof frees money. Legacy v2 manual resolutions
//   can also free money; the v3 engine requires non-execution proof for those resolutions. Everything else stays committed.
// - Only a recorded refusal or a resolved failure allows a new requestId. Every other case re-asks the same id.
// - The judgment is the open unit: every seq of one run belongs to it, and it closes once.
import type { Fail, PayoutAnswer } from "./platform/port";
import type { AttemptState, PayoutResolution } from "../shared/views";
import { minBig, toAtomic } from "../shared/money";
import { type Terms, USDC_DECIMALS } from "../shared/terms";

export interface AttemptLike {
  request_id: string;
  kind: "payout" | "attack";
  seq: number;
  attempt: number;
  state: AttemptState;
  resolution: PayoutResolution | null;
  amount_atomic: string;
  code: string | null;
  auto_retry: number;
}

export interface Line {
  deliverable_id: string;
  amount: bigint;
}

/** `<hash16>-p<seq>-<attempt>`: stable for the same lines, new only when a new request is allowed. */
export function requestIdFor(hash: string, seq: number, attempt: number): string {
  return `${hash.slice(0, 16)}-p${seq}-${attempt}`;
}

export function attackIdFor(scenario: string, rand: string): string {
  return `atk-${scenario}-${rand.slice(0, 10)}`;
}

/** Live attempt states: followed on the status timer, and (with an unresolved `failed`) the open payout slot. */
export const OPEN_STATES: readonly AttemptState[] = ["pending", "blocked", "waiting", "unknown", "held", "processing"];

/** States that hold the contract's one open payout slot (mirrors the `one_open_payout` index). */
export function isOpen(a: Pick<AttemptLike, "kind" | "state" | "resolution">): boolean {
  if (a.kind !== "payout") return false;
  if (a.state === "failed") return a.resolution === null || a.resolution === "disputed";
  return OPEN_STATES.includes(a.state);
}

/** Committed = money that may have left or may still leave. Attacks are never committed. */
export function isCommitted(a: Pick<AttemptLike, "kind" | "state" | "resolution">): boolean {
  if (a.kind !== "payout") return false;
  if (a.state === "refused" || a.state === "rejected" || a.state === "dropped") return false;
  if (a.state === "failed" && (a.resolution === "reowe" || a.resolution === "rejected")) return false;
  return true;
}

/** Counted as paid: platform settlement or the separately labelled representative's `arrived` resolution. */
export function isPaid(a: Pick<AttemptLike, "kind" | "state" | "resolution">): boolean {
  return a.kind === "payout" && (a.state === "paid" || (a.state === "failed" && a.resolution === "arrived"));
}

/** Sum the lines of attempts that pass `pick`, per deliverable. Lines are keyed by request_id. */
export function sumLines(attempts: AttemptLike[], lines: { request_id: string; deliverable_id: string; amount_atomic: string }[], pick: (a: AttemptLike) => boolean): Map<string, bigint> {
  const chosen = new Set(attempts.filter(pick).map((a) => a.request_id));
  const out = new Map<string, bigint>();
  for (const l of lines) if (chosen.has(l.request_id)) out.set(l.deliverable_id, (out.get(l.deliverable_id) ?? 0n) + BigInt(l.amount_atomic));
  return out;
}

/** Target for a deliverable at a completion level: value × completion (levels are quarters, so exact). */
export function targetFor(valueUsd: string, completion: number): bigint {
  return (toAtomic(valueUsd, USDC_DECIMALS) * BigInt(Math.round(completion * 100))) / 100n;
}

/** Owed per deliverable = max(0, value × completion − committed), in scope order. */
export function owedFor(terms: Pick<Terms, "scope">, completion: Record<string, number>, committed: Map<string, bigint>): Line[] {
  const out: Line[] = [];
  for (const d of terms.scope) {
    const owed = targetFor(d.value_usd, completion[d.id] ?? 0) - (committed.get(d.id) ?? 0n);
    if (owed > 0n) out.push({ deliverable_id: d.id, amount: owed });
  }
  return out;
}

/**
 * The next payout for a judgment: amount = min(total owed, largest deliverable), lines filled in scope order
 * (the last one may be partial). Null when nothing is owed.
 */
export function planPayout(terms: Pick<Terms, "scope">, completion: Record<string, number>, committed: Map<string, bigint>, invoiceRemaining?: bigint): { amount: bigint; lines: Line[] } | null {
  const owed = owedFor(terms, completion, committed);
  const owedTotal = owed.reduce((n, l) => n + l.amount, 0n);
  const total = invoiceRemaining === undefined ? owedTotal : minBig(owedTotal, invoiceRemaining);
  if (total <= 0n) return null;
  const largest = terms.scope.reduce((m, d) => (toAtomic(d.value_usd, USDC_DECIMALS) > m ? toAtomic(d.value_usd, USDC_DECIMALS) : m), 0n);
  const amount = minBig(total, largest);
  const lines: Line[] = [];
  let left = amount;
  for (const l of owed) {
    if (left === 0n) break;
    const take = minBig(left, l.amount);
    lines.push({ deliverable_id: l.deliverable_id, amount: take });
    left -= take;
  }
  return { amount, lines };
}

// ------------------------------------------------------------------ platform answer → attempt state

export interface Transition {
  state: AttemptState;
  code: string | null;
  failKind: "refused" | "forbidden" | "session" | "blocked" | null;
  correlationId?: string | null;
  neverExecuted?: boolean;
  failureCode?: string | null;
  /** When the same id may be asked again (waiting/blocked). */
  retryAfterMs?: number;
  /** Covenant bug or operator problem: log loudly, never retry automatically. */
  alert?: string;
  /** `not_found`: the platform never recorded this id, so re-ask the same id. */
  reask?: boolean;
}

export const DEFAULT_RETRY_MS = 60_000;
/** A blocked attempt the platform never recorded: Covenant's preflight or a refusal before recording. */
export const neverRecorded = (a: Pick<AttemptLike, "state" | "code">) => a.state === "blocked" && a.code !== "request_conflict";
/** Recorded refusals that get one automatic attempt+1 after re-reading the overview. */
export const AUTO_RETRY_CODES = new Set(["reviewed_policy_changed", "policy_not_in_force"]);

/** A failed call (nothing recorded, or no answer). Never frees money, never allows a new id. */
export function fromFail(f: Fail, blockedRetryMs = DEFAULT_RETRY_MS): Transition {
  switch (f.kind) {
    case "refused":
      if (f.code === "request_conflict")
        return { state: "blocked", code: f.code, failKind: "blocked", alert: "request_conflict: the same requestId was sent with different terms. This is a Covenant bug; nothing is retried." };
      return { state: "blocked", code: f.code, failKind: "blocked", retryAfterMs: blockedRetryMs };
    case "unresolved":
    case "busy":
      return { state: "waiting", code: f.kind, failKind: null, retryAfterMs: DEFAULT_RETRY_MS };
    case "rate_limited":
      return { state: "waiting", code: "rate_limited", failKind: null, retryAfterMs: (f.retryAfterSeconds ?? 60) * 1000 };
    case "forbidden":
      return { state: "blocked", code: f.code ?? "forbidden", failKind: "forbidden", retryAfterMs: blockedRetryMs };
    case "session":
      return { state: "blocked", code: "credential", failKind: "session", alert: "The platform rejected Covenant's app credential (401). An operator must fix PLATFORM_CREDENTIAL.", retryAfterMs: blockedRetryMs };
    case "unavailable":
    case "unknown":
    case "provider":
      return { state: "unknown", code: f.kind, failKind: null };
  }
}

/** A recorded answer from requestPayout/payoutStatus. `failed` needs classifyFailed with the evidence. */
export function fromAnswer(a: PayoutAnswer): Transition {
  const correlationId = a.correlationId;
  switch (a.state) {
    case "succeeded":
      return { state: "paid", code: null, failKind: null, correlationId };
    case "failed":
      return { state: "failed", code: a.code, failKind: null, correlationId, neverExecuted: a.neverExecuted === true, failureCode: a.failureCode ?? null };
    case "held":
      return { state: "held", code: null, failKind: null, correlationId };
    case "processing":
      return { state: "processing", code: null, failKind: null, correlationId };
    case "refused":
      return { state: "refused", code: a.code ?? "policy_denied", failKind: "refused", correlationId };
    case "unknown":
      return { state: "unknown", code: null, failKind: null, correlationId };
    case "not_found":
      return { state: "unknown", code: "not_found", failKind: null, reask: true };
  }
}

/** A reject attempt is not its outcome. Only the platform's explicit non-execution proof frees the amount. */
export function classifyFailed(vote: "approve" | "reject" | null, txHash: string | null, neverExecuted = false): "rejected" | "failed" {
  return vote === "reject" && neverExecuted && !txHash ? "rejected" : "failed";
}

// ------------------------------------------------------------------ judgment lifecycle

export type JudgmentStep =
  | { kind: "wait" } // a live attempt holds the slot
  | { kind: "close"; outcome: "approved" | "rejected" }
  | { kind: "next_seq" } // the last seq is paid and more is owed
  | { kind: "reowe" } // a failed attempt was resolved reowe: attempt+1 on the same seq
  | { kind: "auto_retry" } // reviewed_policy_changed / policy_not_in_force: one automatic attempt+1
  | { kind: "rep" }; // a recorded refusal: the representative picks Retry or Drop

export function latestAttempt<T extends AttemptLike>(attempts: T[]): T | null {
  let best: T | null = null;
  for (const a of attempts) if (!best || a.seq > best.seq || (a.seq === best.seq && a.attempt > best.attempt)) best = a;
  return best;
}

/** What to do next for the open judgment, given its payout attempts and what is still owed under it. */
export function judgmentStep(attempts: AttemptLike[], owed: bigint): JudgmentStep {
  const mine = attempts.filter((a) => a.kind === "payout");
  if (mine.some(isOpen)) return { kind: "wait" };
  if (mine.some((a) => a.state === "rejected" || (a.state === "failed" && a.resolution === "rejected"))) return { kind: "close", outcome: "rejected" };
  const last = latestAttempt(mine);
  if (!last) return owed > 0n ? { kind: "next_seq" } : { kind: "close", outcome: "approved" };
  if (last.state === "refused") return AUTO_RETRY_CODES.has(last.code ?? "") && !last.auto_retry ? { kind: "auto_retry" } : { kind: "rep" };
  if (last.state === "failed" && last.resolution === "reowe") return { kind: "reowe" };
  if (owed > 0n) return { kind: "next_seq" };
  return mine.filter(isCommitted).every(isPaid) ? { kind: "close", outcome: "approved" } : { kind: "wait" };
}

// ------------------------------------------------------------------ per-contract mutex

/** One in-process async lock per key: the timer, a run and a vote never race on one contract. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
