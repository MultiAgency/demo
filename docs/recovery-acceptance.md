# Recovery and local acceptance

Updated **2026-11-11** for the milestone in [PRD](../PRD.md): complete Report and invoice and Pay on merge jobs in local simulation. Inventory, evidence collection/preview, both-version proof guards, restoration/export and the scoped disposable handoff rehearsal are implemented and checked. Real historical provenance and remaining acceptance cases stay unresolved. Hosted operations remain subject to workspace authorization.

## Historical reconciliation

The enforced rule covers new and existing v2/v3 jobs: failed-payment budget release requires positive platform non-execution evidence without contradictions. Startup checks rejected/manual-release outcomes without relying on parent terms/version, and also refuses recorded refusals with stored transaction/refund counterevidence. Because storage is shared, refusal can block unrelated jobs, sign-in and Market too.

Runtime observations retain the original failed-payment binding, revoke proof when status regresses or conflicts, and preserve the first observed non-null refund amount in `refunded_amount`. A later missing field or unavailable read cannot erase that evidence. Compatible databases receive the nullable column additively; unsafe databases refuse before migration. Older refund observations that were never stored cannot be reconstructed by this change and still need authoritative collection/reconciliation.

The standalone inspector, SDK evidence collector and narrow restoration/export tools exist, with a separate disposable handoff rehearsal below. Unsupported historical cases remain blocked. Ordinary app startup, representative job-detail reads and timers are unsuitable for inspection: they may migrate records or advance payments. Already-resolved historical rows also cannot be repaired through the current `Engine.resolve()` action.

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

### Procedure and operational boundaries

1. **Preserve a consistent snapshot.** Coordinate writers/runs before any money-path change. An authorized operator creates a coherent SQLite backup including committed WAL contents, records its digest/schema/candidate, and retains the original. Production state stays in the operator's protected location; it must not enter this workspace.
2. **Inventory read-only.** Use the inspector above; schema introspection and SELECTs run against its in-memory read-only database. It never calls `openDb()`, `createRuntime()`, auth, HTTP handlers or timers. Report terms/version/hash, deployment, Organization/agent, original request/correlation/approval/owner-step IDs, payout lines, historical resolution and related attempts. Same-judgment/sequence peers and other attempts in that job remain separate; amount/payee similarity never establishes a replacement. Missing proof columns mean missing evidence.
3. **Bind observations to the original platform.** Establish original host, deployment, Organization and agent from trusted records; the database alone does not establish the host. Use the original approved server credential outside reports/logs. Never substitute another deployment or infer a binding from matching amount/payee.
4. **Collect evidence through a read allowlist.** Use the collector above with the original binding. Payout and owner-step correlations are separate identities; retain their recorded associations. Never prepare/submit owner actions, approve, retry or request payouts. Retain successive observations with binding, IDs, timestamps, SDK version and response hashes. Hashes identify observations; they are not cryptographic platform attestations.
5. **Prepare an audited correction on a disposable copy.** The restoration-only export below validates the original snapshot, reviewed request and bound observations, then saves a separate corrected bundle. It retains the original identities and missing evidence; it makes no new platform reads. Broader corrections still need authoritative status, original/replacement and owner-intent review through a supported route. Reject hand-authored proof flags, stale initial observations and conflicting bindings. Do not use direct SQL edits or a force-start option.
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
4. The first restoration transaction runs in memory and can be saved as a new private, durable export bundle. Installation into an application database and supervised resumption remain separate work.

Required recovery tests: no schema/record changes or send-capable calls during inspection; missing-column handling; wrong binding; absent/contradictory/valid proof; success and uncertainty; multiple replacements; repeated startup refusal; safe reopen; failed/repeated corrections; interrupted export and lost results. Real historical resumption remains unavailable without whole-database verification and a supervised handoff procedure.

### First correction contract: restore one commitment

**Implemented:** [`restoreCommitment()`](../src/server/recovery/restore.ts) returns separate private SQLite bytes and a sanitized receipt. The core never writes a file, starts the app or contacts the platform; the [export command below](#export-a-restoration-bundle) saves its result. The first case is limited to one unproven `failed/reowe` payout becoming `failed/disputed` on a disposable copy. It restores a monetary hold; it grants no budget release, payment claim, replacement, proof flag or startup/resumption clearance. The exporter does not install a database into the application.

Accept only an unchanged standalone snapshot with a reviewed original binding and an explicit correction ID. The selected v2/v3 job must have exactly one payout attempt at sequence/attempt `1/1`, no replacement, and one sole, intact pending judgment linked to that original request. Non-execution proof is absent or false. Recipient, positive atomic amount, allocations and job/judgment associations must be consistent; request conflicts and reported payout/payment success are unsupported. For v3, the linked submission must be the latest, still `proposed`, with its original invoice and no pending changes or later revision. Additional closed judgments, already-rejected historical judgments and other released outcomes are outside this first case. Unsupported schemas or open-work index semantics, custom triggers and generated/virtual tables refuse without migration. The output must remain within the same standalone 64 MiB snapshot and 10,000-row-per-table limits.

An initial correction requires snapshot-bound observations completed within five minutes, with no future timestamps. Unavailable or unknown observations remain uncertainty. Any retained foreign-request `platform_record` also excludes the selected attempt, even if its conflict code is missing. Any non-null observed transaction, destination, refund hash or refunded amount refuses this first case, including an empty string or zero amount: a digest alone must not hide new counterevidence from later payment guards. Already-stored counterevidence stays unchanged.

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

Every correction update and insert explicitly aborts on a constraint conflict, overriding schema-level `REPLACE` or `IGNORE` policies. A conflicting historical row must never be deleted or an event silently skipped. Foreign-key cascading actions are disabled on the isolated in-memory connection; custom triggers remain unsupported. A nonconflicting additional constraint does not by itself prevent correction.

Closing the pending judgment is required along with restoring the payout hold: after a late partial payment, a pending judgment could otherwise request a remainder automatically. The correction invokes no application runtime, `Engine.resolve()`, judgment advancement, owner action or payment operation. The original snapshot remains unchanged, and neither the corrected copy nor its receipt starts the app.

Replay uses the returned corrected snapshot containing its audit, rather than the unchanged original. For the same correction ID, matching recorded inputs and the expected corrected context return the exact input bytes as already applied, without another update, audit or event. Evidence may have aged for this no-op; it grants no new authority. A logical digest covers schema, ordinary-table contents and row identities, including unrelated auth/Market context, without putting their private contents in the receipt. Reused IDs with different inputs, stale initial evidence, changed prior values or divergent corrected context refuse. Reprocessing the original snapshot produces a separate result; there is no external idempotency registry.

The changes and audit share one in-memory transaction. Failure before a successful return exposes no partial corrected snapshot and leaves the source unchanged. The export layer separately tests process interruption and loss of its returned result. These checks do not establish application-database installation, whole-database recovery or physical power-loss behavior. Tests reject pre-existing failure triggers as unsupported schema rather than claiming an injected transaction-interruption result.

Local checks verify canonical terms and their hash, both signatures' NEP-413 cryptography/account/domain binding, immutable v3 submission content and the original payout plan. They cannot attest historical on-chain key ownership, original provider provenance or authoritative deployment/agent binding. Restoring a conservative hold does not settle those dependencies or fabricate missing historical evidence. Any later release, replacement or supervised resumption requires separate verification of fresh evidence, all related attempts and whole-database startup blockers.

Fixture acceptance must cover:

- V2 and v3 eligible examples: committed amount changes exactly `0 → A`, paid stays `0`, original identities/evidence/content survive, and the judgment plus v3 submission close disputed atomically.
- Same-ID repetition on the corrected output: exactly one audit/event and byte-identical no-op, including after evidence ages; changed inputs or unrelated context refuse. Failed calls return no corrected bytes and preserve every source record.
- Schema-level replacement conflicts on the payout, judgment, v3 submission or correction event, and ignored correction events, must refuse without output or source changes. Nonconflicting constraints must preserve history and exact replay. Export must refuse before reserving a destination when restoration fails.
- Completed-bundle reuse must reject a repacked snapshot even when its logical audit, receipt and rewritten file hashes agree: exact reproduction from the pinned original source remains required.
- After explicit fixture-only reopening: unknown outcomes and newly observed non-execution keep the restored dispute committed; late partial success cannot create another payout; late full success follows only the original IDs.
- Refusal without writes for replacements, a competing slot/judgment, already-rejected judgments, unsupported outcomes/schema/indexes, mismatched terms/allocations/binding, reported success, stale inputs and correction-ID conflicts.
- An unrelated unsafe release still blocks whole-database startup. Every correction receipt retains `clearance: "none"`; neither fixture compatibility nor one corrected job certifies resumption.

### Export a restoration bundle

```sh
mkdir -m 700 /protected/recovery-exports
bun --no-env-file scripts/export-restoration.ts /protected/standalone-snapshot.sqlite /protected/restoration-request.json /protected/recovery-exports/restore-job-001
```

These are operator-path examples; development tests use disposable synthetic snapshots only. The [standalone command](../scripts/export-restoration.ts) reads no dotenv, creates no application runtime and makes no platform request. The destination's existing parent must be an operator-owned directory with mode `0700`. Parent aliases are resolved once, then directory identities are checked; a symlink at the final parent, bundle or payload is refused. The bundle name starts with an ASCII letter/digit and contains at most 128 ASCII letters, digits, dots, underscores or hyphens. The command creates a new bundle directory with mode `0700` and files with mode `0600`.

The request file, at most 4 MiB, is a complete [`RestorationRequest`](../src/server/recovery/restore.ts): `correction_id`, original `request_id`, `binding`, `collection` and `collection_sha256`. Copy the reviewed binding/collection and its canonical digest from the collector report; choosing an ID supplies no proof or authority. The saved `request.json` is a canonical JSON copy of those original values, rather than a byte-for-byte copy of whitespace in the input file. Initial observations must still satisfy the five-minute freshness boundary.

| Bundle file | Contents |
| --- | --- |
| `snapshot.sqlite` | Corrected standalone database, including the original private auth/Market/job records |
| `request.json` | Original restoration request, including its bound observations |
| `receipt.json` | Original applied receipt with `clearance: "none"` |
| `manifest.json` | Completion marker: fixed operation/identities, exact payload lengths/hashes, source/request/binding/collection/output/receipt hashes and selected audit-row hash |

The [exporter](../src/server/recovery/export.ts) exclusively creates the destination and never overwrites a source, bundle or conflicting file. It flushes the payload files and bundle directory, then publishes the completed manifest with an exclusive hard link from a flushed private staging file in the same parent. It flushes the bundle and parent before acknowledging success. Interrupted attempts may leave an incomplete bundle and a private parent-side manifest staging file; these are retained, never automatically deleted or repaired. An existing destination without a valid completion manifest refuses. Review retained artifacts before a separate attempt; switching destinations is not automatic recovery.

Retry with the same source, request and destination after a lost result. Reuse requires the exact four-file bundle, private regular files, matching original source and canonical inputs, every payload length/digest, the saved receipt and selected audit digest, and a successful byte-identical `already_applied` check against the corrected snapshot. It also reproduces the correction from the pinned original source at the recorded application time and requires byte-identical output and receipt. A self-consistent audit alone cannot establish that an older implementation preserved history. Evidence may have aged for this verified no-op; the recorded time is used only for reproduction, not to authorize another correction. Any refusal leaves existing artifacts untouched; even a logically equivalent artifact refuses if exact reproduction differs. The exporter flushes verified files and both directories again before acknowledging reuse, covering interruption after the manifest link but before directory flush. Incomplete, changed or conflicting bundles refuse without overwrite. Retain the untouched bundle: ordinary auth/job/event activity changes its audited context and prevents reuse.

Exit **0** means completed export, verified reuse or help; exit **1** means failure without a success summary. Stdout contains only a sanitized result and hashes, never source paths, the request or database contents. A failed/lost response can still leave a completed bundle; retry the same command to verify it. `fsync` and process-kill tests establish the supported filesystem protocol, not a hardware power-loss guarantee. The manifest/audit hashes identify bytes and consistency, not authoritative historical provenance or permission to resume the app.

### Whole-database recovery rehearsal

```sh
env -u PLATFORM_STACK_DIR -u PAPERWORK_RESTART_COLLECT -u PAPERWORK_RESTART_DROP_WITHDRAW PAPERWORK_RECOVERY_REHEARSAL=1 bun --no-env-file scripts/demo-job-restart-local.ts
```

The opt-in mode uses the existing pinned isolated SDK stack and fresh synthetic app. It cannot be combined with collector, combined-demo or provider-response-drop modes. The normal/manual launch modes retain their behavior. `--preflight` checks and copies the pinned platform/public dependencies without starting a stack or job. The full command retains a transcript, provenance, compatibility inventories, sources, export bundles, working copies and process/SDK traces under its printed private artifact directory; it stops only its owned processes.

The [read-only compatibility inventory](../src/server/recovery/compatibility.ts) uses the secure snapshot loader and in-memory queries to list every recognized database compatibility blocker: legacy provider-adapter schema, all unsafe budget releases (including unrelated jobs, unknown workflows and orphaned rows), and wrong/unbound deployment (including Market-only records). `complete` means these three known gates could be read; missing/unsupported input refuses or reports incomplete. It does not certify migrations, auth initialization, external availability or financial clearance. Reports always retain `clearance: "none"`.

Preflight precedes any candidate startup. The runtime's legacy-schema and unsafe-release guards run before migration, but deployment binding currently follows `openDb()` and its possible WAL/additive migrations. Do not treat a direct deployment-mismatch failure as a byte-preserving probe; reject it in the read-only preflight instead.

The recipe's stages are:

1. Create, sign and approve the original v3 job through supported app/SDK paths. Stop the owned app while its one original payment is still processing.
2. Preserve the original stopped ledger and sidecars. Checkpoint only a separate backup, then seed the old `failed/reowe`, proof-absent/false local record there. This is explicitly fabricated historical app state; the actual platform payment remains the original approved processing payment. No platform failure or proof is fabricated.
3. Derive two independent sources and export bundles. The clean branch restores its sole commitment. The mixed branch additionally contains a synthetic unrelated release and an orphan release; correcting the selected job must leave both blockers. Its separate working copy must exit with the known unsafe-release refusal, no listener/SDK calls and unchanged database bytes. It remains blocked; no rows are removed to make it start.
4. Copy the clean bundle's database into another private working directory. Start a no-timer app process, require successful fresh original payout/payment reads, verify the 300 USDC dispute remains committed/unpaid, kill it, and start a different OS process on that same working database. Recheck all job, submission, invoice, judgment, request, correlation, approval, recipient, amount and sequence identities. Neither the source nor retained bundle is opened for startup.
5. Invoke only the existing simulated settlement control for the already-approved original payment. Require one original 300 USDC settlement, no additional payout sequence and zero SDK mutation attempts in either resumed process. Hash every retained source and all four bundle files again and verify unchanged completed-bundle reuse.

The [observer child](../scripts/recovery-observer.ts) uses the actual app runtime/API and installed SDK with timers omitted, Market/discovery disabled and SDK transport restricted to the bound agent's read procedures. It records attempts before dispatch and sanitized parsed payout/payment observations afterward. A forbidden attempt makes the rehearsal fail even if platform deduplication prevented a second payment. The settlement control is an explicit simulated-provider operation, separate from the zero-SDK-mutation claim. [Preparation support](../scripts/recovery-rehearsal.ts) and the observer are copied and hashed along with the frozen app source.

V2/v3 full/partial and unknown-outcome handoff cases also run against exported bundles in controlled stand-in tests. Those retain the stand-in provider across in-process runtime replacement; they do not prove independent SDK/process behavior for v2, partial settlement or UNKNOWN. The SDK recipe covers v3 processing, restart and original full settlement. G13/G14 and the other missing acceptance branches remain separate. Successful simulated rehearsal supplies no authority to install a real historical database or resume production.

For a short terminal recording, show the preserved sources/bundle, the mixed inventory and refusal, both clean working-copy PIDs with the same committed amount/IDs, then the original settlement and unchanged bundle hashes. Use the saved receipt rather than exposing raw database or signing contents.

## Acceptance matrix

Use **both layers** for each workflow: controlled app/stand-in tests for failures and UI, and an independent isolated SDK/gateway/provider simulation for integration and process replacement. All money, signatures and provider actions remain simulated. Pin the actual app/SDK/platform source for integration runs; leave peer processes and frozen artifacts intact.

| Required case | Environment and existing entry point | Pass condition / missing work |
| --- | --- | --- |
| V2 complete merge journey | Stand-in, `bun --no-env-file run demo:e2e` | Both signatures, eligible merges, bounded held payouts, explicit approvals and full signed-scope simulated payment |
| V3 complete report/invoice journey | Stand-in, `bun --no-env-file run demo:job` | Immutable submission/invoice, bounded proposal, approval before settlement and one correct simulated payment |
| V3 revision and lost payout reply | Stand-in, `PAPERWORK_JOB_CHANGES=1 PAPERWORK_JOB_LOST_REPLY=1 bun --no-env-file run demo:job` | Original attempt recovered; proven cancellation precedes revision; no duplicate transfer |
| Both-version proof and historical records | Controlled fixtures; `failed-payment-proof.test.ts`, `failed-payment-observation.test.ts`, `engine.test.ts`, `job-finalization.test.ts`, `db-rejection-compat.test.ts`, `sdk-payout-proof.test.ts` | Implemented engine/authenticated HTTP refusals without writes/sends, valid proof, retained counterevidence, unchanged unsafe-ledger refusal and safe reopen. Independent SDK process recovery remains a separate case below |
| Recovery tools | Disposable fixtures plus opt-in independent SDK stack | Inventory, restoration/export and separate-copy handoff are verified for the stated stand-in/v3 SDK cases. Real historical provenance, unsupported cases and remaining SDK branches stay unresolved |
| Both-version access and ownership | Auth-enabled HTTP fixtures and `demo:privacy:browser` | Pass: anonymous/unrelated refusals before platform reads, party-safe responses, own-role signing, original legacy signatures/invitations, public-only verification and refused-refresh clearing |
| V3 desktop/mobile browser journey | Stand-in, `bun --no-env-file run demo:browser` | Both party views, supported rework, held/processing/paid distinction, preserved IDs and no horizontal overflow |
| V2 desktop/mobile browser journey | `bun --no-env-file scripts/demo-v2-browser.ts` | Pass: GUI offer/signatures/setup; self-merged/unrelated PR exclusions, explicit approvals and proven rejection, no re-payment of rejected work, $1,000 full-scope settlement, original IDs after both-view reload and 390/1440px checks |
| V3 complete SDK journey | Fresh loopback stack via `PLATFORM_STACK_DIR`, `bun --no-env-file run demo:job` | Actual SDK/gateway confirms the full simulated obligation under the original IDs |
| V2 complete SDK journey | Fresh isolated final gateway; `bun --no-env-file run demo:stack` | Final candidate now completes the existing negative-case + payment scenario: $1,000/$1,000 paid, four correct transfers, no unresolved dispute. Current receipt: `/tmp/paperwork-local-release/v2-sdk-result.json`. The older $750 + $250 disputed receipt remains historical |
| V3 lost app reply and process restart | Independent SDK stack, `bun --no-env-file run demo:job:restart` | Two app processes share the same durable records; original IDs survive; exactly one approved simulated settlement |
| V2 lost app reply and process restart | `bun --no-env-file scripts/demo-job-restart-local.ts --v2` | Pass on final isolated gateway: suppress completed merge-judgment app reply, SIGKILL, recover original judgment/request/correlation/terms/sequence in a different process, defer duplicate run, explicitly approve and settle one full-scope $300 payment |
| Verification UI | Auth-enabled fixtures plus v2/v3 browser matrix | Pass: allowlisted public status without a private full-job fetch; desktop/mobile; detailed verification remains party-only |

Keyless browser demos establish interaction behavior, not real sign-in or role enforcement. SDK fixtures establish integration, not mainnet settlement or actual wallet interaction. No Market hire, hosted model request or live payment is required for this local milestone.

### Isolated SDK collector proof

```sh
env -u PLATFORM_STACK_DIR -u PAPERWORK_RESTART_DROP_WITHDRAW PAPERWORK_RESTART_COLLECT=1 bun --no-env-file scripts/demo-job-restart-local.ts
```

This opt-in extends the existing [process-restart recipe](job-restart.md) using its verified frozen platform/dependency copy and installed Node prerequisite. It creates its own fresh loopback stack and synthetic job, proves recovery under the original payment identity, settles that one simulated payment with explicit fixture approval, then stops its app before preparing the collector snapshot. Interactive/manual modes are unchanged. Full-demo and provider-response-drop modes cannot be combined with collection.

Only a disposable copy of that run's stopped fixture database is checkpointed to standalone DELETE format. The source database/sidecars are fingerprinted before and after; collector modules execute from the verified app-source copy while its gateway remains alive, using that stack's certificate authority. The probe checks all four bound SDK read procedures, original identities, unchanged snapshot/source bytes and unchanged provider activity, then stops only its owned processes. Automatic Bun children disable dotenv loading.

The receipt's `collector.integration_read_pass` establishes read transport and snapshot integrity, not historical repair, non-execution proof, verified original terms or resumption. Unsupported request metadata and absent owner phases stay unknown; a positive payment/non-execution preview label is not required. Collector artifacts are kept in the protected `collector/` directory under the printed job artifact directory. `--preflight` without the collection flag checks source/dependency/Node availability without starting a server or job.

### Known platform faults

- **G13 (historical snapshot):** the older recorded simulator lacked rejection non-execution proof and correctly blocked revision. Final candidate `822346ac…` now passes DAO SDK rework and the v2 SDK rejection/full-scope continuation; that fresh gateway evidence supersedes the old continuation gap only for these exact pins. Stand-in success alone remains insufficient.
- **G14:** dropped provider-response recovery remains unresolved in its recorded restart run. The safe halt preserves IDs and sends no replacement; that does not establish successful recovery. App-HTTP response loss is a different, required restart case. Current fault command: `PAPERWORK_RESTART_DROP_WITHDRAW=1 bun --no-env-file run demo:job:restart`.

These faults have separate safety and continuation results. Named fail-safe blocks may be recorded as safe behavior while SDK rework/provider-response recovery remain explicitly blocked. They must never be reported as successful continuation. See [platform gaps](platform-gaps.md).

### Completion record

For the post-policy candidate, require both full-scope happy paths in both layers, browser evidence for each workflow, auth-enabled access tests, both SDK process-restart paths, and proof/historical-ledger checks. Record missing runners and blocked faults separately; an existing command exiting zero is insufficient if the obligation remains disputed.

Each receipt identifies app/SDK/platform source, environment, workflow, terms hash, job/submission/judgment IDs as applicable, original request/correlation/approval IDs, committed and paid totals, transfer count and outcome. Include missing transaction evidence explicitly. No credentials, invitation tokens or private confirmation URLs belong in receipts. Older receipts apply only to their recorded source.

## V2 privacy — approved

**Approved 2026-11-11:** full details of both new and existing v2 jobs are to be readable only by their named representative/builder, matching v3's intended private-job boundary. Limited verification remains public. This boundary is now enforced by the application routes; fresh local checks and remaining hosted limits are recorded in PROGRESS.md. Preserve signed terms, recipients, original URLs and invitation hashes. Opening an old link prompts sign-in; possession of the link alone grants no detailed access.

Public verification uses a small projection: terms hash, workflow version, `overall: green | red | incomplete`, a fixed allowlist of check IDs mapped to booleans, and check timestamp. Omit current check labels/details and raw `expected`, `observed` and `consents` fields. This is an app-relayed status, not an independent cryptographic policy proof. Detailed policy/identity/financial evidence stays with the named parties.

The detailed Verify API (`/api/contracts/:id/verify`) requires a named party. Public `/api/contracts/:id/verify/public` returns only `terms_hash`, `workflow_version`, `overall`, an allowlisted ID-to-boolean `checks` map, and `checked_at`. The public page never fetches the full job.

| Surface | Public / unrelated | Named builder | Named representative |
| --- | --- | --- | --- |
| Published openings/Market board | Read | Read | Read |
| Minimal verification status | Read | Read | Read |
| Full job and detailed verification | Deny | Read party-safe projection | Read |
| Terms-signing request | Deny | Own contractor payload | Own representative payload |
| Initial builder acceptance | Deny | Named session + signature (revised 2026-11-13; see below) | Cannot sign for builder |
| Owner preparations/status, deposit instructions, approvals/retry/resolve/run | Deny | Deny | Supported actions |
| Hermes review | Deny | Deny | Supported actions |

**Revised 2026-11-13 (user-approved):** with sign-in required, the named builder's own session and wallet signature accept the offer; the original invitation is no longer also required. The account check runs before the signature is verified, and the signing key must be a full-access key of the named account. Where sign-in is not required (the keyless demonstration, which has no sessions) the original invitation remains the acceptance capability.

The implementation must authorize protected requests before platform reads, remove owner preparations/deposit data from builder views, use generic unauthorized errors and prevent private-response caching. A public status handler may use whitelisted read-only observations, but never reconciliation-capable `getContract()` or other send-capable paths. Public signing-request and raw Verify routes need the same review as full-job reads. Test new/existing v2 and v3 jobs with anonymous, unrelated and named accounts, preserving original invitations and signature bytes. The application enforces this boundary for existing and new terms without changing signed bytes or invitation hashes. Hosted verification remains pending.

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

### In-memory restoration checkpoint

Fresh **2026-11-11** offline checks used Bun **1.4.2**, TypeScript **7.0.2** and SDK **0.5.7**, based on committed checkpoint `b225e36` plus the new restoration module, its two fixture/test files and the secure-loader refactor in `inspect.ts`. Documentation updates accompany the change; a concurrent Hermes documentation edit was preserved.

`bun --no-env-file run typecheck`, `git diff --check` and `bun --no-env-file test` passed **1,284 tests**, 8,442 assertions across 53 files. Full log: `/tmp/paperwork-restoration-final-tests.log`. The new restoration suite contains **42 cases**, 313 assertions; run it with `bun --no-env-file test tests/recovery-restoration.test.ts`.

The fixtures use the actual locally signed v2/v3 workflow before simulating an old release only on a closed disposable backup. Tests establish exact `0 → A` commitment with paid `0 → 0`, preserved records, one correction/event, byte-identical aged replay, refusal on changed unrelated context, original-ID late settlement, and no new remainder payout after partial settlement. They exercise altered SQL literals, hidden row IDs, unsupported event keys, the 10,000-row boundary and an actual post-update SQL failure with no partial snapshot returned. The original snapshot and its directory remain unchanged by restoration. Audit append-only triggers are checked; the audit is not a cryptographic historical attestation.

SHA-256 source fingerprints:

| File | Digest |
| --- | --- |
| `src/server/recovery/inspect.ts` | `33c86143df79417d21eb9c18d95308ba7e8d629642363d2bc3625f2a2e1bf3c3` |
| `src/server/recovery/restore.ts` | `b2fb531cfcc28a0ce31db6f3f3a69c1ae0c8b94a70dfe43cd55c18374fe1ae5f` |
| `tests/recovery-restoration.test.ts` | `2e90656bf635661781901132906cd670a3cceae066f7c2b5b77cbcbac6d7da58` |
| `tests/support/restoration-ledger.ts` | `cb813a0a537585fb9467f9bf1380290204f4258d0ea0a39417157a3d1d930d11` |

These checks do not establish filesystem durability, process-crash recovery, authoritative historical binding, operational import or supervised resumption. No independent SDK-stack/browser/hosted run was repeated for this pure in-memory change. Existing manual demos, secrets, live state and real funds were not used; no commit or deployment was performed.

### Retained-conflict guard correction

A subsequent **2026-11-11** disposable-fixture probe confirmed that the explicit `request_conflict` code was already rejected upstream, but a retained foreign-request `platform_record` with a missing code could still be restored. The selected attempt now requires that field to be null; unrelated jobs remain outside this check. Five new regressions cover the existing code refusal and retained JSON/empty-string records in both workflows. Pre-fix probes left source bytes unchanged.

On the same base/toolchain, fresh typecheck, whitespace and full-suite checks passed **1,289 tests**, 8,477 assertions across 53 files. The restoration suite now has **47 cases**, 348 assertions. Full log: `/tmp/paperwork-restoration-conflict-final-tests.log`. Updated SHA-256 fingerprints: `restore.ts` = `70789e79d4c9b6f41ed875c6234572be501bb4d8fc98f9d1ef54acf787012281`; `recovery-restoration.test.ts` = `c24a504b5e6bf4c168de70791370f5ed8f543588ffba187d8abd422526084877`. Inspector/helper fingerprints and the operational limits above remain unchanged.

### Durable export checkpoint

Fresh **2026-11-11** checks used Bun **1.4.2**, TypeScript **7.0.2** and installed SDK **0.5.7**, based on committed restoration checkpoint `974c88b2e797211973c6b45cbd978664f7d2a9c9` plus the new exporter/CLI, three test files and accompanying docs. The two pre-existing Hermes documentation/profile edits were preserved.

`bun --no-env-file run typecheck`, `git diff --check` and `bun --no-env-file test` passed **1,332 tests**, 8,859 assertions across 55 files. Full log: `/tmp/paperwork-recovery-export-final-tests.log`. The focused command `bun --no-env-file test tests/recovery-export.test.ts tests/recovery-export-cli.test.ts` passed **43 cases**, 382 assertions; `bun --no-env-file scripts/export-restoration.ts --help` also exited 0 without loading inputs.

Actual child processes were killed with `SIGKILL` before completion publication and after durable publication but before a returned result. The first retained an incomplete private destination that refused reuse; the second reused the fully verified bundle without changing its file identities, modification times or bytes. A separate fixture-seeded link/unlink window verified reuse of the exact retained parent-side staging inode; it was not presented as another process-kill experiment. Tests also cover edited/rehashed payloads, an incorrect audit hash, missing/extra files, private ownership/modes, symlinks, sidecars and source/input preservation. Three original-source sidecar regressions failed before correction in `/tmp/paperwork-recovery-export-initial-tests.log`; the final guard checks them on both fresh export and reuse. A post-publication payload removal also refuses acknowledgment.

SHA-256 fingerprints of the tested new files:

| File | Digest |
| --- | --- |
| `src/server/recovery/export.ts` | `2650e7e5c210289d0bad7964d3425b2ddfe0379fc55ecd8449b527e94c43dcbd` |
| `scripts/export-restoration.ts` | `f1028ee1010643acd72b5a525cc1fdde3210c65d771f2d9e70416ee6c7750bae` |
| `tests/recovery-export.test.ts` | `63e092dd3b9511f13875349ee7ffd29e1b25b539a7e6b2ab8adfd2770e04eb7c` |
| `tests/recovery-export-cli.test.ts` | `a040c74f2ab903e0eb1b172ffdf3de092a68cf5852399f8f924891bb703d8f3f` |
| `tests/support/recovery-export-child.ts` | `9ec277e89f1db8b20a29e69c7dd0c4a965c2e3f88380ad9c5e1488c5da8b78aa` |

Only new disposable signed fixtures were used. The command itself imports no application runtime, starts no listener and performs no platform operation; fixture setup creates its own signed stand-in records. Existing manual demos, secrets, live state and real funds were not used. These results establish the local export protocol and process-interruption behavior, not physical power-loss durability, authoritative historical provenance, application-database installation or supervised resumption. SDK-stack/browser/hosted acceptance was not rerun, and no stage, commit or deployment was performed.

### Whole-database rehearsal checkpoint

The **2026-11-11 local / 2026-11-12 UTC** SDK run passed the exact [rehearsal command above](#whole-database-recovery-rehearsal). It used Bun **1.4.2**, TypeScript **7.0.2**, SDK **0.5.7**, Node **v24.22.2**, frozen platform source `f7caad4537e982190094e2654a064b25e7725f8a` and snapshot digest `36a66cb4212faef9d651a342baead7203238eb19d866acf9a8b2ec6ef1e76518`. App source/package/helper digest: `33b37f74115522bcc01d51316f5f160989e64481e1c033b62dbc21ef5f612cee`; copied public dependency digest: `98483c3373616d210e548ffa75399473a0d763f40f9772f65040c38aef8c12eb`. Base HEAD was `974c88b` plus the preceding uncommitted export work and this rehearsal's source/tests/docs; pre-existing Hermes edits were preserved.

Fresh checks passed `bun --no-env-file run typecheck`, `git diff --check` and `bun --no-env-file test`: **1,351 tests**, 9,100 assertions across 57 files. Full log: `/tmp/paperwork-recovery-handoff-final-tests.log`. The focused command `bun --no-env-file test tests/recovery-compatibility.test.ts tests/recovery-handoff.test.ts tests/recovery-restoration.test.ts tests/recovery-export.test.ts tests/recovery-export-cli.test.ts` passed **109 cases**, 971 assertions. The 13 new compatibility cases cover every recognized gate and incomplete input; six handoff cases cover v2/v3 full/partial/UNKNOWN through retained stand-in runtimes.

Concurrent `scripts/configure-review-key.browser.js` and `tests/review-key-setup.test.ts` appeared after that full-suite checkpoint and were left untouched, along with the separate Hermes files. Their coverage is outside the recorded recovery run; the frozen executed-source fingerprints below still match the current recovery files.

The actual SDK job retained request `ad063b7dc50ff8aa-p1-1`, payment correlation `a1ed32b1-31e9-49db-ba11-3c9e58ca9c45`, judgment `r_3f0d79a702eba225a5d50dc7`, submission `s_45b89656a5aed03f0d9cacbd` and invoice `i_45b89656a5aed03f0d9cacbd`. Terms hash: `ad063b7dc50ff8aac8631ff0542f155bfd1c95b18c8c737b22ed04f96b2e6011`. Original explicit approval: `b09031f5-43ee-4522-985b-339be313a9b0`. These IDs belong to this fresh isolated run, not another same-terms simulator receipt.

The clean export's known blockers changed **1 → 0**. Its working copy initially matched output SHA-256 `952153a9b3ed7c8100be865eb78ecdaf210c53d00a39d2aae14cff78e201dc93`. The mixed export changed **3 → 2**, retaining `fixture-unrelated-release` and orphan `fixture-orphan-release`. Its startup probe exited **1** with the exact `unsafe_budget_release` marker, no listener, an empty SDK trace and unchanged standalone database bytes. Both synthetic unrelated rows remain present and blocked; the mixed branch was never resumed or presented as repaired.

| App process | PID | Recorded termination |
| --- | --- | --- |
| Initial proposal | 22770 | Expected `SIGKILL`, awaited exit 137 |
| Original approval | 23205 | `SIGTERM`, awaited exit 143 |
| Mixed-history refusal | 23768 | Expected startup exit 1, no SDK call |
| Clean working copy | 23985 | Expected `SIGKILL`, awaited exit 137 |
| Same working DB after restart | 24284 | `SIGTERM`, awaited exit 0 |

Both clean working-copy processes successfully observed the bound original payout/payment as `PROCESSING`, keeping **300 USDC committed / 0 paid**. After the existing simulated settlement control, the second observed the same IDs as `SUCCESS`: one **300000000-atomic** payment, one successful settlement and zero provider errors. Its SDK trace contains nine read attempts and **zero SDK mutation attempts**. The simulated settlement control is separate from that read-only SDK assertion. Original stopped database/WAL/SHM, historical source copies and all four files in both bundles stayed unchanged; completed-bundle reuse still passed. Both launcher-owned stack/runner processes exited 0 after cleanup.

Retained artifacts: `/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/paperwork-restart-launch-JqJKKo/launcher-receipt.json`; under `jobs/paperwork-job-restart-DjSAJ0/`, `receipt.json`, `app-source-manifest.json`, `processes.json` and `recovery/` contain the inventories, sources, bundles, blocked probe and traces. Child receipt SHA-256: `7f49343dd75eefbece98fd78ab258f3278514b343026e1aedbf2e623b9fbed3c`. Command transcript: `/tmp/paperwork-recovery-rehearsal-sdk.log`. An independent session passed `--preflight` with no owned process/job (`paperwork-restart-launch-hMh07G`) and independently verified the retained frozen bundle/compatibility APIs and traces with network disabled; this was not a second SDK job.

Executed-code fingerprints match the retained SDK manifests:

| File | SHA-256 |
| --- | --- |
| `src/server/recovery/compatibility.ts` | `45f35e0a1fd1810f0062e4efd0107f0822d3ca9b071c46970398686213081e66` |
| `scripts/recovery-rehearsal.ts` | `0446dab6ee5099f969c223149e132f0dc5a38cb6e121645005f3b1cc2a838724` |
| `scripts/recovery-observer.ts` | `0d2563478095dc66dbef3d0bc74930db9ab0db3391d0d458a3b1f7bc3545c307` |
| `scripts/demo-job-restart.ts` | `f6ff2bc74b2598b1bc5bf100050bcb97d66f8df99e7ddf127504c7103f2dde99` |
| `scripts/demo-job-restart-local.ts` | `6affba6f73707bcaf420372f9f268e1519c494b12ae0b441521866038b37f843` |

The old local release and unrelated/orphaned history were explicitly seeded on closed disposable copies; no SDK failure, non-execution proof or real historical recovery was fabricated. V2 SDK restart, SDK UNKNOWN/partial cases, provider-response-loss G13/G14 and other uncompleted acceptance branches remain unproven by this run. Historical key authorization/provenance, unsupported correction cases, physical power loss and actual production installation/resumption remain separate. Manual demos, peer state, secrets, real funds and hosted services were not used; no stage, commit or deployment was performed. All recovery artifacts retain `clearance: "none"`.
