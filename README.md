# Covenant

**The contract is the spending limit.**

Covenant is MultiAgency's payroll app for pay-on-merge contracts. A company and a contractor sign a scope of deliverables, each with a value. Covenant sets the contract up on the [MultiAgency platform](https://github.com/MultiAgency/platform) through `@multiagency/sdk`: an agent made for this contract, whose signed policy pays only the contractor, never more than the largest deliverable in one payment, funded with exactly the scope total. Every time one of the contractor's PRs is merged, a judge decides how complete each deliverable is, Covenant requests the difference, and the platform holds that payout until the company approves it.

> The judge decides how much. The company approves each payout. The contract decides the most it could ever be.

Covenant's server holds only its app credential. It never holds an owner key or a provider key.

Tracks: Real-World Money, AI Security & Defense.

## Run it

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

Requires Bun 1.4+.

### Against the local platform stack

The platform repo ships an isolated stack (gateway, confirm page, provider simulator, local chain). `demo:stack` drives one contract end to end against it, headless:

```bash
# in the platform checkout
pnpm install && pnpm build:web
pnpm test:e2e:stack --app covenant --no-browser --owner acme.demo --payee maria.demo --builder attacker.demo
# wait for "Isolated stack ready: <dir>/state.json", then in this repo:
PLATFORM_STACK_DIR=<dir> bun run demo:stack
touch <dir>/stop
```

It reads the stack's `state.json` (gateway URL, app credential file, TLS certificate, chain RPC), starts Covenant with `PLATFORM=remote`, and runs the same scenario as `demo:e2e`: setup, consents, grant, policy, funding with exactly the total, a judged payout held, approved and settled, an injected payout held and rejected, and the policy refusing the redirect and overpay attacks. The recorded run is in [docs/evidence.md](docs/evidence.md).

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
  scope total      ──▶ the agent is funded with exactly the total

merged PR ──precheck──▶ judge ──▶ owed = value × completion − already committed
          ──▶ payouts/request (requestId saved first) ──▶ held ──▶ approval_vote ──▶ settled
```

- **The company approves every payout.** Nothing is paid by default after a merge: the platform's payout policy holds every payout for the owner. The representative approves or rejects each one with an `approval_vote`; the platform checks the vote against the provider's request before the owner signs. A rejected payout's PRs stay out of later runs.
- **Money stays bounded whatever the judge says.** The policy refuses any other payee and any payment above the largest deliverable. The agent holds exactly the scope total, so it can't pay more than the contract: the daily and monthly limits reset and are not what caps it.
- **Never twice.** Each attempt is saved with its requestId before the call. A lost reply is followed with `payouts/status`, never resent under a new id. Only a `refused` answer (nothing sent) frees the amount for a new attempt. A `failed` payout stays committed until the representative says whether it arrived.
- **One open judgment per contract.** A run while a payout is open waits. A judgment closes approved, rejected, or dropped by the representative.

See [docs/how-it-works.md](docs/how-it-works.md).

### One Organization per contract, by default

Covenant uses one platform Organization per contract (organization = contract id) instead of one per company. The platform keeps each Organization's agent separate, so each contract gets its own payee list, per-payment cap, balance, consent expiry and freeze. With one shared company agent, the withdrawal list would be every contractor, the cap would have to fit the largest deliverable of any contract, and the balance would be pooled. Switching to one agent per company is one function (`orgFor`) plus a union of payees in the policy edit; we left it out this week. The cost of the default (agents per deployment are limited and never released) is filed in [docs/platform-gaps.md](docs/platform-gaps.md).

## What we claim, and what we don't

We claim:
- each contract has its own platform agent whose policy, read back from the platform, allows only withdrawals of USDC to the payee, no single payment above the largest deliverable, and owner approval on every payout;
- the agent is funded with the scope total, so paid + balance never exceeds it;
- Covenant's payout consent ends at the contract end;
- Covenant holds no owner key;
- a prompt-injected PR can fool the judge, but the payout still waits for the company, which sees the judge's flags and the proven terms.

We don't claim:
- that anything judges the quality of the work but the judge;
- a cryptographic proof to the contractor: the Verify page relays the platform's read through Covenant;
- escrow: the company owns the agent, can reject a payout or freeze the agent;
- guaranteed payment for the contractor;
- that the stand-in proves the hosted platform's behaviour. The stack run is the integration evidence; hosted platforms get held-withdrawal approval with the 0.5.5 deploy.

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
src/server/          engine, payout state machine, onboarding, judge (rules, NEAR AI Cloud), auth, HTTP API (Hono), SQLite
src/web/             React app: scope editor, setup checklist, dashboard, approval card, contractor signing, Verify
scripts/             demo-e2e.ts (stand-in), demo-stack.ts (local stack), shared scenario
docs/                how-it-works, evidence, platform-gaps
```

## Configuration

See [.env.example](.env.example). The defaults run the stand-in with no keys. `PLATFORM=remote` needs `PLATFORM_URL` and the app credential (`PLATFORM_CREDENTIAL_FILE`). The credential stays in server memory: never in `/api/config`, events, logs or URLs.

## Built with

Bun, TypeScript, Hono, zod, React, `bun:sqlite`, `@multiagency/sdk` 0.5.4, Better-Auth, better-near-auth, `@noble/curves`, `@noble/hashes`, `@scure/base`, NEAR AI Cloud (optional judge).

Written with AI assistance.

## License

MIT. See [LICENSE](LICENSE).
