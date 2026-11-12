import { describe, expect, test } from "bun:test";
import { hashCanonical } from "../src/shared/canonical";
import { USDC_NEAR } from "../src/shared/terms";
import type { EvidenceCollection, Observation, PaymentEvidence, PayoutEvidence, ReadResult } from "../src/server/recovery/evidence";
import type { LedgerInspection } from "../src/server/recovery/inspect";
import { previewRecovery, RecoveryPreviewError } from "../src/server/recovery/preview";

const timestamp = "2026-11-11T12:00:00.000Z";
const ok = <T>(value: T): ReadResult<T> => ({ ok: true, value, response_sha256: "d".repeat(64) });
const observed = <T>(target_id: string | null, value: T): Observation<T> => ({ target_id, started_at: timestamp, completed_at: timestamp, result: ok(value) });
const failedRead = (): ReadResult<never> => ({ ok: false, kind: "unavailable", response_sha256: null });
function fixture(version: 2 | 3 = 3) {
  const inspection: LedgerInspection = {
    schema_version: 1, snapshot: { sha256: "a".repeat(64), bytes: 4096 }, deployment: "local-deployment", host: null, tables: [],
    jobs: [{ id: "job-1", terms_version: version, terms_hash: "b".repeat(64), organization: "org-1", signing_recipient: "covenant",
      agent: { name: "agent-1", id: "agent-id-1" }, submission_ids: ["submission-1"], invoice_ids: ["invoice-1"], judgment_ids: ["judgment-1"], payout_request_ids: ["request-1"] }],
    attempts: [{ request_id: "request-1", contract_id: "job-1", kind: "payout", seq: 1, attempt: 1, judgment_id: "judgment-1", recipient: "builder.demo", amount_atomic: "300000000",
      state: "failed", resolution: "reowe", code: "delivery_unknown", payout_correlation_id: "payment-1", approval_id: "approval-1", owner_step_correlation_id: "owner-1",
      never_executed: false, tx_hash: null, refund_tx_hash: null, refunded_amount: null, lines: [{ deliverable_id: "d1", amount_atomic: "300000000" }],
      same_obligation_request_ids: [], other_same_job_request_ids: [] }],
    owner_steps: [{ correlation_id: "owner-1", contract_id: "job-1", organization: "org-1", kind: "approval_vote", state: "success", request_id: "request-1", verdict: "approve" }],
    findings: [{ code: "unproven_budget_release", request_id: "request-1", contract_id: "job-1", message: "Historical release lacks stored positive proof." }],
    summary: { job_count: 1, attempt_count: 1, unproven_release_count: 1, contradiction_count: 0, requires_review: true }, limitations: [],
  };
  const binding = { schema_version: 1 as const, snapshot_sha256: inspection.snapshot.sha256, provenance_sha256: "c".repeat(64), platform_origin: "https://platform.invalid",
    deployment: "local-deployment", contract_id: "job-1", terms_hash: "b".repeat(64), organization: "org-1", agent: "agent-1", agent_id: "agent-id-1" };
  const collection: EvidenceCollection = {
    schema_version: 1, binding, binding_sha256: hashCanonical(binding), snapshot: { ...inspection.snapshot }, sdk_version: "0.5.7", started_at: timestamp, completed_at: timestamp,
    payouts: [observed<PayoutEvidence>("request-1", { request_id: "request-1", state: "failed", status: "FAILED", correlation_id: "payment-1", never_executed: true })],
    payments: [observed<PaymentEvidence>("payment-1", { status: "FAILED", approval_id: "approval-1", tx_hash: null, destination_tx_hash: null, refund_tx_hash: null, refunded_amount: null,
      request: { recipient: "builder.demo", amount: "300000000", asset: USDC_NEAR, chain: "near", confidential: true, has_memo: false } })],
    owners: [observed("owner-1", { stage: "submitted", phase: "settled", status: "SUCCESS" })],
    held: observed(null, []), unmatched_held_count: 0, complete: true, clearance: "none", limitations: [],
  };
  return { inspection, collection };
}
type Fixture = ReturnType<typeof fixture>;
function payout(f: Fixture, index = 0) {
  const result = f.collection.payouts[index]!.result;
  if (!result.ok) throw new Error("fixture payout unavailable");
  return result.value;
}
function payment(f: Fixture, index = 0) {
  const result = f.collection.payments[index]!.result;
  if (!result.ok) throw new Error("fixture payment unavailable");
  return result.value;
}
function paid(f: Fixture, index = 0) {
  Object.assign(payout(f, index), { state: "succeeded", status: "SUCCESS", never_executed: false });
  Object.assign(payment(f, index), { status: "SUCCESS", tx_hash: `tx-${index}` });
}
function addAttempt(f: Fixture, options: { sameObligation?: boolean; otherJob?: boolean } = {}) {
  const attempt = structuredClone(f.inspection.attempts[0]!);
  Object.assign(attempt, { request_id: "request-2", payout_correlation_id: "payment-2", approval_id: "approval-2", owner_step_correlation_id: null, attempt: 2 });
  if (!options.sameObligation) Object.assign(attempt, { judgment_id: "judgment-2", seq: 2 });
  if (options.otherJob) Object.assign(attempt, { contract_id: "job-2" });
  f.inspection.attempts.push(attempt);
  if (!options.otherJob) {
    f.inspection.jobs[0]!.payout_request_ids.push(attempt.request_id);
    f.collection.payouts.push(observed("request-2", { ...payout(f), request_id: "request-2", correlation_id: "payment-2" }));
    f.collection.payments.push(observed("payment-2", { ...structuredClone(payment(f)), approval_id: "approval-2" }));
  }
  return attempt;
}
function freezeDeep(value: unknown): void {
  if (value && typeof value === "object") { Object.freeze(value); for (const item of Object.values(value)) freezeDeep(item); }
}
function reject(f: Fixture) {
  let error: unknown;
  try { previewRecovery(f.inspection, f.collection); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(RecoveryPreviewError);
  expect((error as RecoveryPreviewError).code).toBe("invalid_evidence");
}

describe("pure recovery correction preview", () => {
  for (const version of [2, 3] as const) {
    test(`v${version}: consistent non-execution is reported with no permission or mutation`, () => {
      const f = fixture(version);
      const before = JSON.stringify(f);
      freezeDeep(f);
      const preview = previewRecovery(f.inspection, f.collection);
      expect(preview).toMatchObject({ clearance: "none", requires_review: true, requires_fresh_evidence: true,
        snapshot_sha256: f.inspection.snapshot.sha256, binding_sha256: hashCanonical(f.collection.binding), collection_sha256: hashCanonical(f.collection) });
      expect(preview.items[0]).toMatchObject({ request_id: "request-1", category: "non_execution_reported", stored: { never_executed: false, resolution: "reowe" } });
      expect(preview.items[0]!.reported.payout).toEqual(f.collection.payouts[0]!.result);
      expect(preview.ledger_findings).toEqual(f.inspection.findings);
      expect(preview.limitations.join(" ")).toContain("Full signed terms, signatures");
      expect(preview.limitations.join(" ")).toContain("operator-declared");
      expect(preview.limitations.join(" ")).toContain("not readiness to release");
      expect(JSON.stringify(f)).toBe(before);
      expect(preview).toEqual(previewRecovery(f.inspection, f.collection));
      expect(Object.keys(preview).sort()).not.toContain("sql");
      expect(Object.keys(preview).sort()).not.toContain("repairs");
      expect(Object.keys(preview).sort()).not.toContain("import_payload");
    });

    for (const field of ["tx_hash", "refund_tx_hash", "refunded_amount"] as const) for (const value of ["", "0", "counterevidence"]) {
      test(`v${version}: stored ${field}=${JSON.stringify(value)} survives and contradicts fresh proof`, () => {
        const f = fixture(version);
        f.inspection.attempts[0]![field] = value;
        const preview = previewRecovery(f.inspection, f.collection);
        expect(preview.items[0]!.category).toBe("contradictory");
        expect(preview.items[0]!.stored[field]).toBe(value);
        expect(preview.items[0]!.reason_codes).toContain("non_execution_contradicted");
        expect(preview.items[0]!.review_note).toContain("restored to commitment");
      });
    }
    for (const field of ["tx_hash", "destination_tx_hash", "refund_tx_hash", "refunded_amount"] as const) {
      test(`v${version}: observed ${field} is retained as contradiction even if stored proof exists`, () => {
        const f = fixture(version);
        f.inspection.attempts[0]!.never_executed = true;
        payment(f)[field] = field === "refunded_amount" ? "0" : "observed-evidence";
        const preview = previewRecovery(f.inspection, f.collection);
        expect(preview.items[0]!.category).toBe("contradictory");
        expect(preview.items[0]!.reported.payment).toEqual(f.collection.payments[0]!.result);
      });
    }

    test(`v${version}: coherent successful payment is accounted without releasing anything`, () => {
      const f = fixture(version); paid(f);
      const preview = previewRecovery(f.inspection, f.collection);
      expect(preview.items[0]!.category).toBe("payment_reported");
      expect(preview.accounting).toMatchObject({ all_reported_success_request_ids: ["request-1"], payment_reported_request_ids: ["request-1"],
        excluded_success_request_ids: [], matched_status_report_subtotal_atomic: "300000000", historically_released_request_ids: ["request-1"] });
      expect(preview.clearance).toBe("none");
    });

    for (const field of ["tx_hash", "destination_tx_hash"] as const) test(`v${version}: successful ${field} remains in the matched status report subtotal`, () => {
      const f = fixture(version); paid(f);
      payment(f).tx_hash = null;
      payment(f)[field] = "successful-transaction";
      const preview = previewRecovery(f.inspection, f.collection);
      expect(preview.items[0]!.category).toBe("payment_reported");
      expect(preview.accounting).toMatchObject({ all_reported_success_request_ids: ["request-1"], payment_reported_request_ids: ["request-1"],
        excluded_success_request_ids: [], matched_status_report_subtotal_atomic: "300000000" });
      expect(preview.accounting).not.toHaveProperty("payment_reported_amount_atomic");
    });

    for (const source of ["stored", "observed"] as const) for (const [field, value] of [
      ["refund_tx_hash", "refund-transaction"], ["refunded_amount", "300000000"], ["refunded_amount", "0"],
    ] as const) test(`v${version}: ${source} ${field}=${value} conflicts with success and leaves related attempts unresolved`, () => {
      const f = fixture(version); paid(f);
      const evidence = source === "stored" ? f.inspection.attempts[0]! : payment(f);
      evidence[field] = value;
      const preview = previewRecovery(f.inspection, f.collection);
      expect(preview.items[0]!.category).toBe("contradictory");
      expect(preview.items[0]!.reason_codes).toContain("success_refund_conflict");
      expect(preview.accounting).toMatchObject({ all_reported_success_request_ids: ["request-1"], payment_reported_request_ids: [],
        excluded_success_request_ids: ["request-1"], matched_status_report_subtotal_atomic: "0", possible_duplicate_groups: [] });
      expect(preview.clearance).toBe("none");

      const related = fixture(version); addAttempt(related, { sameObligation: true }); paid(related, 1);
      const peerEvidence = source === "stored" ? related.inspection.attempts[1]! : payment(related, 1);
      peerEvidence[field] = value;
      const peerPreview = previewRecovery(related.inspection, related.collection);
      expect(peerPreview.items[0]!.category).toBe("retain_commitment");
      expect(peerPreview.items[0]!.reason_codes).toContain("related_attempt_unresolved");
      expect(peerPreview.items[1]!.category).toBe("contradictory");
      expect(peerPreview.items[1]!.reason_codes).toContain("success_refund_conflict");
      expect(peerPreview.accounting).toMatchObject({ all_reported_success_request_ids: ["request-2"], payment_reported_request_ids: [],
        excluded_success_request_ids: ["request-2"], matched_status_report_subtotal_atomic: "0", possible_duplicate_groups: [] });
    });

    test(`v${version}: failed/REFUNDED is a valid refund report that retains commitment and related uncertainty`, () => {
      const f = fixture(version);
      Object.assign(payout(f), { status: "REFUNDED", never_executed: false });
      Object.assign(payment(f), { status: "REFUNDED", refund_tx_hash: "refund-transaction", refunded_amount: "300000000" });
      const preview = previewRecovery(f.inspection, f.collection);
      expect(preview.items[0]!.category).toBe("retain_commitment");
      expect(preview.items[0]!.reason_codes).toContain("refund_reported");
      expect(preview.items[0]!.reason_codes).not.toContain("payout_state_status_conflict");
      expect(preview.accounting).toMatchObject({ all_reported_success_request_ids: [], excluded_success_request_ids: [], matched_status_report_subtotal_atomic: "0" });

      const related = fixture(version); addAttempt(related, { sameObligation: true });
      Object.assign(payout(related, 1), { status: "REFUNDED", never_executed: false });
      Object.assign(payment(related, 1), { status: "REFUNDED", refunded_amount: "300000000" });
      const peerPreview = previewRecovery(related.inspection, related.collection);
      expect(peerPreview.items.map(item => item.category)).toEqual(["retain_commitment", "retain_commitment"]);
      expect(peerPreview.items[0]!.reason_codes).toContain("related_attempt_unresolved");
    });

    test(`v${version}: REFUNDED contradicts explicit non-execution even before other refund evidence arrives`, () => {
      const f = fixture(version);
      payout(f).status = "REFUNDED";
      const preview = previewRecovery(f.inspection, f.collection);
      expect(preview.items[0]!.category).toBe("contradictory");
      expect(preview.items[0]!.reason_codes).toContain("non_execution_contradicted");
      expect(preview.items[0]!.reason_codes).not.toContain("payout_state_status_conflict");
    });

    for (const state of ["failed", "succeeded"] as const) test(`v${version}: ${state} with null provider status remains unknown, including for a related attempt`, () => {
      const f = fixture(version);
      if (state === "succeeded") paid(f);
      else payout(f).never_executed = false;
      payout(f).status = null;
      const preview = previewRecovery(f.inspection, f.collection);
      expect(preview.items[0]!.category).toBe("retain_commitment");
      expect(preview.items[0]!.reason_codes).toContain("payout_status_unknown");
      expect(preview.items[0]!.reason_codes).not.toContain("payout_state_status_conflict");
      expect(preview.accounting).toMatchObject({ all_reported_success_request_ids: state === "succeeded" ? ["request-1"] : [],
        excluded_success_request_ids: state === "succeeded" ? ["request-1"] : [], matched_status_report_subtotal_atomic: "0" });

      const related = fixture(version); addAttempt(related, { sameObligation: true });
      if (state === "succeeded") paid(related, 1);
      else payout(related, 1).never_executed = false;
      payout(related, 1).status = null;
      const peerPreview = previewRecovery(related.inspection, related.collection);
      expect(peerPreview.items.map(item => item.category)).toEqual(["retain_commitment", "retain_commitment"]);
      expect(peerPreview.items[0]!.reason_codes).toContain("related_attempt_unresolved");
    });
  }

  test("null status alone cannot contradict a failed request's proof, while other observed conflicts still can", () => {
    const f = fixture(); payout(f).status = null;
    expect(previewRecovery(f.inspection, f.collection).items[0]!.category).toBe("retain_commitment");
    payment(f).status = "SUCCESS";
    const preview = previewRecovery(f.inspection, f.collection);
    expect(preview.items[0]!.category).toBe("contradictory");
    expect(preview.items[0]!.reason_codes).toContain("non_execution_contradicted");
    expect(preview.items[0]!.reason_codes).toContain("payout_payment_status_conflict");
  });

  for (const status of ["UNKNOWN", "UNCERTAIN", "NEEDS_REVIEW"] as const) for (const source of ["payout", "payment"] as const)
    test(`${source} ${status} remains unresolved despite stored/live proof, without hiding actual refund evidence`, () => {
      const f = fixture(); f.inspection.attempts[0]!.never_executed = true;
      const response = source === "payout" ? payout(f) : payment(f);
      response.status = status;
      const preview = previewRecovery(f.inspection, f.collection);
      expect(preview.items[0]!.category).toBe("retain_commitment");
      expect(preview.items[0]!.reason_codes).toContain(`${source}_status_unknown`);
      expect(preview.items[0]!.reason_codes).not.toContain("non_execution_contradicted");

      const related = fixture(); addAttempt(related, { sameObligation: true });
      const peerResponse = source === "payout" ? payout(related, 1) : payment(related, 1);
      peerResponse.status = status;
      const peerPreview = previewRecovery(related.inspection, related.collection);
      expect(peerPreview.items.map(item => item.category)).toEqual(["retain_commitment", "retain_commitment"]);
      expect(peerPreview.items[0]!.reason_codes).toContain("related_attempt_unresolved");

      const success = fixture(); paid(success);
      const successResponse = source === "payout" ? payout(success) : payment(success);
      successResponse.status = status;
      const successPreview = previewRecovery(success.inspection, success.collection);
      expect(successPreview.items[0]!.category).toBe("retain_commitment");
      expect(successPreview.accounting).toMatchObject({ all_reported_success_request_ids: ["request-1"], excluded_success_request_ids: ["request-1"],
        matched_status_report_subtotal_atomic: "0" });

      payment(f).refunded_amount = "0";
      const contradiction = previewRecovery(f.inspection, f.collection);
      expect(contradiction.items[0]!.category).toBe("contradictory");
      expect(contradiction.items[0]!.reason_codes).toContain("non_execution_contradicted");
    });

  for (const status of ["PROCESSING", "PENDING_APPROVAL"] as const) test(`explicit ${status} still contradicts positive non-execution proof`, () => {
    const f = fixture(); payment(f).status = status;
    const preview = previewRecovery(f.inspection, f.collection);
    expect(preview.items[0]!.category).toBe("contradictory");
    expect(preview.items[0]!.reason_codes).toContain("non_execution_contradicted");
  });

  for (const incomplete of ["unsupported request", "unavailable payout", "unavailable payment"] as const)
    test(`success claims excluded for ${incomplete} remain visible when the matched subtotal is zero`, () => {
      const f = fixture(); paid(f);
      if (incomplete === "unsupported request") payment(f).request = null;
      if (incomplete === "unavailable payout") { f.collection.payouts[0]!.result = failedRead(); f.collection.complete = false; }
      if (incomplete === "unavailable payment") { f.collection.payments[0]!.result = failedRead(); f.collection.complete = false; }
      const preview = previewRecovery(f.inspection, f.collection);
      expect(preview.items[0]!.category).toBe("retain_commitment");
      expect(preview.accounting).toMatchObject({ all_reported_success_request_ids: ["request-1"], payment_reported_request_ids: [],
        excluded_success_request_ids: ["request-1"], matched_status_report_subtotal_atomic: "0" });
    });

  test("the matched subtotal separates included and mismatched success reports without claiming a complete paid total", () => {
    const f = fixture(); addAttempt(f, { sameObligation: true }); paid(f); paid(f, 1);
    payment(f, 1).request!.recipient = "someone-else";
    const preview = previewRecovery(f.inspection, f.collection);
    expect(preview.accounting).toMatchObject({ all_reported_success_request_ids: ["request-1", "request-2"], payment_reported_request_ids: ["request-1"],
      excluded_success_request_ids: ["request-2"], matched_status_report_subtotal_atomic: "300000000", possible_duplicate_groups: [] });
    expect(preview.clearance).toBe("none");
    expect(preview.limitations.join(" ")).toContain("not net settlement or a complete paid total");
  });

  for (const [name, change] of [
    ["never-executed false", (f: Fixture) => { payout(f).never_executed = false; }],
    ["never-executed missing", (f: Fixture) => { payout(f).never_executed = null; }],
    ["failure status alone", (f: Fixture) => { payout(f).state = "unknown"; payout(f).never_executed = null; }],
    ["not found", (f: Fixture) => { payout(f).state = "not_found"; payout(f).never_executed = null; }],
    ["refused", (f: Fixture) => { payout(f).state = "refused"; payout(f).never_executed = null; }],
    ["request absent", (f: Fixture) => { payment(f).request = null; }],
    ["missing legacy proof column", (f: Fixture) => { f.inspection.findings.push({ code: "missing_column", table: "payout_attempts", column: "never_executed", message: "Legacy column absent." }); }],
    ["missing legacy refund column", (f: Fixture) => { f.inspection.findings.push({ code: "missing_column", table: "payout_attempts", column: "refunded_amount", message: "Legacy column absent." }); }],
    ["missing relation table", (f: Fixture) => { f.inspection.findings.push({ code: "missing_table", table: "owner_steps", message: "Relation table absent." }); }],
    ["payout unavailable", (f: Fixture) => { f.collection.payouts[0]!.result = failedRead(); f.collection.complete = false; }],
    ["payment unavailable", (f: Fixture) => { f.collection.payments[0]!.result = failedRead(); f.collection.complete = false; }],
    ["held unavailable", (f: Fixture) => { f.collection.held.result = failedRead(); f.collection.complete = false; f.collection.unmatched_held_count = null; }],
    ["owner unavailable", (f: Fixture) => { f.collection.owners[0]!.result = failedRead(); f.collection.complete = false; }],
    ["owner unsettled", (f: Fixture) => { f.collection.owners[0]!.result = ok({ stage: "submitted", phase: "submitted", status: "PROCESSING" }); }],
    ["owner terminal phase without outcome", (f: Fixture) => { f.collection.owners[0]!.result = ok({ stage: "submitted", phase: "settled", status: null }); }],
    ["owner expired plus SUCCESS", (f: Fixture) => { f.collection.owners[0]!.result = ok({ stage: "expired", phase: "expired", status: "SUCCESS" }); }],
    ["owner expired plus PROCESSING", (f: Fixture) => { f.collection.owners[0]!.result = ok({ stage: "expired", phase: "expired", status: "PROCESSING" }); }],
    ["owner unknown plus settled SUCCESS", (f: Fixture) => { f.collection.owners[0]!.result = ok({ stage: "unknown", phase: "settled", status: "SUCCESS" }); }],
    ["owner voting plus settled SUCCESS", (f: Fixture) => { f.collection.owners[0]!.result = ok({ stage: "voting", phase: "settled", status: "SUCCESS" }); }],
    ["owner submitting plus settled SUCCESS", (f: Fixture) => { f.collection.owners[0]!.result = ok({ stage: "submitting", phase: "settled", status: "SUCCESS" }); }],
    ["owner failed plus settled SUCCESS", (f: Fixture) => { f.collection.owners[0]!.result = ok({ stage: "failed", phase: "settled", status: "SUCCESS" }); }],
    ["unmatched held records", (f: Fixture) => { f.collection.unmatched_held_count = 1; }],
    ["matching held payment", (f: Fixture) => { f.collection.held = observed(null, [{ correlation_id: "payment-1", approval_id: "approval-1", request: structuredClone(payment(f).request) }]); }],
    ["unbound same-org owner", (f: Fixture) => { f.inspection.owner_steps[0]!.contract_id = null; }],
  ] as const) test(`${name} retains commitment despite a positive-looking failure`, () => {
    const f = fixture(); change(f);
    const preview = previewRecovery(f.inspection, f.collection);
    expect(preview.items[0]!.category).toBe("retain_commitment");
    expect(preview.clearance).toBe("none");
    expect(preview.requires_review).toBe(true);
  });

  for (const [name, change] of [
    ["foreign request", (f: Fixture) => { payout(f).request_id = "foreign-request"; }],
    ["changed correlation", (f: Fixture) => { payout(f).correlation_id = "foreign-payment"; }],
    ["erased correlation", (f: Fixture) => { payout(f).correlation_id = null; }],
    ["changed approval", (f: Fixture) => { payment(f).approval_id = "foreign-approval"; }],
    ["recipient", (f: Fixture) => { payment(f).request!.recipient = "someone-else"; }],
    ["amount", (f: Fixture) => { payment(f).request!.amount = "300000001"; }],
    ["asset", (f: Fixture) => { payment(f).request!.asset = "other-asset"; }],
    ["chain", (f: Fixture) => { payment(f).request!.chain = "other-chain"; }],
    ["confidential", (f: Fixture) => { payment(f).request!.confidential = false; }],
    ["memo", (f: Fixture) => { payment(f).request!.has_memo = true; }],
    ["stored arrived", (f: Fixture) => { f.inspection.attempts[0]!.resolution = "arrived"; }],
    ["stored paid", (f: Fixture) => { f.inspection.attempts[0]!.state = "paid"; }],
    ["proof versus processing", (f: Fixture) => { payout(f).state = "processing"; payout(f).status = "PROCESSING"; }],
    ["failed status mismatch", (f: Fixture) => { payout(f).status = "PROCESSING"; }],
    ["payout/payment mismatch", (f: Fixture) => { payment(f).status = "SUCCESS"; }],
    ["held request mismatch", (f: Fixture) => { f.collection.held = observed(null, [{ correlation_id: "payment-1", approval_id: "foreign-approval", request: null }]); }],
  ] as const) test(`${name} is a contradiction, not a release candidate`, () => {
    const f = fixture(); change(f);
    expect(previewRecovery(f.inspection, f.collection).items[0]!.category).toBe("contradictory");
  });

  test("replacement and original observations remain distinct, unknown peers block positive reports", () => {
    const f = fixture(); addAttempt(f, { sameObligation: true });
    payout(f, 1).state = "unknown"; payout(f, 1).never_executed = null;
    const preview = previewRecovery(f.inspection, f.collection);
    expect(preview.items[0]).toMatchObject({ category: "retain_commitment", same_obligation_request_ids: ["request-2"], other_same_job_request_ids: [] });
    expect(preview.items[0]!.reason_codes).toContain("related_attempt_unresolved");
    expect(preview.items[1]!.reported.payout).toEqual(f.collection.payouts[1]!.result);
  });
  test("a successful peer that is also held cannot clear related-attempt uncertainty", () => {
    const f = fixture(); addAttempt(f, { sameObligation: true }); paid(f, 1);
    f.collection.held = observed(null, [{ correlation_id: "payment-2", approval_id: "approval-2", request: structuredClone(payment(f, 1).request) }]);
    const preview = previewRecovery(f.inspection, f.collection);
    expect(preview.items[0]!.category).toBe("retain_commitment");
    expect(preview.items[0]!.reason_codes).toContain("related_attempt_unresolved");
    expect(preview.items[1]!.category).toBe("contradictory");
    expect(preview.items[1]!.reason_codes).toContain("paid_payment_still_held");
    expect(preview.accounting.payment_reported_request_ids).toEqual([]);
  });
  test("one payment reported both successful and held is contradictory and excluded from coherent totals", () => {
    const f = fixture(); paid(f);
    f.collection.held = observed(null, [{ correlation_id: "payment-1", approval_id: "approval-1", request: structuredClone(payment(f).request) }]);
    const preview = previewRecovery(f.inspection, f.collection);
    expect(preview.items[0]!.category).toBe("contradictory");
    expect(preview.items[0]!.reason_codes).toContain("paid_payment_still_held");
    expect(preview.held_observation).toEqual(f.collection.held);
    expect(preview.accounting.payment_reported_request_ids).toEqual([]);
    expect(preview.accounting.matched_status_report_subtotal_atomic).toBe("0");
  });
  for (const [name, change] of [
    ["unsupported original request", (f: Fixture) => { payment(f, 1).request = null; }],
    ["retained refunded amount", (f: Fixture) => { f.inspection.attempts[1]!.refunded_amount = "300000000"; }],
    ["observed refunded amount", (f: Fixture) => { payment(f, 1).refunded_amount = "300000000"; }],
  ] as const) test(`related proof alone cannot resolve a peer with ${name}`, () => {
    const f = fixture(); addAttempt(f, { sameObligation: true }); change(f);
    const preview = previewRecovery(f.inspection, f.collection);
    expect(preview.items[0]!.category).toBe("retain_commitment");
    expect(preview.items[0]!.reason_codes).toContain("related_attempt_unresolved");
    expect(preview.items[1]!.category).not.toBe("non_execution_reported");
  });
  test("different judgment same job is context, never inferred as duplicate or replacement", () => {
    const f = fixture(); addAttempt(f); paid(f); paid(f, 1);
    const preview = previewRecovery(f.inspection, f.collection);
    expect(preview.items.map(item => item.category)).toEqual(["payment_reported", "payment_reported"]);
    expect(preview.items[0]).toMatchObject({ same_obligation_request_ids: [], other_same_job_request_ids: ["request-2"] });
    expect(preview.accounting.possible_duplicate_groups).toEqual([]);
    expect(preview.accounting.matched_status_report_subtotal_atomic).toBe("600000000");
  });
  test("same-obligation double success is a possible overpayment, with exact big integer accounting", () => {
    const f = fixture(); addAttempt(f, { sameObligation: true });
    const amount = "900719925474099312345";
    for (let index = 0; index < 2; index++) { f.inspection.attempts[index]!.amount_atomic = amount; payment(f, index).request!.amount = amount; paid(f, index); }
    const preview = previewRecovery(f.inspection, f.collection);
    expect(preview.items.map(item => item.category)).toEqual(["possible_duplicate", "possible_duplicate"]);
    expect(preview.accounting.possible_duplicate_groups).toEqual([["request-1", "request-2"]]);
    expect(preview.accounting.matched_status_report_subtotal_atomic).toBe("1801439850948198624690");
  });
  test("other job attempts never become related because payee and amount match", () => {
    const f = fixture(); addAttempt(f, { otherJob: true, sameObligation: true });
    const preview = previewRecovery(f.inspection, f.collection);
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]).toMatchObject({ category: "non_execution_reported", same_obligation_request_ids: [], other_same_job_request_ids: [] });
  });
  test("discovering original correlation is allowed only when no stored correlation exists", () => {
    const f = fixture(); f.inspection.attempts[0]!.payout_correlation_id = null;
    expect(previewRecovery(f.inspection, f.collection).items[0]!.category).toBe("non_execution_reported");
    payout(f).request_id = "foreign-request";
    reject(f); // Foreign response must never authorize the now-extra payment read.
  });
  test("distinct requests cannot reuse one discovered original-payment read as proof", () => {
    const f = fixture(); addAttempt(f, { sameObligation: true });
    f.inspection.attempts[1]!.payout_correlation_id = null;
    payout(f, 1).correlation_id = "payment-1";
    f.collection.payments.pop();
    reject(f);
  });
  test("two new correlations cannot alias one another despite distinct request replies", () => {
    const f = fixture(); addAttempt(f, { sameObligation: true });
    for (const attempt of f.inspection.attempts) attempt.payout_correlation_id = null;
    payout(f, 1).correlation_id = "payment-1";
    f.collection.payments.pop();
    reject(f);
  });
  test("expired owner record is terminal but does not itself prove payment non-execution", () => {
    const f = fixture(); f.collection.owners[0]!.result = ok({ stage: "expired", phase: "expired", status: null });
    expect(previewRecovery(f.inspection, f.collection).items[0]!.category).toBe("non_execution_reported");
    payout(f).never_executed = null;
    expect(previewRecovery(f.inspection, f.collection).items[0]!.category).toBe("retain_commitment");
  });

  for (const [name, change] of [
    ["snapshot digest", (f: Fixture) => { f.collection.snapshot.sha256 = "f".repeat(64); }],
    ["snapshot bytes", (f: Fixture) => { f.collection.snapshot.bytes++; }],
    ["binding digest", (f: Fixture) => { f.collection.binding_sha256 = "f".repeat(64); }],
    ["binding snapshot", (f: Fixture) => { f.collection.binding.snapshot_sha256 = "f".repeat(64); }],
    ["binding deployment", (f: Fixture) => { f.collection.binding.deployment = "other-deployment"; f.collection.binding_sha256 = hashCanonical(f.collection.binding); }],
    ["binding job", (f: Fixture) => { f.collection.binding.contract_id = "other-job"; f.collection.binding_sha256 = hashCanonical(f.collection.binding); }],
    ["binding hash", (f: Fixture) => { f.collection.binding.terms_hash = "f".repeat(64); f.collection.binding_sha256 = hashCanonical(f.collection.binding); }],
    ["binding org", (f: Fixture) => { f.collection.binding.organization = "other-org"; f.collection.binding_sha256 = hashCanonical(f.collection.binding); }],
    ["binding agent", (f: Fixture) => { f.collection.binding.agent_id = "other-agent"; f.collection.binding_sha256 = hashCanonical(f.collection.binding); }],
    ["missing payout", (f: Fixture) => { f.collection.payouts = []; }],
    ["duplicate payout", (f: Fixture) => { f.collection.payouts.push(structuredClone(f.collection.payouts[0]!)); }],
    ["foreign payout", (f: Fixture) => { f.collection.payouts[0]!.target_id = "foreign-request"; }],
    ["missing payment", (f: Fixture) => { f.collection.payments = []; }],
    ["duplicate payment", (f: Fixture) => { f.collection.payments.push(structuredClone(f.collection.payments[0]!)); }],
    ["foreign payment", (f: Fixture) => { f.collection.payments[0]!.target_id = "foreign-payment"; }],
    ["missing owner", (f: Fixture) => { f.collection.owners = []; }],
    ["duplicate owner", (f: Fixture) => { f.collection.owners.push(structuredClone(f.collection.owners[0]!)); }],
    ["foreign owner", (f: Fixture) => { f.collection.owners[0]!.target_id = "foreign-owner"; }],
    ["foreign held correlation", (f: Fixture) => { f.collection.held = observed(null, [{ correlation_id: "foreign-payment", approval_id: "approval-1", request: null }]); }],
    ["held target", (f: Fixture) => { f.collection.held.target_id = "payment-1"; }],
    ["complete flag", (f: Fixture) => { f.collection.complete = false; }],
    ["held count absent", (f: Fixture) => { f.collection.unmatched_held_count = null; }],
    ["reversed timestamps", (f: Fixture) => { f.collection.completed_at = "2026-11-10T00:00:00.000Z"; }],
    ["out-of-envelope timestamp", (f: Fixture) => { f.collection.payments[0]!.started_at = "2026-11-10T00:00:00.000Z"; }],
    ["invalid response digest", (f: Fixture) => { f.collection.payments[0]!.result.response_sha256 = "not-a-digest"; }],
    ["unrecognized payload", (f: Fixture) => { Object.assign(payment(f), { private_payload: "secret-not-to-echo" }); }],
    ["authority flag", (f: Fixture) => { Object.assign(f.collection, { clearance: "resume" }); }],
  ] as const) test(`refuses mismatching or malformed ${name} without returning a partial advisory`, () => {
    const f = fixture(); change(f); reject(f);
  });

  test("collection digest changes with evidence and output never echoes unprojected ledger fields", () => {
    const f = fixture();
    Object.assign(f.inspection.attempts[0]!, { private_owner_payload: "never-echo-owner-payload", report_body: "never-echo-report" });
    const first = previewRecovery(f.inspection, f.collection);
    payout(f).never_executed = false;
    const second = previewRecovery(f.inspection, f.collection);
    expect(first.collection_sha256).not.toBe(second.collection_sha256);
    expect(JSON.stringify(second)).not.toContain("never-echo");
  });
});
