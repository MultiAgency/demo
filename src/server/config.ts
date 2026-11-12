import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DEFAULT_REVIEW_MODEL, NEAR_AI_BASE_URL, type ReviewServiceConfig } from "./review/types";

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
  judge: { kind: "rules" | "near-ai"; apiKey: string | null; model: string; baseUrl: string; assessmentTimeoutMs: number };
  /** Opt-in review service. Its credential is separate from the compensation judge and never sent to the browser. */
  review: ReviewServiceConfig | null;
  /** Check for new merges on a timer (ms). 0 = only when "Run agent" is pressed. */
  pollMs: number;
  /** Sign in with NEAR (Better-Auth + better-near-auth). */
  auth: { secret: string | null; publicUrl: string; enforcePublicHost: boolean; recipient: string; required: boolean };
  /**
   * The agent market (src/server/market). `url` is the market's HTTP API (the local stack's own market overrides it).
   * The worker's token and webhook secret are server secrets: never in /api/config, events, logs or URLs.
   */
  market: { url: string | null; boardToken: string | null; worker: { token: string; secret: string; agencyId: string } | null };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  if (env.PAPERWORK_JOBS_PUBLIC_URL)
    throw new Error("Remove PAPERWORK_JOBS_PUBLIC_URL; use PUBLIC_URL for the single Paperwork app origin.");
  // A production image never falls back to the keyless stand-in (and its demo controls) because a variable is missing.
  if (env.NODE_ENV === "production" && !env.PLATFORM) throw new Error("Set PLATFORM (remote, or fake for the keyless stand-in) when NODE_ENV=production.");
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
    // The default is a fresh Paperwork database; existing records require their original deployment binding.
    dbPath: env.DB_PATH || (production ? "data/paperwork.sqlite" : ":memory:"),
    platformUrl: env.PLATFORM_URL || null,
    deployment: env.PLATFORM_DEPLOYMENT || "multiagency-paperwork",
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
      assessmentTimeoutMs: Number(env.PAPERWORK_ASSESSMENT_TIMEOUT_MS ?? 30_000),
    },
    review: reviewService(env),
    pollMs: env.AGENT_POLL_MS ? Number(env.AGENT_POLL_MS) : 0,
    auth: {
      secret: env.BETTER_AUTH_SECRET || null,
      publicUrl: env.PUBLIC_URL || `http://localhost:${env.PORT ?? 3000}`,
      enforcePublicHost: !!env.PUBLIC_URL || production || env.NODE_ENV === "production",
      recipient: env.SIWN_RECIPIENT || "multiagentic.near",
      required: production || env.REQUIRE_AUTH === "true",
    },
    market: { url: env.MARKET_URL || null, boardToken: env.PAPERWORK_MARKET_BOARD_TOKEN || null, worker: null },
  };

  cfg.auth.publicUrl = publicOrigin(cfg.auth.publicUrl, "PUBLIC_URL");
  if (cfg.review) {
    const url = new URL(cfg.review.url);
    if (cfg.review.backend !== "near" && url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("PAPERWORK_HERMES_URL requires HTTPS except on loopback.");
    if (!Number.isSafeInteger(cfg.review.timeoutMs) || cfg.review.timeoutMs < 1000 || cfg.review.timeoutMs > 300_000)
      throw new Error("PAPERWORK_REVIEW_TIMEOUT_MS must be an integer between 1000 and 300000.");
    if (cfg.review.apiKey.length < 16 || cfg.review.apiKey.length > 4096 || /[\s\x00-\x1f\x7f]/.test(cfg.review.apiKey))
      throw new Error("The review API key must be a valid server credential of 16 to 4096 characters without whitespace.");
  }

  const workerVars = [env.MARKET_AGENT_TOKEN, env.MARKET_WEBHOOK_SECRET, env.MARKET_WORKER_AGENCY];
  if (cfg.market.boardToken && !cfg.market.boardToken.startsWith("aat_"))
    throw new Error("PAPERWORK_MARKET_BOARD_TOKEN must be a server-held aat_ agent token.");
  if (workerVars.some(Boolean)) {
    if (!workerVars.every(Boolean)) throw new Error("The market worker needs MARKET_AGENT_TOKEN, MARKET_WEBHOOK_SECRET and MARKET_WORKER_AGENCY together.");
    if (!env.MARKET_AGENT_TOKEN!.startsWith("aat_")) throw new Error("MARKET_AGENT_TOKEN must be the agent's aat_ token.");
    cfg.market.worker = { token: env.MARKET_AGENT_TOKEN!, secret: env.MARKET_WEBHOOK_SECRET!, agencyId: env.MARKET_WORKER_AGENCY! };
  }

  const mount = volumeProblem(env, cfg.dbPath);
  if (mount) throw new Error(mount);
  if (production) {
    if (!/^https:\/\//.test(cfg.auth.publicUrl)) throw new Error("PLATFORM=remote needs PUBLIC_URL, the app's https origin: sign-in and its cookies name it.");
    if (!cfg.platformUrl) throw new Error("PLATFORM=remote needs PLATFORM_URL.");
    if (!cfg.credential) throw new Error("PLATFORM=remote needs PLATFORM_CREDENTIAL_FILE (preferred) or PLATFORM_CREDENTIAL.");
    if (cfg.dbPath === ":memory:") throw new Error("PLATFORM=remote needs a DB_PATH on disk.");
    if (!cfg.auth.secret) throw new Error("PLATFORM=remote needs BETTER_AUTH_SECRET (openssl rand -base64 32).");
  }
  if (cfg.evidence !== "fake" && cfg.evidence !== "github") throw new Error("GITHUB must be fake or github");
  if (!Number.isSafeInteger(cfg.judge.assessmentTimeoutMs) || cfg.judge.assessmentTimeoutMs <= 0 || cfg.judge.assessmentTimeoutMs > 2_147_483_647)
    throw new Error("PAPERWORK_ASSESSMENT_TIMEOUT_MS must be a positive integer no greater than 2147483647.");
  if (!Number.isFinite(cfg.consentGraceDays) || cfg.consentGraceDays < 0) throw new Error("CONSENT_GRACE_DAYS must be a number of days");
  if (!Number.isFinite(cfg.statusPollMs) || cfg.statusPollMs <= 0) throw new Error("STATUS_POLL_MS must be a positive number of ms");
  return cfg;
}

/** An explicit backend wins during migration; missing or ambiguous settings never fall back silently. */
function reviewService(env: Record<string, string | undefined>): ReviewServiceConfig | null {
  const selected = env.PAPERWORK_REVIEW_BACKEND;
  if (selected && selected !== "near" && selected !== "hermes")
    throw new Error("PAPERWORK_REVIEW_BACKEND must be near or hermes.");
  const nearKey = env.PAPERWORK_REVIEW_NEARAI_API_KEY;
  const hermes = !!env.PAPERWORK_HERMES_URL || !!env.PAPERWORK_HERMES_API_KEY;
  if (!selected && nearKey && hermes)
    throw new Error("Select PAPERWORK_REVIEW_BACKEND when both NEAR and Hermes review settings are present.");
  if (selected === "near" || !selected && nearKey) {
    if (!nearKey) throw new Error("The near review backend requires PAPERWORK_REVIEW_NEARAI_API_KEY.");
    const model = env.PAPERWORK_REVIEW_MODEL || DEFAULT_REVIEW_MODEL;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/.test(model) || model.includes("://"))
      throw new Error("PAPERWORK_REVIEW_MODEL must be a canonical model ID.");
    return { backend: "near", url: NEAR_AI_BASE_URL, apiKey: nearKey, model, provider: "near",
      timeoutMs: Number(env.PAPERWORK_REVIEW_TIMEOUT_MS ?? 120_000) };
  }
  if (selected === "hermes" && nearKey)
    throw new Error("Remove PAPERWORK_REVIEW_NEARAI_API_KEY when selecting the Hermes backend.");
  if (!!env.PAPERWORK_HERMES_URL !== !!env.PAPERWORK_HERMES_API_KEY || selected === "hermes" && !hermes)
    throw new Error("Set PAPERWORK_HERMES_URL and PAPERWORK_HERMES_API_KEY together.");
  return env.PAPERWORK_HERMES_URL && env.PAPERWORK_HERMES_API_KEY ? {
    url: reviewEndpoint(env.PAPERWORK_HERMES_URL), apiKey: env.PAPERWORK_HERMES_API_KEY,
    model: env.PAPERWORK_HERMES_MODEL || env.NEARAI_MODEL || DEFAULT_REVIEW_MODEL,
    provider: env.PAPERWORK_HERMES_PROVIDER || "custom:near",
    timeoutMs: Number(env.PAPERWORK_REVIEW_TIMEOUT_MS ?? 90_000),
  } : null;
}

/** Only explicit origins become sign-in hosts; never accept paths, credentials or wildcard subdomains. */
function publicOrigin(value: string, variable: string): string {
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.hostname.includes("*"))
    throw new Error(`${variable} must be an http(s) origin without credentials, path, query or fragment.`);
  return url.origin;
}

/** Team gateways may expose a dedicated profile at /p/<profile>. */
function reviewEndpoint(value: string): string {
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.hostname.includes("*") ||
    (url.pathname !== "/" && !/^\/p\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/?$/.test(url.pathname)))
    throw new Error("PAPERWORK_HERMES_URL must be an http(s) origin, optionally /p/<profile>, without credentials, query or fragment.");
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")}`;
}

/**
 * Why the server mustn't start on this host's disk, or null. With `REQUIRED_MOUNT` set (on Railway, `/data`), the
 * database lives on the volume mounted there, and Railway names the mounted volume's path in
 * `RAILWAY_VOLUME_MOUNT_PATH`. Without that volume it would land on the container's own disk: a fresh database, lost on
 * the next deploy, with every saved requestId and vote with it. Railway's `requiredMountPath` can't be set from
 * `.railway/railway.ts` (as for Treasury's service), so the server checks.
 */
export function volumeProblem(env: Record<string, string | undefined>, dbPath = env.DB_PATH || "data/paperwork.sqlite"): string | null {
  const required = env.REQUIRED_MOUNT;
  if (!required) return null;
  if (!isAbsolute(required)) return `REQUIRED_MOUNT must be an absolute path, not ${required}`;
  const mounted = env.RAILWAY_VOLUME_MOUNT_PATH;
  const root = resolve(required);
  if (!mounted || !isAbsolute(mounted) || resolve(mounted) !== root) return `No volume is mounted at ${required}${mounted ? ` (Railway mounted one at ${mounted})` : ""}: attach the service's volume there before it starts.`;
  if (dbPath === ":memory:" || !resolve(dbPath).startsWith(`${root === "/" ? "" : root}/`)) return `DB_PATH must be on the volume at ${required}, not ${dbPath}.`;
  return null;
}
