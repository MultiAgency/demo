# How Covenant works

## The idea

Escrow for code, without trusting the escrow agent with the money. A company and a contractor sign a scope of deliverables, each with a value. The scope becomes its own NEAR Intents agent wallet, funded with the total. Every merged PR is judged against the scope, and the agent pays for what the work completed. NEAR enforces the most it could ever pay.

Three separate questions, three separate answers:

| Question | Answered by |
|---|---|
| **When** does money move? | A merged PR (objective, on GitHub) |
| **How much** is the work worth? | The judge, against the signed scope |
| **What's the most** that can move, to whom, until when? | NEAR Intents, from the signed contract |

## Roles

| Role | Does | Holds |
|---|---|---|
| Representative | Drafts and signs the scope, owns and funds the wallet, approves or rejects escalations, can cancel a queued payout or freeze the wallet | The owner key (in their own wallet) |
| Contractor | Signs the same scope, ships PRs, verifies the live wallet | Their own key |
| Agent (Covenant server) | Checks merges, asks the judge, pays the difference | A revocable grant that expires at the contract end |
| Judge | Says how complete each deliverable is | Nothing: it never sees money, amounts or recipients |
| NEAR Intents | Holds the funds, refuses anything outside the policy | — |

## Terms (v2)

Canonical JSON with sorted keys, lowercase accounts and normalized decimals:

```
{ v: 2, company, representative{near_account}, contractor{name, github, near_account},
  payee{chain:"near", address}, asset:<USDC on NEAR>,
  scope: [{ id:"d1", title, criteria, value_usd }, …],     // 1–10 deliverables
  start, end, repos[], acceptance:"merged_to_default_branch_by_other" }
```

`sha256(canonical terms)` is the contract's identity. Both parties sign `Covenant work order sha256:<hash>` with NEP-413 (recipient `covenant`, 32-byte nonce). See `src/shared/terms.ts` and `src/server/nep413.ts`.

## Compiler

`compileContract(terms, hash, {timelockMs})` in `src/shared/compile.ts` is a pure function:

| Clause | Compiles to | Enforced by |
|---|---|---|
| Payee | `destinations: { mode: "only", list: [{ withdraw, near, payee }] }` | NEAR Intents |
| Scope | `limits.per_transaction` = largest deliverable; `limits.monthly` = total; `budget.monthly_usd` = total + 5%; wallet funded with the total | NEAR Intents |
| End date | grant `expires_at` = end date 23:59:59 UTC | NEAR Intents (expired grant) |
| Cancel window | `timelock_ms` (10 min in the demo, 48 h by default for live) | NEAR Intents |
| Payment type | `actions: ["withdraw"]`, `assets: [USDC]`, `owner_approval: false` | NEAR Intents |
| Start date, acceptance, repos | checked before judging | Covenant |
| Completion of each deliverable | judged on every merge | Covenant's judge |

## A payout run

1. **Evidence:** the contractor's merged PRs in the listed repos, across the whole term so far.
2. **Prechecks** (hard rules no judge can override): right author, merged by someone else, listed repo, inside the term. PRs the representative rejected earlier are dropped.
3. **Judge:** completion per deliverable, one of 0, 25, 50, 75, 100%. Completion never goes down, and only judgments that paid, or that the representative approved, carry forward.
4. **Owed** per deliverable = value × completion − already committed (paid, queued, sending, under review).
5. **Escalate or pay:** if any eligible PR is flagged (prompt-injection patterns, or the AI judge's own suspicion or low confidence), every payout from the run waits for the representative. Otherwise each deliverable is its own withdrawal, saved before it is sent, then held in the cancel window.
6. **Resolution:** approving pays it and clears that PR's flag for the future; rejecting excludes that PR for good.

### The judges

- **Rule-based** (`RulesJudge`): reads a `Scope: d2` or `Scope: d2 (done)` line in the PR description. `done` counts as complete, anything else as half. The keyless demo's default, and the fallback with no AI key.
- **NEAR AI Cloud** (`NearAiJudge`, when `NEARAI_API_KEY` is set): an OpenAI-compatible chat completion at `cloud-api.near.ai/v1`, temperature 0, JSON only. PR text is passed as untrusted data, and the system prompt forbids following instructions inside it. The answer is parsed strictly and clamped to known deliverables and allowed levels. Suspicious PRs or low confidence escalate. The model and completion id are kept with the judgment.

## The attack panel

The panel switches off Covenant's own checks and sends requests straight to the provider with the agent's real grant:

| Scenario | Request | Expected refusal |
|---|---|---|
| Overpay | largest deliverable + $1 in one payment | scope clause (`policy_transaction_limit_exceeded`) |
| Redirect | $1 to `attacker.near` | payee clause (`policy_destination_denied`) |
| Injected PR | $5,000 to the payee, as if the AI were fooled | scope clause |
| After end | $1 after the end date | term clause (grant layer) |

Dry runs return warnings and move nothing. Refusals are mapped to clauses by code first, then by layer.

## The simulator

`src/server/provider/sim.ts` implements only the policy features Covenant uses, with shapes and codes taken from the SDK 0.7.3 types (Policy, ErrorDocument layers, dry-run warning codes). Two codes are the simulator's own until the spikes record the real ones: `grant_expired` (layer `grant`) and `agent_frozen` (layer `policy`). The simulator asks for NEP-413 on every owner intent; the real API uses NEP-366 for `agent_create` and `agent_freeze`.

## What we claim, and what we don't

We claim: each contract has its own agent whose policy allows only the payee, no single payment above the largest deliverable, out of a wallet funded with the scope total; the API reports an applied policy equal to the compiled contract; the agent's permission expires at the contract end; the server never holds an owner key; a prompt-injected PR can fool a judge but not the wallet.

We don't claim: that NEAR judges the quality of the work; a cryptographic proof that the policy equals the contract; escrow in the strict sense (the representative still owns the wallet and can freeze it); guaranteed payment for the contractor; cross-chain payouts.
