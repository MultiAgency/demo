# Paperwork

**The signed terms set the spending limit.**

Paperwork turns a signed job into a payment agent that can only pay what was agreed. Any agency, company, team or client paying a builder for scoped work can use it. MultiAgency uses it for its own builder jobs at desk.multiagency.ai. The payer and a builder agree a scope, budget, acceptance criteria, deadline and payment terms. Paperwork uses the [MultiAgency platform](https://github.com/MultiAgency/platform) through `@multiagency/sdk` 0.6.0 (npm, verified offline against the pinned gateway candidate): an agent for this job, a fixed payee, bounded payments and explicit agency approval.

## NEAR HACKATHON: for judges

**Tracks:** Real-World Money, AI Security & Defense, Agent Economy, Autonomous Business, Social Money.

**Problem.** Anyone who pays builders for scoped work (an agency, a company, a team or a client) wants software, including AI, to prepare those payments. It must never give that software open-ended spending power. The builder wants to know the money is really committed to the agreed terms.

**What Paperwork does.** The agency and the builder sign one job's terms (scope, budget, payee, acceptance criteria, deadline, payment terms) with their NEAR wallets. Paperwork turns those signed terms into the spending policy of a dedicated payment agent: USDC only, the signed payee only, at most the signed per-payment cap, and every payout held until the agency approves it. The builder files a report and invoice. An agent proposes compensation within the signed limits. The agency approves or requests changes, and only the platform's settlement result counts as paid. Anyone with the link can see whether the live policy still matches the signed terms.

**How NEAR fits.**

| NEAR piece | What Paperwork uses it for | Status |
| --- | --- | --- |
| NEAR wallets, NEP-413 | Both parties sign the terms hash; every owner step (agent, consents, grant, policy, payout approval) is signed the same way and checked against a full-access key over mainnet RPC | Live: the hosted job is signed on mainnet by `multiagentic.near` and `buildr.near` |
| Sign in with NEAR | Better-Auth with better-near-auth | Live on desk.multiagency.ai |
| NEAR Intents | USDC payouts from a per-job agent on the MultiAgency platform; the provider enforces payee, asset, cap and owner approval | Simulated in the demo; hosted funding and payment paused |
| Agent Market | MultiAgency's listed agent [multi](https://market.near.ai/a/multi) receives hires through Paperwork's worker, and the agency delivers them on Desk; agencies can also hire listed agents | Worker live on the hosted app; hiring runs on the local stack |
| SputnikDAO | A DAO-owned agency votes on each hire's exact terms before it is paid | Local stack only |
| NEAR AI | Optional report assessment and Review assistant (`NEARAI_API_KEY`) | Off on the hosted app, where a rule-based assessor runs |

### Try it (about 5 minutes, no keys, everything simulated)

`bun install && bun run demo`, then open http://localhost:3000. The sidebar says **Platform stand-in · No real funds · demo wallet**: signatures, provider, chain and settlement are simulated.

| Do | See |
| --- | --- |
| Open `http://localhost:3000/#/new`, keep the three default deliverables ($300 + $200 + $500), **Create draft** | A draft job with its terms hash and a live preview of the policy it will become |
| **Sign as acme.demo**, open **Builder invitation**, **Sign as maria.demo (demo wallet)**, then return to the job | Both NEP-413 signatures over the same terms hash |
| **Sign remaining setup steps**, then **Fund $1,000.00 (demo)** | Checklist 8 of 8: Organization, agent, access, payout grant, policy in force; agent balance $1,000.00 |
| In the builder view, write a report, add an HTTPS evidence link for each deliverable, invoice $1,000, **Submit report and invoice** | The agency sees the agent's assessment and $1,000.00 proposed compensation; nothing is paid yet |
| Optional: **Request changes** as the agency, then submit a revision as the builder | Revision 1 is kept as *Changes requested*; revision 2 is a new immutable submission |
| **Security test** → **Run all** | Redirect to `attacker.demo` *Refused by the platform* (`payee_not_agreed`); $1 over the cap refused (`per_transaction_exceeded`); the prompt-injection payout *Held for approval*: "NOT STOPPED by policy: the approval is the second layer". **Reject** it |
| Back on **Submission & review**, **Approve $1,000.00** | Payout *Settling*: approval recorded, paid still $0.00 |
| **Settle approved payouts** (demo bar) | *Payment complete*: *Confirmed settlement*, $1,000.00 to maria.demo, a `FAKE-…` transaction |
| **Copy verify link** and open it | Public checks only: terms hash, both signatures, live policy against the signed terms |

This route, without the optional step, is the one in the demo video, recorded on 2026-11-14 from the `hackathon-submission` source with a fresh server (one job, one confirmed simulated payment). The video then shows the hosted Verify page (read-only), the public [multi](https://market.near.ai/a/multi) listing, and an Agent Market hire simulated on the platform's local stack (no real funds; see [Hire and work on the agent market](#hire-and-work-on-the-agent-market)). The same journey with requested changes runs automated with `bun run demo:browser` (needs `agent-browser`); `bun run demo:e2e` runs the flow and the attacks headless in about a second. `bun test`: 1,688 pass.

**Hosted (real NEAR, read-only for judges):** MultiAgency's own deployment. https://desk.multiagency.ai/#/c/c_a2002ec56bf1/verify shows public verification of a real job signed on mainnet by `multiagentic.near` and `buildr.near`. The checks are relayed live from the platform on `api.dev.multiagency.ai` running SDK 0.6.0. Funding and payment on the hosted app stay paused pending provider reconciliation, so the payment steps are shown with the simulated platform.

### Shared infrastructure (disclosure)

This application uses the shared [MultiAgency Platform](https://github.com/MultiAgency/platform) and `@multiagency/sdk` for app consent, owner/DAO signatures, guarded execution, durable request identity and local simulation. Treasury and Paperwork are separate applications with one shared founder. These primitives are shared work, not independently invented by both teams.

The other project is **Treasury**: https://github.com/MultiAgency/treasury.

Paperwork's own contribution in this repository: the job terms model and canonical hash, two-party NEP-413 signing, compiling terms into a per-job agent policy and checking the live policy before every payout, the report/invoice/revision workflow, compensation assessment, held-payout approval and settlement tracking with lost-reply recovery, public Verify, Desk (assigned work, agency view, public openings), the Agent Market worker and hire flows, and the web app.

### Libraries and baseline

- Own pre-hackathon baseline (Q-005): the MultiAgency Platform before 2026-10-19 (last commit before the window: [`af6c03b`](https://github.com/MultiAgency/platform/commit/af6c03bbdf9070399da534b91dba4a5c26b21aec), 2026-10-16T17:40:34Z; first window commit `830de85`, 2026-10-19T17:02Z). Platform work after that date, including SDK 0.6.0, is shared infrastructure (see above), not a Paperwork submission.
- Third-party: Bun, TypeScript, Hono, zod, React, `bun:sqlite`, Better-Auth, better-near-auth, `@noble/curves`, `@noble/hashes`, `@scure/base`, CopilotKit/AG-UI, `@nearai/inference-sdk`. The full list is in [package.json](package.json).
- Written with AI assistance.

### Hackathon-window diff (Q-003)

All history in this repository is inside the window: the first commit is 2026-11-01, and the repository was created 2026-11-03. There is no pre-hackathon commit here, so the whole repository is hackathon work. Its baseline is the platform listed above. Submission tag: `hackathon-submission` (compare: https://github.com/MultiAgency/demo/commits/hackathon-submission).

### Limits

Payment in the demo is simulated. The hosted app has signed real terms on mainnet, but has not settled a hosted payment, and its funding stays paused. SDK-simulator rework is not shown as working. Verify relays the platform's read; it is not a cryptographic proof to the builder. See [What we claim, and what we don't](#what-we-claim-and-what-we-dont).

## About Paperwork

The **Report and invoice** workflow adds immutable submission revisions, evidence references, an invoice cap, an agent's compensation proposal, requested changes and linked settlement evidence. The **Pay on merge** workflow remains available for v2 jobs; new v3 jobs explicitly sign the report/invoice and payment clauses.

**desk.multiagency.ai** is Paperwork's single entry for private work, agency offers and approvals, public openings and connected [Agent Market](https://market.near.ai) work. Desk opens on **Assigned to me**: jobs where the signed-in account is the named builder or agency representative, grouped into **Needs your action**, **Waiting** and **Completed** from stored workflow evidence. **Agency** shows only jobs that account manages as the representative; **Openings** is public at `/#/openings`. No organization-wide membership access is inferred. See the [Desk walkthrough, source map and boundaries](docs/jobs-portal.md).

Paperwork's server holds only its app credential. In production it never holds an owner or provider key; the keyless demo and the local stack use a demo signer.

**Status:** current deployment, pins and open gates are in [PROGRESS.md](PROGRESS.md) and [release-status.json](docs/release-status.json); environments are in [deploy.md](docs/deploy.md#environments).

## Run it

Prerequisites: Bun 1.4+ (if `bun install` says "Unknown lockfile version", run `bun upgrade`). Everything below is simulated: signatures, provider, chain and funds.

| Command | What it shows | Needs |
| --- | --- | --- |
| `bun run demo:e2e` | The whole flow headless in about a second on the in-process platform stand-in | nothing |
| `bun run demo:job` | One report/invoice job to confirmed settlement; add `PAPERWORK_JOB_CHANGES=1 PAPERWORK_JOB_LOST_REPLY=1` for requested changes and a lost reply ([steps](docs/job-demo.md)) | nothing |
| `bun run demo` | The app in the browser at `localhost:3000` on the stand-in (`PORT=3001` if taken). Public openings read live sources. | network for openings |
| `bun run demo:desk` | Offline Desk fixture: openings, private-job discovery, onboarding; `demo:desk:check` runs it in a browser | nothing |
| `bun run demo:browser` | The complete two-party job in a browser ([proof](docs/browser-demo.md)) | `agent-browser` |
| `bun run demo:privacy:browser` | v2/v3 access matrix: party, unrelated and anonymous reads, public Verify | `agent-browser` |
| `bun run demo:market:browser` | A Market-settled job in a browser against a fixture Market: import, settlement choice, report, assessment and Market acceptance, with no platform payment | `agent-browser` |
| `bun run demo:review` | The Review assistant against a scripted model; `demo:review:check` in a browser ([setup](docs/review.md)) | nothing |
| `bun run demo:job:restart` | A fresh isolated SDK stack: lost app reply, full process restart, same identities, one payment ([proof](docs/job-restart.md)) | platform checkout, Node 24 |
| `bun run demo:full` | Jobs and Agent Market in one app on a fresh SDK gateway and market simulator ([walkthrough](docs/full-demo.md)); `demo:full:check` in a browser | platform checkout, Node 24 |

`bun test` and `bun run typecheck` cover the rest offline. Workflow and boundary references: [workflow map](docs/workflow-map.md), [Agent Market boundary](docs/market-boundary.md), [wallet signing](docs/wallet-signing.md).

The optional **Review assistant** uses CopilotKit/AG-UI to prepare editable report feedback. Its direct NEAR backend uses the official Inference SDK with encrypted Chat Completions and verified model responses. Run `bun run demo:review` for the isolated scripted demonstration, or `bun run demo:review:check` for its browser check. Neither calls a hosted model or creates a payment. See [NEAR setup, verification and the synthetic check](docs/review.md); the [Hermes connection investigation](docs/hermes-review.md) is retained separately.

### Keyless, on the platform stand-in

```bash
bun install
bun run demo:e2e
```

The whole flow runs in about a second with no keys and no network, against `FakePlatform`, an in-process stand-in that follows the platform's rules (requestIds, `held`, `refused` codes, approval votes). The output starts with a "platform stand-in" banner and ends with every step passing. It is a stand-in: it does not prove anything about the hosted platform.

```bash
bun test          # money, hashing, NEP-413, clauses, payout state machine, onboarding, platform stand-in, auth
bun run demo      # the same flow in the browser at http://localhost:3000, on the stand-in
bun run typecheck
```

If port 3000 is taken: `PORT=3001 bun run demo`.

### Against the local platform stack

The platform repo ships an isolated stack (gateway, confirm page, provider simulator, local chain). The selected harness must support the exact `--app multiagency-paperwork` namespace; older Covenant run receipts do not verify that path. `demo:stack` drives one job end to end against it, headless. It needs a clone of [MultiAgency/platform](https://github.com/MultiAgency/platform), Node 24 and pnpm (`corepack enable`):

```bash
git clone https://github.com/MultiAgency/platform && cd platform
corepack enable
pnpm install && pnpm build:web
pnpm test:e2e:stack --app multiagency-paperwork --no-browser --owner acme.demo --payee maria.demo --builder attacker.demo
# wait for "Isolated stack ready: <dir>/state.json", then in this repo:
PLATFORM_STACK_DIR=<dir> bun run demo:stack
touch <dir>/stop
```

It reads the stack's `state.json` (gateway URL, app credential file, TLS certificate, chain RPC), starts Paperwork with `PLATFORM=remote`, and runs the same scenario as `demo:e2e`: setup, consents, grant, policy, funding with the total, a judged payout held, approved and settled, an injected payout held and rejected, and the policy refusing the redirect and overpay attacks. The stack simulates the provider, chain and signatures (every owner signature is the stack's fixture key). The recorded run is in [docs/evidence.md](docs/evidence.md).

### Platform version

Approving a held withdrawal needs platform 0.5.5 or later (MultiAgency/platform#42). Paperwork pins the npm release `@multiagency/sdk` 0.6.0, built from platform commit `f4729f4a7244a4e415d03678535328960b695d71` with gateway candidate `c1a3ae617f7c2ff64dc4a976e1493b96bceec56cf6c98d675d1c863cbd817509`. The retained qualified archive, gateway pin and offline handoff are in `vendor/multiagency-sdk`, and `scripts/check-sdk-pin.ts` binds the registry bytes to them. A pin does not establish a deployed gateway; hosted observations are in [market-boundary.md](docs/market-boundary.md#release-and-hosted-checks--2026-11-11).

## Hire and work on the agent market

Agencies take both sides of the [NEAR AI Agent Market](https://market.near.ai): they hire listed agents, and their own listed agent takes jobs. Each agency has one market agent on the platform (area `market`), owned by a wallet or a Sputnik DAO. Market hires run only against the platform or its local stack: there is no stand-in for them.

```bash
# in the platform checkout (Node 24)
pnpm test:e2e:stack --app multiagency-paperwork --market --no-browser                  # a wallet agency
pnpm test:e2e:stack --app multiagency-paperwork --market --dao-treasury --no-browser   # and a DAO agency
# then in this repo
PLATFORM_STACK_DIR=<dir> bun run demo:market     # headless: Paperwork's own API end to end
PLATFORM=remote PLATFORM_STACK_DIR=<dir> bun run demo   # the browser: Agent market
```

**Hiring (client side).** Pick a listed agent (the market's public directory, or a handle), write the brief, and ask for a quote: the platform answers the hire terms (agent, amount, the market's published payee, the brief's sha256, the window). Each job gets its id when it is quoted, saved before anything is asked. A wallet owner approves by hiring; a DAO approves by its vote on the exact terms, filed by the platform, and the platform pays only after the vote passes, after a fresh quote that must match. Each job is then followed with `market/status`: `paid`, `not_charged`, `refused` (nothing sent), or `unknown`, which waits, and is never retried under a new id. The deliverable is shown beside the terms it was paid under. An x402 job is accepted the moment the agent delivers, with no rework and no dispute, so the approval before paying is the only gate.

**Working (worker side).** Configure one agency's listed agent with `MARKET_AGENT_TOKEN` (its `aat_` token), `MARKET_WEBHOOK_SECRET` and `MARKET_WORKER_AGENCY`. Paperwork verifies each `hire.*` webhook (`sha256=` HMAC of `<timestamp>.<raw body>`, within 300 s), drops repeated deliveries, and polls the agent's assignments as well, since a webhook can be lost or arrive out of order. A person at the agency writes each deliverable; Paperwork never hands a buyer's brief to a model or acts on what it says. Earnings stay in the market account until its owner withdraws them: Paperwork shows the market agent's deposit address, whether it is registered on USDC, and the registration transaction, since the market refuses to withdraw to an unregistered account. Each accepted job records the deposit address shown at the time.

**DAO agencies:** creating the market agent and issuing its grant are the provider's owner intents, which expire in minutes (about 10 for creation, 5 for the grant; MultiAgency/platform#20, a provider limit). A DAO completes them only if its vote passes that fast; Paperwork shows the deadline and prepares the step again after a missed one. Each job's own vote has days.

**Freezing.** The owner can freeze the agency's market agent from its page: the wallet signs it (in Paperwork, or on the platform's confirm page when the provider asks for an on-chain signature), or the DAO votes on it. A freeze stops every provider send of the agent, but not a payment from funds already on its payment key, so Paperwork also approves no job while the agent is frozen. A DAO's own stop page has no time limit but only cuts apps off; it doesn't freeze the agent.

**Not yet:** the worker side and the directory can't run against the stack's simulated market (MultiAgency/platform#68). A DAO's market agent gets its grant and is frozen through Paperwork from platform 0.5.7; on an older platform its setup stops before the grant and says why. See [platform gaps](docs/platform-gaps.md#agent-market-sdk-056-platform-main-7528643), M1–M5.

## Do X → see Y (legacy merge-based browser demo)

Choose **Pay on merge** when creating a job for this walkthrough. The new default report/invoice walkthrough is in [job-demo.md](docs/job-demo.md).

| Do | See |
|---|---|
| `bun run demo`, open http://localhost:3000, **Jobs** → **New job** | A scope of 3 deliverables ($300 + $200 + $500) and a preview of the policy it becomes |
| **Create draft**, sign as `acme.demo` and as `maria.demo` | Both NEP-413 signatures verified |
| Work through the checklist: set up, create the agent, two consents, grant, policy, fund | Each step is one signature from the representative (or the platform's confirm page). The deposit card shows the address; **Fund (demo)** credits exactly the total |
| **Simulate a merge** | The judge sizes the payout; the **Payouts** tab shows it **held for your approval**, with the judge's flags first and the terms the platform proved: payee, USDC, amount, a public withdrawal on NEAR |
| **Approve**, then **Settle approved payouts** | Paid, with the transaction |
| A merge with hidden instructions for the judge | Flagged; **Reject** keeps the PR out of later runs, and nothing moves |
| **Security test** → **Run all** | Redirect refused `payee_not_agreed`, overpay refused `per_transaction_exceeded`, each with the clause it identifies; the injected in-cap payout is not stopped by policy and waits for your approval, the second layer |
| **Policy & verify** → **Open** | The contractor's Verify page: the live policy against the signed terms |

## How it works

The app namespace is `multiagency-paperwork`: platform deployment, stack `--app` value and recipient for terms signatures. The public target is `desk.multiagency.ai`; `paperwork.multiagency.ai` already hosts Documenso and stays separate. The local database is `data/paperwork.sqlite` (`/data/paperwork.sqlite` on the mounted deployment). App-specific environment and browser-storage prefixes are `PAPERWORK_` and `paperwork.`. The repository remains `MultiAgency/demo`.

Each job stores its signing recipient. New jobs use `multiagency-paperwork`; existing rows retain `covenant` and their original complete or partial signatures. The new default database path does not move an old file. To recover old records, use that original file through `DB_PATH`, its original `PLATFORM_DEPLOYMENT` and the credential for that deployment; the app refuses a database/deployment mismatch.

Unsafe historical payment releases also refuse startup. Preserve an offline standalone snapshot and use the [recovery inspection, evidence, private export and disposable rehearsal commands](docs/recovery-acceptance.md). Export creates a separate reviewed bundle. The rehearsal runs separate synthetic working copies; neither command installs or authorizes a real historical database.

New browser state uses `paperwork.*`. Recovery can read a legacy pending submission with its exact saved payload and client key; it does not create a replacement identity. See the [deployment notes](docs/deploy.md#existing-state-during-the-rename).

```
signed scope ──setup──▶ one platform Organization and agent per job
  payee            ──▶ policy withdrawals = [payee]           (provider-enforced)
  signed cap       ──▶ limits.per_transaction = cap           (provider-enforced)
  every payout     ──▶ owner_approval = true                  (held until the company votes)
  end date         ──▶ Paperwork's payout consent expires at the end
  scope total      ──▶ the agent is funded with the total (information on Verify, not a cap)

report + invoice ──▶ assessor proposes ≤ invoice and signed cap ──▶ agency approves
merged PR (Pay on merge) ──precheck──▶ judge ──▶ owed = value × completion − already committed
          ──▶ payouts/request (requestId saved first) ──▶ held ──▶ approval_vote ──▶ settled
```

- **The company approves every payout.** Nothing is paid by default after a report or a merge: the platform's payout policy holds every payout for the owner. The representative approves or rejects each one with an `approval_vote`; the platform checks the vote against the provider's request before the owner signs. A rejected payout's PRs stay out of later runs.
- **Money stays bounded whatever the assessor says.** The policy refuses any other payee and any payment above the signed per-payment cap (the largest deliverable, or the scope total where the terms sign that), and the company approves every payout. Paperwork requests only what is owed against the scope, counting every payout that may have moved. The agent is funded with the scope total and Verify shows paid + balance against it, but that is information, not a cap: the company could deposit more, and the daily and monthly limits reset.
- **Only under the policy both parties signed.** Before every payout request Paperwork checks the whole live policy (actions, assets, owner approval, payee, per-payment, daily and monthly limits, USD budget) against what it signed. Any difference and nothing is requested, with an alert, and Verify turns red. A new revision that still matches (a freeze and unfreeze) is fine. It also checks the payout grant, which the platform issues for 30 days, and asks the representative to issue it again when it runs out.
- **Never twice.** Each attempt is saved with its requestId before the call. A lost reply is followed with `payouts/status`, never resent under a new id. Only a `refused` answer (nothing sent) frees the amount for a new attempt. A `failed` payout stays committed until the representative says whether it arrived.
- **One open judgment per job.** A run while a payout is open waits. A judgment closes approved, rejected, or dropped by the representative.

See [docs/how-it-works.md](docs/how-it-works.md).

### One Organization per job, by default

Paperwork uses one platform Organization per job (organization = the stored job ID) instead of one per company. The platform keeps each Organization's agent separate, so each job gets its own payee list, per-payment cap, balance, consent expiry and freeze. With one shared company agent, the withdrawal list would be every contractor, the cap would have to fit the largest deliverable of any job, and the balance would be pooled.

The limit: the platform hosts at most 16 agents per deployment and never releases them (MultiAgency/platform#46), so one Paperwork deployment can set up at most 16 jobs, ever. Switching to one agent per company means changing `orgFor()` (in `src/server/engine.ts`) and making the policy's payee list every contractor of that company (`policyChanges` and the whole-policy check in `src/shared/policy-request.ts`).

## What we claim, and what we don't

We claim:
- each job has its own platform agent whose policy, read back from the platform, allows only withdrawals of USDC to the payee, no single payment above the signed per-payment cap, and owner approval on every payout;
- Paperwork requests a payout only while the whole live policy matches what both parties signed;
- the agent is funded with the scope total; Verify shows paid + balance against it, as information (the company could deposit more);
- Paperwork's payout consent ends at the job end;
- Paperwork holds no owner key in production (the keyless demo and the local stack use a demo signer);
- a prompt-injected report or PR can mislead the assessor, but the payout still waits for the agency, which sees the assessment and the proven terms.

We don't claim:
- that the assessor's view of the work is correct: the agency decides;
- a cryptographic proof to the contractor: the Verify page relays the platform's read through Paperwork;
- escrow: the company owns the agent, can reject a payout or freeze the agent on the platform's wallet stop page (nothing pays until it unfreezes);
- guaranteed payment for the contractor;
- that the stand-in proves the hosted platform's behaviour. The stack run is local integration evidence; current hosted approval requires a separate authenticated check;
- a mainnet payment: the hosted job's terms are signed on NEAR mainnet, but every recorded payment ran on the stand-in or the platform's local stack, with a simulated chain.

## Sign in with NEAR

Paperwork uses the same sign-in as everything.dev apps: [Better-Auth](https://better-auth.com) with the `siwn` plugin from [better-near-auth](https://www.npmjs.com/package/better-near-auth). Routes live under `/api/auth/*` (`src/server/auth.ts`).

| Action | Who must be signed in |
|---|---|
| Create a job, set it up, check merges, approve or reject, resolve, security test | The representative named in the terms |
| Sign as contractor | The contractor named in the terms (plus their private link) |
| Minimal Verify status | Nobody: public app-relayed checks only |
| Full job and detailed verification | Named representative or builder; owner preparations and deposits remain representative-only |

## Layout

```
src/shared/          terms + canonical hash, money (BigInt), clause mapping, API view types
src/server/platform/ the platform port, SDK client, FakePlatform stand-in, stack reader, chain reader
src/server/market/   agent market: agencies (wallet or DAO), hires, worker (webhooks, jobs, earnings), market API
src/server/          engine, payout state machine, onboarding, judge (rules, NEAR AI Cloud), auth, HTTP API (Hono), SQLite
src/web/             React app: scope editor, setup checklist, dashboard, approval card, contractor signing, Verify, agent market
scripts/             demo-e2e.ts (stand-in), demo-stack.ts (local stack), demo-market.ts (market, local stack), shared scenario
docs/                how-it-works, evidence, platform-gaps
```

## Configuration

See [.env.example](.env.example), and [docs/deploy.md](docs/deploy.md) for the deployed Railway service and its current scope. The defaults run the stand-in with no keys. `PLATFORM=remote` needs `PLATFORM_URL` and the app credential (`PLATFORM_CREDENTIAL_FILE`). The credential stays in server memory: never in `/api/config`, events, logs or URLs.

Optional AI report assessment has a **30-second** deadline covering the request and response body. `PAPERWORK_ASSESSMENT_TIMEOUT_MS` changes that deadline in milliseconds. A timeout records no proposal or payout request and releases the job for agency review; late model responses cannot create a proposal.

## Built with

Bun, TypeScript, Hono, zod, React, `bun:sqlite`, `@multiagency/sdk` 0.6.0 (npm), Better-Auth, better-near-auth, `@noble/curves`, `@noble/hashes`, `@scure/base`, NEAR AI Cloud (optional assessment).

Written with AI assistance.

## License

MIT. See [LICENSE](LICENSE).

### Local Market integration acceptance (2026-11-14)

The SDK pin is npm 0.6.0, byte-identical to candidate `c1a3ae61`'s archive. With a fresh simulated platform stack started with `--app multiagency-paperwork --market`, run:

```bash
PLATFORM_STACK_DIR=<fresh-stack-directory> bun --no-env-file run demo:market
PLATFORM_STACK_DIR=<another-fresh-stack-directory> bun --no-env-file scripts/demo-market.ts --worker
```

Run one owned stack at a time and stop it after its recipe. `demo:market` checks hiring, authorization and settlement. `--worker` also checks worker assignment, submission and acceptance through Paperwork. The replacement `c1a3ae61` simulator supports authenticated immutable history/raw reads. Both normal worker delivery and `--worker-drop-reply` recovery pass with one submission POST under the original fixture hire identity. Historical 404 attempts remain preserved; current checks and exact identities are in `docs/sdk060-local-readiness.json`.

`bun --no-env-file run demo:market:browser` remains a separate fixture-based Market-settled job boundary. It verifies no platform payout, but does not qualify real Market settlement or earnings withdrawal. None of these recipes authorize hosted changes or use of retained funds.

Replacement exact-pair local qualification: [readiness](docs/sdk060-local-readiness.json). Merged as `9842ce9` and deployed to desk.multiagency.ai as `8baf1126` ([receipt](docs/deployment-update-8baf1126.json), [runbook](docs/sdk060-rollout.txt)); the signed-in worker poll read and Market activation remain separate gates. The earlier frozen candidate remains preserved.
