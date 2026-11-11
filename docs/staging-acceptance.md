# Staging acceptance plan

Prepared **2026-11-11** for review. This document authorizes no deployment, credential issuance, wallet signature, account mutation, external message or funds movement. The current milestone remains the isolated demonstration in [job-demo.md](job-demo.md). Follow workspace [AGENTS.md](../../AGENTS.md), the current coordination decisions and the repository's operational boundaries when an operator later executes an approved run.

## What is being accepted

One agency representative, one builder, one v3 report/invoice work order, and one confirmed payment through **Covenant → SDK 0.5.6 → platform held payout**. The offer, both acceptances, submission, invoice, compensation proposal, agency approval and settlement must retain their linked identities across refreshes and an app restart. This job creates no payable Agent Market assignment and no x402 authorization. See [workflow-map.md](workflow-map.md) and [market-boundary.md](market-boundary.md).

The SDK integration already exists in open demo PR #6 at `11e1b16861ecdb3463137ec57f52326ca609870b`; the builder-job slice is currently uncommitted on top of it. Preserve peer changes. A later acceptance run must identify its actual final candidate, not just PR #6 or this document's date.

## Environment and evidence categories

| Environment | What runs | What its result can establish |
| --- | --- | --- |
| In-process stand-in | `bun run demo:job`, fixture identities, simulated signatures/provider/settlement | Application transitions, record links and scripted failure behavior |
| Isolated local platform stack | Same job via SDK and real gateway/executor code; simulated provider, chain and fixture signatures | Integration with the pinned platform snapshot; no real settlement |
| A hypothetical hosted simulated-provider environment | A separately isolated host intentionally configured with simulator and fixture accounts | Hosted application/auth behavior against that simulator, only if independently prepared and identified; this environment is not currently established |
| Hosted platform staging, `api.dev.multiagency.ai` | Real provider and **mainnet**, despite the name “staging” | A real owner/provider/payment outcome, only after separate explicit operational and funds authorization |

There is no established “simulated real-provider payment” mode on the existing staging host. A browser fixture or injected network response is not hosted real-provider evidence. The existing `demo:job` stack mode deliberately permits loopback URLs only; do not repoint or loosen it for staging.

The public checks recorded on November 11 returned healthy/credential-refused responses but no version. A committed deployment record reports staging 0.5.6 at `f7caad4` as of November 10; that is dated deployment evidence. Reconfirm the actual operator-reported deployment/image and capabilities before a hosted run. Do not infer today's host version from npm, source or `/health`.

## Readiness gates before any hosted mutation

1. **Verify the final candidate using the completed local proofs.** The follow-up [browser check](browser-demo.md) now passes actual creation, two-party acceptance, submission, revision, approval and settlement at desktop/mobile sizes. The [process-restart check](job-restart.md) passes a lost app response plus OS-process replacement on the independent SDK gateway, preserving the original payment identity. Use the app's standard build/runtime and record fresh `bun run typecheck`, `bun test`, `bun run demo:job`, its requested-changes/lost-reply variant, `bun run demo:e2e` and `bun run demo:browser` for the eventual final candidate. The local SDK snapshot and app source in each receipt identify the exact code tested; a later edit is not automatically covered.
2. **Verify the implemented wallet path with an actual wallet.** Terms/setup/consent/grant/policy/approval signing now uses the existing sign-in client through an account/network/session-bound NEP-413 adapter; see [wallet-signing.md](wallet-signing.md). Offline cryptographic, HTTP-wiring and durable owner-step tests cover cancellation, timeout, identity changes and lost responses. They do not prove an actual NearConnect popup or wallet extension. Keep NEP-366 on the platform's confirm page. Record a real-wallet walkthrough only when separately authorized, including refusal and reload under the original identities. Redirect-only signing and unsupported key curves remain outside the implementation. Do not enable `/sim/*`, insert fixture signatures or bypass authentication on staging.
3. **Identify the candidate and its state requirements.** After all active session edits settle, record base commit, dirty paths, every included source/script/test/lockfile hash, the aggregate manifest hash, Bun/TypeScript versions and the generated frontend artifact/asset hashes. Include untracked implementation files; exclude `.env`, private links, credentials, databases and runtime state. Keep the complete frontend artifact for open clients. The earlier manifest in [job-evidence.md](job-evidence.md) describes its recorded snapshot and cannot identify later fixes automatically. Historical databases containing a `rejected` payout or v3 freeing manual resolution without persisted positive non-execution proof are refused before migration; preserve them for same-ID evidence reconciliation. Do not delete, reset or backfill proof from an error code to make startup pass.
4. **Identify the matching platform.** Record SDK package version/integrity, exact platform source/candidate/image, supported runtime and deployed app-access contract. The verified local snapshot currently recorded is `36a66cb4212faef9d651a342baead7203238eb19d866acf9a8b2ec6ef1e76518`, source `f7caad4537e982190094e2654a064b25e7725f8a`, Node 24.22.2. Preserve its provenance and freeze; do not run a peer's mutable tree or modify the frozen snapshot.
5. **Prepare an isolated app and custody boundary.** An operator supplies an already approved, host/deployment-bound app credential directly to the server's secret configuration; the app holds no owner/provider key. It needs durable SQLite, a stable auth secret/origin and correctly scoped cookies. `PLATFORM=remote` requires auth; `PLATFORM_STACK_DIR` must be absent, and demo controls/dev signer must be absent. App-origin and platform-origin credentials remain separate. No credential values enter this repository, receipt or transcript. Confirm active run/freeze ownership again before money-path work.
6. **Choose and approve the exact run.** The user/operator must name the two real accounts, host/deployment, work order, dates, budget, invoice ceiling, funding maximum and permitted actions before any real setup signature, funding or payout. The amount below remains a draft. Deployment, new live credentials, cloud model calls and real funds each require authorization covering those actions; a local test pass supplies none.

If any gate is unmet, retain the reviewable candidate and report that gate. Do not improvise a live adapter or fall back to owner/provider credentials.

## Draft job terms to finalize before signing

Use one deliverable so one payment can complete the invoice. The real run must replace every placeholder and have both parties review the resulting canonical terms before accepting.

| Field | Draft value / required decision |
| --- | --- |
| Version and workflow | v3; `acceptance: report_and_invoice` |
| Agency / representative | Named test agency; `<agency NEAR account>`, controlled by its human representative |
| Builder and payee | `<builder NEAR account>` as both contractor and USDC/NEAR payee; a separate human-controlled account from the representative |
| Scope | `d1`: a small CSV export sample and its test report, produced by the builder in an agreed test repository |
| Acceptance criteria | Agreed header/column order; three expected rows; quoted commas/newlines handled; reproducible passing test output and an immutable source revision. Agency opens the evidence and checks these points. Final exact artifact/repository is agreed before signing. |
| Budget / deliverable value | `<BUDGET_USDC>`; **1 USDC is only an illustrative planning amount**, not an approved live amount. Confirm provider/deposit minimums and any registration/setup costs before selecting it. |
| Invoice | Unique `STAGING-<run-id>-R1`, positive amount ≤ signed budget; one immutable report/evidence/invoice submission |
| Dates | Explicit ISO start/end dates covering the supervised run and review. Do not reuse fixture November dates blindly; payout requests stop ten minutes before the signed end. |
| Payment terms | `scope_completion_less_committed`; invoice is a cap; explicit agency approval; platform USDC/NEAR settlement; due after approval |
| Gross amount and fees | Current compensation records the requested gross USDC amount. Before a real offer, agree who bears route/provider fees and what net receipt is promised; a successful gross withdrawal does not by itself prove the builder's exact net receipt. A net guarantee could require a terms/version decision. No automatic top-up is authorized. |
| AI mode | Rules proposer initially, clearly labelled: evidence links count as completion but are not quality verification. Optional cloud assessment is a separate authorized scenario, never a replacement for human review. |
| Payment authority | One dedicated contract Organization/agent; only the platform's held payout path. No market payment, manual duplicate withdrawal or second invoice for the same obligation. |

The scope value bounds total application compensation; the live policy must also match the signed payee, USDC asset, per-payment/daily/monthly limits and `owner_approval`. Exact funding is not escrow or an irrevocable contractor entitlement. Verify the builder's account exists and is registered for USDC; registration is a separate wallet action/cost, not an app-side permission to spend.

## Supervised acceptance sequence after the gates and authorization

| Step and actor | Action and explicit checkpoint | Required observation / retained identity |
| --- | --- | --- |
| 1. Operator | Record candidate, environment, timestamp, authorization scope, run/freeze ownership and account roles. Use two isolated browser profiles. | Candidate manifest, SDK/platform provenance, run ID; no secrets |
| 2. Agency | Sign in, create the finalized offer, review the full terms and sign the terms hash. | Work-order ID, Organization, canonical terms/hash, representative account and signature verification |
| 3. Builder | Sign in as the agreed builder, open the private link, inspect the identical scope/payment terms and accept. | Same work-order/hash, builder account and verified acceptance; no terms edits after signing |
| 4. Agency | Review and sign each setup/creation, split consent, grant and policy action on its supported surface. Pause if action/payee/asset/amount differs. | Agent name/ID, host/deployment, consent IDs/expiry, grant expiry, owner correlation IDs, policy revision/digest and read-back match |
| 5. Agency/operator | Inspect the one-time deposit and its minimum/memo/expiry; separately approve and fund only the authorized amount. | Funding observation, credited balance and deposit receipt; deposit instructions alone are not credited funding |
| 6. Builder | Deliver the actual agreed artifact, file a report with immutable HTTPS evidence and the unique invoice. Refresh the page. | Submission ID/revision, content/terms hashes, invoice ID/number/amount and builder. State is submitted, proposed amount/paid amount remain zero. |
| 7. Agency | Request the agent proposal, then inspect the report, evidence, criteria, invoice and proposed amount. | Judgment ID, bounded amount/lines, payout `requestId`, platform correlation and held approval ID/expiry. No approval and no settlement yet. |
| 8. Agency | Approve only after comparing the platform's proven payee, asset, amount and chain with the signed terms and reviewed submission. Sign the exact approval. | Owner-step correlation, verdict and proven terms. Processing/approval is still unpaid. |
| 9. Both parties | Observe the same payout identity through status reads until the platform proves success or a consequential failure. Builder verifies received funds independently. Refresh both pages; then reopen the app over the same durable DB if that restart was separately authorized and has no active write. | Confirmed settlement state, same request/correlation, amount/payee, available destination transaction evidence and builder receipt. One payout obligation, one successful payment. |

The platform's vote text may show identifiers/hash rather than readable payee/amount; do not sign without the proven terms displayed and compared in the app. If only platform success is available but destination transaction evidence or independent receipt is absent, record those fields as missing. Do not claim “builder receipt verified” from approval, or fabricate a transaction hash. Local stack G12 is an existing simulator evidence limitation, not proof that a hosted payment lacks receipts.

## Failure and recovery cases

Run destructive fault injection only in the isolated stand-in/stack. A real hosted connection failure is observed conservatively; do not manufacture a financial failure on staging without separately approved tooling and scope.

| Case | Expected behavior and safe continuation |
| --- | --- |
| Requested changes before proposal | Agency records exact feedback; original report/invoice stays immutable; builder files revision 2 with a new client submission key and invoice number, under the same accepted terms. |
| Requested changes while held | Old submission becomes `changes_pending`. Agency signs **reject** and the SDK must supply positive `neverExecuted` proof with no contradictory payment/transaction/refund evidence before revision 2. A failure code or attempted reject alone is insufficient. Stale prepared approve, retry, drop and replacement submission must not free an uncertain payment. Wholly unpaid proposals only; partial-paid/rework policy is outside this milestone. |
| Anonymous, builder or other account attempts approval | Server returns 401/403; payout stays held and no signature/payment is accepted. Exercise fixture roles locally first; hosted role checks use only authorized accounts and no credential export. |
| Missing registration, insufficient balance, expired grant/consent or policy mismatch | Record exact typed refusal/state. Fix only through the supported owner/consent path after approval; read back policy/state. A refusal is not settlement and an HTTP error is not automatically proof of non-execution. |
| Lost submission response | Browser retries the saved **same client key and exact body**. Server returns the original submission/invoice. Do not clear browser pending storage to create a replacement while uncertain. |
| Lost proposal or payout response | Keep the written judgment and payout `requestId`; reload/reopen the same DB and observe `payouts/status`/`paymentStatus`. Never re-propose, re-sign or send with a new payment ID merely because the reply was lost. |
| Status unavailable / processing indefinitely | Keep amount committed, block replacement, preserve journal/DB/receipt and escalate for observation. Cancellation, timeout or app restart does not prove nothing happened. |
| `request_conflict` | The platform has different terms under that ID. Preserve the local blocked/committed state and read the foreign record for information only. Never treat its success as this job's payment or as permission for a replacement. |
| Failed/refunded or manual resolution | Preserve uncertainty until the agency reviews authoritative evidence. V3 `reowe`/`rejected` resolutions require positive non-execution proof; an operator assertion alone cannot free committed compensation. Manual `arrived` is labelled separately and does not become platform-confirmed settlement. |

The current snapshot has a dropped-withdrawal-response control. Its concrete optional recovery run retained one unknown app request and one held simulator record without binding them within 25 seconds; it failed safely with no approval, replacement or settlement (G14). The default app-HTTP response-loss/restart run passes. The snapshot's provider simulator also omits rejection non-execution proof, so corrected gateway rework remains blocked (G13). See [platform-gaps.md](platform-gaps.md); neither limitation justifies a weaker app proof or a live workaround.

## Receipt and acceptance record

Keep a private operator record for exact account/payment identities; share a sanitized transcript with explicit environment and simulation labels. Record:

- run ID/time, candidate manifest and app/frontend/lockfile digests, toolchain, SDK integrity, platform source/image/deployment;
- work-order/Organization/agent IDs, accepted terms hash and both account/signature-verification outcomes;
- submission client key/ID/revision/content hash, invoice ID/number/amount, evidence references, judgment ID/completion/amount;
- every payout request/correlation, approval ID/expiry, vote/owner correlation and separately observed request/approval/settlement states;
- payment asset, requested gross amount, fees/net amount when available, payee, transaction/refund evidence when supplied, confirmation source and independently verified builder receipt outcome;
- original and revised submissions for rework; all refusals/unknown outcomes and observation history; no omitted failed attempts.

Acceptance is complete only when the finalized job traverses offer → acceptance → submission → proposal → agency approval → confirmed payment, both party views agree after reload, no same-obligation duplicate exists, and the evidence names its actual environment. Distinguish a passing local UI journey, a local SDK/gateway run, a hosted real-wallet flow and a real payment as separate results.

## Stop and rollback

On a blocker, stop initiating new writes; keep observing the same identities if authorized. Preserve the durable database, platform records, owner actions, pending browser submission and complete frontend artifact. Do not reset state, remove attempts, restore an older DB, reissue identities, replace an uncertain payment, or pay manually to obtain a clean transcript. App rollback must be compatible with the new v3/job records and cannot erase them; retain old hashed assets for open clients. Platform downgrade after market/shared-state changes has its own compatibility boundary and is not part of this plan. Any restart, deploy or rollback affecting a hosted environment requires its own operational authorization.
