# Platform gaps

Issues filed on `MultiAgency/platform`, met while moving Covenant onto `@multiagency/sdk` 0.5.4 (platform `96a0bb6`).

Covenant now runs on 0.5.6. Per the platform's review of MultiAgency/demo#6, 0.5.5 carries this feedback except G1, which 0.5.6
answers with an owner-archived hosting release (`release`). Covenant doesn't call `release` yet. What Covenant uses from those releases:
`payouts/status` under `read` (G8), `reservations` for a lost setup reply, and the platform's wallet stop page for freezing.

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

**Since 0.5.6:** `payouts/status` is a `read`, so Covenant can follow its own requests after the `[payout]` consent ends.

## Only if hit (answered in 0.5.5)

- **Lost `setup` reply recovery:** Covenant resends the same signed body while it is unexpired. After it expires, or on `already_created`, it asks `reservations` for the Organization and owner and takes the one live agent listed. A platform before 0.5.5 answers `refused` 404, and the setup error is shown as before.
- **TLS for non-Node apps on the stack:** the app-server skill now documents the Bun route (`appClient` with a `fetch` adding `tls: { ca }`), which is what `caFetch` does.

---

# Agent market (SDK 0.5.6, platform `main` 7528643)

Met while building Covenant's market hires (`src/server/market/`) against the local stack
(`pnpm test:e2e:stack --app covenant --market`, with `--dao-treasury` for a DAO owner; Node 24.22.2, run 2026-11-11).
`bun run demo:market` asserts M1–M3 as they stand: a check marked "gap" fails once the platform fixes it, so this list gets
updated.

| # | Gap | Platform's answer (2026-11-11) | Issue |
|---|---|---|---|
| M1 | `market/quote` for an unlisted handle answers `unavailable`, which means "send again" | Platform bug; to be fixed | [MultiAgency/platform#66](https://github.com/MultiAgency/platform/issues/66) |
| M2 | A DAO's `read` + `market` consent can't reach `owner/prepare`, so its market grant can't be issued | Platform bug (`app-routes.ts:620` requires `treasury`); to be fixed. Don't add `treasury` | [MultiAgency/platform#67](https://github.com/MultiAgency/platform/issues/67) |
| M3 | The stack's simulated market has no directory and no worker side | Send as a failing case (below) | [MultiAgency/platform#68](https://github.com/MultiAgency/platform/issues/68) |
| M4 | No in-process double for `market/*` | Send as a failing case (below) | [MultiAgency/platform#69](https://github.com/MultiAgency/platform/issues/69) |
| M5 | Smaller: re-voting a paid hire, a silently shortened `validUntil`, an uncoded refusal | — | [MultiAgency/platform#70](https://github.com/MultiAgency/platform/issues/70) |

## M1. A quote for an unlisted handle reads as a transient failure

**Case:** market agent ready on the stack; `app.agent(org, agent).call("market/quote", { handle: "nosuchagent", brief: "x" })`.
**Expected:** `refused` with a code (say `agent_not_found`), since asking again can't succeed.
**Happened:** `{ ok: false, kind: "unavailable" }` (HTTP 503). The simulated market answers JSON-RPC `-32001 no such agent`;
`quoteHire` (`src/market/hire.ts`) lets the `MarketRpcError` from `src/market/client.ts` escape as a generic error. The
SDK says to send `unavailable` again, so an app that follows it retries forever. Covenant shows the error and does not retry.

## M2. A DAO's market agent can't get its grant

**Case:** `--dao-treasury --market`: DAO setup (area `market`) and `agent_create` pass by vote; `daoConsents.file` with
scopes `["read", "market"]` passes; then `owner/prepare { action: { type: "grant_issue", label: "market" }, signer: "dao" }`.
**Expected:** the DAO's proposal for the market grant (`appMayAskDao` allows `grant_issue` with label `market`).
**Happened:** `403 forbidden`, `code: "scope"`: `owner/prepare` is in `APP_OWNER`, which a DAO can't hold, and the gateway
admits a DAO's `owner/prepare` only under `treasury` (`app-routes.ts:620`, per the platform). With `treasury` added to the consent the grant prepares, passes and the DAO's hire is paid by vote
end to end (probe, 2026-11-11), so this is the only blocker. Covenant asks for `read` and `market` only, as decided
2026-11-09, and its DAO setup stops at this step and says why. A DAO's freeze and unfreeze are refused the same way;
Covenant shows the DAO's own stop page instead, which cuts apps off but doesn't freeze. Decided 2026-11-11: a DAO's
`market` consent will cover its market agent's grant, revocation, policy edits, freeze and unfreeze, each by vote.

## M3. The simulated market can't run the worker side or the directory

**Cases** (against `state.json`'s `market.url`, run 2026-11-11):
- `GET /v1/agents?q=writer` → 404. Expected: `BrowseAgentsResponse` (`{ agents: AgentPublic[] }`), so a hire page can pick an agent.
- `GET /v1/agents/{id}/pricing-plans`, `GET /v1/agents/{id}/reputation` → 404.
- `GET /v1/agents/me/assignments?status=all` with `Authorization: Bearer aat_…` → 404. Expected: `MyAssignmentsResponse`.
- `POST /v1/assignments/{id}/submit` `{ "deliverableMarkdown": "…" }` → 404. Expected: the `JobAssignment`, `status: "submitted"`,
  then `accepted` (an x402 hire is accepted on delivery).
- No `hire.*` webhook is ever sent. Expected: a configurable webhook URL and secret, deliveries signed `X-Market-Signature:
  sha256=<HMAC(secret, "<X-Market-Timestamp>.<raw body>")>` with `X-Market-Delivery` and `X-Market-Event`, at least once.
- Listed agents are scripted (`writer` completes, `refuser` rejects, inside the paid call). Expected: a listed agent
  backed by an app's worker, whose task completes only when that worker submits; the payment relayed at that point.

**Why it matters:** the brief's demo loop (agency A hires agency B's listed agent; B's worker delivers; B's earnings return
through `deposit`) can't run offline. Covenant's worker (`src/server/market/worker.ts`) is tested only against a stub of
the market's documented shapes (`tests/market.test.ts`), not against a market.

## M4. No in-process double for the market

**Case:** `import { payoutDouble } from "@multiagency/sdk/testing"` (the module exports only `payoutDouble`);
`appClient({ …, fetch: double.fetch }).agent("org_1", "payout").call("market/quote", { handle: "writer", brief: "x" })`.
**Expected:** a market double (quote, hire, status, account; DAO hire votes) with the platform's codes, as `payoutDouble`
gives for payouts.
**Happened:** HTTP 501, which the SDK maps to `{ ok: false, kind: "unavailable" }`, read as "send again"
(`double.unmodelled()` lists `market/quote`). Covenant's unit tests use a scripted stub of its own market port instead
(`tests/support/market-stub.ts`), so its hire state machine isn't checked against the platform's rules offline.

## M5. Smaller

- **A second vote on a paid hire.** `daoHires.file` with a `requestId` already paid files a new request and proposal.
  Passing it moved nothing (the relay answered `paid`; the payment key's balance was unchanged), but the DAO is asked to
  vote for nothing. Expected: refused, or answered with the existing request. Covenant never refiles a paid hire.
- **`validUntil` shortened without a refusal.** `daoHires.file` with `validUntil` 30 days ahead answered `validUntil` 7 days
  ahead. The filing's answer carries the shortened value, and Covenant shows it with the vote ("Payable until"); a
  refusal, as grants give for out-of-range expiries ("never clamped"), would still be clearer. Covenant asks for 2 days.
- **An uncoded refusal.** After a lost `owner/prepare` reply, preparing again answers `refused` with only the text
  "Agent creation already has an open owner action…" and no `code`. `owner/pending` recovers it, which Covenant does,
  but the refusal can only be recognised by its text.
- **DAO `agent_create` right after the setup vote** answered 503 (`unknown`) once while the hosted agent started; the
  next prepare succeeded. Covenant waits and prepares again, recovering through `owner/pending` if the first one landed.
