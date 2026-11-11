# Full app process restart

This proof runs Covenant as two distinct operating-system processes against the independent local platform gateway through SDK 0.5.6. Both app processes use the same durable SQLite database. The platform provider, chain, signatures, deposits and settlement remain simulated; this is neither hosted acceptance nor a real payment.

The injected fault is specifically a lost **app HTTP proposal response**. A loopback proxy forwards the proposal, lets the application persist its judgment/payment identity and complete the SDK request, then suppresses the HTTP response and aborts the caller. The runner kills that app process with `SIGKILL`, starts a new one, and recovers the existing held payout by reading its retained identity. It never replaces the uncertain proposal with a new payment request.

The default mode does not inject a lost response between the gateway and provider. The pinned platform snapshot also exposes an existing `dropWithdrawResponse` file control. The optional mode below arms that control before proposing compensation; it adds provider-response loss to the app HTTP fault without introducing another simulator.

## Reproduce with one command

```bash
bun run demo:job:restart
```

The default command needs no environment variables or placeholder path. It launches `scripts/demo-job-restart-local.ts`, which finds the workspace's pinned platform snapshot `36a66cb4212faef9d651a342baead7203238eb19d866acf9a8b2ec6ef1e76518` and matching installed Node 24.22.2, verifies the source and dependencies, and copies them into a unique temporary directory. It starts the existing prebuilt offline stack, reads its actual ready `state.json` path, invokes the restart runner with that path and stops its owned stack afterward. It never rebuilds or mutates the sibling checkout or frozen artifact, installs dependencies, calls a hosted gateway or issues a live credential.

The launcher preserves public dependency bytes and internal symlinks, compares before-copy, copied and after-copy fingerprints, and sanitizes child environments. Its `launcher-receipt.json` records snapshot provenance, child results and retained job receipt paths. Logs and failed-run artifacts remain available. Only process groups created by this launcher are signalled during bounded cleanup.

To check only the snapshot copy and Node prerequisite, without starting any server or job:

```bash
bun scripts/demo-job-restart-local.ts --preflight
```

To check fresh SDK stack startup and cleanup without creating an application job:

```bash
bun scripts/demo-job-restart-local.ts --bootstrap-only
```

To add the existing provider withdrawal-response fault on its own fresh stack:

```bash
JOB_RESTART_DROP_WITHDRAW=1 bun run demo:job:restart
```

In that mode the initial platform correlation may be unknown. Submission, invoice, judgment and request IDs must remain unchanged; a correlation is accepted only when the original SDK request later supplies it. A bounded unresolved result fails with its database and IDs retained. It never creates another payment to obtain a successful receipt. Verification status for this optional mode is recorded separately from the default app-HTTP proof.

An explicitly supplied `PLATFORM_STACK_DIR` is an advanced option for an already running, fresh loopback stack. Use its real directory value; the launcher does not stop that caller-owned stack. The same application runner is `scripts/demo-job-restart.ts`. The complete default command above avoids the earlier shell error caused by copying an angle-bracket path placeholder as if it were an argument.

The application runner separately copies source, package metadata and installed dependencies into its own artifact directory, verifies that source snapshot against the checkout, and launches the app from that copy. Both app generations use a fixture-only auth secret and app-owned SQLite there. The gateway uses its existing simulated credential and fixture signer; no live credential is created or copied.

The check performs:

1. Agency offer and two-party acceptance of immutable v3 terms.
2. SDK setup, consents, policy, fixture funding and builder report/invoice submission.
3. Agent proposal through the local HTTP fault proxy; the caller loses its response.
4. App process kill and restart, with the gateway staying alive independently.
5. Read recovery of the same terms hash, submission, invoice, judgment, payout request and platform payment correlation. Retrying the original submission identity stays idempotent.
6. Explicit agency approval, a distinct processing state, then confirmed SDK settlement.
7. Independent provider observation of one original payment and one `SUCCESS`, with no provider errors.

A successful run prints its `receipt.json` path. Alongside it, `app-source-manifest.json` records each source hash, the runner hash, SDK and Bun versions, and the copied dependency fingerprint. `dependency-manifest.json` fingerprints the complete public installed dependency tree, including file contents and internal symlink targets; the before-copy, copied and after-copy fingerprints must match. `processes.json` records the two app PIDs and exit results; app logs and the fixture database remain local for diagnosis. The receipt carries no tokens or keys. As in the other gateway recipe, transaction evidence may be null even when the platform reports `succeeded`; it is never fabricated.

HTTP requests have bounded timeouts (30 seconds; five seconds for startup health). A timeout leaves the run failed with its fixture database and any retained payment identities; it never proves non-execution or triggers a new payment request. Process cleanup waits up to five seconds after `SIGTERM`, then sends `SIGKILL` only to its owned child if necessary and waits up to five more seconds. The receipt records the requested signals and awaited exit results.

The application runner stops its app processes and proxy. The default launcher then stops its own simulated gateway. An explicitly supplied stack remains caller-owned and is left running for its owner.

Preserve a failed run's database and receipt for inspection. A failed or uncertain receipt does not authorize a replacement payment in that stack; start another fresh isolated stack only for a separate test.

## Wallet-signing follow-up evidence — November 11, 2026

The updated source passed the same exact no-environment command after shared wallet signing and owner-intent durability changes. Launcher: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-restart-launch-TycRB2/launcher-receipt.json`; child receipt: `jobs/covenant-job-restart-lrqlej/receipt.json`. App source/package hash: `538ec17c4b117b8e94fa374310af010a7342f85dcc1d00fba617d90d1ec4b387`. Launcher/runner and copied dependency hashes remain the same as the table below.

Processes `51710` (killed, exit 137) and `51837` (cleanup, exit 143) used the same SQLite and retained request `6724a37d57e67ab8-p1-1`, correlation `125bd074-b9ee-4728-8db5-ef9186a45f8d`, submission/invoice and proposal. Independent stopped-simulator fields confirm exactly one `SUCCESS`, `300000000` atomic USDC to `maria.demo`, and zero provider errors; sanitized `provider-observation.json` is alongside the child receipt. Transaction hash remains null. Both wrapper-owned processes exited cleanly with result 0; no live wallet or real funds were used. This run uses fixture signatures and does not exercise the new adapter through an actual wallet.

## Earlier one-command evidence — November 11, 2026

The exact user command `bun run demo:job:restart`, with no environment variables, passed with exit 0 after the financial review fixes. Launcher artifact: `/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-restart-launch-kQij0i/launcher-receipt.json`. Its application receipt is `jobs/covenant-job-restart-By7pyc/receipt.json` under that directory.

The launcher created its own fresh pinned SDK gateway, supplied the real ready directory, ran the app HTTP response-loss/crash proof and stopped the gateway cleanly. App process `78016` returned 137 after `SIGKILL`; process `78333` resumed the same database and returned 143 after cleanup. Independent stopped-provider observations record **one withdrawal request, one `SUCCESS` of `300000000` atomic USDC to `maria.demo`, and zero provider errors**. The original request remained `6724a37d57e67ab8-p1-1`, with correlation `4f50316d-9a8b-4dd3-9ce1-135a4804e7a5`. Transaction evidence was null; settlement came from the SDK status, with provider and chain simulated.

Both the successful default run and the optional fault case below tested these source fingerprints:

| Artifact | SHA-256 |
| --- | --- |
| No-environment launcher | `d49f548868c793cbbf4db462c6f8bfc487dca1932f9667d12a5c780a143adbd8` |
| Application restart runner | `d05f84cb1a03d7af52b9075a05fd10e250434b4568cac838adf67cd86a997dfe` |
| App source/package metadata | `6db0c75b5fab1a2ca23137d2246f7fa3fe65aba27697bbea6939c0af7dad2370` |
| Copied app dependencies | `29c3057585d21ee7aa62bdaa6ae4eaba7e1dabad5a30f0bef52f6d8c281c7353` |
| Copied public platform dependency content/links | `0fb37eea64b2b16085bd0a5de96a2f42bbdf9401086605ec63af96052b99056c` |

The public platform dependency fingerprint covers 42,909 entries, including one preserved stale internal pnpm alias whose target is missing. It is recorded without dereferencing or modifying that alias. Before-copy, copied and after-copy fingerprints matched. The canonical frozen installed-tree fingerprint remains `eb9728c521ebb5d31d352941e3d3e20eaa33d9d08e8c3cb4567e4ce08f05c9eb`. Preflight and bootstrap-only checks also passed; no application job was created in those checks.

## Optional provider-response fault — unresolved within the observation window

`JOB_RESTART_DROP_WITHDRAW=1 bun run demo:job:restart` used a separate fresh gateway and the existing `dropWithdrawResponse` command in the pinned platform's `test/e2e/stack-controls.mjs`, backed by `test/e2e/provider.mjs`. Contrary to the earlier documentation, that control exists on this snapshot. No provider or simulator code was copied into Covenant or patched for the test.

This run exited **1** after the bounded 25-second post-restart observation window. Artifact: `/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-restart-launch-T5URkV/launcher-receipt.json`; retained application receipt: `jobs/covenant-job-restart-Trmr6N/receipt.json` beneath it. The original submission `s_60f1d5ee060da1183f765e70`, invoice `i_60f1d5ee060da1183f765e70`, judgment `r_0f5a80f8654eb0aa838fdaf8` and payout request `6724a37d57e67ab8-p1-1` survived the crash. Its state stayed `unknown` and its platform correlation remained null in the preserved database.

Independent provider observations show **exactly one withdrawal request and one `PENDING_APPROVAL` record** for `300000000` atomic USDC to `maria.demo`, correlation `9eb334ca-be31-4502-b55c-0885d0cdbb19`, with zero provider errors. No agency approval or `SUCCESS` occurred. The application did not bind that provider record to the original request within the observation window. This is a concrete unresolved case, not proof of a permanent platform defect; a supported same-identity binding or operator resolution is still needed. Matching only recipient and amount is insufficient evidence to replace or resolve the uncertain request.

The original IDs/database were retained, no replacement request was made, and both app processes and the wrapper-owned SDK stack stopped. The failure is reported as a failed recovery check, not as confirmed settlement. The default app-HTTP response-loss mode passed separately as recorded above.

## Earlier reviewed runner evidence — November 11, 2026

The reviewed runner passed with exit 0 on fresh isolated gateway `run-j5d1ln/stack`, using Bun 1.4.2, SDK 0.5.6 and platform Node 24.22.2. Its independent provider assertion matched **one `SUCCESS`, recipient `maria.demo`, amount `300000000` atomic USDC**, the signed scope total, and the original correlation. It recorded zero provider errors. The lost app response and process crash retained submission `s_60f1d5ee060da1183f765e70`, invoice `i_60f1d5ee060da1183f765e70`, judgment `r_0f5a80f8654eb0aa838fdaf8`, request `6724a37d57e67ab8-p1-1` and correlation `33c755bd-edf8-47eb-b275-b0e90634e819`.

Final artifacts are in `/tmp/covenant-job-restart-NKz2oP/`: `receipt.json`, `transcript.txt`, `app-source-manifest.json`, `dependency-manifest.json`, `processes.json` and `provider-observation.json`. The receipt includes the provider recipient/amount, signed atomic total and all platform snapshot digests. Exact fingerprints:

| Artifact | SHA-256 |
| --- | --- |
| App source and package metadata | `94eae19dd6d67ecbb63fd0e3674d71975006d20e3b0180697e512aeffe2c8a24` |
| Tested runner | `9d6a27a74be77d3ed5d3911cdb1acfeb4eba1e6c9f1126ae3f198f1af128b2e4` |
| Copied public dependencies, 7,026 entries | `29c3057585d21ee7aa62bdaa6ae4eaba7e1dabad5a30f0bef52f6d8c281c7353` |

Process `27563` was killed with `SIGKILL` and returned 137; process `27722` resumed the same database and later returned 143 after `SIGTERM`. The bounded cleanup completed without needing its fallback kill. The owned app processes, proxy and gateway were stopped. A dependency-copy preflight had previously rejected normalized symlinks into the source tree before any app process, agent or job was created; the tested copy preserves relative symlinks verbatim and matches the original dependency fingerprint. The earlier runner's hash below is historical evidence only.

## Earlier process-restart evidence — November 11, 2026

An earlier runner revision passed with exit 0 on Bun 1.4.2 / SDK 0.5.6 against the copied platform snapshot on Node 24.22.2. The isolated gateway run was `run-DCY4ch/stack`. App process `32363` was killed with `SIGKILL` (awaited exit result 137); process `32888` resumed the same database and was stopped with `SIGTERM` after the check (awaited exit result 143).

Safe result artifacts are under `/tmp/covenant-job-restart-zegADG/`: `receipt.json`, `transcript.txt`, `app-source-manifest.json`, `processes.json` and `provider-observation.json`. The source manifest SHA-256 is `2b553f530123d4db38909e722fb7215f443c0327137812310835972dfe989482`; the tested runner SHA-256 is `19ffa8109056441d804cc86f0a160b1c5a7eba553d45f0271af42982c745939c`. The receipt also records the platform snapshot, source, frontend, dependency and lockfile digests.

The same submission `s_60f1d5ee060da1183f765e70`, invoice `i_60f1d5ee060da1183f765e70`, judgment `r_0f5a80f8654eb0aa838fdaf8`, payout request `6724a37d57e67ab8-p1-1` and payment correlation `623872db-f10d-48a0-a893-5325f37d2773` were retained across the crash. The gateway independently recorded exactly one payment, one successful simulated 300 USDC settlement and zero provider errors. Transaction evidence remained null, as in the earlier local-gateway run. The owned app processes, proxy and local stack were stopped afterward.

That earlier run extended the SQLite connection-reopen check to a true application process restart. Successful recovery after gateway/provider response loss remains unestablished; the current optional failure case above tests that boundary and retains the unresolved result. None of these runs establishes hosted authentication, a hosted AI assessment, real-wallet behavior or real payment.

## Independent developer reproduction

The user independently reported a passing `bun run demo:browser` run and supplied its artifact `covenant-browser-N2Lmuu`. The retained receipt at `/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-browser-N2Lmuu/receipt.json` records the simulated job `c_5048d896ad77`, $300 paid and one successful transfer. This is a separate developer reproduction of the earlier browser command, reported by the user and corroborated by its local receipt; it is not hosted authentication, real-wallet or real-payment evidence. No external actor was contacted.
