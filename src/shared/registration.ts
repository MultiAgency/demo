/** Read-only NEP-145 quote. No server-side transaction or funds authority. */
export interface RegistrationQuote {
  account: string;
  token: string;
  registered: boolean;
  deposit_yocto: string;
  gas: string;
  gas_estimate_yocto: string;
  expires_at: string;
}
export const REGISTRATION_GAS = "30000000000000";
export function nearAmount(yocto: string): string {
  const value = BigInt(yocto);
  return `${value / 10n ** 24n}.${(value % 10n ** 24n).toString().padStart(24, "0")}`.replace(/\.?0+$/, "") || "0";
}
