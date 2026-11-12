/** Offline subprocess for the DAO job recipe. Observe original identities; never prepare a replacement. */
import { writeFileSync } from "node:fs";
import { createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { readStack } from "../src/server/platform/stack";

const [stackDir, database, job, request, ownerStep, output] = process.argv.slice(2);
if (!stackDir || !database || !job || !request || !ownerStep || !output) throw new Error("Missing isolated DAO resume inputs.");
const stack = readStack(stackDir);
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(stack.url).hostname)) throw new Error("Loopback stack required.");
const rt = await createRuntime(loadConfig({ PLATFORM: "remote", PLATFORM_STACK_DIR: stackDir, PLATFORM_DEPLOYMENT: stack.deployment, DB_PATH: database, GITHUB: "fake", JUDGE: "rules" }));
const c = rt.engine;
const before = await c.viewContract(job);
if (before.payouts.length !== 1 || before.payouts[0]?.request_id !== request || before.paid_usd !== "0") throw new Error("Original unpaid obligation was not retained.");
let processing = false;
for (const until = Date.now() + 30_000; Date.now() < until; await Bun.sleep(250)) {
  await c.getOwnerStep(ownerStep);
  const view = await c.getContract(job);
  if (view.payouts.length !== 1 || view.payouts[0]?.request_id !== request) throw new Error("Payment identity changed during recovery.");
  if (view.payouts[0].state === "processing") { processing = true; break; }
}
if (!processing) throw new Error("The original DAO approval was not recovered; nothing replaced it.");
await rt.kit.controls!.settle(c.attempt(request).correlation_id!);
let paid = false;
for (const until = Date.now() + 20_000; Date.now() < until; await Bun.sleep(250)) {
  const view = await c.getContract(job);
  if (view.payouts.length !== 1 || view.payouts[0]?.request_id !== request || view.hash !== before.hash) throw new Error("Original job identity changed.");
  if (view.payouts[0].state === "paid") { paid = true; break; }
}
if (!paid) throw new Error("Original payment did not settle.");
writeFileSync(output, JSON.stringify({ simulated: true, pid: process.pid, job, request, owner_step: ownerStep,
  terms_hash: before.hash, recovered_original_approval: true, new_payment_requests: 0, settled: true }, null, 2));
