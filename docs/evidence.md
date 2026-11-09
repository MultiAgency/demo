# Evidence

Recorded runs of Covenant against the MultiAgency platform. Stand-in (`FakePlatform`) results never appear here.

## Local platform stack run

Platform commit: _to fill_ · Covenant commit: _to fill_ · Date (UTC): _to fill_

```bash
pnpm test:e2e:stack --app covenant --no-browser --owner acme.demo --payee maria.demo --builder attacker.demo
PLATFORM_STACK_DIR=<dir> bun run demo:stack
```

### Transcript

```
(paste the demo:stack output here)
```

### Payouts (from the stack's `state.transfers`)

Every row with status SUCCESS must match one approved Covenant payout, all to `maria.demo`, summing to the contract's `paid_usd`; nothing to `attacker.demo`.

| requestId | Covenant state | Vote | Amount | Recipient | Transfer status |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

### Refusals and holds

| Scenario | requestId | Platform answer | Code | Clause shown |
|---|---|---|---|---|
| Redirect | — | refused | `payee_not_agreed` | Payee |
| Overpay | — | refused | `per_transaction_exceeded` | Scope |
| Injected in-cap | — | held → rejected | — | Approval |

### Contract agent

| Contract hash | Organization | Agent id | Policy revision / digest | Payout consent expires |
|---|---|---|---|---|
| — | — | — | — | — |

## Hosted platform

None yet. Held-withdrawal approval reaches hosted platforms with the 0.5.5 deploy.
