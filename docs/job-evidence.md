# Builder-job evidence — 2026-11-11

This is local development evidence, with no release or live-payment authorization. No commits, deployment, production restart, live credentials, real funds or external messages were performed. The SDK integration from open demo PR #6 at `11e1b16` was extended in the working tree; other sessions' changes were preserved.

## Wallet-signing follow-up — current local candidate

Implemented the shared-client workflow signer and durable owner-signing identities described in [wallet-signing.md](wallet-signing.md). Current checks:

| Check | Result / scope |
| --- | --- |
| `bun test` | **272 passed, 0 failed; 1,596 assertions across 18 files**; `/tmp/covenant-wallet-final-tests.log` |
| Focused signer/API/owner-recovery command in a separate agent session | **36 passed, 244 assertions**; same Bun 1.4.2, no recipe blockers; entirely offline fixtures |
| `bun run typecheck`, `git diff --check` | Passed |
| `DEMO_JOB_CHANGES=1 DEMO_JOB_LOST_REPLY=1 bun run demo:job` | Passed; one revised job and one simulated payment; `/tmp/covenant-wallet-job.log` |
| `bun run demo:browser` | Passed with revision, distinct processing/settlement and both parties at desktop/mobile sizes; simulated signing/provider/settlement |
| `bun run demo:job:restart` | Passed on the actual SDK 0.5.6 gateway with original IDs over lost app response and `SIGKILL`/restart; simulated provider/chain/signatures |

Independent user reproduction on November 11, 2026: the user ran both commands from the `demo` checkout and supplied passing transcripts. The local receipts were then read and verified:

| Command | User-run receipt / verified outcome |
| --- | --- |
| `bun run demo:browser` | `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-browser-2nailw/receipt.json`; complete revision journey, request `5048d896ad774ea9-p2-1`, one successful simulated 300 USDC payment |
| `bun run demo:job:restart` | `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-restart-launch-N50FkV/jobs/covenant-job-restart-4XuDIC/receipt.json`; source/package hash `538ec17c4b117b8e94fa374310af010a7342f85dcc1d00fba617d90d1ec4b387` matches the agent-run source; original request `6724a37d57e67ab8-p1-1` and correlation `c9d388de-718b-4720-b951-f1927d24a8c3` survive process replacement; exactly one simulated `SUCCESS` of `300000000` atomic USDC to `maria.demo`, zero provider errors |

The user's restart receipt records process `1896` killed with exit 137 and process `2080` cleaned up with exit 143. Its launcher receipt confirms both owned wrapper processes exited 0. Transaction evidence remains null. This is independent developer reproduction of the simulated flows, not an actual wallet, hosted provider or real-payment check.

Final public source/scripts/tests/package manifest: **85 files**, `/tmp/covenant-wallet-signing-manifest.json`, aggregate SHA-256 `e0c621b85976085687ea26c4e45cbd69f7a153c699f126472e8f66c4a1ae6ef1`. All files still matched after the integration runs. No dependency/lockfile changes were made. Earlier manifests below remain historical.

Agent-run browser receipt: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-browser-JSIDsM/receipt.json`, plus seven screenshots. The revised submission is `s_e6123802a3ab818ab66c87c3`, invoice `i_e6123802a3ab818ab66c87c3`, proposal `r_370f1e6aa582051c782a06b5`, request `5048d896ad774ea9-p2-1`, approval `d10c9113-7216-48fb-aa98-1431f2ef26a1` and payment `aec399d7-a733-46fd-a285-b6edc9e36d68`. Both parties see one successful simulated gross 300 USDC payment to the agreed builder.

Agent-run SDK launcher receipt: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-restart-launch-TycRB2/launcher-receipt.json`; child artifacts: `jobs/covenant-job-restart-lrqlej/`. App source/package fingerprint is `538ec17c4b117b8e94fa374310af010a7342f85dcc1d00fba617d90d1ec4b387`. Process `51710` exited 137 after `SIGKILL`; process `51837` resumed the same SQLite/identities and exited 143 on cleanup. Request `6724a37d57e67ab8-p1-1`, correlation `125bd074-b9ee-4728-8db5-ef9186a45f8d`, retained the original report/invoice/proposal links. The stopped simulator independently records one `SUCCESS` of `300000000` atomic USDC to `maria.demo`, zero errors and one created agent; sanitized `provider-observation.json` retains those public fields. Transaction hash remains null. Launcher-owned gateway and child processes both exited cleanly. [job-restart.md](job-restart.md) describes the exact fault boundary and pinned snapshot.

Initial sandbox attempts could not listen on loopback; those failed attempts are not passing evidence. The checks above were rerun with permission for the isolated local processes. The browser runner closed its owned sessions/server.

These complete-flow runs still use demo signatures. The **new wallet adapter** is separately verified with real cryptographic fixture signatures, injected wallet/session/HTTP responses and durable simulated-platform tests; no actual NearConnect popup, extension, live wallet/RPC, hosted approval or real payment was exercised. G13/G14 remain open on the unchanged frozen platform snapshot. A definitive owner-submit refusal also conservatively retains its attempted-vote marker; confirm-only external actions cannot be silently superseded. See the limits in [wallet-signing.md](wallet-signing.md) before any separately authorized hosted acceptance.

## Earlier careful review

After financial/authentication review, the current suite is **236 passed, 0 failed; 1,352 assertions across 15 files**. New cases cover positive non-execution proof through the installed SDK parser/adapter, contradictory payment evidence, atomic finalization/timer repair, protected reads, account/session races and safe refusal of ambiguous historical ledgers. Typecheck and whitespace checks pass. The original dependency lock is unchanged. [review-2026-11-11.md](review-2026-11-11.md) records the findings and fixes.

Current browser receipt: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-browser-zJ3HSr/receipt.json`. Its seven screenshots show actual two-party forms and review at desktop/mobile sizes, including revision and approval before settlement. It confirms exactly one successful simulated gross 300 USDC payout to the signed payee: request `5048d896ad774ea9-p2-1`, approval `405a04ed-0684-488e-b154-b9b9acf69d3f`, payment `9ae048ba-ded8-4fc1-8c0f-c6df6af3fa88`, simulated transaction `FAKE-ba2410bac2d0f32437d55c20423f11e1`.

The exact no-environment command `bun run demo:job:restart` passes after these fixes. Its owned fresh SDK gateway confirms one successful simulated payout and retains the same IDs over a lost app HTTP response and `SIGKILL`/restart. Launcher receipt: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-restart-launch-kQij0i/launcher-receipt.json`; child receipt: `jobs/covenant-job-restart-By7pyc/receipt.json`. App source/package manifest fingerprint for that run is `6db0c75b5fab1a2ca23137d2246f7fa3fe65aba27697bbea6939c0af7dad2370`; tested launcher/runner/dependency hashes are in [job-restart.md](job-restart.md).

Two limitations are now explicit. The frozen provider simulator omits positive rejection non-execution proof, so corrected gateway rework blocks; its earlier pass below predates the safety correction (G13). Its **existing** `dropWithdrawResponse` control was exercised by `JOB_RESTART_DROP_WITHDRAW=1 bun run demo:job:restart`: bounded recovery failed after 25 seconds, with one unknown app request and one held simulator withdrawal, no approval, no success and no replacement (G14). It is not a passing settlement/recovery claim. Receipts and precise scope are in [platform-gaps.md](platform-gaps.md) and [job-restart.md](job-restart.md). All owned app, browser and stack processes stopped.

Final source/scripts/tests/package manifest: **80 files**, `/tmp/covenant-final-review-manifest.json`, aggregate SHA-256 `979d288c1e842d693944354405a214674714cecef1207a34b9911da636068954`. It excludes docs, secrets and runtime state. Final logs: `/tmp/covenant-final-review-tests.log` and `/tmp/covenant-final-review-job.log`; the latter passes requested changes, revision and lost-response fixtures with one simulated 300 USDC payment. The final signout guard and manual-resolution/ledger compatibility guards were verified by targeted tests and the full suite after the browser/SDK receipt runs. Those earlier receipts remain evidence for their own recorded code, not this final manifest automatically. No further hosted or real-payment evidence is implied.

## Earlier implementation and follow-up verification

Toolchain: Bun **1.4.2**; platform stack **Node 24.22.2**. The app is a Bun application; no dependency versions were changed.

Initial builder-job application/scripts/tests manifest (68 files, excluding secrets and runtime state): `/tmp/covenant-job-implementation-manifest.json`, aggregate SHA-256 `9558523623d35158760928df5948ced5c9fed7a3cbe580faffd6bd75f97fc80e`. It records the original slice over baseline `11e1b16861ecdb3463137ec57f52326ca609870b`; follow-up browser/restart evidence appears below. This is source provenance, not a release artifact or deployment authorization. The original tracked dependency lock is unchanged.

Historical follow-up source/scripts/tests manifest: **70 files**, `/tmp/covenant-followup-implementation-manifest.json`, SHA-256 `63b9273c0ced22acdc6a1df9ddfd91f8b7764766c4a79bf80c351f5b6ef2016f`. Its browser runner hash was `cac792834944f283797e0b1643c1e361bc8bc446d03face34ced8ce22c45640d`; restart runner hash was `9d6a27a74be77d3ed5d3911cdb1acfeb4eba1e6c9f1126ae3f198f1af128b2e4`. That earlier suite passed 198 tests / 918 assertions. These hashes/counts do not identify the current reviewed source.

| Check | Result | What it establishes |
| --- | --- | --- |
| `bun test` | **198 passed, 0 failed; 918 assertions; 10 files** | Existing workflow regressions plus the new job/assessment cases; scripted stand-ins and injected AI responses |
| `bun run typecheck`, `git diff --check` | Passed | Type consistency and patch whitespace |
| `bun run demo:job` | Passed | One agency, one builder, one $300 job through confirmed stand-in payment |
| `DEMO_JOB_CHANGES=1 DEMO_JOB_LOST_REPLY=1 bun run demo:job` | Passed | Original held proposal cancelled by signed rejection, immutable revision paid once; lost replies observed by the same IDs |
| `DEMO_BUDGET_USD=150 DEMO_INVOICE_USD=125 bun run demo:job` | Passed | Compensation stays at the lower invoice cap |
| `bun run demo:e2e` | Passed, all original scenario steps | Existing merge-based contracts still pay $1,000 through four approved simulated transfers |
| Earlier SDK stack job with `DEMO_JOB_CHANGES=1` | Historical pass before cancellation-proof correction | Rework currently blocks on missing simulator proof (G13); this earlier transcript is not current rerunnable evidence |
| `bun run demo:browser` | Passed, exit 0; agency and builder at 1440×1000 and 390×844 | Actual forms/clicks for offer, both signatures, setup, report/invoice, proposal, changes, rejection, revision, approval and settlement; both party views retain the same payment identity |
| Earlier restart runner with supplied fresh stack | Historical pass, exit 0 | A lost app HTTP proposal response followed by `SIGKILL` and a second app process on the same SQLite; actual SDK/gateway, same identities, exactly one simulated successful payment |

The dedicated workflow suite has **15 tests / 195 assertions**: acceptance and submission gates, invoice/remaining-budget caps including multiple payment sequences, submission idempotency and duplicate invoices, immutable revisions, held cancellation, stale prepared approvals, unavailable outcomes, `request_conflict`, anonymous and wrong-account authorization, private report access, hostile report instructions, a SQLite close/reopen, destination-only transaction evidence and insufficient funds. The separate **5 tests / 27 assertions** for the optional AI assessor inject every HTTP answer; no hosted model was called.

The unit recovery test closes the app's SQLite connection and builds a new runtime over the same database while retaining the independent scripted provider. It preserves submission, invoice, judgment and payment identities and produces one successful transfer. The separate [process-restart proof](job-restart.md) now extends this to two actual OS processes and the independent SDK gateway; its lost response is at the app HTTP boundary, not between gateway and provider. Default browser demos keep isolated in-memory app/provider state; production app state uses its required durable database and the external platform.

The earlier form-only captures (`/tmp/covenant-job-new-desktop.png`, `/tmp/covenant-job-new-mobile.png`) and interrupted Create draft observation are superseded by the completed browser journey. The diagnostic cause was off-screen automation clicks; explicitly scrolling and refreshing accessibility references made Create draft and the other controls work. No Create draft application behavior was changed. The responsive run found and fixed a mobile transaction-row overflow. The confirming journey now checks both page widths, and an actual simulated pending approval stays distinct from confirmed settlement.

Earlier browser evidence: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-browser-UCY0jO/receipt.json`, with seven phase/party/size screenshots in the same directory. It records job `c_5048d896ad77`, revised submission `s_e7cd363a3353299d2f549715`, invoice `i_e7cd363a3353299d2f549715`, proposal `r_d7d8f80203268d363879b44e`, payout `5048d896ad774ea9-p2-1`, approval `3f5f7ca9-1df3-4790-8f1a-232dcfca5f65`, payment `35b28286-fdc6-4181-81fc-e5ec2418c61f`, and one successful simulated $300 transfer. [browser-demo.md](browser-demo.md) documents the command. All owned browser sessions and servers were stopped.

The reviewed real-process restart receipt is `/tmp/covenant-job-restart-NKz2oP/receipt.json`. Process `27563` was killed with `SIGKILL` (awaited result 137); process `27722` resumed the same SQLite and was stopped with `SIGTERM` (143). Submission `s_60f1d5ee060da1183f765e70`, invoice `i_60f1d5ee060da1183f765e70`, judgment `r_0f5a80f8654eb0aa838fdaf8`, request `6724a37d57e67ab8-p1-1` and payment correlation `33c755bd-edf8-47eb-b275-b0e90634e819` were unchanged across the crash. Independent provider evidence confirms one `SUCCESS` of exactly `300000000` atomic USDC to the agreed `maria.demo`, with zero provider errors. Copied app dependencies were fingerprinted (`29c3057585d21ee7aa62bdaa6ae4eaba7e1dabad5a30f0bef52f6d8c281c7353`, 7,026 entries); HTTP waits and owned-child cleanup are bounded. See [job-restart.md](job-restart.md) for the final source/runner hashes, exact fault boundary and earlier dated runs. The owned gateway was stopped cleanly. No hosted or live payment occurred.

Sandbox attempts that could not bind a local port or read the loopback chain are not passing evidence. Those checks were rerun with permission for the isolated local processes. A script-observation bug after extending the recipe to the gateway was also fixed: the automatic stand-in was being advanced past `processing` by an observation read. Stand-in recipes now inspect that phase without advancing it; the executable browser demo uses explicit simulated settlement. No second payment was issued to repair a failed receipt assertion.

## Earlier real SDK / local gateway rework run

This transcript predates the positive non-execution-proof correction. Preserve it as historical evidence; current code must not complete this snapshot's rejection/revision without the missing proof (G13).

Platform verified snapshot: `36a66cb4212faef9d651a342baead7203238eb19d866acf9a8b2ec6ef1e76518`, source `f7caad4537e982190094e2654a064b25e7725f8a`, frozen 2026-11-10 22:01:42 UTC. Source and prebuilt frontend were copied into `/tmp/covenant-job-stack-nUaut7`; its dependency tree was independently copied and fingerprint-checked. Nothing in the sibling working tree or frozen artifact was modified.

| Artifact | SHA-256 |
| --- | --- |
| Platform source | `a15e1a3f0cedc400847abaec91afa0e8b01522522e8b1c4bc916bf804f2c913c` |
| Dependencies | `eb9728c521ebb5d31d352941e3d3e20eaa33d9d08e8c3cb4567e4ce08f05c9eb` |
| Frontend | `805a8d674c5b19890c2bbd41dc9f1035b03744fef68d3a6a0192861ce141af2f` |
| Assets | `d0d0b4186ef0ec17a504049b040b28f51e8803d8c4b37b4f4c6c5e397a68a30f` |
| E2E fixtures | `74d334de376999377c8522a6ee7d6150ee6e3d7500e9b7c0f65d0e1f584ec993` |
| Lockfile | `01d6a1eab68e5b65b55b4e3348d785f45658dfd80e51f77e3e2e854eac395727` |

The fresh run used `run-FBUoUb/stack`, loopback gateway `127.0.0.1:55038`, `@multiagency/sdk` **0.5.6**, the existing `StackControls`, fixture NEP-413 signer and the existing `invoices` grant-label workaround. Safe observations/provenance, excluding credentials and keys: `/tmp/covenant-job-stack-nUaut7/.test-artifacts/job-integration-observation.json`. The owned stack was stopped cleanly afterward.

```json
{
  "work_order": "c_c06a2aedc180",
  "terms_hash": "c06a2aedc1805867ebc85f42fc0086ee8d57860dbb438fdacb8c9a0aac14b49a",
  "builder": "maria.demo",
  "submission": "s_b596a6cbe6634cfe55ed54da",
  "revision": 2,
  "invoice": "i_b596a6cbe6634cfe55ed54da",
  "compensation_proposal": "r_53e56a003759c21d00cb481e",
  "approval": "00c61d8e-8112-4965-99fa-5491e5ed808b",
  "payout_request": "c06a2aedc1805867-p2-1",
  "payment_correlation": "efe480fc-299a-49c7-bc02-6f1cdd5ff1ec",
  "settlement": "paid",
  "tx_hash": null,
  "confirmation_source": "platform payouts/status succeeded; provider/chain simulated",
  "paid_usd": "300"
}
```

Independent simulator state recorded **one agent**, **zero provider errors**, and two payment records: the original owner-rejected `FAILED` and the revised `SUCCESS` for `300000000` atomic USDC to `maria.demo`. Only the revision settled. The stack supplies no chain transaction hash; no one invented a receipt. The earlier assertion failure and its exact limitation are recorded as [G12](platform-gaps.md).

## Evidence that remains separate

- [evidence.md](evidence.md) retains the original November 10 SDK 0.5.4 / platform `96a0bb6` local stack evidence. It is historical, not this run.
- [market-boundary.md](market-boundary.md) records fresh official Market APIs, published SDK/PR metadata, public health checks and dated deployment records. Health is not authenticated hosted acceptance.
- The stack does support withdrawal-response injection; its current unresolved recovery case is G14 above. Hosted approval/settlement, a hosted AI assessment, a real wallet flow and real payment were not tested. Browser wallet signing was incomplete at that milestone; the local follow-up is in [wallet-signing.md](wallet-signing.md). Actual wallet/hosted evidence remains absent.

Exact repeatable commands and a filming sequence are in [job-demo.md](job-demo.md); the implementation/ownership map is in [workflow-map.md](workflow-map.md).
