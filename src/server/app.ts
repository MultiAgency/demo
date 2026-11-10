import { Hono } from "hono";
import { z } from "zod";
import { toAtomic } from "../shared/money";
import { scopeTotal, type Terms, USDC_DECIMALS } from "../shared/terms";
import type { ConfigView } from "../shared/views";
import { type Auth, createAuth, type SessionInfo, sessionFrom } from "./auth";
import type { Config } from "./config";
import { openDb } from "./db";
import { Covenant, type Role, type Scenario, SCENARIOS, toUserError, UserError } from "./engine";
import { type EvidenceSource, FakeEvidence, GitHubEvidence } from "./evidence/github";
import { NearAiJudge, RulesJudge } from "./judge";
import { makePlatform } from "./platform/index";
import type { PlatformKit } from "./platform/port";

/** Accounts the keyless demo signs for. Clearly fake names so nobody mistakes them for real accounts. */
export const DEMO_ACCOUNTS = { representative: "acme.demo", contractor: "maria.demo", attacker: "attacker.demo" } as const;

/** Covenant's clock. The platform stand-in reads the same clock (PlatformConfig.now), so moving it moves both. */
export class Clock {
  private offset = 0;
  constructor(start?: number, readonly movable = start !== undefined) {
    if (start !== undefined) this.offset = start - Date.now();
  }
  now = (): Date => new Date(Date.now() + this.offset);
  advance(ms: number): Date {
    this.offset += ms;
    return this.now();
  }
  set(d: Date): Date {
    this.offset = d.getTime() - Date.now();
    return this.now();
  }
}

export interface Runtime {
  app: Hono<{ Variables: { session: SessionInfo | null } }>;
  covenant: Covenant;
  auth: Auth;
  kit: PlatformKit;
  clock: Clock;
  config: Config;
  evidence: EvidenceSource;
}

export interface RuntimeOptions {
  /** Inject a platform (tests, demo scripts). Otherwise makePlatform(config). */
  kit?: PlatformKit;
  /** Start the clock here (fake platform only; makes it movable through /api/sim/advance). */
  clockStart?: number;
  attacker?: string;
  log?: (msg: string) => void;
}

export async function createRuntime(config: Config, opts: RuntimeOptions = {}): Promise<Runtime> {
  const db = openDb(config.dbPath);
  const clock = new Clock(opts.clockStart ?? (config.platform === "fake" ? Date.now() : undefined));
  const kit =
    opts.kit ??
    makePlatform({
      mode: config.platform,
      deployment: config.deployment,
      url: config.platformUrl ?? undefined,
      credential: config.credential ?? undefined,
      caPem: config.caPem ?? undefined,
      rpcUrl: config.rpcUrl ?? undefined,
      stackDir: config.stackDir ?? undefined,
      now: clock.now,
    });
  const auth = await createAuth({
    db,
    secret: config.auth.secret ?? crypto.randomUUID() + crypto.randomUUID(),
    baseURL: config.auth.publicUrl,
    recipient: config.auth.recipient,
    trustedOrigins: [config.auth.publicUrl],
  });
  const evidence = config.evidence === "fake" ? new FakeEvidence(clock.now) : new GitHubEvidence(config.githubToken ?? undefined);
  const covenant = new Covenant({
    db,
    platform: kit.platform,
    chain: kit.chain,
    evidence,
    judge: config.judge.kind === "near-ai" && config.judge.apiKey ? new NearAiJudge(config.judge.apiKey, config.judge.model, config.judge.baseUrl) : new RulesJudge(),
    config,
    now: clock.now,
    attacker: opts.attacker ?? DEMO_ACCOUNTS.attacker,
    log: opts.log,
  });
  const rt = { covenant, auth, kit, clock, config, evidence };
  return { ...rt, app: buildApp(rt) };
}

const signedBody = z.object({ account_id: z.string(), public_key: z.string(), signature: z.string(), nonce: z.string() });
const walletSig = z
  .object({ publicKey: z.string().optional(), public_key: z.string().optional(), signature: z.string() })
  .transform((b, ctx) => {
    const publicKey = b.publicKey ?? b.public_key;
    if (!publicKey) ctx.addIssue({ code: "custom", message: "publicKey is required" });
    return { publicKey: publicKey ?? "", signature: b.signature };
  });

export function buildApp(rt: Omit<Runtime, "app">): Hono<{ Variables: { session: SessionInfo | null } }> {
  const { covenant, auth, kit, clock, config, evidence } = rt;
  const app = new Hono<{ Variables: { session: SessionInfo | null } }>().basePath("/api");

  app.onError((err, c) => {
    const e = err instanceof z.ZodError ? new UserError(err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")) : toUserError(err);
    return c.json({ error: e.message }, e.status as 400);
  });

  app.on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw));
  app.use("*", async (c, next) => {
    c.set("session", c.req.path.startsWith("/api/auth/") ? null : await sessionFrom(auth, c.req.raw.headers));
    await next();
  });

  const requireAccount = (session: SessionInfo | null, account: string, role: string) => {
    if (!config.auth.required) return;
    if (!session) throw new UserError(`Sign in with NEAR as ${account} to act as the ${role}.`, 401);
    if (session.accountId !== account) throw new UserError(`You're signed in as ${session.accountId}. Only ${account} can act as the ${role}.`, 403);
  };
  const asRepresentative = (session: SessionInfo | null, contractId: string) => requireAccount(session, covenant.parties(contractId).representative, "representative");

  app.get("/config", (c) => {
    const view: ConfigView = {
      platform: kit.platform.mode,
      stack: !!config.stackDir,
      host: kit.platform.host,
      demo_controls: !!kit.controls,
      demo_accounts: kit.controls ? DEMO_ACCOUNTS : null,
      now: clock.now().toISOString(),
      judge: { kind: config.judge.kind, model: config.judge.kind === "near-ai" ? config.judge.model : null },
      auth: { required: config.auth.required, recipient: config.auth.recipient, network: "mainnet" },
    };
    return c.json(view);
  });

  app.get("/me", (c) => c.json({ session: c.get("session") }));

  app.get("/contracts", (c) => {
    const s = c.get("session");
    return c.json(covenant.listContracts(config.auth.required ? (s?.accountId ?? "\u0000") : undefined));
  });

  app.post("/contracts", async (c) => {
    const body = await c.req.json();
    requireAccount(c.get("session"), String(body?.representative?.near_account ?? "").toLowerCase(), "representative");
    const { id, contractorToken } = covenant.createContract(body);
    return c.json({ id, contractor_link: `/#/c/${id}/sign?t=${contractorToken}`, contractor_token: contractorToken }, 201);
  });

  app.get("/contracts/:id", async (c) => {
    const id = c.req.param("id");
    // Only the representative's reads move payouts along; anyone else gets the view (the status timer still follows up).
    let representative = true;
    try {
      asRepresentative(c.get("session"), id);
    } catch {
      representative = false;
    }
    return c.json(representative ? await covenant.getContract(id) : await covenant.viewContract(id));
  });

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
    return c.json(await covenant.addSignature(id, role, signedBody.parse(body.signed), body.contractor_token));
  });

  // ---------- onboarding (setup → create → consents → grant → policy) and owner steps
  app.post("/contracts/:id/onboarding/next", async (c) => {
    const id = c.req.param("id");
    asRepresentative(c.get("session"), id);
    return c.json(await covenant.next(id));
  });
  app.post("/contracts/:id/onboarding/signed", async (c) => {
    const id = c.req.param("id");
    asRepresentative(c.get("session"), id);
    const body = z.object({ step: z.enum(["setup", "consent_payout", "consent_owner"]), nonce: z.string(), publicKey: z.string(), signature: z.string() }).parse(await c.req.json());
    return c.json(await covenant.signed(id, body));
  });
  // The wallet signature is the authority here; the platform checks it against the owner key.
  app.post("/owner-steps/:cid/submit", async (c) => c.json(await covenant.submitOwnerStep(c.req.param("cid"), walletSig.parse(await c.req.json()))));
  app.get("/owner-steps/:cid", async (c) => c.json(await covenant.getOwnerStep(c.req.param("cid"))));

  app.post("/contracts/:id/deposit", async (c) => {
    const id = c.req.param("id");
    asRepresentative(c.get("session"), id);
    return c.json(await covenant.deposit(id));
  });

  // ---------- payouts
  app.post("/contracts/:id/run", async (c) => {
    const id = c.req.param("id");
    asRepresentative(c.get("session"), id);
    return c.json(await covenant.run(id));
  });
  app.post("/contracts/:id/retry", async (c) => {
    const id = c.req.param("id");
    asRepresentative(c.get("session"), id);
    return c.json(await covenant.retry(id));
  });
  app.post("/contracts/:id/drop", async (c) => {
    const id = c.req.param("id");
    asRepresentative(c.get("session"), id);
    return c.json(await covenant.drop(id));
  });
  app.post("/payouts/:rid/vote", async (c) => {
    const rid = c.req.param("rid");
    asRepresentative(c.get("session"), covenant.payoutContract(rid));
    const body = z.object({ verdict: z.enum(["approve", "reject"]) }).parse(await c.req.json());
    return c.json(await covenant.vote(rid, body.verdict));
  });
  app.post("/payouts/:rid/resolve", async (c) => {
    const rid = c.req.param("rid");
    asRepresentative(c.get("session"), covenant.payoutContract(rid));
    const body = z.object({ outcome: z.enum(["arrived", "reowe", "rejected"]) }).parse(await c.req.json());
    return c.json(await covenant.resolve(rid, body.outcome));
  });

  // Public: anyone with the link can verify a contract.
  app.get("/contracts/:id/verify", async (c) => c.json(await covenant.verify(c.req.param("id"))));

  app.post("/contracts/:id/attacks/:scenario", async (c) => {
    const id = c.req.param("id");
    asRepresentative(c.get("session"), id);
    const scenario = c.req.param("scenario") as Scenario;
    if (!SCENARIOS.includes(scenario)) throw new UserError("Unknown scenario", 404);
    return c.json(await covenant.attack(id, scenario));
  });

  // ---------- demo controls (platform stand-in; local stack when PLATFORM_STACK_DIR)
  const controls = kit.controls;
  if (controls) {
    app.post("/sim/sign", async (c) => {
      const body = z.object({ account_id: z.string(), message: z.string(), nonce: z.string(), recipient: z.string() }).parse(await c.req.json());
      if (!kit.devSigner) throw new UserError("No demo signer.");
      const s = await kit.devSigner.sign413({ message: body.message, recipient: body.recipient, nonce: body.nonce });
      return c.json({ account_id: body.account_id, publicKey: s.publicKey, public_key: s.publicKey, signature: s.signature, nonce: body.nonce, simulated: true });
    });
    app.post("/sim/fund", async (c) => {
      const body = z.object({ contract_id: z.string().optional(), agent_id: z.string().optional(), usd: z.string().optional() }).parse(await c.req.json());
      let agentId = body.agent_id;
      let usd = body.usd;
      if (body.contract_id) {
        const v = await covenant.getContract(body.contract_id);
        agentId ??= v.platform.agent_id ?? undefined;
        usd ??= scopeTotal(v.terms as Terms);
      }
      if (!agentId || !usd) throw new UserError("Give contract_id, or agent_id and usd.");
      await controls.fund(agentId, toAtomic(usd, USDC_DECIMALS).toString());
      return c.json({ agent_id: agentId, funded_usd: usd });
    });
    app.post("/sim/settle", async (c) => {
      const body = z.object({ contract_id: z.string().optional(), request_id: z.string().optional(), correlation_id: z.string().optional() }).parse(await c.req.json());
      let cids: string[] = [];
      if (body.correlation_id) cids = [body.correlation_id];
      else if (body.request_id) cids = [covenant.attempt(body.request_id).correlation_id ?? ""].filter(Boolean);
      else if (body.contract_id) cids = (await covenant.getContract(body.contract_id)).payouts.filter((p) => p.state === "processing").map((p) => covenant.attempt(p.request_id).correlation_id ?? "").filter(Boolean);
      if (!cids.length) throw new UserError("Nothing approved is waiting to settle.");
      for (const cid of cids) await controls.settle(cid);
      return c.json({ settled: cids });
    });
    app.post("/sim/merge", async (c) => {
      if (!(evidence instanceof FakeEvidence)) throw new UserError("Only available with the demo evidence source.");
      const body = z.object({ contract_id: z.string() }).parse(await c.req.json());
      return c.json({ merged: evidence.mergeNext((await covenant.getContract(body.contract_id)).terms) });
    });
    app.post("/sim/advance", async (c) => {
      if (kit.platform.mode !== "fake" || !clock.movable) throw new UserError("The clock only moves with the platform stand-in.");
      const body = z.object({ ms: z.number().int().positive().optional(), to: z.string().datetime().optional() }).parse(await c.req.json());
      const now = body.to ? clock.set(new Date(body.to)) : clock.advance(body.ms ?? 60_000);
      return c.json({ now: now.toISOString() });
    });
    app.post("/sim/confirm", async (c) => {
      const body = z.object({ url: z.string() }).parse(await c.req.json());
      if (!controls.completeConfirm) throw new UserError("This platform can't complete confirm links headlessly.");
      await controls.completeConfirm(body.url);
      return c.json({ confirmed: true });
    });
  }

  return app;
}
