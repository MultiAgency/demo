# Covenant

**The contract is the spending limit.**

Covenant pays for merged work, judged against a signed scope. A company and a contractor sign a scope of deliverables, each with a value. The scope becomes its own NEAR Intents agent wallet, funded with the total. Every time one of the contractor's PRs is merged, an AI judge decides how complete each deliverable now is, and the agent pays the difference. NEAR enforces the hard limits: only the payee, no payment above the largest deliverable, never more than the scope, nothing after the end date.

> The AI decides how much. The contract decides the most it could ever be.

Tracks: Real-World Money, AI Security & Defense.

## Run it (no keys, no network)

```bash
bun install
bun run demo:e2e
```

Expected: 13 numbered steps, each with ✓ lines, ending in `✓ All steps passed. Paid for the scope, never more.` and exit code 0. Everything runs against a local simulator with a throwaway demo wallet and the rule-based judge. Tx hashes start with `SIMULATED-`.

```bash
bun test          # money, hashing, compiler, NEP-413, simulator rules, scope payouts, escalations, auth
bun run demo      # the same flow in the browser at http://localhost:3000
bun run typecheck
```

Requires Bun 1.4+.

## Do X → see Y

| Do | See |
|---|---|
| `bun run demo`, open http://localhost:3000, click **Create a contract** | A scope of 3 deliverables ($300 + $200 + $500) and a live preview of the wallet it compiles to |
| **Create draft**, then **Sign as acme.demo** and **Sign as maria.demo** | Both NEP-413 signatures verified. The contractor's own signing page (scope list, values) is behind **Open** |
| **Create wallet**, **Issue grant**, **Deposit (simulated)** | The dashboard, with the **Scope** scoreboard |
| **Check merges** | d1 100%, d2 50%, d3 50%: three payouts ($300, $100, $250), each in its cancel window. Three PRs listed as not counted, with reasons |
| **Skip timelock**, then **Simulate a merge** | The PR that finishes d2 lands: $100 more, only the difference |
| **Simulate a merge** again | A PR with hidden instructions for the AI: flagged in amber, $250 for d3 **needs review** instead of paying |
| **Payouts** tab → **Reject**, then **Simulate a merge** | The rejected PR is out for good; the real d3 completion pays $250. Scope fully paid: $1,000 of $1,000 |
| **Security test** tab → **Run all** | Overpay, redirect, prompt injection, after the end: each blocked, tagged with the clause it enforces |
| **Policy & verify** tab → **Open** | The contractor's Verify page: "Matches what you signed" |

## How it works

```
signed scope ──compile──▶ one agent wallet per contract, funded with the total
  payee                ──▶ policy.destinations = only [payee]
  deliverables         ──▶ policy.limits.per_transaction = largest deliverable (one payment per deliverable)
                           policy.limits.monthly = total; budget.monthly_usd = total + 5% (backstop)
  end date             ──▶ grant.expires_at = end date 23:59:59 UTC
  (cancel window)      ──▶ policy.timelock_ms
                           actions = [withdraw], assets = [USDC], owner_approval = false

merged PR ──precheck──▶ judge ──▶ completion per deliverable (0, 25, 50, 75, 100%)
          owed = value × completion − already paid  ──▶ one withdrawal per deliverable ──▶ NEAR checks the policy
```

- **Trigger:** a merged PR by the contractor, merged by someone else, in a listed repo, inside the term. `AGENT_POLL_MS` checks for merges on a timer; **Check merges** runs it on demand.
- **Measure:** the judge reads the merged PRs against each deliverable's acceptance criteria. With `NEARAI_API_KEY` set it's a model on **NEAR AI Cloud** (`cloud-api.near.ai`); otherwise a rule-based judge that reads `Scope: d2` / `Scope: d2 (done)` lines. PR text is treated as untrusted data. Suspicion or low confidence escalates instead of paying.
- **Bound:** whatever the judge says, NEAR Intents only lets the agent pay the payee, at most the largest deliverable per payment, out of a wallet holding the scope total, before the end date.
- **Never backwards, never twice:** completion only goes up, and only judgments that paid (or that the representative approved) carry forward. A rejected PR is excluded from all future runs.
- **Escrow-like, not escrow:** payment is the default after a merge, and the representative can cancel in the window. The representative still owns the wallet and can freeze it; the contractor's Verify page shows it if they do.
- **Persist, then send:** each payout's request and idempotency key are saved before the call. A refusal is recorded as `refused`; an unknown outcome becomes `needs_review` and is never resent automatically.

See [docs/how-it-works.md](docs/how-it-works.md).

## Sign in with NEAR

Covenant uses the same sign-in as everything.dev apps: [Better-Auth](https://better-auth.com) with the `siwn` plugin from [better-near-auth](https://www.npmjs.com/package/better-near-auth). The wallet signs `Sign in to multiagentic.near` (NEP-413); the server verifies it, checks the key is a full-access key, and sets a session cookie. Routes live under `/api/auth/*` (`src/server/auth.ts`).

| Action | Who must be signed in |
|---|---|
| Create a contract, set up its wallet, check merges, approve or reject, cancel, freeze, security test | The representative named in the terms |
| Sign as contractor | The contractor named in the terms (plus their private link) |
| Verify page | Nobody: it's public |

Sign-in is always required with `PROVIDER=live`. The keyless simulator leaves it optional (set `REQUIRE_AUTH=true` to try it). `bos.app.ts` registers the app on everything.dev, extending `bos://dev.everything.near/dev.everything.dev` under `multiagentic.near`.

## Status

| Part | State |
|---|---|
| Signed scope, hashing, NEP-413 two-party signing, compiler, policy diff | Done, tested |
| Scope payouts: judge, per-deliverable withdrawals, carry-forward, escalation memory, timelock, cancel, freeze | Done, tested against the simulator |
| Rule-based judge; NEAR AI Cloud judge (OpenAI-compatible) | Done; the NEAR AI judge needs `NEARAI_API_KEY` and is not yet exercised against the live API |
| Sign in with NEAR (Better-Auth + better-near-auth) | Done; wallet round trip to be tested against mainnet RPC |
| UI: scope editor, setup checklist, dashboard + scoreboard, contractor signing, Verify, security test | Done |
| Live adapter for the NEAR Intents Agent API (mainnet) | Next: after spikes SP0–SP4, see [docs/spikes.md](docs/spikes.md) |
| Mainnet evidence (tx links, recorded refusals) | [docs/evidence.md](docs/evidence.md), filled during the build |

`PROVIDER=live` refuses to start until the live adapter is in place.

## Layout

```
src/shared/     terms (signed scope) + canonical hash, money (BigInt), compiler, clause mapping
src/server/     engine (contracts, signatures, owner intents, scope payouts, verify, attacks), judge (rules,
                NEAR AI Cloud), auth (Better-Auth + SIWN), HTTP API (Hono), NEP-413, SQLite store,
                AES-GCM secret box, provider port + simulator, GitHub evidence
src/web/        React app: scope editor, setup checklist, dashboard, contractor signing, Verify, guide
scripts/        demo-e2e.ts
tests/          bun test suites
docs/           how-it-works, spikes, evidence
bos.app.ts      everything.dev identity
```

## Configuration

See [.env.example](.env.example). Defaults run the simulator with no keys. `ALLOW_WRITES` must be `true` before any live payout is sent.

## Built with

Bun, TypeScript, Hono, zod, React, `bun:sqlite`, Better-Auth, better-near-auth, `@noble/curves`, `@noble/hashes`, `@scure/base`, `@near-intents-agent-api/sdk` 0.7.3 (types now, live adapter next), NEAR AI Cloud (optional judge).

Written with AI assistance (Claude Code).

## License

MIT. See [LICENSE](LICENSE).
