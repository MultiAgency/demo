// Exact decimal <-> atomic conversion. No floating point anywhere money is involved.

const DECIMAL = /^\d+(\.\d+)?$/;

export function isDecimal(value: string): boolean {
  return DECIMAL.test(value);
}

/** "12.5" with 6 decimals -> 12500000n. Throws on more precision than the asset supports. */
export function toAtomic(value: string, decimals: number): bigint {
  if (!isDecimal(value)) throw new Error(`Not a decimal amount: ${value}`);
  const [whole = "0", frac = ""] = value.split(".");
  if (frac.length > decimals) {
    if (/[^0]/.test(frac.slice(decimals))) throw new Error(`${value} has more than ${decimals} decimals`);
  }
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

/** 12500000n with 6 decimals -> "12.5". */
export function fromAtomic(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Canonical decimal string: no trailing zeros, no leading zeros. "050.10" -> "50.1". */
export function normalizeDecimal(value: string): string {
  if (!isDecimal(value)) return value;
  const [whole = "0", frac = ""] = value.split(".");
  const w = whole.replace(/^0+(?=\d)/, "");
  const f = frac.replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Format a USD decimal for display: "40" -> "$40.00". */
export function usd(value: string): string {
  const atomic = toAtomic(normalizeDecimal(value), 6);
  const cents = (atomic + 5000n) / 10000n;
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, "0");
  return `$${whole.toLocaleString("en-US")}.${frac}`;
}
