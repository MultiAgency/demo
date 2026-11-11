import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MarketControls } from "../market/port";
import type { DemoControls } from "./port";

/**
 * The MultiAgency platform's isolated local stack (`pnpm test:e2e:stack --app covenant ...` in the platform checkout).
 * Its `state.json` names the dashboard host, the app credential file, the stack's own TLS certificate and its simulated
 * chain. Its controls are files in a directory, never HTTP routes. Dev only: config refuses a stack dir in production.
 */
export interface StackInfo {
  url: string;
  credential: string;
  caPem: string;
  rpcUrl: string;
  owner: string;
  payees: string[];
  /** The stack's app deployment, its not-agreed account and its control directory. */
  deployment: string;
  builder: string | null;
  controlsDir: string;
  stateFile: string;
  /** With `--market`: the simulated agent market's URL. */
  marketUrl: string | null;
  /** With `--dao-treasury`: the simulated DAO that owns agents. */
  dao: string | null;
}

interface StackState {
  dashboard: string;
  ownerAccount: string;
  payees: string[];
  builder: string | null;
  chain: { rpc: string };
  app: { deployment: string; base: string; credentialFile: string } | null;
  controls: { directory: string };
  market: { url: string; agents: string[] } | null;
  dao: { account: string } | null;
  transfers: { agent: string; correlation: string; approval: string; status: string; recipient: string; amount: string }[];
}

const readState = (dir: string): StackState => JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as StackState;

/** `dir` is the stack directory holding `state.json` (printed as "Isolated stack ready: <dir>/state.json"). */
export function readStack(dir: string): StackInfo {
  const stateFile = join(dir, "state.json");
  if (!existsSync(stateFile)) throw new Error(`No platform stack at ${dir}: state.json is missing (is the stack running?)`);
  const s = readState(dir);
  if (!s.app) throw new Error("The platform stack was started without --app <deployment>: it issued no app credential");
  return {
    url: s.app.base ?? s.dashboard,
    credential: readFileSync(s.app.credentialFile, "utf8").trim(),
    caPem: readFileSync(join(dir, "environment", "localhost.crt"), "utf8"),
    rpcUrl: s.chain.rpc,
    owner: s.ownerAccount,
    payees: s.payees,
    deployment: s.app.deployment,
    builder: s.builder ?? null,
    controlsDir: s.controls.directory,
    stateFile,
    marketUrl: s.market?.url ?? null,
    dao: s.dao?.account ?? null,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The stack's file controls as `DemoControls`: simulated funding of a created agent and settlement of an approved payout.
 * Lost replies, outages and failures after approval are injected on the fake only (the stack can't drop a withdrawal's
 * reply).
 */
export class StackControls implements DemoControls, MarketControls {
  private seq = 0;
  constructor(private readonly dir: string) {}

  /** Writes `<name>.json` and waits for the stack to answer in `<name>.result.json`. */
  async command(command: string, args: Record<string, unknown>, timeoutMs = 20_000): Promise<unknown> {
    const { controls } = readState(this.dir);
    const name = `covenant-${process.pid}-${Date.now()}-${++this.seq}`;
    const file = join(controls.directory, `${name}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify({ command, ...args }));
    renameSync(`${file}.tmp`, file);
    const result = join(controls.directory, `${name}.result.json`);
    for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(100)) {
      if (!existsSync(result)) continue;
      const answer = JSON.parse(readFileSync(result, "utf8")) as { ok: boolean; value?: unknown; error?: string };
      unlinkSync(result);
      if (!answer.ok) throw new Error(`Stack control ${command} failed: ${answer.error}`);
      return answer.value;
    }
    throw new Error(`Stack control ${command} got no answer in ${timeoutMs} ms (is the stack running?)`);
  }

  async fund(agentId: string, atomic: string): Promise<void> {
    await this.command("fund", { agent: agentId, amount: atomic });
  }
  async settle(correlationId: string): Promise<void> {
    await this.command("settle", { correlation: correlationId });
  }
  /** The owner's one-time USDC registration of a market agent's payment key (`--market`). */
  async marketRegister(account: string): Promise<void> {
    await this.command("marketRegister", { account });
  }
  /** The market's chain moves on, so an unused hire payment expires (`--market`; default 1300 blocks). */
  async marketAdvance(blocks?: number): Promise<void> {
    await this.command("marketAdvance", blocks === undefined ? {} : { blocks });
  }
  /** The simulated DAO passes the proposal that signs `hash` (`--dao-treasury`). */
  async daoVote(hash: string): Promise<void> {
    await this.command("daoVote", { hash });
  }
  /** Every transfer and withdrawal the simulated provider accepted, as `state.json` lists them (refreshed every 250 ms). */
  async transfers(): Promise<{ recipient: string; amount: string; status: string }[]> {
    await sleep(300);
    return readState(this.dir).transfers.map(({ recipient, amount, status }) => ({ recipient, amount, status }));
  }
}
