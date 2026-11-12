import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { endInstant, parseTerms, termsHash } from "../src/shared/terms";
import { setup, signTerms, START } from "./support/harness";
import { closeRestorationRuntime } from "./support/restoration-ledger";
import { consentMessage, parseConsentMessage } from "@multiagency/sdk";

const directories: string[] = [];
afterEach(() => { for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });
const request = { id: "original-setup", hash: "ab".repeat(32), description: "Offline DAO setup", votingUntil: START + 1000, proposal: null, proposalAndVote: null };

test("DAO ownership is part of signed v3 terms without changing legacy wallet terms", () => {
  const wallet = parseTerms(JOB_DEMO_TERMS);
  expect(wallet).not.toHaveProperty("agency_owner");
  const dao = parseTerms({ ...JOB_DEMO_TERMS, agency_owner: { type: "dao", account_id: "agency.sputnik-dao.near" } });
  expect(termsHash(dao)).not.toBe(termsHash(wallet));
  expect(termsHash(parseTerms(dao))).toBe(termsHash(dao));
});

test("unknown DAO filing retains its exact body and persisted request across runtime replacement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paperwork-dao-access-")); directories.push(directory);
  const database = join(directory, "job.sqlite");
  const ctx = await setup({ ...JOB_DEMO_TERMS, agency_owner: { type: "dao", account_id: "agency.sputnik-dao.near" } }, { DB_PATH: database });
  await signTerms(ctx);
  const messages: string[] = [], reads: string[] = [];
  let expired = false;
  Object.assign(ctx.stub, {
    daoSetup: {
      file: async (message: string) => { messages.push(message); return messages.length === 1 ? { ok: false, kind: "unknown" } : { ok: true, value: request }; },
      state: async (id: string) => { reads.push(id); return { ok: true, value: { state: expired ? "expired" : "pending" } }; },
    },
    daoConsent: { file: async () => { throw new Error("Unexpected consent filing"); }, state: async () => { throw new Error("Unexpected consent read"); } },
  });
  await expect(ctx.rt.engine.next(ctx.id)).rejects.toThrow();
  const step = await ctx.rt.engine.next(ctx.id);
  expect(step).toMatchObject({ kind: "dao_vote", request });
  expect(messages).toHaveLength(2); expect(messages[0]).toBe(messages[1]);
  expect(ctx.rt.engine.onboarding.agentRow(ctx.id)?.owner).toBe("agency.sputnik-dao.near");
  await closeRestorationRuntime(ctx.rt);
  const resumed = await createRuntime(loadConfig({ PLATFORM: "fake", GITHUB: "fake", JUDGE: "rules", DB_PATH: database }), { clockStart: START, kit: ctx.stub.kit() });
  try {
    resumed.clock.advance(60_000);
    expect(await resumed.engine.next(ctx.id)).toMatchObject({ kind: "dao_vote", request });
    expect(messages).toHaveLength(2);
    expect(reads.every(id => id === request.id)).toBe(true);
    expect((await resumed.engine.viewContract(ctx.id)).payouts).toHaveLength(0);
    expired = true;
    expect(await resumed.engine.next(ctx.id)).toMatchObject({ kind: "wait" });
    expect(resumed.engine.onboarding.agentRow(ctx.id)?.pending_sign).toBeNull();
  } finally { await closeRestorationRuntime(resumed); }
});

test("DAO payout consent is read/payout only and repeated reads retain the original proposal", async () => {
  const ctx = await setup({ ...JOB_DEMO_TERMS, agency_owner: { type: "dao", account_id: "agency.sputnik-dao.near" } });
  await signTerms(ctx);
  await expect(ctx.rt.engine.next(ctx.id)).rejects.toThrow("does not support");
  ctx.rt.engine.onboarding.setAgent(ctx.id, { agent: "fixture-agent", agent_id: "fixture-agent-id", stage: "needs_consent" });
  const messages: string[] = [];
  ctx.stub.consentMessage = input => consentMessage({ host: ctx.stub.host, deployment: ctx.stub.deployment, ...input });
  Object.assign(ctx.stub, {
    daoSetup: { file: async () => { throw new Error("Unexpected setup"); }, state: async () => { throw new Error("Unexpected setup"); } },
    daoConsent: {
      file: async (message: string) => { messages.push(message); return { ok: true, value: { ...request, id: "original-consent" } }; },
      state: async () => ({ ok: true, value: { state: "pending" } }),
    },
  });
  try {
    expect(await ctx.rt.engine.next(ctx.id)).toMatchObject({ kind: "dao_vote", request: { id: "original-consent" } });
    expect(await ctx.rt.engine.next(ctx.id)).toMatchObject({ kind: "dao_vote", request: { id: "original-consent" } });
    expect(messages).toHaveLength(1);
    expect(parseConsentMessage(messages[0]!)?.scopes).toEqual(["payout", "read"]);
    expect((await ctx.rt.engine.viewContract(ctx.id)).payouts).toHaveLength(0);
  } finally { await closeRestorationRuntime(ctx.rt); }
});

test("a DAO owner action refuses member wallet submission and waits for authoritative expiry", async () => {
  const ctx = await setup({ ...JOB_DEMO_TERMS, agency_owner: { type: "dao", account_id: "agency.sputnik-dao.near" } });
  await signTerms(ctx);
  await expect(ctx.rt.engine.next(ctx.id)).rejects.toThrow("does not support");
  ctx.rt.engine.onboarding.setAgent(ctx.id, { agent: "fixture-agent", stage: "needs_create" });
  const original = ctx.stub.agent.bind(ctx.stub);
  let expired = false, submitted = 0;
  ctx.stub.agent = (organization, agent) => ({ ...original(organization, agent),
    ownerPrepare: async () => ({ ok: true, value: { correlationId: "original-owner-action", expiresAt: new Date(START + 1000).toISOString(), summary: "Create DAO agent",
      dao: { owner: "derived-owner", transaction: { receiverId: "v1.signer", actions: [] }, proposal: null, proposalAndVote: null } } }),
    ownerSubmit: async () => { submitted++; throw new Error("DAO must not submit a wallet signature"); },
    ownerStatus: async () => ({ ok: true, value: { stage: "prepared", phase: expired ? "expired" : "open", status: "PREPARED", failureCode: null } }),
  });
  try {
    const a = ctx.rt.engine.onboarding.agentRow(ctx.id)!;
    const step = await ctx.rt.engine.onboarding.prepare(ctx.id, a, { type: "agent_create", role: "payout" });
    await expect(ctx.rt.engine.submitOwnerStep(step.correlation_id, { publicKey: "member-key", signature: "member-signature" })).rejects.toThrow();
    expect(submitted).toBe(0);
    ctx.rt.clock.advance(60_000);
    expect((await ctx.rt.engine.onboarding.pollStep(step.correlation_id)).state).toBe("prepared");
    expired = true;
    expect((await ctx.rt.engine.onboarding.pollStep(step.correlation_id)).state).toBe("expired");
  } finally { await closeRestorationRuntime(ctx.rt); }
});

test("post-job DAO observation consent extends reads without extending payout authority", async () => {
  const ctx = await setup({ ...JOB_DEMO_TERMS, agency_owner: { type: "dao", account_id: "agency.sputnik-dao.near" } });
  await signTerms(ctx);
  await expect(ctx.rt.engine.next(ctx.id)).rejects.toThrow("does not support");
  const payoutExpiry = endInstant(JOB_DEMO_TERMS);
  ctx.rt.engine.onboarding.setAgent(ctx.id, { agent: "fixture-agent", agent_id: "fixture-agent-id", stage: "needs_consent", payout_consent_id: "original-payout-consent", payout_consent_expires_at: payoutExpiry });
  let message = "";
  ctx.stub.consentMessage = input => consentMessage({ host: ctx.stub.host, deployment: ctx.stub.deployment, ...input });
  Object.assign(ctx.stub, {
    daoSetup: { file: async () => { throw new Error("Unexpected setup"); }, state: async () => { throw new Error("Unexpected setup"); } },
    daoConsent: {
      file: async (body: string) => { message = body; return { ok: true, value: { ...request, id: "read-grace-consent" } }; },
      state: async () => ({ ok: true, value: { state: "pending" } }),
    },
  });
  try {
    await ctx.rt.engine.next(ctx.id);
    const parsed = parseConsentMessage(message)!;
    expect(parsed.scopes).toEqual(["read"]);
    expect(Date.parse(parsed.expiresAt)).toBeGreaterThan(Date.parse(payoutExpiry));
    expect(ctx.rt.engine.onboarding.agentRow(ctx.id)).toMatchObject({ payout_consent_id: "original-payout-consent", payout_consent_expires_at: payoutExpiry });
  } finally { await closeRestorationRuntime(ctx.rt); }
});
