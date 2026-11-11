import { readFileSync } from "node:fs";

export interface Config {
  platform: "fake" | "remote";
  port: number;
  dbPath: string;
  /** MultiAgency platform (PLATFORM=remote). */
  platformUrl: string | null;
  deployment: string;
  /** App credential (`tap_…`). Server memory only: never in /api/config, events, logs or URLs. */
  credential: string | null;
  caPem: string | null;
  /** Dev/test only: a local platform stack's directory (state.json). Refused in production. */
  stackDir: string | null;
  rpcUrl: string | null;
  consentGraceDays: number;
  statusPollMs: number;
  evidence: "fake" | "github";
  githubToken: string | null;
  /** The agent's judge. NEAR AI Cloud when NEARAI_API_KEY is set, otherwise rule-based. */
  judge: { kind: "rules" | "near-ai"; apiKey: string | null; model: string; baseUrl: string };
  /** Check for new merges on a timer (ms). 0 = only when "Run agent" is pressed. */
  pollMs: number;
  /** Sign in with NEAR (Better-Auth + better-near-auth). */
  auth: { secret: string | null; publicUrl: string; recipient: string; required: boolean };
  /**
   * The agent market (src/server/market). `url` is the market's HTTP API (the local stack's own market overrides it).
   * The worker's token and webhook secret are server secrets: never in /api/config, events, logs or URLs.
   */
  market: { url: string | null; worker: { token: string; secret: string; agencyId: string } | null };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const platform = (env.PLATFORM ?? "fake") as Config["platform"];
  if (platform !== "fake" && platform !== "remote") throw new Error(`PLATFORM must be fake or remote, got ${platform}`);
  const stackDir = env.PLATFORM_STACK_DIR || null;
  if (stackDir && env.NODE_ENV === "production") throw new Error("PLATFORM_STACK_DIR is for local testing only and is refused when NODE_ENV=production.");
  if (stackDir && platform !== "remote") throw new Error("PLATFORM_STACK_DIR needs PLATFORM=remote.");
  const production = platform === "remote" && !stackDir;

  let credential = env.PLATFORM_CREDENTIAL || null;
  if (env.PLATFORM_CREDENTIAL_FILE) credential = readFileSync(env.PLATFORM_CREDENTIAL_FILE, "utf8").trim();
  const caPem = env.PLATFORM_CA_FILE ? readFileSync(env.PLATFORM_CA_FILE, "utf8") : null;

  const cfg: Config = {
    platform,
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH || (production ? "data/covenant.sqlite" : ":memory:"),
    platformUrl: env.PLATFORM_URL || null,
    deployment: env.PLATFORM_DEPLOYMENT || "covenant",
    credential,
    caPem,
    stackDir,
    rpcUrl: env.NEAR_RPC_URL || null,
    consentGraceDays: env.CONSENT_GRACE_DAYS ? Number(env.CONSENT_GRACE_DAYS) : 30,
    statusPollMs: env.STATUS_POLL_MS ? Number(env.STATUS_POLL_MS) : 60_000,
    evidence: (env.GITHUB ?? (production ? "github" : "fake")) as Config["evidence"],
    githubToken: env.GITHUB_TOKEN || null,
    judge: {
      kind: env.JUDGE === "rules" || !env.NEARAI_API_KEY ? "rules" : "near-ai",
      apiKey: env.NEARAI_API_KEY || null,
      model: env.NEARAI_MODEL || "z-ai/glm-5.3-flash",
      baseUrl: env.NEARAI_BASE_URL || "https://cloud-api.near.ai/v1",
    },
    pollMs: env.AGENT_POLL_MS ? Number(env.AGENT_POLL_MS) : 0,
    auth: {
      secret: env.BETTER_AUTH_SECRET || null,
      publicUrl: env.PUBLIC_URL || `http://localhost:${env.PORT ?? 3000}`,
      recipient: env.SIWN_RECIPIENT || "multiagentic.near",
      required: production || env.REQUIRE_AUTH === "true",
    },
    market: { url: env.MARKET_URL || null, worker: null },
  };

  const workerVars = [env.MARKET_AGENT_TOKEN, env.MARKET_WEBHOOK_SECRET, env.MARKET_WORKER_AGENCY];
  if (workerVars.some(Boolean)) {
    if (!workerVars.every(Boolean)) throw new Error("The market worker needs MARKET_AGENT_TOKEN, MARKET_WEBHOOK_SECRET and MARKET_WORKER_AGENCY together.");
    if (!env.MARKET_AGENT_TOKEN!.startsWith("aat_")) throw new Error("MARKET_AGENT_TOKEN must be the agent's aat_ token.");
    cfg.market.worker = { token: env.MARKET_AGENT_TOKEN!, secret: env.MARKET_WEBHOOK_SECRET!, agencyId: env.MARKET_WORKER_AGENCY! };
  }

  if (production) {
    if (!cfg.platformUrl) throw new Error("PLATFORM=remote needs PLATFORM_URL.");
    if (!cfg.credential) throw new Error("PLATFORM=remote needs PLATFORM_CREDENTIAL_FILE (preferred) or PLATFORM_CREDENTIAL.");
    if (cfg.dbPath === ":memory:") throw new Error("PLATFORM=remote needs a DB_PATH on disk.");
    if (!cfg.auth.secret) throw new Error("PLATFORM=remote needs BETTER_AUTH_SECRET (openssl rand -base64 32).");
  }
  if (cfg.evidence !== "fake" && cfg.evidence !== "github") throw new Error("GITHUB must be fake or github");
  if (!Number.isFinite(cfg.consentGraceDays) || cfg.consentGraceDays < 0) throw new Error("CONSENT_GRACE_DAYS must be a number of days");
  if (!Number.isFinite(cfg.statusPollMs) || cfg.statusPollMs <= 0) throw new Error("STATUS_POLL_MS must be a positive number of ms");
  return cfg;
}
