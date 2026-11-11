/**
 * bun run demo:stack   (PLATFORM_STACK_DIR=<platform stack dir> required)
 *
 * Paperwork against the MultiAgency platform's isolated local stack: simulated provider, chain, signatures and
 * settlement; the real gateway, app routes, consents, policy and payout rules. Start the stack in the platform checkout:
 *   pnpm test:e2e:stack --app multiagency-paperwork --no-browser --owner acme.demo --payee maria.demo --builder attacker.demo
 * and pass the directory of the `state.json` it prints.
 *
 * This starts Paperwork (PLATFORM=remote, PLATFORM_STACK_DIR) and runs the shared `runScenario` (scripts/scenario.ts)
 * with the stack driver. `--platform-only` runs `platformScenario`: the same money path straight through the
 * `Platform` interface, which proves the SDK client end to end.
 * Exits non-zero on any failure.
 */
import { join } from "node:path";
import type { ScenarioDriver } from "./scenario-driver";
import { runScenario } from "./scenario";
import { makePlatform } from "../src/server/platform/index";
import type { AgentHandle, DemoControls, OwnerAction, OwnerSigner, PlatformKit, Res } from "../src/server/platform/port";
import { USDC } from "../src/server/platform/port";
import { stackSigner } from "../src/server/platform/signer";
import { StackControls, readStack } from "../src/server/platform/stack";

const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const usd = (atomic: string | bigint) => `$${(Number(atomic) / 1e6).toFixed(2)}`;

export interface PlatformScenarioInput {
  kit: Pick<PlatformKit, "platform" | "chain">;
  controls: DemoControls;
  signer: OwnerSigner;
  owner: string;
  payee: string;
  attacker: string;
  organization: string;
  /** Contract total and largest deliverable, atomic USDC. */
  total: bigint;
  largest: bigint;
  /** Contract end (ISO): the payout consent ends here. */
  end: string;
  now: () => Date;
  log?: (line: string) => void;
  pollMs?: number;
}

/**
 * One contract's money path through the `Platform` interface only (what Paperwork's engine does, without the engine):
 * setup → create → [payout] and [owner,read] consents → grant → one policy edit → fund the total → attacks refused →
 * a judged payout held → approved → settled → succeeded → the remainder held → rejected → failed, unpaid. Returns
 * the failures (empty = pass).
 */
export async function platformScenario(s: PlatformScenarioInput): Promise<{ failures: string[]; agentId: string | null; agent: string | null }> {
  const { platform, chain } = s.kit;
  const log = s.log ?? ((l: string) => console.log(l));
  const failures: string[] = [];
  const pollMs = s.pollMs ?? 200;
  const check = (cond: boolean, label: string) => {
    log(`    ${cond ? "✓" : "✗"} ${label}`);
    if (!cond) failures.push(label);
  };
  const must = <T>(r: Res<T>, label: string): T => {
    if (!r.ok) throw new Error(`${label}: ${JSON.stringify(r)}`);
    return r.value;
  };
  const poll = async <T>(f: () => Promise<Res<T>>, done: (t: T) => boolean, label: string, ms = 30_000): Promise<T> => {
    let last: Res<T> | undefined;
    for (const end = Date.now() + ms; Date.now() < end; await sleep(pollMs)) {
      last = await f();
      if (last.ok && done(last.value)) return last.value;
    }
    throw new Error(`timed out: ${label} (last ${JSON.stringify(last)})`);
  };
  const signed = async (message: string) => {
    const n = nonce();
    const sig = await s.signer.sign413({ message, recipient: platform.host, nonce: n });
    return { message, nonce: n, ...sig };
  };
  const ownerStep = async (agent: AgentHandle, action: OwnerAction, label: string) => {
    const prepared = must(await agent.ownerPrepare(action), `${label}: prepare`);
    if (!prepared.intent) throw new Error(`${label}: expected a NEP-413 intent, got a confirm link`);
    const sig = await s.signer.sign413(prepared.intent.payload);
    must(await agent.ownerSubmit(prepared.correlationId, prepared.intent, sig), `${label}: submit`);
    const st = await poll(() => agent.ownerStatus(prepared.correlationId), (v) => v.status === "SUCCESS" || v.status === "FAILED", `${label}: status`);
    check(st.status === "SUCCESS", `${label}: owner signed, platform applied (${prepared.summary})`);
    return prepared;
  };
  let agentId: string | null = null;
  let name: string | null = null;
  try {
    const now = s.now().getTime();
    log(`\n1. Set up the contract's own Organization "${s.organization}" (owner ${s.owner})`);
    const setup = must(await platform.setup(await signed(platform.setupMessage({ organization: s.organization, owner: s.owner, expiresAt: new Date(now + 30 * 60_000).toISOString() }))), "setup");
    name = setup.agent;
    check(setup.consent.agentId === "unborn" && setup.consent.scopes.join() === "owner", `setup reserved agent ${name}; setup consent scopes [owner]`);
    await poll(() => platform.identity(setup.agent), (v) => v.created === false, "identity created:false");
    const agent = platform.agent(s.organization, setup.agent);
    await ownerStep(agent, { type: "agent_create", owner: { type: "near", account_id: s.owner, public_key: setup.consent.publicKey }, role: "payout" }, "agent_create");
    agentId = (await poll(() => platform.identity(setup.agent), (v) => v.created && v.agentId !== null, "identity created")).agentId;
    check(!!agentId, `agent created: ${agentId}`);

    log("\n2. Two consents: [payout] until the end, [owner, read] for the end plus grace");
    const payoutConsent = must(await platform.submitConsent(await signed(platform.consentMessage({ organization: s.organization, owner: s.owner, agent: setup.agent, agentId: agentId!, scopes: ["payout"], expiresAt: s.end }))), "consent payout");
    const grace = new Date(Date.parse(s.end) + 14 * DAY).toISOString();
    must(await platform.submitConsent(await signed(platform.consentMessage({ organization: s.organization, owner: s.owner, agent: setup.agent, agentId: agentId!, scopes: ["owner", "read"], expiresAt: grace }))), "consent owner,read");
    check(payoutConsent.expiresAt === s.end, `payout consent ends with the contract: ${payoutConsent.expiresAt}`);
    const listed = must(await platform.listConsents(s.organization), "listConsents").filter((c) => c.agentId === agentId);
    check(listed.length === 2, `listConsents shows both consents for the agent`);

    log("\n3. Grant and the one policy edit");
    await ownerStep(agent, { type: "grant_issue", label: "payout" }, "grant_issue");
    const before = await poll(() => agent.overview(), (v) => v.status === "APPLIED", "policy applied");
    const total = s.total.toString(), largest = s.largest.toString();
    const budgetUsd = ((Number(s.total) / 1e6) * 1.05).toFixed(2);
    await ownerStep(agent, {
      type: "policy_update",
      expectedPolicy: { revision: before.revision!, digest: before.digest! },
      changes: {
        withdrawals: [{ address: s.payee }],
        owner_approval: true,
        limits: { per_transaction: { [USDC]: largest }, daily: { [USDC]: total }, monthly: { [USDC]: total } },
        budget: { daily_usd: budgetUsd, weekly_usd: null, monthly_usd: budgetUsd },
      },
    }, "policy_update");
    const ov = await poll(() => agent.overview(), (v) => v.notInForce === null && v.synced && (v.revision ?? 0) > (before.revision ?? 0), "policy in force");
    const p = ov.policy!;
    check(p.actions.join() === "withdraw", `actions == ["withdraw"] (got ${JSON.stringify(p.actions)})`);
    check(Array.isArray(p.assets) && p.assets.join() === USDC, "assets == [USDC]");
    check(p.withdrawals.join() === s.payee, `withdrawals == [${s.payee}]`);
    check(p.limits.per_transaction?.[USDC] === largest, `per-transaction cap ${usd(largest)}`);
    check(p.owner_approval && !p.frozen, "owner_approval on, not frozen");
    check(ov.grants.some((g) => !g.revoked && (g.label === "payout" || g.label === "invoices")), `live payout grant (label ${ov.grants.map((g) => g.label).join(",")})`);

    log(`\n4. Fund exactly the total, ${usd(total)}`);
    const dep = must(await agent.deposit(), "deposit");
    log(`    deposit address ${dep.address} memo ${dep.memo} min ${dep.minAmount}`);
    await s.controls.fund(agentId!, total);
    const funded = await poll(() => agent.overview(), (v) => v.usdc === total, "funded");
    const reviewed = { revision: funded.revision!, digest: funded.digest! };
    check(funded.usdc === total, `confidential balance ${usd(funded.usdc)}`);

    log("\n5. Attacks the policy refuses");
    const tag = Math.random().toString(36).slice(2, 12);
    const redirect = must(await agent.requestPayout({ requestId: `atk-redirect-${tag}`, recipient: s.attacker, amount: "1000000", expectedPolicy: reviewed }), "redirect");
    check(redirect.state === "refused" && redirect.code === "payee_not_agreed", `redirect to ${s.attacker}: ${redirect.state} ${redirect.code}`);
    const overpay = must(await agent.requestPayout({ requestId: `atk-overpay-${tag}`, recipient: s.payee, amount: (s.largest + 1n).toString(), expectedPolicy: reviewed }), "overpay");
    check(overpay.state === "refused" && overpay.code === "per_transaction_exceeded", `largest+1: ${overpay.state} ${overpay.code}`);

    log(`\n6. The judged payout ${usd(largest)}: held → owner approves → settled`);
    const rid = `${tag}-p1-1`;
    const p1 = must(await agent.requestPayout({ requestId: rid, recipient: s.payee, amount: largest, expectedPolicy: reviewed }), "request p1");
    check(p1.state === "held", `requestPayout ${rid}: ${p1.state}`);
    const again = must(await agent.requestPayout({ requestId: rid, recipient: s.payee, amount: largest, expectedPolicy: reviewed }), "request p1 again");
    check(again.correlationId === p1.correlationId && again.state === "held", "asked again under the same requestId: same payout, nothing new sent");
    const held = must(await agent.held(), "held").find((h) => h.correlationId === p1.correlationId);
    check(!!held, `held lists it (approval ${held?.approvalId})`);
    const ps = must(await agent.paymentStatus(p1.correlationId!), "paymentStatus held");
    check(ps.status === "PENDING_APPROVAL" && !!ps.expiresAt, `paymentStatus PENDING_APPROVAL, approval expires ${ps.expiresAt}`);
    const vote = must(await agent.ownerPrepare({ type: "approval_vote", approvalId: held!.approvalId, verdict: "approve", correlationId: p1.correlationId! }), "approve prepare");
    const t = vote.payment?.terms;
    check(!!t && t.recipient === s.payee && t.asset === USDC && t.amount === largest && (t.chain ?? "near") === "near", `vote terms proven by the platform: ${JSON.stringify(t)}`);
    const vs = await s.signer.sign413(vote.intent!.payload);
    const sub = must(await agent.ownerSubmit(vote.correlationId, vote.intent!, vs), "approve submit");
    check(sub.status === "PROCESSING", `owner/submit answered the released payment: ${sub.status}`);
    await poll(() => agent.payoutStatus(rid), (v) => v.state === "processing" || v.state === "succeeded", "processing");
    await s.controls.settle(p1.correlationId!);
    const done = await poll(() => agent.payoutStatus(rid), (v) => v.state === "succeeded" || v.state === "failed", "settled");
    check(done.state === "succeeded", `payouts/status ${rid}: ${done.state}`);

    const rest = s.total - s.largest;
    log(`\n7. The remainder ${usd(rest)} (seq 2, same judgment): held → owner rejects → failed, unpaid`);
    const rid2 = `${tag}-p2-1`;
    const p2 = must(await agent.requestPayout({ requestId: rid2, recipient: s.payee, amount: rest.toString(), expectedPolicy: reviewed }), "request p2");
    check(p2.state === "held", `requestPayout ${rid2}: ${p2.state}`);
    const held2 = must(await agent.held(), "held").find((h) => h.correlationId === p2.correlationId)!;
    const rej = must(await agent.ownerPrepare({ type: "approval_vote", approvalId: held2.approvalId, verdict: "reject", correlationId: p2.correlationId! }), "reject prepare");
    check(rej.payment?.terms === null, "reject vote carries no terms");
    const rsub = must(await agent.ownerSubmit(rej.correlationId, rej.intent!, await s.signer.sign413(rej.intent!.payload)), "reject submit");
    check(rsub.status === "FAILED" && rsub.failureCode === "rejected_by_owner", `owner/submit: ${rsub.status} ${rsub.failureCode}`);
    const failed = await poll(() => agent.payoutStatus(rid2), (v) => v.state === "failed", "rejected");
    const fps = must(await agent.paymentStatus(failed.correlationId!), "paymentStatus rejected");
    check(fps.failureCode === "rejected_by_owner" && fps.evidence.txHash === null, "rejected: failureCode rejected_by_owner, no tx");

    log("\n8. Prompt-injected in-cap payout: NOT stopped by policy — held for the owner, who rejects it");
    const inj = must(await agent.requestPayout({ requestId: `atk-injected-${tag}`, recipient: s.payee, amount: "1000000", expectedPolicy: reviewed }), "injected");
    check(inj.state === "held", `injected in-cap request: ${inj.state} (the approval is the second layer)`);
    const hi = must(await agent.held(), "held").find((h) => h.correlationId === inj.correlationId)!;
    const ij = must(await agent.ownerPrepare({ type: "approval_vote", approvalId: hi.approvalId, verdict: "reject", correlationId: inj.correlationId! }), "injected reject");
    must(await agent.ownerSubmit(ij.correlationId, ij.intent!, await s.signer.sign413(ij.intent!.payload)), "injected reject submit");
    check((await poll(() => agent.payoutStatus(`atk-injected-${tag}`), (v) => v.state === "failed", "injected rejected")).state === "failed", "injected payout rejected, unpaid");

    log("\n9. What moved");
    const final = must(await agent.overview(), "overview");
    check(final.usdc === rest.toString(), `balance ${usd(final.usdc)} = total − paid`);
    const transfers = (await s.controls.transfers()).filter((x) => x.status === "SUCCESS");
    const mine = transfers.filter((x) => x.recipient === s.payee && x.amount === largest);
    check(mine.length >= 1, `provider record: ${usd(largest)} to ${s.payee} SUCCESS`);
    check(!transfers.some((x) => x.recipient === s.attacker), `nothing to ${s.attacker}`);
    check(await chain.isFullAccessKey(s.owner, setup.consent.publicKey), "the owner's signing key is a full-access key on chain");
    check((await chain.isRegistered(USDC, s.payee)) === true, `${s.payee} is registered on the USDC contract (NEP-145)`);
  } catch (e) {
    failures.push(String(e instanceof Error ? e.message : e));
    log(`    ✗ ${String(e instanceof Error ? e.message : e)}`);
  }
  return { failures, agentId, agent: name };
}

/** The stack `ScenarioDriver` for `runScenario`. */
export function stackDriver(stackDir: string, base: string, now = new Date()): ScenarioDriver {
  const stack = readStack(stackDir);
  const day = (n: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n)).toISOString().slice(0, 10);
  const signer = stackSigner();
  return {
    name: "stack",
    base,
    signer: () => signer,
    controls: new StackControls(stackDir),
    termsWindow: { start: day(-7), end: day(21) },
    payee: stack.payees[0]!,
    rep: stack.owner,
    attacker: stack.builder ?? "attacker.demo",
  };
}

async function waitFor(url: string, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
  }
  throw new Error(`Paperwork did not come up at ${url}`);
}

async function main() {
  const stackDir = process.env.PLATFORM_STACK_DIR;
  if (!stackDir) throw new Error("Set PLATFORM_STACK_DIR to the platform stack directory (the folder holding state.json)");
  const stack = readStack(stackDir);
  const platformOnly = process.argv.includes("--platform-only");
  console.log(`Paperwork · MultiAgency local stack (${stack.url}) · SIMULATED provider, chain, signatures and settlement`);
  if (platformOnly) {
    console.log("Mode: platform-only (the Platform interface end to end, no Paperwork engine)");
    const now = new Date();
    const kit = makePlatform({ mode: "remote", deployment: stack.deployment, stackDir, now: () => new Date() });
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 21)).toISOString();
    const { failures } = await platformScenario({
      kit, controls: kit.controls!, signer: kit.devSigner!, owner: stack.owner, payee: stack.payees[0]!, attacker: stack.builder ?? "attacker.demo",
      organization: `ct-${Date.now().toString(36)}`, total: 800_000_000n, largest: 500_000_000n, end, now: () => new Date(),
    });
    console.log(failures.length ? `\nFAILED (${failures.length}):\n - ${failures.join("\n - ")}` : "\nPASS: every step held on the platform stack");
    process.exit(failures.length ? 1 : 0);
  }
  // Paperwork itself, as its own process, on the stack: PLATFORM=remote with the stack dir (dev only).
  const port = Number(process.env.PORT ?? 8781);
  const child = Bun.spawn(["bun", "src/server/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, PORT: String(port), PLATFORM: "remote", PLATFORM_STACK_DIR: stackDir, PLATFORM_DEPLOYMENT: stack.deployment },
    stdout: "inherit",
    stderr: "inherit",
  });
  try {
    const base = `http://localhost:${port}/api`;
    await waitFor(`${base}/config`);
    const failures = await runScenario(stackDriver(stackDir, base));
    console.log(failures.length ? `\nFAILED (${failures.length}):\n - ${failures.join("\n - ")}` : "\nPASS");
    process.exitCode = failures.length ? 1 : 0;
  } finally {
    child.kill();
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

