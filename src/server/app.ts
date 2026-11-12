import { Hono } from "hono";
import { z } from "zod";
import { toAtomic } from "../shared/money";
import { scopeTotal, type Terms, USDC_DECIMALS } from "../shared/terms";
import type { ConfigView, ContractView } from "../shared/views";
import { type Auth, createAuth, type SessionInfo, sessionFrom } from "./auth";
import type { Config } from "./config";
import { bindAppDeployment, openDb } from "./db";
import { Engine, type Role, type Scenario, SCENARIOS, toUserError, UserError } from "./engine";
import { type EvidenceSource, FakeEvidence, GitHubEvidence } from "./evidence/github";
import { NearAiJudge, RulesJudge } from "./judge";
import { Market } from "./market/index";
import { MarketApi, MarketHttpError } from "./market/api";
import { MultiAgencyOpenings } from "./jobs/openings";
import { rpcDaoPolicy } from "./market/members";
import { marketRoutes } from "./market/routes";
import { makePlatform } from "./platform/index";
import { reviewRoutes } from "./review/routes";
import type { ReviewFetch } from "./review/hermes";
import type { NearReviewClientFactory } from "./review/near";
import type { PlatformKit } from "./platform/port";

/** Accounts the keyless demo signs for. Clearly fake names so nobody mistakes them for real accounts. */
export const DEMO_ACCOUNTS = { representative: "acme.demo", contractor: "maria.demo", attacker: "attacker.demo" } as const;

/** Paperwork's clock. The platform stand-in reads the same clock (PlatformConfig.now), so moving it moves both. */
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
  engine: Engine;
  auth: Auth;
  kit: PlatformKit;
  clock: Clock;
  config: Config;
  evidence: EvidenceSource;
  /** The agent market, when the platform offers it (remote, or a stack started with `--market`). */
  market: Market | null;
  /** Read-only public Market board, independent of SDK agency/worker setup. Never serialized. */
  boardApi: MarketApi | null;
  openings: MultiAgencyOpenings;
  /** Offline Hermes transport injection for focused integration checks. */
  reviewFetch?: ReviewFetch;
  /** Internal offline SDK injection; no browser/configuration path can replace verification. */
  reviewNearClient?: NearReviewClientFactory;
}

export interface RuntimeOptions {
  reviewFetch?: ReviewFetch;
  reviewNearClient?: NearReviewClientFactory;
  /** Offline transport injection for public-board checks; never falls back to a browser's Market session. */
  boardApi?: MarketApi | null;
  /** Public-source fixture injection; no existing app data or credentials are imported. */
  openings?: MultiAgencyOpenings;
  /** The browser demo uses its explicit settlement control; automated stand-ins keep their existing default. */
  manualFakeSettlement?: boolean;
  /** Inject a platform (tests, demo scripts). Otherwise makePlatform(config). */
  kit?: PlatformKit;
  /** Start the clock here (fake platform only; makes it movable through /api/sim/advance). */
  clockStart?: number;
  attacker?: string;
  log?: (msg: string) => void;
}

export async function createRuntime(config: Config, opts: RuntimeOptions = {}): Promise<Runtime> {
  const db = openDb(config.dbPath);
  try { bindAppDeployment(db, config.deployment); }
  catch (error) { db.close(); throw error; }
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
      marketUrl: config.market.url ?? undefined,
      now: clock.now,
      ...(opts.manualFakeSettlement && { autoSettle: "manual" as const }),
    });
  const auth = await createAuth({
    db,
    secret: config.auth.secret ?? crypto.randomUUID() + crypto.randomUUID(),
    baseURL: config.auth.publicUrl,
    recipient: config.auth.recipient,
    trustedOrigins: [config.auth.publicUrl],
  });
  const evidence = config.evidence === "fake" ? new FakeEvidence(clock.now) : new GitHubEvidence(config.githubToken ?? undefined);
  const engine = new Engine({
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
  const market = kit.market
    ? new Market({
        db,
        market: kit.market.platform,
        controls: kit.market.controls,
        chain: kit.chain,
        api: new MarketApi(kit.market.url, config.market.worker?.token ?? null),
        worker: config.market.worker,
        daoPolicy: rpcDaoPolicy(kit.market.rpcUrl),
        now: clock.now,
      })
    : null;
  const boardToken = config.market.boardToken ?? config.market.worker?.token;
  const boardApi = opts.boardApi !== undefined ? opts.boardApi
    : boardToken ? new MarketApi(kit.market?.url ?? config.market.url ?? "https://market.near.ai", boardToken) : null;
  const openings = opts.openings ?? new MultiAgencyOpenings();
  const rt = { engine, auth, kit, clock, config, evidence, market, boardApi, openings, reviewFetch: opts.reviewFetch, reviewNearClient: opts.reviewNearClient };
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
  const { engine, auth, kit, clock, config, evidence, market, boardApi, openings } = rt;
  const app = new Hono<{ Variables: { session: SessionInfo | null } }>().basePath("/api");

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.onError((err, c) => {
    const e = err instanceof z.ZodError ? new UserError(err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")) : toUserError(err);
    return c.json({ error: e.message }, e.status as 400);
  });

  // Railway's health check. The server answers only once its configuration was checked at startup (loadConfig).
  app.get("/health", (c) => c.json({ ok: true }));
  // APIs and sign-in accept only the explicitly configured app host.
  // Ignore forwarded host headers: they must never select an auth origin or another portal.
  app.use("*", async (c, next) => {
    if (config.auth.enforcePublicHost) {
      const host = new URL(c.req.url).host;
      if (new URL(config.auth.publicUrl).host !== host)
        return c.json({ error: "This host is not configured for Paperwork." }, 421);
      const origin = c.req.header("origin");
      if (origin && origin !== config.auth.publicUrl)
        return c.json({ error: "This origin is not configured for Paperwork." }, 403);
    }
    await next();
  });
  app.on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw));
  app.use("*", async (c, next) => {
    c.set("session", c.req.path.startsWith("/api/auth/") ? null : await sessionFrom(auth, c.req.raw.headers, c.req.raw));
    await next();
  });

  const requireAccount = (session: SessionInfo | null, account: string, role: string) => {
    if (!config.auth.required) return;
    if (!session) throw new UserError("Sign in with NEAR to access this action.", 401);
    if (session.accountId !== account) throw new UserError("This action is not available to this account.", 403);
  };
  const builderView = (view: ContractView): ContractView => ({ ...view, next_step: null, platform: { ...view.platform, deposit: null, consents: null } });
  const asRepresentative = (session: SessionInfo | null, contractId: string) => requireAccount(session, engine.parties(contractId).representative, "representative");
  const asParty = (session: SessionInfo | null, id: string) => {
    if (!config.auth.required) return;
    const parties = engine.parties(id);
    if (!session) throw new UserError("Sign in as a party to this job.", 401);
    if (session.accountId !== parties.representative && session.accountId !== parties.contractor) throw new UserError("Only the agency or builder can read the submission.", 403);
  };

  app.get("/config", (c) => {
    const view: ConfigView = {
      platform: kit.platform.mode,
      stack: !!config.stackDir,
      host: kit.platform.host,
      demo_controls: !!kit.controls,
      demo_accounts: kit.controls ? DEMO_ACCOUNTS : null,
      now: clock.now().toISOString(),
      judge: { kind: config.judge.kind, model: config.judge.kind === "near-ai" ? config.judge.model : null },
      review: { enabled: !!config.review },
      auth: { required: config.auth.required, recipient: config.auth.recipient, network: "mainnet" },
      market: { enabled: !!market, worker: !!market?.worker.configured, owner: kit.market?.owner ?? null, dao: kit.market?.dao ?? null },
    };
    return c.json(view);
  });

  app.get("/me", (c) => c.json({ session: c.get("session") }));

  app.get("/jobs/mine", (c) => {
    const session = c.get("session");
    if (config.auth.required && !session) throw new UserError("Sign in with NEAR to see your private jobs.", 401);
    // The keyless fallback uses its named builder. Production never accepts a caller-selected account.
    const account = session?.accountId ?? DEMO_ACCOUNTS.contractor;
    return c.json({ jobs: engine.jobsFor(account), demo: !config.auth.required });
  });

  app.get("/jobs/openings", async (c) => {
    c.header("cache-control", "no-store");
    try { return c.json(await openings.list()); }
    catch { throw new UserError("Published MultiAgency openings could not be read. Try again or check MultiAgency's listings directly.", 502); }
  });

  // This endpoint projects only the Market's common PUBLIC board, never /v1/jobs or private assignments.
  // Browsing grants no bid, award, hire, submission or payment authority.
  app.get("/market/jobs", async (c) => {
    const query = z.object({
      q: z.string().trim().max(200).optional(),
      kind: z.enum(["standard", "instant", "competition"]).optional(),
      sort: z.enum(["recent", "budget"]).default("recent"),
      offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 50).default(0),
    }).parse(c.req.query());
    if (!boardApi) throw new UserError("The open job board is not connected. Open NEAR AI Agent Market directly, or ask the operator to configure its server-side board connection.", 503);
    c.header("cache-control", "no-store");
    try { return c.json(await boardApi.openJobs(query)); }
    catch (error) {
      if (error instanceof MarketHttpError) throw new UserError(`Open jobs could not be read from the Market (${error.status || "connection failed"}). Try again or open NEAR AI Agent Market directly.`, 502);
      throw error;
    }
  });

  app.get("/contracts", (c) => {
    const s = c.get("session");
    if (c.req.query("role") === "agency") {
      if (config.auth.required && !s) return c.json([]);
      const account = s?.accountId ?? DEMO_ACCOUNTS.representative;
      return c.json(engine.listContracts(account).filter((job) => engine.parties(job.id).representative === account));
    }
    return c.json(engine.listContracts(config.auth.required ? (s?.accountId ?? "\u0000") : undefined));
  });

  app.post("/contracts", async (c) => {
    const body = await c.req.json();
    requireAccount(c.get("session"), String(body?.representative?.near_account ?? "").toLowerCase(), "representative");
    const { id, contractorToken } = engine.createContract(body);
    return c.json({ id, contractor_link: `/#/c/${id}/sign?t=${contractorToken}`, contractor_token: contractorToken }, 201);
  });

  app.get("/contracts/:id", async (c) => {
    const id = c.req.param("id");
    // Authorize private records before any platform read or reconciliation work.
    asParty(c.get("session"), id);
    // Only the representative's reads move payouts along; anyone else gets the view (the status timer still follows up).
    let representative = true;
    try {
      asRepresentative(c.get("session"), id);
    } catch {
      representative = false;
    }
    const view = representative ? await engine.getContract(id) : await engine.viewContract(id);
    c.header("Cache-Control", "no-store");
    return c.json(representative ? view : builderView(view));
  });

  app.get("/contracts/:id/signing-request", (c) => {
    const role = c.req.query("role") as Role;
    if (role !== "representative" && role !== "contractor") throw new UserError("role must be representative or contractor");
    const id = c.req.param("id");
    requireAccount(c.get("session"), engine.parties(id)[role], role);
    return c.json(engine.signingRequest(id, role));
  });

  app.post("/contracts/:id/signatures", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const role = body.role as Role;
    if (role !== "representative" && role !== "contractor") throw new UserError("role must be representative or contractor");
    requireAccount(c.get("session"), engine.parties(id)[role], role);
    const view = await engine.addSignature(id, role, signedBody.parse(body.signed), body.contractor_token);
    return c.json(config.auth.required && role === "contractor" && c.get("session")?.accountId !== engine.parties(id).representative ? builderView(view) : view);
  });

  // ---------- onboarding (setup → create → consents → grant → policy) and owner steps
  app.post("/contracts/:id/onboarding/next", async (c) => {
    const id = c.req.param("id");
    asRepresentative(c.get("session"), id);
    return c.json(await engine.next(id));
  });
  app.post("/contracts/:id/onboarding/signed", async (c) => {
    const id = c.req.param("id");
    asRepresentative(c.get("session"), id);
    const body = z.object({ step: z.enum(["setup", "consent_payout", "consent_owner"]), nonce: z.string(), publicKey: z.string(), signature: z.string() }).parse(await c.req.json());
    return c.json(await engine.signed(id, body));
  });
  // The platform checks the wallet signature against the owner key; Paperwork also requires the representative's session.
  app.post("/owner-steps/:cid/submit", async (c) => {
    const cid = c.req.param("cid");
    const contractId = engine.ownerStepContract(cid);
    if (contractId) asRepresentative(c.get("session"), contractId);
    else if (config.auth.required) throw new UserError("This owner step belongs to no job.", 403);
    return c.json(await engine.submitOwnerStep(cid, walletSig.parse(await c.req.json())));
  });
  app.get("/owner-steps/:cid", async (c) => {
    const cid = c.req.param("cid");
    const contractId = engine.ownerStepContract(cid);
    if (contractId) asRepresentative(c.get("session"), contractId);
    else if (config.auth.required) throw new UserError("This owner step belongs to no job.", 403);
    return c.json(await engine.getOwnerStep(cid));
  });

  app.post("/contracts/:id/deposit", async (c) => {
    const id = c.req.param("id");
    asRepresentative(c.get("session"), id);
    return c.json(await engine.deposit(id));
  });

  // ---------- immutable reports and invoices; only v3 signed terms opt into this workflow
  reviewRoutes(app, { engine, config, asRepresentative, fetch: rt.reviewFetch, nearClient: rt.reviewNearClient });
  app.get("/contracts/:id/submissions", (c) => {
    const id = c.req.param("id");
    asParty(c.get("session"), id);
    return c.json(engine.jobSubmissions(id));
  });
  app.post("/contracts/:id/submissions", async (c) => {
    const id = c.req.param("id");
    const builder = engine.parties(id).contractor;
    requireAccount(c.get("session"), builder, "builder");
    const { contractor_token, ...body } = await c.req.json();
    // The keyless demo has no sessions; use the existing private builder link as its filing capability.
    if (!config.auth.required) {
      engine.requireContractorToken(id, contractor_token);
    }
    return c.json(await engine.submitJob(id, body, builder), 201);
  });
  app.post("/submissions/:sid/propose", async (c) => {
    const sid = c.req.param("sid");
    asRepresentative(c.get("session"), engine.jobContract(sid));
    return c.json(await engine.proposeJob(sid));
  });
  app.post("/submissions/:sid/changes", async (c) => {
    const sid = c.req.param("sid");
    asRepresentative(c.get("session"), engine.jobContract(sid));
    const body = z.object({ reason: z.string().trim().min(3).max(4000) }).strict().parse(await c.req.json());
    return c.json(await engine.requestJobChanges(sid, body.reason));
  });

  // ---------- payouts
  app.post("/contracts/:id/run", async (c) => {
    const id = c.req.param("id");
    asRepresentative(c.get("session"), id);
    return c.json(await engine.run(id));
  });
  app.post("/contracts/:id/retry", async (c) => {
    const id = c.req.param("id");
    asRepresentative(c.get("session"), id);
    return c.json(await engine.retry(id));
  });
  app.post("/contracts/:id/drop", async (c) => {
    const id = c.req.param("id");
    asRepresentative(c.get("session"), id);
    return c.json(await engine.drop(id));
  });
  app.post("/payouts/:rid/vote", async (c) => {
    const rid = c.req.param("rid");
    asRepresentative(c.get("session"), engine.payoutContract(rid));
    const body = z.object({ verdict: z.enum(["approve", "reject"]) }).parse(await c.req.json());
    return c.json(await engine.vote(rid, body.verdict));
  });
  app.post("/payouts/:rid/resolve", async (c) => {
    const rid = c.req.param("rid");
    asRepresentative(c.get("session"), engine.payoutContract(rid));
    const body = z.object({ outcome: z.enum(["arrived", "reowe", "rejected", "disputed"]), reason: z.string().trim().min(3).max(4000).optional() }).parse(await c.req.json());
    return c.json(await engine.resolve(rid, body.outcome, body.reason));
  });

  // Public verification relays only fixed check IDs and booleans. No reconciliation-capable reads.
  app.get("/contracts/:id/verify/public", async (c) => c.json(await engine.publicVerification(c.req.param("id"))));
  app.get("/contracts/:id/verify", async (c) => {
    const id = c.req.param("id");
    asParty(c.get("session"), id);
    return c.json(await engine.verify(id));
  });

  app.post("/contracts/:id/attacks/:scenario", async (c) => {
    const id = c.req.param("id");
    asRepresentative(c.get("session"), id);
    const scenario = c.req.param("scenario") as Scenario;
    if (!SCENARIOS.includes(scenario)) throw new UserError("Unknown scenario", 404);
    return c.json(await engine.attack(id, scenario));
  });

  if (market) marketRoutes(app, market, { authRequired: config.auth.required, controls: kit.controls });

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
        const v = await engine.getContract(body.contract_id);
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
      else if (body.request_id) cids = [engine.attempt(body.request_id).correlation_id ?? ""].filter(Boolean);
      else if (body.contract_id) cids = (await engine.getContract(body.contract_id)).payouts.filter((p) => p.state === "processing").map((p) => engine.attempt(p.request_id).correlation_id ?? "").filter(Boolean);
      if (!cids.length) throw new UserError("Nothing approved is waiting to settle.");
      for (const cid of cids) await controls.settle(cid);
      return c.json({ settled: cids });
    });
    app.post("/sim/merge", async (c) => {
      if (!(evidence instanceof FakeEvidence)) throw new UserError("Only available with the demo evidence source.");
      const body = z.object({ contract_id: z.string() }).parse(await c.req.json());
      return c.json({ merged: evidence.mergeNext((await engine.getContract(body.contract_id)).terms) });
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
