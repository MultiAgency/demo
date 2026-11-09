import { describe, expect, test } from "bun:test";
import { clauseFor } from "../src/shared/clauses";
import { DEMO_TERMS } from "../src/shared/demo";
import { parseTerms } from "../src/shared/terms";

// Demo scope: d1 $300, d2 $200, d3 $500 → largest $500, total $1,000.
const terms = parseTerms({ ...DEMO_TERMS, start: "2026-11-01", end: "2026-11-30" });
const before = new Date("2026-11-15T12:00:00Z");
const after = new Date("2026-12-01T00:00:00Z");
const refused = (code: string | null, now = before) => clauseFor({ kind: "refused", code }, terms, now);
const forbidden = (code: string | null, now: Date) => clauseFor({ kind: "forbidden", code }, terms, now);

describe("clauseFor (#3: only clauses the code identifies)", () => {
  test("payee codes", () => {
    expect(refused("payee_not_agreed")?.id).toBe("payee");
    expect(refused("recipient_not_found")?.id).toBe("payee");
    expect(refused("payee_not_agreed")?.text).toContain(terms.payee.address);
  });

  test("per-transaction cap names the largest deliverable", () => {
    const c = refused("per_transaction_exceeded");
    expect(c?.id).toBe("cap");
    expect(c?.text).toBe("No payment above $500.00, the largest deliverable.");
  });

  test("spend budget is the budget clause, not the cap", () => {
    const c = refused("spend_budget_exceeded");
    expect(c?.id).toBe("budget");
    expect(c?.text).toContain("sized from the $1,000.00 scope");
  });

  test("withdraw-only codes", () => {
    expect(refused("withdraw_not_allowed")?.id).toBe("withdraw-only");
    expect(refused("asset_not_allowed")?.id).toBe("withdraw-only");
  });

  test("#4: insufficient balance credits the funded total", () => {
    const c = refused("insufficient_balance");
    expect(c?.id).toBe("funding");
    expect(c?.text).toBe("Funded with exactly the $1,000.00 scope; it can't pay what it doesn't hold.");
  });

  test("frozen is termination", () => {
    expect(refused("frozen")?.id).toBe("termination");
  });

  test("held is the approval clause", () => {
    expect(clauseFor({ kind: "held", code: null }, terms, before)?.id).toBe("approval");
  });

  test("setup codes", () => {
    for (const code of ["grant_missing", "grant_purpose_denied", "policy_not_in_force", "recipient_not_registered", "credential"]) expect(refused(code)?.id).toBe("setup");
    expect(clauseFor({ kind: "blocked", code: "recipient_not_registered" }, terms, before)?.id).toBe("setup");
    expect(clauseFor({ kind: "session", code: null }, terms, before)?.id).toBe("setup");
  });

  test("platform rules are never contract clauses", () => {
    for (const code of ["duplicate_held_payout", "reviewed_policy_changed", "request_conflict"]) {
      const c = refused(code);
      expect(c?.id).toBe("platform");
      expect(c?.text.startsWith("Platform rule:")).toBe(true);
    }
  });

  test("bare policy_denied and unknown codes name no clause", () => {
    expect(refused("policy_denied")).toBeNull();
    expect(refused("something_new")).toBeNull();
    expect(refused(null)).toBeNull();
    expect(clauseFor({ kind: "blocked", code: "recipient_unchecked" }, terms, before)).toBeNull();
  });

  test("forbidden at or after the end is the term; before the end it's setup", () => {
    for (const code of ["scope", "no_consent", "access_ended"]) {
      expect(forbidden(code, after)?.id).toBe("term");
      expect(forbidden(code, before)?.id).toBe("setup");
    }
    expect(forbidden("scope", new Date("2026-11-30T23:59:59Z"))?.id).toBe("term");
    expect(forbidden("consent_revoked", after)?.id).toBe("setup");
    expect(forbidden(null, after)?.id).toBe("setup");
    // A forbidden answer recorded on a blocked attempt keeps its code.
    expect(clauseFor({ kind: "blocked", code: "scope" }, terms, after)?.id).toBe("term");
  });

  test("no clause text calls monthly a cap", () => {
    const codes = ["payee_not_agreed", "per_transaction_exceeded", "spend_budget_exceeded", "withdraw_not_allowed", "insufficient_balance", "frozen", "grant_missing", "duplicate_held_payout"];
    for (const code of codes) expect(refused(code)?.text.toLowerCase()).not.toContain("month");
  });
});
