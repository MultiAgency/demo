# How Covenant works

## The idea

A company and a contractor sign a scope of deliverables, each with a value. Covenant turns the signed scope into a MultiAgency platform agent made for that contract, funded with the total. Every merged PR is judged against the scope; Covenant requests what the work completed; the platform holds the payout until the company approves it, and refuses anything outside the contract's policy.

| Question | Answered by |
|---|---|
| **When** is a payout requested? | A merged PR (objective, on GitHub) |
| **How much** is the work worth? | The judge, against the signed scope |
| **Does this payout go out?** | The company, voting on the held payout |
| **What's the most** that can move, to whom? | The platform policy and the funded total |

## Roles

| Role | Does | Holds |
|---|---|---|
| Representative | Drafts and signs the scope, owns and funds the agent, approves or rejects every payout | The owner key, in their own wallet |
| Contractor | Signs the same scope, ships PRs, verifies the live policy | Their own key |
| Covenant (app) | Checks merges, asks the judge, requests payouts, prepares owner steps for the representative to sign | The app credential only |
| Judge | Says how complete each deliverable is | Nothing: it never sees money or recipients |
| MultiAgency platform | Holds the agent's policy and funds, refuses what the policy forbids, holds every payout for approval | — |

## Terms (v2)

Canonical JSON with sorted keys, lowercase accounts and normalized decimals:

```
{ v: 2, company, representative{near_account}, contractor{name, github, near_account},
  payee{chain:"near", address}, asset:<USDC on NEAR>,
  scope: [{ id:"d1", title, criteria, value_usd }, …],     // 1–10 deliverables
  start, end, repos[], acceptance:"merged_to_default_branch_by_other" }
```

`sha256(canonical terms)` is the contract's identity. Both parties sign `Covenant work order sha256:<hash>` with NEP-413 (recipient `covenant`, 32-byte nonce). See `src/shared/terms.ts` and `src/server/nep413.ts`. Signing the terms makes no platform call.

## Setting up a contract on the platform

Each contract is its own platform Organization (`organization = contract id`). The representative signs each step; Covenant never signs as the owner.

| # | Step | Platform call |
|---|---|---|
| 1 | Set up | The representative signs a setup message for the `payables` area; `setup` reserves the Organization's agent |
| 2 | Create | `owner/prepare agent_create` (role `payout`), signed by the representative |
| 3 | Consents | `[payout]` until the contract end; `[owner, read]` until the end plus a grace period, so held payouts can still be voted on |
| 4 | Grant | `owner/prepare grant_issue` (label `payout`) |
| 5 | Policy | One `owner/prepare policy_update`: `withdrawals: [payee]`, `owner_approval: true`, `limits.per_transaction` = largest deliverable, daily and monthly = total, a USD budget sized from the total |
| 6 | Fund | `deposit` gives a one-time address; the representative sends exactly the scope total |

An owner step is either a NEP-413 message the representative signs, or a link to the platform's confirm page. A lost reply is answered by reading the step's status, never by signing again.

### What enforces what

| Clause | Enforced by |
|---|---|
| Payee | Policy `withdrawals = [payee]` (provider) |
| No payment above the largest deliverable | `limits.per_transaction` (provider) |
| Every payout approved by the company | `owner_approval: true` (platform holds, company votes) |
| Never more than the scope | The agent is funded with exactly the total |
| End date | Covenant's `[payout]` consent expires at the end; Covenant also stops requesting 10 minutes before |
| Start date, acceptance, repos | Covenant, before judging |
| Completion of each deliverable | Covenant's judge |

The daily and monthly limits are set too, but they reset (monthly on the same date each month), so they are not what caps a contract longer than a month. The funded total is.

## A payout run

1. **Evidence:** the contractor's merged PRs in the listed repos, across the term so far.
2. **Prechecks** (hard rules no judge can override): right author, merged by someone else, listed repo, inside the term. PRs the representative rejected earlier are dropped.
3. **Judge:** completion per deliverable, one of 0, 25, 50, 75, 100%. Only approved judgments carry forward.
4. **Owed** = Σ value × completion − already committed. One payout, at most the largest deliverable, covers the deliverables in scope order.
5. **Before the request:** the platform's policy must be in force, with owner approval on, the payee as the only withdrawal destination and the right per-payment cap. Otherwise no request is made.
6. **Request:** the attempt is saved with its requestId (`<hash16>-p<seq>-<attempt>`) before `payouts/request`.
7. **Held:** the platform holds it. The approval card leads with the judge's flags and shows the terms the platform proved for this approval: payee, USDC, amount, a public withdrawal on NEAR that may arrive less a route fee. Covenant refuses to ask for an approval signature if those terms don't match the attempt.
8. **Vote:** approve → the platform releases it → `succeeded` with the transaction. Reject → nothing moves, the judgment closes rejected, and its PRs stay out of later runs.

If owed is still above zero after a paid payout, the next payout of the same judgment is requested and needs its own approval. A run while a judgment is open is deferred.

### Attempt states

| Platform answer | Covenant shows | Amount freed? | Next |
|---|---|---|---|
| no answer (crash, lost reply) | pending / unknown | no | read `payouts/status`; re-ask the **same** id only on `not_found` |
| thrown refusal before recording (`recipient_not_registered`, …) | blocked | no | fix, then the same id |
| `unresolved`, `busy`, `rate_limited` | waiting | no | the same id later |
| `forbidden`, `session` | blocked | no | re-consent or operator fix |
| `refused` (nothing sent) | refused | yes | Retry (new attempt) or Drop |
| `held` | held | no | the representative votes |
| `processing` | settling | no | poll |
| `succeeded` | paid | no | — |
| `failed` after a reject vote, no transaction | rejected | yes | judgment closes rejected |
| any other `failed` | failed | no, until resolved | the representative picks *arrived*, *owe it again* or *count as rejected* |

### Refusals and clauses

Covenant shows a clause only when the code identifies one (`src/shared/clauses.ts`):

| Code | Clause |
|---|---|
| `payee_not_agreed`, `recipient_not_found` | Payee |
| `per_transaction_exceeded` | Scope: no payment above the largest deliverable |
| `spend_budget_exceeded` | Budget: the policy's USD budget, sized from the scope, is used up for this window |
| `withdraw_not_allowed`, `asset_not_allowed` | Payment: withdraw USDC to the payee only |
| `insufficient_balance` | Funding: funded with exactly the scope total; it can't pay what it doesn't hold |
| `forbidden` (`scope`, `no_consent`, `access_ended`) at or after the end | Term |
| `frozen` | Freeze: nothing pays until the owner unfreezes |
| `grant_missing`, `policy_not_in_force`, `recipient_not_registered`, … | Setup |
| `duplicate_held_payout`, `reviewed_policy_changed`, `request_conflict` | Platform rule (never a contract clause) |
| bare `policy_denied`, anything else | none: "The policy refused it." |

## The judges

- **Rule-based** (`RulesJudge`): reads a `Scope: d2` or `Scope: d2 (done)` line in the PR description. The keyless demo's default.
- **NEAR AI Cloud** (`NearAiJudge`, when `NEARAI_API_KEY` is set): an OpenAI-compatible chat completion at `cloud-api.near.ai/v1`, temperature 0, JSON only. PR text is passed as untrusted data. Suspicious PRs or low confidence are flagged; the flags lead the approval card.

## The attack panel

Real `payouts/request` calls with Covenant's own checks skipped (stand-in and local stack only):

| Scenario | Request | Result |
|---|---|---|
| Redirect | a payout to `attacker.demo` | refused `payee_not_agreed` (payee clause) |
| Overpay | largest deliverable + $1 | refused `per_transaction_exceeded` (scope clause) |
| Injected PR | an in-cap payout to the payee, as if the judge were fooled | **not stopped by policy**: held, and the representative rejects it. The approval is the second layer |
| After the end (stand-in only) | a payout after the contract end | `forbidden scope` (term clause) |

## Verify

The contractor's Verify page reads, through Covenant, the platform's overview of the contract's agent and the app's consents, and compares them with what the signed terms call for: policy applied and in force; actions = withdraw; assets = USDC; withdrawals = the payee; per-payment cap = largest deliverable; owner approval on; not frozen; a live payout grant; the payout consent expiring by the contract end. As information: paid + balance ≤ total, and the daily and monthly limits (which are not what caps the contract). Covenant relays the platform's read; a payee-scoped proof from the platform is filed as a gap.

## The stand-in and the stack

- `FakePlatform` (`src/server/platform/fake.ts`) is an in-process stand-in for `bun test` and `demo:e2e`. It follows the platform's request, hold and vote rules, and can simulate lost replies, outages and failures that the stack can't.
- `demo:stack` runs the same scenario against the platform's own isolated stack: real gateway, confirm page, provider simulator and local chain. The stack signs with its published test key.

## What we claim, and what we don't

See the README.
