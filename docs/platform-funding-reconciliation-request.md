# Request to the platform: funding reconciliation reads

Paperwork → MultiAgency platform/SDK. Proposed 2026-11-14 for 0.6.x. Not implemented by any platform version; SDK 0.6.0 is a release target that does not include it (`sdk/docs/release-0.6.0.md`).

## Why

Job `c_a2002ec56bf1` has an unknown first `deposit` outcome. It also has a 0.01 USDC credit and two cached `PENDING_DEPOSIT` allocations, and none of these can be bound to an exact operation (see [job-funding.md](job-funding.md)). Paperwork must not allocate again, replay, reset markers or infer non-receipt from empty arrays. Without authoritative reads, funding that job, or any job with a partial credit, stays blocked.

Paperwork already validates and uses the two answers below behind optional server ports (`Platform.fundingRecovery`, `Platform.fundingRecoveryOutcome` in `src/server/platform/port.ts`). Both are switched off until the platform supplies them. Schemas: `src/shared/funding-recovery.ts`.

## Read 1: funding reconciliation for a job's agent

`fundingReconciliation(binding) → FundingReconciliation`. Read-only, under the app's existing credential and `read` scope. It sends nothing and allocates nothing.

The binding is exactly what Paperwork signed and set up: `job_id`, `terms_hash`, `deployment`, `platform_host`, `app_origin`, `organization`, `owner`, `agent_id`, `target_atomic`. The platform must echo every one unchanged. Any mismatch is refused.

| Field | Meaning, from provider-owned records only |
| --- | --- |
| `schema_version` | `1` |
| `reconciliation_id` | stable identity of this review; changes when any value below changes |
| `original_allocation` | `{ state: "resolved", resolution: "exact_operation" \| "provider_recovery_procedure", evidence_reference }`. Omit the whole result while the original unknown allocation is unresolved |
| `route_ready` | `true` only when the payout route has been verified without moving funds |
| `credited_atomic`, `available_atomic` | the agent's provider-credited USDC (must be equal) |
| `target_atomic` | echo of the signed total |
| `expected_credit_atomic`, `fee_atomic`, `transfer_atomic` | remainder needed, route fee, and exact transfer (`transfer = target − credited + fee`) |
| `destination` | `{ address, allocation_request_id, correlation_id, can_receive_this_transfer: true, minimum_atomic, expires_at, memo: null }`: one existing destination confirmed to credit this agent |
| `observed_at`, `expires_at` | read time; validity of at most 5 minutes |
| `asset`, `chain`, `network` | USDC on NEAR mainnet |

**Rule:** return an error instead of a partial or best-guess answer. Paperwork treats any missing, extra or inconsistent field as "not cleared".

## Read 2: what became of a destination

`fundingRecoveryOutcome({ ...binding, correlation_id, allocation_request_id }) → FundingRecoveryOutcome`. This is the negative-result read #81 needs: an authoritative statement that a destination received nothing.

```json
{ "schema_version": 1, "correlation_id": "…", "allocation_request_id": "…",
  "state": "not_received", "destination_expired": true, "received_atomic": "0", "observed_at": "…" }
```

Return this only when provider records show the destination has expired and received nothing. If anything was received, or the state is uncertain, return an error or a different state; Paperwork then keeps the attempt unresolved. Paperwork additionally requires the answer to be fresh (5 minutes), the destination's expiry to have passed, and the agent's verified balance to be unchanged.

## Preventing recurrence

1. **App-supplied allocation request ID on `deposit`:** a versioned, app-scoped ID that Paperwork persists before submission and the platform retains with the operation.
2. **Read-only status by that ID:** returns the original correlation, instructions and outcome, so a lost reply is recovered under its original identity and never replaced. This depends on the provider's lookup by original idempotency key (`sdk-typescript#38`, platform#81).

## What Paperwork does with the answers

- **Read 1 ready:** the agency reviews the exact credit, remainder, fee and destination, and opens one wallet transfer. A single attempt is claimed before the wallet opens.
- **Attempt then resolves as `funded`** when Paperwork's own verification shows the agent holding the signed total.
- **Attempt resolves as `not_received`** only on Read 2. Only then can a new reviewed attempt be prepared.
- **Anything else** (an error, staleness, a changed balance or silence) keeps funding blocked. No marker is cleared and no address is requested.

## Not requested

No send, reset, sweep, clearance of legacy records, replacement allocation, or heuristic matching of past deposits.

## Acceptance

- **Platform:** offline tests for both reads covering each refusal case. Read 2 never answers `not_received` for an unexpired destination or for one with any credit.
- **Paperwork:** `tests/funding-recovery.test.ts` already exercises these contracts against stubs. Its acceptance run is against the exact platform/SDK pair carrying the reads, with funding still separately authorized.
