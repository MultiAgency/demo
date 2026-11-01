# Covenant

**The contract is the spending limit.**

Covenant is contractor payroll on NEAR. Each signed work order becomes its own NEAR Intents agent wallet. The payee, the monthly cap and the end date are compiled from the contract into that wallet's policy and grant, and the provider enforces them. An agent reviews the contractor's merged pull requests and pays on its own, and neither the agent nor our server can overpay, pay someone else, or pay after the contract ends.

Tracks: Real-World Money, AI Security & Defense.

## Run it (no keys, no network)

```bash
bun install
bun run demo:e2e
```

Expected: 11 numbered steps, each with ✓ lines, ending in `✓ All steps passed. The contract was the spending limit.` and exit code 0. Everything runs against a local simulator with a throwaway demo wallet. Tx hashes start with `SIMULATED-`.

```bash
bun test          # 34 tests: money, hashing, compiler, NEP-413, simulator rules, payout engine
bun run demo      # the same flow in the browser at http://localhost:3000 (step-by-step wizard)
bun run typecheck
```

Requires Bun 1.4+.

## Do X → see Y

| Do | See |
|---|---|
| `bun run demo`, open http://localhost:3000, click **Create a contract** | A form prefilled with a demo work order (Acme Labs → Maria, $10/PR, $50/month limit) and a live preview of the wallet it compiles to |
| **Create draft** | The setup checklist: 5 steps, the current one highlighted |
| **Sign as acme.demo**, then **Sign as maria.demo** | Both NEP-413 signatures verified against full-access keys. The contractor's own signing page is behind **Open** |
| **Create wallet** | The wallet policy card goes live: only the payee, at most the limit, 10-minute cancel window |
| **Issue grant** | The agent's permission, expiring at the contract end (23:59:59 UTC on the end date) |
| **Deposit (simulated)** | The contract dashboard: balance, used this month, end date |
| **Run agent** | 4 of 6 PRs accepted (one self-merged, one outside the contract's repos), $40 in its timelock with a **Cancel payout** button |
| **Skip timelock** | Status **Paid**, tx `SIMULATED-…` |
| **Security test** tab → **Run all** (then **Jump past end date** and run **After the end**) | Every bad payout blocked, each tagged with the clause it enforces |
| **Policy & verify** tab → **Open** | The contractor's Verify page: "Matches what you signed" |

## How it works

```
signed terms ──compile──▶ one agent per contract
  payee               ──▶ policy.destinations = only [payee]
  monthly cap         ──▶ policy.limits.per_transaction = limits.monthly = cap (USDC, exact)
                          policy.budget.monthly_usd = cap + 5% (backstop)
  end date            ──▶ grant.expires_at = end date 23:59:59 UTC
  (cancel window)     ──▶ policy.timelock_ms
                          actions = [withdraw], assets = [USDC], owner_approval = false
```

- **Two-party signing.** Representative and contractor sign `Covenant work order sha256:<hash of canonical terms>` with their NEAR wallets (NEP-413). The server verifies the ed25519 signature and that the key is a full-access key of the account.
- **One wallet per contract, never edited.** Changing a contract means signing a new one. This keeps "live policy == compiled contract" true and checkable.
- **The owner key never touches the server.** Every owner action (create, grant, cancel, freeze) is prepared by the server and signed in the representative's wallet.
- **The agent decides, the policy limits.** The scorer decides which PRs count and whether to pay or escalate. Code computes the amount (rate × accepted, never above what is left under the cap). The provider refuses anything outside the policy.
- **Persist, then send.** Each payout's request and idempotency key are saved before the call. A refusal is recorded as `refused`; an unknown outcome becomes `needs_review` and is never resent automatically.

What NEAR Intents enforces: payee, cap, end date (through grant expiry), timelock. What Covenant checks before sending: rate, scope, acceptance rule, start date. See [docs/how-it-works.md](docs/how-it-works.md).

## Status

| Part | State |
|---|---|
| Terms, hashing, NEP-413 verification, compiler, policy diff | Done, tested |
| Payout engine (persist-then-send, idempotency, timelock, cancel, escalation, freeze) | Done, tested against the simulator |
| UI: setup checklist, contract dashboard, contractor signing page, Verify page, security test | Done |
| Keyless headless demo (`demo:e2e`) | Done |
| Live adapter for the NEAR Intents Agent API (mainnet) | Next: after spikes SP0–SP4, see [docs/spikes.md](docs/spikes.md) |
| Browser wallet signing (near-connect) | Next, with the live adapter |
| AI scorer (Claude) | Next; the deterministic scorer is the fallback and the demo default |
| Mainnet evidence (tx links, recorded refusals) | [docs/evidence.md](docs/evidence.md), filled during the build |

`PROVIDER=live` refuses to start until the live adapter is in place.

## Layout

```
src/shared/     terms schema + canonical hash, money (BigInt), compiler, clause mapping
src/server/     engine (contracts, signatures, owner intents, payouts, verify, attacks), HTTP API (Hono),
                NEP-413, SQLite store, AES-GCM secret box, provider port + simulator, GitHub evidence, scorer
src/web/        React wizard, contractor signing page, Verify page, guide
scripts/        demo-e2e.ts
tests/          bun test suites
docs/           how-it-works, spikes, evidence
```

## Configuration

See [.env.example](.env.example). Defaults run the simulator with no keys. `ALLOW_WRITES` must be `true` before any live payout is sent.

## Built with

Bun, TypeScript, Hono, zod, React, `bun:sqlite`, `@noble/curves`, `@noble/hashes`, `@scure/base`, `@near-intents-agent-api/sdk` 0.7.3 (types now, live adapter next).

Written with AI assistance (Claude Code).

## License

MIT. See [LICENSE](LICENSE).
