# Fund a job from its wallet

The funding button is deployed from `3ee5b41`. [Read-only deployment acceptance](deployment-update-3ee5b41.json) verified all 107 runtime source/SDK inputs, served frontend and preserved records. No wallet was opened and no transfer is authorized; hosted Intear funding acceptance remains unverified.

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

## Local correction: stable deposit instructions

A hosted attempt exposed an app bug: the existing `deposit` platform call allocates a new one-time address, but Paperwork called it again during refresh and immediately before wallet review. Comparing the new allocation with the displayed allocation then stopped the funding attempt. The subsequent `unknown` allocation reply is a separate upstream uncertainty; it is not proof that the platform rejected or did not allocate the address.

The local, undeployed correction serializes lookup/allocation per job and returns the original saved instructions while unexpired. It never asks for another address merely to refresh. A durable `deposit_pending` event is written before the first allocation; a successful response saves the address and its `deposit_ready` event atomically. An unknown/thrown/invalid reply leaves the original allocation blocked across refresh and database reopen. Expired or missing resolved instructions require reconciliation rather than silent replacement. Existing saved instructions remain compatible; no schema migration, credentials or pins change.

The pinned platform allocates with its own new idempotency key on each call. Paperwork cannot recover a lost original allocation through a client request ID on this interface. Platform-owner inspection is needed for unresolved allocations; the app adds no reset or retry bypass. Older Paperwork code does not honor the new pending marker, so rollback across an unresolved allocation needs compatibility review.

This correction is not yet committed or deployed. Do not resume live funding attempts on the old implementation while the reported upstream `unknown` is unresolved.
