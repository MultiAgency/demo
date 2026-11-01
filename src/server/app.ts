import { Hono } from "hono";
import { z } from "zod";
import { DEMO_TIMELOCK_MS } from "../shared/compile";
import { toAtomic } from "../shared/money";
import { USDC_DECIMALS } from "../shared/terms";
import type { Config } from "./config";
import { SecretBox } from "./crypto";
import { openDb } from "./db";
import { Covenant, type Role, type Scenario, toUserError, UserError } from "./engine";
import { FakeEvidence, GitHubEvidence } from "./evidence/github";
import { DevWallet, nonceFromString } from "./nep413";
import { SimKeyRegistry, SimProvider } from "./provider/sim";
import { DeterministicScorer } from "./scorer";

/** Accounts the keyless demo can sign for. Clearly fake names so nobody mistakes them for real accounts. */
export const DEMO_ACCOUNTS = {
  representative: "acme.demo",
  contractor: "maria.demo",
} as const;

export interface Runtime {
  app: Hono;
  covenant: Covenant;
  sim: SimProvider | null;
  wallet: DevWallet | null;
  config: Config;
}

export async function createRuntime(config: Config, opts: { clockStart?: number } = {}): Promise<Runtime> {
  if (config.provider !== "sim") throw new Error("Only PROVIDER=sim is available until the live adapter lands.");
  const keys = new SimKeyRegistry();
  const wallet = new DevWallet();
  for (const account of Object.values(DEMO_ACCOUNTS)) keys.register(account, wallet.addAccount(account));
  const sim = new SimProvider(keys, opts.clockStart);
  const covenant = new Covenant({
    db: openDb(config.dbPath),
    provider: sim,
    keys,
    evidence: config.evidence === "fake" ? new FakeEvidence(() => sim.now()) : new GitHubEvidence(config.githubToken ?? undefined),
    scorer: new DeterministicScorer(),
    box: config.secretKey ? await SecretBox.fromHex(config.secretKey) : await SecretBox.random(),
    config,
  });
  return { app: buildApp({ covenant, sim, wallet, config }), covenant, sim, wallet, config };
}

const signedBody = z.object({ account_id: z.string(), public_key: z.string(), signature: z.string(), nonce: z.string() });
const intentBody = z.object({ type: z.enum(["agent_create", "grant_issue", "execution_cancel", "agent_freeze"]), payout_id: z.string().optional() });

export function buildApp(rt: Omit<Runtime, "app">): Hono {
  const { covenant, sim, wallet, config } = rt;
  const app = new Hono().basePath("/api");

  app.onError((err, c) => {
    const e = toUserError(err);
    return c.json({ error: e.message }, e.status as 400);
  });

  app.get("/config", (c) =>
    c.json({
      provider: config.provider,
      timelock_ms: config.timelockMs,
      evidence: config.evidence,
      demo_wallet: !!wallet,
      demo_accounts: wallet ? DEMO_ACCOUNTS : null,
      now: sim?.now().toISOString() ?? new Date().toISOString(),
      demo_timelock: config.timelockMs === DEMO_TIMELOCK_MS,
    }),
  );

  app.get("/contracts", (c) => c.json(covenant.listContracts()));

  app.post("/contracts", async (c) => {
    const { id, contractorToken } = covenant.createContract(await c.req.json());
    return c.json({ id, contractor_link: `/#/c/${id}/sign?t=${contractorToken}`, contractor_token: contractorToken }, 201);
  });

  app.get("/contracts/:id", async (c) => c.json(await covenant.getContract(c.req.param("id"))));

  app.get("/contracts/:id/signing-request", (c) => {
    const role = c.req.query("role") as Role;
    if (role !== "representative" && role !== "contractor") throw new UserError("role must be representative or contractor");
    return c.json(covenant.signingRequest(c.req.param("id"), role));
  });

  app.post("/contracts/:id/signatures", async (c) => {
    const body = await c.req.json();
    const role = body.role as Role;
    if (role !== "representative" && role !== "contractor") throw new UserError("role must be representative or contractor");
    const signed = signedBody.parse(body.signed);
    return c.json(await covenant.addSignature(c.req.param("id"), role, signed, body.contractor_token));
  });

  app.post("/contracts/:id/intents", async (c) => {
    const body = intentBody.parse(await c.req.json());
    return c.json(await covenant.prepareIntent(c.req.param("id"), body.type, body.payout_id));
  });

  app.post("/intents/:cid/submit", async (c) => {
    const body = z.object({ public_key: z.string(), signature: z.string() }).parse(await c.req.json());
    return c.json(await covenant.submitIntent(c.req.param("cid"), body));
  });

  app.post("/contracts/:id/run", async (c) => c.json(await covenant.run(c.req.param("id"))));
  app.post("/payouts/:pid/approve", async (c) => c.json(await covenant.resolveEscalation(c.req.param("pid"), true)));
  app.post("/payouts/:pid/reject", async (c) => c.json(await covenant.resolveEscalation(c.req.param("pid"), false)));
  app.get("/contracts/:id/verify", async (c) => c.json(await covenant.verify(c.req.param("id"))));

  app.post("/contracts/:id/attacks/:scenario", async (c) => {
    const scenario = c.req.param("scenario") as Scenario;
    if (!["overpay", "redirect", "after_end", "injected"].includes(scenario)) throw new UserError("Unknown scenario", 404);
    const mode = c.req.query("mode") === "live" ? "live" : "dry";
    return c.json(await covenant.attack(c.req.param("id"), scenario, mode));
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
    app.post("/sim/advance", async (c) => {
      const body = z.object({ ms: z.number().int().positive().optional(), to: z.string().datetime().optional() }).parse(await c.req.json());
      const now = body.to ? sim.setNow(new Date(body.to)) : sim.advance(body.ms ?? config.timelockMs + 1000);
      return c.json({ now: now.toISOString() });
    });
  }

  return app;
}
