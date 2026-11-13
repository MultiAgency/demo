# Fund a job from its wallet

The allocation-stability fix was originally accepted from `33c4899`. The current frozen candidate `0791b0e2` is deployed as `c5808392`; [current deployment acceptance](deployment-readiness-0791b0e2.json) verifies all 116 runtime inputs and original rows across 25 tables. A clean Intear Web builder sign-in and logout/private-data refusal checks pass. Agency sign-in is now confirmed by a fresh active server session after the user completed the normal-browser flow; that browser's UI and reload remain uninspected. Funding and payout acceptance remain unverified. No allocation, marker reset, report/invoice, payout approval or transfer was performed during this update. The original provider funding hold remains in force.

At step 8, **Review funding in wallet** prepares one transaction from the signed job's representative on mainnet. The amount comes from the signed scope using exact atomic USDC units. The pinned SDK 0.5.9 supplies the two actions: register the platform's deposit address with `storage_deposit` (0.00125 NEAR, registration_only), then `ft_transfer` the scope total with 1 yoctoNEAR attached. Each call allows 30 Tgas. Review the wallet's final costs; the UI does not quote gas price or promise a wallet balance requirement. This follows the [SDK funding contract](../vendor/multiagency-sdk/final-handoff-252cba1.json) and [NEP-141 transfer standard](https://github.com/near/NEPs/blob/master/neps/nep-0141.md).

The page displays the full copyable recipient, exact minimum without currency rounding, expiry and attached deposits. It refreshes the authoritative deposit instructions immediately before sending and refuses changed or expired instructions. The original job/agent, mainnet wallet account, unchanged application session, signed policy, active grant/consent and zero agent balance must verify. No server-side money authority or new endpoint is added. SDK/gateway pins and dependencies remain unchanged.

One explicit click opens the wallet; its final confirmation can move real USDC. Funding does not approve a builder payment. Fees, funding and later held-payout approval each require their own supervised authorization.

## Duplicate and interrupted requests

A Web Lock coordinates tabs in the same browser. A local unresolved-attempt record is written before calling the wallet. Concurrent clicks, reloads and an interrupted wallet result cannot automatically trigger another send. If browser storage or cross-tab locking is unavailable, the wallet request refuses.

The record is deliberately retained even after a wallet error or cancellation once send was entered. It is not proof of submission or settlement. Do not clear it merely because an error occurred or the agent balance is still zero; independently reconcile the original wallet transaction and deposit credit. An operator-assisted retry/reconciliation UI is not implemented. This browser-local protection does not coordinate another device or prevent manual wallet transfers; a funding race across browsers is not made atomic by the balance check.

DAO-owned jobs, deposits requiring a memo, and additional top-ups are not supported by this wallet button. They retain instructions and require separate review. Existing stand-in demos retain their simulated Fund button.

## Offline checks

```sh
bun --no-env-file run typecheck
bun --no-env-file test
bun --no-env-file scripts/demo-funding-browser.ts
```

The dedicated browser check uses fixture identities on localhost, blocks external connections, and never opens a wallet or signs. It covers the full address, exact minimum/costs, 1440px/390px layout, unresolved-attempt persistence and wrong-account refusal. CI runs it with the other offline browser checks. Unit checks cover account/network/session changes, changed deposit instructions, storage/lock failure, duplicate requests, signed-scope arithmetic, policy/balance verification and the pinned SDK action payload. These checks do not establish hosted Intear funding acceptance.

## Deployed correction: stable deposit instructions

A hosted attempt exposed an app bug: the existing `deposit` platform call allocates a new one-time address, but Paperwork called it again during refresh and immediately before wallet review. Comparing the new allocation with the displayed allocation then stopped the funding attempt. The subsequent `unknown` allocation reply is a separate upstream uncertainty; it is not proof that the platform rejected or did not allocate the address.

The deployed correction serializes lookup/allocation per job and returns the original saved instructions while unexpired. It never asks for another address merely to refresh. A durable `deposit_pending` event is written before the first allocation; a successful response saves the address and its `deposit_ready` event atomically. An unknown/thrown/invalid reply leaves the original allocation blocked across refresh and database reopen. Expired or missing resolved instructions require reconciliation rather than silent replacement. Existing saved instructions remain compatible; no schema migration, credentials or pins change.

The pinned platform allocates with its own new idempotency key on each call. Paperwork cannot recover a lost original allocation through a client request ID on this interface. Platform-owner inspection is needed for unresolved allocations; the app adds no reset or retry bypass. Older Paperwork code does not honor the new pending marker, so rollback across an unresolved allocation needs compatibility review.

This correction is deployed, but neither reported address nor any other unverified destination is cleared. Do not resume funding until provider allocation records establish destination binding/validity, receipt/credit evidence and route readiness. Empty balances or deposit-history arrays do not establish non-receipt. No live allocation or wallet transaction was used to accept the deployment.

## Reported provider reconciliation follow-up — 2026-11-13

The platform session reports recovered allocation correlations through history with `include_unpaid: true`, one successful historical 10,000 atomic USDC deposit/credit (0.01 USDC), and matching available balance. It reports independently checking the final deposit and settlement receipts on NEAR mainnet. Two other cached allocations remain `PENDING_DEPOSIT`; their recorded binding and November 19 expiry do not authorize funding. Separate empty provider-record arrays were incomplete evidence. Paperwork has reviewed the retained private reconciliation receipt and recorded its reference and SHA-256 in the [summary](provider-reconciliation-summary.json), without copying private correlations or addresses. Provider/RPC reads were not independently repeated.

The original unknown allocation is still not bound to an exact operation. Preserve all markers and cached records. The successful consumed address is not cleared for reuse; payout configuration does not prove a working payout route. The current funding button requires zero balance, so the reported existing credit must be reconciled before any supported funding correction. Do not bypass the guard or blindly add another dollar.

The reviewed receipt reports no allocation events in the current app query. The platform owner must examine the original gateway request/audit for exact binding; no matching app event should be assumed. If that binding is absent, the provider owner must supply it. Durable recovery needs a versioned, app-scoped allocation request ID persisted before submission, a read-only status API returning its original correlation/instructions/outcome, and Paperwork retention of that correlation. Unbound legacy outcomes remain unknown. No app-side reset or replacement allocation is justified.

### Gateway audit review

Paperwork reviewed the separate retained gateway audit findings: 13 matching deposit-call entries contain no request ID, provider idempotency key, correlation or outcome, and inspected operation journals contain no matching identity. The original reconciliation receipt fingerprint is unchanged. Binding is unrecoverable from those inspected gateway records; this does not establish absence from provider internal records or uninspected archives. The provider owner is now responsible for authoritative binding or a supported recovery procedure. Funding remains held; no app correction or replacement allocation follows from this audit result. References and hashes are recorded in the reconciliation summary without copying private audit rows.

## Explicit recovery review (deployed inert in `eac99283`; outcome resolution local)

The agency job page now has **Recover funding**, including when an existing credit makes setup appear active. Opening it reads `GET /api/contracts/:id/funding-recovery`; it never calls the allocating deposit endpoint. The representative sees either a blocked explanation or a review showing the signed scope target, verified available credit, net credit still needed, provider fee, exact wallet transfer, route minimum, full destination, validity and reconciliation/evidence references. A labelled acknowledgement and a separate wallet button remain required. This is wallet-owned platform funding only; DAO-owned and Market-settled jobs are refused.

The trust boundary is `Platform.fundingRecovery(binding)`, an optional **read-only** server-side port. The current pinned SDK does not implement it, so the remote adapter remains unavailable and the UI stays blocked. `src/shared/funding-recovery.ts` is a proposed app-side integration contract for platform/SDK review, not a claim that a remote procedure is released. There is no receipt-upload route, operator boolean override, new remote URL, credential setting or local file importer. The retained private reconciliation receipt still has `fundingClearance: false` and cannot enable this flow.

A supported adapter must return authoritative resolution of the original unknown allocation (exact operation or a provider-supported recovery procedure), explicit permission for this transfer to its original destination/correlation, route readiness, fresh credit/available balance, exact net credit, fee, total transfer, minimum and expiry. The result binds to job, original terms hash, deployment, platform host, application origin, organization, owner, agent, asset, chain and network. It must be stable under its reconciliation ID, with a maximum five-minute review validity. Refreshing observation time alone may retain the same plan hash; changing the transfer, destination, resolution evidence or expiry requires review again. Missing, unresolved, stale, mismatched, reserved-credit or arithmetically inconsistent evidence stays blocked. The full live signed policy, signatures, grant/consent and balance must independently verify. A reported 0.01 USDC balance does not itself authorize a 0.99 USDC transfer.

Before opening the wallet, the client re-reads the reconciliation and verification. `POST /api/contracts/:id/funding-recovery/prepare` accepts only the reviewed reconciliation ID and plan hash, revalidates through the trusted port, and atomically claims one attempt in the additive `funding_recovery_attempts` table. It records the exact plan before wallet I/O. Duplicate callers, another engine/process, a lost prepare response and a reopened database cannot claim a second attempt. There is no automatic retry or reset. Status review reports `wallet_outcome_unknown` for a claimed attempt; the existing job status can still refresh balance. The ordinary deposit endpoint also refuses once a recovery is claimed. No payout is proposed or approved by this path.

The wallet layer retains the original job/account Web Lock and browser funding-marker key. It does not bypass or delete a marker from the old funding flow. After successful preparation, it writes that marker before sending the exact reconciled amount using the existing SDK funding transaction. Cancellation, storage failure or a lost reply can leave a claimed attempt even if no transfer occurred; preserve it and use authoritative reconciliation, not another click. This first recovery path permits one claimed attempt per job. Resolving an existing browser marker or authorizing another attempt requires a separately specified, evidence-bound recovery procedure; it is not implemented as a reset. Once recovery attempts exist, backend rollback to code that ignores the new table requires compatibility review.

### Resolving a recovery attempt

A claimed attempt keeps blocking deposit instructions and any other recovery until positive evidence resolves it. **Check recovery outcome** (`POST /api/contracts/:id/funding-recovery/observe`, representative only) resolves it as:

- `funded`, when a fresh, green verification shows the job's agent holding at least the signed total. This read exists today.
- `not_received`, only when a trusted provider read (`Platform.fundingRecoveryOutcome`, proposed and not implemented) reports the attempt's own destination expired having received nothing, within five minutes, after the destination's expiry, and the verified balance is exactly the credit the plan started from. Only then can a new reviewed recovery be prepared.

A cancelled wallet, an error, an unavailable read, a changed balance below the target or silence resolves nothing. At most one unresolved attempt exists per job (partial unique index). The first schema, which allowed one attempt per job ever, is rebuilt once at startup. Every row is copied and counted before the old table is dropped, and a row that cannot be copied stops startup with the original table intact.

Local validation: `tests/funding-recovery.test.ts` covers read-only review, account/host/terms binding, stale/unresolved/invalid evidence, existing-credit verification, durable concurrent claims, restart and interrupted wallet outcomes. `scripts/demo-funding-recovery-browser.ts` checks keyboard review, exact amounts, acknowledgement, phone/desktop reflow, light/dark axe scans, retained markers, blocked/expired evidence and account switching. CI includes both through the existing test job and an explicit browser step. All accounts, evidence and wallet sends in these checks are fixtures; no deployment, provider query or funds movement is performed.
