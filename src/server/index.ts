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
}
