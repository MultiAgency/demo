# Combined experience evidence — November 11, 2026

Latest findings 1–7 corrections and fresh platform-main evidence: [PR #9 review record](pr-9-review.md). Earlier source hashes and test counts below retain their original scope.

The integration combines builder report/invoice jobs and wallet signing with the committed Agent Market branch `9c44162` (PR #7). Platform PR #6 was already merged as `fe8934d`. SDK remains **0.5.6**. The original builder changes remain recoverable in local stash `588d3b6ff88fb03dc97aa1bb3217c614b0ed200f` and public-source backup `/tmp/covenant-before-combined-oqgyhdwi`; the separate `demo-market` checkout and its running server were left unchanged.

The user subsequently reserved all commits for themselves and requested a rebase of `covenant-market` onto current main. At that checkpoint no integration commit or push had been made. The user later committed and pushed `1500ce49cd6cab05d19b52fffe1d41be5c663e94`, reviewed in PR #9. Deployment, live credentials, owner signatures and real funds remain outside authorization. A read-only Railway source-trigger query across accessible projects found no deployment trigger for `MultiAgency/demo`; no Railway configuration was applied or deployment performed.

## User validation of commit `1500ce4` — November 11, 2026

The user's pasted run reports **381 tests / 2,199 assertions** and passing typecheck, stand-in browser, SDK restart and combined browser commands. The named receipts and all screenshots were independently read and verified:

- `covenant-browser-yYRwC0/receipt.json`: requested changes, confirmed cancellation, immutable revision and one simulated 300 USDC payment; seven captures.
- `covenant-restart-launch-3UVu7k/launcher-receipt.json`, child `jobs/covenant-job-restart-IFxhwg/receipt.json`: original request/correlation across app processes `58421 → 60332`, one simulated 300 USDC payment, zero provider errors, no transaction hash. This loses the app HTTP response, not the provider response. App-source SHA-256: `2b828d0371e3040db51aa41d567b0f76c223cd1c19d7d1e954560bd2ba667b68`.
- `covenant-full-launch-cbdTFO/launcher-receipt.json`, child `jobs/covenant-browser-tmUFGl/receipt.json`: builder settlement plus a distinct 0.5 USDC market service returning `the article`; nine captures.

These directories are under `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T`. SDK evidence uses SDK 0.5.6, Node 24.22.2 and platform snapshot `36a66cb4` / source `f7caad4`. The user's interactive `covenant-full-launch-NsvbUg/jobs/covenant-full-app-F2rvMn` app is on port 3003. These runs predate the subsequent fixes for stale worker recovery snapshots and the AI deadline; they do not validate those fixes retroactively.

## PR #9 review corrections after `1500ce4`

- Worker polls now treat the initial pending list as candidate IDs, re-read eligibility before each versions request and condition recovery writes on the same agency/pending row snapshot. A different job's delayed versions read cannot downgrade a now-confirmed submission or turn a known refusal into uncertainty. Two deterministic two-assignment regressions preserve explicit rework/retry behavior and the empty-versions rule.
- Optional AI assessment now has a configurable 30-second application deadline (`JOB_ASSESSMENT_TIMEOUT_MS`) covering response headers and JSON body reads. Timeout aborts the request and releases the contract mutex even if the injected client ignores abort. Queued agency changes complete with the original submission/invoice/terms, no judgment, no payout request and no transfer. Late full-completion model results cannot create a proposal. Header and body regressions exercise both the assessor and whole job workflow.

Fresh checks: **388 tests passed, 0 failed, 2,309 assertions across 22 files**, log `/tmp/covenant-pr9-review-fixes-tests.log`; `bun run typecheck` and patch whitespace checks passed. Toolchain: Bun 1.4.2, TypeScript 7.0.2, SDK 0.5.6. Source manifest: `/tmp/covenant-pr9-review-fixes-manifest.json`, 105 selected source/test/script/build files, SHA-256 `93eb0c85b10c96946713c7f78dd7ff1767b9578580603beb4355f8fb586a4d48`, based on user commit `1500ce4` plus these local changes.

These new regressions are offline fixtures; they do not establish hosted AI, worker or payment behavior. The user's running interactive process on port 3003 was left untouched and retains its pre-fix loaded backend. The full browser/SDK receipts above remain evidence for their recorded source. Review corrections are uncommitted for the user; no merge, deployment or live action was performed.

## Rebase onto current main — November 11, 2026

Fetched main at `799feeb58534799d036ec795a8e4aa6e1ead9bc2`, including merged PR #7 (`f7c0373`) and PR #8. Rebased the actual `covenant-market` branch from `11e1b16` to that commit and restored the reconciled candidate without creating an ordinary commit. The original full candidate is retained in recovery stash `f5dfc5c3e5a0a10d3d9afb4820d40d3025bd9617`; the isolated reconciliation is also retained in `8d7edc5996ceaf766f82e8dc2eb4f8734b16bc6c` and `/tmp/covenant-rebased-main-candidate.patch`.

Retained upstream's setup-refusal guard, parallel independent market reads and updated `demo:market` script. Reconciled its DAO and worker recovery cases to require explicit terminal evidence: a generic refusal or stale `in_progress` observation cannot permit another submission. Added counterexamples covering prior settlement while frozen and uncertain worker submissions after reconstruction. PR #8's newer assertions target platform `cf59c43` / unreleased 0.5.7; the combined launcher's verified platform pin remains unchanged.

Fresh checks on the rebased candidate: **362 tests passed, 0 failed, 2,057 assertions across 22 files** (`/tmp/covenant-market-rebase-tests.log`), `bun run typecheck` passed, staged whitespace checked and no unmerged entries. An independent read-only audit confirmed the upstream fixes and recovery safeguards survived.

`bun run demo:full:check` also passed freshly from this checkout: one builder job through confirmed simulated settlement, then a distinct listed-agent service through delivery/payment in the same browser app. Launcher receipt: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-full-launch-jOWvFm/launcher-receipt.json`; browser receipt: `jobs/covenant-browser-0AgPqc/receipt.json`; log: `/tmp/covenant-market-rebase-browser.log`. Its isolated stack stopped normally. This remains simulation against snapshot `36a66cb4`, not a rerun of PR #8's newer-platform cases. G13 still blocks SDK-simulator rework; existing stand-in revision checks and their historical receipts remain separate.

Rebased source manifest: `/tmp/covenant-market-rebased-manifest.json`, **105 selected source, test, script and build files**, SHA-256 `7f0c23cc178cc8657a451c240825fb39897f6281fa9cb7155f61c67d97b139b2`. Browser evidence in the next section predates this rebase.

## Worker deliverable recovery follow-up — November 11, 2026

Historical implementation at `1500ce4`/`294abae` used any recorded version as assignment-level arrival evidence. That rule was incorrect after rework and is superseded by the PR #9 findings 1–7 correction: persist each attempt's server version baseline before POST and confirm only a newer matching version. The earlier test results below describe the historical implementation, not proof that its recovery rule was correct.

The full SDK browser receipts above predate this follow-up and do not exercise the worker API, which the pinned simulator lacks. Worker recovery verification uses offline HTTP fixtures and the real local worker/database code; it is not a hosted worker or real-payment observation. See the [API boundary](market-boundary.md#current-official-endpoints-and-actors).

Fresh verification: `bun test` **381 passed, 0 failed, 2,199 assertions across 22 files**, log `/tmp/covenant-worker-versions-tests.log`; `bun run typecheck` and patch whitespace checks passed. The isolation suite covers empty/nonempty versions, authenticated encoded paths, failed/malformed reads, reload recovery, active POSTs, shared concurrent polls and late replies after acceptance/rework. Independent read-only review found and verified the two late-response guards. No commit, deployment or hosted worker call was made.

## Integration changes

- Preserve immutable builder terms, report/invoice revisions, bounded compensation, explicit held approval, positive non-execution proof, durable payment/owner identities and atomic finalization.
- Thread the existing guarded wallet signer into market owner flows; scope private market resources/forms and late callbacks to the signed-in account.
- Persist market owner submissions and DAO hire filings as uncertain before external I/O. Lost filing replies cannot become discardable quotes or replacement hires. SDK 0.5.6 has no request-ID lookup for a lost DAO vote hash; unresolved cases remain blocked.
- Require a confirmed unfrozen state before initial or same-ID market sends. Preserve worker ownership across configuration changes, quarantine unbound historical records, keep malformed successful submission replies unknown and bound exact-byte webhook buffering to 1 MiB.
- Validate the normalized effective database path under a required volume. Preserve the market branch's locked Railway development dependency and compile its configuration without applying it.
- Add `demo:full` and `demo:full:check` using the existing verified-snapshot launcher and platform `--market` simulator. Interactive/browser fixture servers bind to loopback. Builder held withdrawals and instant x402 hires remain separate obligations and payment authorities.

## Checks before the rebase

| Check | Result and evidence |
| --- | --- |
| `bun test` | **335 passed, 0 failed; 1,940 assertions across 22 files**; final log `/tmp/covenant-combined-commit-tests.log` |
| `bun run typecheck` | Passed, including `.railway` configuration |
| Patch whitespace | Checked on staged source, including new files |
| `bun run demo:browser` | Passed full builder revision/cancellation/approval/settlement in two browser sessions; receipt `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-browser-60rxG9/receipt.json` |
| `bun run demo:full:check` | Passed one SDK-backed browser app through builder payment and separate market hire, with desktop/mobile captures; launcher `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-full-launch-M5WM29/launcher-receipt.json`, child `jobs/covenant-browser-uTe3Wi/receipt.json` |
| `bun run demo:job:restart` | Passed original identities over lost app response and actual process replacement; launcher `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-restart-launch-14oI3T/launcher-receipt.json`, child `jobs/covenant-job-restart-2kuS73/receipt.json` |
| Independent interactive recipe | A separate session started the documented command, verified loopback-only binding, checked Report and invoice selected and Agent Market navigation, and created no jobs/payments; app receipt `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-full-launch-chBkyM/jobs/covenant-full-app-C7h5wI/receipt.json` |

The combined browser receipt confirms builder request `5048d896ad774ea9-p1-1` paid **300 USDC** once, and distinct market service request `hire-e42f14ff-e6bc-4d2c-a9e3-84218f1635e2` paid **0.5 USDC**, returning `the article`. It checks that the market service did not pay the builder job again. The restart proof retained request `6724a37d57e67ab8-p1-1`, correlation `fd425bd3-0ec9-453e-a05d-fd5e676899df`, submission/invoice/proposal, and exactly one successful payout with zero provider errors. Process `63482` was killed; `63969` resumed its database.

Two initial combined browser attempts exposed checker races: the market hire was already paid before its pending button was sought, and setup had already become active before its next action was sought. Saved screens confirm those terminal states. The waits now recognize completion as well as available controls. Failed-run databases/identities were not reused or replaced; the clean pass used another fresh isolated simulator. The final loopback-only bind was then independently checked by the interactive recipe. A trailing blank line was normalized afterward; the complete final unit suite passed again. All automated-run owned processes stopped; the interactive app was intentionally left running for the user's walkthrough.

Final public source/scripts/tests/build-config manifest: **109 files**, `/tmp/covenant-full-integration-manifest.json`, SHA-256 `4ef2f20b8fbbf165cf4b5af52742ead977df87ec0b86597fe7d75aa2da700f26`. It excludes docs, secrets and runtime state. The SDK restart's own app-source hash is `2871d6eac38d7da7b60c7a89be7aaab35969eee0153b5d21d8191b518f29f448`. Each receipt identifies its actual source/run; later documentation and whitespace normalization do not retroactively change it.

## Limits

Every signature, provider/chain action, market delivery and settlement above is simulated. Actual wallet/hosted behavior remains unverified. G13 blocks SDK-simulator builder rework without positive cancellation proof; disputed closure retains the amount without pretending it was paid. G14 provider-response recovery remains unresolved. The simulator lacks directory and the full worker loop (M3), and DAO authority/provider windows have separate limits. Unbound historical worker records remain quarantined; lost DAO filing hashes have the supported same-request recovery described in the latest review record. See [platform-gaps.md](platform-gaps.md), [wallet-signing.md](wallet-signing.md), and [full-demo.md](full-demo.md).


> **Renamed 2026-11-11:** The app is now **MultiAgency Paperwork** (UI **Paperwork**), deployment `multiagency-paperwork`. Historical text, identifiers, commands and artifact paths above remain as recorded; they do not verify the renamed candidate. Current instructions are in the [README](../README.md).
