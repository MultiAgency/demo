# Recovery and local acceptance

Prepared **2026-11-11** for the milestone in [PRD](../PRD.md): complete Report and invoice and Pay on merge jobs in local simulation. Read-only inventory, evidence collection/review preview and both-version proof/startup guards are implemented. Correction/import, resumption and remaining acceptance work below are still planned. Hosted operations remain subject to workspace authorization.

## Historical reconciliation

The enforced rule covers new and existing v2/v3 jobs: failed-payment budget release requires positive platform non-execution evidence without contradictions. Startup checks rejected/manual-release outcomes without relying on parent terms/version, and also refuses recorded refusals with stored transaction/refund counterevidence. Because storage is shared, refusal can block unrelated jobs, sign-in and Market too.

Runtime observations retain the original failed-payment binding, revoke proof when status regresses or conflicts, and preserve the first observed non-null refund amount in `refunded_amount`. A later missing field or unavailable read cannot erase that evidence. Compatible databases receive the nullable column additively; unsafe databases refuse before migration. Older refund observations that were never stored cannot be reconstructed by this change and still need authoritative collection/reconciliation.

The standalone inspector and SDK evidence collector exist. The historical correction importer does **not** exist yet. Ordinary app startup, representative job-detail reads and timers are unsuitable for inspection: they may migrate records or advance payments. Already-resolved historical rows also cannot be repaired through the current `Engine.resolve()` action.

### Inspect a snapshot

```sh
bun --no-env-file scripts/inspect-ledger.ts /path/to/standalone-snapshot.sqlite
```

The [CLI](../scripts/inspect-ledger.ts) emits JSON with the snapshot digest, stored deployment, job/payment identities, related attempts, retained refund amounts and review findings. Missing legacy refund-amount columns remain unknown and produce a finding without migration. It excludes reports, full terms, signatures, invitation/auth data and owner signing/confirmation payloads. Financial identities/amounts in the inventory still belong in the operator's protected records.

The [inspector](../src/server/recovery/inspect.ts) reads a regular standalone snapshot, hashes the bytes and deserializes them into read-only memory. It rejects symlinks, WAL-format headers and any WAL/SHM/journal sidecars; it never checkpoints or exports a running database. Operators must prepare a consistent snapshot that includes committed WAL content. Limits: 64 MiB, 10,000 rows per projected table and 200 attempts per job; oversized inputs fail rather than return a partial inventory.

Exit codes: **0** inventory without findings; **2** inventory requires review; **1** input/schema/inspection error, with no partial report. Neither successful inventory nor stored proof verifies the platform outcome, signed terms/signatures, snapshot freshness or permission to resume payments. Missing fields remain unknown, and the original platform host must come from trusted provenance.

### Collect evidence and preview one job

```sh
bun --no-env-file scripts/collect-ledger-evidence.ts /protected/standalone-snapshot.sqlite /protected/binding.json /protected/credential-file
```

This [standalone command](../scripts/collect-ledger-evidence.ts) loads no dotenv or app runtime. It checks one explicitly selected job and every retained payout attempt for it, including original/replacement attempts. It validates the snapshot and manifest before loading the credential, uses four SDK reads, then re-inspects the snapshot before printing. A changed source produces no report. Source snapshots and credentials are never rewritten. Development checks use only synthetic fixtures; no real credential or production state was used in this workspace.

The manifest is a JSON object with these required fields; the [schema](../src/server/recovery/evidence.ts) is authoritative:

| Field | Required value |
| --- | --- |
| `schema_version` | `1` |
| `snapshot_sha256` | Exact digest from the inspector |
| `provenance_sha256` | Digest of the operator's trusted original binding record |
| `platform_origin` | Original canonical HTTPS origin, without trailing slash/path/query/fragment/userinfo; HTTP is supported only for explicit loopback fixtures |
| `deployment` | Original platform deployment, matching the snapshot |
| `contract_id`, `terms_hash` | Selected job and its stored terms hash |
| `organization`, `agent`, `agent_id` | Original recorded Organization, agent name and agent ID |

Digests are 64 lowercase hexadecimal characters. The manifest records operator-declared provenance; its digest does not authenticate that provenance. The credential is an explicitly provided original server app credential, never included in output. Real historical inputs and credentials remain in the authorized operator's protected environment under the workspace operational boundary.

The [collector](../src/server/recovery/collect.ts) rejects mismatched, malformed or ambiguous selected bindings before any remote call. The [reader](../src/server/recovery/sdk-reader.ts) uses the installed SDK directly and exposes only `payouts/status`, `paymentStatus` with `waitMs: 0`, `held` and `owner/status`. It makes no automatic retries, follows no redirects or returned URLs, and creates no owner preparation or payment request. Limits: 200 selected-job attempts, 200 relevant owner steps, 500 held records, 1 MiB per response, five seconds per read and a 30-second collection budget. Exhaustion becomes explicit incomplete evidence. Unrelated held records are counted and omitted; matching amount/payee never establishes a link.

Output contains `collection` and a pure [review preview](../src/server/recovery/preview.ts), bound to snapshot, manifest and collection digests. Original payment and owner correlations stay distinct. The preview describes non-execution reports, reported payments, retained commitments, contradictions and possible duplicate payments. It compares supported original-request fields when supplied; missing or alternative request shapes remain unsupported. It always has `clearance: "none"`, requires human review and fresh evidence, and supplies no SQL, import payload, replacement identity or permission to start/resume the app. SDK observations cannot independently attest the original deployment/agent binding, complete signed terms or signatures.

The accounting section exposes `matched_status_report_subtotal_atomic`, `all_reported_success_request_ids` and `excluded_success_request_ids`. The subtotal includes only matching, consistent success reports; it is not net payment, an agent balance, a complete paid total or accounting clearance. Success with refund evidence stays visible among reported/excluded successes, is excluded from the subtotal and cannot resolve a related attempt. SDK `failed/REFUNDED` is a valid refunded outcome, not a state contradiction or non-execution proof; absent provider status and explicit unknown outcomes remain unresolved. The reporting corrections are implemented and verified in the checkpoint below.

Exit codes: **0** help; **2** review-only report, even when every read succeeds; **1** input/collection failure without a report. `complete: true` means all selected reads succeeded, not that reconciliation is safe. HTTP response hashes identify received bytes, not platform signatures. Keep successive reports and original provenance in protected operator records; a later report cannot erase prior counterevidence. Correction/import must recheck fresh evidence and all relevant history separately.

### Procedure to implement

1. **Preserve a consistent snapshot.** Coordinate writers/runs before any money-path change. An authorized operator creates a coherent SQLite backup including committed WAL contents, records its digest/schema/candidate, and retains the original. Production state stays in the operator's protected location; it must not enter this workspace.
2. **Inventory read-only.** Use the inspector above; schema introspection and SELECTs run against its in-memory read-only database. It never calls `openDb()`, `createRuntime()`, auth, HTTP handlers or timers. Report terms/version/hash, deployment, Organization/agent, original request/correlation/approval/owner-step IDs, payout lines, historical resolution and related attempts. Same-judgment/sequence peers and other attempts in that job remain separate; amount/payee similarity never establishes a replacement. Missing proof columns mean missing evidence.
3. **Bind observations to the original platform.** Establish original host, deployment, Organization and agent from trusted records; the database alone does not establish the host. Use the original approved server credential outside reports/logs. Never substitute another deployment or infer a binding from matching amount/payee.
4. **Collect evidence through a read allowlist.** Use the collector above with the original binding. Payout and owner-step correlations are separate identities; retain their recorded associations. Never prepare/submit owner actions, approve, retry or request payouts. Retain successive observations with binding, IDs, timestamps, SDK version and response hashes. Hashes identify observations; they are not cryptographic platform attestations.
5. **Prepare an audited correction on a disposable copy.** The proposed importer must re-read authoritative status, validate binding/terms and inspect original/replacement attempts plus live owner intents. Append evidence and a correction record preserving prior values; update effective accounting transactionally under an explicit correction ID. Reject hand-authored proof flags, stale snapshots and conflicting observations. Do not use direct SQL edits or a force-start option.
6. **Validate and resume deliberately.** Rehearse against fixtures first. Before an authorized application, recheck the snapshot and fresh evidence. Confirm all startup blockers are addressed, uncertain amounts remain committed, and no original/replacement pair can silently authorize another send. Resume with one writer and supervised observation. Ordinary startup can advance existing workflows; it is not read-only. Preserve the before/after evidence and compatible recovery artifacts.

### Evidence decisions

| Observation | Permitted outcome |
| --- | --- |
| Terminal failure with explicit `neverExecuted: true`, valid identity/terms binding and no payment/refund contradiction | Candidate for reviewed release, after checking every related replacement |
| Authoritative success | Account for the original payment; do not free its obligation. Reconcile any replacement separately |
| Held, processing, unknown, unavailable, absent record or unresolved external owner intent | Keep blocked/committed; continue authorized observation under original IDs |
| Wrong host/deployment, request conflict, unbound correlation or contradictory evidence | Refuse correction; escalate through the supported platform/operator route |
| Original and replacement both paid | Record an overpayment finding; reconciliation cannot undo it |

`not_found`, a failure code, no transaction hash or an operator assertion is not non-execution proof. If available platform records cannot establish original request binding or a consistent terminal outcome, the case remains blocked. A supported platform reconciliation route is then a dependency, rather than permission to guess.

### Small implementation steps

1. Read-only inspection is implemented and checked against disposable fixtures; use its report to scope later work.
2. Both-version proof/startup guards are implemented; fixture checks cover refusal without mutation, safe reopening and retention of original identities/counterevidence.
3. The allowlisted one-job collector and review-only correction preview are implemented; they cannot clear a ledger or resume payments.
4. Implement the narrow importer transaction only after its report and state transitions are reviewed. Test idempotency and interruption before enabling writes.

Required recovery tests: no schema/record changes or send-capable calls during inspection; missing-column handling; wrong binding; absent/contradictory/valid proof; success and uncertainty; multiple replacements; repeated startup refusal; safe reopen; interrupted/repeated corrections. Real historical repair remains unavailable until this tooling is implemented and verified.

### First correction contract: restore one commitment

**Planned, not implemented.** The first write case is limited to one unproven `failed/reowe` payout becoming `failed/disputed` on a disposable copy. Implementation is gated on the isolated SDK collector proof and review of this transaction. It restores a monetary hold; it grants no budget release, payment claim, replacement, proof flag or startup/resumption clearance.

Accept only an unchanged standalone snapshot with a reviewed original binding and an explicit correction ID. The selected v2/v3 job must have exactly one payout attempt, no replacement or competing open payout/judgment, and an intact pending judgment linked to that original request. Non-execution proof is absent or false. Recipient, positive atomic amount, allocations and job/judgment associations must be consistent; request conflicts and reported success are unsupported. For v3, the linked submission must be the latest, still `proposed`, with its original invoice and no pending changes or later revision. Already-rejected historical judgments and other released outcomes are outside this first case. Unsupported schemas or payout-index semantics refuse without migration.

Let `A` be the original positive integer amount in USDC atomic units, represented as a decimal string; `300000000` is 300 USDC. The table concerns this original payout, not platform balance or verified settlement.

| Record or accounting value | Before | After |
| --- | --- | --- |
| Payout state / resolution | `failed` / `reowe` | `failed` / `disputed` |
| Committed amount, atomic units | `0` | `A` (example: `300000000`) |
| Counted paid amount, atomic units | `0` | `0` |
| Original monetary slot | Released | Held by the original payout |
| Judgment outcome / closure | `pending` / no closure | `disputed` / correction timestamp |
| V3 submission state | `proposed` | `disputed` |

Apply those changes and one append-only correction audit in a single transaction, comparing the expected prior values before every update. Preserve original request/payment/approval/owner IDs, amount, allocations, evidence, proof, terms/signatures, report/invoice content and prior events. Record the correction ID, operation, original identities, changed fields' exact before/after values, timestamp and source/binding/collection digests. Missing evidence stays explicitly missing. A correction event may reference that audit; it must not describe an ordinary representative resolution or claim that the payment never executed.

Closing the pending judgment is required along with restoring the payout hold: after a late partial payment, a pending judgment could otherwise request a remainder automatically. The planned correction invokes no application runtime, `Engine.resolve()`, judgment advancement, owner action or payment operation. The original snapshot remains unchanged, and neither the corrected copy nor its receipt starts the app.

For the same correction ID, matching recorded inputs and the expected corrected state return an already-applied result without another update, audit or event. Reused IDs with different inputs, stale snapshot/binding digests, changed prior values or divergent corrected state refuse without writes. Failure before transaction commit leaves none of the correction applied; a lost reply after commit is recoverable by the same idempotency check.

The local record checks establish consistency, not authenticity. Full signed-term/signature verification and authoritative original provider/deployment/agent binding remain unresolved until a supported authoritative route establishes them. Restoring a conservative hold does not settle those dependencies or fabricate missing historical evidence. Any later release, replacement or supervised resumption requires separate verification of fresh evidence, all related attempts and whole-database startup blockers.

Fixture acceptance must cover:

- V2 and v3 eligible examples: committed amount changes exactly `0 → A`, paid stays `0`, original identities/evidence/content survive, and the judgment plus v3 submission close disputed atomically.
- Same-ID repetition and interruption before/after commit: exactly one audit/event, no partial correction and no duplicate monetary effect.
- After explicit fixture-only reopening: unknown outcomes and newly observed non-execution keep the restored dispute committed; late partial success cannot create another payout; late full success follows only the original IDs.
- Refusal without writes for replacements, a competing slot/judgment, already-rejected judgments, unsupported outcomes/schema/indexes, mismatched terms/allocations/binding, reported success, stale inputs and correction-ID conflicts.
- An unrelated unsafe release still blocks whole-database startup. Every correction receipt retains `clearance: "none"`; neither fixture compatibility nor one corrected job certifies resumption.

## Acceptance matrix

Use **both layers** for each workflow: controlled app/stand-in tests for failures and UI, and an independent isolated SDK/gateway/provider simulation for integration and process replacement. All money, signatures and provider actions remain simulated. Pin the actual app/SDK/platform source for integration runs; leave peer processes and frozen artifacts intact.

| Required case | Environment and existing entry point | Pass condition / missing work |
| --- | --- | --- |
| V2 complete merge journey | Stand-in, `bun --no-env-file run demo:e2e` | Both signatures, eligible merges, bounded held payouts, explicit approvals and full signed-scope simulated payment |
| V3 complete report/invoice journey | Stand-in, `bun --no-env-file run demo:job` | Immutable submission/invoice, bounded proposal, approval before settlement and one correct simulated payment |
| V3 revision and lost payout reply | Stand-in, `PAPERWORK_JOB_CHANGES=1 PAPERWORK_JOB_LOST_REPLY=1 bun --no-env-file run demo:job` | Original attempt recovered; proven cancellation precedes revision; no duplicate transfer |
| Both-version proof and historical records | Controlled fixtures; `failed-payment-proof.test.ts`, `failed-payment-observation.test.ts`, `engine.test.ts`, `job-finalization.test.ts`, `db-rejection-compat.test.ts`, `sdk-payout-proof.test.ts` | Implemented engine/authenticated HTTP refusals without writes/sends, valid proof, retained counterevidence, unchanged unsafe-ledger refusal and safe reopen. Independent SDK process recovery remains a separate case below |
| Recovery tools | Read-only disposable database fixtures, injected SDK HTTP responses and scripted readers | Inspector, collector and review-only preview are implemented. Importer/resumption remain missing; fixture checks do not establish real historical repair |
| Both-version access and ownership | Auth-enabled HTTP fixtures | Anonymous/unrelated refusals, party reads and representative-only mutations; no unauthorized platform work. Extend tests to the selected privacy policy |
| V3 desktop/mobile browser journey | Stand-in, `bun --no-env-file run demo:browser` | Both party views, supported rework, held/processing/paid distinction, preserved IDs and no horizontal overflow |
| V2 desktop/mobile browser journey | Stand-in browser | Missing branch: extend the existing browser runner for Pay on merge, including ineligible/self-merged PR exclusion and rejected-work exclusion |
| V3 complete SDK journey | Fresh loopback stack via `PLATFORM_STACK_DIR`, `bun --no-env-file run demo:job` | Actual SDK/gateway confirms the full simulated obligation under the original IDs |
| V2 complete SDK journey | Fresh isolated stack; existing `demo:stack` supplies the integration harness | Missing clean happy-path variant. The current fault scenario's 750 paid + 250 disputed is not full-scope completion |
| V3 lost app reply and process restart | Independent SDK stack, `bun --no-env-file run demo:job:restart` | Two app processes share the same durable records; original IDs survive; exactly one approved simulated settlement |
| V2 lost app reply and process restart | Independent SDK stack | Missing v2 branch: extend the restart runner to the merge-judgment path. Reusing FakePlatform memory does not establish process recovery |
| Verification UI | Auth-enabled fixtures plus focused browser checks | Public/private projections follow the chosen privacy contract. Verify must not depend on an unauthorized full-job read |

Keyless browser demos establish interaction behavior, not real sign-in or role enforcement. SDK fixtures establish integration, not mainnet settlement or actual wallet interaction. No Market hire, hosted model request or live payment is required for this local milestone.

### Isolated SDK collector proof

```sh
env -u PLATFORM_STACK_DIR -u PAPERWORK_RESTART_DROP_WITHDRAW PAPERWORK_RESTART_COLLECT=1 bun --no-env-file scripts/demo-job-restart-local.ts
```

This opt-in extends the existing [process-restart recipe](job-restart.md) using its verified frozen platform/dependency copy and installed Node prerequisite. It creates its own fresh loopback stack and synthetic job, proves recovery under the original payment identity, settles that one simulated payment with explicit fixture approval, then stops its app before preparing the collector snapshot. Interactive/manual modes are unchanged. Full-demo and provider-response-drop modes cannot be combined with collection.

Only a disposable copy of that run's stopped fixture database is checkpointed to standalone DELETE format. The source database/sidecars are fingerprinted before and after; collector modules execute from the verified app-source copy while its gateway remains alive, using that stack's certificate authority. The probe checks all four bound SDK read procedures, original identities, unchanged snapshot/source bytes and unchanged provider activity, then stops only its owned processes. Automatic Bun children disable dotenv loading.

The receipt's `collector.integration_read_pass` establishes read transport and snapshot integrity, not historical repair, non-execution proof, verified original terms or resumption. Unsupported request metadata and absent owner phases stay unknown; a positive payment/non-execution preview label is not required. Collector artifacts are kept in the protected `collector/` directory under the printed job artifact directory. `--preflight` without the collection flag checks source/dependency/Node availability without starting a server or job.

### Known platform faults

- **G13:** the recorded SDK simulator lacks rejection non-execution proof. Correct behavior retains commitment and blocks revision. Stand-in revision success cannot count as SDK rework success.
- **G14:** dropped provider-response recovery remains unresolved in its recorded restart run. The safe halt preserves IDs and sends no replacement; that does not establish successful recovery. App-HTTP response loss is a different, required restart case. Current fault command: `PAPERWORK_RESTART_DROP_WITHDRAW=1 bun --no-env-file run demo:job:restart`.

These faults have separate safety and continuation results. Named fail-safe blocks may be recorded as safe behavior while SDK rework/provider-response recovery remain explicitly blocked. They must never be reported as successful continuation. See [platform gaps](platform-gaps.md).

### Completion record

For the post-policy candidate, require both full-scope happy paths in both layers, browser evidence for each workflow, auth-enabled access tests, both SDK process-restart paths, and proof/historical-ledger checks. Record missing runners and blocked faults separately; an existing command exiting zero is insufficient if the obligation remains disputed.

Each receipt identifies app/SDK/platform source, environment, workflow, terms hash, job/submission/judgment IDs as applicable, original request/correlation/approval IDs, committed and paid totals, transfer count and outcome. Include missing transaction evidence explicitly. No credentials, invitation tokens or private confirmation URLs belong in receipts. Older receipts apply only to their recorded source.

## V2 privacy — approved

**Approved 2026-11-11:** full details of both new and existing v2 jobs are to be readable only by their named representative/builder, matching v3's intended private-job boundary. Limited verification remains public. This is the implementation target; the current routes still have the disclosures below. Preserve signed terms, recipients, original URLs and invitation hashes. Opening an old link prompts sign-in; possession of the link alone grants no detailed access.

Public verification uses a small projection: terms hash, workflow version, `overall: green | red | incomplete`, a fixed allowlist of check IDs mapped to booleans, and check timestamp. Omit current check labels/details and raw `expected`, `observed` and `consents` fields. This is an app-relayed status, not an independent cryptographic policy proof. Detailed policy/identity/financial evidence stays with the named parties.

The current public Verify API is broader: it exposes payees, caps/totals, signer accounts, raw agent balance/policy, grants and consent metadata. Reducing only the v2 full-job route would leave those disclosures intact.

| Surface | Public / unrelated | Named builder | Named representative |
| --- | --- | --- | --- |
| Published openings/Market board | Read | Read | Read |
| Minimal verification status | Read | Read | Read |
| Full job and detailed verification | Deny | Read party-safe projection | Read |
| Terms-signing request | Deny | Own contractor payload | Own representative payload |
| Initial builder acceptance | Deny | Named session + original invitation + signature | Cannot sign for builder |
| Owner preparations/status, deposit instructions, approvals/retry/resolve/run | Deny | Deny | Supported actions |
| Hermes review | Deny | Deny | Supported actions |

The implementation must authorize protected requests before platform reads, remove owner preparations/deposit data from builder views, use generic unauthorized errors and prevent private-response caching. A public status handler may use whitelisted read-only observations, but never reconciliation-capable `getContract()` or other send-capable paths. Public signing-request and raw Verify routes need the same review as full-job reads. Test new/existing v2 and v3 jobs with anonymous, unrelated and named accounts, preserving original invitations and signature bytes. Implementation and verification remain pending.

## Dated recovery evidence

These **2026-11-11** checkpoints preserve the results previously recorded in PROGRESS. They describe successive source states, not new runs or certification of the current tree. See [PROGRESS](../PROGRESS.md) for the latest checkpoint and open defects. All used Bun **1.4.2**; the proof-guard and collector checkpoints used TypeScript **7.0.2**, based on HEAD `77d7416171708dae00c4d8c36ecf459c4179b1b7` plus the then-current uncommitted Desk/Hermes/recovery work.

### Inspector checkpoint

Typecheck, whitespace and the full suite passed: **781 tests**, 4,434 assertions across 46 files. The initial ledger/CLI suites contained 88 cases. Full output: `/tmp/paperwork-ledger-inspector-tests.log`. Subsequent guard/refund work superseded this source checkpoint.

Only disposable fixture databases were inspected. The user confirmed no unattended runs/freezes for the local payment/recovery work; existing manual demos were not attached to or restarted. Correction/import and privacy implementation were still pending.

### Proof-guard checkpoint

`bun --no-env-file run typecheck`, `git diff --check` and `bun --no-env-file test` passed: **1,011 tests**, 7,237 assertions across 48 files, including both-version refund persistence across database reopen. Full output: `/tmp/paperwork-payment-proof-tests.log`.

Three stand-in runs passed:

- `bun --no-env-file scripts/demo-e2e.ts`: v2 full 1,000 USDC scope, four settled simulated transfers, explicit approvals and no attacker payment. The initial sandbox invocation could not open a local listener; the authorized rerun passed. Log: `/tmp/paperwork-proof-v2-demo.log`.
- `env -u PLATFORM_STACK_DIR -u PAPERWORK_JOB_CHANGES -u PAPERWORK_JOB_LOST_REPLY bun --no-env-file scripts/demo-job.ts`: one v3 approval and one 300 USDC simulated settlement. Log: `/tmp/paperwork-proof-v3-demo.log`.
- `env -u PLATFORM_STACK_DIR PAPERWORK_JOB_CHANGES=1 PAPERWORK_JOB_LOST_REPLY=1 bun --no-env-file scripts/demo-job.ts`: supported revision and original-request recovery, with one successful simulated transfer. Log: `/tmp/paperwork-proof-v3-recovery-demo.log`.

The proof, observation, compatibility and expanded inspector suites covered authenticated refusals without writes/sends, valid proof, transaction/refund contradictions, stale/foreign observations, unsafe-ledger non-mutation and safe reopening. These were fixture and stand-in results; SDK-stack/browser/hosted acceptance was not rerun, existing manual demos stayed untouched, and historical correction remained incomplete.

### Initial collector and preview checkpoint

With installed SDK **0.5.7**, `bun --no-env-file run typecheck`, local documentation link checks, `git diff --check` and `bun --no-env-file test` passed: **1,194 tests**, 7,802 assertions across 52 files. Full output: `/tmp/paperwork-recovery-evidence-tests.log`.

The collector, SDK-reader, preview and CLI suites contained **183 cases**, using scripted readers and actual installed-SDK parsing with injected HTTP responses. They covered bounded hangs/streams, wrong binding with zero reads, original/replacement coverage, redaction, source-change refusal and review-only output. No network/listener, live credential, real state or real funds were used. Independent SDK-stack/browser/hosted acceptance was not rerun for this standalone-tool change.

Three separately prepared synthetic review examples were saved at `/tmp/paperwork-recovery-preview-examples.json`: consistent non-execution, missing proof and a refund contradiction produced `non_execution_reported`, `retain_commitment` and `contradictory`, respectively; all retained `clearance: "none"`. Existing manual demos and historical audit receipts stayed untouched.

A subsequent read-only audit found success/refund subtotal and related-attempt handling defects, plus false contradictions for valid `failed/REFUNDED` or absent provider status. The initial passing checkpoint does not establish those later corrections; their validation belongs in the latest checkpoint.

### Preview reporting correction checkpoint

Original failures were reproduced before editing and checked against installed SDK **0.5.7** contracts. Success with stored/live refund evidence is now contradictory, excluded from the matched status-report subtotal and unable to resolve related attempts. Valid refunds and unknown outcomes remain unresolved; ordinary successful transaction/destination evidence still counts. Reported and excluded success IDs make the subtotal's incomplete coverage explicit. Every preview retains `clearance: "none"`.

Fresh **2026-11-11** checks, Bun **1.4.2**, TypeScript **7.0.2**, same base HEAD plus uncommitted Desk/Hermes/recovery work: `bun --no-env-file run typecheck`, `git diff --check` and `bun --no-env-file test` passed **1,237 tests**, 8,083 assertions across 52 files. Log: `/tmp/paperwork-recovery-reporting-fixes-tests.log`. The focused preview/CLI command passed **158 tests**, 621 assertions, including actual installed-SDK parsing with injected HTTP responses. No network/listener, hosted model/platform request, live credential, real state or real funds were used; existing manual demos and the earlier receipts were preserved. Independent SDK-stack/browser acceptance was not rerun for these advisory-report fixes.

Seven corrected synthetic examples are saved separately at `/tmp/paperwork-recovery-preview-corrected-examples.json`, preserving the initial artifact. They cover normal success, refunded success, a valid refunded failure, missing provider status, an explicit unknown payment status, consistent non-execution and a refund contradiction. These are independent fixture scenarios, not historical reconciliation evidence or permission to resume payments.

### SDK collector integration checkpoint

The **2026-11-11 local / 2026-11-12 UTC** run passed:

```sh
env -u PLATFORM_STACK_DIR -u PAPERWORK_RESTART_DROP_WITHDRAW PAPERWORK_RESTART_COLLECT=1 bun --no-env-file scripts/demo-job-restart-local.ts
```

The sandbox attempt was refused loopback-listen permission before an app job. The first authorized run then recovered and settled its one simulated payment, but collection stopped before HTTP reads because an incorrect `tap_`-prefix format check rejected the platform's `tap_UUID.secret` credential. Both failed attempts and their cleanup receipts remain retained; no uncertain payment was replaced. The reader/CLI now treat credentials as opaque, bounded safe HTTP-header values. Regression fixtures use the actual platform format and reject whitespace, control/header injection and oversized inputs without echoing contents.

The corrected fresh run used Bun **1.4.2**, SDK **0.5.7**, platform Node **v24.22.2** and frozen platform digest `36a66cb4212faef9d651a342baead7203238eb19d866acf9a8b2ec6ef1e76518`. App source digest: `b3f467f85cf8cf729061a6a0a4dac07e89d615196ffe75ac7c43e31ad5d0dc64`; public dependency digest: `98483c3373616d210e548ffa75399473a0d763f40f9772f65040c38aef8c12eb`. The run's manifests retain per-file/module provenance.

Original request `ad063b7dc50ff8aa-p1-1` and correlation `ef1ee195-9bc4-4542-9f25-f71035a0c666` survived app process replacement. After explicit fixture approval, the provider confirmed one 300 USDC simulated settlement. With both app processes stopped, collection completed seven HTTP reads across the four allowed procedures: one payout status, one payment status, four owner statuses and held records. The 237,568-byte standalone snapshot retained digest `0b4c3fad8a938efc146398c71e686d6ce2b047b025249f23f6117495d77bd003`; source database/sidecars and app source also remained unchanged. Provider payment count stayed **1 → 1**. This candidate supplied supported request metadata and owner phases; the preview reported payment with `clearance: "none"`. Both launcher-owned processes exited 0 after cleanup.

Protected artifacts: `/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/paperwork-restart-launch-PtUYJo/launcher-receipt.json` and `jobs/paperwork-job-restart-E24qGO/{receipt.json,app-source-manifest.json,collector/report.json,collector/binding.json,collector/provenance.json}` beneath that directory. Report SHA-256: `fac40ac62da2f1e34230faec4818c4b2e74c18fb4c687ae4d0bc3b7175502c5f`. The earlier failed runs remain at `paperwork-restart-launch-rKYGe1` and `paperwork-restart-launch-bBlcK6` under the same temporary root. Command transcripts: `/tmp/paperwork-recovery-sdk-proof.log`, `/tmp/paperwork-recovery-sdk-credential-format-failure.log` and `/tmp/paperwork-recovery-sdk-proof-approved.log`.

Fresh offline checks after the credential fix passed typecheck, whitespace and **1,242 tests**, 8,129 assertions across 52 files; focused SDK-reader/CLI/preview checks passed **203 tests**, 816 assertions. Full log: `/tmp/paperwork-recovery-sdk-final-tests.log`. Existing running demos were not reused or restarted, and the original frozen platform source artifacts remained unchanged; the automated runners gained the explicit opt-in proof and dotenv safeguards. This receipt establishes simulated SDK read transport, snapshot integrity and the default app-response-loss recovery path; it does not establish historical correction/resumption, rejected-payment non-execution, provider-response-loss recovery, hosted acceptance or real-wallet settlement.
