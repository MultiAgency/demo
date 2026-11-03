import { Hono } from "hono";
import { z } from "zod";
import { DEMO_TIMELOCK_MS } from "../shared/compile";
import { toAtomic } from "../shared/money";
import { USDC_DECIMALS } from "../shared/terms";
import { type Auth, createAuth, type SessionInfo, sessionFrom } from "./auth";
import type { Config } from "./config";
import { SecretBox } from "./crypto";
import { openDb } from "./db";
import { Covenant, type Role, type Scenario, toUserError, UserError } from "./engine";
import { type EvidenceSource, FakeEvidence, GitHubEvidence } from "./evidence/github";
import { DevWallet, nonceFromString } from "./nep413";
import { SimKeyRegistry, SimProvider } from "./provider/sim";
import { NearAiJudge, RulesJudge } from "./judge";

/** Accounts the keyless demo can sign for. Clearly fake names so nobody mistakes them for real accounts. */
export const DEMO_ACCOUNTS = {
  representative: "acme.demo",
  contractor: "maria.demo",
} as const;

export interface Runtime {
  app: Hono<{ Variables: { session: SessionInfo | null } }>;
  covenant: Covenant;
  auth: Auth;
  sim: SimProvider | null;
  wallet: DevWallet | null;
  config: Config;
  evidence: EvidenceSource;
}

export async function createRuntime(config: Config, opts: { clockStart?: number } = {}): Promise<Runtime> {
  if (config.provider !== "sim") throw new Error("Only PROVIDER=sim is available until the live adapter lands.");
  const db = openDb(config.dbPath);
  const keys = new SimKeyRegistry();
  const wallet = new DevWallet();
  for (const account of Object.values(DEMO_ACCOUNTS)) keys.register(account, wallet.addAccount(account));
  const sim = new SimProvider(keys, opts.clockStart);
  const auth = await createAuth({
    db,
    secret: config.auth.secret ?? crypto.randomUUID() + crypto.randomUUID(),
    baseURL: config.auth.publicUrl,
    recipient: config.auth.recipient,
    trustedOrigins: [config.auth.publicUrl],
  });
  const evidence = config.evidence === "fake" ? new FakeEvidence(() => sim.now()) : new GitHubEvidence(config.githubToken ?? undefined);
  const covenant = new Covenant({
    db,
    provider: sim,
    keys,
    evidence,
    judge: config.judge.kind === "near-ai" && config.judge.apiKey ? new NearAiJudge(config.judge.apiKey, config.judge.model, config.judge.baseUrl) : new RulesJudge(),
    box: config.secretKey ? await SecretBox.fromHex(config.secretKey) : await SecretBox.random(),
    config,
  });
  return { app: buildApp({ covenant, auth, sim, wallet, config, evidence }), covenant, auth, sim, wallet, config, evidence };
}

const signedBody = z.object({ account_id: z.string(), public_key: z.string(), signature: z.string(), nonce: z.string() });
const intentBody = z.object({ type: z.enum(["agent_create", "grant_issue", "execution_cancel", "agent_freeze"]), payout_id: z.string().optional() });

export function buildApp(rt: Omit<Runtime, "app">): Hono<{ Variables: { session: SessionInfo | null } }> {
  const { covenant, auth, sim, wallet, config, evidence } = rt;
  const app = new Hono<{ Variables: { session: SessionInfo | null } }>().basePath("/api");

  app.onError((err, c) => {
    const e = toUserError(err);
    return c.json({ error: e.message }, e.status as 400);
  });

  // Sign in with NEAR: Better-Auth + better-near-auth (SIWN), as in everything.dev apps.
  app.on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw));

  // Resolve the session once per request.
  app.use("*", async (c, next) => {
    c.set("session", c.req.path.startsWith("/api/auth/") ? null : await sessionFrom(auth, c.req.raw.headers));
    await next();
  });

  /** When auth is required, the signed-in NEAR account must be `account`. */
  const requireAccount = (session: SessionInfo | null, account: string, role: string) => {
    if (!config.auth.required) return;
    if (!session) throw new UserError(`Sign in with NEAR as ${account} to act as the ${role}.`, 401);
    if (session.accountId !== account) throw new UserError(`You're signed in as ${session.accountId}. Only ${account} can act as the ${role}.`, 403);
  };
  const asRepresentative = (session: SessionInfo | null, contractId: string) =>
    requireAccount(session, covenant.parties(contractId).representative, "representative");

  app.get("/config", (c) =>
    c.json({
      provider: config.provider,
      timelock_ms: config.timelockMs,
      evidence: config.evidence,
      demo_wallet: !!wallet,
      demo_accounts: wallet ? DEMO_ACCOUNTS : null,
      now: sim?.now().toISOString() ?? new Date().toISOString(),
      demo_timelock: config.timelockMs === DEMO_TIMELOCK_MS,
      judge: { kind: config.judge.kind, model: config.judge.kind === "near-ai" ? config.judge.model : null },
      auth: { required: config.auth.required, recipient: config.auth.recipient, network: "mainnet" },
    }),
  );

  app.get("/me", (c) => c.json({ session: c.get("session") }));

  app.get("/contracts", (c) => {
    const s = c.get("session");
    return c.json(covenant.listContracts(config.auth.required ? (s?.accountId ?? "\u0000") : undefined));
  });

  app.post("/contracts", async (c) => {
    const body = await c.req.json();
    const rep = String(body?.representative?.near_account ?? "").toLowerCase();
    requireAccount(c.get("session"), rep, "representative");
    const { id, contractorToken } = covenant.createContract(body);
    return c.json({ id, contractor_link: `/#/c/${id}/sign?t=${contractorToken}`, contractor_token: contractorToken }, 201);
  });

  app.get("/contracts/:id", async (c) => c.json(await covenant.getContract(c.req.param("id"))));

  app.get("/contracts/:id/signing-request", (c) => {
    const role = c.req.query("role") as Role;
    if (role !== "representative" && role !== "contractor") throw new UserError("role must be representative or contractor");
    return c.json(covenant.signingRequest(c.req.param("id"), role));
  });

  app.post("/contracts/:id/signatures", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const role = body.role as Role;
    if (role !== "representative" && role !== "contractor") throw new UserError("role must be representative or contractor");
    requireAccount(c.get("session"), covenant.parties(id)[role], role);
    const signed = signedBody.parse(body.signed);
    return c.json(await covenant.addSignature(id, role, signed, body.contractor_token));
  });

  app.post("/contracts/:id/intents", async (c) => {
    const id = c.req.param("id");
    asRepresentative(c.get("session"), id);
    const body = intentBody.parse(await c.req.json());
    return c.json(await covenant.prepareIntent(id, body.type, body.payout_id));
  });

  // The wallet signature is the authority here; the provider checks it against the owner key.
  app.post("/intents/:cid/submit", async (c) => {
    const body = z.object({ public_key: z.string(), signature: z.string() }).parse(await c.req.json());
    return c.json(await covenant.submitIntent(c.req.param("cid"), body));
  });

  app.post("/contracts/:id/run", async (c) => {
    const id = c.req.param("id");
    asRepresentative(c.get("session"), id);
    return c.json(await covenant.run(id));
  });
  app.post("/payouts/:pid/approve", async (c) => {
    asRepresentative(c.get("session"), covenant.payoutContract(c.req.param("pid")));
    return c.json(await covenant.resolveEscalation(c.req.param("pid"), true));
  });
  app.post("/payouts/:pid/reject", async (c) => {
    asRepresentative(c.get("session"), covenant.payoutContract(c.req.param("pid")));
    return c.json(await covenant.resolveEscalation(c.req.param("pid"), false));
  });

  // Public: anyone with the link can verify a contract wallet.
  app.get("/contracts/:id/verify", async (c) => c.json(await covenant.verify(c.req.param("id"))));

  app.post("/contracts/:id/attacks/:scenario", async (c) => {
    const id = c.req.param("id");
    asRepresentative(c.get("session"), id);
    const scenario = c.req.param("scenario") as Scenario;
    if (!["overpay", "redirect", "after_end", "injected"].includes(scenario)) throw new UserError("Unknown scenario", 404);
    const mode = c.req.query("mode") === "live" ? "live" : "dry";
    return c.json(await covenant.attack(id, scenario, mode));
  });

  // ---------- simulator-only helpers (keyless demo) ----------
  if (sim && wallet) {
    app.post("/sim/sign", async (c) => {
      const body = z.object({ account_id: z.string(), message: z.string(), nonce: z.string(), recipient: z.string() }).parse(await c.req.json());
      const signed = wallet.sign(body.account_id, { message: body.message, nonce: nonceFromString(body.nonce), recipient: body.recipient });
      return c.json({ ...signed, nonce: body.nonce, simulated: true });
    });
    app.post("/sim/fund", async (c) => {
      const body = z.object({ agent_id: z.string(), usd: z.string() }).parse(await c.req.json());
      return c.json(sim.fund(body.agent_id, toAtomic(body.usd, USDC_DECIMALS)));
    });
    // Simulate the contractor's next PR being merged on GitHub (demo evidence only).
    app.post("/sim/merge", async (c) => {
      if (!(evidence instanceof FakeEvidence)) throw new UserError("Only available with the demo evidence source.");
      const body = z.object({ contract_id: z.string() }).parse(await c.req.json());
      const pr = evidence.mergeNext((await covenant.getContract(body.contract_id)).terms);
      return c.json({ merged: pr });
    });
    app.post("/sim/advance", async (c) => {
      const body = z.object({ ms: z.number().int().positive().optional(), to: z.string().datetime().optional() }).parse(await c.req.json());
      const now = body.to ? sim.setNow(new Date(body.to)) : sim.advance(body.ms ?? config.timelockMs + 1000);
      return c.json({ now: now.toISOString() });
    });
  }

  return app;
}
