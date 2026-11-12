import { describe, expect, test } from "bun:test";
import {
  type AttemptLike,
  attackIdFor,
  classifyFailed,
  fromAnswer,
  fromFail,
  isCommitted,
  isOpen,
  isPaid,
  judgmentStep,
  KeyedMutex,
  owedFor,
  planPayout,
  requestIdFor,
  sumLines,
} from "../src/server/payouts";
import type { PayoutAnswer } from "../src/server/platform/port";
import { DEMO_TERMS } from "../src/shared/demo";
import { parseTerms } from "../src/shared/terms";

const terms = parseTerms(DEMO_TERMS); // d1 $300, d2 $200, d3 $500
const M = (usd: number) => BigInt(usd) * 1_000_000n;
const ans = (state: PayoutAnswer["state"], code: string | null = null): PayoutAnswer => ({ requestId: "r", state, status: null, correlationId: "pay-1", code });
const att = (p: Partial<AttemptLike>): AttemptLike => ({ request_id: "r", kind: "payout", seq: 1, attempt: 1, state: "held", resolution: null, amount_atomic: "1", code: null, auto_retry: 0, ...p });

describe("request ids", () => {
  test("<hash16>-p<seq>-<attempt>", () => {
    expect(requestIdFor("c239cdbde22495e9a0550ffff", 2, 3)).toBe("c239cdbde22495e9-p2-3");
    expect(attackIdFor("redirect", "0123456789abcdef")).toBe("atk-redirect-0123456789");
  });
});

describe("planPayout: amount = min(owed, largest deliverable), lines in scope order", () => {
  test("owed $650 → $500 now: d1 300, d2 100, d3 100", () => {
    const plan = planPayout(terms, { d1: 1, d2: 0.5, d3: 0.5 }, new Map())!;
    expect(plan.amount).toBe(M(500));
    expect(plan.lines.map((l) => [l.deliverable_id, l.amount])).toEqual([["d1", M(300)], ["d2", M(100)], ["d3", M(100)]]);
  });
  test("d1+d3 = $800 with a $500 cap → $500, then $300 for the rest", () => {
    const first = planPayout(terms, { d1: 1, d3: 1 }, new Map())!;
    expect(first.amount).toBe(M(500));
    const committed = new Map(first.lines.map((l) => [l.deliverable_id, l.amount]));
    const second = planPayout(terms, { d1: 1, d3: 1 }, committed)!;
    expect(second.amount).toBe(M(300));
    expect(second.lines.map((l) => [l.deliverable_id, l.amount])).toEqual([["d3", M(300)]]);
    const all = new Map(committed);
    for (const l of second.lines) all.set(l.deliverable_id, (all.get(l.deliverable_id) ?? 0n) + l.amount);
    expect(planPayout(terms, { d1: 1, d3: 1 }, all)).toBeNull();
  });
  test("nothing owed → null; owed never negative", () => {
    expect(planPayout(terms, {}, new Map())).toBeNull();
    expect(owedFor(terms, { d1: 0.5 }, new Map([["d1", M(300)]]))).toEqual([]);
  });
});

describe("committed / open / paid", () => {
  test("committed excludes refused, rejected and failed resolved reowe/rejected; attacks never count", () => {
    expect(isCommitted(att({ state: "refused" }))).toBe(false);
    expect(isCommitted(att({ state: "rejected" }))).toBe(false);
    expect(isCommitted(att({ state: "failed", resolution: "reowe" }))).toBe(false);
    expect(isCommitted(att({ state: "failed", resolution: "rejected" }))).toBe(false);
    expect(isCommitted(att({ state: "failed", resolution: "arrived" }))).toBe(true);
    expect(isCommitted(att({ state: "failed" }))).toBe(true);
    for (const s of ["pending", "blocked", "waiting", "unknown", "held", "processing", "paid"] as const) expect(isCommitted(att({ state: s }))).toBe(true);
    expect(isCommitted(att({ kind: "attack", state: "held" }))).toBe(false);
  });
  test("an unresolved failed attempt holds the open slot; a resolved one doesn't", () => {
    expect(isOpen(att({ state: "failed" }))).toBe(true);
    expect(isOpen(att({ state: "failed", resolution: "arrived" }))).toBe(false);
    expect(isOpen(att({ state: "paid" }))).toBe(false);
    expect(isPaid(att({ state: "failed", resolution: "arrived" }))).toBe(true);
  });
  test("sumLines keys by request id", () => {
    const a = [att({ request_id: "a", state: "paid" }), att({ request_id: "b", state: "refused" })];
    const lines = [
      { request_id: "a", deliverable_id: "d1", amount_atomic: "5" },
      { request_id: "b", deliverable_id: "d1", amount_atomic: "7" },
    ];
    expect(sumLines(a, lines, isCommitted).get("d1")).toBe(5n);
  });
});

describe("platform answer → attempt state (one per answer)", () => {
  test("row written, no answer: pending is followed like unknown (status, not a new id)", () => {
    expect(isOpen(att({ state: "pending" })) && isCommitted(att({ state: "pending" }))).toBe(true);
  });
  for (const code of ["recipient_not_registered", "recipient_not_found", "recipient_unchecked", "chain_not_supported", "some_new_code"]) {
    test(`thrown refused ${code} → blocked with the code, same id later`, () => {
      const t = fromFail({ ok: false, kind: "refused", code });
      expect([t.state, t.code, t.reask ?? false]).toEqual(["blocked", code, false]);
      expect(t.retryAfterMs).toBeGreaterThan(0);
    });
  }
  test("thrown request_conflict → blocked, alert, never retried", () => {
    const t = fromFail({ ok: false, kind: "refused", code: "request_conflict" });
    expect(t.state).toBe("blocked");
    expect(t.alert).toContain("Paperwork bug");
    expect(t.retryAfterMs).toBeUndefined();
  });
  test("unresolved / busy → waiting 60 s; rate_limited honours retryAfterSeconds", () => {
    expect(fromFail({ ok: false, kind: "unresolved" })).toMatchObject({ state: "waiting", retryAfterMs: 60_000 });
    expect(fromFail({ ok: false, kind: "busy" })).toMatchObject({ state: "waiting", retryAfterMs: 60_000 });
    expect(fromFail({ ok: false, kind: "rate_limited", retryAfterSeconds: 7 })).toMatchObject({ state: "waiting", retryAfterMs: 7000 });
    expect(fromFail({ ok: false, kind: "rate_limited", retryAfterSeconds: null })).toMatchObject({ state: "waiting", retryAfterMs: 60_000 });
  });
  test("forbidden / session → blocked with the code; session is an operator alert", () => {
    expect(fromFail({ ok: false, kind: "forbidden", code: "scope" })).toMatchObject({ state: "blocked", code: "scope", failKind: "forbidden" });
    expect(fromFail({ ok: false, kind: "session" })).toMatchObject({ state: "blocked", code: "credential", failKind: "session" });
    expect(fromFail({ ok: false, kind: "session" }).alert).toBeDefined();
  });
  test("unavailable / unknown / provider → unknown (never frees money)", () => {
    for (const kind of ["unavailable", "unknown", "provider"] as const) {
      const t = fromFail({ ok: false, kind });
      expect(t.state).toBe("unknown");
      expect(isCommitted(att({ state: t.state }))).toBe(true);
    }
  });
  test("not_found from status → re-ask the same id", () => {
    expect(fromAnswer(ans("not_found")).reask).toBe(true);
  });
  test("recorded refused → refused (frees the amount)", () => {
    const t = fromAnswer(ans("refused", "insufficient_balance"));
    expect([t.state, t.code, t.failKind]).toEqual(["refused", "insufficient_balance", "refused"]);
    expect(isCommitted(att({ state: "refused" }))).toBe(false);
  });
  test("held / processing / succeeded", () => {
    expect(fromAnswer(ans("held"))).toMatchObject({ state: "held", correlationId: "pay-1" });
    expect(fromAnswer(ans("processing")).state).toBe("processing");
    expect(fromAnswer(ans("succeeded")).state).toBe("paid");
  });
  test("failed + our reject vote + explicit non-execution proof + no tx → rejected (freed)", () => {
    expect(classifyFailed("reject", null, true)).toBe("rejected");
  });
  test("any other failed → failed, committed until the representative resolves it", () => {
    expect(classifyFailed("approve", null)).toBe("failed");
    expect(classifyFailed(null, null)).toBe("failed");
    expect(classifyFailed("reject", "tx123")).toBe("failed");
    expect(classifyFailed("reject", null)).toBe("failed");
    expect(classifyFailed("reject", null, false)).toBe("failed");
    expect(classifyFailed("reject", "tx123", true)).toBe("failed");
    expect(classifyFailed("approve", null, true)).toBe("failed");
    expect(isCommitted(att({ state: "failed" }))).toBe(true);
  });
});

describe("judgment lifecycle", () => {
  test("a live attempt → wait", () => {
    expect(judgmentStep([att({ state: "held" })], M(1))).toEqual({ kind: "wait" });
    expect(judgmentStep([att({ state: "failed" })], 0n)).toEqual({ kind: "wait" });
  });
  test("paid and owed 0 → approved; paid and owed > 0 → next seq", () => {
    expect(judgmentStep([att({ state: "paid" })], 0n)).toEqual({ kind: "close", outcome: "approved" });
    expect(judgmentStep([att({ state: "paid" })], M(300))).toEqual({ kind: "next_seq" });
  });
  test("seq 1 paid + seq 2 rejected → rejected, never re-requested", () => {
    expect(judgmentStep([att({ state: "paid" }), att({ seq: 2, state: "rejected" })], M(150))).toEqual({ kind: "close", outcome: "rejected" });
  });
  test("refused → the rep chooses; reviewed_policy_changed → one automatic retry only", () => {
    expect(judgmentStep([att({ state: "refused", code: "insufficient_balance" })], M(1))).toEqual({ kind: "rep" });
    expect(judgmentStep([att({ state: "refused", code: "reviewed_policy_changed" })], M(1))).toEqual({ kind: "auto_retry" });
    expect(judgmentStep([att({ state: "refused", code: "reviewed_policy_changed", auto_retry: 1 })], M(1))).toEqual({ kind: "rep" });
  });
  test("failed resolved reowe → attempt+1; arrived counts as paid; rejected closes", () => {
    expect(judgmentStep([att({ state: "failed", resolution: "reowe" })], M(1))).toEqual({ kind: "reowe" });
    expect(judgmentStep([att({ state: "failed", resolution: "arrived" })], 0n)).toEqual({ kind: "close", outcome: "approved" });
    expect(judgmentStep([att({ state: "failed", resolution: "rejected" })], M(1))).toEqual({ kind: "close", outcome: "rejected" });
  });
});

describe("per-contract mutex", () => {
  test("runs one at a time per key, in order", async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    const slow = (tag: string, ms: number) => m.run("c", async () => {
      log.push(`start ${tag}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${tag}`);
    });
    await Promise.all([slow("a", 20), slow("b", 1), m.run("other", async () => void log.push("other"))]);
    expect(log.filter((l) => l !== "other")).toEqual(["start a", "end a", "start b", "end b"]);
  });
  test("a throwing holder releases the lock", async () => {
    const m = new KeyedMutex();
    await expect(m.run("c", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await m.run("c", async () => 1)).toBe(1);
  });
});
