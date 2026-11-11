import index from "../web/index.html";
import { loadConfig } from "./config";
import { createRuntime, type Runtime } from "./app";
import { UserError } from "./engine";

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

/** Timers: follow live payouts every STATUS_POLL_MS; optionally check for new merges every AGENT_POLL_MS. */
export function startTimers(rt: Runtime): () => void {
  const timers: ReturnType<typeof setInterval>[] = [];
  timers.push(setInterval(() => void rt.covenant.followUpAll(), rt.config.statusPollMs));
  if (rt.market) timers.push(setInterval(() => void rt.market!.tick(), rt.config.statusPollMs));
  if (rt.config.pollMs > 0) {
    timers.push(
      setInterval(async () => {
        for (const id of rt.covenant.activeContractIds()) {
          try {
            await rt.covenant.run(id);
          } catch (err) {
            // A 409 is an expected state (frozen, ended, nothing to do); only log real failures.
            if (err instanceof UserError && err.status === 409) continue;
            console.error(`merge watcher: ${id}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }, rt.config.pollMs),
    );
  }
  return () => timers.forEach(clearInterval);
}

if (import.meta.main) {
  const config = loadConfig();
  const rt = await createRuntime(config);
  const server = await startServer(rt, config.port);
  const banner =
    rt.kit.platform.mode === "fake"
      ? "PLATFORM STAND-IN (fake: no real funds, no network)"
      : config.stackDir
        ? `LOCAL PLATFORM STACK at ${rt.kit.platform.host}`
        : `MultiAgency platform at ${rt.kit.platform.host}`;
  console.log(`\nCovenant · ${banner}\n→ ${server.url}\n`);
  startTimers(rt);
  if (config.pollMs > 0) console.log(`Merge watcher on: every ${Math.round(config.pollMs / 1000)}s`);
}
