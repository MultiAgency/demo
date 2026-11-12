# Report review with Hermes and NEAR AI Cloud

The agency's **Review assistant** compares one immutable report/invoice submission with its signed deliverables. It returns source-linked observations and editable feedback. **Use draft in feedback** populates the existing **Changes needed** field; the representative still submits through **Request changes**. Preparing, editing or applying a draft creates no compensation proposal, payout, signature or recorded feedback.

## Try the isolated demonstration

```sh
bun run demo:review
bun run demo:review:check
```

The first command prints a local job URL. The second runs a browser check and writes screenshots to a temporary directory. Both use simulated signatures, the platform stand-in and scripted Hermes HTTP responses. They do not call Hermes or NEAR AI Cloud, establish model quality, or verify the team-hosted runtime.

## Connection and account

The intended account is the user's [MultiAgency team workspace](https://portal.nousresearch.com/orgs/multiagency). The Portal organization URL is a dashboard, **not** a Hermes API origin or an inference endpoint.

Inspection on 2026-11-11 confirmed the team workspace and its existing general agent. Its dashboard reports **v0.23.0**, with `install_method: managed-runtime` and `can_apply: false` from the updater check. The dashboard cannot apply its own Hermes update. Managed image updates belong to [Portal management](https://hermes-agent.nousresearch.com/docs/guides/manage-hermes-cloud-with-mcp); availability of a v0.23.1 image has not been verified.

A new **paperwork-review** profile was created without cloning channels, memory or skills. Hermes can seed the launch model/provider even for a blank profile, so its seeded model block was explicitly cleared before saving the restricted configuration. Its environment has no configured keys. Read-back confirmed the NEAR origin and key-variable name, the pinned `z-ai/glm-5.3-flash` model, disabled memory and user profile, suppressed API/CLI toolsets, no configured MCP servers or hooks, disabled automatic skill creation/project discovery, and disabled title/background work. The review API remains **disabled**; these are saved configuration checks, not effective-runtime isolation or hosted inference evidence. The default Multi profile was not edited.

This is a **runtime profile inside the existing Multi instance**, not a separately provisioned Portal cloud agent or team member. The Portal's team agent list therefore still lists Multi. Runtime profiles appear in Multi's Hermes dashboard under Profiles and its profile switcher. In `/env?profile=paperwork-review`, `/env` is that runtime's Keys page and the query selects which profile it edits; it does not create or register an organization-level agent. The separate review profile was an implementation choice to keep its review configuration distinct, not a Hermes protocol requirement or an independent security sandbox.

The dashboard origin returns **200 text/html** at `/v1/capabilities`, the dashboard's SPA fallback rather than a Runs API response. Hermes's [API listener](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) normally runs separately on loopback port 8642. No supported hosted control for exposing that listener through authenticated TLS/private ingress has been established. Creating another paid Portal instance is not a verified solution to that routing gap.

A later public status check on the same date reports a running multiplex gateway with `api_server`, `relay` and `paperwork-review:relay` among its platform names; its sampled gateway state was `draining`. This establishes that an API adapter is advertised by the existing gateway, not that its Runs endpoint is externally reachable or the review profile is activated. Inspect the existing access/routing controls before provisioning another listener.

```text
Desk's custom React panel / CopilotKit core
  -> same-origin authorized CopilotRuntime
  -> AG-UI review agent
  -> authenticated Hermes Runs API on a restricted team review profile
  -> NEAR AI Cloud inference
```

Use a dedicated review profile under that team account. Its API must require bearer authentication, offer Runs submission/events/stop, and have all API toolsets disabled. The review profile must also have no default MCP servers, plugins, connected owner accounts, global memory, automatic skill writing or fallback inference providers. The existing general team agent must not be treated as isolated merely because it belongs to the right organization.

The [v0.23.1 activation example](hermes-review-profile.yaml) records the supported configuration keys, NEAR routing and remaining operator checks. Its YAML syntax was validated. The prepared hosted profile has the same restrictions but keeps the API disabled and has no credentials; the active configuration in the example has not been runtime-verified.

Hermes's toolset discovery excludes some default MCP tools, so the app's preflight is a compatibility check, not proof of complete isolation. If the stream reports tool, subagent, approval or clarification activity, the app stops that run and withholds the draft. Operator configuration is still needed to prevent those actions before they begin.

The profile's named custom provider `near` uses `https://cloud-api.near.ai/v1` and the `NEARAI_API_KEY` variable. The pilot is pinned to [`z-ai/glm-5.3-flash`](https://near.ai/models/z-ai/glm-5.3-flash), listed as Private TEE in NEAR's catalog on 2026-11-11. Confirm current API features before activation and supply its credential securely on the host. Disable provider fallbacks and auxiliary routes to other services. Hermes hosts the agent process; NEAR supplies inference. The Portal account alone does not configure this connection.

Then configure Paperwork's server:

```dotenv
PAPERWORK_HERMES_URL=https://your-authenticated-hermes-api-origin
PAPERWORK_HERMES_API_KEY=<server-held-Hermes-API-credential>
PAPERWORK_HERMES_PROVIDER=custom:near
PAPERWORK_HERMES_MODEL=z-ai/glm-5.3-flash
PAPERWORK_REVIEW_TIMEOUT_MS=90000
COPILOTKIT_TELEMETRY_DISABLED=true
```

Use an HTTPS origin, optionally followed by the team gateway's `/p/<profile>` prefix, without credentials, query or fragment. HTTP is supported only on loopback for local testing. The Hermes credential is different from the NEAR inference key. Paperwork never forwards either key to the browser; `/api/config` exposes only review availability. Existing `NEARAI_*` settings still configure the separate compensation assessor.

NEAR's [model catalog](https://docs.near.ai/cloud/models) distinguishes Confidential TEE, third-party confidential and Incognito routes. Incognito inference runs outside a TEE at the upstream provider. Choosing a confidential model does not protect Hermes's own storage, memory, logs or tools, and this app does not yet verify attestation or response signatures. No end-to-end verification claim is made.

## Hosted activation and synthetic check

First prove the provider connection in the existing hosted dashboard: securely configure `NEARAI_API_KEY` only in `paperwork-review`, then submit one synthetic review through that profile's Chat. The dashboard launches Chat with the selected profile's configuration. This narrower proof needs no SSH, exposed API port or additional Hermes API credential. It does not prove the application's Runs integration, the requested latest hosted version or cryptographic attestation.

For the application's automated review, a supported route to the Runs listener and appropriate authentication are still needed. Current dashboard documentation describes Portal peer passes and `/api/peer/p/<profile>/…`, but that route is absent from the v0.23.0 and v0.23.1 stable dashboard sources. A public status probe on 2026-11-11 confirmed v0.23.0 and no advertised `peer_access` contract on this host. Do not assume the managed host supports that route, or switch to development code merely to obtain it. [Current peer documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard#peer-passes-apipeer), [v0.23.1 dashboard source](https://github.com/NousResearch/hermes-agent/blob/v0.23.1/hermes_cli/web_server.py).

The managed runtime update to the requested latest stable version also remains pending. The workspace's operations pause still applies to live credential issuance and shared-runtime updates/restarts. Those actions have not been performed. No paid instance was provisioned and no hosted model request was made.

Stable source supports configuring this directly; contacting support is not a prerequisite. Under shared gateway multiplexing, a secondary profile's `API_SERVER_KEY` does not start a missing listener. The primary profile's shared API listener needs its own enabled configuration and startup key; otherwise the review profile needs a separately configured gateway/listener. Inspect the actual host controls and listener state before choosing an activation method. The profile example is not complete host provisioning.

Once the host is configured, provide the four `PAPERWORK_HERMES_*` settings securely in the process environment and run:

```sh
bun --no-env-file scripts/check-review-live.ts --confirm-hosted
```

This command does not load dotenv files, app configuration, a database or platform clients. It submits exactly one fixed synthetic report, uses the existing citation validation, and reads the admitted run's final status to check the served model and requested `custom:near` route. It has no automatic retry and prints only a bounded, sanitized receipt. Requested/served routing metadata does not prove the NEAR origin, attestation or TEE execution; host configuration and any cryptographic verification require separate evidence. The ordinary test suite exercises this script with offline fixtures only.

## Runtime contract and versions

The integration uses Hermes's documented [Runs API](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server), not the unmerged [native AG-UI adapter](https://github.com/NousResearch/hermes-agent/pull/65845). It requires authenticated `/v1/capabilities`, `/v1/toolsets`, `/v1/runs`, run events and run stop.

Latest stable integration packages resolved on **2026-11-11**:

| Package | Version |
| --- | --- |
| `@copilotkit/core` | `1.86.0` |
| `@copilotkit/runtime` | `1.86.0` |
| `@ag-ui/client`, `@ag-ui/core` | `1.0.4` |
| `rxjs` | `7.8.2` |

Versions are recorded exactly in `package.json` and `bun.lock`. AG-UI and RxJS overrides keep CopilotKit's transitive copies on the same latest versions; integration tests exercise the actual runtime. The lightweight CopilotKit core powers the existing React controls instead of importing the full chat UI.

The latest official Hermes stable release observed on the same date is [v0.23.1](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.1), published November 10. This repository does not package, update or restart the team-hosted Hermes service. Its installed version and enabled API capabilities must be confirmed when connecting it.

## Scope, state and recovery

All review routes require the existing named representative's access, with host/origin checks and bounded JSON requests. The server derives review context from stored signed terms and the selected submission. It discards browser-supplied messages, tools, state, model settings and context. It never invokes `proposeJob()`, `getContract()` or platform follow-up to gather review facts.

Every draft uses a fresh opaque Hermes session and admission identity. There is no shared review history, replay store or automatic retry. Only active streams are retained, scoped by deployment, account and submission; at most four local review streams run per process. Configure Hermes's own concurrency cap as well: upstream work may outlive a detached local stream. The default deadline is 90 seconds, and response/input sizes are bounded. Cancellation requests a stop of the original run; a stop acknowledgement is not proof that upstream work has ceased.

Only validated final JSON reaches the interface. Each finding must name exactly one known signed deliverable, cite evidence indices belonging to it, and quote only exact substrings of the report. Evidence URLs are displayed from the original submission; they are not fetched or independently verified. The agent's free-text conclusions remain suggestions for human review. Raw reasoning, model commentary, tool previews and upstream errors do not reach the browser.

The server checks the submission fingerprint again before releasing a completed draft. Account, accepted terms, revision, state and proposal changes clear the UI context. Applying feedback stays local until the existing explicit submit action. The normal server guards remain authoritative if workflow state changes afterward.

The runtime emits keepalives every five seconds so quiet inference remains connected beyond Bun's ten-second idle limit. The browser check deliberately holds a scripted review open for more than ten seconds before cancelling it.

## Validation

Focused tests cover malformed or invented citations, tool-enabled profiles, foreign run events, deadlines, truncated streams, cancellation, role/origin guards, stale submissions, cross-submission controls, concurrency and unchanged domain records after drafting. The browser demonstration covers generation, editing, explicit application and cancellation using scripted sources.

Activating the prepared team profile and running an actual NEAR inference request remain separate from these offline checks. Production deployment/restarts and live credential issuance remain subject to the workspace's operational pause.

The implementation checks on 2026-11-11, before the hosted-check script was added: typecheck passed; **685 tests passed** (3,953 assertions, 43 files); whitespace checks passed. The browser command passed generation, edited explicit application, a quiet stream exceeding ten seconds, cancellation/retry and desktop/mobile layout checks. Its receipt and screenshots are in `/var/folders/v_/45s63t697hg3gbvvpvzwyjd40000gn/T/paperwork-review-fgf270/`. This is scripted integration evidence, not hosted model evidence.

After preparing the hosted-check script, its offline fixtures plus the existing transport tests passed **20 tests, 116 assertions**. TypeScript passed again. Documentation links, activation YAML syntax and whitespace checks also passed. The full suite and browser demonstration were not repeated for this preparation step.
