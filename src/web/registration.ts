import { REGISTRATION_GAS, type RegistrationQuote } from "../shared/registration";
import { USDC_NEAR } from "../shared/terms";

export function validateRegistration(q: RegistrationQuote, account: string, now = Date.now()) {
  if (q.account !== account || q.token !== USDC_NEAR.slice(7) || q.registered ||
      q.gas !== REGISTRATION_GAS || !/^[1-9]\d*$/.test(q.deposit_yocto) ||
      !/^[1-9]\d*$/.test(q.gas_estimate_yocto) || !Number.isFinite(Date.parse(q.expires_at)) || Date.parse(q.expires_at) <= now)
    throw new Error("Registration quote changed or expired. Check the cost again before approving.");
}

interface RegistrationSession { account: string | null; loading: boolean; version: number }
interface RegistrationDependencies {
  network: string;
  session(): RegistrationSession;
  connect(): Promise<boolean>;
  readAccount(): Promise<string | null>;
  wallet(): { account: string | null; network: string; connected: boolean };
  send(quote: RegistrationQuote): Promise<unknown>;
}
/** Single explicit wallet transaction; errors and unknown replies are never retried here. */
export class RegistrationWallet {
  private pending = false;
  constructor(private readonly d: RegistrationDependencies) {}
  async register(input: RegistrationQuote): Promise<void> {
    if (this.pending) throw new Error("A registration request is already open. Finish or cancel it first.");
    if (this.d.network !== "mainnet") throw new Error("This USDC registration is supported on mainnet only.");
    const quote = Object.freeze({ ...input });
    const initial = { ...this.d.session() };
    const check = () => {
      validateRegistration(quote, initial.account ?? "");
      const current = this.d.session();
      if (initial.loading || !initial.account || current.loading || current.account !== initial.account || current.version !== initial.version)
        throw new Error("Your sign-in changed. Review registration again.");
    };
    check();
    this.pending = true;
    try {
      if (!await this.d.connect()) throw new Error("Wallet connection cancelled.");
      check();
      if (await this.d.readAccount() !== initial.account) throw new Error("Your session changed. Sign in again.");
      check();
      const wallet = this.d.wallet();
      if (!wallet.connected || wallet.account !== initial.account || wallet.network !== this.d.network)
        throw new Error(`Connect the ${this.d.network} wallet for ${initial.account} before registering.`);
      await this.d.send(quote);
      // Only a fresh chain read can confirm registration, including after an interrupted reply.
    } finally { this.pending = false; }
  }
}
