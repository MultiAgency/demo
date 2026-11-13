import { expect, test } from "bun:test";
import { jobAttention, type JobAttentionSnapshot } from "../src/server/jobs/attention";
import { DEMO_TERMS, JOB_DEMO_TERMS } from "../src/shared/demo";
import { parseTerms } from "../src/shared/terms";

// Pure snapshots of durable app records. No SDK, wallet, database mutation or hosted request is involved.
const snapshot = (patch: Partial<JobAttentionSnapshot> = {}): JobAttentionSnapshot => ({
  terms: parseTerms(JOB_DEMO_TERMS), roles: ["builder"],
  row: { rep_sig: "recorded-agency-signature", contractor_sig: "recorded-builder-signature", frozen: 0 },
  agent: { stage: "ready", usdc_observed: null }, latestSubmission: null, payouts: [], ownerSteps: [], openJudgmentId: null,
  now: new Date("2026-11-20T12:00:00Z"), ...patch,
});
const payment = (patch: Partial<JobAttentionSnapshot["payouts"][number]> = {}): JobAttentionSnapshot["payouts"][number] => ({
  kind: "payout", request_id: "original-payment", run_id: "original-judgment", state: "held", resolution: null,
  amount_atomic: "300000000", vote: null, code: null, ...patch,
});
const step = (patch: Partial<JobAttentionSnapshot["ownerSteps"][number]> = {}): JobAttentionSnapshot["ownerSteps"][number] => ({
  kind: "approval_vote", request_id: "original-payment", state: "prepared", confirm_url: null, ...patch,
});
const submission = (state: NonNullable<JobAttentionSnapshot["latestSubmission"]>["state"]) => ({ state, judgment_id: "original-judgment" });
const roles = [["agency"], ["builder"], ["agency", "builder"]] as const;

test("an uncertain approval with a missing historical payment link cannot become a fresh approval task", () => {
  for (const request_id of [null, "missing-original-payment"]) {
    const result = jobAttention(snapshot({ roles: ["agency"], payouts: [payment()], ownerSteps: [step({ state: "unknown", request_id })] }));
    expect(result.state).toBe("waiting");
    expect(result.actions).toEqual([]);
    expect(result.summary).toBe("Waiting for payment evidence");
  }
});

test("membership does not assign another party's unsigned acceptance; both roles retain their own missing signatures", () => {
  const row = { rep_sig: null, contractor_sig: null, frozen: 0 };
  expect(jobAttention(snapshot({ row, roles: ["agency"] })).actions).toEqual([{ role: "agency", label: "Review and sign terms" }]);
  expect(jobAttention(snapshot({ row })).actions).toEqual([{ role: "builder", label: "Review offered terms" }]);
  expect(jobAttention(snapshot({ row, roles: ["agency", "builder"] })).actions).toHaveLength(2);
  const builderAccepted = { ...row, contractor_sig: "accepted" };
  const agencyAccepted = { ...row, rep_sig: "accepted" };
  expect(jobAttention(snapshot({ row: builderAccepted })).state).toBe("waiting");
  expect(jobAttention(snapshot({ row: agencyAccepted, roles: ["agency"] })).state).toBe("waiting");
  expect(jobAttention(snapshot({ row })).detail).toContain("sign them with the named account's wallet");
});

test("recorded readiness without balance proof names the builder's submission and the agency's funding check, not a funded-work assertion", () => {
  expect(jobAttention(snapshot())).toMatchObject({ state: "needs_action", summary: "No report and invoice submitted yet", actions: [{ role: "builder", label: "Submit report and invoice" }] });
  expect(jobAttention(snapshot({ roles: ["agency"] })).actions).toEqual([{ role: "agency", label: "Verify setup and funding" }]);
  const both = jobAttention(snapshot({ roles: ["agency", "builder"] }));
  expect(both.actions).toHaveLength(2);
  expect(both.detail).toContain("does not confirm funding");
  expect(JSON.stringify(both)).not.toMatch(/submit_report|Do work|funded/);
});

test("a recorded balance splits readiness: zero asks the agency to fund, above zero asks the builder to submit", () => {
  const ready = (usdc_observed: string) => ({ stage: "ready" as const, usdc_observed });
  expect(jobAttention(snapshot({ agent: ready("0"), roles: ["agency"] }))).toMatchObject({ reason_code: "funding_required", state: "needs_action", actions: [{ role: "agency", label: "Fund the job" }] });
  expect(jobAttention(snapshot({ agent: ready("0") }))).toMatchObject({ reason_code: "funding_required", state: "waiting", actions: [] });
  expect(jobAttention(snapshot({ agent: ready("300000000") }))).toMatchObject({ reason_code: "submission_due", state: "needs_action", actions: [{ role: "builder", label: "Submit report and invoice" }] });
  expect(jobAttention(snapshot({ agent: ready("300000000"), roles: ["agency"] }))).toMatchObject({ reason_code: "submission_due", state: "waiting", actions: [] });
  // A submission on file outranks the readiness split; a spent balance after a payout is not "unfunded".
  expect(jobAttention(snapshot({ agent: ready("300000000"), roles: ["agency"], latestSubmission: submission("submitted") })).reason_code).toBe("submission_review");
  expect(jobAttention(snapshot({ agent: ready("0"), payouts: [payment({ state: "paid" })], latestSubmission: submission("settled") })).reason_code).not.toBe("funding_required");
});

test("inside a signed review window filed work stays reviewable and nothing new is asked of the builder", () => {
  const terms = parseTerms({ ...JOB_DEMO_TERMS, payment_terms: { calculation: "scope_completion_less_committed", invoice: "cap", approval: "explicit_agency", settlement: "platform_usdc_near", due: "after_approval", review_days: 14 } });
  const inWindow = new Date("2026-12-05T12:00:00Z");
  expect(jobAttention(snapshot({ terms, now: inWindow, roles: ["agency"], latestSubmission: submission("submitted") })).reason_code).toBe("submission_review");
  for (const latestSubmission of [null, submission("changes_requested"), submission("settled")])
    expect(jobAttention(snapshot({ terms, now: inWindow, latestSubmission }))).toMatchObject({ reason_code: "submission_closed", state: "waiting", actions: [] });
  expect(jobAttention(snapshot({ terms, now: new Date("2026-12-15T12:00:00Z") })).reason_code).toBe("job_ended_unsettled");
  // Terms without a window end on the end date, as before.
  expect(jobAttention(snapshot({ now: inWindow })).reason_code).toBe("job_ended_unsettled");
});

test("known incomplete setup belongs to the agency; pending policy belongs to neither party", () => {
  for (const agent of [null, { stage: "needs_grant" as const, usdc_observed: null }, { stage: "needs_setup" as const, usdc_observed: null }]) {
    expect(jobAttention(snapshot({ agent, roles: ["agency"] })).actions).toEqual([{ role: "agency", label: "Continue existing setup" }]);
    expect(jobAttention(snapshot({ agent })).state).toBe("waiting");
  }
  expect(jobAttention(snapshot({ agent: { stage: "policy_pending", usdc_observed: null }, roles: ["agency"] })).actions).toEqual([]);
});

for (const ownerStep of [step({ kind: "grant_issue", request_id: null, state: "unknown" }), step({ kind: "agent_create", request_id: null, state: "submitted" }), step({ kind: "policy_update", request_id: null, confirm_url: "https://platform.invalid/original-confirmation" })]) {
  test(`an uncertain existing setup intent waits instead of assigning replacement setup: ${ownerStep.kind}`, () => {
    const result = jobAttention(snapshot({ agent: { stage: "needs_grant", usdc_observed: null }, roles: ["agency"], ownerSteps: [ownerStep] }));
    expect(result.state).toBe("waiting"); expect(result.summary).toBe("Waiting for setup confirmation"); expect(result.actions).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("platform.invalid");
  });
}

test("a submitted report assigns assessment to the agency and leaves the builder waiting", () => {
  const latestSubmission = submission("submitted");
  expect(jobAttention(snapshot({ latestSubmission, roles: ["agency"] })).actions).toEqual([{ role: "agency", label: "Review the submission" }]);
  expect(jobAttention(snapshot({ latestSubmission })).state).toBe("waiting");
});

test("a held compensation proposal needs agency review, never builder approval or confirmed-payment labeling", () => {
  const patch = { latestSubmission: submission("proposed"), payouts: [payment()], openJudgmentId: "original-judgment" };
  expect(jobAttention(snapshot({ ...patch, roles: ["agency"] })).actions).toEqual([{ role: "agency", label: "Review payout proposal" }]);
  const builder = jobAttention(snapshot(patch));
  expect(builder.state).toBe("waiting"); expect(builder.actions).toEqual([]); expect(builder.summary).toBe("Waiting for agency payout review");
});

for (const ownerStep of [step({ state: "unknown" }), step({ state: "submitted" }), step({ confirm_url: "https://platform.invalid/original-confirmation" })]) {
  test(`uncertain owner intent takes priority even if the local payout vote marker is absent: ${ownerStep.state}/${!!ownerStep.confirm_url}`, () => {
    for (const actorRoles of roles) {
      const result = jobAttention(snapshot({ roles: [...actorRoles], latestSubmission: submission("proposed"), payouts: [payment()], ownerSteps: [ownerStep] }));
      expect(result.state).toBe("waiting"); expect(result.actions).toEqual([]); expect(result.detail).toContain("original payment");
    }
  });
}

test("an unsigned local wallet preparation or positively expired intent can still lead to reviewing the existing held payout", () => {
  for (const ownerStep of [step(), step({ state: "expired", confirm_url: "https://platform.invalid/expired" })]) {
    expect(jobAttention(snapshot({ roles: ["agency"], payouts: [payment()], ownerSteps: [ownerStep] })).actions[0]?.label).toBe("Review payout proposal");
  }
});

for (const state of ["pending", "waiting", "unknown", "processing", "resolved", "disputed"] as const) {
  test(`original ${state} money outcome prevents fresh actions, even before a missing signature`, () => {
    const result = jobAttention(snapshot({ roles: ["agency", "builder"], row: { rep_sig: null, contractor_sig: null, frozen: 0 }, payouts: [payment({ state })] }));
    expect(result.state).toBe("waiting"); expect(result.actions).toEqual([]);
  });
}

test("a submitted approve or reject vote waits instead of assigning a second decision", () => {
  for (const vote of ["approve", "reject"] as const) {
    expect(jobAttention(snapshot({ roles: ["agency"], payouts: [payment({ vote })] })).actions).toEqual([]);
  }
});

test("requested changes do not assign builder revision until cancellation is confirmed", () => {
  const patch = { latestSubmission: submission("changes_pending"), payouts: [payment()] };
  expect(jobAttention(snapshot(patch)).state).toBe("waiting");
  expect(jobAttention(snapshot({ ...patch, roles: ["agency"] })).actions).toEqual([{ role: "agency", label: "Review payout cancellation" }]);
  expect(jobAttention(snapshot({ ...patch, roles: ["agency"], ownerSteps: [step({ state: "unknown" })] })).actions).toEqual([]);
  expect(jobAttention(snapshot({ latestSubmission: submission("changes_pending"), payouts: [payment({ state: "rejected" })] })).state).toBe("waiting");
  expect(jobAttention(snapshot({ latestSubmission: submission("changes_requested"), payouts: [payment({ state: "rejected" })] })).actions).toEqual([{ role: "builder", label: "Review requested changes" }]);
  expect(jobAttention(snapshot({ latestSubmission: submission("changes_requested"), roles: ["agency"] })).state).toBe("waiting");
});

test("a disputed submission keeps its original commitment and never assigns replacement work", () => {
  for (const actorRoles of roles) {
    const result = jobAttention(snapshot({ roles: [...actorRoles], latestSubmission: submission("disputed") }));
    expect(result.state).toBe("waiting"); expect(result.actions).toEqual([]);
  }
});

test("blocked/refused current requests are for agency inspection; historical refusals do not obscure a later submission", () => {
  for (const state of ["blocked", "refused"] as const) {
    const patch = { payouts: [payment({ state, code: "insufficient_balance" })], openJudgmentId: "original-judgment" };
    expect(jobAttention(snapshot({ ...patch, roles: ["agency"] })).actions).toEqual([{ role: "agency", label: "Inspect existing payout" }]);
    expect(jobAttention(snapshot(patch)).state).toBe("waiting");
  }
  const result = jobAttention(snapshot({ roles: ["agency"], latestSubmission: submission("submitted"), payouts: [payment({ state: "refused" })] }));
  expect(result.actions).toEqual([{ role: "agency", label: "Review the submission" }]);
});

test("closed reviews and partially settled submissions do not promise the currently unavailable continuation form", () => {
  for (const state of ["closed", "settled"] as const) {
    const result = jobAttention(snapshot({ latestSubmission: submission(state), payouts: [payment({ state: "paid", amount_atomic: "100000000" })] }));
    expect(result.state).toBe("needs_action"); expect(result.actions).toEqual([{ role: "builder", label: "Review remaining scope" }]);
    expect(result.detail).toContain("does not promise a new submission form");
    expect(result.state).not.toBe("completed");
  }
});

test("only positive full signed scope with provider-paid payouts completes the job, including several partial invoices", () => {
  const payouts = [payment({ request_id: "part-one", state: "paid", amount_atomic: "100000000" }), payment({ request_id: "part-two", state: "paid", amount_atomic: "200000000" })];
  for (const actorRoles of roles) {
    const result = jobAttention(snapshot({ roles: [...actorRoles], payouts, latestSubmission: submission("settled"), now: new Date("2026-12-05T00:00:00Z") }));
    expect(result.state).toBe("completed"); expect(result.actions).toEqual([]);
  }
  expect(jobAttention(snapshot({ payouts: [payment({ state: "paid", amount_atomic: "100000000" })] })).state).not.toBe("completed");
  expect(jobAttention(snapshot({ terms: { ...parseTerms(JOB_DEMO_TERMS), scope: [] }, payouts: [] })).state).not.toBe("completed");
});

test("manual arrived, attacks, approval, and ended work never stand in for provider-confirmed full payment", () => {
  const cases = [payment({ state: "failed", resolution: "arrived" }), payment({ kind: "attack", state: "paid" }), payment({ vote: "approve" })];
  for (const payout of cases) expect(jobAttention(snapshot({ payouts: [payout] })).state).not.toBe("completed");
  const ended = jobAttention(snapshot({ now: new Date("2026-12-05T00:00:00Z") }));
  expect(ended.state).toBe("waiting"); expect(ended.summary).toContain("full payment is not confirmed");
});

test("full paid totals cannot hide an additional unresolved commitment, but terminal historical intents do not block completion", () => {
  const full = payment({ state: "paid" });
  expect(jobAttention(snapshot({ payouts: [full, payment({ request_id: "still-unknown", state: "unknown", amount_atomic: "1" })] })).state).toBe("waiting");
  expect(jobAttention(snapshot({ roles: ["agency"], payouts: [full, payment({ request_id: "still-held", amount_atomic: "1" })] })).state).not.toBe("completed");
  expect(jobAttention(snapshot({ payouts: [full], ownerSteps: [step({ state: "unknown" })] })).state).toBe("completed");
  expect(jobAttention(snapshot({ payouts: [full, payment({ request_id: "old-refused", state: "refused", amount_atomic: "1" })] })).state).toBe("completed");
});

test("an unexplained failed payment is reviewable only through its original agency view", () => {
  expect(jobAttention(snapshot({ roles: ["agency"], payouts: [payment({ state: "failed" })] })).actions).toEqual([{ role: "agency", label: "Review payment issue" }]);
  expect(jobAttention(snapshot({ payouts: [payment({ state: "failed" })] })).actions).toEqual([]);
});

test("legacy merge acceptance never receives a report-and-invoice task", () => {
  const terms = parseTerms(DEMO_TERMS);
  const agency = jobAttention(snapshot({ terms, roles: ["agency"] }));
  expect(agency.actions).toEqual([{ role: "agency", label: "Open existing merge workflow" }]);
  expect(jobAttention(snapshot({ terms })).state).toBe("waiting");
  expect(JSON.stringify(agency)).not.toContain("submit_report");
});

test("projection does not mutate frozen input records or disclose request/intent identities", () => {
  const s = snapshot({ payouts: [payment()], ownerSteps: [step()], latestSubmission: submission("proposed"), roles: ["agency"] });
  const before = JSON.stringify(s);
  Object.freeze(s.row); Object.freeze(s.agent); Object.freeze(s.roles); Object.freeze(s.payouts[0]); Object.freeze(s.payouts);
  Object.freeze(s.ownerSteps[0]); Object.freeze(s.ownerSteps); Object.freeze(s.latestSubmission); Object.freeze(s);
  const result = jobAttention(s);
  expect(JSON.stringify(s)).toBe(before);
  expect(JSON.stringify(result)).not.toMatch(/original-payment|original-judgment|recorded-agency-signature/);
});
