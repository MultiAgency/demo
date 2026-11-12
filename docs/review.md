# Report review on NEAR AI Cloud

The Review assistant compares one stored report/invoice submission with its signed deliverables. It returns source-linked findings and an editable feedback draft. Applying that draft populates the existing Changes needed field. The representative still chooses Request changes separately. Preparing a draft creates no judgment, compensation proposal, payment, signature or recorded feedback.

## Direct NEAR backend

Paperwork uses the official [`@nearai/inference-sdk`](https://docs.near.ai/cloud/inference-sdk/javascript), pinned to **0.3.0**. It calls the standard `https://cloud-api.near.ai/v1` gateway through the SDK's Node entry point. It does not depend on `private-ai`, a Hermes dashboard, a memory plugin or a direct model endpoint. The reference project's useful patterns are verification before disclosure, bounded work, source validation and clear proof limits; Paperwork owns its task-specific implementation.

Each review has a fresh SDK client. Before sending the prompt it verifies gateway and model evidence, requires Intel TCB `UpToDate` for both and verified GPU evidence, and binds gateway HTTPS requests to the attested TLS public key. Supported Chat fields use E2EE v3. The model receives only a server-derived context and the fixed review instructions; no tools are offered. There is one model-request attempt and no fallback provider.

After the complete response arrives, Paperwork calls `verifyResponse(id)` on that same client and requires a `provider_tee` signature. It then checks the JSON shape, deliverable coverage, exact report quotes and evidence ownership. It rechecks the stored submission fingerprint before releasing a draft. No reasoning or unverified model text reaches the browser. A changed submission, failed signature, partial response or cancellation discards the draft.

Transient signature lookup failures may repeat verification on the same client and completion ID, at most three attempts within the original deadline. Inference is never replayed by that observation retry. Cancellation aborts local transport and closes the client; it does not prove that an already accepted model request stopped or was not billed.

## Configuration

Set these in the app server's secret environment:

```sh
PAPERWORK_REVIEW_BACKEND=near
PAPERWORK_REVIEW_NEARAI_API_KEY=<review-only-NEAR-credential>
PAPERWORK_REVIEW_MODEL=z-ai/glm-5.3-flash
PAPERWORK_REVIEW_TIMEOUT_MS=120000
```

The review key is separate from `NEARAI_API_KEY`, which controls the existing compensation judge. Configuring review does not enable or change that judge. The browser receives only whether review is enabled. Neither key nor raw attestation reports enter the browser, logs or review events. CopilotKit telemetry is disabled before its runtime loads.

An explicit backend selection wins when migrating from existing Hermes settings. With both sets of credentials present and no selection, startup refuses the ambiguous configuration. A selected backend with missing credentials is refused. NEAR review always uses the standard gateway; compensation-judge URL/model overrides do not change it. The default deadline is 120 seconds; configuration accepts 1 to 300 seconds. Four active local review streams are allowed. Private context is capped at 192 KiB, the model's final text at 32 KiB, and the encrypted completion response at 512 KiB.

## Synthetic hosted check

From `demo` in a zsh terminal:

```zsh
(
  export PAPERWORK_REVIEW_MODEL='z-ai/glm-5.3-flash'
  read -rs 'PAPERWORK_REVIEW_NEARAI_API_KEY?Review NEAR API key: '
  printf '\n'
  export PAPERWORK_REVIEW_NEARAI_API_KEY
  bun --no-env-file scripts/check-review-near.ts --confirm-hosted
)
```

The hidden prompt keeps the key out of command history, and the subshell does not retain it in the parent environment. No dotenv file, app database, platform client or private job is loaded. The fixed synthetic requirement asks for date, project and amount columns; its report mentions only date and project. The check authorizes at most one paid model request. A pass requires verified inference, an exact quote and a finding identifying the missing amount column. It writes a mode-0600 verification record to a fresh temporary directory and prints the sanitized result and path.

Failure output uses fixed codes and attempted call counts. An inference attempt with a lost response leaves execution/billing unknown. Inspect that result before starting a replacement check. Do not paste the key into chat.

## What verification establishes

The SDK verifies attestation and byte-exact response signatures. The app's verification record summarizes those checks, the model signer, gateway binding and hashes of the review context/instructions. Those context hashes are application assertions. The record is not an independently portable attestation bundle, does not attest the Paperwork host, and does not approve a model image against an application-owned provenance allowlist. It contains hashes and proof metadata rather than the report or feedback. The browser gets only a compact verification summary.

Encryption starts at the Paperwork server. That server already reads the report from its database; neither E2EE nor a model TEE hides it from the app host. A valid signature also does not establish that a finding is correct. Source checks and human approval remain separate.

## Local verification

```sh
bun --no-env-file test tests/review-near.test.ts tests/review-near-client.test.ts tests/review-near-http.test.ts tests/review-near-check.test.ts tests/review-config.test.ts tests/review-dashboard-probe.test.ts
bun --no-env-file run typecheck
bun run demo:review:check
```

The SDK transport tests additionally use a temporary local HTTPS server to exercise matching and mismatched TLS public-key pins under Bun. The official SDK specifies Node 24.22.1+ for Node use; Bun 1.4.2 has been checked locally for imports, lifecycle behavior and its Node TLS transport. A real NEAR inference/attestation pass remains the explicit hosted check above.

Run the transport tests in an environment that permits loopback listeners. The synthetic hosted-check CLI enforces the same 1000–300000 ms configured deadline as the app server; shorter deadlines are reserved for injected offline lifecycle tests.

The browser demo uses an isolated scripted Hermes HTTP fixture and simulated accounts/funds to exercise the same UI and approval boundaries. It never calls a hosted model and is not evidence of live NEAR verification. Its legacy transport remains available for fixtures and separately configured Hermes users; the team-account investigation is in [hermes-review.md](hermes-review.md). This change does not deploy or restart either hosted application.
