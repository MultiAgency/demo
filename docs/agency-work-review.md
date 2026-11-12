# Agency Work UI review — November 11, 2026

The app is named **Agency Work**, with **Jobs** and **New job** in navigation. New jobs retain the report/invoice default; existing Pay on merge jobs remain supported. Agency and builder views check status every five seconds while visible and on focus. An agency can discover a new submission without reloading the page. Proposal, approval, and confirmed settlement remain separate steps.

Automatic reads skip an in-flight read. A post-mutation reload can supersede an older background response. Network errors and HTTP 408/429/5xx responses retain the current view and unfinished form; authentication/access refusals clear private data. Status checks use the existing authorized GET and its existing guarded reconciliation of durable payment identities.

## Compatibility

This is a display rename. Existing signing bytes (`Covenant work order sha256:…`, recipient `covenant`), accepted terms, API routes, database/deployment/auth identifiers, package/BOS IDs, saved builder links, and pending submission keys are preserved. Two new engine regressions accept and verify v2/v3 signatures made with the fixed historical message and recipient, without dispatching a payout.

SDK **0.5.7** and the existing verified platform pin remain unchanged. Upcoming 0.5.8 is a separate upgrade requiring its own published-package and platform verification.

## Fresh verification

Tests ran from the frozen public-source copy `/private/tmp/agency-work-review-2puew8m2/demo`, based on `5b8f79c` plus these uncommitted changes. Its 129-file manifest is `/private/tmp/agency-work-review-2puew8m2/manifest.json`; source SHA-256 is `1e721c35b19b8a4ca5964e8dc3c332478c617e1992f7790f839ca21c1c2bdd37`. No runtime state or secrets were copied. Locked dependencies were installed separately in that copy: Bun 1.4.2, TypeScript 7.0.2, SDK 0.5.7. The evidence document and README link were added after code verification.

| Check | Result |
| --- | --- |
| `bun --no-env-file test` | 440 passed, zero failed, 2,516 assertions across 23 files |
| `bun --no-env-file run typecheck` | App and Railway TypeScript checks passed |
| `bun --no-env-file run demo:browser` | Report/invoice → requested changes → confirmed cancellation → revision → explicit approval → one confirmed simulated 300 USDC payment; no job-page reloads |
| Browser failure check | A simulated 503 during status polling preserved report, invoice and evidence inputs; a later successful read recovered automatically |
| `bun --no-env-file run demo:full:check` | One SDK-backed builder payment and a separate instant Agent Market hire passed in the same app; owned stack stopped normally |
| Desktop/mobile inspection | Agency Work branding, Jobs navigation, both party outcomes and horizontal overflow checks passed at 1440×1000 and 390×844 |

Logs: `/private/tmp/agency-work-review-2puew8m2/{tests,browser,full-check}.log`.

Stand-in browser receipt: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-browser-hhw0Cx/receipt.json`.

SDK launcher receipt: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-full-launch-HEmPDp/launcher-receipt.json`. Browser receipt: `jobs/covenant-browser-Q7smWv/receipt.json` under that launcher directory. Platform snapshot `36a66cb4…`, source `f7caad4`, Node 24.22.2; all source/dependency-copy guards remained enabled.

These checks use simulated wallets, signatures, provider, chain, market and funds. They establish no hosted or real-payment outcome. SDK-simulator rework remains limited by G13; G14 and the directory/worker simulator gap are unchanged. See [platform gaps](platform-gaps.md). The passing revision check uses the stand-in's positive cancellation proof.

## Reproduce

```bash
bun run typecheck
bun test
bun run demo:browser
bun run demo:full:check
```

For the existing interactive demo, reload its agency and builder tabs once to load the new UI; subsequent job status updates are automatic. Starting a fresh isolated demo remains `FULL_DEMO_PORT=3004 bun run demo:full` when that port is available. See the [manual walkthrough](full-demo.md).


> **Renamed 2026-11-11:** The app is now **MultiAgency Paperwork** (UI **Paperwork**), deployment `multiagency-paperwork`. Historical text, identifiers, commands and artifact paths above remain as recorded; they do not verify the renamed candidate. Current instructions are in the [README](../README.md). For new Paperwork runs, use `PAPERWORK_DEMO_PORT=3004 bun run demo:full`; the `FULL_DEMO_PORT` command above belongs to the historical candidate.
