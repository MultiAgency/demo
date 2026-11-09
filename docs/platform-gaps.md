# Platform gaps

Issues filed on `MultiAgency/platform`, met while moving Covenant onto `@multiagency/sdk` 0.5.4 (platform `96a0bb6`).

| # | Gap | Issue |
|---|---|---|
| G1 | Organization agents are never released, 16 per deployment | [MultiAgency/platform#46](https://github.com/MultiAgency/platform/issues/46) |
| G2 | `grant_issue` has no expiry input | [MultiAgency/platform#47](https://github.com/MultiAgency/platform/issues/47) |
| G3 | Approval votes show the terms only through the app | [MultiAgency/platform#48](https://github.com/MultiAgency/platform/issues/48) |
| G4 | `payouts/status` reads `failed` for rejected, expired and delivery failures alike | [MultiAgency/platform#49](https://github.com/MultiAgency/platform/issues/49) |
| G5 | `duplicate_held_payout` keys on recipient, asset and amount across the agent | [MultiAgency/platform#50](https://github.com/MultiAgency/platform/issues/50) |
| G6 | A payee can't verify the policy that pays them | [MultiAgency/platform#51](https://github.com/MultiAgency/platform/issues/51) |
| G7 | App testing tools (no SDK stand-in, stack controls, sim coverage) | [MultiAgency/platform#52](https://github.com/MultiAgency/platform/issues/52) |
| G8 | `payouts/status` is not reachable under `read` | [MultiAgency/platform#53](https://github.com/MultiAgency/platform/issues/53) |
| G9 | The stack's provider sim refuses `grant_issue` with label `payout` (confirmed on the stack) | [MultiAgency/platform#54](https://github.com/MultiAgency/platform/issues/54) |
| G10 | `owner/status` for an approve vote never reports a status (confirmed on the stack) | [MultiAgency/platform#55](https://github.com/MultiAgency/platform/issues/55) |

---

## G1. Per-contract agents through Organizations are never released and capped at 16 per deployment

**Tried:** one Organization per contract, which `docs/app-access.md` describes as isolating payees, budget and balance.
**Expected:** a finished contract frees its agent.
**Happened:** hosted agents are never released, each runs as its own process, and `PER_DEPLOYMENT=16`.
**Ask:** release or archive an Organization's agent, or a lightweight agent per Organization.

## G2. `grant_issue` has no expiry input

**Tried:** binding the payout grant to the contract end.
**Happened:** the platform chooses the grant's expiry. Only the app consent's `expiresAt` bounds what the app can do, so Covenant ends its `[payout]` consent at the contract end and shows the grant's expiry as information.
**Ask:** an optional `expiresAt` on `grant_issue`.

## G3. Approval votes show the terms only through the app

**Happened:** the signed vote text (`approve:{id}:{pubkey}:{hash}`) names no payee or amount. The owner sees the proven terms only if the app shows them (Covenant does, from `payment.terms`).
**Ask:** an optional confirm page for `approval_vote` that shows the proven terms on the platform's domain.

## G4. `payouts/status` reads `failed` for owner-rejected, expired-before-approval and delivery failures alike

**Happened:** an app must read `paymentStatus` under `read` (and remember whether it voted to reject) to tell a rejected payout, where nothing moved, from a delivery failure, where something may have moved.
**Ask:** `failureCode` plus a "nothing moved" flag on `payoutRequestOutput`.

## G5. `duplicate_held_payout` keys on (recipient, asset, amount) across the whole agent

**Happened:** two legitimate requests with equal amounts can't both wait for approval. Covenant keeps one open payout per contract partly for this.
**Ask:** key by requestId, or let the caller opt in.

## G6. A payee can't verify the policy that pays them

**Happened:** the contractor's Verify page depends on Covenant relaying `overview`.
**Ask:** a payee-scoped, owner-authorized proof: agreed destination, caps, `owner_approval`, digest.

## G7. App testing tools

- (a) The SDK has no in-process stand-in for `authorize` and requestId semantics. Covenant's `FakePlatform` (`src/server/platform/fake.ts`) is offered as a starting point.
- (b) Stack controls can sign only as the owner; `--payee` accounts can't sign the app's own NEP-413.
- (c) The stack sim doesn't model approval expiry, FAILED/REFUNDED or budgets, and `dropTransferResponse` covers `/transfer` but not `/withdraw`, so lost withdrawal replies can't be tested against the real gateway. Covenant tests them on the stand-in only.

## G8. `payouts/status` is not reachable under `read`

**Happened:** once the `[payout]` consent expires (Covenant ends it at the contract end), a lost `payouts/request` reply can't be followed with `payouts/status`.
**Mitigation in Covenant:** it stops requesting 10 minutes before the end, and after the end it can still find a held payout through `held` (read) and vote on it within the `[owner, read]` grace period.
**Ask:** `payouts/status` under `read`.

## Only if hit

- **Lost `setup` reply recovery:** no way to look up the agent name by (Organization, owner, area) after the setup expires.
- **TLS for non-Node apps on the stack:** document the Bun route for the stack's self-signed certificate.
