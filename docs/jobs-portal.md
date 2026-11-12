# Paperwork Desk

**Paperwork lives at `desk.multiagency.ai`.** The default **Assigned to me** view shows jobs where the signed-in NEAR account is the named builder or agency representative, grouped by recorded next action, waiting state or confirmed completion. **Agency** shows the jobs that account manages as the named representative. **Openings** remains a shareable public route. Active projects without a published opening are excluded.

All views share one origin, backend, SQLite database and `multiagency-paperwork` deployment. The separate Jobs subdomain plan was dropped on 2026-11-11. Remove any nonempty `PAPERWORK_JOBS_PUBLIC_URL`; startup rejects it. `PUBLIC_URL` names the single origin. Cookies remain host-only, with exact-host/origin checks when that origin is explicitly configured; forwarding headers cannot select a different host. Accepted terms, source bindings, browser recovery keys and payment identities are unchanged. No old browser state is moved between hosts.

| Route | Purpose |
| --- | --- |
| `/#/` and `/#/my-jobs` | Assigned to me: private named-party jobs and recorded actions |
| `/#/agency` | Agency offers, setup, submission review and payout approval; exact representative access |
| `/#/openings` | Published MultiAgency openings, publicly readable |
| `/#/market-jobs` | Public Agent Market jobs, reached through Openings' source selector |
| `/#/market` and `/#/market/<id>` | Market integration setup and hires, reached through Agency |
| `/#/assignments` | Separately authorized listed-agent assignments; retained private route |
| `/#/start` | Optional onboarding into existing application and invitation flows |
| Existing `/#/c/<id>`, `/sign?t=…` and `/verify` links | Existing role-specific job views, private invitations and policy verification |

## Workflow and payment authority

| Route | Offer and acceptance | Submission and review | Payment authority |
| --- | --- | --- | --- |
| Published MultiAgency opening | Public NEARN listing for MultiAgency's configured sponsor; apply and review the offer on its source | Source application and award process; browsing creates no agreement | Source listing's payment terms. No Paperwork payout is created by discovery or an application |
| Paperwork builder job, on Desk | Agency offers immutable terms; builder signs them | Report, invoice and evidence; bounded agent compensation proposal; agency approves or requests changes | Existing held SDK payout; agency approval precedes payment; platform-confirmed settlement is recorded separately |
| Listed-agent assignment, in Desk's Market integration | Market creates/awards the assignment under its own terms | Existing agent-token API submits Markdown; Market owns acceptance, rework and disputes | Market escrow/settlement. This assignment never also triggers a Paperwork builder payout |
| Instant x402 hire, in Desk's Market integration | Agency approves exact hire terms before work | Delivery automatically accepts the instant hire; there is no post-delivery agency approval gate | Existing SDK market hire path, not the builder payout path |

Standard Market jobs can request rework during the review window and auto-accept after that window. Instant x402 work has a different lifecycle. Keep the agreed builder workflow on Paperwork's held payout path: switching it to instant x402 would remove the required agency review before payment. Official references: [worker lifecycle](https://market.near.ai/skill/flows/worker-lifecycle.md), [x402 lifecycle](https://market.near.ai/skill/flows/a2a-x402.md).

## Implemented entry and API map

| Jobs behavior | App API / record | Authoritative source |
| --- | --- | --- |
| Published MultiAgency openings | `GET /api/jobs/openings`, `MultiAgencyOpenings.list` | Public MultiAgency settings identifies its NEARN sponsor; anonymous sponsor catalog across bounty, project, hackathon and sponsorship types. Only published, public, open, unexpired rows are returned |
| My private jobs | `GET /api/jobs/mine`, `Engine.jobsFor(account)` | Existing local Paperwork records, exact named agency/builder account only; original job IDs and acceptance flags, without invitation tokens, invoices, reports or payment totals |
| Optional onboarding | `#/start` | Existing MultiAgency application form, original Paperwork invitation and role-specific job views. No new account authority or automatic application submission |
| Public Market board | `GET /api/market/jobs`, `MarketApi.openJobs` | `GET /v1/jobs/board`; public `open`/`filling` set, 50 rows plus a lookahead, then increasing offsets. All pages remain reachable beyond 100; no global total or snapshot is invented |
| Agency-authorized assignment queue | `market_assignments`, `Worker.poll`, `GET /api/market/worker` | `GET /v1/agents/me/assignments?status=all&limit=100` |
| Explicit deliverable submission | Write-ahead saved Markdown, attempt ID, agency binding and version baseline; `Worker.submit` | `POST /v1/assignments/{id}/submit` with the server-held agent token |
| Lost response recovery | Keep unknown until readable history proves the attempt arrived or did not; never count an older version as this delivery | `GET /v1/assignments/{id}/deliverable/versions` and matching new version's exact Markdown via `/deliverable/versions/{version}/raw` |
| Assignment outcome | Market status and acceptance observation | Assignment polling and authenticated webhook events |
| Earnings destination | Existing agency deposit record and owner withdrawal instructions | Owner checks Market payout records/balance; the agent token does not expose owner balance |

Assigned to me derives attention from stored signatures, setup, submissions, payout records and owner steps. The job-attention projection performs no SDK refresh, nonce preparation, follow-up or job-record write. Uncertain payment/approval outcomes remain **Waiting**, retaining the existing identities. **Completed** requires platform-paid payouts covering the full positive signed scope with no unresolved commitment; approval, manual arrival notes, a partial invoice and an ended date do not qualify. Where funding has no stored proof, an action opens the existing job to check readiness rather than claim it is funded. Older responses without attention data safely show Waiting.

Agency access remains exact named-representative access, not organization-wide membership. The existing agency/builder job pages still operate on the same immutable job record. Public discovery grants no private-job, bid, hire or payment authority. Failed reads retain existing results with a stale warning. Content is escaped and external links use fixed validated source hosts. Listing compensation preserves fixed/range/variable meaning where supplied; unknown terms link to the source. A generic listing deadline is not presented as an application cutoff.

These endpoints are verified against the [official OpenAPI](https://market.near.ai/openapi.json), [agent API](https://market.near.ai/skill/reference/agent-api.md), and [webhook reference](https://market.near.ai/skill/reference/webhooks.md), read anonymously on 2026-11-11. No authenticated hosted Market call was made.

## Local walkthrough

From this repository:

```sh
bun install --frozen-lockfile
bun run demo:desk
```

Open the printed `http://desk.localhost:3006/` URL. To avoid a running demo, choose a fresh port, for example `PAPERWORK_DEMO_PORT=3008 bun run demo:desk`. Everything uses this one origin. The older `demo:jobs` commands remain aliases; they no longer select another host. Existing running demos are not stopped or restarted by this launcher.

1. **Assigned to me** opens by default. The fixture builder's unsigned private job appears under **Needs your action** with **View offered terms**, a read-only link. Use the launcher's printed **Builder invitation (simulated)** URL to sign that fixture job; opening it does not sign automatically. The private summary never exposes an invitation token.
2. **Openings** shows three simulated published listings: fixed advertised amount, a range and a variable cap. Draft, private and closed fixture records are excluded. External fixture links do not identify real hosted openings.
3. **Get started** explains how to apply or accept an invitation. Application links open existing source forms; nothing is sent automatically.
4. **Agency** opens the named representative's job list, with **New job**, existing review links and **Market integration** for agency setup and hires. The demo uses its explicit simulated representative account for that view. Market management is not a separate top-level navigation item. The entry remains discoverable when unconfigured; that route explains the missing connection rather than enabling setup or hires. A running backend must be relaunched on a fresh port to load launcher or server changes; refreshing only updates the frontend.
5. In **Openings**, choose the **Agent Market** source for 123 simulated public jobs. Use **Load more**, search or filter by job type. Public source navigation does not include private assignments.
6. Open **Agency → Market integration** for the existing listed-agent queue, also available at `/#/assignments`. Submit Markdown there. The fixture loses the response, then exposes a matching version and accepted status on its next check. Market acceptance is not payment confirmation. Ctrl+C stops only this launcher's app; it starts no platform stack.

For the automated workspace browser check, run `bun run demo:desk:check`. It checks the default private queue, public-source filtering, onboarding, all 123 Market fixture jobs, later-page failure recovery and desktop/mobile layouts. Independent tabs use the same origin; an uncertain worker submission survives reload and a saved-attempt retry observes a late matching version without another send. The separate `bun run demo:browser` completes the simulated builder payment flow and verifies that the personal queue waits during payment processing and completes only after full-scope confirmation. Receipts and screenshots use the printed temporary directories. Auth tests use signed fixture sessions; these keyless browser runs do not prove hosted wallet login or real payment.

For the complete **human builder payment** demonstration, continue to use `bun run demo:full` and the [builder job walkthrough](job-demo.md). Jobs does not replace that flow.

## Evidence and remaining gaps

The browser and failure checks use actual app code with scripted source/auth fixtures. They are not hosted application or payment evidence. The separate anonymous public-source observation below is a real HTTP read. Current Market simulator gap [platform#68](https://github.com/MultiAgency/platform/issues/68) prevents claiming a full worker loop on `demo:market`'s stack; that command still proves the separate buyer SDK integration.

Market bidding still uses the source's account/agent authorization; Paperwork's NEAR login is not Market login. The worker view does not yet expose assignment start, message threads, file uploads, review clocks or assignment pagination beyond its existing latest 100 records. This limit does not apply to the new paginated public board. Use Market for those actions and its owner payout records. An `accepted` status or a deposit address is not confirmed payment; no `payout.paid` webhook is currently emitted.

Paperwork invitation recovery remains a concrete gap: creation returns the private token once, stores only its hash, and the creator's browser saves the link per origin. Lost creation responses, blocked storage or another host/browser can leave an unsigned builder unable to accept. My jobs deliberately does not reveal/reissue that token or bypass its check. An accepted builder signed in with the named NEAR account can use the token-free builder view; the keyless demo still requires the original invitation to submit.

MultiAgency's native internal-listing endpoints currently require organization administration and have no public listing feed. This implementation reads its existing public NEARN openings; it does not fetch admin records, infer openings from active projects or publish private Paperwork contracts. Other publishing systems need an explicit public-source contract before claiming complete coverage.

DNS, deployment, real wallet sign-in and hosted assignment/payout behavior remain unverified. SDK remains pinned at 0.5.7; a forthcoming 0.5.8 release is not silently adopted.

## Earlier listed-agent verification recorded 2026-11-11

This records the preceding listed-agent portal milestone. The expanded openings/onboarding/My jobs implementation has separate evidence below; these earlier counts and source digests do not verify the later changes.

The final public-source freeze is `/private/tmp/paperwork-jobs-review-Mvd1aj/demo`, based on `77d7416171708dae00c4d8c36ecf459c4179b1b7` plus these local changes. Its manifest records 138 public files with SHA-256 `c892a7f8d3a053743c1e2ca22a8ca89fa43a0c088421495c7cb897d59cd8257a`; no secrets, existing application databases or peer runtime state were copied. Dependency declarations and lock match the previously frozen installed dependencies. This evidence section was appended after the freeze; it changes documentation only.

| Check | Final result and evidence |
| --- | --- |
| `bun --no-env-file run typecheck` | Pass, including Railway configuration; `../typecheck.log` |
| `bun --no-env-file test` | 482 passed, 0 failed, 2,825 assertions across 29 files; `../tests.log` |
| `bun --no-env-file run demo:e2e` | Complete simulated builder flow passes; `../e2e.log` |
| `bun --no-env-file run demo:jobs:check` | Independent browser run passes at 1440×1000 and 390×844, one outbound submission; `../jobs-browser.log` |
| `bun --no-env-file run demo:stack` | Three confirmed simulated transfers totaling 750 USDC, zero to attacker; remaining 250 stays disputed/committed pending positive non-execution evidence; `../stack.log` |
| `bun --no-env-file run demo:market` | Wallet and DAO hires, exact-term approvals and freeze/unfreeze pass, with on-chain policy edits; known simulator directory/worker gap remains explicit; `../market.log` |

The browser receipt is `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/paperwork-jobs-1CnWNp/receipt.json`, with `desktop.png` and `mobile.png` beside it. It retains assignment `assignment-offline-1` and attempt `44a58fe1-f1ec-4e81-b7eb-759286cc84d3`. The saved-retry tests also prove that a stale retry after another tab confirms the attempt observes that same record, rather than creating a revision or outbound send.

SDK checks used installed `@multiagency/sdk` 0.5.7, Bun 1.4.2, Node 24.22.2 and isolated platform revision `82d5caca90532b63f5e96b891fbfd48575629dd9`. Fresh owned stacks were started through `node test/e2e/run.mjs --stack --app multiagency-paperwork --no-browser --owner acme.demo --payee maria.demo --builder attacker.demo`; the Market stack additionally used `--market --dao-treasury --on-chain-policy-edits`. Wallet `run-oOU7H9` and Market `run-kP2j4l` both stopped through their own stop files and exited 0. Platform source remained clean, and all frozen app files still matched after the runs.

The auth fixtures use real Better Auth and signed fixture session cookies; they prove allowed-host selection, host-only cookie attributes and foreign-origin refusal. They do not prove a hosted wallet login. Market/provider/chain/signature/settlement observations above are simulated. No deployment, DNS update, live credential, real funds, commit or external message was performed.

## Earlier discovery and onboarding verification — 2026-11-11

This is the preceding multi-host discovery milestone. The current single-Desk layout and validation are recorded below; this historical source digest is preserved.

The user selected **only published openings and my private jobs**, excluding active projects. The resulting source map is:

| View | Coverage and access | Next action |
| --- | --- | --- |
| Published openings, default | MultiAgency's configured NEARN sponsor, all four published listing types, open/public and unexpired. No sign-in; no active-project inference | View opening and apply on its source, or open optional Get started guidance |
| My jobs | All existing Paperwork jobs matching the signed-in named agency/builder, including records beyond 100. Private before and after acceptance | Open the existing role-specific view; unsigned builders retain the original invitation requirement |
| Agent Market | Its common public open/filling board with search, type, sort and reachable pages beyond 100 | View the native Market job; bidding and account onboarding remain on Market |
| Agent assignments | Existing configured listed-agent queue and owner/DAO permissions | Existing delivery/recovery flow; no second payout path |

**Actual public-source observations:** `GET https://multiagency.ai/api/settings` identifies NEARN sponsor `multiagency`. The full anonymous, read-only sponsor query returned `200 {"bounties":[]}`. The new `MultiAgencyOpenings` client itself was run against those sources at **2026-11-11 18:52:11 UTC** and returned **0 published openings**, recorded in `/private/tmp/paperwork-jobs-review-NJMjJP/public-openings-observation.json`. The public projects feed separately returned 13 active projects with no linked listing; they were not turned into openings. `/apply` returned 200. No application was submitted.

The NEARN integration consumes the current public source contract, rather than an invented pagination API: [sponsor handler at `0aa3a0f`](https://github.com/NEAR-DevHub/nearn/blob/0aa3a0f659c858a4b5486f77b1e021198cb93292/src/pages/api/listings/sponsor.ts). It returns the full requested sponsor/type set. NEARN's supported `/listing/<slug>` redirect provides the canonical detail page. Missing publication/privacy fields or an unreadable catalog produce an error, not a successful empty list.

**Frozen app verification:** `/private/tmp/paperwork-jobs-review-NJMjJP/demo`, 157 public files, SHA-256 `42d0b1c8c7d48b8b2db9803ff2799a25379f2d91544b22a9dcb9496dc46b7dab`, based on `77d7416` plus local changes. Secrets, existing application state and peer runtime data were excluded; installed dependencies use the same unchanged lock and SDK 0.5.7. This evidence section was appended after the freeze.

- `bun --no-env-file run typecheck`: pass, including Railway configuration (`../typecheck.log`).
- `bun --no-env-file test`: **632 passed, 0 failed**, 3,544 assertions across 39 files (`../tests.log`).
- `bun --no-env-file run demo:e2e`: complete simulated builder flow passes (`../e2e.log`).
- Independent `bun --no-env-file run demo:jobs:check`: pass (`../jobs-browser.log`). The receipt is `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/paperwork-jobs-v84hmK/receipt.json`; four desktop/mobile source-view screenshots are beside it.

The browser run displays 3 simulated published openings, retains private job `c_c8b0fc6bbd10`, loads all 123 simulated Market rows after a later-page outage, and retains worker attempt `992994b9-5a51-482f-9da4-1c56df5c4aeb` with **one outbound submission**. It follows onboarding links without sending an application, bid or payment. Unit/HTTP checks also cover account switching, unauthorized private-job reads, 105 private records, source filtering, safe links, malformed reads and stale retries. The browser/server it owned were stopped; existing manual demos were left alone.

The earlier SDK stack records above belong to their recorded source freeze. This discovery expansion changes no payment route and adds no hosted wallet or payment evidence. Internal published-listing coverage and lost invitation recovery remain the concrete source/operational gaps described above. All changes remain local for the user to commit; no deployment or DNS update was performed.

## Single Desk and role-aware work — 2026-11-11

The user dropped the separate Jobs subdomain and selected **Assigned to me** as the signed-in default. The private queue now distinguishes **Needs your action**, **Waiting** and **Completed**, using only stored workflow evidence. Named-party membership alone is not a next-action signal. Agency remains a separate exact-representative view; public openings are shareable at `/#/openings` on the same origin.

Unknown approval or payment outcomes, externally signable pending confirmations, disputed payments and manual arrival reports stay out of Completed. Missing historical approval/payment links also remain Waiting. Full positive agreed scope must be confirmed by provider-paid payout records with no unresolved commitment. Setup records without funding evidence produce a readiness-inspection action. Partial-settled invoices do not complete the job or promise a continuation form that is not available. Queue reads run under SQLite `query_only` in tests with SDK, signing preparation and nonce methods forbidden, leaving the records unchanged.

Listing cards now preserve source fixed amounts, ranges and variable caps; unknown compensation points to the source terms. Prize budgets are not labeled as individual compensation. Dates are labeled **Listing deadline** until their application/submission meaning is known. The agency overview labels its legacy aggregate **Recorded paid** and explains that agency-reported arrivals differ from platform-confirmed settlement. No publication, application, signature, approval, payout or recovery authority was added by these views.

**Final source freeze:** `/private/tmp/paperwork-jobs-review-ZAJujJ/demo`, 159 public files, SHA-256 `e940c8a731dec0398aafb5ebd97877e1761fc1497930cb1099d68655cb99069c`, based on `77d7416` plus local changes. Only public source and unchanged locked dependencies were copied. This evidence section was appended afterward.

| Verification | Result |
| --- | --- |
| `bun --no-env-file run typecheck` | Pass, app and Railway configuration; `../typecheck.log` |
| `bun --no-env-file test` | **663 passed, 0 failed**, 3,800 assertions across 40 files; `../tests.log` |
| `bun --no-env-file run demo:e2e` | Complete simulated builder flow passes; `../e2e.log` |
| Independent `bun --no-env-file run demo:desk:check` | Pass, one origin, correct default and role actions, public/private separation, all 123 Market rows, retained uncertain submission and one outbound send; `../desk-browser.log` |
| Independent `bun --no-env-file run demo:browser` | Pass, requested changes and confirmed cancellation, explicit payout approval, zero paid during processing, one $300 simulated transfer and personal Waiting → Completed only after full settlement; `../builder-browser.log` |

Workspace receipt: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/paperwork-desk-ecoz5g/receipt.json`, with Assigned/Openings/Market desktop and mobile captures beside it. It retains private job `c_c8b0fc6bbd10` and worker attempt `adae7504-bdd1-4d5d-896b-4fa3573b9eb9`. Builder receipt: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/paperwork-browser-9EUAmt/receipt.json`; the two parties retain payment request `5048d896ad774ea9-p2-1`. An initial mobile run exposed the seven-item navigation overflowing the old one-row header. The final confirmation verifies the two-row responsive header and accessible navigation names without page overflow. Failed runs are not counted as passing evidence.

**SDK regression evidence:** the same backend, shared types, tests and scripts passed `demo:stack` and `demo:market` from `/private/tmp/paperwork-jobs-review-mzICvN/demo`, source SHA-256 `33592c75a3b838a84fa9799eda11c46c9f537f05bcf5eaec02e8fd34f4f7572e`. The final freeze differs only in `src/web/main.tsx` navigation accessibility attributes and `src/web/styles.css` responsive layout, documented by `../verification-scope.json`. SDK remains 0.5.7, Bun 1.4.2, Node 24.22.2, platform `82d5caca90532b63f5e96b891fbfd48575629dd9`. Fresh `multiagency-paperwork` stacks `run-Qhmwkz` and `run-JxkJOA` passed their job and wallet/DAO/on-chain-policy Market checks, then stopped only through their own stop files and exited 0. Job evidence still keeps 250 disputed/committed while 750 is confirmed simulated paid; no attacker transfer or unsupported full-scope claim is made. Logs are in the `mzICvN` parent as `demo-stack.log`, `stack.log`, `demo-market.log` and `market.log`.

All browser/provider/chain/signature/settlement checks here are simulated. Test-owned browsers, app servers and platform stacks were stopped. The user's existing demos on 3007/3004 were not attached to, stopped or restarted. The earlier anonymous public-source read is separate from this validation; no application, bid, live wallet action or real payment was sent. Native published-listing coverage, listing-specific application-to-offer linkage and lost-invitation recovery remain concrete gaps. No commit, deployment, live credential or DNS change was performed.

## Market navigation clarification — 2026-11-11

The sidebar no longer presents competing Agent Market and Market agencies entries. Public Market jobs are a source under **Openings**; setup, hires and listed-agent work remain under **Agency → Market integration**. Existing routes and authorization stay intact. Private assignments are not a public-source tab. The combined browser walkthrough now enters Market management through Agency.

The navigation candidate was frozen at `/private/tmp/paperwork-jobs-review-HsLwFL/demo`: 159 public files, SHA-256 `9aa90933a69aa356f40818e3d3968e1dedf77a5f2c4b57619d618f9b71e39284`. Typecheck passed; all **664 tests** passed with 3,818 assertions across 40 files (`../nav-typecheck.log`, `../nav-tests.log`). Its independent simulated `demo:desk:check` passed the Agency management link, public/private source separation and existing pagination/submission recovery cases. Receipt and desktop/mobile captures: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/paperwork-desk-e7DZ7W/receipt.json`. All frozen source files still matched afterward (`../nav-source-check.json`). This evidence note was appended after the freeze. No additional SDK, hosted or real-payment check is claimed for this frontend navigation change.

## Manual walkthrough corrections — 2026-11-11

The unsigned builder's token-free list action now says **View offered terms**. It does not enable signing. The offline launcher prints the original **Builder invitation (simulated)** URL separately; the private jobs API still contains no invitation token. **Agency → Market integration** remains visible even when unconfigured, with a prerequisite explanation and no setup/hire controls in that state. Existing running backends are preserved; use a fresh launch to load backend/launcher changes. The Guide's local commands now include Desk, the full isolated app and the browser walkthrough, without a bare stack command that lacks its required stack directory. Onboarding distinguishes report-and-invoice from Pay on merge.

Latest verification freeze: `/private/tmp/paperwork-jobs-review-2yE8Tn/demo`, 159 public files, SHA-256 `5911e8cbc8d296d7804e1a1d87c6834c0cbdbfca87581f1ed29635466ec43587`. Typecheck and all **664 tests** passed (3,818 assertions; `../walkthrough-typecheck.log`, `../walkthrough-tests.log`). One earlier run exposed a test comparing two advancing clock timestamps; the assertion now compares origin/authority configuration independently of time.

The independent simulated browser check passed from `/private/tmp/paperwork-jobs-review-F3L7i8/demo`, SHA-256 `d5ff28e1708af007bb960892ee086d75b11f43a6ca8c2466dfb0b7c71208a47b`. Its app code and scripts match the latest freeze; only the timing assertion test differs (`2yE8Tn/verification-scope.json`). Receipt: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/paperwork-desk-MKIVIp/receipt.json`. It verifies both invitation states without automatic signing, both Market configuration states, existing privacy/pagination/recovery behavior, one outbound submission and desktop/mobile layouts. Both frozen trees remained unchanged. These are fixture checks, not new hosted-wallet, SDK-settlement or real-payment evidence. The user's running demos were untouched; changes remain local and uncommitted.
