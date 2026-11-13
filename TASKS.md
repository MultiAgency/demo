# Tasks

Production (`desk.multiagency.ai`) runs frozen candidate `0791b0e2` as deployment `c5808392`; scoped nonfinancial acceptance passes ([deployment receipt](docs/deployment-readiness-0791b0e2.json)). Current pins and gates: [release-status.json](docs/release-status.json). Completed task sections and their dated notes: [task history](docs/archive/tasks-2026-11.md).

Work on one task at a time, with a concrete result and an appropriate check. Routine implementation choices within an authorized task do not need another approval round; changes to authority or live operations follow [RULES.md](RULES.md).

## Current task: review hardening and environment split (local, 2026-11-13)

- [x] Verify review findings; reproduce both proof defects and the anonymous demo controls.
- [x] Require a successful FAILED payment read for proof and retain observed REFUNDED status; add v2/v3 regressions.
- [x] Gate demo controls by the simulated action's access rule when sign-in is required.
- [x] Restrict production stand-in startup to a Railway-generated staging origin; document both environments.
- [x] Close review findings: inspector/preview report `counterevidence`, shared public verification result, replayed webhook signatures dropped.
- [x] Close product gaps: v2 judge deadline, paginated GitHub evidence that refuses partial lists.
- [x] Split the payout ledger and request/observation state machine out of `engine.ts`; SDK restart demo passes.
- [x] Journey fixes: builder submissions after partial settlement and before setup, request-changes flow and banner, API error codes/JSON 404s, AA status ink tokens, mobile sign-in name, skip link, labels; remove duplicate demo aliases.
- [x] Consolidate status documents; archive dated checkpoints verbatim.
- [x] Import a public Agent Market job into a v3 offer as signed `market_source`; refuse platform setup/funding until the Market job is closed.
- [x] Market-settled jobs (path A, user-approved): signed variant without a NEAR payee, assessment-only review, acceptance recorded from the Market job's `completed` status.
- [ ] Optional, per agency: a non-spending Market MCP grant to read richer job state. Needs a test account's sign-in to confirm its scopes and tools.
- [x] Duplicated staging environment (copied production variables) deleted 2026-11-13; recreate empty with keyless settings when needed.
- [x] Deploy frozen candidate `0791b0e2`, with protected snapshot and preserved-record verification.
- [x] Review and qualify the later working tree: release candidate `eac99283` reviewed, frozen and deployed 2026-11-13 ([receipt](docs/deployment-update-eac99283.json)).
- [x] Interactive wallet sign-in on `eac99283` confirmed by the owner (2026-11-13).
- [ ] Optional: create an empty staging environment and deploy the keyless stand-in (production now carries the startup guard).

## Funding recovery (deployed inert in `eac99283`; attempt resolution local)

- [x] Add representative-only read/review and durable single-attempt preparation, exact credit/fee/remainder checks, and explicit wallet review without resetting legacy records.
- [x] Add unit and offline browser regression coverage for blocked evidence, duplicate/lost replies, expiry, account switching and existing markers.
- [x] Evidence-based attempt resolution (`funded` / `not_received`), one unresolved attempt per job, and a verified, fail-closed schema rebuild (local, not deployed).
- [ ] Platform/SDK owner reviews and supplies the trusted read-only reconciliation and destination-outcome contracts. Current remote adapter stays unavailable.
- [ ] Resolve original allocation/provider readiness, then qualify the recovery path before any hosted funding.

## Open gates

- **Funding:** provider owner must investigate internal request records using the reviewed reconciliation receipt and separate gateway audit findings. Binding is unrecoverable from the inspected gateway records; provider-side recoverability remains unknown. A historical 0.01 USDC credit is reported; it does not clear address reuse, additional funding or payout readiness. Preserve markers and the zero-balance guard. See [reported findings](docs/provider-reconciliation-summary.json).
- **Ownership modes:** prove wallet and DAO workflows with simulated funds, including rejected/expired votes, unrelated actors, lost replies, restart and same-payment observation. Live budgets, fee limits, signatures and deployment stay separately authorized.
- **Hermes:** verify authenticated profile Runs connectivity and actual NEAR routing under the operational boundary.

## Backlog

Candidates, not agreed priorities. Split one into executable steps when it is selected.

- Lost job-creation replies and invitations: a durable creation identity needs a decision on who generates the invitation token (it is an authorization credential).
- Offline demos still load the wallet selector's manifest and icons from external hosts; create the wallet client lazily or bundle its assets.
- Agent-facing API: attention actions that name their route, one workflow identifier across endpoints (`report_invoice` vs `report_and_invoice`), and a non-browser authentication path.
- Market: separate task observation from payment completion; authority renewal; worker pagination beyond 100 assignments.
- 16-job ceiling per deployment (platform#46): an upstream fix or one agent per company (authorization change).
