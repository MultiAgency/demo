# Progress

Updated **2026-11-11** after the whole-database recovery rehearsal. The local milestone covers both Report and invoice (v3) and Pay on merge (v2).

## Latest checks

Bun **1.4.2**, TypeScript **7.0.2**, SDK **0.5.7**, isolated platform Node **v24.22.2**; base HEAD `974c88b` plus uncommitted export/rehearsal source, tests and docs. Separate Hermes/review-key setup work was preserved and is outside this checkpoint.

- `bun --no-env-file run typecheck` passed.
- `bun --no-env-file test` passed **1,351 tests**, 9,100 assertions across 57 files. Log: `/tmp/paperwork-recovery-handoff-final-tests.log`.
- Focused compatibility/handoff/restoration/export checks passed **109 cases**, 971 assertions. New stand-in cases cover both-version full/partial/unknown handoff; compatibility tests aggregate all known gates, unrelated/orphaned releases and Market-only binding.
- The isolated SDK rehearsal passed: mixed blockers **3 → 2** with actual unchanged startup refusal; clean blockers **1 → 0**, then two no-timer app processes retained a 300 USDC dispute and settled the original approved payment once. All nine resumed SDK attempts were reads; sources/bundles stayed unchanged and passed reuse. [Command and receipt](docs/recovery-acceptance.md#whole-database-rehearsal-checkpoint).

The historical release in this rehearsal is seeded only in closed disposable copies; the actual SDK payment remains processing until explicit simulated settlement. An unchanged mixed-history copy stays blocked, while a separate clean working copy is restarted. No real historical ledger, credential or money is used. Every recovery receipt retains `clearance: "none"`.

Commands, source digests, process exits and limits are in the [whole-database rehearsal checkpoint](docs/recovery-acceptance.md#whole-database-rehearsal-checkpoint). Earlier receipts remain in [dated recovery evidence](docs/recovery-acceptance.md#dated-recovery-evidence), [Hermes validation](docs/hermes-review.md#validation) and the historical [documentation audit](docs/documentation-audit.json); they identify their recorded source states.

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
| Privacy/Verify | V2 full-job reads remain public. Verify/signing routes expose excess identity/financial/consent metadata; anonymous v3 Verify also depends on a protected job read. Builder-safe/owner-only projections and the incorrect funded-total-cap wording remain to fix. |
| Acceptance | Dedicated v2 browser, full-scope SDK and independent restart branches are missing. Recorded G13/G14 safe halts do not demonstrate continuation; later candidates need fresh checks. [Acceptance matrix](docs/recovery-acceptance.md#acceptance-matrix). |
| V2 assessment | Cloud judging has no explicit timeout; GitHub evidence reads only the first 50 results per repository. |
| Hermes | Offline drafting works; the hosted NEAR request/Runs connection, effective isolation and requested hosted-version update remain unverified. Saved profile settings do not establish these outcomes. |
| Market | Paid hires stop task observation; authority renewal is missing. Worker handles one agency, polls the latest 100 assignments without pagination, and has recorded simulator directory/worker gaps. |
| Invitations | Lost creation replies or unavailable browser storage can strand the original link; creation has no durable client request identity. |
| Discovery/UI | Listing-specific application-to-offer linkage and native internal-listing publication are absent. Some forms and directory/config/deposit reads have incomplete pending/error/supersession handling. |

Evidence links are supplied references, not fetched or quality-verified artifacts. Requested changes apply only while proposals remain wholly unapproved/unpaid. [State-machine audit](docs/implicit-state-machines.md), [architecture](ARCHITECTURE.md) and [recorded platform gaps](docs/platform-gaps.md) contain the supporting detail.

## Next

Implement the approved private-job/minimal-public-verification contract, including existing/new v2 jobs, party-safe reads and own-role signing requests. Authorize protected reads before platform work; fix public Verify and the funded-total-cap claim. Remaining SDK/browser acceptance branches stay explicit in [TASKS.md](TASKS.md).

Existing manual demos remain untouched under the user's local run/freeze confirmation. Production deployments/restarts remain paused; local checks grant no live-operation authority.
