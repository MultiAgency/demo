// The whole Paperwork story over HTTP, shared by demo:e2e (platform stand-in) and demo:stack (local platform stack).
// It returns the failures; an empty list means every step passed.
import { DEMO_TERMS } from "../src/shared/demo";
import { toAtomic } from "../src/shared/money";
import type { ContractView, NextStep, PayoutView, VerifyView } from "../src/shared/views";
import type { ScenarioDriver } from "./scenario-driver";

export async function runScenario(d: ScenarioDriver, opts: { log?: (line: string) => void } = {}): Promise<string[]> {
  const out = opts.log ?? ((l: string) => console.log(l));
  const failures: string[] = [];
  let disputed = false;
  let step = 0;
  const log = (title: string, detail = "") => {
    step += 1;
    out(`\n${String(step).padStart(2, "0")}. ${title}${detail ? `\n    ${detail.split("\n").join("\n    ")}` : ""}`);
  };
  const check = (ok: boolean, label: string) => {
    out(`    ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failures.push(label);
    return ok;
  };
  async function api<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${d.base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json.error}`);
    return json as T;
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const contract = (id: string) => api<ContractView>("GET", `/contracts/${id}`);
  const payout = (c: ContractView, rid: string) => c.payouts.find((p) => p.request_id === rid);
  const live = (c: ContractView) => c.payouts.find((p) => p.kind === "payout" && (p.state === "held" || p.state === "processing" || p.state === "pending" || p.state === "unknown"));
  const lines = (p: PayoutView | undefined) => (p ? p.lines.map((l) => `${l.deliverable_id} $${l.amount_usd}`).join(", ") : "nothing");

  /** Owner signs a prepared step: NEP-413 with the owner's key, or the platform's confirm page. */
  async function ownerSign(cid: string, sign: { message: string; recipient: string; nonce: string } | null | undefined, confirm: { url: string } | null | undefined) {
    if (sign) {
      const s = await d.signer(d.rep).sign413({ message: sign.message, recipient: sign.recipient, nonce: sign.nonce });
      return api("POST", `/owner-steps/${cid}/submit`, { publicKey: s.publicKey, signature: s.signature });
    }
    if (confirm) {
      await api("POST", "/sim/confirm", { url: confirm.url });
      return api("GET", `/owner-steps/${cid}`);
    }
    throw new Error(`owner step ${cid} has nothing to sign`);
  }

  async function vote(id: string, rid: string, verdict: "approve" | "reject") {
    const v = await api("POST", `/payouts/${rid}/vote`, { verdict });
    await ownerSign(v.correlation_id, v.sign, v.confirm);
    return { v, c: await contract(id) };
  }

  /** Approve the live payout, settle it, and return the contract after the follow-up. */
  async function approveAndSettle(id: string, rid: string) {
    const { v, c } = await vote(id, rid, "approve");
    check(["processing", "paid"].includes(payout(c, rid)?.state ?? ""), `${rid}: approved with the owner's signature; the platform releases it (terms ${v.terms?.amount} → ${v.terms?.recipient})`);
    await api("POST", "/sim/settle", { request_id: rid });
    return contract(id);
  }

  try {
    out(`Paperwork · end-to-end scenario on the ${d.name === "fake" ? "platform stand-in (fake: no real funds, no network)" : "local MultiAgency platform stack"}`);
    const cfg = await api("GET", "/config");
    out(`Platform: ${cfg.platform} at ${cfg.host} · clock ${cfg.now} · judge: ${cfg.judge.kind}`);

    // 1. Draft and sign the scope
    const terms = {
      ...DEMO_TERMS,
      representative: { near_account: d.rep },
      contractor: { ...DEMO_TERMS.contractor, near_account: d.payee },
      payee: { chain: "near" as const, address: d.payee },
      start: d.termsWindow.start,
      end: d.termsWindow.end,
    };
    const created = await api("POST", "/contracts", terms);
    const id: string = created.id;
    log("Draft the job: a signed scope of deliverables", terms.scope.map((x) => `${x.id}  $${x.value_usd.padStart(4)}  ${x.title}`).join("\n"));
    let c = await contract(id);
    check(c.stage === "needs_signatures" && c.total_usd === "1000", `scope total $${c.total_usd}, organization ${c.organization}`);
    for (const role of ["representative", "contractor"] as const) {
      const req = await api("GET", `/contracts/${id}/signing-request?role=${role}`);
      const s = await d.signer(req.account_id).sign413({ message: req.message, recipient: req.recipient, nonce: req.nonce });
      c = await api("POST", `/contracts/${id}/signatures`, { role, signed: { account_id: req.account_id, public_key: s.publicKey, signature: s.signature, nonce: req.nonce }, contractor_token: created.contractor_token });
      log(`${role === "representative" ? "Representative" : "Contractor"} signs the terms hash`, `${req.account_id}: "${req.message.slice(0, 48)}…"`);
      check(!!c.signatures[role], "NEP-413 signature verified against a full-access key");
    }

    // 2. Onboarding: setup → create → two consents → grant → policy edit
    log("Set up the contract's own platform agent (one Organization per contract)");
    let next: NextStep = await api("POST", `/contracts/${id}/onboarding/next`);
    for (let i = 0; i < 60 && next.kind !== "done"; i++) {
      if (next.kind === "sign") {
        const s = await d.signer(next.sign.account_id).sign413(next.sign);
        out(`    · signed: ${next.label}`);
        next = await api("POST", `/contracts/${id}/onboarding/signed`, { step: next.step, nonce: next.sign.nonce, publicKey: s.publicKey, signature: s.signature });
      } else if (next.kind === "owner_step") {
        out(`    · owner step: ${next.label} (${next.action})`);
        await ownerSign(next.correlation_id, next.sign, next.confirm);
        next = await api("POST", `/contracts/${id}/onboarding/next`);
      } else {
        await sleep(Math.min(next.retry_ms, d.name === "fake" ? 10 : 2000));
        next = await api("POST", `/contracts/${id}/onboarding/next`);
      }
    }
    c = await contract(id);
    check(next.kind === "done" && c.stage === "needs_funding", `agent ${c.platform.agent_id} ready; policy revision ${c.platform.policy?.revision} applied: ${c.platform.policy?.applied}`);

    // 3. Fund exactly the scope total
    const dep = await api("POST", `/contracts/${id}/deposit`);
    await d.controls.fund(c.platform.agent_id!, toAtomic(c.total_usd, 6).toString());
    c = await contract(id);
    log("Fund the agent with exactly the scope total", `deposit address ${dep.address}${dep.memo ? ` memo ${dep.memo}` : ""}`);
    check(c.stage === "active" && c.platform.balance_usd === "1000", `balance $${c.platform.balance_usd} of $${c.total_usd}`);

    // 4. Verify
    let v: VerifyView = await api("GET", `/contracts/${id}/verify`);
    log("Contractor verifies what the platform enforces");
    check(v.overall === "green", `Verify ${v.overall}${v.overall === "green" ? "" : `: ${v.checks.filter((x) => !x.ok && !x.info).map((x) => x.id).join(", ")}`}`);

    // 5. First run: judged, capped at the largest deliverable, held for approval
    let run = await api("POST", `/contracts/${id}/run`);
    log(
      "The agent judges merged PRs against the scope",
      [
        ...run.judgment.prs.map((p: any) => `${p.eligible && p.deliverable ? "→ " + p.deliverable : "✗   "}  ${p.key} ${p.title}${p.eligible && p.deliverable ? "" : ` — ${p.reason}`}`),
        ...run.judgment.deliverables.map((x: any) => `${x.id} completion ${x.completion * 100}%`),
      ].join("\n"),
    );
    let p1: PayoutView = run.payouts[0];
    check(run.outcome === "requested" && p1?.state === "held" && p1.amount_usd === "500", `owes $650; requests $${p1?.amount_usd} (the per-payment cap) for ${lines(p1)}; held for approval`);
    c = await approveAndSettle(id, p1.request_id);
    check(payout(c, p1.request_id)?.state === "paid", `${p1.request_id} settled to ${d.payee}`);
    let p2 = live(c);
    check(!!p2 && p2.seq === 2 && p2.amount_usd === "150" && p2.state === "held", `the rest of the same judgment, $${p2?.amount_usd} for ${lines(p2)}, is requested as seq 2 and held`);
    if (p2) c = await approveAndSettle(id, p2.request_id);
    check(c.paid_usd === "650" && c.open_judgment === null && (c.judgment as any)?.outcome === "approved", `paid $${c.paid_usd}; judgment approved`);

    // 6. A merge finishes d2
    let merged = (await api("POST", "/sim/merge", { contract_id: id })).merged;
    run = await api("POST", `/contracts/${id}/run`);
    log("A new PR is merged", `${merged.title} (#${merged.number})`);
    p1 = run.payouts[0];
    check(p1?.amount_usd === "100" && lines(p1) === "d2 $100", `requests only the difference: ${lines(p1)}`);
    if (p1) c = await approveAndSettle(id, p1.request_id);
    check(c.paid_usd === "750", `paid $${c.paid_usd}`);

    // 7. A prompt-injected merge: held, the approver sees the flag and rejects
    merged = (await api("POST", "/sim/merge", { contract_id: id })).merged;
    run = await api("POST", `/contracts/${id}/run`);
    log("A merged PR hides instructions for the AI reviewer", `${merged.title} (#${merged.number})`);
    p1 = run.payouts[0];
    const flagged = p1?.prs.filter((p) => p.flags.length > 0) ?? [];
    check(p1?.state === "held" && flagged.length > 0, `held for approval; the card leads with ${flagged.map((p) => `${p.key} [${p.flags.join(", ")}]`).join("; ") || "no flags"}`);
    if (p1) {
      const r = await vote(id, p1.request_id, "reject");
      c = r.c;
      const rejected = payout(c, p1.request_id);
      if (rejected?.state === "failed" && rejected.vote === "reject" && rejected.failure_code === "rejected_by_owner" && !rejected.never_executed) {
        log("The platform has not proven non-execution (G13): close review as disputed, retain the money hold");
        c = await api("POST", `/payouts/${p1.request_id}/resolve`, { outcome: "disputed" });
        disputed = true;
        check(payout(c, p1.request_id)?.state === "disputed" && (c.judgment as any)?.outcome === "disputed", "review is explicitly disputed, not a confirmed rejection or payment");
        check(c.paid_usd === "750" && c.committed_usd === "1000", "$750 confirmed paid; the unproven $250 remains committed under its original request");
      } else {
        check(rejected?.state === "rejected" && (c.judgment as any)?.outcome === "rejected", "rejection has positive non-execution proof; judgment rejected");
      }
    }
    run = await api("POST", `/contracts/${id}/run`);
    check(run.outcome === (disputed ? "deferred" : "nothing"), disputed ? "the disputed money outcome blocks another request; no replacement payment" : "the injected PR is excluded; the next run requests nothing");

    // 8. Compromised server: requests go straight to the platform
    log("Compromised server: Paperwork's own checks off, requests go straight to the platform");
    const redirect = await api("POST", `/contracts/${id}/attacks/redirect`);
    check(redirect.outcome === "refused" && redirect.code === "payee_not_agreed", `redirect: ${redirect.story} → ${redirect.code}${redirect.clause ? ` (${redirect.clause.title})` : ""}`);
    const overpay = await api("POST", `/contracts/${id}/attacks/overpay`);
    check(overpay.outcome === "refused" && overpay.code === "per_transaction_exceeded", `overpay: ${overpay.story} → ${overpay.code}${overpay.clause ? ` (${overpay.clause.title})` : ""}`);
    const injected = await api("POST", `/contracts/${id}/attacks/injected`);
    check(injected.outcome === "held", `injected in-cap: ${injected.story} → ${injected.note ?? injected.outcome}`);
    if (injected.outcome === "held") {
      const r = await vote(id, injected.payout.request_id, "reject");
      const rejected = payout(r.c, injected.payout.request_id);
      check(rejected?.state === "rejected" || (rejected?.state === "failed" && rejected.vote === "reject" && rejected.failure_code === "rejected_by_owner" && !rejected.never_executed), "the representative attempted rejection; only explicit proof can label it unexecuted");
    }

    // 9. The real completion of d3
    merged = (await api("POST", "/sim/merge", { contract_id: id })).merged;
    run = await api("POST", `/contracts/${id}/run`);
    log("The PR that actually finishes rate limiting is merged", `${merged.title} (#${merged.number})`);
    if (disputed) {
      c = await contract(id);
      check(run.outcome === "deferred" && run.payouts.length === 0, "new work cannot bypass the disputed original payment identity");
      check(c.paid_usd === "750" && c.committed_usd === "1000", "job review is closed as disputed: $750 paid, $250 held pending evidence; scope is not claimed fully paid");
    } else {
      p1 = run.payouts[0];
      check(p1?.amount_usd === "250", `requests ${lines(p1)}`);
      if (p1) c = await approveAndSettle(id, p1.request_id);
      check(c.paid_usd === "1000", `scope fully paid: $${c.paid_usd} of $${c.total_usd}`);
    }

    // 10. Verify and the platform's own record of transfers
    v = await api("GET", `/contracts/${id}/verify`);
    log("Verify again, and match the platform's transfers to approved payouts");
    check(v.overall === "green", `Verify ${v.overall}`);
    const transfers = (await d.controls.transfers()).filter((t) => t.status === "SUCCESS");
    const paidRows = c.payouts.filter((p) => p.kind === "payout" && p.state === "paid");
    const sum = transfers.reduce((n, t) => n + BigInt(t.amount), 0n);
    check(transfers.length === paidRows.length && transfers.every((t) => t.recipient === d.payee), `${transfers.length} settled transfers, one per approved payout, all to ${d.payee}`);
    check(sum === toAtomic(c.paid_usd, 6), `transfers sum to $${c.paid_usd}`);
    check(!transfers.some((t) => t.recipient === d.attacker), `nothing to ${d.attacker}`);

    // 11. After the end (the stand-in's clock can move; the stack's can't)
    if (d.name === "fake") {
      const after = new Date(Date.parse(`${d.termsWindow.end}T23:59:59Z`) + 86_400_000).toISOString();
      await api("POST", "/sim/advance", { to: after });
      const ended = await api("POST", `/contracts/${id}/attacks/after_end`);
      log("After the contract ends", ended.story);
      check(ended.outcome === "forbidden" && ended.code === "scope", `the payout consent has expired: forbidden (${ended.code})${ended.clause ? ` → ${ended.clause.title}` : ""}`);
    }
  } catch (err) {
    failures.push(String(err));
    out(`\n✗ ${err instanceof Error ? (err.stack ?? err.message) : err}`);
  }
  out(failures.length ? `\n✗ ${failures.length} step(s) failed:\n  - ${failures.join("\n  - ")}` : disputed ? "\n✓ All supported steps passed. Review is closed as disputed; unproven money stays committed and is not counted as paid." : "\n✓ All steps passed. Paid for the scope, never more, and only with the representative's approval.");
  return failures;
}
