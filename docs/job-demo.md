# One builder job in Paperwork

The selected payment path is Paperwork → `@multiagency/sdk` → the platform's held payout. This job is not also paid through Agent Market. See [the market boundary](market-boundary.md) for the routes that would change the workflow.

The v3 job signs scope, acceptance criteria, budget, deadline, payee and explicit payment terms. The builder's report, evidence references and invoice form an immutable submission revision. An agent proposes compensation within the signed scope and invoice cap. The agency signs a separate approval; only the platform's settlement outcome counts as confirmed payment.

## Run the complete demonstration

From this repository, with Bun 1.4+ and dependencies installed:

```bash
bun run demo:job
```

The recipe uses Paperwork's application code and the existing in-process `FakePlatform`. Signatures, provider behavior, balances and settlement are simulated. The rule-based proposer treats an attached evidence reference as completion; it does not fetch the reference or verify work quality. The agency's review remains necessary. No credentials, network requests or real funds are used.

The transcript includes the offer, acceptance, submission, compensation proposal, agency approval and confirmed simulated payment. Its final JSON receipt links the job and terms hash to the builder, submission, invoice, judgment, approval, payout request, platform payment correlation and simulated transaction.

Run the requested-changes and lost-response variations on the same job workflow:

```bash
PAPERWORK_JOB_CHANGES=1 PAPERWORK_JOB_LOST_REPLY=1 bun run demo:job
```

This version requests changes while a payout is held, signs its rejection, retains the original submission, submits a revision, and confirms one payment. Each injected lost payout reply is recovered by observing the same persisted request identity.

Inputs are configurable without changing workflow code:

```bash
PAPERWORK_BUDGET_USD=150 PAPERWORK_INVOICE_USD=125 bun run demo:job
```

Other inputs: `PAPERWORK_REPORT` and `PAPERWORK_EVIDENCE_URL` (HTTPS reference). An invoice must fit the signed budget. The demo accounts and dates are fixture values.

## Through the SDK and isolated local gateway

Use a verified immutable platform snapshot with its matching dependencies and complete prebuilt `web/dist`. Work from an isolated copy; do not start the stack in another session's checkout or modify its frozen artifact. The current recorded snapshot is `36a66cb4212faef9d651a342baead7203238eb19d866acf9a8b2ec6ef1e76518`, source `f7caad4537e982190094e2654a064b25e7725f8a`, frozen on November 10, 2026. Its required Node version is 24.22.2; `SNAPSHOT.json` and the generated run manifest record the dependency and frontend digests.

The selected platform harness must support the exact `--app multiagency-paperwork` namespace. Earlier Covenant receipts and the older snapshot pin do not establish that support for this candidate.

In that isolated platform copy, on Node 24.22.2:

```bash
node test/e2e/run.mjs --prebuilt-web --stack --app multiagency-paperwork --no-browser --owner acme.demo --payee maria.demo --builder attacker.demo
```

Wait for `Isolated stack ready: <directory>/state.json`. In this repository:

```bash
PLATFORM_STACK_DIR="$PAPERWORK_STACK_DIR" bun run demo:job
```

Set `PAPERWORK_STACK_DIR` to the actual ready directory printed by your running stack before using this advanced command. For the complete SDK process-restart proof, `bun run demo:job:restart` creates and cleans up its own isolated stack without a path variable.

This runs the same job through SDK 0.5.7 and the actual gateway, executor and held-approval code. The provider, chain, signatures, deposits and settlement remain simulated. The recipe only accepts a loopback stack URL. It uses the stack's existing local fixture credential and file controls; it creates no live credential and reaches no hosted platform.

The selected snapshot reports a successful withdrawal without a transaction hash in `paymentStatus.evidence`. The recipe confirms its authoritative SDK settlement state and prints the absent transaction evidence explicitly; it never fabricates a transaction. The stand-in variation supplies and checks its labelled simulated transaction. `PAPERWORK_JOB_LOST_REPLY=1` is stand-in-only in this recipe. The separate `PAPERWORK_RESTART_DROP_WITHDRAW=1 bun run demo:job:restart` uses the snapshot's existing withdrawal-response control; the current result remains unresolved and fails safely, as recorded in [job-restart.md](job-restart.md).

Requested changes on this pinned gateway are currently blocked after rejection: its provider simulator omits `details.never_executed`. The corrected app requires positive SDK non-execution proof before releasing a failed payout's committed amount. Do not use `PAPERWORK_JOB_CHANGES=1` on this snapshot expecting completion; the browser and in-process stand-in demonstrate rework with explicit proof. See G13 in [platform-gaps.md](platform-gaps.md).

Stop the local stack after the recipe:

```bash
touch "$PAPERWORK_STACK_DIR/stop"
```

Keep the generated manifest, transcript and simulated-provider observations with the result. A local gateway run proves integration against that named snapshot; hosted acceptance and real payment remain separate evidence.

An earlier November 11 SDK run completed rework before the cancellation-proof correction. That historical pass does not establish current gateway rework. The corrected code passes the no-revision SDK job and full process-restart check with one simulated 300 USDC payment, while the browser/stand-in passes the complete rework flow. See [the recorded job evidence](job-evidence.md).

## Browser walkthrough and filming sequence

For an automated journey through both real browser views, including rework and desktop/mobile settlement evidence, run `bun run demo:browser`. It uses isolated fixture sessions and simulated funds; [browser-demo.md](browser-demo.md) describes its evidence and cleanup. Full OS-process recovery on the SDK gateway is separately runnable with `bun run demo:job:restart`; see [job-restart.md](job-restart.md).

```bash
bun run demo
```

Open `http://localhost:3000` (or set `PORT=3001` if occupied), then use **Jobs**. Agency and builder job views check status on focus and every five seconds while visible; **Refresh status** requests an immediate status check.

1. Create a job with the **Report and invoice** workflow. For the $300 single-deliverable recipe, remove `d2` and `d3`, keeping the CSV export. Show scope values, acceptance criteria, deadline, payee and the payment terms before creating the draft.
2. Sign as the agency representative, then open the builder's private signing link and accept the same terms. Keep both views open.
3. Complete the agency's setup checklist, then fund the job's agent using the demo control. Funding and signatures are visibly simulated.
4. On the builder's page, enter a report (at least 10 characters), invoice `INV-001` for `300` USDC, and a `d1` HTTPS evidence reference such as `https://github.com/acme/app/pull/101` labelled “CSV export and tests”. The example is a fixture reference; no code or quality is fetched/verified. Submit; show **Submitted · awaiting proposal** and the retained record identities.
5. Return to the agency page and wait for the status update. The **Agent assessment** appears on its own once the report is filed: show the report, evidence, invoice cap and the proposed amount. No payout is requested yet; paid remains zero.
6. Optional revision: enter a reason under **Changes needed** and choose **Request changes**. No payout exists to reject at this point. Wait for the builder view to show the requested changes, submit a revised report with a new invoice number, and wait for its assessment.
7. Choose **Approve $300.00**. That one action files the held payout and approves it with the agency's demo wallet. Show that the payment is processing and has not yet settled.
8. Choose **Settle approved payouts** in the demo controls. Wait for both views to update and show confirmed settlement, the same payment identity, and the simulated transaction.

The local demo has open fixture authentication by default; the private builder token still gates its submission route. The automated HTTP role tests enable authentication and inject named fixture sessions to test agency and builder boundaries. Neither proves hosted wallet sign-in.

## Verify the meaningful failures

```bash
bun test tests/job-workflow.test.ts
bun run typecheck
bun test
```

The dedicated suite checks acceptance and submission gates; invoice and budget bounds; immutable revisions; idempotent submission identity and duplicate invoices; requested changes with cancellation pending; stale and unauthorized approval; an uncertain payout surviving SQLite close/reopen without replacement payment; request conflicts whose foreign payment later succeeds; destination-only transaction evidence; and insufficient funding. The provider in these tests is a scripted stand-in, not a hosted platform or chain.

Historical local platform integration evidence in [evidence.md](evidence.md) remains separately dated and identifies its SDK/platform versions. This new recipe does not establish hosted acceptance or real-payment behavior. The wallet signing adapter is implemented and fixture-tested locally; an actual wallet walkthrough, live funds and deployments require separate authorization and evidence. See [wallet-signing.md](wallet-signing.md).


> **Renamed 2026-11-11:** The app is now **MultiAgency Paperwork** (UI **Paperwork**), deployment `multiagency-paperwork`. Historical text, identifiers, commands and artifact paths above remain as recorded; they do not verify the renamed candidate. Current instructions are in the [README](../README.md).

## DAO-owned v3 jobs with the local SDK 0.5.9 candidate

The optional signed `agency_owner: {type: "dao", account_id: "<dao>"}` separates DAO ownership from the named human representative. Existing wallet terms are unchanged. The representative and builder sign the job terms; those signatures alone do not authorize DAO spending or prove membership. The DAO separately authorizes setup, `read,payout` consent ending at the job deadline, a later-expiring read-only consent for settlement observation, creation, the payout grant, policy and each held-payout decision. `owner` consent and member-wallet submission of owner signatures are not used.

The New job form exposes an optional DAO owner for Report and invoice. Paperwork displays the platform-returned proposal transactions for a member to file and vote through their DAO wallet, then offers a status check. The application does not automatically submit those transactions. Provider-verified payment terms are still compared with the immutable job before a proposal is shown. A passed approval vote remains separate from settlement.

The repository-relative SDK tarball and provenance are under `vendor/multiagency-sdk`; `gateway-pin.json` now identifies final combined commit `252cba1d1e6642a5ea9f42ea4927f982423ed8e1` and candidate `822346ac5b50313d493c951971695abbbab5cc1d5a48ca8868bc73421a609a40`. SDK 0.5.9 is published with bytes identical to this retained pin; the matching gateway remains an offline candidate, not a hosted capability claim. Node 24.22.3 is required. The old `dao-payout-freeze` launcher targets the superseded overlay and must not supply final-candidate evidence. Verify/copy the current clean snapshot first:

```sh
bun --no-env-file scripts/demo-job-restart-local.ts --preflight
```

Start the verified copy’s documented `test/e2e/stack.mjs` fixture with `--app multiagency-paperwork --dao-treasury --no-browser`, using its `offlineEnvironment()` and offline-network preload. Keep runtime artifacts under the owned copy (or give temporary runtime children access only to that copy’s dependency tree); never write runtime state into the frozen snapshot. Then set `PLATFORM_STACK_DIR` to the actual printed stack directory. Use a fresh stack for each independent fixture:

```sh
PAPERWORK_JOB_DAO=1 PAPERWORK_JOB_CHANGES=1 PAPERWORK_JOB_FIXTURE_NAME=dao-rework-check bun --no-env-file scripts/demo-job.ts
PAPERWORK_JOB_DAO=1 PAPERWORK_JOB_DAO_RESTART=1 PAPERWORK_JOB_FIXTURE_NAME=dao-restart-check bun --no-env-file scripts/demo-job.ts
PAPERWORK_JOB_FIXTURE_NAME=wallet-regression-check bun --no-env-file scripts/demo-job.ts
```

All are simulated. DAO fixture databases are retained in the printed temporary artifact directory, including on failure. Setup/consent filing messages and returned IDs, owner-action correlations/proposals and original payment IDs are durable. Unknown filing responses retry the same saved body, but the gateway assigns a fresh nonce/hash to each setup/consent filing: this does not recover the lost request or establish same-request idempotence. It may leave additional unsigned requests and consume filing quota. The app never received the lost proposal transactions, so this is not demonstrated duplicate-payout behavior. Once an ID is known, it is persisted and observed without replacement. Local deadlines do not prove non-execution. The test control casts one simulated vote per proposal and polls thereafter.

The restart recipe closes the first app runtime's database after the simulated DAO signature is available but before Paperwork observes it. A separate OS process opens that database, observes the original approval and request, confirms processing with zero paid, then settles the same simulated payment. It records both process identities and the retained job/request/owner-action IDs. The supervising first process remains alive; this is a clean runtime handoff to a second process, not a SIGKILL or provider-response-loss proof. The gateway supplies no settlement transaction hash; none is fabricated. Hosted sign-in, member wallet submission, quorum behavior and real payment remain separate gates.
