/**
 * bun run demo:e2e
 *
 * The whole Covenant story, headless, on the platform stand-in: both parties sign a scope, the contract gets its
 * own platform agent (setup, create, two consents, grant, one policy edit), is funded with exactly the scope total,
 * and every merged PR is judged. Every payout is held by the platform until the representative approves it in the
 * wallet; a prompt-injected merge is rejected and excluded; attacks are refused or held. No keys, no network.
 */
import { createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { startServer } from "../src/server/index";
import type { PlatformKit } from "../src/server/platform/port";
import { StubPlatform } from "../tests/support/stub-platform";
import { runScenario } from "./scenario";
import type { ScenarioDriver } from "./scenario-driver";

const CLOCK_START = Date.parse("2026-11-20T12:00:00Z");

// Until track A's FakePlatform lands (M2), the stand-in is track B's StubPlatform.
let kit: PlatformKit;
let clockNow: () => Date = () => new Date();
const stub = new StubPlatform(() => clockNow());
kit = stub.kit();

const rt = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules" }), { clockStart: CLOCK_START, kit });
clockNow = rt.clock.now;
const server = await startServer(rt, 0);

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

console.log("Covenant · keyless end-to-end demo · PLATFORM STAND-IN (no real funds, no network)");
const failures = await runScenario(driver);
server.stop(true);
process.exit(failures.length ? 1 : 0);
