import { DEMO_TIMELOCK_MS, PRODUCTION_TIMELOCK_MS } from "../shared/compile";
import { LIVE_PROVIDER_READY } from "./provider/live";

export interface Config {
  provider: "sim" | "live";
  port: number;
  dbPath: string;
  secretKey: string | null;
  allowWrites: boolean;
  evidence: "fake" | "github";
  githubToken: string | null;
  timelockMs: number;
  devWallet: boolean;
  agentApiKey: string | null;
  agentApiBaseUrl: string | null;
  /** Sign in with NEAR (Better-Auth + better-near-auth). */
  auth: {
    secret: string | null;
    publicUrl: string;
    /** NEP-413 recipient for sign-in. Defaults to the MultiAgency account, like its everything.dev apps. */
    recipient: string;
    /** When true, company actions need the representative signed in, and contractor actions the contractor. */
    required: boolean;
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const provider = (env.PROVIDER ?? "sim") as Config["provider"];
  if (provider !== "sim" && provider !== "live") throw new Error(`PROVIDER must be sim or live, got ${provider}`);
  const devWallet = provider === "sim";

  const cfg: Config = {
    provider,
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH || (provider === "sim" ? ":memory:" : "data/covenant.sqlite"),
    secretKey: env.SECRET_KEY || null,
    allowWrites: env.ALLOW_WRITES === "true",
    evidence: (env.GITHUB ?? (provider === "sim" ? "fake" : "github")) as Config["evidence"],
    githubToken: env.GITHUB_TOKEN || null,
    timelockMs: env.TIMELOCK_MS ? Number(env.TIMELOCK_MS) : provider === "sim" ? DEMO_TIMELOCK_MS : PRODUCTION_TIMELOCK_MS,
    devWallet,
    agentApiKey: env.NEAR_INTENTS_AGENT_API_KEY || env.AGENT_API_KEY || null,
    agentApiBaseUrl: env.AGENT_API_BASE_URL || null,
    auth: {
      secret: env.BETTER_AUTH_SECRET || null,
      publicUrl: env.PUBLIC_URL || `http://localhost:${env.PORT ?? 3000}`,
      recipient: env.SIWN_RECIPIENT || "multiagentic.near",
      required: provider === "live" || env.REQUIRE_AUTH === "true",
    },
  };

  if (cfg.provider === "live") {
    // Hard safety rules for real money.
    if (!LIVE_PROVIDER_READY) throw new Error("PROVIDER=live is not wired yet. It lands after spikes SP0-SP4 (docs/spikes.md).");
    if (cfg.devWallet) throw new Error("The demo wallet can never run with PROVIDER=live.");
    if (!cfg.secretKey) throw new Error("PROVIDER=live needs SECRET_KEY (32 bytes hex) to encrypt the grant credential.");
    if (!cfg.agentApiKey) throw new Error("PROVIDER=live needs NEAR_INTENTS_AGENT_API_KEY.");
    if (cfg.dbPath === ":memory:") throw new Error("PROVIDER=live needs a DB_PATH on disk.");
    if (!cfg.auth.secret) throw new Error("PROVIDER=live needs BETTER_AUTH_SECRET (openssl rand -base64 32).");
  }
  if (cfg.evidence !== "fake" && cfg.evidence !== "github") throw new Error("GITHUB must be fake or github");
  return cfg;
}
