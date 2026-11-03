import index from "../web/index.html";
import { loadConfig } from "./config";
import { createRuntime, type Runtime } from "./app";

export async function startServer(rt: Runtime, port: number) {
  return Bun.serve({
    port,
    development: process.env.NODE_ENV !== "production" && !process.env.CI,
    routes: {
      "/": index,
      "/api/*": (req) => rt.app.fetch(req),
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });
}

if (import.meta.main) {
  const config = loadConfig();
  const rt = await createRuntime(config);
  const server = await startServer(rt, config.port);
  const banner = config.provider === "sim" ? "SIMULATED (no real funds, no network)" : "LIVE MAINNET";
  console.log(`\nCovenant · ${banner}\n→ ${server.url}\n`);
  // Pays when a PR is merged: check every active contract for new merges on a timer.
  if (config.pollMs > 0) {
    setInterval(async () => {
      for (const id of rt.covenant.activeContractIds()) {
        try {
          await rt.covenant.run(id);
        } catch (err) {
          console.error(`merge watcher: ${id}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }, config.pollMs);
    console.log(`Merge watcher on: every ${Math.round(config.pollMs / 1000)}s`);
  }
}
