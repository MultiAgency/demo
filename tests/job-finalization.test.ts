import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { buildApp, type Runtime } from "../src/server/app";
import type { Auth } from "../src/server/auth";
import { JOB_DEMO_TERMS } from "../src/shared/demo";
import { activate, castVote } from "./support/harness";

function agencyApp(rt: Runtime) {
  const account = JOB_DEMO_TERMS.representative.near_account;
  const auth = {
    handler: async () => new Response("fixture auth"),
    api: { getSession: async () => ({ user: { id: account } }) },
    nearAccountFor: () => account,
  } as unknown as Auth;
  return buildApp({ ...rt, config: { ...rt.config, auth: { ...rt.config.auth, required: true } }, auth });
}

/** SQLite faults model interruption between related finalization writes; all provider actions are fixtures. */
async function heldJob(key: string) {
  const ctx = await activate("300", JOB_DEMO_TERMS);
  const c = ctx.rt.covenant;
  const submission = await c.submitJob(ctx.id, {
    client_request_id: key,
    report: "CSV export and acceptance tests are complete for agency review.",
    evidence: [{ deliverable_id: "d1", label: "CSV export tests", url: "https://evidence.invalid/export" }],
    invoice: { number: key, amount_usd: "300" },
  }, JOB_DEMO_TERMS.contractor.near_account);
  const proposed = await c.proposeJob(submission.id);
  const payout = proposed.payouts[0]!;
  const judgmentId = proposed.submissions[0]!.judgment_id!;
  const db = (c as unknown as { d: { db: Database } }).d.db;
  const outcome = () => (db.query("SELECT outcome FROM judgments WHERE id = ?").get(judgmentId) as { outcome: string }).outcome;
  return { ctx, c, submission, payout, judgmentId, db, outcome };
}

describe("job finalization is atomic — simulated provider", () => {
  test("a failed settled-state write preserves the open judgment and resumes without another payment request", async () => {
    const { ctx, c, submission, payout, judgmentId, db, outcome } = await heldJob("atomic-settlement-001");
    await castVote(ctx, payout.request_id, "approve");
    const correlation = c.attempt(payout.request_id).correlation_id!;
    ctx.stub.settle(correlation);
    db.exec(`CREATE TEMP TRIGGER fail_job_finalization BEFORE UPDATE OF state ON job_submissions
      WHEN NEW.state = 'settled' BEGIN SELECT RAISE(ABORT, 'fixture finalization interrupted'); END`);
    try {
      const interrupted = await c.getContract(ctx.id);
      expect(outcome()).toBe("pending");
      expect(interrupted.open_judgment?.id).toBe(judgmentId);
      expect(interrupted.submissions[0]!.state).toBe("proposed");
      expect(interrupted.submissions[0]!.id).toBe(submission.id);
      expect(interrupted.payouts[0]!.state).toBe("paid");
      expect(interrupted.committed_usd).toBe("300");
      expect(c.followUpIds()).toContain(ctx.id); // Terminal payout still has a pending finalization.
      expect(interrupted.events.some((e) => e.text.includes(`Submission ${submission.id}: settled`))).toBe(false);
    } finally { db.exec("DROP TRIGGER fail_job_finalization"); }

    await c.followUpAll(); // The recovery timer must finish this without a representative GET.
    const repaired = await c.viewContract(ctx.id);
    expect(outcome()).toBe("approved");
    expect(repaired.open_judgment).toBeNull();
    expect(repaired.submissions[0]!.state).toBe("settled");
    expect(repaired.submissions[0]!.judgment_id).toBe(judgmentId);
    expect(repaired.submissions[0]!.payout_request_ids).toEqual([payout.request_id]);
    expect(c.attempt(payout.request_id).correlation_id).toBe(correlation);
    expect(c.followUpIds()).not.toContain(ctx.id);
    expect(ctx.stub.calls.requestPayout).toBe(1);
    expect(ctx.stub.transfers).toEqual([{ recipient: JOB_DEMO_TERMS.payee.address, amount: "300000000", status: "SUCCESS" }]);
  });

  test("a failed changes-state write preserves pending cancellation and resumes after the same confirmed rejection", async () => {
    const { ctx, c, submission, payout, judgmentId, db, outcome } = await heldJob("atomic-cancellation-001");
    await c.requestJobChanges(submission.id, "Include the reproducible CSV acceptance-test output.");
    const correlation = c.attempt(payout.request_id).correlation_id;
    db.exec(`CREATE TEMP TRIGGER fail_job_finalization BEFORE UPDATE OF state ON job_submissions
      WHEN NEW.state = 'changes_requested' BEGIN SELECT RAISE(ABORT, 'fixture finalization interrupted'); END`);
    try {
      await expect(castVote(ctx, payout.request_id, "reject")).rejects.toThrow("fixture finalization interrupted");
      const interrupted = await c.getContract(ctx.id);
      expect(outcome()).toBe("pending");
      expect(interrupted.open_judgment?.id).toBe(judgmentId);
      expect(interrupted.submissions[0]!.state).toBe("changes_pending");
      expect(interrupted.payouts[0]!.state).toBe("rejected");
      expect(interrupted.paid_usd).toBe("0");
      expect(interrupted.committed_usd).toBe("0"); // The original payout's rejection is already authoritative.
      expect(c.followUpIds()).toContain(ctx.id);
      expect(interrupted.events.some((e) => e.text.includes(`Submission ${submission.id}: changes_requested`))).toBe(false);
    } finally { db.exec("DROP TRIGGER fail_job_finalization"); }

    await c.followUpAll();
    const repaired = await c.viewContract(ctx.id);
    expect(outcome()).toBe("rejected");
    expect(repaired.open_judgment).toBeNull();
    expect(repaired.submissions[0]!.state).toBe("changes_requested");
    expect(repaired.submissions[0]!.judgment_id).toBe(judgmentId);
    expect(repaired.submissions[0]!.payout_request_ids).toEqual([payout.request_id]);
    expect(c.attempt(payout.request_id).correlation_id).toBe(correlation);
    expect(c.followUpIds()).not.toContain(ctx.id);
    expect(ctx.stub.calls.requestPayout).toBe(1);
    expect(ctx.stub.transfers).toEqual([]);
  });
});

describe("unknown reject submission requires platform non-execution proof", () => {
  for (const [failureCode, neverExecuted, txHash, paymentStatusOverride] of [
    ["delivery_outcome_unknown", false, null, null],
    ["rejected", false, null, null], // The provider's rejection code alone is not proof.
    ["rejected", true, null, null],
    ["rejected", true, "fixture-positive-transaction", null],
    ["rejected", true, null, "PROCESSING"],
    ["rejected", true, null, "PENDING_APPROVAL"],
  ] as const) {
    test(`${failureCode}, proof=${neverExecuted}, tx=${txHash}, status=${paymentStatusOverride}: preserves the payment boundary`, async () => {
      const { ctx, c, submission, payout } = await heldJob(`unknown-reject-${failureCode}-${neverExecuted}`);
      await c.requestJobChanges(submission.id, "Attach the independent acceptance-test output.");
      const vote = await c.vote(payout.request_id, "reject");
      const originalAgent = ctx.stub.agent.bind(ctx.stub);
      ctx.stub.agent = (organization, agent) => {
        const handle = originalAgent(organization, agent);
        return {
          ...handle,
          // The response gives no evidence that this particular reject was applied.
          ownerSubmit: async () => ({ ok: false, kind: "unknown", detail: "fixture reject response lost" }),
          payoutStatus: async (requestId) => {
            const status = await handle.payoutStatus(requestId);
            return status.ok ? { ok: true, value: {
              ...status.value,
              failureCode: status.value.state === "failed" ? failureCode : null,
              neverExecuted: status.value.state === "failed" && neverExecuted,
            } } : status;
          },
          paymentStatus: async (correlation) => {
            const status = await handle.paymentStatus(correlation);
            return status.ok && paymentStatusOverride ? {
              ok: true, value: { ...status.value, status: paymentStatusOverride },
            } : status;
          },
        };
      };
      await c.submitOwnerStep(vote.correlation_id, ctx.stub.sign(vote.sign!));
      Object.assign(ctx.stub.payouts.get(payout.request_id)!, {
        state: "failed", status: "FAILED", failureCode, txHash,
      });
      const followed = await c.getContract(ctx.id);
      const provenNotExecuted = neverExecuted && txHash === null && paymentStatusOverride === null;
      expect(c.attempt(payout.request_id).vote).toBe("reject");
      expect(followed.payouts[0]!.request_id).toBe(payout.request_id);
      expect(followed.payouts[0]!.state).toBe(provenNotExecuted ? "rejected" : "failed");
      expect(followed.submissions[0]!.state).toBe(provenNotExecuted ? "changes_requested" : "changes_pending");
      expect(followed.committed_usd).toBe(provenNotExecuted ? "0" : "300");
      expect(followed.paid_usd).toBe("0");
      if (!provenNotExecuted) await expect(c.submitJob(ctx.id, {
        client_request_id: "unknown-reject-replacement",
        report: "A revision cannot replace an uncertain payment outcome.",
        evidence: [{ deliverable_id: "d1", label: "Revised tests", url: "https://evidence.invalid/revision" }],
        invoice: { number: "UNKNOWN-REJECT-REVISION", amount_usd: "300" },
      }, JOB_DEMO_TERMS.contractor.near_account)).rejects.toThrow();
      if (!provenNotExecuted) {
        for (const outcome of ["reowe", "rejected"] as const) {
          await expect(c.resolve(payout.request_id, outcome)).rejects.toThrow("platform proves it never executed");
          const response = await agencyApp(ctx.rt).request(`/api/payouts/${payout.request_id}/resolve`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outcome }),
          });
          expect(response.status).toBe(409);
          expect(c.attempt(payout.request_id).resolution).toBeNull();
        }
        expect((await c.viewContract(ctx.id)).committed_usd).toBe("300");
      }
      expect(ctx.stub.calls.requestPayout).toBe(1);
      expect(ctx.stub.transfers).toEqual([]);
    });
  }

  test("a recorded failed payout remains committed when later status is not_found; the timer never resends it", async () => {
    const { ctx, c, payout, judgmentId } = await heldJob("recorded-failure-observation-only");
    const correlation = c.attempt(payout.request_id).correlation_id;
    Object.assign(ctx.stub.payouts.get(payout.request_id)!, {
      state: "failed", status: "FAILED", failureCode: "delivery_outcome_unknown", txHash: null,
    });
    const failed = await c.getContract(ctx.id);
    expect(failed.payouts[0]!.state).toBe("failed");
    expect(failed.committed_usd).toBe("300");
    expect(c.followUpIds()).toContain(ctx.id);
    // Missing subsequent provider observation cannot erase a failure already recorded by the app.
    ctx.stub.payouts.delete(payout.request_id);
    await c.followUpAll();
    const observed = await c.viewContract(ctx.id);
    expect(observed.payouts).toHaveLength(1);
    expect(observed.payouts[0]!.state).toBe("failed");
    expect(observed.payouts[0]!.request_id).toBe(payout.request_id);
    expect(observed.open_judgment?.id).toBe(judgmentId);
    expect(c.attempt(payout.request_id).correlation_id).toBe(correlation);
    expect(observed.committed_usd).toBe("300");
    expect(observed.paid_usd).toBe("0");
    expect(ctx.stub.calls.requestPayout).toBe(1);
    expect(ctx.stub.transfers).toEqual([]);
  });
});

describe("manual v3 failure resolution cannot release uncertain money", () => {
  for (const outcome of ["reowe", "rejected"] as const) {
    test(`unproven ${outcome} is refused before changing the attempt or creating another SDK request`, async () => {
      const { ctx, c, payout, judgmentId } = await heldJob(`manual-unproven-${outcome}`);
      Object.assign(ctx.stub.payouts.get(payout.request_id)!, {
        state: "failed", status: "FAILED", failureCode: "delivery_outcome_unknown", txHash: null,
      });
      await c.getContract(ctx.id);
      const before = c.attempt(payout.request_id);
      await expect(c.resolve(payout.request_id, outcome)).rejects.toThrow("platform proves it never executed");
      const response = await agencyApp(ctx.rt).request(`/api/payouts/${payout.request_id}/resolve`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outcome }),
      });
      expect(response.status).toBe(409);
      expect(c.attempt(payout.request_id)).toEqual(before);
      const after = await c.viewContract(ctx.id);
      expect(after.open_judgment?.id).toBe(judgmentId);
      expect(after.committed_usd).toBe("300");
      expect(after.paid_usd).toBe("0");
      expect(after.payouts).toHaveLength(1);
      expect(ctx.stub.calls.requestPayout).toBe(1);
    });

    test(`explicit non-execution proof permits ${outcome} within the original job's budget`, async () => {
      const { ctx, c, payout } = await heldJob(`manual-proven-${outcome}`);
      Object.assign(ctx.stub.payouts.get(payout.request_id)!, {
        state: "failed", status: "FAILED", failureCode: "rejected_by_owner", txHash: null,
      });
      await c.getContract(ctx.id);
      const correlation = c.attempt(payout.request_id).correlation_id;
      expect(c.attempt(payout.request_id).never_executed).toBe(1);
      const resolved = await c.resolve(payout.request_id, outcome);
      expect(c.attempt(payout.request_id).resolution).toBe(outcome);
      expect(c.attempt(payout.request_id).correlation_id).toBe(correlation);
      expect(resolved.paid_usd).toBe("0");
      expect(resolved.submissions[0]!.state).not.toBe("settled");
      expect(ctx.stub.calls.requestPayout).toBe(outcome === "reowe" ? 2 : 1);
      expect(ctx.stub.transfers).toEqual([]);
    });
  }

  test("manual arrived remains labelled as resolution and cannot claim platform-confirmed settlement", async () => {
    const { ctx, c, payout } = await heldJob("manual-arrived-retains-identity");
    Object.assign(ctx.stub.payouts.get(payout.request_id)!, {
      state: "failed", status: "FAILED", failureCode: "delivery_outcome_unknown", txHash: null,
    });
    await c.getContract(ctx.id);
    const correlation = c.attempt(payout.request_id).correlation_id;
    const resolved = await c.resolve(payout.request_id, "arrived");
    expect(resolved.payouts[0]!.state).toBe("resolved");
    expect(resolved.payouts[0]!.resolution).toBe("arrived");
    expect(resolved.submissions[0]!.state).toBe("closed");
    expect(resolved.committed_usd).toBe("300");
    expect(c.attempt(payout.request_id).correlation_id).toBe(correlation);
    expect(ctx.stub.calls.requestPayout).toBe(1);
    expect(ctx.stub.transfers).toEqual([]);
  });
});
