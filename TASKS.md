# Tasks

Work on one task at a time, with a concrete result and an appropriate check. Routine implementation choices within an authorized task do not need another approval round; changes to authority or live operations follow [RULES.md](RULES.md).

## Selected priority: payment and recovery

Selected 2026-11-11 for the local milestone covering both Report and invoice and Pay on merge. Public verification and the complete walkthroughs follow this work.

- [x] Approve the policy requiring positive platform non-execution proof for new and existing v2/v3 jobs before failed-payment budget release, with review of older exceptions.
- [x] Specify the historical recovery sequence and required stand-in/SDK acceptance cases in [Recovery and local acceptance](docs/recovery-acceptance.md).
- [x] Build the standalone read-only inspector against disposable historical fixtures: inventory original/replacement IDs without migrations, auth, timers or send-capable calls. Command and supported snapshot format: [inspect a snapshot](docs/recovery-acceptance.md#inspect-a-snapshot).
- [x] Extend `Engine.resolve()` and startup compatibility checks to both workflows. Retain transaction/refund counterevidence and failed-payment identity across contradictory observations; unsafe historical ledgers refuse startup before migration.
- [x] Verify engine/authenticated HTTP refusals without writes or new payout requests, valid proof, unchanged unsafe-ledger refusal, safe reopen and original identities across fixture response loss/database reopen.
- [x] Add one-job allowlisted SDK status collection and a review-only correction preview, with explicit binding, redaction, deadlines and unchanged source snapshots. [Command and limits](docs/recovery-acceptance.md#collect-evidence-and-preview-one-job).
- [x] Correct preview reporting: refunded success claims are excluded from the matched status-report subtotal and remain visible; valid SDK refunds/unknown statuses retain commitment. Verified pure preview and installed-SDK/CLI regressions, including related attempts and normal successful transaction evidence.
- [x] Verify one collector journey against an isolated SDK stack: original request/correlation retained, all four read procedures complete, snapshot/source unchanged, provider payment count unchanged and owned processes stopped. [Receipt and limits](docs/recovery-acceptance.md#sdk-collector-integration-checkpoint).
- [x] Define one restoration-only correction contract with explicit before/after accounting, evidence/verification limits and refusal cases. [First correction contract](docs/recovery-acceptance.md#first-correction-contract-restore-one-commitment).
- [x] Implement that reviewed correction transaction in memory against disposable fixtures; preserve prior records/evidence and test refusal without source mutation, exact replay and stale/conflicting observations.
- [x] Add a restoration-only private export command with durable completion, verified completed-bundle reuse and disposable process-interruption/lost-result tests. [Usage and handoff limits](docs/recovery-acceptance.md#export-a-restoration-bundle).
- [x] Rehearse whole-database blocker inventory and supervised handoff on disposable exports: both-version stand-in full/partial/unknown cases and v3 SDK processing/restart/original full settlement. The mixed-history copy remains blocked. [Scope and evidence](docs/recovery-acceptance.md#whole-database-recovery-rehearsal).
- [ ] Complete the acceptance matrix, including missing v2 browser, clean SDK happy-path and independent process-restart branches.

The proof/startup guard, collector/preview, restoration/export and scoped disposable handoff rehearsal are verified. Real historical provenance and unsupported recovery cases remain unresolved; the remaining acceptance branches stay open. Implement the approved privacy boundary below before the final browser acceptance work. Existing Hermes work remains recorded below.

## Hermes report-review assistant

The user requested Hermes with NEAR AI Cloud, the MultiAgency team account and latest stable integration releases on 2026-11-11.

- [x] Add a separate stored-data review projection without platform follow-up or compensation actions.
- [x] Bridge authenticated Hermes Runs to CopilotKit/AG-UI with scoped ephemeral streams.
- [x] Validate citations and add editable feedback, explicit apply and cancellation.
- [x] Resolve latest stable dependencies; document team-profile setup and limits.
- [x] Complete the isolated desktop/mobile browser check and final source checks.
- [x] Prepare the inactive `paperwork-review` team profile and a one-request synthetic hosted check; verify saved restrictions without credentials.
- [x] Review the local key-setup helper and hosted-check diagnostics offline; fix completion/escaped-key validation, pin the helper origin and recheck key state after its prompt. [Current review and remaining race](docs/hermes-review.md#offline-key-setup-review-checkpoint--2026-11-11).
- [ ] Verify authenticated profile Runs connectivity and actual NEAR routing under the existing operational boundary. User-reported Chat output and a prior key-save acknowledgement do not establish this connection, provider origin, effective isolation or the requested hosted-version update.

Offline implementation and the hosted connection have separate evidence. See [Hermes review](docs/hermes-review.md).

## Next: private jobs and limited public verification

- [x] Approve private full details for new and existing v2 jobs, with limited public verification; [access contract](docs/recovery-acceptance.md#v2-privacy--approved).
- [ ] Enforce named-party full-job/detailed-verification reads and own-role signing requests. Authorize protected reads before SDK work, remove owner-only fields from builder views and use generic refusals/no-cache responses.
- [ ] Add the minimal public verification projection without raw identity/financial/consent data, and render it without an unauthorized full-job read in `src/web/pages/Verify.tsx`.
- [ ] Correct the claim that the funded total caps the job.
- [ ] Check new/existing v2 and v3 jobs with anonymous, unrelated and named accounts, including original invitations, account switches, refresh errors and a focused browser run.

Done when the public view exposes only the approved fields, party/representative access follows the matrix, existing signatures/invitations remain valid, and the funding explanation matches the accounting boundary. The current defects are recorded in [PROGRESS.md](PROGRESS.md).

## Short backlog

- Separate Market task observation from payment completion and address authority renewal/worker pagination.
- Define recovery for lost job-creation replies and invitations.

These are candidates, not agreed priorities. Additional source/application and platform dependencies remain in PROGRESS. Split a candidate into executable steps when it is selected.
