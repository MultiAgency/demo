# Paperwork browser demo

```bash
bun run demo:browser
```

Prerequisites: Bun 1.4+, the installed project dependencies, `agent-browser` and its Chrome installation. The verified browser tool is agent-browser 0.26.0 with Chrome for Testing 148. The command needs permission to listen on loopback and use its own browser session sockets.

The runner starts an isolated in-memory Paperwork server with explicit manual simulated settlement and separate agency/builder browser sessions. It uses actual form inputs, trusted clicks, and the existing demo-wallet controls. It never invokes a workflow mutation through a test-only engine shortcut. Read-only application checks inspect record links and the independent stand-in's transfer count.

The browser journey performs:

1. Create one report/invoice job for a $300 deliverable, then sign the exact terms from both party screens.
2. Complete the agency's setup/consent/grant/policy/funding checklist.
3. Submit a builder report, invoice and HTTPS evidence reference; show that submission alone requests no payment.
4. Propose compensation, request changes, show the builder waiting for cancellation, and sign rejection of the held payout.
5. Submit an immutable revision with a distinct invoice and the original terms hash.
6. Propose and approve compensation; show processing while confirmed paid remains zero.
7. Use the explicit settlement control, wait for both party views to update, and confirm the same payment request and one successful simulated transfer.
8. Capture both outcomes at desktop 1440×1000 and mobile 390×844, checking for horizontal page overflow.

Visible agency and builder job views check status every five seconds and when focused; **Refresh status** is also available. Proposals and agency decisions remain explicit actions.

The command prints its temporary artifact directory. `receipt.json` links the job, accepted terms, revised report/invoice, proposal, approval, payment request/correlation and labelled fake transaction. Screenshots cover the held proposal, cancellation wait, approval before settlement and both parties' desktop/mobile outcomes. All signatures, provider/chain behavior and settlement in this browser proof are simulated. Production authentication is not exercised; named-role 401/403 checks remain in `tests/job-workflow.test.ts`.

The runner closes only its own browser sessions and server. On failure it retains screenshots, an accessibility snapshot and an error under the artifact directory; it creates no replacement payment to repair a failed assertion. A subsequent run uses an independent fresh fixture server.

## Resolved observations

The earlier “Create draft stays on the form” observation came from the automation: agent-browser 0.26.0 reported a completed click on an off-screen control without activating it. Explicit `scrollintoview` followed by a fresh accessibility reference resolves the observed case. The runner applies that sequence before every button activation; no Create draft application behavior was changed.

The first complete responsive check found the transaction label and full hash exceeding the agency screen width at 390 pixels. The job payment rows now wrap within their container. The confirming browser run checks both agency and builder page widths and retains their screenshots.

The process-restart proof is separate: [job-restart.md](job-restart.md) uses two actual app processes and durable SQLite against the independent real SDK gateway with a simulated provider. This browser command intentionally uses the in-process stand-in. The [staging plan](staging-acceptance.md) defines the remaining hosted signing and operational gates.

## Wallet-signing follow-up evidence — November 11, 2026

The complete keyless journey passed on the updated source with shared wallet-signing plumbing and durable owner-step changes. Latest receipt and seven screenshots: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-browser-JSIDsM/`. Both parties retain request `5048d896ad774ea9-p2-1`, approval `d10c9113-7216-48fb-aa98-1431f2ef26a1` and payment `aec399d7-a733-46fd-a285-b6edc9e36d68`; exactly one successful simulated 300 USDC payment matches the signed payee/amount. The runner stopped its owned sessions/server. This uses the existing demo signer; wallet-adapter fixture checks and the remaining actual-wallet gate are described separately in [wallet-signing.md](wallet-signing.md).

## Earlier review evidence — November 11, 2026

The browser journey passed again after the cancellation-proof, finalization and private-read corrections: `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-browser-zJ3HSr/receipt.json`, with seven screenshots. It confirms the signed gross amount and payee as well as the single successful simulated transfer. Request `5048d896ad774ea9-p2-1`, approval `405a04ed-0684-488e-b154-b9b9acf69d3f` and payment `9ae048ba-ded8-4fc1-8c0f-c6df6af3fa88` appear in both final party views. Authenticated session lifecycle and HTTP authorization are tested separately with fixtures, since this keyless journey has fixture authentication.

## Earlier evidence — November 11, 2026

The final check passed with Bun 1.4.2, agent-browser 0.26.0 and Chrome for Testing 148. Seven phase/party/size screenshots and `receipt.json` are retained under `/private/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/covenant-browser-UCY0jO/`. Both mobile views passed the page-width assertion, and both party screens displayed payment request `5048d896ad774ea9-p2-1`. The receipt records proposal `r_d7d8f80203268d363879b44e`, approval `3f5f7ca9-1df3-4790-8f1a-232dcfca5f65`, payment correlation `35b28286-fdc6-4181-81fc-e5ec2418c61f` and one successful simulated $300 payment. The runner closed both sessions and its fixture server.


> **Renamed 2026-11-11:** The app is now **MultiAgency Paperwork** (UI **Paperwork**), deployment `multiagency-paperwork`. Historical text, identifiers, commands and artifact paths above remain as recorded; they do not verify the renamed candidate. Current instructions are in the [README](../README.md).
