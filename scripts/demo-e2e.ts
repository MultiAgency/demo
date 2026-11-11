/**
 * bun run demo:e2e
 *
 * The whole Paperwork story, headless, on the platform stand-in (FakePlatform): both parties sign a scope, the contract
 * gets its own platform agent (setup, create, two consents, grant, one policy edit), is funded with exactly the scope
 * total, and every merged PR is judged. Every payout is held by the platform until the representative approves it in
 * the wallet; a prompt-injected merge is rejected and excluded; attacks are refused or held. No keys, no network.
 */
import { createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { startServer } from "../src/server/index";
import { runScenario } from "./scenario";
import type { ScenarioDriver } from "./scenario-driver";

const CLOCK_START = Date.parse("2026-11-20T12:00:00Z");
const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules" }), { clockStart: CLOCK_START });
const server = await startServer(rt, 0);
const kit = rt.kit;

const driver: ScenarioDriver = {
  name: "fake",
  base: `${server.url}api`,
  signer: () => kit.devSigner!,
  controls: kit.controls!,
  termsWindow: { start: "2026-11-01", end: "2026-11-30" },
  payee: "maria.demo",
  rep: "acme.demo",
  attacker: "attacker.demo",
};

console.log("Paperwork · keyless end-to-end demo · PLATFORM STAND-IN (no real funds, no network)");
const failures = await runScenario(driver);
server.stop(true);
process.exit(failures.length ? 1 : 0);
