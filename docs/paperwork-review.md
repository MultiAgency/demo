# MultiAgency Paperwork — renamed 2026-11-11

The full name is **MultiAgency Paperwork**, the UI name is **Paperwork**, and one piece of work remains a **job**. The repository remains `MultiAgency/demo`.

| Identity | Current value |
| --- | --- |
| Deployment / stack `--app` | `multiagency-paperwork` |
| Domain target | `paperwork.multiagency.ai` |
| New terms message / recipient | `Paperwork terms sha256:<hash>` / `multiagency-paperwork` |
| Default database | `data/paperwork.sqlite`; mounted deployment `/data/paperwork.sqlite` |
| App-specific environment / browser keys | `PAPERWORK_*` / `paperwork.*` |
| Railway project | `paperwork` |
| Package / BOS name; BOS title | `multiagency-paperwork`; `Paperwork` |
| Engine | `Engine` / `rt.engine` |

Standard platform, provider and runtime settings such as `PLATFORM_DEPLOYMENT`, `PLATFORM_STACK_DIR`, `DB_PATH` and `PORT` retain their names. Current demo controls use `PAPERWORK_DEMO_PORT`, `PAPERWORK_DEMO_ARTIFACTS`, `PAPERWORK_RESTART_*`, `PAPERWORK_JOB_*` and `PAPERWORK_ASSESSMENT_TIMEOUT_MS`.

## Existing records

Dated evidence keeps its original text, identifiers and paths, with a dated rename note. Old receipts do not establish a Paperwork run.

New jobs pin the Paperwork signing recipient. An additive SQLite migration pins existing v2/v3 rows to `covenant`, preserving accepted terms/hash, old signed bytes and complete or partial signatures. The remaining party to an old draft signs that original domain; new jobs refuse old-domain signatures. No payment/request/correlation ID is renamed.

An empty database binds to its deployment; reopening it under another deployment is refused. Historical unbound jobs/agencies cannot be adopted into `multiagency-paperwork`. Preserve their database and recover using the original `DB_PATH`, `PLATFORM_DEPLOYMENT` and credential. The default filename change does not move data or authorize another payment. New browser writes use `paperwork.*`; legacy links and pending submissions remain readable without replacing the saved body or client request ID.

## Fresh verification

SDK **0.5.7** stays pinned. Integration used isolated platform main **`82d5caca90532b63f5e96b891fbfd48575629dd9`**, whose source declares the next package version 0.5.8. This is source integration, not evidence of npm publication or hosted deployment. Toolchain: Bun 1.4.2, TypeScript 7.0.2, platform Node 24.22.2.

| Check | Result |
| --- | --- |
| `bun run typecheck` | App and Railway configuration passed |
| `bun test` | **446 passed**, zero failed; 2,555 assertions, 24 files |
| `bun run demo:e2e` | Passed; approved stand-in payments total 1,000 USDC to the agreed payee |
| `bun run demo:stack` | Passed on fresh `--app multiagency-paperwork`: 750 USDC confirmed paid, 250 disputed/committed pending non-execution proof; nothing paid to the attacker |
| `bun run demo:market` | Every check passed on a fresh `--app multiagency-paperwork --market --dao-treasury --on-chain-policy-edits` stack, including wallet and DAO hire, freeze/unfreeze and approval boundaries |
| `bun run demo:browser` | Paperwork UI passed at desktop/mobile sizes, with revision, automatic status updates, simulated 503 draft preservation and one 300 USDC payment |
| `bun run demo:job:restart` | Passed on a third fresh main stack: lost app response, process kill, same durable submission/invoice/proposal/request/correlation, explicit approval and one 300 USDC simulated payment |

All three owned platform stacks stopped cleanly. Wallets, signatures, provider, chain, market and funds were simulated. The browser revision uses the stand-in's positive cancellation proof. The SDK disputed branch preserves the unresolved rejection amount and does not claim full settlement. Restart loses the **app HTTP response**, not a gateway/provider response. Hosted operator setup, credentials, Railway/DNS changes and real payments were not performed.

The restart check initially stopped before starting a job because standalone E2E stacks lack release `SNAPSHOT.json`. The runner now records the official E2E manifest with an explicitly null release snapshot in that case. It does not manufacture release provenance or weaken the owned launcher's snapshot guards. The corrected retry used the demonstrably unused stack and passed.

## Provenance and evidence

The first 131-file public-source freeze is `/private/tmp/paperwork-review-26m3yn4q/demo`, SHA-256 `8f380f29998288f316c3ea3dafd96d6131ee538cb1cd9d46761f615c2ef98d29`. Tests, typecheck, E2E, stack, market and browser ran there; logs are beside it in `tests.log`, `e2e.log`, `stack.log`, `market.log` and `browser.log`.

The final freeze `/private/tmp/paperwork-review-final-_gx9plrz/demo`, SHA-256 `7b26f9d021febb32d20b92dca13284a6ad84b4669ee25484a86e7cceea9be4a7`, differs only in the restart runner's optional snapshot-provenance handling. Its manifest records that single difference. Final typecheck and the corrected restart proof passed there. This evidence document and the README link were added afterward.

Platform provenance: `/private/tmp/paperwork-platform-main-_vh5fj24/provenance.json`. Copied public dependencies matched before/copy/after: SHA-256 `0fb37eea64b2b16085bd0a5de96a2f42bbdf9401086605ec63af96052b99056c`, 42,909 entries. Gateway runs are `run-kWHgrs` (job), `run-giZXHq` (market) and `run-Xtz21d` (restart), under its platform `.test-artifacts/e2e/` directory.

- Browser receipt: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/paperwork-browser-98cJSL/receipt.json`.
- Restart receipt: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/paperwork-restart-launch-qcSfn1/jobs/paperwork-job-restart-nArfLg/receipt.json`.

## Reproduce

Run `bun install --frozen-lockfile`, `bun run typecheck`, `bun test` and `bun run demo:e2e`. Start fresh simulated platform stacks with `--app multiagency-paperwork`, then use the actual printed directory as `PLATFORM_STACK_DIR` for `bun run demo:stack` and `bun run demo:market`. Add `--market --dao-treasury --on-chain-policy-edits` for the recorded market branch. Stop each owned stack through its `stop` file afterward. See [README](../README.md).

For a fresh combined UI without disturbing the existing port-3004 demo:

```bash
PAPERWORK_DEMO_PORT=3005 bun run demo:full
```

The default launcher starts its own fresh `multiagency-paperwork` stack using the unchanged verified snapshot guards. That older platform pin and the fresh-main results above are separate evidence. Follow the [manual walkthrough](full-demo.md).
