# Covenant

**The contract is the spending limit.**

Covenant is MultiAgency's payroll app for pay-on-merge contracts. A company and a contractor sign a scope of deliverables, each with a value. Covenant sets the contract up on the [MultiAgency platform](https://github.com/MultiAgency/platform) through `@multiagency/sdk`: an agent made for this contract, whose signed policy pays only the contractor, never more than the largest deliverable in one payment, funded with the scope total. Every time one of the contractor's PRs is merged, a judge decides how complete each deliverable is, Covenant requests the difference, and the platform holds that payout until the company approves it.

> The judge decides how much. The company approves each payout. The contract decides the most it could ever be.

Covenant's server holds only its app credential. In production it never holds an owner or provider key; the keyless demo and the local stack use a demo signer.

Tracks: Real-World Money, AI Security & Defense.

## Run it

Prerequisites: Bun 1.4+ (if `bun install` says "Unknown lockfile version", run `bun upgrade`).

### Keyless, on the platform stand-in

```bash
bun install
bun run demo:e2e
```

The whole flow runs in about 10 seconds with no keys and no network, against `FakePlatform`, an in-process stand-in that follows the platform's rules (requestIds, `held`, `refused` codes, approval votes). The output starts with a "platform stand-in" banner and ends with every step passing. It is a stand-in: it does not prove anything about the hosted platform.

```bash
bun test          # money, hashing, NEP-413, clauses, payout state machine, onboarding, platform stand-in, auth
bun run demo      # the same flow in the browser at http://localhost:3000, on the stand-in
bun run typecheck
```

If port 3000 is taken: `PORT=3001 bun run demo`.

### Against the local platform stack

The platform repo ships an isolated stack (gateway, confirm page, provider simulator, local chain). `demo:stack` drives one contract end to end against it, headless. It needs a clone of [MultiAgency/platform](https://github.com/MultiAgency/platform), Node 24 and pnpm (`corepack enable`):

```bash
git clone https://github.com/MultiAgency/platform && cd platform
corepack enable
pnpm install && pnpm build:web
pnpm test:e2e:stack --app covenant --no-browser --owner acme.demo --payee maria.demo --builder attacker.demo
# wait for "Isolated stack ready: <dir>/state.json", then in this repo:
PLATFORM_STACK_DIR=<dir> bun run demo:stack
touch <dir>/stop
```

It reads the stack's `state.json` (gateway URL, app credential file, TLS certificate, chain RPC), starts Covenant with `PLATFORM=remote`, and runs the same scenario as `demo:e2e`: setup, consents, grant, policy, funding with the total, a judged payout held, approved and settled, an injected payout held and rejected, and the policy refusing the redirect and overpay attacks. The stack simulates the provider, chain and signatures (every owner signature is the stack's fixture key). The recorded run is in [docs/evidence.md](docs/evidence.md).

### Platform version

Approving a held withdrawal needs platform 0.5.5 (MultiAgency/platform#42); production runs 0.5.4 until 0.5.5 is deployed. Covenant pins `@multiagency/sdk` 0.5.6; the local stack above runs a platform that already has 0.5.5. The owner's freeze link (the platform's wallet stop page) and recovering a lost setup reply through `reservations` also need 0.5.5; on 0.5.4 a lost setup reply shows the setup error as before.

## Hire and work on the agent market

Agencies take both sides of the [NEAR AI Agent Market](https://market.near.ai): they hire listed agents, and their own listed agent takes jobs. Each agency has one market agent on the platform (area `market`), owned by a wallet or a Sputnik DAO. Market hires run only against the platform or its local stack: there is no stand-in for them.

```bash
# in the platform checkout (Node 24)
pnpm test:e2e:stack --app covenant --market --no-browser                  # a wallet agency
pnpm test:e2e:stack --app covenant --market --dao-treasury --no-browser   # and a DAO agency
# then in this repo
PLATFORM_STACK_DIR=<dir> bun run demo:market     # headless: Covenant's own API end to end
PLATFORM=remote PLATFORM_STACK_DIR=<dir> bun run demo   # the browser: Agent market
```

**Hiring (client side).** Pick a listed agent (the market's public directory, or a handle), write the brief, and ask for a quote: the platform answers the hire terms (agent, amount, the market's published payee, the brief's sha256, the window). Each job gets its id when it is quoted, saved before anything is asked. A wallet owner approves by hiring; a DAO approves by its vote on the exact terms, filed by the platform, and the platform pays only after the vote passes, after a fresh quote that must match. Each job is then followed with `market/status`: `paid`, `not_charged`, `refused` (nothing sent), or `unknown`, which waits, and is never retried under a new id. The deliverable is shown beside the terms it was paid under. An x402 job is accepted the moment the agent delivers, with no rework and no dispute, so the approval before paying is the only gate.

**Working (worker side).** Configure one agency's listed agent with `MARKET_AGENT_TOKEN` (its `aat_` token), `MARKET_WEBHOOK_SECRET` and `MARKET_WORKER_AGENCY`. Covenant verifies each `hire.*` webhook (`sha256=` HMAC of `<timestamp>.<raw body>`, within 300 s), drops repeated deliveries, and polls the agent's assignments as well, since a webhook can be lost or arrive out of order. A person at the agency writes each deliverable; Covenant never hands a buyer's brief to a model or acts on what it says. Earnings stay in the market account until its owner withdraws them: Covenant shows the market agent's deposit address, whether it is registered on USDC, and the registration transaction, since the market refuses to withdraw to an unregistered account. Each accepted job records the deposit address shown at the time.

**DAO agencies:** creating the market agent and issuing its grant are the provider's owner intents, which expire in minutes (about 10 for creation, 5 for the grant; MultiAgency/platform#20, a provider limit). A DAO completes them only if its vote passes that fast; Covenant shows the deadline and prepares the step again after a missed one. Each job's own vote has days.

**Freezing.** The owner can freeze the agency's market agent from its page: the wallet signs it (in Covenant, or on the platform's confirm page when the provider asks for an on-chain signature), or the DAO votes on it. A freeze stops every provider send of the agent, but not a payment from funds already on its payment key, so Covenant also approves no job while the agent is frozen. A DAO's own stop page has no time limit but only cuts apps off; it doesn't freeze the agent.

**Not yet:** the worker side and the directory can't run against the stack's simulated market, and a DAO's market agent stops before its grant and can't be frozen through Covenant yet. See [platform gaps](docs/platform-gaps.md#agent-market-sdk-056-platform-main-7528643), M1–M5.

## Do X → see Y (browser demo)

| Do | See |
|---|---|
| `bun run demo`, open http://localhost:3000, **Create a contract** | A scope of 3 deliverables ($300 + $200 + $500) and a preview of the policy it becomes |
| **Create draft**, sign as `acme.demo` and as `maria.demo` | Both NEP-413 signatures verified |
| Work through the checklist: set up, create the agent, two consents, grant, policy, fund | Each step is one signature from the representative (or the platform's confirm page). The deposit card shows the address; **Fund (demo)** credits exactly the total |
| **Simulate a merge** | The judge sizes the payout; the **Payouts** tab shows it **held for your approval**, with the judge's flags first and the terms the platform proved: payee, USDC, amount, a public withdrawal on NEAR |
| **Approve**, then **Settle approved payouts** | Paid, with the transaction |
| A merge with hidden instructions for the judge | Flagged; **Reject** keeps the PR out of later runs, and nothing moves |
| **Security test** → **Run all** | Redirect refused `payee_not_agreed`, overpay refused `per_transaction_exceeded`, each with the clause it identifies; the injected in-cap payout is not stopped by policy and waits for your approval, the second layer |
| **Policy & verify** → **Open** | The contractor's Verify page: the live policy against the signed terms |

## How it works

```
signed scope ──setup──▶ one platform Organization and agent per contract
  payee            ──▶ policy withdrawals = [payee]           (provider-enforced)
  largest item     ──▶ limits.per_transaction = largest       (provider-enforced)
  every payout     ──▶ owner_approval = true                  (held until the company votes)
  end date         ──▶ Covenant's payout consent expires at the end
  scope total      ──▶ the agent is funded with the total (information on Verify, not a cap)

merged PR ──precheck──▶ judge ──▶ owed = value × completion − already committed
          ──▶ payouts/request (requestId saved first) ──▶ held ──▶ approval_vote ──▶ settled
```

- **The company approves every payout.** Nothing is paid by default after a merge: the platform's payout policy holds every payout for the owner. The representative approves or rejects each one with an `approval_vote`; the platform checks the vote against the provider's request before the owner signs. A rejected payout's PRs stay out of later runs.
- **Money stays bounded whatever the judge says.** The policy refuses any other payee and any payment above the largest deliverable, and the company approves every payout. Covenant requests only what is owed against the scope, counting every payout that may have moved. The agent is funded with the scope total and Verify shows paid + balance against it, but that is information, not a cap: the company could deposit more, and the daily and monthly limits reset.
- **Only under the policy both parties signed.** Before every payout request Covenant checks the whole live policy (actions, assets, owner approval, payee, per-payment, daily and monthly limits, USD budget) against what it signed. Any difference and nothing is requested, with an alert, and Verify turns red. A new revision that still matches (a freeze and unfreeze) is fine. It also checks the payout grant, which the platform issues for 30 days, and asks the representative to issue it again when it runs out.
- **Never twice.** Each attempt is saved with its requestId before the call. A lost reply is followed with `payouts/status`, never resent under a new id. Only a `refused` answer (nothing sent) frees the amount for a new attempt. A `failed` payout stays committed until the representative says whether it arrived.
- **One open judgment per contract.** A run while a payout is open waits. A judgment closes approved, rejected, or dropped by the representative.

See [docs/how-it-works.md](docs/how-it-works.md).

### One Organization per contract, by default

Covenant uses one platform Organization per contract (organization = contract id) instead of one per company. The platform keeps each Organization's agent separate, so each contract gets its own payee list, per-payment cap, balance, consent expiry and freeze. With one shared company agent, the withdrawal list would be every contractor, the cap would have to fit the largest deliverable of any contract, and the balance would be pooled.

The limit: the platform hosts at most 16 agents per deployment and never releases them (MultiAgency/platform#46), so one Covenant deployment can set up at most 16 contracts, ever. Switching to one agent per company means changing `orgFor()` (in `src/server/engine.ts`) and making the policy's payee list every contractor of that company (`policyChanges` and the whole-policy check in `src/shared/policy-request.ts`).

## What we claim, and what we don't

We claim:
- each contract has its own platform agent whose policy, read back from the platform, allows only withdrawals of USDC to the payee, no single payment above the largest deliverable, and owner approval on every payout;
- Covenant requests a payout only while the whole live policy matches what both parties signed;
- the agent is funded with the scope total; Verify shows paid + balance against it, as information (the company could deposit more);
- Covenant's payout consent ends at the contract end;
- Covenant holds no owner key in production (the keyless demo and the local stack use a demo signer);
- a prompt-injected PR can fool the judge, but the payout still waits for the company, which sees the judge's flags and the proven terms.

We don't claim:
- that anything judges the quality of the work but the judge;
- a cryptographic proof to the contractor: the Verify page relays the platform's read through Covenant;
- escrow: the company owns the agent, can reject a payout or freeze the agent on the platform's wallet stop page (nothing pays until it unfreezes);
- guaranteed payment for the contractor;
- that the stand-in proves the hosted platform's behaviour. The stack run is the integration evidence; hosted platforms get held-withdrawal approval with the 0.5.5 deploy;
- a mainnet run: the recorded runs are on the platform's local stack, with a simulated chain.

## What's NEAR here

- **Two-party signing with NEP-413.** Both parties sign the terms hash with their NEAR wallet; Covenant checks each signature against a full-access key of the account. The company also signs every platform owner step (setup, consents, grant, policy, approvals) with NEP-413.
- **Sign in with NEAR** through Better-Auth and [better-near-auth](https://www.npmjs.com/package/better-near-auth).
- **USDC on NEAR**, paid out through the MultiAgency platform's NEAR Intents agent: one agent per contract, withdrawals only to the payee's NEAR account.
- **NEAR AI Cloud** judges the merged work when `NEARAI_API_KEY` is set; otherwise a rule-based judge runs.

The recorded runs are on the platform's local stack (simulated provider and chain), not mainnet.

## Sign in with NEAR

Covenant uses the same sign-in as everything.dev apps: [Better-Auth](https://better-auth.com) with the `siwn` plugin from [better-near-auth](https://www.npmjs.com/package/better-near-auth). Routes live under `/api/auth/*` (`src/server/auth.ts`).

| Action | Who must be signed in |
|---|---|
| Create a contract, set it up, check merges, approve or reject, resolve, security test | The representative named in the terms |
| Sign as contractor | The contractor named in the terms (plus their private link) |
| Verify page | Nobody: it's public |

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

See [.env.example](.env.example), and [docs/deploy.md](docs/deploy.md) for Railway (not deployed yet). The defaults run the stand-in with no keys. `PLATFORM=remote` needs `PLATFORM_URL` and the app credential (`PLATFORM_CREDENTIAL_FILE`). The credential stays in server memory: never in `/api/config`, events, logs or URLs.

## Built with

Bun, TypeScript, Hono, zod, React, `bun:sqlite`, `@multiagency/sdk` 0.5.6, Better-Auth, better-near-auth, `@noble/curves`, `@noble/hashes`, `@scure/base`, NEAR AI Cloud (optional judge).

Written with AI assistance.

## License

MIT. See [LICENSE](LICENSE).
