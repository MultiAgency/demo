# One builder job

The selected payment path is Covenant → `@multiagency/sdk` → the platform's held payout. This job is not also paid through Agent Market. See [the market boundary](market-boundary.md) for the routes that would change the workflow.

The v3 job signs scope, acceptance criteria, budget, deadline, payee and explicit payment terms. The builder's report, evidence references and invoice form an immutable submission revision. An agent proposes compensation within the signed scope and invoice cap. The agency signs a separate approval; only the platform's settlement outcome counts as confirmed payment.

## Run the complete demonstration

From this repository, with Bun 1.4+ and dependencies installed:

```bash
bun run demo:job
```

The recipe uses Covenant's application code and the existing in-process `FakePlatform`. Signatures, provider behavior, balances and settlement are simulated. The rule-based proposer treats an attached evidence reference as completion; it does not fetch the reference or verify work quality. The agency's review remains necessary. No credentials, network requests or real funds are used.

The transcript includes the offer, acceptance, submission, compensation proposal, agency approval and confirmed simulated payment. Its final JSON receipt links the job and terms hash to the builder, submission, invoice, judgment, approval, payout request, platform payment correlation and simulated transaction.

Run the requested-changes and lost-response variations on the same job workflow:

```bash
DEMO_JOB_CHANGES=1 DEMO_JOB_LOST_REPLY=1 bun run demo:job
```

This version requests changes while a payout is held, signs its rejection, retains the original submission, submits a revision, and confirms one payment. Each injected lost payout reply is recovered by observing the same persisted request identity.

Inputs are configurable without changing workflow code:

```bash
DEMO_BUDGET_USD=150 DEMO_INVOICE_USD=125 bun run demo:job
```

Other inputs: `DEMO_REPORT` and `DEMO_EVIDENCE_URL` (HTTPS reference). An invoice must fit the signed budget. The demo accounts and dates are fixture values.

## Through the SDK and isolated local gateway

Use a verified immutable platform snapshot with its matching dependencies and complete prebuilt `web/dist`. Work from an isolated copy; do not start the stack in another session's checkout or modify its frozen artifact. The current recorded snapshot is `36a66cb4212faef9d651a342baead7203238eb19d866acf9a8b2ec6ef1e76518`, source `f7caad4537e982190094e2654a064b25e7725f8a`, frozen on November 10, 2026. Its required Node version is 24.22.2; `SNAPSHOT.json` and the generated run manifest record the dependency and frontend digests.

In that isolated platform copy, on Node 24.22.2:

```bash
node test/e2e/run.mjs --prebuilt-web --stack --app covenant --no-browser --owner acme.demo --payee maria.demo --builder attacker.demo
```

Wait for `Isolated stack ready: <directory>/state.json`. In this repository:

```bash
PLATFORM_STACK_DIR="$COVENANT_STACK_DIR" bun run demo:job
```

Set `COVENANT_STACK_DIR` to the actual ready directory printed by your running stack before using this advanced command. For the complete SDK process-restart proof, `bun run demo:job:restart` creates and cleans up its own isolated stack without a path variable.

This runs the same job through SDK 0.5.6 and the actual gateway, executor and held-approval code. The provider, chain, signatures, deposits and settlement remain simulated. The recipe only accepts a loopback stack URL. It uses the stack's existing local fixture credential and file controls; it creates no live credential and reaches no hosted platform.

The selected snapshot reports a successful withdrawal without a transaction hash in `paymentStatus.evidence`. The recipe confirms its authoritative SDK settlement state and prints the absent transaction evidence explicitly; it never fabricates a transaction. The stand-in variation supplies and checks its labelled simulated transaction. `DEMO_JOB_LOST_REPLY=1` is stand-in-only in this recipe. The separate `JOB_RESTART_DROP_WITHDRAW=1 bun run demo:job:restart` uses the snapshot's existing withdrawal-response control; the current result remains unresolved and fails safely, as recorded in [job-restart.md](job-restart.md).

Requested changes on this pinned gateway are currently blocked after rejection: its provider simulator omits `details.never_executed`. The corrected app requires positive SDK non-execution proof before releasing a failed payout's committed amount. Do not use `DEMO_JOB_CHANGES=1` on this snapshot expecting completion; the browser and in-process stand-in demonstrate rework with explicit proof. See G13 in [platform-gaps.md](platform-gaps.md).

Stop the local stack after the recipe:

```bash
touch "$COVENANT_STACK_DIR/stop"
```

Keep the generated manifest, transcript and simulated-provider observations with the result. A local gateway run proves integration against that named snapshot; hosted acceptance and real payment remain separate evidence.

An earlier November 11 SDK run completed rework before the cancellation-proof correction. That historical pass does not establish current gateway rework. The corrected code passes the no-revision SDK job and full process-restart check with one simulated 300 USDC payment, while the browser/stand-in passes the complete rework flow. See [the recorded job evidence](job-evidence.md).

## Browser walkthrough and filming sequence

For an automated journey through both real browser views, including rework and desktop/mobile settlement evidence, run `bun run demo:browser`. It uses isolated fixture sessions and simulated funds; [browser-demo.md](browser-demo.md) describes its evidence and cleanup. Full OS-process recovery on the SDK gateway is separately runnable with `bun run demo:job:restart`; see [job-restart.md](job-restart.md).

```bash
bun run demo
```

Open `http://localhost:3000` (or set `PORT=3001` if occupied).

1. Create a contract with the **Report and invoice** workflow. For the $300 single-deliverable recipe, remove `d2` and `d3`, keeping the CSV export. Show scope values, acceptance criteria, deadline, payee and the payment terms before creating the draft.
2. Sign as the agency representative, then open the builder's private signing link and accept the same terms. Keep both views open.
3. Complete the agency's setup checklist, then fund the contract's agent using the demo control. Funding and signatures are visibly simulated.
4. On the builder's page, enter a report (at least 10 characters), invoice `INV-001` for `300` USDC, and a `d1` HTTPS evidence reference such as `https://github.com/acme/app/pull/101` labelled “CSV export and tests”. The example is a fixture reference; no code or quality is fetched/verified. Submit; show **Submitted · awaiting proposal** and the retained record identities.
5. Refresh the agency page and choose **Propose compensation**. Show report, evidence, invoice cap and proposed amount. The payout is held; paid remains zero.
6. Optional revision: enter a reason under **Changes needed**, choose **Request changes**, then **Reject held payout for revision**. Refresh the builder page, submit a revised report with a new invoice number, and propose compensation again. Show both revisions and the original change request.
7. Approve the held payout with the agency's demo wallet. Show that the payment is processing and has not yet settled.
8. Choose **Settle approved payouts** in the demo controls. Refresh both views and show confirmed settlement, the same payment identity, and the simulated transaction.

The local demo has open fixture authentication by default; the private builder token still gates its submission route. The automated HTTP role tests enable authentication and inject named fixture sessions to test agency and builder boundaries. Neither proves hosted wallet sign-in.

## Verify the meaningful failures

```bash
bun test tests/job-workflow.test.ts
bun run typecheck
bun test
```

The dedicated suite checks acceptance and submission gates; invoice and budget bounds; immutable revisions; idempotent submission identity and duplicate invoices; requested changes with cancellation pending; stale and unauthorized approval; an uncertain payout surviving SQLite close/reopen without replacement payment; request conflicts whose foreign payment later succeeds; destination-only transaction evidence; and insufficient funding. The provider in these tests is a scripted stand-in, not a hosted platform or chain.

Historical local platform integration evidence in [evidence.md](evidence.md) remains separately dated and identifies its SDK/platform versions. This new recipe does not establish hosted acceptance or real-payment behavior. The wallet signing adapter is implemented and fixture-tested locally; an actual wallet walkthrough, live funds and deployments require separate authorization and evidence. See [wallet-signing.md](wallet-signing.md).
