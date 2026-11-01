# How Covenant works

## The idea

A contract and a wallet are usually two separate things: a document that says what should happen, and a wallet that can do anything. Covenant makes them one thing. Every signed work order gets its own NEAR Intents agent wallet, and the terms become that wallet's spending policy.

## Roles

| Role | Does | Holds |
|---|---|---|
| Representative | Drafts and signs the work order, owns the contract wallet, funds it, can cancel a queued payout or freeze the wallet | The owner key (in their own wallet) |
| Contractor | Signs the same terms, verifies the live wallet | Their own key |
| Agent (Covenant server) | Reviews merged PRs, decides what to pay, sends payouts | A revocable grant that expires at the contract end |
| NEAR Intents | Holds the funds, refuses anything outside the policy | — |

## Terms (v1)

Canonical JSON with sorted keys, lowercase accounts and normalized decimals:

```
{ v, company, representative{near_account}, contractor{name, github, near_account},
  payee{chain:"near", address}, asset:<USDC on NEAR>, monthly_cap_usd, rate_per_accepted_pr_usd,
  start, end, repos[], scope, acceptance:"merged_to_default_branch_by_other" }
```

`sha256(canonical terms)` is the contract's identity. Both parties sign `Covenant work order sha256:<hash>` with NEP-413 (recipient `covenant`, 32-byte nonce). See `src/shared/terms.ts` and `src/server/nep413.ts`.

## Compiler

`compileContract(terms, hash, {timelockMs})` in `src/shared/compile.ts` is a pure function:

| Clause | Compiles to | Enforced by |
|---|---|---|
| Payee | `destinations: { mode: "only", list: [{ withdraw, near, payee }] }` | NEAR Intents |
| Monthly cap | `limits.per_transaction` and `limits.monthly` = cap in atomic USDC; `budget.monthly_usd` = cap + 5% | NEAR Intents |
| End date | grant `expires_at` = end date 23:59:59 UTC | NEAR Intents (expired grant) |
| Cancel window | `timelock_ms` (10 min in the demo, 48 h by default for live) | NEAR Intents |
| Payment type | `actions: ["withdraw"]`, `assets: [USDC]`, `owner_approval: false` | NEAR Intents |
| Start date | the grant is only issued on or after the start date | Covenant |
| Rate, scope, acceptance | checked before every payout | Covenant (the provider still caps the result) |

The 5% budget headroom exists because USDC can trade slightly under $1. The exact atomic monthly limit is the real cap.

## Lifecycle

1. **Draft**: terms validated and hashed.
2. **Sign**: representative and contractor sign the hash. Keys are checked as full-access keys of the named accounts.
3. **Wallet**: `agent_create` with the compiled policy, signed by the representative's wallet.
4. **Grant**: `grant_issue` with `expires_at` = contract end, signed by the representative's wallet. The credential is stored AES-GCM encrypted.
5. **Fund**: USDC deposit to the agent.
6. **Pay**: evidence → prechecks → scorer → amount → persist → withdraw → timelock → paid. The representative can cancel during the timelock.
7. **Verify**: anyone with the link compares the live policy and grant with the compiled contract.
8. **End**: the grant expires; the provider refuses further payouts. Early termination is an owner-signed freeze.

## Payout engine guarantees

- The amount is `min(rate × accepted PRs, cap − already used this month)`. PRs already paid are never counted twice.
- The request and idempotency key are saved before the call. Retries reuse the same key.
- A provider refusal becomes `refused`. A network error or unknown outcome becomes `needs_review` and is never resent automatically.
- An escalation (for example a PR that tries to instruct the reviewer) waits for the representative. Flagged PRs stay excluded if approved. This gate is Covenant's, not the provider's.

## The attack panel

The panel switches off Covenant's own checks and sends requests straight to the provider with the agent's real grant:

| Scenario | Request | Expected refusal |
|---|---|---|
| Overpay | cap + $1 to the payee | cap clause (`policy_transaction_limit_exceeded` and/or budget layer) |
| Redirect | $1 to `attacker.near` | payee clause (`policy_destination_denied`) |
| Injected PR | $5,000 to the payee, as if the AI were fooled | cap clause |
| After end | $1 after the end date | term clause (grant layer) |

Dry runs return warnings and move nothing. Refusals are mapped to clauses by code first, then by layer, because the provider may report a cap breach as a generic `policy_denied`.

## The simulator

`src/server/provider/sim.ts` implements only the policy features Covenant uses, with shapes and codes taken from the SDK 0.7.3 types (Policy, ErrorDocument layers, dry-run warning codes). Two codes are the simulator's own until the spikes record the real ones: `grant_expired` (layer `grant`) and `agent_frozen` (layer `policy`). The simulator asks for NEP-413 on every owner intent; the real API uses NEP-366 for `agent_create` and `agent_freeze`.

## What we claim, and what we don't

We claim: each contract has its own agent whose policy allows only the payee and only up to the cap; the API reports an applied policy equal to the compiled contract; the agent's permission expires at the contract end; the server never holds an owner key.

We don't claim: that NEAR enforces scope, rate or acceptance; a cryptographic proof that the policy equals the contract; escrow or guaranteed payment for the contractor; cross-chain payouts.
