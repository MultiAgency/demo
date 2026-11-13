# Progress

## Local wallet funding button — not deployed

Step 8 now has a local **Review funding in wallet** implementation, reusing pinned SDK registration + USDC transfer actions. It checks the representative/mainnet wallet, signed scope, fresh deposit instructions and policy/authority/zero-balance verification. Full address and exact minimum are shown. Browser-local locking and a persisted unresolved marker prevent automatic resend after an interrupted wallet result. No live wallet or financial action was performed. See [funding behavior and limitations](docs/job-funding.md).

## Setup refresh correction · deployed f85f2c3

Ordinary representative job reads now reconcile existing creation, grant, policy and DAO-vote outcomes under the job mutex. Refresh never prepares a new owner action or files a DAO proposal. Policy completion still requires the newer revision and full signed-policy match. The setup UI uses that single snapshot, offers Refresh status at every step and distinguishes payout consent from owner/read consent. Existing account-scoped polling and return-to-tab refresh remain in use. A failed setup status check keeps the saved checklist visible, reports an error and skips further follow-up during that check.

Owner-reported hosted progress for `c_a2002ec56bf1` is 7 of 8 steps: policy revision 2 in force, funding not performed here. The correction is deployed from `f85f2c3`; all 105 runtime source/SDK files, frontend and served assets, TLS/access checks and all prior database records passed verification. The original volume, credentials and SDK/gateway pins are preserved. The no-write window is released; see [deployment receipt](docs/deployment-update-f85f2c3.json). Funding, payment and DAO hosted acceptance remain separate gates. Offline checks and evidence boundaries are recorded in [setup refresh review](docs/setup-refresh-review.json).

Current release and deployment status: [release-status.json](docs/release-status.json). Paperwork source `f85f2c3` is deployed at https://desk.multiagency.ai; scoped read-only acceptance passes. [Exact source, image and acceptance record](docs/deployment-update-f85f2c3.json). The dated checkpoints below preserve their original evidence and then-open limitations.

## Previous deployment checkpoint — ef73b58

At that checkpoint, `ef73b58` was live on deployment `99d46b9a-85b2-4943-8841-bdba2105864c`. All 105 source/SDK inputs, runtime/frontend artifacts, TLS and private/public access checks pass. The original 50,000 MB volume, SQLite records, signatures and invitation binding are preserved; no setup or financial records were created during deployment acceptance.

The unchanged SDK 0.5.9 passed six isolated consumer scenarios against gateway source `39eefe118`, manifest `3f50539c…`, currently bound to deployment `62cb5775…`. This is separate compatibility evidence, not a repository repin. The temporary Market setup window was closed; Payables setup admission is separate and was subsequently confirmed by the coordinator. No maintenance start-command override or host-wide executor-off state is claimed. No Market/executor resume is authorized. Native-backup availability was accepted by the owner; completion time and restore remain unverified.

Subsequent owner-supervised registration and wallet setup reached policy revision 2 in force, according to the hosted UI supplied by the owner. Funding and payments remain unapproved; DAO hosted acceptance is separate. The earlier checkpoints below retain their original then-open gates; current status supersedes those historical statements.

Historical update **2026-11-11** after the offline Hermes/key-setup review. The local milestone covers both Report and invoice (v3) and Pay on merge (v2).

## Historical checkpoint — 2026-11-11

Bun **1.4.2**, TypeScript **7.0.2**, SDK **0.5.7**; base HEAD `1833cb7` plus the reviewed Hermes/key-setup files and documentation updates. The recovery/export/rehearsal work is committed at that HEAD.

- `bun --no-env-file run typecheck` passed.
- `bun --no-env-file test` passed **1,377 tests**, 9,240 assertions across 58 files. Log: `/tmp/paperwork-hermes-offline-review-tests.log`.
- The checker/key-helper suites passed **34 cases**, 193 assertions. Regressions cover contradictory completion, escaped credential echoes, absolute origin binding and key-state changes during the prompt. YAML syntax/expected configuration fields and whitespace checks also passed.
- No hosted request, key/profile read or write, browser run or runtime update was performed. Prior user-reported key-save/Chat results remain separate from authenticated Runs/provider/isolation evidence. [Offline review receipt](docs/hermes-review.md#offline-key-setup-review-checkpoint--2026-11-11).

The committed recovery rehearsal remains the latest independent SDK result: mixed blockers **3 → 2** stay blocked; a separate clean copy retains the original 300 USDC dispute across restart and settles once, with zero SDK mutation attempts and unchanged bundles. It was not rerun for the helper/checker review. Every recovery receipt retains `clearance: "none"`.

Current commands, source fingerprints and limits are in the [Hermes review checkpoint](docs/hermes-review.md#offline-key-setup-review-checkpoint--2026-11-11). Earlier receipts remain in the [whole-database rehearsal checkpoint](docs/recovery-acceptance.md#whole-database-rehearsal-checkpoint), [dated recovery evidence](docs/recovery-acceptance.md#dated-recovery-evidence) and historical [documentation audit](docs/documentation-audit.json); they identify their recorded source states.

## Implemented

- Both signed job workflows, scope/invoice accounting, held payouts and explicit agency approval.
- Desk, Assigned to me, public openings/onboarding and the separate Agent Market integration.
- Durable submission/payment/owner-action identities, account-scoped browser resources and wallet signing.
- Both-version failed-payment proof guards, retained refund evidence and unsafe-history startup refusal before migration.
- Standalone ledger/compatibility inventory, bounded SDK collection, audited restoration/export and scoped disposable handoff/restart rehearsal. [Recovery commands and limits](docs/recovery-acceptance.md).
- Optional Hermes review drafting with offline authorization, citation, streaming/cancellation and browser checks. [Hermes implementation and hosted status](docs/hermes-review.md).

## Known gaps

| Area | Current limitation |
| --- | --- |
| Historical recovery | Real historical provenance/key authorization and unsupported recovery cases remain unresolved. Local rehearsal covers stand-in v2/v3 and SDK v3 processing/full settlement, not physical power loss or real installation/resumption. Deployment preflight must precede startup because runtime binding follows possible migrations. Unsafe unrelated history still blocks the database. |
| Privacy/Verify | V2/v3 full-job and detailed verification reads require a named party; terms requests require the caller’s own role. Builder job responses omit owner preparations, deposit instructions and owner-consent expiry metadata. Public Verify uses `/verify/public` and only allowlisted checks. Fresh local validation is recorded below; hosted acceptance remains pending. |
| Acceptance | Full v2 payment browser and independent v2 restart branches now pass. Provider-response-loss continuation, historical restoration/install clearance and hosted evidence remain separate. Recorded G13/G14 safe halts do not demonstrate continuation; later candidates need fresh checks. [Acceptance matrix](docs/recovery-acceptance.md#acceptance-matrix). |
| V2 assessment | Cloud judging has no explicit timeout; GitHub evidence reads only the first 50 results per repository. |
| Hermes | Authenticated profile Runs routing, actual NEAR provider execution, effective isolation and hosted-version update remain unverified. Prior user-reported Chat/key-save results are limited evidence. The key helper narrows the prompt race but lacks atomic server-side create-only/CAS. |
| Market | Paid hires stop task observation; authority renewal is missing. Worker handles one agency, polls the latest 100 assignments without pagination, and has recorded simulator directory/worker gaps. |
| Invitations | Lost creation replies or unavailable browser storage can strand the original link; creation has no durable client request identity. |
| Discovery/UI | Listing-specific application-to-offer linkage and native internal-listing publication are absent. Some forms and directory/config/deposit reads have incomplete pending/error/supersession handling. |

Evidence links are supplied references, not fetched or quality-verified artifacts. Requested changes apply only while proposals remain wholly unapproved/unpaid. [State-machine audit](docs/implicit-state-machines.md), [architecture](ARCHITECTURE.md) and [recorded platform gaps](docs/platform-gaps.md) contain the supporting detail.

## Local follow-up — November 13, 2026

Builder registration now has a private on-chain quote, explicit wallet review and a fresh status check. Unknown status stays unknown; acceptance and agency preparation are separate. This implementation is local and has not registered an account or been deployed. See [registration flow and limits](docs/payee-registration.md).

Precommit checks: typecheck, all 1,562 offline tests, the simulated job workflow, SDK pin verification, frontend build and whitespace checks pass. Registration desktop/mobile and state-transition checks use offline fixtures. No new container or hosted registration acceptance is claimed.

The reviewed payout changes refuse foreign request/payment identities and retain commitments when a known payment regresses to a refused/missing request record. Dropping blocked judgments requires a fresh matching absence observation. The provider-response-loss G14 gap remains open; see [restart evidence](docs/job-restart.md).

## CI artifact review — November 12, 2026 (America/New_York)

GitHub run `43340276379` on `39e521d` reports success, but its retained artifacts contain failed builder-mobile and public-Verify overflow checks and no final receipts for those two recipes. That run does not qualify browser/privacy acceptance. The standalone header is now allowed to wrap its brand/actions. CI explicitly selects Bash so pipeline failures propagate instead of being hidden by `tee`, and browser stderr is retained in the log artifacts. Local complete-job and v2/v3 privacy reruns now pass with positive receipts, alongside typecheck, actionlint and a pipeline-failure probe. Receipts: `data/release-evidence/ci-correction-39e521d/review.json`. Remote CI must be rerun on the corrected exact commit. The native Linux container build/smoke and other passing steps from the original run remain dated evidence for `39e521d`, not the corrected source.

No deployment or live financial action was performed. The original empty-volume deployment helper is inapplicable to the now-populated volume; any update must preserve the existing signed job and use a separately reviewed backup/update procedure.

## Next

The reviewed app update is deployed from ef73b58; current exact-head CI, Linux packaging and read-only hosted acceptance pass. Prepare the exact setup and registration actions/costs for separate approval; do not redeploy or register an account from a local test pass. Remote CI and the scoped deployment/nonfinancial checks pass. Scoped hosted wallet login, cancellation, refusal and both job-terms signatures pass. DAO setup/quorum, USDC registration, funding and payment remain unapproved; see [current release status](docs/release-status.json).

Existing manual demos remain untouched under the user's local run/freeze confirmation. Production deployments/restarts remain paused; local checks grant no live-operation authority.


## Privacy gate — local validation, 2026-11-12

Implemented the approved v2/v3 boundary: named-party full-job and detailed Verify reads, own-role terms requests, generic account refusals, no-store API responses, and builder responses without owner preparations/deposit data (including the signature response). Original signed bytes, recipients and invitation hashes are unchanged. Public `/api/contracts/:id/verify/public` returns only the approved hash/version/status/check-map/time projection; the public page reads no full-job endpoint and explains that funding is not a lifetime provider cap.

Fresh checks on local `80afa29` plus the privacy delta: typecheck passed; **1,546 tests passed**, zero failures, 10,369 assertions. `demo:job`, `demo:e2e` and `demo:browser` passed. The browser includes immutable revision/rejection, refresh failure recovery, approval/processing, one simulated settlement, and public Verify without a full-job request at desktop/mobile sizes. Browser receipt: `/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/paperwork-browser-0fF0IJ/receipt.json`. Logs and source/artifact hashes are recorded in `/tmp/paperwork-privacy-20261112/verification.json`.

Initial failures are retained: one old test expected public v2 access and was corrected to require 401 while preserving its no-send assertion; sandboxed TLS/E2E listeners were refused and passed with local socket permission; the first browser privacy assertion counted resource timing entries from an earlier private page and was corrected to use a fresh document without weakening the no-private-request requirement. No credentials, paid inference, hosted services, live money or platform maintenance were used.

These are simulated/local checks, not hosted wallet, DAO quorum or mainnet acceptance. The browser journey is v3; dedicated v2 browser and the remaining acceptance-matrix branches are still open. The coordinator's final release manifest, replacement artifact pinning, packaging and exact-artifact acceptance remain release gates. No commit, push, merge or deployment was performed; inactive candidate artifacts were preserved.


## V2/v3 privacy browser matrix and hosted-run preparation — 2026-11-12

`bun run demo:privacy:browser` now passes for new unsigned and existing signed v2/v3 jobs. The existing v2 fixture retains its original `covenant` signing recipient; both versions preserve exact signature, terms-hash and invitation records. Actual browser requests test anonymous/unrelated refusals, named-party reads, own-role signing requests and builder redaction. Public Verify passes at 390px and 1440px without requesting a full job; a same-tab refused refresh clears private details. Fixture sessions are explicitly simulated; no wallet sign-in, gateway call or payment is represented. Receipt: `/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/paperwork-privacy-browser-9XVSym/receipt.json`. Typecheck and whitespace checks pass. Earlier browser-matrix failures were fixture-handler/readiness mistakes; production auth and assertions were not relaxed.

Each receipt records the unchanged SDK SHA-256 `68a9924c224a3c7969c72243cefeb4e37864e0973f61e9c671bb39bd2759600b`, gateway snapshot `8f65066e6013f0c9f7fd68717f3bd11103b35d216034c329f002212fb3c6c0a7`, full gateway provenance, lockfile and script hashes. This closes dedicated privacy browser coverage, not the complete v2 payment/restart matrix.

The user reconfirmed the release hold: no final approved combined manifest exists; historical withdrawal receipt-coverage refusal, Market-route proof and final combined source/candidate verification remain outstanding. Treasury development compatibility artifacts do not authorize Paperwork repinning. SDK/gateway pins and inactive artifacts remain untouched. The platform owning session retains maintenance responsibility.

[Staging plan](docs/staging-run-plan.json) and [operator checklist](docs/staging-acceptance.md) prepare wallet/DAO cases with `buildr.near` as payee. Recommended planning ceilings are 1 USDC per job (2 USDC total gross), 1 USDC combined provider/route fees, and 0.1 NEAR total setup/storage/gas; these are not approved spending or fee estimates. Actual staging origin, budgets, fee payer, DAO representative/quorum and final run dates remain unapproved. No publication, deployment, credential issuance, live signing or funds movement is authorized or performed.


## Final combined SDK/gateway repin — 2026-11-12

The user authorized paired offline-only repinning from the authoritative final handoff. Before adoption, verified its SDK/provenance/release/gateway/source-archive/image-archive hashes, clean source bindings, owner commit signature, 57 SDK source inputs and 256 gateway package files. Current package is `vendor/multiagency-sdk/multiagency-sdk-0.5.9-252cba1.tgz`, SHA-256 `4ae53dce669664bcf90e0c5939e0ac617db0ab24c101e3792fc659ac4494475a`; installed package files match all 101 tarball files. Gateway pin selects clean signed commit `252cba1d1e6642a5ea9f42ea4927f982423ed8e1`, snapshot `822346ac5b50313d493c951971695abbbab5cc1d5a48ca8868bc73421a609a40`, dependencies `400d16463092b8b5b68c14b3225cb0fe7c3dec3e438dd391c2cb121b814ab0b3`, Node 24.22.3. SDK/gateway moved together; old artifacts and privacy work were preserved. The restart launcher now validates the current pair instead of selecting the older 0.5.7 snapshot.

Fresh consumer checks pass: typecheck; 1,546 tests / 10,369 assertions; security E2E; copied-final-gateway DAO reject/rework/approve/settlement, DAO clean-handoff recovery and wallet job; documented wallet SIGKILL/original-ID recovery after suppressed app HTTP reply; stand-in job/revision browser and v2/v3 privacy browser matrix; standalone frontend build. All provider, chain, signatures and payments were simulated. The wallet restart proof is not gateway/provider-response-loss recovery. DAO recovery remains a clean DB handoff, not a DAO SIGKILL proof. Gateway settlement transaction hashes were absent, not invented. Browser recipes use stand-in/fixture sessions, not real wallets or a gateway browser acceptance claim.

The retained failures are preparation-only: sandboxed install needed temp/cache permission; first custom gateway could not resolve `tsx` until the owned dependency path was supplied; the auxiliary wallet restart lacked the required E2E manifest and stopped before app startup. The documented launcher then passed without weakening provenance or payment assertions. Owned test stacks stopped. Source/artifact hashes, all original logs and linked receipts are retained in `/tmp/paperwork-final-252cba1/verification.json`; local summary is [final consumer results](docs/final-consumer-252cba1.json).

Final pin adoption and these consumer gates do not authorize publication/deployment/staging restart or live financial actions. Market-route proof, configured shared provider-key/external authority boundary, staging maintenance completion, hosted capabilities, real wallets, DAO quorum and independent builder receipt remain operational/release gates. Paperwork Linux/container packaging was not rerun in this validation. No commit, push, merge, tag or deployment occurred.


## Local release review, packaging and CI — 2026-11-12

Reviewed the combined DAO/privacy/final-pin delta and all candidate files; inactive `0018f553` files remain preserved/excluded. SDK/gateway pins are unchanged. SDK publication is independently recorded by the coordinator as byte-identical; active docs now acknowledge publication without rewriting historical handoffs/receipts.

Found and fixed two packaging defects: the broad vendor copy/context could include inactive artifacts, and a runtime-bundled production asset failed after restart when requested before HTML. The Docker context is now allowlisted and copies only the active tarball. The image builds a complete frontend artifact once; startup verifies its manifest and serves every asset eagerly. HTML uses no-cache; hashed assets remain immutable. Tests refuse corrupt/duplicate/escaping manifests. Full artifacts and both local images are retained, not deployed.

Fresh checks: typecheck; **1,549 tests, zero failures, 10,377 assertions**; actionlint; privacy and v3 revision/payment desktop/mobile browsers; standard job and security E2E; Linux arm64 and amd64 production images with network-disabled startup, SDK/secret/privacy, real bundled-asset and synthetic SQLite restart checks. The first runtime-bundled asset failure is retained; corrected images pass without requesting HTML before the old asset. The amd64 smoke ran under Docker Desktop emulation, not a native hosted runner.

The existing v2 SDK HTTP recipe also now passes against a fresh final copied gateway: **$1,000/$1,000 confirmed simulated payment**, four approved transfers, rejected-work exclusion and no attacker payment. Its earlier disputed remainder is historical. No assertions were weakened or uncertain payment replaced. The owned simulated stack stopped.

[Local review](docs/local-release-review.json) reconciles the remaining gates. Required full v2 payment-browser and independent v2 process-restart branches are still release blockers. Privacy browser checks and v3 restart receipts do not close them. GitHub CI is prepared and linted, but not run remotely; no push is authorized. Platform maintenance/Market-route/shared-authority and real wallet/quorum/receipt checks remain separate hosted gates. Optional paid review remains off for acceptance.

The prepared explicit commit set, source hashes, image/frontend archives and current receipts are at `/tmp/paperwork-local-release/verification.json` and `/tmp/paperwork-local-release/commit-plan.json`. No index staging, commit, push, merge, deployment, staging restart, credentials or live funds action occurred.


## Closing the v2 local acceptance branches — 2026-11-12

Both remaining named local blockers are closed. `bun --no-env-file scripts/demo-v2-browser.ts` passes a complete GUI Pay on merge job: both signatures, setup/funding, visible unrelated/self-merged PR exclusions, explicit approvals, flagged-work rejection with positive non-execution proof, a fresh completed-run event showing rejected work is not paid again, legitimate later completion and **$1,000 confirmed simulated payment in four transfers**. Both browser views reload the same terms/payment identities and pass 390/1440px checks. It uses keyless fixture browsers, not hosted sessions. Early harness failures (radio events, stale tab after builder acceptance, incorrect button/tab selector) were retained; workflow, payment and exclusion assertions were not relaxed.

`bun --no-env-file scripts/demo-job-restart-local.ts --v2` passes the independent final-gateway process proof: lost completed merge-judgment app reply, SIGKILL, new PID, original judgment/request/correlation/recipient/amount/sequence, repeated-run deferral, explicit approval with zero paid, then **one original $300 simulated payment** equal to the full fixture scope. No v2 submission/invoice IDs are invented. The v3 default was rerun and retains its original submission/invoice and idempotent-retry assertions. Unsupported mode combinations/unknown workflows refuse before stack/job startup. All owned stacks/processes stopped.

Typecheck, all **1,549 tests** (10,377 assertions), actionlint and whitespace checks pass. The existing Linux arm64/amd64 image receipts still bind every unchanged Docker build input; production app code and the SDK/gateway pins were not changed for these harness additions. CI now includes the v2 browser, while frozen-gateway restart receipts remain separate from portable CI.

[Current v2 results](docs/v2-acceptance.json) and `/tmp/paperwork-v2-acceptance/verification.json` hold exact source/artifact pins and refreshed commit plan. Earlier source/packaging/receipt artifacts are preserved. This closes the two named local branches, not G14 provider-response-loss continuation, DAO SIGKILL recovery, real historical installation, remote CI or hosted wallet/quorum/payment proof. No staging/credential/funds action, staging of files, commit, push, merge or deployment occurred.
