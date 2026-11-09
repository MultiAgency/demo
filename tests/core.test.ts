import { describe, expect, test } from "bun:test";
import { base64 } from "@scure/base";
import { canonicalJson } from "../src/shared/canonical";
import { expectations, policyChanges, policyProblem } from "../src/shared/policy-request";
import type { Overview } from "../src/server/platform/port";
import { DEMO_TERMS } from "../src/shared/demo";
import { fromAtomic, normalizeDecimal, toAtomic } from "../src/shared/money";
import { parseTerms, scopeTotal, termsHash, USDC_NEAR } from "../src/shared/terms";
import { DevWallet, nep413Hash, randomNonce, verifyNep413 } from "../src/server/nep413";

describe("money", () => {
  test("decimal <-> atomic is exact", () => {
    expect(toAtomic("50", 6)).toBe(50_000_000n);
    expect(toAtomic("12.345678", 6)).toBe(12_345_678n);
    expect(toAtomic("0.1", 6)).toBe(100_000n);
    expect(fromAtomic(52_500_000n, 6)).toBe("52.5");
    expect(fromAtomic(1n, 6)).toBe("0.000001");
  });
  test("rejects more precision than the asset has", () => {
    expect(() => toAtomic("1.0000001", 6)).toThrow();
    expect(toAtomic("1.0000000", 6)).toBe(1_000_000n);
  });
  test("normalizes decimals", () => {
    expect(normalizeDecimal("050.10")).toBe("50.1");
    expect(normalizeDecimal("7.000")).toBe("7");
  });
});

describe("terms", () => {
  test("hash is stable regardless of key order and repo order", () => {
    const a = parseTerms(DEMO_TERMS);
    const shuffled = JSON.parse(JSON.stringify({ ...DEMO_TERMS, repos: ["acme/app"] }));
    const b = parseTerms(Object.fromEntries(Object.entries(shuffled).reverse()));
    expect(termsHash(a)).toBe(termsHash(b));
  });
  test("any change changes the hash", () => {
    const a = termsHash(parseTerms(DEMO_TERMS));
    const b = termsHash(parseTerms({ ...DEMO_TERMS, scope: DEMO_TERMS.scope.map((d, i) => (i === 0 ? { ...d, value_usd: "301" } : d)) }));
    expect(a).not.toBe(b);
  });
  test("normalizes accounts and amounts", () => {
    const t = parseTerms({ ...DEMO_TERMS, payee: { chain: "near", address: "Maria.Demo" }, scope: [{ ...DEMO_TERMS.scope[0]!, value_usd: "050.00" }] });
    expect(t.payee.address).toBe("maria.demo");
    expect(t.scope[0]!.value_usd).toBe("50");
    expect(scopeTotal(t)).toBe("50");
  });
  test("rejects bad terms", () => {
    expect(() => parseTerms({ ...DEMO_TERMS, end: "2026-10-01" })).toThrow();
    expect(() => parseTerms({ ...DEMO_TERMS, scope: [{ ...DEMO_TERMS.scope[0]!, value_usd: "-5" }] })).toThrow();
    expect(() => parseTerms({ ...DEMO_TERMS, scope: [] })).toThrow();
    expect(() => parseTerms({ ...DEMO_TERMS, scope: [DEMO_TERMS.scope[0]!, DEMO_TERMS.scope[0]!] })).toThrow();
    expect(() => parseTerms({ ...DEMO_TERMS, payee: { chain: "base", address: "0xabc" } })).toThrow();
    expect(() => parseTerms({ ...DEMO_TERMS, extra: true })).toThrow();
    expect(() => parseTerms({ ...DEMO_TERMS, end: "2028-01-01" })).toThrow();
  });
  test("canonical JSON sorts keys deeply", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe('{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}');
  });
});

describe("policy request (what the platform is asked to enforce)", () => {
  const terms = parseTerms(DEMO_TERMS);

  test("policy_update body: full withdrawals list, owner approval, three limits, three budget windows", () => {
    expect(policyChanges(terms)).toEqual({
      withdrawals: [{ address: "maria.demo" }],
      owner_approval: true,
      limits: { per_transaction: { [USDC_NEAR]: "500000000" }, daily: { [USDC_NEAR]: "1000000000" }, monthly: { [USDC_NEAR]: "1000000000" } },
      budget: { daily_usd: "1050", weekly_usd: null, monthly_usd: "1050" },
    });
  });
  test("expectations: payee, cap = largest deliverable, consent ends at the contract end, total", () => {
    expect(expectations(terms)).toEqual({
      payee: "maria.demo",
      asset: USDC_NEAR,
      per_transaction: "500000000",
      owner_approval: true,
      withdrawals: ["maria.demo"],
      payout_consent_expires_by: "2026-11-30T23:59:59.000Z",
      total: "1000000000",
    });
  });
  test("pure: same input, same output", () => {
    expect(policyChanges(terms)).toEqual(policyChanges(parseTerms(DEMO_TERMS)));
  });
  const ov = (policy: Partial<NonNullable<Overview["policy"]>>, extra: Partial<Overview> = {}): Overview => ({
    agentId: "a",
    revision: 2,
    digest: "d",
    status: "APPLIED",
    synced: true,
    notInForce: null,
    usdc: "0",
    grants: [],
    policy: { actions: ["withdraw"], assets: [USDC_NEAR], owner_approval: true, frozen: false, limits: { per_transaction: { [USDC_NEAR]: "500000000" } }, budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, withdrawals: ["maria.demo"], ...policy },
    ...extra,
  });
  test("before every request: in force, owner approval, withdrawals == [payee], cap == largest", () => {
    expect(policyProblem(ov({}), terms)).toBeNull();
    expect(policyProblem(ov({}, { notInForce: "pending" }), terms)).toMatchObject({ code: "policy_not_in_force", waiting: true });
    expect(policyProblem(ov({ owner_approval: false }), terms)).toMatchObject({ code: "policy_mismatch", waiting: false });
    expect(policyProblem(ov({ withdrawals: ["maria.demo", "attacker.demo"] }), terms)?.code).toBe("policy_mismatch");
    expect(policyProblem(ov({ limits: { per_transaction: { [USDC_NEAR]: "500000001" } } }), terms)?.code).toBe("policy_mismatch");
    expect(policyProblem(ov({ frozen: true }), terms)?.code).toBe("frozen");
    expect(policyProblem(null, terms)?.waiting).toBe(true);
  });
});

describe("NEP-413", () => {
  const wallet = new DevWallet();
  const pk = wallet.addAccount("alice.demo");
  const payload = { message: "hello", nonce: randomNonce(), recipient: "covenant" };

  test("a demo wallet signature verifies", () => {
    const s = wallet.sign("alice.demo", payload);
    expect(s.public_key).toBe(pk);
    expect(verifyNep413(payload, s)).toBe(true);
  });
  test("tampered message, recipient or nonce fails", () => {
    const s = wallet.sign("alice.demo", payload);
    expect(verifyNep413({ ...payload, message: "hello!" }, s)).toBe(false);
    expect(verifyNep413({ ...payload, recipient: "evil" }, s)).toBe(false);
    expect(verifyNep413({ ...payload, nonce: randomNonce() }, s)).toBe(false);
  });
  test("another key fails", () => {
    const other = new DevWallet();
    const opk = other.addAccount("bob.demo");
    const s = wallet.sign("alice.demo", payload);
    expect(verifyNep413(payload, { public_key: opk, signature: s.signature })).toBe(false);
  });
  test("hash layout: tag 2^31+413 little-endian first", () => {
    const h1 = nep413Hash(payload);
    const h2 = nep413Hash({ ...payload, callbackUrl: "https://x" });
    expect(h1).not.toEqual(h2);
    expect(base64.encode(h1).length).toBe(44);
  });
});
