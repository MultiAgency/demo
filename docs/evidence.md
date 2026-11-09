# Evidence

Recorded runs of Covenant against the MultiAgency platform. Stand-in (`FakePlatform`) results never appear here.

## Local platform stack run

Platform commit: `96a0bb6` (MultiAgency/platform main, with held-withdrawal approval #42) · Covenant: branch `covenant-platform` · Date (UTC): 2026-11-09

Simulated provider, chain, signatures and settlement: no keys and no real money. Every step below went through the real platform gateway via `@multiagency/sdk` 0.5.4.

```bash
pnpm test:e2e:stack --app covenant --no-browser --owner acme.demo --payee maria.demo --builder attacker.demo
PLATFORM_STACK_DIR=<dir> bun run demo:stack
```

### Transcript

```
Covenant · MultiAgency local stack (https://127.0.0.1:44363) · SIMULATED provider, chain, signatures and settlement

Covenant · LOCAL PLATFORM STACK at 127.0.0.1:44363
→ http://localhost:8781/

Covenant · end-to-end scenario on the local MultiAgency platform stack
Platform: remote at 127.0.0.1:44363 · clock 2026-11-09T02:05:24.756Z · judge: rules

01. Draft the work order: a signed scope of deliverables
    d1  $ 300  CSV export for monthly reports
    d2  $ 200  Scheduler timezone handling
    d3  $ 500  Rate limiting on the public API
    ✓ scope total $1000, organization c_87f364c5f4e1

02. Representative signs the terms hash
    acme.demo: "Covenant work order sha256:87f364c5f4e13869d64cd…"
    ✓ NEP-413 signature verified against a full-access key

03. Contractor signs the terms hash
    maria.demo: "Covenant work order sha256:87f364c5f4e13869d64cd…"
    ✓ NEP-413 signature verified against a full-access key

04. Set up the contract's own platform agent (one Organization per contract)
    · signed: Set up the contract's platform agent
    · owner step: Create the contract's agent (agent_create)
    · signed: Let Covenant request payouts until 2026-11-30 (the contract end)
    · signed: Let Covenant prepare your approvals and read the agent until 2026-12-30
    · owner step: Issue the agent's payout grant (grant_issue)
    · owner step: Agree the payee and limits (policy_update)
    ✓ agent 25cd0f9774cd965c0f0b891d1289d84f5463f313752e7fb75fedef370bf632e0 ready; policy revision 2 applied: true

05. Fund the agent with exactly the scope total
    deposit address work-1.local-wallet.near
    ✓ balance $1000 of $1000

06. Contractor verifies what the platform enforces
    ✓ Verify green

07. The agent judges merged PRs against the scope
    → d1  acme/app#101 Add CSV export to monthly reports
    → d2  acme/app#102 Run the payout scheduler on UTC
    ✗     acme/app#103 Refactor auth middleware into one module — not linked to a deliverable in the signed scope
    → d3  acme/app#104 Token bucket for public routes
    ✗     acme/app#105 Update README badges — merged by its own author
    ✗     acme/marketing-site#7 New landing page hero — acme/marketing-site is not a repo in this contract
    d1 completion 100%
    d2 completion 50%
    d3 completion 50%
    ✓ owes $650; requests $500 (the per-payment cap) for d1 $300, d2 $100, d3 $100; held for approval
    ✓ 87f364c5f4e13869-p1-1: approved in the wallet; the platform releases it (terms 500000000 → maria.demo)
    ✓ 87f364c5f4e13869-p1-1 settled to maria.demo
    ✓ the rest of the same judgment, $150 for d3 $150, is requested as seq 2 and held
    ✓ 87f364c5f4e13869-p2-1: approved in the wallet; the platform releases it (terms 150000000 → maria.demo)
    ✓ paid $650; judgment approved

08. A new PR is merged
    Handle daylight-saving changes in the scheduler (#107)
    ✓ requests only the difference: d2 $100
    ✓ 87f364c5f4e13869-p3-1: approved in the wallet; the platform releases it (terms 100000000 → maria.demo)
    ✓ paid $750

09. A merged PR hides instructions for the AI reviewer
    Fix typo in rate-limit docs (#108)
    ✓ held for approval; the card leads with acme/app#108 [possible_prompt_injection]
    ✓ rejected in the wallet: nothing sent, judgment rejected
    ✓ the injected PR is excluded; the next run requests nothing

10. Compromised server: Covenant's own checks off, requests go straight to the platform
    ✓ redirect: Send $1.00 to attacker.demo instead of the payee. → payee_not_agreed (Payee clause)
    ✓ overpay: Pay $501.00 in one payment; the largest deliverable is worth $500.00. → per_transaction_exceeded (Scope clause)
    ✓ injected in-cap: A pull request hides instructions for the AI reviewer. Suppose the judge is fooled and asks for $250.00, inside every limit. → NOT STOPPED by policy — the approval is the second layer. Reject it.
    ✓ the representative rejects it: nothing sent

11. The PR that actually finishes rate limiting is merged
    Configurable rate limits, with docs (#109)
    ✓ requests d3 $250
    ✓ 87f364c5f4e13869-p5-1: approved in the wallet; the platform releases it (terms 250000000 → maria.demo)
    ✓ scope fully paid: $1000 of $1000

12. Verify again, and match the platform's transfers to approved payouts
    ✓ Verify green
    ✓ 4 settled transfers, one per approved payout, all to maria.demo
    ✓ transfers sum to $1000
    ✓ nothing to attacker.demo

✓ All steps passed. Paid for the scope, never more, and only with the representative's approval.

PASS
```

### Payouts (from the stack's `state.transfers`)

Every row with status SUCCESS must match one approved Covenant payout, all to `maria.demo`, summing to the contract's `paid_usd`; nothing to `attacker.demo`.

| requestId | Covenant state | Vote | Amount | Recipient | Transfer status |
|---|---|---|---|---|---|
| `87f364c5f4e13869-p1-1` | paid | approve | $500.00 (d1 $300, d2 $100, d3 $100) | maria.demo | SUCCESS |
| `87f364c5f4e13869-p2-1` | paid | approve | $150.00 (d3 $150) | maria.demo | SUCCESS |
| `87f364c5f4e13869-p3-1` | paid | approve | $100.00 (d2 $100) | maria.demo | SUCCESS |
| `87f364c5f4e13869-p4-1` | rejected | reject | $250.00 (d3, prompt-injected PR #108) | maria.demo | none: nothing sent |
| `87f364c5f4e13869-p5-1` | paid | approve | $250.00 (d3 $250) | maria.demo | SUCCESS |

4 settled transfers, all to `maria.demo`, summing to $1,000 = the scope total = the contract's `paid_usd`. Nothing to `attacker.demo`. The stack records no transaction hashes (all evidence fields are null on the simulator).

### Refusals and holds

| Scenario | requestId | Platform answer | Code | Clause shown |
|---|---|---|---|---|
| Redirect | `atk-redirect-…` | refused | `payee_not_agreed` | Payee |
| Overpay | `atk-overpay-…` | refused | `per_transaction_exceeded` | Scope |
| Injected in-cap ($250) | `atk-injected-…` | held → rejected | — | Approval: not stopped by policy, stopped by the representative |

### Contract agent

| Contract hash | Organization | Agent id | Policy revision / digest | Payout consent expires |
|---|---|---|---|---|
| `87f364c5…` | `c_87f364c5f4e1` (one Organization per contract) | `25cd0f9774cd…f632e0` | revision 2, applied | 2026-11-30 (the contract end); owner/read consent to 2026-12-30 |

## Hosted platform

None yet. Held-withdrawal approval reaches hosted platforms with the 0.5.5 deploy.
