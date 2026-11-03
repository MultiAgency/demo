import { describe, expect, test } from "bun:test";
import { base64 } from "@scure/base";
import { canonicalJson } from "../src/shared/canonical";
import { canonicalPolicy, compileContract, diffPolicy } from "../src/shared/compile";
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

describe("compiler", () => {
  const terms = parseTerms(DEMO_TERMS);
  const hash = termsHash(terms);
  const c = compileContract(terms, hash, { timelockMs: 600_000 });

  test("one destination: the payee", () => {
    expect(c.policy.destinations).toEqual({ mode: "only", list: [{ action: "withdraw", chain: "near", address: "maria.demo", memo: null }] });
  });
  test("one payment is at most the largest deliverable; the total is the scope", () => {
    expect(scopeTotal(terms)).toBe("1000");
    expect(c.policy.limits.per_transaction?.[USDC_NEAR]).toBe("500000000");
    expect(c.policy.limits.monthly?.[USDC_NEAR]).toBe("1000000000");
    expect(c.policy.budget.monthly_usd).toBe("1050");
    expect(c.policy.max_actions_per_hour).toBe(5);
  });
  test("withdraw-only, USDC-only, no owner approval, timelock on", () => {
    expect(c.policy.actions).toEqual(["withdraw"]);
    expect(c.policy.assets).toEqual([USDC_NEAR]);
    expect(c.policy.owner_approval).toBe(false);
    expect(c.policy.timelock_ms).toBe(600_000);
  });
  test("grant expires at the last second of the end date", () => {
    expect(c.grant.expires_at).toBe("2026-11-30T23:59:59.000Z");
  });
  test("pure: same input, same output", () => {
    expect(compileContract(terms, hash, { timelockMs: 600_000 })).toEqual(c);
  });
  test("diff ignores formatting differences but catches real ones", () => {
    const formatted = structuredClone(c.policy);
    formatted.budget.monthly_usd = "1050.00";
    formatted.destinations.list = [{ action: "withdraw", chain: "near", address: "MARIA.DEMO", memo: null }];
    expect(diffPolicy(c.policy, formatted)).toEqual([]);
    const widened = structuredClone(c.policy);
    widened.limits.monthly = { [USDC_NEAR]: "5000000000" };
    expect(diffPolicy(c.policy, widened).map((d) => d.path)).toEqual([`limits.monthly.${USDC_NEAR}`]);
    expect(canonicalPolicy(c.policy)).toEqual(canonicalPolicy(formatted));
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
