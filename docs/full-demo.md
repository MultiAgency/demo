# Paperwork combined local demo

From any terminal:

```bash
bun run --cwd /Users/jlwaugh/agencies/dao/demo demo:full
```

The command verifies and copies the pinned platform snapshot, starts its existing `--market` simulator, and serves this checkout's combined app bound to **127.0.0.1**. It prints its source directory and **http://127.0.0.1:3002/#/new**. Leave the command running while testing. `PAPERWORK_DEMO_PORT=3003` selects another port if 3002 is occupied. It does not stop other checkouts or reuse their databases.

The selected platform harness must support the exact `--app multiagency-paperwork` namespace. Earlier Covenant receipts and the older snapshot pin do not establish that support for this candidate.

All accounts, wallet signatures, funding, provider/chain activity and market delivery/settlement are simulated. The platform gateway and the app's SDK 0.5.7 integration are real code. No live worker token, wallet signature, hosted service or funds are needed. Dependencies and the verified workspace snapshot/Node 24.22.2 must already be installed; the command installs nothing.

## Builder job

Use **Jobs** for builder work and **Agent market** for separate listed-agent services. Agency and builder job views check status on focus and every five seconds while visible. You can also select **Refresh status**; proposals and agency decisions remain explicit actions.

1. Under **Work and payment terms**, **Report and invoice** is already selected. Keep the default parties/dates. Remove `d2` and `d3`, leaving the $300 `d1` CSV export, and select **Create draft**.
2. Sign as `acme.demo`. Open **Builder submission** in a second tab and sign as `maria.demo`; both accept the same terms hash.
3. In the agency tab, finish the setup checklist and fund the agent with the demo control.
4. In the builder tab, submit a report of at least 10 characters, invoice `INV-001` for `300` USDC, and a `d1` HTTPS evidence reference such as `https://github.com/acme/app/pull/101`. The reference is a fixture, not fetched quality evidence.
5. Return to the agency tab, wait for the status update and select **Propose compensation**. Review the report/invoice and held payout. Paid remains zero. Select **Approve $300.00**, observe processing, then **Settle approved payouts**.
6. Wait for the status update in each tab. Both show the same request identity and confirmed simulated 300 USDC settlement. The pinned SDK simulator supplies no transaction hash; it stays explicitly absent.

This pinned simulator omits positive rejection non-execution proof (G13), so **requested changes after a held proposal remain conservatively blocked on this SDK demo**. The complete revision/cancellation browser proof remains `bun run demo:browser` on the existing in-process stand-in. Do not weaken the proof or recreate a payment to finish rework.

If the platform reports failure without sufficient evidence, the agency can instead **Close review as disputed**. Both parties see the dispute; the original amount remains committed and unpaid, and no replacement is authorized. Later evidence is followed under the same payment identity. Closing review does not claim settlement or release the monetary hold.

## Separate Agent Market service

1. In the same app, select **Agent market**. Create a wallet agency with a name and the prefilled `acme.demo` owner.
2. Complete its separate market-agent setup, signing the demo messages and selecting **Register (demo)** when asked. Then **Fund $10 (demo)**.
3. Enter agent handle `writer` and a brief for a separate service, then **Ask for a quote**. The frozen simulator's directory is unavailable, so enter the handle directly.
4. Inspect the 0.5 USDC quote and the x402 lifecycle notice. Select **Approve and hire for 0.5 USDC**. Use **Check the outcome** if still pending; delivery may already have settled it.
5. Confirm **Paid** and the fixture deliverable, `the article`, under the original market job ID. The builder job keeps its own single payout and identity.

These are distinct obligations and payment paths: builder work requires post-submission agency review and the platform's held withdrawal; the instant market hire is authorized before work and settles on delivery. Combining their navigation does not make an instant hire another payout path for the builder's job.

The frozen snapshot has no directory or full market-worker/webhook loop (M3). Worker ownership, authorization and delivery-failure behavior are checked with fixtures; no end-to-end worker earnings claim is made. DAO authority/provider-window limits, G13 and dropped provider-response recovery (G14) remain separate platform cases in [platform-gaps.md](platform-gaps.md).

## Checks and shutdown

```bash
bun run demo:full:check
bun test
bun run typecheck
```

The combined check uses actual browser controls for one builder payment and a separate listed-agent hire on one SDK-backed app, with desktop/mobile captures and a receipt. Its own app, browsers and gateway stop afterward. The standalone restart proof remains `bun run demo:job:restart`.

For the default interactive command, **Ctrl+C** stops its owned app and gateway. Advanced use with an explicitly supplied `PLATFORM_STACK_DIR` leaves that caller-owned gateway running. Each new launch creates fresh isolated state; retained artifacts/database are diagnostic evidence, not permission to replace an uncertain payment. Existing servers from `demo-market` remain untouched. Production deployment remains paused.


> **Renamed 2026-11-11:** The app is now **MultiAgency Paperwork** (UI **Paperwork**), deployment `multiagency-paperwork`. Historical text, identifiers, commands and artifact paths above remain as recorded; they do not verify the renamed candidate. Current instructions are in the [README](../README.md).
