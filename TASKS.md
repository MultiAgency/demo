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

## Required before accepting both agency ownership modes

User requirement, 2026-11-12: builder jobs must work for wallet owner `multiagentic.near` and DAO owner `agentic.sputnik-dao.near`, with builder/payee `buildr.near` and attacker fixture role `hackr.near`. These are planned account roles, not permission to sign or spend. DAO representative authority remains to be verified from the DAO policy.

- [x] Review the platform-owned DAO payout action contract supplied in the local SDK 0.5.9 handoff. Verified tarball SHA-256 `68a9924c224a3c7969c72243cefeb4e37864e0973f61e9c671bb39bd2759600b`: `payout` is a DAO consent scope; payout-agent creation, payout grants and approval votes are admitted; `read,payout` covers requests while a consent containing `owner` is refused. Earlier 0.5.7/0.5.8 refusals are superseded by this candidate contract, not by a hosted rollout. Do not substitute treasury/Market authority or wallet credentials.
- [x] Adopt the SDK 0.5.9 candidate reproducibly and obtain an immutable matching gateway snapshot. The verified local/unpublished tarball is pinned under `vendor/multiagency-sdk` with checksum/provenance; the Docker build copies it before dependency installation. Matching snapshot `8f65066e6013f0c9f7fd68717f3bd11103b35d216034c329f002212fb3c6c0a7` is pinned in `gateway-pin.json` and verified with the platform-owned verifier. Extend the payout port/client to retain DAO proposal replies, omit wallet ownership on DAO creation, use the `payout` grant label and never call wallet `owner/submit` for DAO actions. Follow the platform handoff in `sdk/docs/app-access.md`.
- [x] Add explicitly signed optional DAO ownership to v3 report/invoice terms, distinct from the human representative; retain existing jobs' original terms, hashes, recipients and wallet ownership without reinterpretation.
- [x] Route DAO setup, consents, creation, grant, policy and exact payout approval through supported platform proposals. Platform and chain checks retain membership, action permission, quorum, expiry and revocation authority; representative authentication alone cannot authorize spending. The human signs job terms, while each DAO action requires its own passed proposal. Actual hosted membership/quorum and wallet filing remain unverified.
- [ ] Prove wallet and DAO workflows with simulated funds, including rejected/expired votes, unrelated actors, lost replies, restart and same-payment observation. Keep live budgets, fee limits, signatures and deployment separately authorized.

The local implementation now supports v3 DAO-owned builder jobs. Terms signatures belong to the named human representative and builder; they do not prove membership or grant spending authority. DAO action authority remains enforced by the platform and on-chain proposals. Simulated rejection/revision/settlement and original-approval recovery in a second app process pass; this does not establish SIGKILL recovery for the new DAO path, hosted wallet voting or mainnet settlement. See the DAO recipe in docs/job-demo.md.

## Short backlog

- Separate Market task observation from payment completion and address authority renewal/worker pagination.
- Define recovery for lost job-creation replies and invitations.

These are candidates, not agreed priorities. Additional source/application and platform dependencies remain in PROGRESS. Split a candidate into executable steps when it is selected.

Release review limitation (2026-11-12): retrying an unanswered DAO setup/consent filing with saved text can create a new gateway request hash. Saved-body reuse is not recovery of that unknown request; only known IDs are polled. The paired release review records quota/unsigned-request impact, with no demonstrated duplicate payout. Fresh committed platform/SDK release artifacts and Paperwork Linux/container packaging remain separate release gates.
