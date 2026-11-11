/** Interactive combined app. Only the verified local launcher supplies this simulated gateway. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { startServer, startTimers } from "../src/server/index";
import { readStack } from "../src/server/platform/stack";

const stackDir = process.env.PLATFORM_STACK_DIR;
if (!stackDir) throw new Error("Run bun run demo:full to start a fresh isolated platform and market.");
const stack = readStack(stackDir);
const local = (url: string) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
if (!local(stack.url) || !local(stack.rpcUrl) || !stack.marketUrl || !local(stack.marketUrl))
  throw new Error("The combined demo only supports the isolated loopback gateway, chain and market simulator.");
const dir = mkdtempSync(join(process.env.COVENANT_DEMO_ARTIFACTS ?? tmpdir(), "covenant-full-app-"));
const port = process.env.FULL_DEMO_PORT ?? "3002";
const rt = await createRuntime(loadConfig({ PLATFORM: "remote", PLATFORM_STACK_DIR: stackDir, PLATFORM_DEPLOYMENT: stack.deployment,
  PORT: port, PUBLIC_URL: `http://127.0.0.1:${port}`, DB_PATH: join(dir, "state", "covenant.sqlite"), GITHUB: "fake", JUDGE: "rules" }));
if (!rt.market) throw new Error("The isolated gateway has no market simulator.");
const server = await startServer(rt, rt.config.port, "127.0.0.1");
const stopTimers = startTimers(rt);
const receipt = { simulated: true, source: resolve(import.meta.dir, ".."), url: server.url.origin, stack: stack.stateFile,
  scope: "Interactive builder work orders and separate instant marketplace hires; fixture signatures/provider/chain/market/funds", database: join(dir, "state", "covenant.sqlite"),
  limits: ["Pinned simulator lacks rejection non-execution proof for builder rework", "Market directory and worker loop unavailable on this pin", "No actual wallet or real payment evidence"] };
writeFileSync(join(dir, "receipt.json"), JSON.stringify(receipt, null, 2));
console.log(`\nCovenant · COMBINED LOCAL EXPERIENCE · SIMULATED funds and wallets\nSource: ${receipt.source}\nOpen: ${server.url.origin}/#/new\nContracts + Agent market are in the same app.\nArtifacts: ${dir}\nCtrl+C stops this app. The launcher stops its own gateway; an explicitly supplied gateway remains caller-owned.\n`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  stopTimers();
  server.stop(true);
  process.exit(0);
});
