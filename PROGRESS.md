# Progress

Updated **2026-11-11** after the in-memory restoration checks. The local milestone covers both Report and invoice (v3) and Pay on merge (v2).

## Latest checks

Bun **1.4.2**, TypeScript **7.0.2**, SDK **0.5.7**; base HEAD `b225e36` plus the uncommitted restoration source/tests and documentation updates. A concurrent Hermes documentation edit was preserved.

- `bun --no-env-file run typecheck` passed.
- `bun --no-env-file test` passed **1,289 tests**, 8,477 assertions across 53 files. Log: `/tmp/paperwork-restoration-conflict-final-tests.log`.
- The **47 restoration cases** cover both versions, exact audited replay, signatures/content/allocations, refusal without source mutation, schema/capacity boundaries and original-ID fixture reopening. Retained foreign-request records refuse even when their conflict code is missing; a post-update SQL failure returns no partial snapshot. [Contract and limits](docs/recovery-acceptance.md#first-correction-contract-restore-one-commitment).
- SDK-stack/browser/hosted runs were not repeated for this offline prototype. The prior isolated SDK collector proof retains its own [receipt and source provenance](docs/recovery-acceptance.md#sdk-collector-integration-checkpoint).

The prototype restores only one original `failed/reowe` amount to disputed commitment, atomically closing its judgment and v3 submission with an audit/event. It returns separate private bytes and leaves the source unchanged. New observed transfer/refund evidence refuses this case; stored evidence remains intact. Every receipt retains `clearance: "none"`.

Commands, source digests and limits are in the [restoration checkpoint](docs/recovery-acceptance.md#in-memory-restoration-checkpoint) and [retained-conflict correction](docs/recovery-acceptance.md#retained-conflict-guard-correction). Earlier receipts remain in [dated recovery evidence](docs/recovery-acceptance.md#dated-recovery-evidence), [Hermes validation](docs/hermes-review.md#validation) and the historical [documentation audit](docs/documentation-audit.json); they identify their recorded source states.

## Implemented

- Both signed job workflows, scope/invoice accounting, held payouts and explicit agency approval.
- Desk, Assigned to me, public openings/onboarding and the separate Agent Market integration.
- Durable submission/payment/owner-action identities, account-scoped browser resources and wallet signing.
- Both-version failed-payment proof guards, retained refund evidence and unsafe-history startup refusal before migration.
- Standalone snapshot inspection, bounded one-job SDK collection, advisory previews and audited in-memory commitment restoration. [Recovery commands and limits](docs/recovery-acceptance.md).
- Optional Hermes review drafting with offline authorization, citation, streaming/cancellation and browser checks. [Hermes implementation and hosted status](docs/hermes-review.md).

## Known gaps

| Area | Current limitation |
| --- | --- |
| Historical recovery | No operational importer, filesystem/process durability proof or supervised resumption. Restoration verifies local signed terms and content; historical key authorization and authoritative provider provenance remain unverified. Earlier refund observations never stored cannot be reconstructed locally. Unsafe history can block the shared database. |
| Privacy/Verify | V2 full-job reads remain public. Verify/signing routes expose excess identity/financial/consent metadata; anonymous v3 Verify also depends on a protected job read. Builder-safe/owner-only projections and the incorrect funded-total-cap wording remain to fix. |
| Acceptance | Dedicated v2 browser, full-scope SDK and independent restart branches are missing. Recorded G13/G14 safe halts do not demonstrate continuation; later candidates need fresh checks. [Acceptance matrix](docs/recovery-acceptance.md#acceptance-matrix). |
| V2 assessment | Cloud judging has no explicit timeout; GitHub evidence reads only the first 50 results per repository. |
| Hermes | Offline drafting works; the hosted NEAR request/Runs connection, effective isolation and requested hosted-version update remain unverified. Saved profile settings do not establish these outcomes. |
| Market | Paid hires stop task observation; authority renewal is missing. Worker handles one agency, polls the latest 100 assignments without pagination, and has recorded simulator directory/worker gaps. |
| Invitations | Lost creation replies or unavailable browser storage can strand the original link; creation has no durable client request identity. |
| Discovery/UI | Listing-specific application-to-offer linkage and native internal-listing publication are absent. Some forms and directory/config/deposit reads have incomplete pending/error/supersession handling. |

Evidence links are supplied references, not fetched or quality-verified artifacts. Requested changes apply only while proposals remain wholly unapproved/unpaid. [State-machine audit](docs/implicit-state-machines.md), [architecture](ARCHITECTURE.md) and [recorded platform gaps](docs/platform-gaps.md) contain the supporting detail.

## Next

Define the operational persistence/handoff procedure for the [restoration prototype](docs/recovery-acceptance.md#first-correction-contract-restore-one-commitment), then verify it on disposable copies through process interruption and lost results. Full verification and whole-database resumption remain separate; this case grants no budget release or startup clearance. [TASKS.md](TASKS.md) tracks the steps.

The approved private-job/minimal-public-verification contract follows payment/recovery work. Existing manual demos remain untouched under the user's local run/freeze confirmation. Production deployments/restarts remain paused; local checks grant no live-operation authority.
