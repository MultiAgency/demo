# Progress

**Production** (`desk.multiagency.ai`, Railway environment `production`) runs reviewed release candidate `eac99283` (deployed 2026-11-13 after a protected snapshot and a passing rollback gate); deployed source, the signed job's unchanged hash, green verification and scoped read-only acceptance pass ([receipt](docs/deployment-update-eac99283.json)). Interactive wallet sign-in on this release was confirmed by the owner. Funding and payment remain paused pending provider reconciliation. **Staging:** the duplicated `staging` environment, which held copied production variables, was deleted on 2026-11-13; recreate it empty with keyless settings when needed ([environments](docs/deploy.md#environments)). Exact pins, receipts and gates: [release-status.json](docs/release-status.json). Dated checkpoints: [progress archive](docs/archive/progress-2026-11.md).

## Working-tree changes since 33c4899 (2026-11-13)

This section includes the deployed snapshot and later local edits. Only the exact `0791b0e2` manifest is confirmed deployed; do not infer that every current working-tree change is live.

**Money path**
- **Failed-payment proof.** Proof needs a successful FAILED payment read; the first transition write can only revoke it; an observed REFUNDED status is retained in the new nullable `payout_attempts.counterevidence` column (additive startup migration). Two reproduced replacement-payout paths are closed. Transient processing/unknown regressions still only revoke proof, as the restoration tests require. Older code ignores the column, so rollback across it needs compatibility review.
- **Structure.** `src/server/ledger.ts` owns payout, judgment and event records; `src/server/payout-follower.ts` owns the request/observation state machine and proof rules; `engine.ts` keeps workflows, judgments and views (1,607 → 1,277 lines). Behaviour and public API are unchanged.
- **Assessment inputs.** The v2 judge uses the v3 assessment deadline. GitHub evidence reads every search page and refuses incomplete or over-1,000 results instead of judging a partial list.

**Access and abuse**
- With sign-in required, `/api/sim/*` and `/api/market/sim/*` follow the access rule of the action they simulate.
- `NODE_ENV=production` with `PLATFORM=fake` starts only on an https `*.up.railway.app` origin.
- Anonymous public verification shares one result per job for 30 seconds, with concurrent callers coalesced.
- A webhook signature already accepted is dropped under a new delivery id or relabelled event (delivery and event headers are unsigned).
- The ledger inspector and correction preview report `counterevidence`.

**Market-sourced jobs**
- A v3 offer can import a public Agent Market job and sign it as `market_source`. Because a Market award is already funded on the Market, platform setup and funding are refused until that job reads `closed`; unreadable sources refuse, and an unreadable source is refused at creation. A job already awarded on the Market can instead settle there (path A): a separate signed terms variant with no NEAR payee, which the type system and one ledger guard keep out of all platform setup, funding and payout code. The agent assesses without proposing an amount, and acceptance is recorded only when the Market job reads `completed`; the Market's payout is not observed. See [Market-sourced builder jobs](docs/market-boundary.md#market-sourced-builder-jobs--2026-11-13).

**Experience**
- Builders can submit for unpaid scope after a partial settlement; the invoice defaults to and is capped by unpaid scope. Submission waits, with an explanation, until the agency's setup is complete, frozen or ended.
- Requesting changes sits beside Approve/Reject and names the follow-up rejection; the banner asks for that signature instead of an approval.
- API errors carry a `code`; malformed JSON is 400; unknown API routes are JSON 404s.
- Success and danger text use AA ink tokens; the phone sign-in button keeps its accessible name; a skip link reaches the main content; the builder link is labelled as an invitation until accepted; the revision form shows the requested changes. Duplicate `demo:jobs` aliases are removed. New jobs start blank outside the keyless demo; the Security test tab shows only with demo controls; an unsubmitted job names the builder's report-and-invoice step.

**Core flow (agency offers → builder accepts → report and invoice → approval → payment)**
- **Offer.** New job starts blank outside the keyless demo. Report-and-invoice terms may sign a title and description, and the GitHub identity and repositories are optional there; Pay on merge still requires them. Absent fields leave earlier hashes unchanged (pinned by test).
- **One approval per invoice.** New report-and-invoice jobs sign `payment_terms.per_payment: "scope_total"`: the policy's per-payment cap is the scope total, so one held payout covers an invoice. Jobs signed without it keep the largest-deliverable cap and its payout sequence.
- **Review window.** New jobs sign `payment_terms.review_days` (form default 14, 1–60). Reports are due by the end date; proposals, payout requests and Paperwork's payout consent run to the end of the window. Jobs signed without it end on the end date as before.
- **Acceptance.** With sign-in required, the named builder's session and wallet signature accept the offer without the private invitation token; the keyless demo still requires the token. Assigned to me sends an unsigned builder to review and sign.
- **Assessment before any request.** Filing a report over HTTP starts the agent's assessment, stored on the submission (`job_submissions.assessment`). It creates no judgment, payout identity or platform call. Only the agency reads it; a builder sees a proposal once the agency acts. The agency sees the assessed amount and reasons; **Approve** files one held request (the proposal, limited by the signed per-payment cap) and takes that one request straight to the approval signature. Later payouts of a capped sequence each wait for their own click. Requesting changes before approval needs no payout rejection. `proposeJob` still assesses itself when no assessment is stored.
- **Setup.** One action signs the remaining wallet-owned setup steps back to back; each is still its own signature. DAO votes, platform confirm pages and waits end the run.
- **Desk.** The job list stores the agent balance last observed by a job read (`platform_agents.usdc_observed`): zero asks the agency to fund, above zero asks the builder to submit, never observed keeps the cautious wording. The agency sees an unregistered payee on the job page; the builder's unsent report and evidence are kept in the browser under the signed-in account; the Security test tab shows only with demo controls.
- **Failed-payment proof, tightened.** An unavailable payment read no longer keeps proof: it is withdrawn until the next successful FAILED read, so a flag stored by an earlier release without such a read frees nothing. Releasing a failed payout's budget ("owe it again" or "count as rejected") also requires a confirmation made at decision time: the payout record must claim non-execution under the same request and payment identity, and a successful FAILED payment read must agree, with no transaction, refund or retained counterevidence. Otherwise it refuses, releases nothing, and records whatever those reads showed.
- **Funding recovery (inert).** The explicit funding-recovery review is present but answers `platform_recovery_unavailable` everywhere: no platform adapter implements its read contract, which is a proposal not yet agreed with the platform. A recorded attempt now resolves only on evidence: `funded` when verification shows the signed total, or `not_received` when a trusted provider read confirms the expired destination received nothing and the balance is unchanged (local, not deployed). See [job-funding.md](docs/job-funding.md).
- **Keyless production.** `NODE_ENV=production` with `PLATFORM=fake` refuses to start when `NEARAI_API_KEY`, a review service key, a platform credential or any Market worker variable is set, and holds a Market board token only with `PAPERWORK_KEYLESS_MARKET_BOARD=throwaway-agent` (startup then warns that the token must belong to a throwaway agent). This enforces the variable checklist in [deploy.md](docs/deploy.md#environments); the board token is an `aat_` agent token that can also bid and submit as that agent, not a read-only key: that mode has no sign-in, and filing a report starts an assessment.
- **Market-settled reads.** The agency's refreshing read of a Market-settled job no longer attempts platform setup reconciliation (it reported a false "Setup status could not refresh" on every poll). `demo:market:browser` walks that job in a browser against a fixture Market.
- **Rollback.** Forward-only once any new-kind record exists. `33c4899` reads stored terms without re-validating them, so on a database holding the new clauses it misreads rather than refuses: job lists break on a Market-settled job, such a job is offered platform setup and deposit instructions, the Market-source gate is dropped, and retained refund evidence is ignored. The two new nullable columns (`platform_agents.usdc_observed`, `job_submissions.assessment`) are themselves ignored by older code. The exact queries that must return no rows before a rollback are in [deploy.md](docs/deploy.md#rollback-after-the-2026-11-13-changes).
- **Not run for this work:** `demo:full`. The blank form and token-free acceptance were exercised by tests, not in a signed-in browser.

**SDK 0.6.0 replacement-pair reacceptance (2026-11-14; not deployed)**
- Local rollout candidate uses source `f4729f4a7244a4e415d03678535328960b695d71`, candidate `c1a3ae617f7c2ff64dc4a976e1493b96bceec56cf6c98d675d1c863cbd817509`, SDK SHA-256 `aa3d4325bde4f74604280c577fac99b50acea805d27214a89899a77e1132af9a`. Prior artifacts, original failed attempts and frozen candidates remain unchanged.
- Fresh 1,688 offline tests, typecheck, contract, real-SDK workflow, rework rejection proof, contained process restart, all browser checks and Linux amd64 packaging pass. Normal and lost-acknowledgement worker flows submit once, recover immutable version/raw evidence and settle the original fixture hire without platform payout or replacement.
- Initial restart dependency-layout refusal is retained separately; identical app source with contained dependencies passed. No guard was weakened.
- Exact app source/image/receipt identities: `docs/sdk060-local-readiness.json`. Owner merge/CI, migration-aware protected-state/rollback review, hosted checks and current Desk readiness remain gates. Treasury must reaccept this replacement pair; its prior #304 CI is not relabeled. No deployment, signatures, hire or funds movement. #81 remains separately deferred.

**Type and boundary hardening (local, 2026-11-14; not deployed)**
- **Market HTTP answers.** `src/server/market/api.ts` reads every Market answer through a schema. A malformed directory, pricing plan, reputation or assignment list is a failed Market read (502 on its route, a failed worker poll) instead of a 500 or a stored `"undefined"` identity. Assignment ids and status must be non-empty strings; escrow fields and the job brief stay optional.
- **Request bodies.** `jsonBody` returns `unknown`. A JSON body that is not an object is a 400 on signing and submission, where `null` was a 500. Job creation still checks the signed-in account before validating terms.
- **SDK adapter.** `src/server/platform/client.ts` uses the SDK's own call types instead of an untyped cast; the SDK already validates each answer at runtime. Requests sent are unchanged.
- **Structure.** `Runtime` exposes `db` and `close()`; tests and scripts use them instead of reaching into the engine. `noUnusedLocals` and `noUnusedParameters` are on. `noImplicitReturns` and `noImplicitOverride` are also on, with the host middleware returning `next()` and the review runner declaring its override. `exactOptionalPropertyTypes` remains off.
- **Stored assessments and views.** One shared judgment schema types `ContractView.judgment` and validates stored assessment JSON before it affects a job view or compensation calculation. Unreadable records stop the step without rewriting records or releasing commitments. Other stored record types remain separate follow-up work.
- **Market SDK and worker.** The adapter uses the SDK call types; the port retains nonterminal `funding` and `funding_review` states. DAO ownership stays separate from wallet ownership. Worker webhook bodies remain unknown until narrowed; stored submission baselines are schema-checked, with unreadable baselines retaining uncertainty.
- **Fresh verification (2026-11-14):** `bun --no-env-file run typecheck` and all **1,675 tests** passed. `bun --no-env-file scripts/demo-job-restart-local.ts` passed on the unchanged SDK 0.5.9/platform pin: real app process kill/restart, original durable IDs, one explicitly approved 300 USDC simulated payment, owned stack stopped. Receipt: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/paperwork-restart-launch-zjGTet/launcher-receipt.json`. Logs: `/private/tmp/paperwork-hardening-typecheck.log`, `/private/tmp/paperwork-hardening-tests.log`, `/private/tmp/paperwork-hardening-restart.log`. This is distinct from SDK 0.6.0 frozen acceptance; #74 stays open and #81 successful provider-response-loss recovery stays deferred.
- **Fresh combined browser verification:** `bun --no-env-file scripts/demo-job-restart-local.ts --full-check` passed: setup/consent, signed terms, submission, typed assessment, explicit payout approval, settlement at desktop/mobile sizes, and a separate explicitly approved Market service with distinct identities. Owned stack stopped. Receipt: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/paperwork-full-launch-7D1yBy/launcher-receipt.json`; log: `/private/tmp/paperwork-hardening-full-check.log`.
- **Fresh worker desk verification:** `bun --no-env-file run demo:desk:check` passed, including lost Market response/reload retaining the saved submission and attempt without a second POST, matching-version observation, and separation of delivery from acceptance/payment. Fixture receipt: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/paperwork-desk-vFPsKu/receipt.json`; log: `/private/tmp/paperwork-hardening-desk-check.log`.
- **Checks (Bun 1.4.2, offline, simulated):** typecheck; 1,672 tests; `demo:job`; `demo:e2e`; browser `demo:browser --keyboard`, `demo-v2-browser --keyboard`, `demo:privacy:browser`, `demo-funding-recovery-browser`; `profile:reads`; SDK `demo-job-restart-local` (run before the request-body and `Runtime` changes). **Not run:** `demo:market`, responsive and accessibility checks, container build.

**Checks for the core-flow work (Bun 1.4.2, offline, simulated):** typecheck; 1,656 tests; `demo:e2e`; `demo:job` with and without changes and lost reply; browser `demo:browser`, `demo:desk:check`, `demo:privacy:browser`, `demo:review:check`, `demo:market:browser`, `test:responsive`, `test:accessibility`, the Pay on merge and funding browser checks, and SDK `demo:job:restart`.

**Checks (Bun 1.4.2, offline, simulated):** typecheck; 1,594 tests, 10,778 assertions; `demo:e2e`; `demo:job` with changes and lost reply; SDK `demo:job:restart` (true process restart, same identities, one payment); browser `demo:browser`, `demo:desk:check`, `demo:privacy:browser`, `demo:review:check`, funding and v2 payment checks. Each new regression fails without its fix. No deployment, Railway read or live action was performed.

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
| Hosted acceptance | Funding, payment, DAO setup/quorum and registration on hosted infrastructure are unverified. Funding is paused on an unresolved provider deposit allocation. |
| Capacity | One platform Organization per job and at most 16 never-released agents per deployment (platform#46) cap a deployment at 16 jobs. |
| Historical recovery | Real historical provenance/key authorization and unsupported recovery cases remain unresolved. Local rehearsal covers stand-in v2/v3 and SDK v3 processing/full settlement, not physical power loss or real installation/resumption. Deployment preflight must precede startup because runtime binding follows possible migrations. Unsafe unrelated history still blocks the database. |
| Acceptance | Provider-response-loss continuation (G14), historical restoration/install clearance and hosted evidence remain separate. [Acceptance matrix](docs/recovery-acceptance.md#acceptance-matrix). |
| DAO filings | Retrying an unanswered DAO setup/consent filing with saved text can create a new gateway request hash; only known IDs are polled. No duplicate payout has been demonstrated. |
| Hermes | Authenticated profile Runs routing, actual NEAR provider execution, effective isolation and hosted-version update remain unverified. The key helper lacks atomic server-side create-only/CAS. |
| Market | Paid hires stop task observation; authority renewal is missing. Worker handles one agency, polls the latest 100 assignments without pagination, and has recorded simulator directory/worker gaps. Webhook replay protection is in memory and resets on restart within the 300-second window. |
| Market-settled jobs | Paperwork observes the Market job's public status only: it cannot read the buyer's acceptance details, ledger or the worker's payout, cannot prevent acceptance by a lapsed window, and cannot read private (direct-hire) Market jobs. No browser check covers the Market import or settlement screens yet. |
| Invitations | Lost creation replies or unavailable browser storage can strand the original link; creation has no durable client request identity. |
| Agent access | No non-browser authentication path; attention actions name labels, not routes; workflow identifiers differ across endpoints. |
| Offline demos | The wallet selector loads its manifest and icons from external hosts even in keyless mode. |
| Discovery/UI | Listing-specific application-to-offer linkage and native internal-listing publication are absent. Some forms and directory/config/deposit reads have incomplete pending/error/supersession handling. |

Evidence links are supplied references, not fetched or quality-verified artifacts. Requested changes apply only while proposals remain wholly unapproved/unpaid. [State-machine audit](docs/implicit-state-machines.md), [architecture](ARCHITECTURE.md) and [recorded platform gaps](docs/platform-gaps.md) contain the supporting detail.

## Next

1. Owner cleanup of the staging environment's copied variables.
2. A separately approved production update carrying the local changes, after rollback review of the additive column.
3. Provider reconciliation of the deposit allocation, then supervised hosted funding.

Production deployments and restarts remain paused; local checks grant no live-operation authority.

## Explicit funding recovery (deployed inert in `eac99283`; attempt resolution local)

Agency **Recover funding** reads a trusted reconciliation, shows exact existing credit/remainder/fees and destination, requires acknowledgement and wallet review, and claims one durable attempt before wallet I/O. The original allocation/cache and browser markers are retained. Duplicate preparations and the ordinary deposit endpoint refuse after a claim. The pinned SDK has no reconciliation adapter, so production remains blocked rather than accepting the private receipt as clearance. See [flow and integration boundary](docs/job-funding.md#explicit-recovery-review-local-not-deployed).
