# Workflow wallet signing

Local implementation follow-up on November 11, 2026. No live wallet was opened or signed, and no hosted action or payment was performed. The existing keyless browser demo remains explicitly simulated.

## Supported path

The terms, setup, consent and payout-vote buttons use the **same** Better-Auth / `better-near-auth` 2.0.0-rc.6 client as sign-in. `SessionProvider` supplies a workflow signer to the existing API helpers. No second wallet connector, key import, relayer, transaction sender or provider credential is added.

For each explicit click, `WorkflowWalletSigner`:

1. Copies the original account, message, recipient and canonical 32-byte base64 nonce before asynchronous work.
2. Checks the local authenticated account/operation generation, a fresh `/me` response and the configured network.
3. Reconnects the existing wallet if needed, then checks its actual account, network and connection state.
4. Calls the installed `getNearClient(network).signMessage` with the exact message, recipient and decoded nonce. It supplies no callback URL or login nonce. The wallet's returned account is checked independently of `signerId`.
5. Verifies the returned ed25519 signature over the original payload, then rechecks the wallet, local session generation and fresh server session before returning it to the API helper.

The server still checks the named account, full-access key, immutable terms or prepared platform intent, role authorization and payout bounds. A client signature is neither accepted approval nor confirmed settlement.

Cancellation, mismatched identities/networks, expired sessions and malformed signatures stop before workflow submission. One signing operation can be pending at a time. After the signing deadline, a late signature is discarded and the guard remains locked until the underlying prompt settles; close that prompt before trying again. No automatic retry or new request identity is introduced.

NEP-366 actions retain the platform's existing confirmation link. Covenant does not convert them into direct transactions. Wallets requiring a redirect-only message-signing protocol or unsupported key curves are outside this implementation; their failure must not cause a key import or fallback send.

## Durable signing identities

An unexpired matching setup/consent request retains its original nonce and message over refresh. An unexpired, never-submitted approval preparation is reused for the same payout and verdict. Superseding a never-submitted message invalidates its old app submission path. An external confirmation link may already have been acted on and cannot be silently superseded.

Before an owner signature leaves the app, its original correlation is durably marked uncertain. A crash or lost submission reply therefore cannot leave it signable again. An uncertain/submitted vote blocks another preparation, including the opposite verdict; the app observes the same owner/payment identities. Approval outcomes remain separate from settlement. A failed or uncertain outcome may require reconciliation and is not a reason to create a new payment.

The platform-owned provider-response and rejection-proof cases G13/G14 remain open. A read-only local source/ref/snapshot review found no newer verified snapshot addressing them; cached refs were inspected without fetching or changing peer checkouts. Do not patch the frozen snapshot or infer recovery from recipient/amount matching.

## Verification and limits

From the repository root with dependencies installed, run the focused offline checks:

```bash
bun test tests/wallet-signing.test.ts tests/wallet-api.test.ts tests/owner-signing-recovery.test.ts
bun run typecheck
```

The signer tests use throwaway cryptographic fixture keys. API tests inject HTTP and signer results. Recovery tests use the existing application and simulated platform. They establish local payload, authorization and identity behavior; they do not establish an actual NearConnect wallet popup, extension or hosted provider outcome.

Fresh result: the full suite passes **272 tests / 1,596 assertions**. A separate agent session ran the focused command above verbatim: **36 tests / 244 assertions**, plus passing typecheck, with no recipe blockers. All use Bun 1.4.2 and SDK 0.5.6. The full simulated browser and SDK restart recipes below also passed on the updated source; they keep using fixture signatures rather than an actual wallet.

A definitive owner-submit refusal conservatively retains the attempted-vote marker while the payout remains held and unpaid. This can require explicit reconciliation; it never becomes confirmed approval or a reason to replace the payment. External confirm-only actions also remain observable only through their supported platform/payment path and cannot be silently superseded. No new platform lookup/replay mechanism was invented.

The complete simulated job remains reproducible with:

```bash
bun run demo:browser
bun run demo:job:restart
```

Run receipts and exact tested source fingerprints are recorded in [job-evidence.md](job-evidence.md). Before any hosted walkthrough, satisfy the separate [staging acceptance plan](staging-acceptance.md), including explicit operational/funds authorization and actual wallet evidence. No deployment or real signing is authorized by this implementation or its tests.
