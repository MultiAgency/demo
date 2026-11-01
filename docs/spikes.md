# Spikes: what must be proven on mainnet before the live adapter is written

All live spikes use a new dedicated owner account, payees we control, and at most $10. Each result is written here before more live code lands. Go/no-go checkpoint: **Nov 3, 23:59 UTC**.

| ID | When | Test | Go if | Fallback | Result |
|---|---|---|---|---|---|
| SP0 | Nov 2 | Bun imports SDK 0.7.3; `getNetwork`, `whoami`, `getPartnerQuota`, `getTokens` on the default host and the demo host | Key valid on a host; quota allows ≥3 agents; USDC asset id and decimals read | Node 24 + tsx; use whichever host works | pending |
| SP1 | Nov 2–3 | Throwaway browser page with near-connect: `agent_create` (NEP-366) with the compiled policy, `grant_issue` (NEP-413) expiring in 60 min, deposit $8 USDC (`confidential: false`), then `getPolicy` APPLIED + synced | Agent active, policy applied, balance available | Try HOT / MyNearWallet; last resort a local owner-side signer on the owner's laptop. No agent by Nov 4 → no-go | pending |
| SP2 | Nov 3 | Withdraw $2 to our NEP-145-registered account: appears in `listScheduledExecutions`, dispatches after the timelock → SUCCESS + tx. A second $2: `execution_cancel` inside the window | Both behave as documented | `timelock_ms: 0`; the story becomes "caps, not vetoes" | pending |
| SP3 | Nov 3 | Live and dry: withdraw to an unlisted address; withdraw cap + $1. Record status, code, layer, request id, and whether the refusal is immediate or at dispatch | Destination refused immediately; over-cap refused | If over-cap is judged at dispatch, show FAILED after the window. If not refused at all, drop the overpay claim | pending |
| SP4 | Nov 3 (+60 min) | After the SP1 grant expires: live and dry withdraw | Refused at the grant/auth layer, nothing moves | End date = owner-signed freeze + server date gate | pending |
| SP5 | Nov 4 (stretch gate) | Dry withdraw USDC with `chain: "base"` | Clean quote | Stay NEAR-only | pending |

## Things to record for every call

- Request (with secrets removed), HTTP status, `errors[].code`, `errors[].layer`, `meta.request_id`, timestamps.
- For withdrawals: `correlation_id`, status transitions, `dispatch_at`, tx hash.
- Any difference from the simulator: update `src/server/provider/sim.ts` and the clause mapping to match, and note it here.
