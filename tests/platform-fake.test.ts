import { describe, expect, test } from "bun:test";
import { platformScenario } from "../scripts/demo-stack";
import { SimChain } from "../src/server/platform/chain";
import { SdkPlatform, toFail } from "../src/server/platform/client";
import { FakePlatform, applyChanges } from "../src/server/platform/fake";
import { makePlatform } from "../src/server/platform/index";
import type { AgentHandle, OwnerAction, Res, Reviewed } from "../src/server/platform/port";
import { USDC } from "../src/server/platform/port";
import { KeySigner, STACK_TEST_KEY, stackSigner } from "../src/server/platform/signer";

const T0 = Date.parse("2026-11-20T12:00:00Z");
const DAY = 86_400_000;
const OWNER = "acme.near", PAYEE = "maria.near", ATTACKER = "mallory.near";
const TOTAL = 800_000_000n, LARGEST = 500_000_000n;
const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

function must<T>(r: Res<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.value;
}

function world(autoSettle: "manual" | "after-read" = "manual") {
  let now = T0;
  const chain = new SimChain();
  const signer = KeySigner.random();
  chain.trustKey(signer.publicKey);
  const fake = new FakePlatform({ deployment: "covenant", now: () => new Date(now), chain, autoSettle });
  const signed = async (message: string, by = signer) => {
    const n = nonce();
    return { message, nonce: n, ...(await by.sign413({ message, recipient: fake.host, nonce: n })) };
  };
  const step = async (agent: AgentHandle, action: OwnerAction) => {
    const p = must(await agent.ownerPrepare(action));
    const r = await agent.ownerSubmit(p.correlationId, p.intent!, await signer.sign413(p.intent!.payload));
    return { prepared: p, result: r };
  };
  return { fake, chain, signer, signed, step, controls: fake.controls, setNow: (t: number) => (now = t), now: () => now };
}

type World = ReturnType<typeof world>;

/** Up to a ready contract Organization: created, consented, granted, policy edited, funded (each optional). */
async function onboard(w: World, o: { grant?: boolean; policy?: boolean; fund?: bigint; end?: number; org?: string } = {}) {
  const { fake, signed, step } = w;
  const org = o.org ?? "ct-1";
  const end = o.end ?? T0 + 21 * DAY;
  const setup = must(await fake.setup(await signed(fake.setupMessage({ organization: org, owner: OWNER, expiresAt: new Date(w.now() + 30 * 60_000).toISOString() }))));
  const agent = fake.agent(org, setup.agent);
  must((await step(agent, { type: "agent_create", owner: { type: "near", account_id: OWNER, public_key: w.signer.publicKey }, role: "payout" })).result);
  const agentId = must(await fake.identity(setup.agent)).agentId!;
  must(await fake.submitConsent(await signed(fake.consentMessage({ organization: org, owner: OWNER, agent: setup.agent, agentId, scopes: ["payout"], expiresAt: new Date(end).toISOString() }))));
  must(await fake.submitConsent(await signed(fake.consentMessage({ organization: org, owner: OWNER, agent: setup.agent, agentId, scopes: ["owner", "read"], expiresAt: new Date(end + 14 * DAY).toISOString() }))));
  if (o.grant !== false) must((await step(agent, { type: "grant_issue", label: "payout" })).result);
  if (o.policy !== false) {
    const ov = must(await agent.overview());
    must((await step(agent, {
      type: "policy_update",
      expectedPolicy: { revision: ov.revision!, digest: ov.digest! },
      changes: {
        withdrawals: [{ address: PAYEE }],
        owner_approval: true,
        limits: { per_transaction: { [USDC]: LARGEST.toString() }, daily: { [USDC]: TOTAL.toString() }, monthly: { [USDC]: TOTAL.toString() } },
        budget: { daily_usd: "840", weekly_usd: null, monthly_usd: "840" },
      },
    })).result);
  }
  if (o.fund !== undefined) await w.controls.fund(agentId, o.fund.toString());
  const ov = must(await agent.overview());
  const reviewed: Reviewed = { revision: ov.revision!, digest: ov.digest! };
  const ask = (requestId: string, amount: bigint | string, recipient = PAYEE, expectedPolicy = reviewed) =>
    agent.requestPayout({ requestId, recipient, amount: amount.toString(), expectedPolicy });
  return { org, agent, name: setup.agent, agentId, reviewed, ask, setupConsent: setup.consent };
}

async function heldVote(w: World, agent: AgentHandle, correlationId: string, verdict: "approve" | "reject") {
  const h = must(await agent.held()).find((x) => x.correlationId === correlationId)!;
  return w.step(agent, { type: "approval_vote", approvalId: h.approvalId, verdict, correlationId });
}

describe("FakePlatform: the whole money path (same scenario as demo:stack)", () => {
  test("platformScenario passes on makePlatform({mode:'fake'})", async () => {
    const kit = makePlatform({ mode: "fake", deployment: "covenant", now: () => new Date() });
    const lines: string[] = [];
    const end = new Date(Date.now() + 21 * DAY).toISOString();
    const r = await platformScenario({
      kit, controls: kit.controls!, signer: kit.devSigner!, owner: OWNER, payee: PAYEE, attacker: ATTACKER, organization: "ct-scn",
      total: TOTAL, largest: LARGEST, end, now: () => new Date(), log: (l) => lines.push(l), pollMs: 1,
    });
    expect(r.failures).toEqual([]);
    expect(kit.platform.mode).toBe("fake");
  });
});

describe("FakePlatform: setup and consents", () => {
  test("setup checks the NEP-413 signature, host, expiry and the owner's full-access key", async () => {
    const w = world();
    const msg = w.fake.setupMessage({ organization: "o", owner: OWNER, expiresAt: new Date(T0 + 30 * 60_000).toISOString() });
    const good = await w.signed(msg);
    expect(await w.fake.setup({ ...good, signature: (await w.signed("other")).signature })).toMatchObject({ ok: false, kind: "refused", code: "signature_invalid" });
    const stranger = KeySigner.random();
    expect(await w.fake.setup(await w.signed(msg, stranger))).toMatchObject({ ok: false, kind: "forbidden", code: "owner_key" });
    const long = w.fake.setupMessage({ organization: "o", owner: OWNER, expiresAt: new Date(T0 + 2 * 3_600_000).toISOString() });
    expect(await w.fake.setup(await w.signed(long))).toMatchObject({ ok: false, code: "too_long" });
    const first = must(await w.fake.setup(good));
    expect(first.consent).toMatchObject({ agentId: "unborn", scopes: ["owner"], revoked: false });
    expect(must(await w.fake.setup(good)).agent).toBe(first.agent); // the same signed body is idempotent
    expect(must(await w.fake.identity(first.agent))).toEqual({ agentId: null, created: false, owner: OWNER });
  });

  test("agent_create must name the key that signed the setup", async () => {
    const w = world();
    const setup = must(await w.fake.setup(await w.signed(w.fake.setupMessage({ organization: "o", owner: OWNER, expiresAt: new Date(T0 + 60_000).toISOString() }))));
    const agent = w.fake.agent("o", setup.agent);
    const other = KeySigner.random();
    expect(await agent.ownerPrepare({ type: "agent_create", owner: { type: "near", account_id: OWNER, public_key: other.publicKey }, role: "payout" })).toMatchObject({ ok: false, kind: "forbidden", code: "setup_key" });
  });

  test("the setup consent only follows creation; reads need a consent naming the created agent", async () => {
    const w = world();
    const setup = must(await w.fake.setup(await w.signed(w.fake.setupMessage({ organization: "o", owner: OWNER, expiresAt: new Date(T0 + 60_000).toISOString() }))));
    const agent = w.fake.agent("o", setup.agent);
    const { prepared } = await w.step(agent, { type: "agent_create", owner: { type: "near", account_id: OWNER, public_key: w.signer.publicKey }, role: "payout" });
    expect(must(await agent.ownerStatus(prepared.correlationId))).toEqual({ stage: "submitted", status: "SUCCESS", failureCode: null });
    expect(await agent.overview()).toMatchObject({ ok: false, kind: "forbidden", code: "agent_changed" });
    expect(await w.fake.agent("other-org", setup.agent).overview()).toMatchObject({ ok: false, kind: "forbidden", code: "no_consent" });
  });

  test("consents expire on the fake's own clock: forbidden `scope` for sends while [owner,read] lives, `no_consent` after", async () => {
    const w = world();
    const c = await onboard(w, { fund: TOTAL });
    w.controls.advance(21 * DAY + 1);
    expect(await c.ask("after-end-1", 1_000_000n)).toMatchObject({ ok: false, kind: "forbidden", code: "scope" });
    expect(await c.agent.payoutStatus("x")).toMatchObject({ ok: true }); // a read since SDK 0.5.6: the app follows its own requests
    expect((await c.agent.held()).ok).toBe(true); // held is a read too
    w.controls.advance(14 * DAY);
    expect(await c.agent.overview()).toMatchObject({ ok: false, kind: "forbidden", code: "no_consent" });
    const consents = must(await w.fake.listConsents(c.org));
    expect(consents.length).toBe(3);
    expect(consents.every((x) => typeof x.expiresAt === "string" && x.expiresAt.endsWith("Z"))).toBe(true);
  });

  test("a removed key ends the consents it signed (consent_revoked)", async () => {
    const w = world();
    const c = await onboard(w, { fund: TOTAL });
    w.chain.removeKey(OWNER, w.signer.publicKey);
    expect(await c.agent.overview()).toMatchObject({ ok: false, kind: "forbidden", code: "consent_revoked" });
  });

  test("a consent must name the created agent's current id and last at most 366 days", async () => {
    const w = world();
    const c = await onboard(w);
    const msg = (agentId: string, ms: number) => w.fake.consentMessage({ organization: c.org, owner: OWNER, agent: c.name, agentId, scopes: ["read"], expiresAt: new Date(T0 + ms).toISOString() });
    expect(await w.fake.submitConsent(await w.signed(msg("f".repeat(64), DAY)))).toMatchObject({ ok: false, code: "agent_mismatch" });
    expect(await w.fake.submitConsent(await w.signed(msg(c.agentId, 367 * DAY)))).toMatchObject({ ok: false, code: "too_long" });
  });
});

describe("FakePlatform: owner actions", () => {
  test("the policy edit: withdrawals only → actions [withdraw]; owner_approval, three limits and three budget windows as signed", async () => {
    const w = world();
    const c = await onboard(w);
    const p = w.controls.policyOf(c.agentId)!;
    expect(p.actions).toEqual(["withdraw"]);
    expect(p.destinations.list).toEqual([{ action: "withdraw", chain: "near", address: PAYEE, memo: null }]);
    expect(p.owner_approval).toBe(true);
    expect(p.limits).toEqual({ per_transaction: { [USDC]: "500000000" }, daily: { [USDC]: "800000000" }, monthly: { [USDC]: "800000000" } });
    expect(p.budget).toEqual({ daily_usd: "840", weekly_usd: null, monthly_usd: "840" });
    const ov = must(await c.agent.overview());
    expect(ov).toMatchObject({ status: "APPLIED", synced: true, notInForce: null, revision: 2 });
    expect(ov.policy!.withdrawals).toEqual([PAYEE]);
    expect(ov.grants).toMatchObject([{ label: "payout", revoked: false }]);
  });

  test("applyChanges keeps withdrawals on an edit that doesn't name them", () => {
    const base = applyChanges(
      { frozen: false, actions: ["transfer"], confidential: true, owner_approval: true, assets: [USDC], limits: {}, max_actions_per_hour: 10,
        destinations: { mode: "only", list: [] }, budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, timelock_ms: 0 },
      { withdrawals: [{ address: PAYEE }] },
    );
    expect(applyChanges(base, { owner_approval: false }).actions).toEqual(["withdraw"]);
    expect(applyChanges(base, { withdrawals: [] }).actions).toEqual([]);
  });

  test("a stale review is refused at prepare", async () => {
    const w = world();
    const c = await onboard(w);
    expect(await c.agent.ownerPrepare({ type: "policy_update", expectedPolicy: { revision: 1, digest: c.reviewed.digest }, changes: { owner_approval: true } }))
      .toMatchObject({ ok: false, kind: "refused", code: "reviewed_policy_changed" });
  });

  test("a signature by another key is refused at submit", async () => {
    const w = world();
    const c = await onboard(w);
    const p = must(await c.agent.ownerPrepare({ type: "grant_issue", label: "payout" }));
    const other = KeySigner.random();
    w.chain.trustKey(other.publicKey);
    expect(await c.agent.ownerSubmit(p.correlationId, p.intent!, await other.sign413(p.intent!.payload))).toMatchObject({ ok: false, code: "signature_invalid" });
  });

  test("agent_freeze comes back as a confirm link; completing it freezes the agent (policy not in force)", async () => {
    const w = world();
    const c = await onboard(w, { fund: TOTAL });
    const p = must(await c.agent.ownerPrepare({ type: "agent_freeze" }));
    expect(p.intent).toBeUndefined();
    expect(p.confirm!.url).toStartWith(`https://${w.fake.host}/confirm/`);
    await w.controls.completeConfirm(p.confirm!.url);
    expect(must(await c.agent.ownerStatus(p.correlationId)).status).toBe("SUCCESS");
    const ov = must(await c.agent.overview());
    expect(ov.notInForce).toBe("the agent is frozen");
    expect(must(await c.ask("frozen-1", 1_000_000n, PAYEE, { revision: ov.revision!, digest: ov.digest! }))).toMatchObject({ state: "refused", code: "policy_not_in_force" });
  });
});

describe("FakePlatform: payout rules", () => {
  test("recorded refusals: grant_missing, payee_not_agreed, per_transaction_exceeded, reviewed_policy_changed, policy_not_in_force", async () => {
    const w = world();
    const noGrant = await onboard(w, { grant: false, fund: TOTAL, org: "a" });
    expect(must(await noGrant.ask("g-1", 1_000_000n))).toMatchObject({ state: "refused", code: "grant_missing" });
    expect(must(await noGrant.ask("g-1", 1_000_000n))).toMatchObject({ state: "refused", code: "grant_missing" }); // recorded: same id answers the same

    const c = await onboard(w, { fund: TOTAL, org: "b" });
    expect(must(await c.ask("r-1", 1_000_000n, ATTACKER))).toMatchObject({ state: "refused", code: "payee_not_agreed" });
    expect(must(await c.ask("r-2", LARGEST + 1n))).toMatchObject({ state: "refused", code: "per_transaction_exceeded" });
    expect(must(await c.ask("r-3", 1_000_000n, PAYEE, { revision: 1, digest: c.reviewed.digest }))).toMatchObject({ state: "refused", code: "reviewed_policy_changed" });
    w.controls.setPolicyStatus(c.agentId, "SIGNED", false);
    expect(must(await c.ask("r-4", 1_000_000n))).toMatchObject({ state: "refused", code: "policy_not_in_force" });
    expect(await w.controls.transfers()).toEqual([]);
  });

  test("insufficient_balance counts payouts already held; duplicate_held_payout refuses the same payee+amount", async () => {
    const w = world();
    const c = await onboard(w, { fund: TOTAL });
    expect(must(await c.ask("p-1", 400_000_000n)).state).toBe("held");
    expect(must(await c.ask("p-2", 400_000_000n))).toMatchObject({ state: "refused", code: "duplicate_held_payout" });
    expect(must(await c.ask("p-3", 400_000_001n))).toMatchObject({ state: "refused", code: "insufficient_balance" });
    expect(must(await c.ask("p-4", 399_999_999n)).state).toBe("held");
    expect(must(await c.agent.overview()).usdc).toBe(TOTAL.toString()); // held money is still in the balance
  });

  test("spend_budget_exceeded once the USD window is used up", async () => {
    const w = world();
    const c = await onboard(w, { fund: 2_000_000_000n });
    expect(must(await c.ask("b-1", 500_000_000n)).state).toBe("held");
    expect(must(await c.ask("b-2", 340_000_001n))).toMatchObject({ state: "refused", code: "spend_budget_exceeded" });
  });

  test("requestId idempotency and request_conflict", async () => {
    const w = world();
    const c = await onboard(w, { fund: TOTAL });
    const a = must(await c.ask("id-1", 100_000_000n));
    expect(must(await c.ask("id-1", 100_000_000n))).toEqual(a);
    expect(await c.ask("id-1", 100_000_001n)).toEqual({ ok: false, kind: "refused", code: "request_conflict" });
    expect((await w.controls.transfers()).length).toBe(1);
  });

  test("recipient_not_registered is thrown before recording; the same id succeeds after registration", async () => {
    const w = world();
    const c = await onboard(w, { fund: TOTAL });
    w.chain.setRegistered(PAYEE, false);
    expect(await c.ask("reg-1", 100_000_000n)).toEqual({ ok: false, kind: "refused", code: "recipient_not_registered" });
    expect(must(await c.agent.payoutStatus("reg-1")).state).toBe("not_found");
    w.chain.setRegistered(PAYEE, true);
    expect(must(await c.ask("reg-1", 100_000_000n)).state).toBe("held");
    w.chain.setMissing("ghost.near", true);
    expect(await c.ask("reg-2", 1n, "ghost.near")).toEqual({ ok: false, kind: "refused", code: "recipient_not_found" });
  });

  test("no memo is accepted", async () => {
    const w = world();
    const c = await onboard(w, { fund: TOTAL });
    const r = await c.agent.requestPayout({ requestId: "m-1", recipient: PAYEE, amount: "1", expectedPolicy: c.reviewed, memo: "x" } as never);
    expect(r).toEqual({ ok: false, kind: "refused", code: "memo_not_allowed" });
    expect(Object.keys(w.controls.requests().at(-1)!).sort()).toEqual(["amount", "expectedPolicy", "memo", "recipient", "requestId"]);
  });
});

describe("FakePlatform: held → vote → outcome", () => {
  test("approve: held → processing → settled → succeeded; terms proven at prepare; owner/status reads `submitting`", async () => {
    const w = world();
    const c = await onboard(w, { fund: TOTAL });
    const a = must(await c.ask("ok-1", LARGEST));
    expect(a).toMatchObject({ state: "held", status: "PENDING_APPROVAL" });
    const ps = must(await c.agent.paymentStatus(a.correlationId!));
    expect(ps).toMatchObject({ status: "PENDING_APPROVAL", approvalId: expect.any(String), expiresAt: expect.any(String) });
    const { prepared, result } = await heldVote(w, c.agent, a.correlationId!, "approve");
    expect(prepared.payment).toEqual({ correlationId: a.correlationId!, verdict: "approve", terms: { recipient: PAYEE, asset: USDC, amount: LARGEST.toString(), chain: "near" } });
    expect(must(result)).toEqual({ status: "PROCESSING", failureCode: null });
    expect(must(await c.agent.ownerStatus(prepared.correlationId))).toEqual({ stage: "submitting", status: null, failureCode: null });
    expect(must(await c.agent.payoutStatus("ok-1")).state).toBe("processing");
    await w.controls.settle(a.correlationId!);
    expect(must(await c.agent.payoutStatus("ok-1")).state).toBe("succeeded");
    expect(must(await c.agent.paymentStatus(a.correlationId!)).evidence.txHash).toStartWith("FAKE-");
    expect(must(await c.agent.overview()).usdc).toBe((TOTAL - LARGEST).toString());
    expect(await w.controls.transfers()).toEqual([{ recipient: PAYEE, amount: LARGEST.toString(), status: "SUCCESS" }]);
  });

  test("after-read auto-settle: processing once, then succeeded", async () => {
    const w = world("after-read");
    const c = await onboard(w, { fund: TOTAL });
    const a = must(await c.ask("as-1", 1_000_000n));
    await heldVote(w, c.agent, a.correlationId!, "approve");
    expect(must(await c.agent.payoutStatus("as-1")).state).toBe("processing");
    expect(must(await c.agent.payoutStatus("as-1")).state).toBe("succeeded");
  });

  test("reject: failed, rejected_by_owner, no tx, nothing moved", async () => {
    const w = world();
    const c = await onboard(w, { fund: TOTAL });
    const a = must(await c.ask("rj-1", 300_000_000n));
    const { prepared, result } = await heldVote(w, c.agent, a.correlationId!, "reject");
    expect(prepared.payment).toEqual({ correlationId: a.correlationId!, verdict: "reject", terms: null });
    expect(must(result)).toEqual({ status: "FAILED", failureCode: "rejected_by_owner" });
    expect(must(await c.agent.ownerStatus(prepared.correlationId))).toEqual({ stage: "submitted", status: "FAILED", failureCode: "rejected_by_owner" });
    expect(must(await c.agent.payoutStatus("rj-1")).state).toBe("failed");
    const ps = must(await c.agent.paymentStatus(a.correlationId!));
    expect(ps.failureCode).toBe("rejected_by_owner");
    expect(ps.evidence.txHash).toBeNull();
    expect(must(await c.agent.overview()).usdc).toBe(TOTAL.toString());
    expect(must(await c.agent.held())).toEqual([]);
  });

  test("failAfterApproval: an approved payout ends failed with that code and a tx", async () => {
    const w = world();
    const c = await onboard(w, { fund: TOTAL });
    const a = must(await c.ask("fa-1", 100_000_000n));
    w.controls.failAfterApproval("delivery_failed");
    await heldVote(w, c.agent, a.correlationId!, "approve");
    await w.controls.settle(a.correlationId!);
    expect(must(await c.agent.payoutStatus("fa-1")).state).toBe("failed");
    const ps = must(await c.agent.paymentStatus(a.correlationId!));
    expect(ps).toMatchObject({ status: "FAILED", failureCode: "delivery_failed" });
    expect(ps.evidence.txHash).not.toBeNull();
  });

  test("an approval the current policy no longer allows is refused at the vote", async () => {
    const w = world();
    const c = await onboard(w, { fund: TOTAL });
    const a = must(await c.ask("pc-1", 100_000_000n));
    const ov = must(await c.agent.overview());
    must((await w.step(c.agent, { type: "policy_update", expectedPolicy: { revision: ov.revision!, digest: ov.digest! }, changes: { withdrawals: [{ address: "other.near" }] } })).result);
    const h = must(await c.agent.held())[0]!;
    expect(await c.agent.ownerPrepare({ type: "approval_vote", approvalId: h.approvalId, verdict: "approve", correlationId: a.correlationId! }))
      .toMatchObject({ ok: false, kind: "refused", code: "payee_not_agreed" });
  });
});

describe("FakePlatform: lost replies and outages", () => {
  test("dropNextReply → unknown; the payout exists, re-reading finds it, exactly one transfer", async () => {
    const w = world();
    const c = await onboard(w, { fund: TOTAL });
    w.controls.dropNextReply();
    expect(await c.ask("lost-1", 100_000_000n)).toMatchObject({ ok: false, kind: "unknown" });
    expect(must(await c.agent.payoutStatus("lost-1")).state).toBe("held");
    expect(must(await c.ask("lost-1", 100_000_000n)).state).toBe("held");
    expect((await w.controls.transfers()).length).toBe(1);
  });

  test("dropNextReply on a vote submit → unknown, but the vote took effect", async () => {
    const w = world();
    const c = await onboard(w, { fund: TOTAL });
    const a = must(await c.ask("lv-1", 100_000_000n));
    w.controls.dropNextReply();
    const { result } = await heldVote(w, c.agent, a.correlationId!, "reject");
    expect(result).toMatchObject({ ok: false, kind: "unknown" });
    expect(must(await c.agent.payoutStatus("lv-1")).state).toBe("failed");
  });

  test("setUnavailable: reads unavailable, a request unknown and unrecorded → not_found → the same id is held", async () => {
    const w = world();
    const c = await onboard(w, { fund: TOTAL });
    w.controls.setUnavailable(true);
    expect(await c.agent.overview()).toMatchObject({ ok: false, kind: "unavailable" });
    expect(await c.ask("out-1", 100_000_000n)).toMatchObject({ ok: false, kind: "unknown" });
    expect(await c.agent.payoutStatus("out-1")).toMatchObject({ ok: false, kind: "unavailable" });
    w.controls.setUnavailable(false);
    expect(must(await c.agent.payoutStatus("out-1")).state).toBe("not_found");
    expect(must(await c.ask("out-1", 100_000_000n)).state).toBe("held");
    expect((await w.controls.transfers()).length).toBe(1);
  });
});

describe("SdkPlatform mapping (stub fetch)", () => {
  const CREDENTIAL = "tap_secret_credential_value";
  function stub(handler: (path: string, body: any) => { status: number; json: unknown }) {
    const seen: { path: string; body: any; auth: string | null }[] = [];
    const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ path: url.pathname, body, auth: new Headers(init?.headers).get("authorization") });
      const r = handler(url.pathname, body);
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { send, seen };
  }

  test("requestPayout sends a withdrawal to chain near with no memo; the credential is only in the header", async () => {
    const { send, seen } = stub(() => ({ status: 200, json: { json: { requestId: "r1", state: "held", status: "PENDING_APPROVAL", correlationId: "c1", code: null } } }));
    const p = new SdkPlatform({ url: "https://platform.example", credential: CREDENTIAL, deployment: "covenant", fetch: send });
    const r = await p.agent("o", "a").requestPayout({ requestId: "r1", recipient: PAYEE, amount: "5", expectedPolicy: { revision: 2, digest: `sha256:${"0".repeat(64)}` } });
    expect(r).toEqual({ ok: true, value: { requestId: "r1", state: "held", status: "PENDING_APPROVAL", correlationId: "c1", code: null } });
    const sent = seen[0]!;
    expect(sent.path).toBe("/apps/v1/o/o/a/a/rpc/payouts/request");
    const body = sent.body.json ?? sent.body;
    expect(body).toEqual({ requestId: "r1", asset: USDC, delivery: { chain: "near" }, recipient: PAYEE, amount: "5", expectedPolicy: { revision: 2, digest: `sha256:${"0".repeat(64)}` } });
    expect("memo" in body).toBe(false);
    expect(sent.auth).toBe(`Bearer ${CREDENTIAL}`);
    expect(JSON.stringify(r)).not.toContain(CREDENTIAL);
  });

  test("consents: epoch ms → ISO; failures map to the port kinds", async () => {
    const consent = { id: "c", deployment: "covenant", host: "platform.example", organization: "o", owner: OWNER, agent: "a", agentId: "x", scopes: ["payout"], expiresAt: T0, createdAt: T0, publicKey: "ed25519:k", revoked: false, revokedAt: null };
    const { send } = stub((path) => (path === "/apps/v1/consents" ? { status: 200, json: { consents: [consent] } } : { status: 403, json: { error: "no", code: "no_consent" } }));
    const p = new SdkPlatform({ url: "https://platform.example", credential: CREDENTIAL, deployment: "covenant", fetch: send });
    expect(must(await p.listConsents("o"))).toEqual([{ id: "c", agentId: "x", scopes: ["payout"], expiresAt: new Date(T0).toISOString(), publicKey: "ed25519:k", revoked: false }]);
    expect(p.host).toBe("platform.example");
    expect(toFail({ ok: false, kind: "forbidden", code: "scope" })).toEqual({ ok: false, kind: "forbidden", code: "scope" });
    expect(toFail({ ok: false, kind: "session" })).toEqual({ ok: false, kind: "session" });
    expect(toFail({ ok: false, kind: "rate_limited" })).toEqual({ ok: false, kind: "rate_limited", retryAfterSeconds: null });
    expect(toFail({ ok: false, kind: "unknown", httpStatus: 503 })).toEqual({ ok: false, kind: "unknown", detail: "HTTP 503" });
    expect(toFail({ ok: false, kind: "refused", code: "request_conflict", status: 409 })).toEqual({ ok: false, kind: "refused", code: "request_conflict" });
    expect(toFail({ ok: false, kind: "provider", code: "x", error: "e" })).toEqual({ ok: false, kind: "provider", detail: "x" });
  });

  test("grant_issue goes out with the configured label (the stack accepts only `invoices`)", async () => {
    const { send, seen } = stub(() => ({ status: 500, json: {} }));
    const p = new SdkPlatform({ url: "https://platform.example", credential: CREDENTIAL, deployment: "covenant", fetch: send, grantLabel: "invoices" });
    await p.agent("o", "a").ownerPrepare({ type: "grant_issue", label: "payout" });
    const body = seen[0]!.body.json ?? seen[0]!.body;
    expect(body.action).toEqual({ type: "grant_issue", label: "invoices" });
  });
});

describe("signer", () => {
  test("the stack signer is the platform's published fixture key", () => {
    expect(stackSigner().publicKey).toBe("ed25519:9S2phg9fejcY4tCT3vp2id9zrwFatEU7d77hnZcxjxkQ");
    expect(KeySigner.fromSecretKey(STACK_TEST_KEY).publicKey).toBe(stackSigner().publicKey);
  });
});
