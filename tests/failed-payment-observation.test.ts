import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { PaymentStatus, PayoutAnswer, Res } from "../src/server/platform/port";
import { DEMO_TERMS, JOB_DEMO_TERMS } from "../src/shared/demo";
import { activate, castVote, type Ctx } from "./support/harness";

const contexts: Ctx[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await (await ctx.rt.auth.$context).checkSchema?.();
    (ctx.rt.engine as unknown as { d: { db: Database } }).d.db.close();
  }
});

/** Only status reads are scripted. No hosted calls, production records or real settlement are involved. */
function observeThrough(ctx: Ctx) {
  const reads = {
    payout: null as Res<PayoutAnswer> | null,
    payment: null as Res<PaymentStatus> | null,
    proof: false,
    payoutIds: [] as string[],
    paymentIds: [] as string[],
  };
  const originalAgent = ctx.stub.agent.bind(ctx.stub);
  ctx.stub.agent = (organization, agent) => {
    const handle = originalAgent(organization, agent);
    return {
      ...handle,
      payoutStatus: async (requestId) => {
        reads.payoutIds.push(requestId);
        if (reads.payout) return reads.payout;
        const result = await handle.payoutStatus(requestId);
        return result.ok && result.value.state === "failed"
          ? { ok: true, value: { ...result.value, neverExecuted: reads.proof } }
          : result;
      },
      paymentStatus: async (correlation) => {
        reads.paymentIds.push(correlation);
        return reads.payment ?? handle.paymentStatus(correlation);
      },
    };
  };
  return reads;
}

function payment(status: string, refundedAmount: string | null = null): Res<PaymentStatus> {
  return { ok: true, value: {
    status, failureCode: status === "FAILED" ? "delivery_outcome_unknown" : null,
    approvalId: null, expiresAt: null,
    evidence: { txHash: null, destinationTxHash: null, refundTxHash: null, refundTo: null, refundedAmount },
  } };
}

async function failedPayment(version: 2 | 3, { proof = false, txHash = null }: { proof?: boolean; txHash?: string | null } = {}) {
  const terms = version === 2 ? { ...DEMO_TERMS, scope: [DEMO_TERMS.scope[0]!] } : JOB_DEMO_TERMS;
  const ctx = await activate("300", terms);
  contexts.push(ctx);
  const engine = ctx.rt.engine;
  if (version === 2) await engine.run(ctx.id);
  else {
    const submitted = await engine.submitJob(ctx.id, {
      client_request_id: "observation-original-submission",
      report: "CSV export and acceptance evidence are ready for agency review.",
      evidence: [{ deliverable_id: "d1", label: "CSV export tests", url: "https://evidence.invalid/export" }],
      invoice: { number: "OBSERVATION-001", amount_usd: "300" },
    }, JOB_DEMO_TERMS.contractor.near_account);
    await engine.proposeJob(submitted.id);
  }
  const original = (await engine.viewContract(ctx.id)).payouts.find(item => item.kind === "payout")!;
  await castVote(ctx, original.request_id, "approve");
  const provider = ctx.stub.payouts.get(original.request_id)!;
  Object.assign(provider, { state: "failed", status: "FAILED", failureCode: "delivery_outcome_unknown", txHash });
  const reads = observeThrough(ctx);
  reads.proof = proof;
  await engine.getContract(ctx.id);
  const stored = engine.attempt(original.request_id);
  expect(stored.state).toBe("failed");
  expect(stored.never_executed).toBe(proof && txHash === null ? 1 : 0);
  expect(ctx.stub.calls.requestPayout).toBe(1);
  return { ctx, engine, original, provider, reads, correlation: stored.correlation_id!, judgment: stored.run_id! };
}

type FailedPayment = Awaited<ReturnType<typeof failedPayment>>;

async function expectOriginalCommitment(fixture: FailedPayment) {
  const { ctx, engine, original, correlation, judgment } = fixture;
  const view = await engine.viewContract(ctx.id);
  expect(engine.attempt(original.request_id)).toMatchObject({
    request_id: original.request_id, correlation_id: correlation, run_id: judgment,
    state: "failed", never_executed: 0, resolution: null,
  });
  expect(view.committed_usd).toBe("300");
  expect(view.paid_usd).toBe("0");
  expect(view.open_judgment?.id).toBe(judgment);
  expect(view.payouts.map(item => item.request_id)).toEqual([original.request_id]);
  await expect(engine.resolve(original.request_id, "reowe")).rejects.toThrow("platform proves it never executed");
  await expect(engine.retry(ctx.id)).rejects.toThrow();
  await expect(engine.drop(ctx.id)).rejects.toThrow();
  expect(ctx.stub.calls.requestPayout).toBe(1);
  expect([...ctx.stub.payouts.keys()]).toEqual([original.request_id]);
}

for (const foreign of ["request", "correlation", "same-refusal", "same-not-found"] as const) test(`processing payout retains its commitment on ${foreign}`, async () => {
  const ctx = await activate("300", JOB_DEMO_TERMS);
  contexts.push(ctx);
  const engine = ctx.rt.engine;
  const submission = await engine.submitJob(ctx.id, {
    client_request_id: "foreign-live-submission", report: "CSV export and tests are ready.",
    evidence: [{ deliverable_id: "d1", label: "Tests", url: "https://evidence.invalid/tests" }],
    invoice: { number: "LIVE-001", amount_usd: "300" },
  }, JOB_DEMO_TERMS.contractor.near_account);
  const proposed = await engine.proposeJob(submission.id);
  const original = proposed.payouts[0]!;
  await castVote(ctx, original.request_id, "approve");
  const correlation = engine.attempt(original.request_id).correlation_id!;
  const reads = observeThrough(ctx);
  reads.payout = { ok: true, value: {
    requestId: foreign === "request" ? "foreign-request" : original.request_id,
    correlationId: foreign === "correlation" ? "foreign-correlation" : correlation,
    state: foreign === "same-not-found" ? "not_found" : "refused", status: "REFUSED", code: "policy_denied",
  } };
  const observed = await engine.getContract(ctx.id);
  expect(engine.attempt(original.request_id).state).toBe("processing");
  expect(engine.attempt(original.request_id).correlation_id).toBe(correlation);
  expect(observed.committed_usd).toBe("300");
  await expect(engine.retry(ctx.id)).rejects.toThrow();
  expect(ctx.stub.calls.requestPayout).toBe(1);
  // A regressed request record may persist; settlement still follows the known payment.
  if (foreign === "request" || foreign === "correlation") reads.payout = null;
  ctx.stub.settle(correlation);
  const settled = await engine.getContract(ctx.id);
  expect(settled.paid_usd).toBe("300");
  expect(ctx.stub.transfers).toHaveLength(1);
});

for (const version of [2, 3] as const) describe(`v${version} failed-payment observations — in-memory fixtures`, () => {
  test("a later recorded refusal cannot erase a known failed transaction or authorize another request", async () => {
    const fixture = await failedPayment(version, { txHash: "fixture-original-failed-transaction" });
    const { ctx, engine, original, correlation, reads } = fixture;
    reads.payout = { ok: true, value: {
      requestId: original.request_id, state: "refused", status: null, code: "policy_denied", correlationId: correlation,
    } };
    await engine.getContract(ctx.id);
    await expectOriginalCommitment(fixture);
    ctx.rt.clock.advance(61_000);
    await engine.followUpAll();
    await expectOriginalCommitment(fixture);
    expect(engine.attempt(original.request_id).tx_hash).toBe("fixture-original-failed-transaction");
    expect(ctx.stub.transfers).toEqual([]);
  });

  for (const [state, status] of [
    ["processing", "PROCESSING"], ["held", "PENDING_APPROVAL"], ["unknown", null],
    ["not_found", null], ["refused", "REFUSED"],
  ] as const) {
    test(`previous non-execution proof is revoked when payout status becomes ${state}`, async () => {
      const fixture = await failedPayment(version, { proof: true });
      const { ctx, engine, original, correlation, reads } = fixture;
      reads.payout = { ok: true, value: {
        requestId: original.request_id, state, status, correlationId: correlation,
        code: state === "refused" ? "policy_denied" : null, neverExecuted: true,
      } };
      await engine.getContract(ctx.id);
      await engine.followUpAll();
      await expectOriginalCommitment(fixture);
      expect(reads.paymentIds.every(id => id === correlation)).toBe(true);
      expect(ctx.stub.transfers).toEqual([]);
    });
  }

  for (const foreign of ["request", "correlation"] as const) {
    test(`foreign ${foreign} observations cannot import proof/payment; only the original payment can later settle`, async () => {
      const fixture = await failedPayment(version);
      const { ctx, engine, original, correlation, reads, provider } = fixture;
      const identity = {
        requestId: foreign === "request" ? "foreign-request-identity" : original.request_id,
        correlationId: foreign === "correlation" ? "foreign-payment-correlation" : correlation,
      };
      reads.payout = { ok: true, value: { ...identity, state: "failed", status: "FAILED", code: null, neverExecuted: true } };
      await engine.getContract(ctx.id);
      await expectOriginalCommitment(fixture);

      reads.payout = { ok: true, value: { ...identity, state: "succeeded", status: "SUCCESS", code: null, neverExecuted: false } };
      await engine.followUpAll();
      await expectOriginalCommitment(fixture);
      expect(reads.paymentIds.every(id => id === correlation)).toBe(true);
      expect(ctx.stub.transfers).toEqual([]);

      Object.assign(provider, { state: "processing", status: "PROCESSING" });
      ctx.stub.settle(correlation);
      const settled = await engine.getContract(ctx.id);
      expect(engine.attempt(original.request_id)).toMatchObject({ request_id: original.request_id, correlation_id: correlation, run_id: fixture.judgment, state: "paid", never_executed: 0 });
      expect(settled.paid_usd).toBe("300");
      expect(settled.payouts.map(item => item.request_id)).toEqual([original.request_id]);
      expect(ctx.stub.calls.requestPayout).toBe(1);
      expect(reads.paymentIds.every(id => id === correlation)).toBe(true);
      expect(ctx.stub.transfers).toEqual([{ recipient: "maria.demo", amount: "300000000", status: "SUCCESS" }]);
    });
  }

  for (const status of ["PROCESSING", "REFUNDED"] as const) {
    test(`forbidden payout status cannot retain old proof when original payment status is ${status}`, async () => {
      const fixture = await failedPayment(version, { proof: true });
      const { ctx, engine, reads } = fixture;
      reads.payout = { ok: false, kind: "forbidden", code: "scope" };
      reads.payment = payment(status);
      await engine.getContract(ctx.id);
      await engine.followUpAll();
      await expectOriginalCommitment(fixture);
      expect(ctx.stub.transfers).toEqual([]);
    });
  }

  test("refund amount counterevidence survives unavailable, absent and changed later evidence", async () => {
    const fixture = await failedPayment(version);
    const { ctx, engine, original, reads } = fixture;
    reads.proof = true;
    reads.payment = payment("FAILED", "300000000");
    await engine.getContract(ctx.id);
    expect(engine.attempt(original.request_id).refunded_amount).toBe("300000000");
    await expectOriginalCommitment(fixture);

    for (const later of [{ ok: false, kind: "unavailable" } as const, payment("FAILED"), payment("FAILED", "1")]) {
      reads.payment = later;
      await engine.followUpAll();
      expect(engine.attempt(original.request_id).refunded_amount).toBe("300000000");
      await expectOriginalCommitment(fixture);
    }
    expect(ctx.stub.transfers).toEqual([]);
  });

  test("a non-execution claim with an unavailable payment read is not proof", async () => {
    const fixture = await failedPayment(version);
    const { ctx, engine, original, reads } = fixture;
    reads.proof = true;
    reads.payment = { ok: false, kind: "unavailable" };
    await engine.getContract(ctx.id);
    await engine.followUpAll();
    await expectOriginalCommitment(fixture);
    // The same claim with a consistent FAILED payment read establishes proof.
    reads.payment = payment("FAILED");
    await engine.followUpAll();
    expect(engine.attempt(original.request_id).never_executed).toBe(1);
    expect(ctx.stub.transfers).toEqual([]);
  });

  test("an observed REFUNDED status survives later FAILED and unavailable reads", async () => {
    const fixture = await failedPayment(version);
    const { ctx, engine, original, reads } = fixture;
    reads.proof = true;
    reads.payment = payment("REFUNDED");
    await engine.getContract(ctx.id);
    await expectOriginalCommitment(fixture);
    for (const later of [payment("FAILED"), { ok: false, kind: "unavailable" } as const, payment("FAILED")]) {
      reads.payment = later;
      await engine.followUpAll();
      expect(engine.attempt(original.request_id).counterevidence).toBe("payment status REFUNDED");
      await expectOriginalCommitment(fixture);
    }
    expect(ctx.stub.transfers).toEqual([]);
  });

  test("late success settles the original request/correlation without creating a replacement", async () => {
    const fixture = await failedPayment(version);
    const { ctx, engine, original, correlation, provider } = fixture;
    Object.assign(provider, { state: "processing", status: "PROCESSING" });
    ctx.stub.settle(correlation);
    const settled = await engine.getContract(ctx.id);
    expect(engine.attempt(original.request_id)).toMatchObject({ request_id: original.request_id, correlation_id: correlation, run_id: fixture.judgment, state: "paid", never_executed: 0 });
    expect(settled.paid_usd).toBe("300");
    expect(settled.committed_usd).toBe("300");
    expect(settled.open_judgment).toBeNull();
    expect(settled.payouts.map(item => item.request_id)).toEqual([original.request_id]);
    expect(ctx.stub.calls.requestPayout).toBe(1);
    expect(ctx.stub.transfers).toEqual([{ recipient: "maria.demo", amount: "300000000", status: "SUCCESS" }]);
  });
});

for (const version of [2, 3] as const) describe(`v${version} proof needs a successful FAILED read, when stored and again when budget is released`, () => {
  const dbOf = (ctx: Ctx) => (ctx.rt.engine as unknown as { d: { db: Database } }).d.db;

  test("a stored proof flag without a successful read frees nothing while the payment read is unavailable", async () => {
    const fixture = await failedPayment(version);
    const { ctx, engine, original, reads } = fixture;
    // A row as the earlier release could leave it: flagged as never executed with no successful FAILED read behind it.
    dbOf(ctx).query("UPDATE payout_attempts SET never_executed = 1 WHERE request_id = ?").run(original.request_id);
    reads.proof = true;
    reads.payment = { ok: false, kind: "unavailable" };
    await engine.followUpAll();
    await expectOriginalCommitment(fixture);
  });

  test("a transient outage withdraws proof and the next successful FAILED read restores it", async () => {
    const { ctx, engine, original, reads } = await failedPayment(version, { proof: true });
    reads.payment = { ok: false, kind: "unavailable" };
    await engine.followUpAll();
    expect(engine.attempt(original.request_id)).toMatchObject({ state: "failed", never_executed: 0, resolution: null });
    reads.payment = payment("FAILED");
    await engine.followUpAll();
    expect(engine.attempt(original.request_id)).toMatchObject({ state: "failed", never_executed: 1 });
    expect(ctx.stub.calls.requestPayout).toBe(1);
  });

  test("owing it again reads the payment afresh and then requests exactly one replacement", async () => {
    const { ctx, engine, original, reads, correlation } = await failedPayment(version, { proof: true });
    const before = reads.paymentIds.length;
    await engine.resolve(original.request_id, "reowe");
    expect(reads.paymentIds.slice(before)).toContain(correlation);
    expect(engine.attempt(original.request_id).resolution).toBe("reowe");
    expect(ctx.stub.calls.requestPayout).toBe(2);
    expect(ctx.stub.transfers).toEqual([]);
  });

  test("stored proof does not release budget when the payment reads refunded, moved or unavailable at decision time", async () => {
    const moved = payment("FAILED");
    if (moved.ok) moved.value.evidence.txHash = "late-transaction";
    for (const atDecision of [payment("REFUNDED"), payment("FAILED", "300000000"), moved, { ok: false, kind: "unavailable" } as const]) {
      const { ctx, engine, original, reads } = await failedPayment(version, { proof: true });
      reads.payment = atDecision;
      for (const outcome of ["reowe", "rejected"] as const)
        await expect(engine.resolve(original.request_id, outcome)).rejects.toThrow("never executed");
      // Refused: nothing released or requested, and what the read showed is recorded at once.
      expect(engine.attempt(original.request_id)).toMatchObject({ state: "failed", never_executed: 0, resolution: null });
      if (atDecision.ok && atDecision.value.status === "REFUNDED") expect(engine.attempt(original.request_id).counterevidence).toBe("payment status REFUNDED");
      expect(ctx.stub.calls.requestPayout).toBe(1);
      expect(ctx.stub.transfers).toEqual([]);
    }
  });

  test("a FAILED payment read is not enough: the payout record must also claim non-execution, now, under the same identity", async () => {
    const regressed = (state: PayoutAnswer["state"], correlationId: string | null, neverExecuted: boolean, requestId: string): Res<PayoutAnswer> =>
      ({ ok: true, value: { requestId, state, status: null, correlationId, code: null, neverExecuted } });
    for (const variant of ["claim withdrawn", "processing again", "foreign payment", "foreign request", "unavailable"] as const) {
      const { ctx, engine, original, reads, correlation } = await failedPayment(version, { proof: true });
      reads.payment = payment("FAILED");
      if (variant === "claim withdrawn") reads.proof = false;
      if (variant === "processing again") reads.payout = regressed("processing", correlation, false, original.request_id);
      if (variant === "foreign payment") reads.payout = regressed("failed", "pay-foreign", true, original.request_id);
      if (variant === "foreign request") reads.payout = regressed("failed", correlation, true, "another-request");
      if (variant === "unavailable") reads.payout = { ok: false, kind: "unavailable" };
      for (const outcome of ["reowe", "rejected"] as const)
        await expect(engine.resolve(original.request_id, outcome)).rejects.toThrow();
      // A recorded failure never regresses to a live state, and an authoritative contrary answer withdraws proof.
      expect(engine.attempt(original.request_id)).toMatchObject({ state: "failed", resolution: null });
      if (variant === "claim withdrawn" || variant === "processing again") expect(engine.attempt(original.request_id).never_executed).toBe(0);
      expect(ctx.stub.calls.requestPayout).toBe(1);
      expect(ctx.stub.transfers).toEqual([]);
    }
  });
});
