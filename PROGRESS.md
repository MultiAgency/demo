# Progress

Updated **2026-11-11** after the isolated SDK collector proof. The local milestone covers both Report and invoice (v3) and Pay on merge (v2).

## Latest checks

Bun **1.4.2**, TypeScript **7.0.2**, SDK **0.5.7**; base HEAD `77d7416171708dae00c4d8c36ecf459c4179b1b7` plus existing uncommitted Desk/Hermes/recovery work.

- `bun --no-env-file run typecheck` passed.
- `bun --no-env-file test` passed **1,242 tests**, 8,129 assertions across 52 files. Log: `/tmp/paperwork-recovery-sdk-final-tests.log`.
- Focused SDK-reader/CLI/preview checks passed **203 tests**, 816 assertions. Canonical opaque credentials and header-injection refusal are covered.
- The opt-in isolated SDK run passed original-ID process recovery, one simulated settlement and all collector reads, with unchanged source/snapshot bytes and no additional provider activity. All owned processes stopped. [Receipt and exact command](docs/recovery-acceptance.md#sdk-collector-integration-checkpoint). This establishes local SDK integration, not historical repair or hosted acceptance.

Original failures were reproduced before correction. Refund-bearing success claims now stay visible but are excluded from the matched status-report subtotal and cannot resolve related attempts. Valid `failed/REFUNDED`, absent provider status and explicit unknown outcomes remain unresolved; normal successful transaction evidence still counts. Every preview retains `clearance: "none"`.

Seven independent synthetic examples: `/tmp/paperwork-recovery-preview-corrected-examples.json`. Earlier receipts remain in [dated recovery evidence](docs/recovery-acceptance.md#dated-recovery-evidence), [Hermes validation](docs/hermes-review.md#validation) and the historical [documentation audit](docs/documentation-audit.json); they identify their recorded source states.

## Implemented

- Both signed job workflows, scope/invoice accounting, held payouts and explicit agency approval.
- Desk, Assigned to me, public openings/onboarding and the separate Agent Market integration.
- Durable submission/payment/owner-action identities, account-scoped browser resources and wallet signing.
- Both-version failed-payment proof guards, retained refund evidence and unsafe-history startup refusal before migration.
- Standalone snapshot inspection, bounded one-job SDK collection and advisory previews. [Recovery command and limits](docs/recovery-acceptance.md).
- Optional Hermes review drafting with offline authorization, citation, streaming/cancellation and browser checks. [Hermes implementation and hosted status](docs/hermes-review.md).

## Known gaps

| Area | Current limitation |
| --- | --- |
| Historical recovery | No audited importer or supervised resumption. Original provenance and full signed terms/signatures remain unverified by the preview. Earlier refund observations never stored cannot be reconstructed locally. Unsafe history can block the shared database. |
| Privacy/Verify | V2 full-job reads remain public. Verify/signing routes expose excess identity/financial/consent metadata; anonymous v3 Verify also depends on a protected job read. Builder-safe/owner-only projections and the incorrect funded-total-cap wording remain to fix. |
| Acceptance | Dedicated v2 browser, full-scope SDK and independent restart branches are missing. Recorded G13/G14 safe halts do not demonstrate continuation; later candidates need fresh checks. [Acceptance matrix](docs/recovery-acceptance.md#acceptance-matrix). |
| V2 assessment | Cloud judging has no explicit timeout; GitHub evidence reads only the first 50 results per repository. |
| Hermes | Offline drafting works; the hosted NEAR request/Runs connection, effective isolation and requested hosted-version update remain unverified. Saved profile settings do not establish these outcomes. |
| Market | Paid hires stop task observation; authority renewal is missing. Worker handles one agency, polls the latest 100 assignments without pagination, and has recorded simulator directory/worker gaps. |
| Invitations | Lost creation replies or unavailable browser storage can strand the original link; creation has no durable client request identity. |
| Discovery/UI | Listing-specific application-to-offer linkage and native internal-listing publication are absent. Some forms and directory/config/deposit reads have incomplete pending/error/supersession handling. |

Evidence links are supplied references, not fetched or quality-verified artifacts. Requested changes apply only while proposals remain wholly unapproved/unpaid. [State-machine audit](docs/implicit-state-machines.md), [architecture](ARCHITECTURE.md) and [recorded platform gaps](docs/platform-gaps.md) contain the supporting detail.

## Next

Implement the [restoration-only correction contract](docs/recovery-acceptance.md#first-correction-contract-restore-one-commitment) against disposable fixtures. Restore one unproven `failed/reowe` amount to disputed commitment, with atomic audit, interruption/idempotency and refusal tests. Full verification and whole-database resumption remain separate; this case grants no budget release or startup clearance. [TASKS.md](TASKS.md) tracks the steps.

The approved private-job/minimal-public-verification contract follows payment/recovery work. Existing manual demos remain untouched under the user's local run/freeze confirmation. Production deployments/restarts remain paused; local checks grant no live-operation authority.
