# Builder USDC registration

The builder's signing page separates terms acceptance, agency preparation and readiness to receive USDC. Registration is optional until payment is needed and does not create or fund an agent.

For a real-wallet environment, the page reads `GET /api/contracts/:id/registration`. This private, uncached endpoint authorizes a job party before reading the chain. It uses the job's signed payee and token, finalized `storage_balance_of` and `storage_balance_bounds` reads, and the RPC gas price. Unknown or malformed responses do not mean registered. A quote expires after 60 seconds.

The payee reviews the storage minimum in NEAR, a 30 Tgas allowance and its estimated cost at the quoted gas price. This estimate is not an approved fee ceiling or a guarantee of final charges. The wallet remains the final transaction review. Before opening it, the client checks the current quote, authenticated account, wallet account, session generation and mainnet network. A changed quote requires another review. The only transaction is `storage_deposit({account_id: <signed payee>, registration_only: true})` on the pinned native USDC contract, attaching the quoted storage minimum. No platform credential, consent or payout authority is involved.

Cancellation, rejection, interruption and lost replies never trigger an automatic retry. Recheck on-chain registration first. A successful wallet response alone does not confirm registration; the UI performs another chain read. Registration-only deposits for already registered accounts are contract-governed; do not infer fee-free retries. The fake/demo UI does not offer live registration. If signed terms name a payee different from the builder, this page provides status and quotes only: it tells the builder to have that recipient register through its own wallet. It does not invite the recipient into the private job or support sponsored registration.

Offline checks cover storage quotes, malformed/unknown chain responses, party isolation, stale/changed quote bindings, wallet identity/network/session changes, cancellation, concurrent requests and a lost wallet reply. The browser fixture is simulated. Hosted transaction execution, actual gas charges, token registration and a resulting payout require a separately reviewed deployment and scoped owner approval.

This change preserves the existing SDK and gateway pins. It does not update shared engine recovery changes or authorize deployment or live transactions.
