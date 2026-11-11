# Agent Market boundary

Read-only verification: **2026-11-11**. Official HTTP documents were fetched from `market.near.ai`; OpenAPI reports `agents-market API` **2.0.0**, buyer skill **0.45.0**, x402 caller skill **0.2.0**. These are current documentation observations, not a hosted transaction test.

## Selected boundary for the builder job

**Paperwork owns this job's offer, signed acceptance, report, invoice, compensation proposal and review. The MultiAgency platform owns authorization, held payout approval, dispatch and settlement.** The current app reuses the existing payout integration through pinned `@multiagency/sdk` **0.5.7**. The builder is the contractor account named in the signed terms. AI recommends within those terms; only the agency representative can authorize the held payout.

This boundary extends the held-payout integration originally present at `11e1b16` with SDK 0.5.6 in [demo PR #6](https://github.com/MultiAgency/demo/pull/6). There is one payment authority for this job: the platform payout record and its durable `requestId`. An invoice or local review decision does not establish payment. No market assignment or x402 authorization is also created for it.

This selection preserves the user's explicit post-submission agency approval requirement. It does **not** complete the separately agreed product ambition of agencies buying and selling listed-agent work on the market.

## Supported market routes

| Route | Offer and acceptance | Submission and review | Payment authority | Fit |
| --- | --- | --- | --- | --- |
| Standard account-backed marketplace job | Buyer posts job; worker bids; buyer awards and funds held price; worker declares start | Worker submits; buyer accepts or requests changes; review also ends by timeout or dispute ruling | Market held funds and payout/ledger | Supports review, but silence can pay and compensation is the awarded price |
| Account-backed direct hire of listed agent | Buyer approves hire draft at listing price | Same account-backed review model | Market held funds and payout/ledger | Review exists, with the same timeout |
| A2A + x402 listed-agent call | Caller signs the quoted payment authorization before work | Submission is automatically accepted and payment settles on delivery | Market facilitator/chain, then treasury sweep to worker owner's balance | Cannot preserve agency review after delivery |
| Paperwork builder job (selected) | Signed scope offered by agency and accepted by builder | Report/invoice → agent proposal → explicit agency vote, or changes | Existing platform held withdrawal and confirmed settlement | Preserves agreed workflow without a second payment path |

Account-backed hires have a **3–7 day** acceptance window, default **3**, frozen at hire. `accept_result` currently returns `action_required` and a job-page link; the person completes acceptance there. `request_changes` removes the current version from review and re-arms the delivery SLA. A message alone does not stop auto-acceptance. Buyer MCP tools are advertised as `marketplace__post_job`, `prepare_job`, `list_bids`, `award_bid`, `get_job_status`, `get_job_result`, `accept_result`, and `request_changes`; availability depends on deployment. `award_bid` also directs the person to the job page. [`MCP buyer contract`](https://market.near.ai/skill/mcp-buyer/SKILL.md)

Market terms describe collected/held funds and a published 5% fee, while expressly saying the arrangement is not legal escrow. Release may also follow inaction or dispute resolution. Thus using market settlement would change the strict “agency approval remains explicit” requirement. The reported x402 fee discrepancy in the earlier prototype is unresolved; documentation does not resolve a transaction-specific fee outcome. [`Standardized Job Terms`](https://market.near.ai/v1/legal/job-terms)

## Current official endpoints and actors

All REST paths below are relative to `https://market.near.ai`. The current [OpenAPI](https://market.near.ai/openapi.json) lists:

| Actor/action | Endpoint |
| --- | --- |
| Public agent discovery and pricing | `GET /v1/agents`, `GET /v1/agents/{agent_id}/pricing-plans` |
| Worker discovers board jobs | `GET /v1/jobs/board`, `GET /v1/jobs/{id}` |
| Worker bids | `POST /v1/jobs/{id}/bids` with `amount`, `proposal`, optional `slaSeconds` |
| Human worker profile | `GET /v1/me/worker` |
| Agent assignment queue | `GET /v1/agents/me/assignments` |
| Worker declares start | `POST /v1/assignments/{id}/start` (idempotent) |
| Worker submits | `POST /v1/assignments/{id}/submit` with `deliverableMarkdown`, optional `files` |
| Read submitted versions/evidence | `GET /v1/assignments/{id}/deliverable/versions`, `GET /v1/assignments/{id}/files` |
| Buyer jobs and financial evidence | `GET /v1/me/jobs`, `GET /v1/wallet/ledger`, `GET /v1/wallet/balance` |

`POST /v1/assignments/{id}/review` is a **reputation review after payment clearance**, not payout approval. Current OpenAPI does not publish buyer award/accept/change endpoints; use the documented MCP/page flow rather than inventing REST paths. No invoice or post-delivery variable-compensation endpoint was identified in that contract.

Humans can bid with their account session and `asSelf: true`; an owned listed agent uses `agentId`, while an `aat_` bearer pins the worker from the token. Human and agent identity therefore are separate supported cases, not interchangeable tokens. A human's first self-bid creates a worker profile. An agent bearer cannot act as a buyer account or move owner funds. [`Worker API reference`](https://market.near.ai/skill/reference/agent-api.md), [`Marketplace overview`](https://market.near.ai/llms.txt)

Assignments normally follow `in_progress → submitted → accepted`; changes return them to `in_progress`. Disputes may end accepted, cancelled, partially resolved, or back in progress. Identical submit retries with the same Markdown/file set are no-ops; changed contents create a new version. **Accepted does not prove settlement:** an account-backed payout may wait after a rail refusal; an agent token cannot inspect its owner's wallet. Owner ledger/balance confirmation is a separate observation. [`Worker lifecycle`](https://market.near.ai/skill/flows/worker-lifecycle.md)

Paperwork records a durable attempt ID, start and complete server version baseline **before** posting a worker submission. Recovery reads `GET /v1/assignments/{id}/deliverable/versions` with its agent bearer, then compares only newer versions against the saved baseline and reads their managed Markdown through `/v1/assignments/{id}/deliverable/versions/{version}/raw`. A newer version with a nonregressing server timestamp and the exact submitted Markdown confirms arrival. Older versions and bare assignment status cannot confirm the new revision. Server version order supplies the boundary; a shared app/server clock is not assumed. [`OpenAPI`](https://market.near.ai/openapi.json), [`Worker API reference`](https://market.near.ai/skill/reference/agent-api.md)

A complete unchanged baseline permits an explicit retry of the **same** saved Markdown under the original attempt ID; it never resends automatically. Failed/malformed reads, mismatched newer content and historical pending rows lacking an attempt baseline remain unknown. Failed initial baseline reads send no POST and report preflight failure. Unbound historical agency rows remain hidden and unchanged while healthy polling continues. Assignment status, acceptance and settlement stay separate from delivery evidence. The earlier “any version means delivered” rule was incorrect for rework and is superseded by these attempt-specific checks.

An uncertain DAO hire filing is recovered only through its original request ID and approved terms. Platform 0.5.7 can return a matching retained request; Paperwork probes with an already-expired filing deadline so that neither an older gateway nor an absent/lapsed request can create a fresh vote. Recovery validates the original identity and requires null new proposal transactions before linking the existing vote. A 0.5.6 or unsupported response stays blocked with an explicit explanation. Payment status is observed first, so an already confirmed payment never becomes another filing.

## Why x402 cannot be the payout leg for this job

Listed agents expose `https://{handle}.market.near.ai/a2a/v1`. Unpaid `SendMessage` returns a 402 quote; the caller signs the exact quoted USDC payment and repeats with `X-PAYMENT`. Preserve `task.id` for free `GetTask` observation. The quote uses the default pricing plan; the caller does not set a later compensation amount. `maxTimeoutSeconds` covers the delivery window plus ten minutes. A 502 is documented as requiring the same signed header, not a newly signed replacement. [`x402 caller contract`](https://market.near.ai/skill/x402-caller/SKILL.md)

The market converts that call into an assignment, but its worker submission **automatically accepts** it and settles the caller's payment. A subsequent sweep credits the worker owner's market balance; that is distinct from the caller's settlement. This shared assignment shape does not make its review lifecycle equivalent to standard jobs. [`A2A worker lifecycle`](https://market.near.ai/skill/flows/a2a-x402.md)

Future switching to market settlement requires a product decision accepting its fixed awarded/listed price, fee, custody and timeout/dispute behavior. Never pay the same obligation through both a market assignment and Paperwork's held withdrawal. Hiring a listed agent to assess a builder's work would be a separate service job, with its own agreed budget and payment identity.

## Evidence boundaries

- **Initial integration:** demo PR #6 at `11e1b16`, SDK 0.5.6; its held-payout implementation is reused by the current SDK 0.5.7 app. PR CI success is not workflow or settlement evidence.
- **Historical local integration:** [evidence.md](evidence.md) records the 2026-11-10 platform `96a0bb6` run through SDK 0.5.4 with simulated provider, chain and signatures. It does not verify this new builder submission slice or a hosted release.
- **Historical prototype/mainnet:** the workspace's `sdk/docs/market.md` records 2026-11-09/10 x402 delivery settlement and earnings return outside the platform. Those observations do not establish hosted platform market support. That record also reports a payment-expiry discrepancy with current caller instructions; do not resolve it by signing live requests here.
- **Initial public-document observation:** official docs and OpenAPI above were read on 2026-11-11. No account was created, authenticated mutation made, credential issued, external message sent, deployment performed, or funds moved for this research.
- **Platform release/deployment:** see the dated public checks and deployment record below. Package publication, public liveness and tested hosted behavior remain separate evidence.

OpenAPI snapshot SHA-256: `2c7b2496e05f56aece8b13f8a825845a54b8cae9689efd4f3acf79ea28e32cd3`. Buyer skill: `6064a4bf13052e3035e76be9325858398908938103345ea1832226fc58de93fb`. x402 caller: `cd156d246362a5681ded143bf02dfab8ca721d24b800534a2101d2136505ffe4`.

## Release and hosted checks — 2026-11-11

These are the initial read-only observations from this date, before the later 0.5.7 source review; they are not a claim that npm's `latest` tag or hosted versions remained unchanged. The app was pinned to SDK 0.5.6 at that initial check; it now pins SDK 0.5.7. Fresh integration against the named platform-main candidate is recorded in [PR #9 review](pr-9-review.md), separately from the unchanged default `36a66cb4` / `f7caad4` simulator pin.

The initial public metadata established:

- [Platform PR #42](https://github.com/MultiAgency/platform/pull/42), the held-withdrawal approval fix, merged **2026-11-08 22:22:03 UTC**, merge `b0ee19042b8522ef61e5715ce702c6edda0594c3`.
- [Platform PR #61](https://github.com/MultiAgency/platform/pull/61), market hires and hosted-agent release, merged **2026-11-10 17:11:53 UTC**, merge `f7caad4537e982190094e2654a064b25e7725f8a`.
- The [npm registry](https://registry.npmjs.org/@multiagency%2fsdk) reports `latest: 0.5.6`, published **2026-11-10 17:55:33.015 UTC**; its tarball is `https://registry.npmjs.org/@multiagency/sdk/-/sdk-0.5.6.tgz`, integrity `sha512-phD2cZFoajM3VG3zLmLYQVwiXVHuBKpQd6UWt1jnVcJgRGHdmKMva727rRijdsWXvVXLEv5XmCo9L7JVlYXvEQ==`. The [sdk-v0.5.6 tag](https://github.com/MultiAgency/platform/tree/sdk-v0.5.6) points to `6252bd357f7c1f9d76da1aa8425239739144a3b8`. GitHub's Releases list was empty; npm publication and Git tags are the available release metadata.
- Both [staging health](https://api.dev.multiagency.ai/health) and [production health](https://api.multiagency.ai/health) answered HTTP 200 with `{"ok":true}`. Both documented `/apps/v1/agents/x` probes answered HTTP 401 without credentials. These prove public liveness and credential refusal only; neither response exposes a version or proves approval/market capability.

The platform's committed [staging deployment record](https://github.com/MultiAgency/platform/blob/75286430f2375ed6671edcbf9933df47846383f8/docs/platform-staging.md) reports **0.5.6**, source `f7caad4`, checked **2026-11-10 22:38 UTC**, candidate `36a66cb4`, deployment `ffcb4120`, image prefix `sha256:d5201b74…`; its recorded validation is smoke checks and matching confirm assets, with no new money-path exercise. The [production record](https://github.com/MultiAgency/platform/blob/75286430f2375ed6671edcbf9933df47846383f8/docs/platform-production.md) last records **0.5.4** on **2026-11-08 22:17 UTC**. Neither that older production entry nor today's health response establishes today's production version. No authenticated capability check or hosted payout/hire was performed here.


> **Renamed 2026-11-11:** The app is now **MultiAgency Paperwork** (UI **Paperwork**), deployment `multiagency-paperwork`. Historical text, identifiers, commands and artifact paths above remain as recorded; they do not verify the renamed candidate. Current instructions are in the [README](../README.md).
