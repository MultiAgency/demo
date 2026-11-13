import type { Hono } from "hono";
import { z } from "zod";
import { toAtomic } from "../../shared/money";
import { USDC_DECIMALS } from "../../shared/terms";
import type { SessionInfo } from "../auth";
import { UserError } from "../engine";
import { jsonBody } from "../errors";
import type { DemoControls } from "../platform/port";
import { MarketHttpError } from "./api";
import type { AgencyRow } from "./db";
import type { Market } from "./index";
import { requireMember } from "./members";
import { MAX_WEBHOOK_BODY } from "./worker";

type App = Hono<{ Variables: { session: SessionInfo | null } }>;

const signedStep = z.object({ step: z.enum(["setup", "consent"]), nonce: z.string(), publicKey: z.string(), signature: z.string() });
const walletSig = z.object({ publicKey: z.string(), signature: z.string() });

/** Read the public webhook as a bounded byte stream; parsing/re-encoding before HMAC verification changes its bytes. */
async function webhookBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_WEBHOOK_BODY) throw new UserError("A market webhook is at most 1 MiB.", 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_WEBHOOK_BODY) {
        void reader.cancel().catch(() => {});
        throw new UserError("A market webhook is at most 1 MiB.", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
  return raw;
}

/** The market's routes under `/api/market`. `controls` are the local stack's (dev only), as for contracts. */
export function marketRoutes(app: App, m: Market, o: { authRequired: boolean; controls: DemoControls | null }) {
  const account = (c: { get(k: "session"): SessionInfo | null }) => c.get("session")?.accountId ?? null;
  const member = (a: AgencyRow, who: string | null, need: "read" | "propose") => requireMember(a, who, need, o.authRequired, m.d.daoPolicy);
  const directory = async <T>(f: () => Promise<T>) => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof MarketHttpError) throw new UserError(`${err.message} The directory at ${m.d.api.base} couldn't be read; you can still enter a handle.`, 502);
      throw err;
    }
  };

  // Only the agencies the signed-in account may read: its own wallet's, and those of DAOs it is a member of.
  app.get("/market/agencies", async (c) => {
    const who = account(c);
    if (o.authRequired && !who) throw new UserError("Sign in with NEAR to see your agencies.", 401);
    const readable: AgencyRow[] = [];
    for (const a of m.agencies.list()) {
      try {
        await member(a, who, "read");
        readable.push(a);
      } catch {
        /* not this account's */
      }
    }
    return c.json(readable.map((a) => ({ id: a.id, name: a.name, owner: a.owner, signer: a.signer, stage: a.stage })));
  });
  app.post("/market/agencies", async (c) => {
    const body = z.object({ name: z.string(), owner: z.string(), signer: z.enum(["wallet", "dao"]) }).parse(await jsonBody(c));
    await requireMember({ name: body.name, owner: body.owner.trim().toLowerCase(), signer: body.signer } as AgencyRow, account(c), "propose", o.authRequired, m.d.daoPolicy);
    return c.json({ id: m.agencies.create(body).id }, 201);
  });
  app.get("/market/agencies/:id", async (c) => {
    const a = m.agencies.row(c.req.param("id"));
    await member(a, account(c), "read");
    return c.json(await m.view(a.id));
  });
  app.post("/market/agencies/:id/next", async (c) => {
    const a = m.agencies.row(c.req.param("id"));
    await member(a, account(c), "propose");
    return c.json(await m.agencies.next(a.id));
  });
  app.post("/market/agencies/:id/signed", async (c) => {
    const a = m.agencies.row(c.req.param("id"));
    await member(a, account(c), "propose");
    return c.json(await m.agencies.signed(a.id, signedStep.parse(await jsonBody(c))));
  });
  app.post("/market/steps/:cid/submit", async (c) => {
    const s = m.agencies.step(c.req.param("cid"));
    await member(m.agencies.row(s.agency_id), account(c), "propose");
    return c.json(await m.agencies.submitStep(s.correlation_id, walletSig.parse(await jsonBody(c))));
  });
  app.post("/market/agencies/:id/deposit", async (c) => {
    const a = m.agencies.row(c.req.param("id"));
    await member(a, account(c), "propose");
    return c.json(await m.agencies.deposit(a.id));
  });

  for (const [path, kind] of [["freeze", "agent_freeze"], ["unfreeze", "agent_unfreeze"]] as const)
    app.post(`/market/agencies/:id/${path}`, async (c) => {
      const a = m.agencies.row(c.req.param("id"));
      await member(a, account(c), "propose");
      return c.json(await m.agencies.stop(a.id, kind));
    });

  // ---------- client: the directory, quotes and hires
  app.get("/market/directory", async (c) => c.json(await directory(() => m.d.api.browse(c.req.query("q") ?? ""))));
  app.get("/market/directory/:agentId", async (c) => c.json(await directory(() => m.d.api.detail(c.req.param("agentId")))));
  app.post("/market/agencies/:id/quote", async (c) => {
    const a = m.agencies.row(c.req.param("id"));
    await member(a, account(c), "propose");
    const body = z.object({ handle: z.string(), brief: z.string() }).parse(await jsonBody(c));
    return c.json(m.hires.view(await m.hires.quote(a.id, body.handle, body.brief)));
  });
  const hireRoute = (path: string, f: (rid: string, who: string | null) => Promise<unknown>) =>
    app.post(`/market/hires/:rid/${path}`, async (c) => {
      const rid = c.req.param("rid");
      await member(m.agencies.row(m.hires.row(rid).agency_id), account(c), "propose");
      return c.json(await f(rid, account(c)));
    });
  hireRoute("approve", async (rid, who) => m.hires.view(await m.hires.approve(rid, who)));
  hireRoute("follow", async (rid) => m.hires.view(await m.hires.follow(rid)));
  hireRoute("discard", async (rid) => {
    m.hires.discard(rid);
    return { discarded: rid };
  });

  // ---------- worker: the agency's listed agent
  app.get("/market/worker", async (c) => {
    // Authenticate before any private assignment or deposit read. Disabled configuration exposes no history;
    // historical agency bindings remain in the database and are never inferred from a replacement configuration.
    if (m.d.worker) await member(m.agencies.row(m.d.worker.agencyId), account(c), "read");
    return c.json(await m.worker.view());
  });
  const workerAgency = () => {
    const v = m.d.worker;
    if (!v) throw new UserError("The market worker isn't configured.", 404);
    return m.agencies.row(v.agencyId);
  };
  app.post("/market/worker/poll", async (c) => {
    await member(workerAgency(), account(c), "propose");
    try {
      await m.worker.poll();
    } catch (err) {
      if (err instanceof MarketHttpError) throw new UserError(err.message, 502);
      throw err;
    }
    return c.json(await m.worker.view());
  });
  app.post("/market/worker/jobs/:aid/submit", async (c) => {
    await member(workerAgency(), account(c), "propose");
    const body = z.object({ markdown: z.string(), retry_attempt_id: z.string().min(1).max(200).optional() }).parse(await jsonBody(c));
    await m.worker.submit(c.req.param("aid"), body.markdown, body.retry_attempt_id);
    return c.json(await m.worker.view());
  });
  // The market's webhooks: authenticated by their signature, not a session.
  app.post("/market/webhook", async (c) => {
    if (!m.worker.configured) return c.body(null, 404);
    const r = await m.worker.receive(c.req.raw.headers, await webhookBody(c.req.raw));
    return c.body(null, r.status);
  });

  // ---------- local stack controls (dev only)
  const controls = m.d.controls;
  if (controls && o.controls) {
    const demo = o.controls;
    app.post("/market/sim/register", async (c) => {
      const body = z.object({ agency_id: z.string() }).parse(await jsonBody(c));
      const a = m.agencies.row(body.agency_id);
      await member(a, account(c), "propose");
      const acct = await m.agencies.agent(a).account();
      if (!acct.ok) throw new UserError("The platform didn't read the payment key.", 503);
      await controls.marketRegister(acct.value.account);
      return c.json({ registered: acct.value.account });
    });
    app.post("/market/sim/vote", async (c) => {
      const body = z.object({ vote_id: z.string() }).parse(await jsonBody(c));
      const vote = m.agencies.vote(body.vote_id);
      await member(m.agencies.row(vote.agency_id), account(c), "propose");
      await controls.daoVote(vote.hash);
      return c.json({ passed: body.vote_id });
    });
    app.post("/market/sim/advance", async (c) => {
      if (o.authRequired && !account(c)) throw new UserError("Sign in with NEAR to use the demo controls.", 401);
      const body = z.object({ blocks: z.number().int().positive().optional() }).parse(await jsonBody(c));
      await controls.marketAdvance(body.blocks);
      return c.json({ advanced: body.blocks ?? null });
    });
    app.post("/market/sim/fund", async (c) => {
      const body = z.object({ agency_id: z.string(), usd: z.string() }).parse(await jsonBody(c));
      const a = m.agencies.row(body.agency_id);
      await member(a, account(c), "propose");
      if (!a.agent_id) throw new UserError("The agency's agent isn't created yet.", 409);
      await demo.fund(a.agent_id, toAtomic(body.usd, USDC_DECIMALS).toString());
      return c.json({ funded_usd: body.usd });
    });
  }
}
