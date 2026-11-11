// Scripted app-state fixtures on disposable disk databases; no hosted market, wallet, or real-payment evidence.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { SessionInfo } from "../src/server/auth";
import { Market } from "../src/server/market";
import { MarketApi } from "../src/server/market/api";
import type { DaoHireInput, Fail, FiledDaoHire, MarketAgent, MarketPlatform, OwnerPrepared, Res } from "../src/server/market/port";
import { SdkMarket } from "../src/server/market/sdk";
import { marketRoutes } from "../src/server/market/routes";
import { answer, registeredChain, StubMarket, TERMS } from "./support/market-stub";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(signer: "wallet" | "dao" = "wallet") {
  const dir = mkdtempSync(join(tmpdir(), "paperwork-market-recovery-"));
  const path = join(dir, "market.sqlite");
  let db = new Database(path);
  const stub = new StubMarket();
  const platform: MarketPlatform = stub;
  // Include the whole bound input, unlike the intentionally short messages in the general market stub.
  platform.setupMessage = (i) => JSON.stringify({ kind: "setup", ...i });
  platform.consentMessage = (i) => JSON.stringify({ kind: "consent", ...i });
  const hooks: Partial<MarketAgent> = {};
  const originalAgent = stub.agent.bind(stub);
  stub.agent = () => ({ ...originalAgent(), ...hooks });
  let now = NOW;
  const deps = () => ({ db, market: stub, controls: null, chain: registeredChain,
    api: new MarketApi("https://market.invalid", null), worker: null, daoPolicy: async () => null,
    now: () => new Date(now) });
  let m = new Market(deps());
  const agency = m.agencies.create({ name: "Acme", owner: signer === "wallet" ? "acme.near" : "council.sputnik-dao.near", signer });
  db.query("UPDATE market_agencies SET stage = 'ready', agent = 'own-1', agent_id = 'agent-id' WHERE id = ?").run(agency.id);
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get db() { return db; }, get m() { return m; }, path, stub, hooks, agency,
    advance(ms: number) { now += ms; },
    stage(stage: string) { db.query("UPDATE market_agencies SET stage = ? WHERE id = ?").run(stage, agency.id); },
    reload() { db.close(); db = new Database(path); m = new Market(deps()); },
  };
}

const prepared = (id: string, extra: Partial<OwnerPrepared> = {}): Res<OwnerPrepared> => ({ ok: true, value: {
  correlationId: id, expiresAt: "2026-11-11T13:00:00.000Z", summary: "Issue the market grant",
  intent: { standard: "nep413", payload: { message: `grant ${id}`, nonce: `nonce-${id}`, recipient: "provider.test" } }, ...extra,
} });
const sig = { publicKey: "fixture-public-key", signature: "fixture-signature" };
const unavailable = async () => ({ ok: false as const, kind: "unavailable" as const });
const calls = (f: ReturnType<typeof fixture>, name: string) => f.stub.calls.filter((c) => c[0] === name);

describe("market signing recovery", () => {
  for (const stage of ["needs_setup", "needs_consent"] as const) {
    test(`${stage}: reload preserves the exact unexpired body, then expiry replaces it`, async () => {
      const f = fixture();
      f.stage(stage);
      const first = await f.m.agencies.next(f.agency.id);
      expect(first.kind).toBe("sign");
      if (first.kind !== "sign") throw new Error("Expected sign request");
      f.advance(60_000);
      f.reload();
      expect(await f.m.agencies.next(f.agency.id)).toEqual(first);
      f.advance(stage === "needs_setup" ? 30 * 60_000 : 90 * 86_400_000);
      await expect(f.m.agencies.signed(f.agency.id, { step: first.step, nonce: first.sign.nonce, ...sig })).rejects.toThrow(/unexpired/);
      const renewed = await f.m.agencies.next(f.agency.id);
      if (renewed.kind !== "sign") throw new Error("Expected renewed sign request");
      expect(renewed.sign.nonce).not.toBe(first.sign.nonce);
      expect(renewed.sign.message).not.toBe(first.sign.message);
    });
  }

  test("losing the app's prepare response reuses its durable correlation and intent after reload", async () => {
    const f = fixture(); f.stage("needs_grant");
    f.stub.prepareAnswers.push(prepared("grant-original"));
    const issued = await f.m.agencies.next(f.agency.id); // The browser never receives this response.
    f.reload();
    expect(await f.m.agencies.next(f.agency.id)).toEqual(issued);
    expect(calls(f, "ownerPrepare")).toHaveLength(1);
    expect(f.db.query("SELECT correlation_id FROM market_steps").all()).toEqual([{ correlation_id: "grant-original" }]);
  });

  test("a lost platform prepare response recovers owner/pending under its original identity", async () => {
    const f = fixture(); f.stage("needs_grant");
    const p = prepared("grant-platform");
    if (!p.ok) throw new Error("Expected prepared fixture");
    f.stub.prepareAnswers.push({ ok: false, kind: "unknown" });
    f.stub.pending = [{ ...p.value, type: "grant_issue", hash: null, intent: p.value.intent! }];
    expect(await f.m.agencies.next(f.agency.id)).toMatchObject({ kind: "owner_step", correlation_id: "grant-platform" });
    f.reload();
    expect(await f.m.agencies.next(f.agency.id)).toMatchObject({ kind: "owner_step", correlation_id: "grant-platform" });
    expect(calls(f, "ownerPrepare")).toHaveLength(1);
  });

  test("simultaneous next requests share one prepare", async () => {
    const f = fixture(); f.stage("needs_grant");
    let release!: (p: Res<OwnerPrepared>) => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<Res<OwnerPrepared>>((resolve) => { release = resolve; });
    f.hooks.ownerPrepare = async (action, signer) => { f.stub.calls.push(["ownerPrepare", action.type, signer]); entered(); return pending; };
    const one = f.m.agencies.next(f.agency.id);
    await enteredPromise;
    const two = f.m.agencies.next(f.agency.id);
    release(prepared("grant-concurrent"));
    expect(await two).toEqual(await one);
    expect(calls(f, "ownerPrepare")).toHaveLength(1);
  });

  for (const fault of ["throw", "unknown"] as const) {
    test(`owner submit ${fault}: claim is durable before I/O; reload and opposite action never replay it`, async () => {
      const f = fixture(); f.stage("needs_grant");
      f.stub.prepareAnswers.push(prepared("grant-uncertain"));
      await f.m.agencies.next(f.agency.id);
      let sends = 0;
      f.hooks.ownerStatus = unavailable;
      f.hooks.ownerSubmit = async (id) => {
        sends++;
        // A second connection sees the write before any external response or app acknowledgement.
        const observer = new Database(f.path, { readonly: true });
        try { expect(observer.query("SELECT state FROM market_steps WHERE correlation_id = ?").get(id)).toEqual({ state: "unknown" }); }
        finally { observer.close(); }
        if (fault === "throw") throw new TypeError("lost owner response");
        return { ok: false, kind: "unknown" };
      };
      expect(await f.m.agencies.submitStep("grant-uncertain", sig)).toMatchObject({ kind: "wait" });
      f.reload();
      expect(f.m.agencies.step("grant-uncertain").state).toBe("unknown");
      await expect(f.m.agencies.submitStep("grant-uncertain", sig)).rejects.toThrow(/already unknown/);
      expect(await f.m.agencies.next(f.agency.id)).toMatchObject({ kind: "wait" });
      expect(await f.m.agencies.stop(f.agency.id, "agent_freeze")).toMatchObject({ kind: "wait" });
      expect(sends).toBe(1);
      expect(calls(f, "ownerPrepare")).toHaveLength(1);
      f.hooks.ownerStatus = async () => ({ ok: true, value: { stage: "submitted", status: "SUCCESS", failureCode: null } });
      expect(await f.m.agencies.next(f.agency.id)).toEqual({ kind: "done" });
      expect(f.m.agencies.step("grant-uncertain").state).toBe("success");
      expect(calls(f, "ownerPrepare")).toHaveLength(1);
      expect(sends).toBe(1);
    });
  }

  test("a duplicate submit and a different prepare are blocked while the original submit is in flight", async () => {
    const f = fixture(); f.stage("needs_grant");
    f.stub.prepareAnswers.push(prepared("grant-in-flight"));
    await f.m.agencies.next(f.agency.id);
    let release!: (r: Res<{ status: string }>) => void;
    let sends = 0;
    f.hooks.ownerStatus = unavailable;
    f.hooks.ownerSubmit = async () => { sends++; return new Promise((resolve) => { release = resolve; }); };
    const original = f.m.agencies.submitStep("grant-in-flight", sig);
    expect(f.m.agencies.step("grant-in-flight").state).toBe("unknown");
    await expect(f.m.agencies.submitStep("grant-in-flight", sig)).rejects.toThrow(/already unknown/);
    expect(await f.m.agencies.stop(f.agency.id, "agent_freeze")).toMatchObject({ kind: "wait" });
    release({ ok: false, kind: "unknown" });
    await original;
    expect(sends).toBe(1);
    expect(calls(f, "ownerPrepare")).toHaveLength(1);
  });

  test("expired wallet intents are never submitted", async () => {
    const f = fixture(); f.stage("needs_grant");
    f.stub.prepareAnswers.push(prepared("grant-expired", { expiresAt: "2026-11-11T12:00:01.000Z" }));
    await f.m.agencies.next(f.agency.id);
    let sends = 0;
    f.hooks.ownerSubmit = async () => { sends++; return { ok: true, value: { status: "SUCCESS" } }; };
    f.advance(1_001);
    await expect(f.m.agencies.submitStep("grant-expired", sig)).rejects.toThrow(/expired/);
    expect(f.m.agencies.step("grant-expired").state).toBe("expired");
    expect(sends).toBe(0);
  });

  test("a local finalization failure repairs the saved successful owner step after reopen without another submission", async () => {
    const f = fixture(); f.stage("needs_grant");
    f.stub.prepareAnswers.push(prepared("grant-finalizing"));
    await f.m.agencies.next(f.agency.id);
    let sends = 0;
    f.hooks.ownerSubmit = async () => { sends++; return { ok: true, value: { status: "SUCCESS" } }; };
    f.db.exec(`CREATE TEMP TRIGGER fail_local_stage BEFORE UPDATE OF stage ON market_agencies
      WHEN NEW.stage = 'needs_registration' BEGIN SELECT RAISE(ABORT, 'local finalization fault'); END`);
    await expect(f.m.agencies.submitStep("grant-finalizing", sig)).rejects.toThrow(/local finalization fault/);
    expect(f.m.agencies.step("grant-finalizing").state).toBe("success");
    expect(f.m.agencies.row(f.agency.id).stage).toBe("needs_grant");
    f.reload(); // The transient trigger is gone; the original stored success is still authoritative.
    expect(await f.m.agencies.next(f.agency.id)).toEqual({ kind: "done" });
    expect(f.m.agencies.row(f.agency.id).stage).toBe("ready");
    expect(f.m.agencies.step("grant-finalizing").state).toBe("success");
    expect(calls(f, "ownerPrepare")).toHaveLength(1);
    expect(sends).toBe(1);
  });

  test("local confirm expiry cannot replace an externally signable intent or permit an opposite action", async () => {
    const f = fixture();
    f.stub.prepareAnswers.push(prepared("freeze-confirm", { intent: undefined,
      expiresAt: "2026-11-11T12:00:01.000Z", confirm: { url: "https://platform.test/confirm/original", expiresAt: "2026-11-11T12:00:01.000Z" } }));
    expect(await f.m.agencies.stop(f.agency.id, "agent_freeze")).toMatchObject({ correlation_id: "freeze-confirm" });
    f.advance(1_001); f.reload(); f.hooks.ownerStatus = unavailable;
    expect(await f.m.agencies.stop(f.agency.id, "agent_freeze")).toMatchObject({ correlation_id: "freeze-confirm" });
    expect(await f.m.agencies.stop(f.agency.id, "agent_unfreeze")).toMatchObject({ kind: "wait" });
    expect(f.m.agencies.step("freeze-confirm").state).toBe("prepared");
    expect(calls(f, "ownerPrepare")).toHaveLength(1);
  });
});

describe("market hire freeze recovery", () => {
  for (const signer of ["wallet", "dao"] as const) {
    test(`${signer}: overlapping approvals cannot issue a second hire or DAO filing`, async () => {
      const f = fixture(signer);
      const q = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
      let release!: (r: Res<boolean>) => void;
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      let first = true;
      f.hooks.frozen = async () => {
        if (!first) return { ok: true, value: false };
        first = false; entered();
        return new Promise((resolve) => { release = resolve; });
      };
      const original = f.m.hires.approve(q.request_id, "original.near");
      await enteredPromise;
      await expect(f.m.hires.approve(q.request_id, "second.near")).rejects.toThrow(/already being followed/);
      release({ ok: true, value: false });
      await original;
      expect(f.m.hires.row(q.request_id).approved_by).toBe("original.near");
      expect(calls(f, signer === "wallet" ? "hire" : "daoHire.file")).toEqual([[signer === "wallet" ? "hire" : "daoHire.file", q.request_id]]);
    });
  }

  for (const signer of ["wallet", "dao"] as const) for (const fault of ["unavailable", "throw"] as const) {
    test(`${signer}: ${fault} freeze read refuses initial approval without changing the quote`, async () => {
      const f = fixture(signer);
      const q = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
      f.hooks.frozen = fault === "throw" ? async () => { throw new TypeError("policy unavailable"); } : unavailable;
      await expect(f.m.hires.approve(q.request_id, "acme.near")).rejects.toThrow(/confirm whether/);
      expect(f.m.hires.row(q.request_id)).toMatchObject({ state: "quoted", terms: q.terms, approved_by: null });
      expect(calls(f, "hire")).toHaveLength(0);
      expect(calls(f, "daoHire.file")).toHaveLength(0);
    });
  }

  for (const fault of ["frozen", "unavailable", "throw"] as const) {
    test(`not_found after ${fault} cannot resend; unfreeze resumes under the original approved id and terms`, async () => {
      const f = fixture();
      const q = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
      await f.m.hires.approve(q.request_id, "acme.near");
      expect(calls(f, "hire")).toEqual([["hire", q.request_id]]);
      f.hooks.frozen = fault === "frozen" ? async () => ({ ok: true, value: true }) : fault === "throw" ? async () => { throw new TypeError("policy unavailable"); } : unavailable;
      f.stub.statusAnswers.push(answer(q.request_id, "not_found", { taskId: null }));
      f.reload();
      expect(await f.m.hires.follow(q.request_id)).toMatchObject({ state: "unknown", approved_by: "acme.near", terms: q.terms });
      expect(calls(f, "hire")).toEqual([["hire", q.request_id]]);
      f.hooks.frozen = async () => ({ ok: true, value: false });
      f.stub.statusAnswers.push(answer(q.request_id, "not_found", { taskId: null }));
      f.stub.hireAnswers.push(answer(q.request_id, "paid"));
      expect(await f.m.hires.follow(q.request_id)).toMatchObject({ state: "paid", request_id: q.request_id, terms: q.terms });
      expect(calls(f, "hire")).toEqual([["hire", q.request_id], ["hire", q.request_id]]);
      expect(f.db.query("SELECT request_id FROM market_hires").all()).toEqual([{ request_id: q.request_id }]);
    });
  }

  test("a freeze after approval's first read blocks its paid call and preserves the approved identity", async () => {
    const f = fixture();
    const q = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
    let reads = 0;
    f.hooks.frozen = async () => ({ ok: true, value: ++reads > 1 });
    expect(await f.m.hires.approve(q.request_id, "acme.near")).toMatchObject({ state: "hiring", approved_by: "acme.near" });
    expect(calls(f, "hire")).toHaveLength(0);
    f.reload(); f.hooks.frozen = async () => ({ ok: true, value: false });
    f.stub.statusAnswers.push(answer(q.request_id, "not_found", { taskId: null }));
    f.stub.hireAnswers.push(answer(q.request_id, "paid"));
    expect(await f.m.hires.follow(q.request_id)).toMatchObject({ state: "paid", terms: q.terms });
    expect(calls(f, "hire")).toEqual([["hire", q.request_id]]);
  });

  test("a thrown hire response preserves its exact approved terms; a later paid observation sends nothing while frozen", async () => {
    const f = fixture();
    const q = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
    const sent: unknown[] = [];
    f.hooks.hire = async (id, brief, terms) => {
      sent.push({ id, brief, terms });
      throw new TypeError("payment response lost");
    };
    expect(await f.m.hires.approve(q.request_id, "acme.near")).toMatchObject({ state: "unknown", approved_by: "acme.near" });
    f.reload(); f.hooks.frozen = async () => ({ ok: true, value: true });
    f.stub.statusAnswers.push(answer(q.request_id, "paid"));
    expect(await f.m.hires.follow(q.request_id)).toMatchObject({ state: "paid", terms: q.terms });
    expect(sent).toEqual([{ id: q.request_id, brief: "Exact brief", terms: JSON.parse(q.terms) }]);
  });
});

describe("DAO hire filing recovery", () => {
  test("a lost filing is restored after reopen under the original job and DAO approval, with no new vote or payment", async () => {
    const f = fixture("dao");
    const q = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
    const platform: MarketPlatform = f.stub;
    const originalFile = platform.daoHire.file;
    let retained!: FiledDaoHire;
    platform.daoHire.file = async (input) => {
      const filed = await originalFile(input);
      if (!filed.ok) throw new Error("Expected fixture approval");
      retained = filed.value;
      return { ok: false, kind: "unknown" };
    };
    await f.m.hires.approve(q.request_id, "original-member.near");
    f.reload();
    let recoveredInput: unknown;
    platform.daoHire.recover = async (input) => { recoveredInput = input; return { ok: true, value: retained }; };
    const recovered = await f.m.hires.follow(q.request_id);
    expect(recovered).toMatchObject({ request_id: q.request_id, state: "voting", dao_vote_id: retained.id,
      approved_by: "original-member.near", terms: q.terms });
    expect(recoveredInput).toEqual({ organization: f.agency.organization, agent: "own-1", owner: f.agency.owner,
      agentId: "agent-id", requestId: q.request_id, brief: q.brief, approved: JSON.parse(q.terms) });
    expect(f.m.agencies.vote(retained.id)).toMatchObject({ ref: q.request_id, hash: retained.hash, valid_until: retained.validUntil });
    f.reload();
    expect(f.m.hires.row(q.request_id).dao_vote_id).toBe(retained.id);
    expect(calls(f, "daoHire.file")).toEqual([["daoHire.file", q.request_id]]);
    expect(calls(f, "hire")).toHaveLength(0);
    expect(f.db.query("SELECT count(*) AS n FROM market_dao_votes").get()).toEqual({ n: 1 });
  });

  test("recovery observations share one lookup and never race an active original filing", async () => {
    const f = fixture("dao");
    const q = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
    const platform: MarketPlatform = f.stub;
    let releaseFile!: () => void;
    platform.daoHire.file = async () => { await new Promise<void>((resolve) => { releaseFile = resolve; }); return { ok: false, kind: "unknown" }; };
    const sending = f.m.hires.approve(q.request_id, "member.near");
    while (!releaseFile) await Promise.resolve();
    await f.m.hires.follow(q.request_id);
    expect(calls(f, "daoHire.recover")).toHaveLength(0);
    releaseFile(); await sending;
    let releaseRecovery!: (result: Res<FiledDaoHire>) => void;
    let reads = 0;
    platform.daoHire.recover = async () => { reads++; return new Promise((resolve) => { releaseRecovery = resolve; }); };
    const one = f.m.hires.follow(q.request_id);
    const two = f.m.hires.follow(q.request_id);
    while (!releaseRecovery) await Promise.resolve();
    releaseRecovery({ ok: false, kind: "unavailable" });
    await Promise.all([one, two]);
    expect(reads).toBe(1);
    expect(f.m.hires.row(q.request_id)).toMatchObject({ state: "unknown", dao_vote_id: null, terms: q.terms });
  });

  for (const late of ["status", "recovery"] as const) {
    test(`a late ${late} cannot undo a recovered approval or confirmed payment`, async () => {
      const f = fixture("dao");
      const q = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
      const platform: MarketPlatform = f.stub;
      const originalFile = platform.daoHire.file;
      const filed = await originalFile({ organization: f.agency.organization, agent: "own-1", requestId: q.request_id,
        brief: q.brief, approved: JSON.parse(q.terms), validUntil: "2026-11-12T00:00:00.000Z" });
      if (!filed.ok) throw new Error("Expected retained approval");
      f.db.query("UPDATE market_hires SET state = 'unknown', code = 'dao_filing_unknown' WHERE request_id = ?").run(q.request_id);
      let release!: () => void;
      let first = true;
      if (late === "status") {
        f.hooks.status = async () => {
          if (first) { first = false; await new Promise<void>((resolve) => { release = resolve; }); }
          return answer(q.request_id, "unknown");
        };
        platform.daoHire.recover = async () => filed;
      } else {
        platform.daoHire.recover = async () => { await new Promise<void>((resolve) => { release = resolve; }); return filed; };
      }
      const old = f.m.hires.follow(q.request_id);
      while (!release) await Promise.resolve();
      if (late === "status") expect(await f.m.hires.follow(q.request_id)).toMatchObject({ state: "voting", dao_vote_id: filed.value.id });
      else {
        f.stub.isFrozen = true;
        f.stub.statusAnswers.push(answer(q.request_id, "paid"));
        expect(await f.m.hires.follow(q.request_id)).toMatchObject({ state: "paid" });
      }
      release();
      expect(await old).toMatchObject({ state: late === "status" ? "voting" : "paid", dao_vote_id: filed.value.id });
      expect(calls(f, "hire")).toHaveLength(0);
    });
  }

  for (const fault of ["unknown", "unavailable", "provider", "throw"] as const) {
    test(`${fault} filing response preserves a non-discardable original identity and blocks replacement approval`, async () => {
      const f = fixture("dao");
      const q = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
      const platform: MarketPlatform = f.stub;
      const filedIds: string[] = [];
      let voteReads = 0;
      platform.daoHire.file = async (input) => {
        filedIds.push(input.requestId);
        const observer = new Database(f.path, { readonly: true });
        try {
          expect(observer.query("SELECT state, code, dao_vote_id, terms, approved_by FROM market_hires WHERE request_id = ?").get(input.requestId))
            .toEqual({ state: "unknown", code: "dao_filing_unknown", dao_vote_id: null, terms: q.terms, approved_by: "member.near" });
        } finally { observer.close(); }
        if (fault === "throw") throw new TypeError("filing response lost");
        return { ok: false, kind: fault };
      };
      platform.daoHire.state = async () => { voteReads++; throw new Error("No vote hash is known"); };
      expect(await f.m.hires.approve(q.request_id, "member.near")).toMatchObject({ state: "unknown", code: "dao_filing_unknown", dao_vote_id: null });
      f.reload();
      expect(f.m.hires.view(f.m.hires.row(q.request_id))).toMatchObject({ state: "unknown", code: "dao_filing_unknown", vote: null });
      expect(() => f.m.hires.discard(q.request_id)).toThrow(/only an unapproved quote/);
      await expect(f.m.hires.approve(q.request_id, "member.near")).rejects.toThrow(/unknown/);
      const replacement = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
      await expect(f.m.hires.approve(replacement.request_id, "member.near")).rejects.toThrow(q.request_id);
      f.stub.statusAnswers.push(answer(q.request_id, "not_found", { taskId: null }));
      expect(await f.m.hires.follow(q.request_id)).toMatchObject({ state: "unknown", code: "dao_filing_recovery_unavailable", terms: q.terms });
      // A normal unknown status must not erase why this original filing cannot be replaced.
      expect(await f.m.hires.follow(q.request_id)).toMatchObject({ state: "unknown", code: "dao_filing_recovery_unavailable" });
      await expect(f.m.hires.approve(q.request_id, "member.near")).rejects.toThrow(/platform 0\.5\.7/);
      f.stub.statusAnswers.push(answer(q.request_id, "paid"));
      expect(await f.m.hires.follow(q.request_id)).toMatchObject({ state: "paid", request_id: q.request_id, terms: q.terms });
      expect(filedIds).toEqual([q.request_id]);
      expect(voteReads).toBe(0);
      expect(calls(f, "hire")).toHaveLength(0);
      expect(f.db.query("SELECT * FROM market_dao_votes").all()).toEqual([]);
    });
  }

  for (const code of ["invalid_request", "brief_mismatch", "expires_too_soon"] as const) {
    test(`explicit pre-filing refusal ${code} is retained under the original id`, async () => {
      const f = fixture("dao");
      const q = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
      const platform: MarketPlatform = f.stub;
      const filedIds: string[] = [];
      platform.daoHire.file = async (input) => { filedIds.push(input.requestId); return { ok: false, kind: "refused", code }; };
      await expect(f.m.hires.approve(q.request_id, "member.near")).rejects.toThrow();
      f.reload();
      expect(await f.m.hires.follow(q.request_id)).toMatchObject({ request_id: q.request_id, state: "refused", code, terms: q.terms, dao_vote_id: null });
      await expect(f.m.hires.approve(q.request_id, "member.near")).rejects.toThrow(/refused/);
      expect(filedIds).toEqual([q.request_id]);
      expect(calls(f, "hire")).toHaveLength(0);
      expect(f.db.query("SELECT * FROM market_dao_votes").all()).toEqual([]);
    });
  }

  test("an unspecified refusal is not promoted to proof that no DAO filing exists", async () => {
    const f = fixture("dao");
    const q = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
    const platform: MarketPlatform = f.stub;
    platform.daoHire.file = async () => ({ ok: false, kind: "refused", code: "http_400" });
    expect(await f.m.hires.approve(q.request_id, "member.near")).toMatchObject({ state: "unknown", code: "dao_filing_unknown" });
    expect(() => f.m.hires.discard(q.request_id)).toThrow(/only an unapproved quote/);
  });

  test("a database failure after successful filing cannot lose the write-ahead identity or leave an orphan local vote", async () => {
    const f = fixture("dao");
    const q = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
    f.db.exec(`CREATE TEMP TRIGGER fail_vote_link BEFORE UPDATE OF state ON market_hires
      WHEN NEW.state = 'voting' BEGIN SELECT RAISE(ABORT, 'vote link fault'); END`);
    await expect(f.m.hires.approve(q.request_id, "member.near")).rejects.toThrow(/vote link fault/);
    expect(f.db.query("SELECT * FROM market_dao_votes").all()).toEqual([]);
    f.reload();
    expect(f.m.hires.row(q.request_id)).toMatchObject({ state: "unknown", code: "dao_filing_unknown", dao_vote_id: null, terms: q.terms });
    expect(() => f.m.hires.discard(q.request_id)).toThrow(/only an unapproved quote/);
    f.stub.statusAnswers.push(answer(q.request_id, "not_found", { taskId: null }));
    expect(await f.m.hires.follow(q.request_id)).toMatchObject({ state: "unknown" });
    await expect(f.m.hires.approve(q.request_id, "member.near")).rejects.toThrow(/unknown/);
    expect(calls(f, "daoHire.file")).toEqual([["daoHire.file", q.request_id]]);
    expect(calls(f, "hire")).toHaveLength(0);
  });

  test("a failed local recovery transaction retains the original job and can restore the same approval after reopen", async () => {
    const f = fixture("dao");
    const q = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
    const platform: MarketPlatform = f.stub;
    const originalFile = platform.daoHire.file;
    let retained!: FiledDaoHire;
    platform.daoHire.file = async (input) => {
      const filed = await originalFile(input);
      if (!filed.ok) throw new Error("Expected original approval");
      retained = filed.value;
      return { ok: false, kind: "unknown" };
    };
    await f.m.hires.approve(q.request_id, "member.near");
    platform.daoHire.recover = async () => ({ ok: true, value: retained });
    f.db.exec(`CREATE TEMP TRIGGER fail_recovered_link BEFORE UPDATE OF state ON market_hires
      WHEN NEW.state = 'voting' BEGIN SELECT RAISE(ABORT, 'recovery link fault'); END`);
    await expect(f.m.hires.follow(q.request_id)).rejects.toThrow(/recovery link fault/);
    expect(f.db.query("SELECT * FROM market_dao_votes").all()).toEqual([]);
    expect(f.m.hires.row(q.request_id)).toMatchObject({ state: "unknown", dao_vote_id: null, terms: q.terms });
    f.reload();
    expect(await f.m.hires.follow(q.request_id)).toMatchObject({ state: "voting", dao_vote_id: retained.id, terms: q.terms });
    expect(calls(f, "daoHire.file")).toEqual([["daoHire.file", q.request_id]]);
    expect(calls(f, "hire")).toHaveLength(0);
    expect(f.db.query("SELECT count(*) AS n FROM market_dao_votes").get()).toEqual({ n: 1 });
  });

  test("different request ids racing through preflight cannot bypass the unresolved filing guard", async () => {
    const f = fixture("dao");
    const first = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
    const second = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
    const platform: MarketPlatform = f.stub;
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const originalFile = platform.daoHire.file;
    platform.daoHire.file = async (input) => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      return originalFile(input);
    };
    const original = f.m.hires.approve(first.request_id, "member.near");
    const competing = f.m.hires.approve(second.request_id, "member.near").then(() => null, (error: unknown) => error);
    await enteredPromise;
    expect(await competing).toBeInstanceOf(Error);
    expect(String(await competing)).toContain(first.request_id);
    expect(() => f.m.hires.discard(first.request_id)).toThrow(/only an unapproved quote/);
    release();
    expect(await original).toMatchObject({ state: "voting", dao_vote_id: expect.any(String) });
    expect(calls(f, "daoHire.file")).toEqual([["daoHire.file", first.request_id]]);
    expect(f.m.hires.row(second.request_id).state).toBe("quoted");
  });

  test("a partial voting record with unavailable recovery cannot invent a vote hash", async () => {
    const f = fixture("dao");
    const q = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
    f.db.query("UPDATE market_hires SET state = 'voting', dao_vote_id = NULL WHERE request_id = ?").run(q.request_id);
    const platform: MarketPlatform = f.stub;
    let voteReads = 0;
    platform.daoHire.state = async () => { voteReads++; throw new Error("No vote hash"); };
    f.stub.statusAnswers.push(answer(q.request_id, "not_found", { taskId: null }));
    expect(await f.m.hires.follow(q.request_id)).toMatchObject({ state: "unknown", code: "dao_filing_recovery_unavailable" });
    expect(voteReads).toBe(0);
    expect(calls(f, "daoHire.file")).toHaveLength(0);
    expect(calls(f, "hire")).toHaveLength(0);
  });
});

const nonterminalVoteFailures: { label: string; failure: Fail }[] = [
  { label: "generic 409", failure: { ok: false, kind: "refused", code: "http_409" } },
  { label: "agent_refused", failure: { ok: false, kind: "refused", code: "agent_refused" } },
  { label: "forbidden", failure: { ok: false, kind: "forbidden", code: "access_ended" } },
];

describe("DAO request endings require explicit evidence", () => {
  for (const kind of ["setup", "consent"] as const) for (const { label, failure } of nonterminalVoteFailures) {
    test(`${kind}: ${label} retains its original pending vote instead of filing another`, async () => {
      const f = fixture("dao"); f.stage(kind === "setup" ? "needs_setup" : "needs_consent");
      const platform: MarketPlatform = f.stub;
      const request = kind === "setup" ? platform.daoSetup : platform.daoConsent;
      let filings = 0;
      const originalFile = request.file;
      request.file = async (message) => { filings++; return originalFile(message); };
      const first = await f.m.agencies.next(f.agency.id);
      if (first.kind !== "dao_vote") throw new Error("Expected original DAO vote");
      request.state = async () => failure;
      expect(await f.m.agencies.next(f.agency.id)).toMatchObject({ kind: "wait" });
      f.reload();
      expect(await f.m.agencies.next(f.agency.id)).toMatchObject({ kind: "wait" });
      expect(f.m.agencies.vote(first.vote.id).state).toBe("pending");
      expect(filings).toBe(1);
    });
  }

  for (const { label, failure } of nonterminalVoteFailures) {
    test(`hire: ${label} cannot expire or refile the original approval`, async () => {
      const f = fixture("dao");
      const q = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
      const original = await f.m.hires.approve(q.request_id, "member.near");
      f.stub.daoHireStates.push(failure);
      expect(await f.m.hires.follow(q.request_id)).toMatchObject({ state: "voting", dao_vote_id: original.dao_vote_id });
      expect(f.m.agencies.vote(original.dao_vote_id!).state).toBe("pending");
      await expect(f.m.hires.approve(q.request_id, "member.near")).rejects.toThrow(/voting/);
      expect(calls(f, "daoHire.file")).toEqual([["daoHire.file", q.request_id]]);
      expect(calls(f, "hire")).toHaveLength(0);
    });
  }

  for (const code of ["agent_refused", "signed_expired"] as const) {
    test(`a prior settled payment remains paid after ${code} and freeze, without another filing or send`, async () => {
      const f = fixture("dao");
      const q = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
      await f.m.hires.approve(q.request_id, "member.near");
      f.stub.isFrozen = true;
      f.stub.daoHireStates.push({ ok: false, kind: "refused", code });
      f.stub.statusAnswers.push(answer(q.request_id, "paid"));
      const view = await f.m.view(f.agency.id);
      expect(view.frozen).toBe(true);
      expect(view.hires).toEqual([expect.objectContaining({ state: "paid", request_id: q.request_id })]);
      expect(calls(f, "daoHire.file")).toEqual([["daoHire.file", q.request_id]]);
      expect(calls(f, "hire")).toHaveLength(0);
    });
  }
});

describe("agency API keeps payment observations truthful after freeze", () => {
  for (const outcome of ["paid", "not_found"] as const) {
    test(`${outcome}: the authenticated handler observes the original identity without another hire`, async () => {
      const f = fixture();
      const q = await f.m.hires.quote(f.agency.id, "writer", "Exact brief");
      await f.m.hires.approve(q.request_id, "acme.near");
      f.stub.isFrozen = true;
      f.stub.statusAnswers.push(answer(q.request_id, outcome));
      // Actual HTTP handlers with an explicit fixture session, not a hosted sign-in or a real wallet.
      const app = new Hono<{ Variables: { session: SessionInfo | null } }>().basePath("/api");
      app.use("*", async (c, next) => { c.set("session", { accountId: "acme.near", userId: "acme.near" }); await next(); });
      marketRoutes(app, f.m, { authRequired: true, controls: null });
      const response = await app.request(`/api/market/agencies/${f.agency.id}`);
      expect(response.status).toBe(200);
      const view = await response.json();
      expect(view.frozen).toBe(true);
      expect(view.hires).toEqual([expect.objectContaining({ state: outcome === "paid" ? "paid" : "unknown", request_id: q.request_id })]);
      expect(calls(f, "hire")).toEqual([["hire", q.request_id]]);
    });
  }
});

describe("SDK DAO job recovery uses a non-creating capability check", () => {
  const brief = "Keep this original job brief.";
  const input = (): DaoHireInput & { owner: string; agentId: string } => ({
    organization: "original-organization", agent: "original-agent", requestId: "original-job",
    owner: "council.sputnik-dao.near", agentId: "original-agent-id", brief,
    approved: { ...TERMS, brief: createHash("sha256").update(brief).digest("hex") },
  });
  const retained = () => ({ request: { id: "a".repeat(64), hash: "a".repeat(64), dao: input().owner,
    organization: input().organization, agent: input().agent, agentId: input().agentId, requestId: input().requestId,
    approved: input().approved, validUntil: "2026-11-12T00:00:00.000Z", votingUntil: NOW + 60_000,
    description: "Original DAO job approval" }, transactions: { proposal: null, proposalAndVote: null } });
  const adapter = (handler: (body: any, init: RequestInit) => Response) => new SdkMarket({
    url: "https://platform.invalid", credential: "tap_fixture_not_a_live_credential", deployment: "multiagency-paperwork",
    fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://platform.invalid/apps/v1/dao-hires");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tap_fixture_not_a_live_credential");
      return handler(JSON.parse(String(init?.body)), init!);
    }) as typeof fetch,
  });

  test("a matching retained approval proves support without relying on the installed SDK version", async () => {
    let sent = 0;
    const original = input();
    const sdk = adapter((body) => {
      sent++;
      expect(body).toEqual({ organization: original.organization, agent: original.agent, requestId: original.requestId,
        brief: original.brief, approved: original.approved, validUntil: "1970-01-01T00:00:00.000Z" });
      return Response.json(retained());
    });
    expect(await sdk.daoHire.recover(original)).toMatchObject({ ok: true, value: {
      id: "a".repeat(64), hash: "a".repeat(64), validUntil: retained().request.validUntil,
      proposal: null, proposalAndVote: null,
    } });
    expect(sent).toBe(1);
  });

  for (const host of ["0.5.6", "0.5.7 with no retained approval", "0.5.7 with a lapsed unsigned approval"] as const) {
    test(`${host}: the expired deadline cannot file a new vote`, async () => {
      let created = 0;
      const sdk = adapter((body) => {
        // Pinned gateway contracts check this before file(): 0.5.7 only short-circuits for a reusable old request.
        if (Date.parse(body.validUntil) <= NOW + 60_000)
          return Response.json({ code: "expires_too_soon", error: "Nothing was filed." }, { status: 409 });
        created++;
        return Response.json(retained(), { status: 201 });
      });
      expect(await sdk.daoHire.recover(input())).toEqual({ ok: false, kind: "refused", code: "dao_filing_recovery_unavailable" });
      expect(created).toBe(0);
    });
  }

  for (const fault of ["job", "organization", "agent", "owner", "agentId", "terms", "hash", "new-transactions"] as const) {
    test(`${fault}: an unrelated or newly filed answer cannot bind the original job`, async () => {
      const body = retained();
      if (fault === "job") body.request.requestId = "other-job";
      else if (fault === "organization") body.request.organization = "other-organization";
      else if (fault === "agent") body.request.agent = "other-agent";
      else if (fault === "owner") body.request.dao = "other.sputnik-dao.near";
      else if (fault === "agentId") body.request.agentId = "other-agent-id";
      else if (fault === "terms") body.request.approved.amount = "999999999";
      else if (fault === "hash") body.request.hash = "b".repeat(64);
      else (body.transactions as { proposal: unknown }).proposal = { receiverId: "dao.near", actions: [] };
      expect(await adapter(() => Response.json(body)).daoHire.recover(input())).toMatchObject({ ok: false, kind: "unavailable" });
    });
  }

  test("malformed, failed and lost reads provide no recovered identity", async () => {
    for (const response of [Response.json({}), new Response("not JSON"), Response.json({ error: "unavailable" }, { status: 503 })])
      expect(await adapter(() => response).daoHire.recover(input())).toMatchObject({ ok: false });
    expect(await adapter(() => { throw new TypeError("lost lookup response"); }).daoHire.recover(input())).toMatchObject({ ok: false });
  });
});
