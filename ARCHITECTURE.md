# Architecture

Paperwork is one Bun process serving a React interface and Hono API from one origin, backed by SQLite. Jobs, discovery, sign-in and Market integration share that process and database.

## Stack and source map

Bun, strict TypeScript ESM, React, plain CSS, Hono, Zod, `bun:sqlite`, Better-Auth/better-near-auth and the MultiAgency SDK form the core stack. Optional assessment uses NEAR AI Cloud; review drafting uses Hermes through CopilotKit/AG-UI. Versions and commands are authoritative in [package.json](package.json) and [bun.lock](bun.lock).

| Path | Responsibility |
| --- | --- |
| `src/shared/` | Schemas, canonical terms/hashes, exact money and view contracts |
| `src/server/index.ts`, `app.ts`, `config.ts` | Startup, composition, routes, authorization and configuration |
| `src/server/db.ts` | SQLite schema, compatibility checks and deployment binding |
| `src/server/engine.ts`, `onboarding.ts`, `payouts.ts` | Job workflow, durable owner steps and payment accounting |
| `src/server/platform/` | SDK adapter, stand-in, chain reads and isolated-stack helpers |
| `src/server/market/` | Agencies, hires, worker, Market API and persistence |
| `src/server/jobs/` | Public openings and stored personal-attention projection |
| `src/server/review/`, `src/shared/review.ts` | Authorized review context, Hermes transport and streamed drafts |
| `src/server/recovery/`, `scripts/inspect-ledger.ts`, `scripts/collect-ledger-evidence.ts`, `scripts/export-restoration.ts` | Standalone ledger/compatibility inventory, four allowlisted SDK observations, advisory preview, in-memory restoration and private export; no app startup or sends |
| `src/web/` | Hash routes, shared UI, sessions, account-scoped resources and wallet signing |
| `scripts/`, `tests/`, `docs/` | Local workflows, checks and detailed evidence |

`bos.app.ts` is an everything.dev identity descriptor outside the app typecheck. Docker/Railway configuration assumes one replica with a persistent database under `/data`; operation guards are process-local.

## Startup and state

`loadConfig()` → `createRuntime()` → `Bun.serve()`. Bun serves the HTML entry at `/` and routes `/api/*` to Hono. The runtime composes the database, auth, platform adapter, engine and optional services.

Contracts link to immutable submissions/invoices, judgments, payout attempts and per-deliverable payout lines. Owner steps retain signing/confirmation identities. Auth and Market records share SQLite. WAL, foreign keys and unique open-work constraints support the workflow.

The database binds to its platform deployment. The default deployment and new terms-signature recipient are both `multiagency-paperwork`, but they are separate concepts. Old jobs retain their signing recipient. Renaming the app or database path does not migrate records; incompatible state is refused.

## Job and review flow

```text
terms + two signatures → dedicated job Organization/agent
  → consent, grant, policy, funding
  → report + invoice (v3) / eligible merged PRs (v2)
  → persisted judgment/payout identity → SDK held payout
  → agency approval → observation → settlement or unresolved outcome
```

The app owns business records and compensation accounting; the platform owns guarded execution. Preflight checks signed policy fields, grant lifetime and job dates. The platform enforces consent on its calls. Paperwork holds an app credential rather than production owner/provider keys. Recovery rules are in [RULES.md](RULES.md).

Both workflows require consistent platform non-execution proof before a failed payment releases compensation. Observed transaction/refund evidence is retained, including the nullable `refunded_amount` column. Failed payments keep their original binding through regressive or conflicting observations. Startup refuses unsafe historical releases before migrations. Standalone recovery tools inspect immutable snapshots, inventory all three known database compatibility gates, collect bounded SDK reads and produce advisory comparisons. Restoration returns corrected private bytes and an audit; export saves a separate durable bundle. A separate opt-in SDK rehearsal starts only disposable working copies, with no timers and traced read-only SDK dispatch. It verifies unrelated startup refusal, process restart and original settlement while retaining sources/bundles. Deployment binding still follows `openDb()`; read-only preflight must catch a mismatch before candidate startup. Real historical installation/resumption is outside this rehearsal. [Recovery details](docs/recovery-acceptance.md) specify the limits.

Representative detail reads and timers can reconcile or advance an existing judgment into another capped, held payout sequence. Market agency reads can resume an already approved hire. `/api/jobs/mine` is a separate stored-only projection; do not assume every GET is free of workflow effects.

The optional Review assistant uses same-origin CopilotKit/AG-UI to send an authorized stored submission to the configured Hermes service. Signed criteria, report, reference metadata and invoice leave the app; credentials stay server-side. Validated output fills an editable feedback draft without changing payment authority. Paperwork retains active streams, not completed review history; Hermes retention is a separate service concern.

## Access and browser state

| Surface | Current access with authentication required |
| --- | --- |
| V3 full job/submissions | Named representative or builder; mutations remain role-specific |
| V2 full job by ID | Public read |
| Verification API and opening projections | Public projections |
| Market wallet agency/worker | Wallet owner |
| Market DAO agency/worker | Members read; proposal-capable members mutate, subject to platform/DAO approval |
| Review assistant | Named representative |

The approved target makes existing/new v2 full details party-only and public verification minimal; implementation is pending. See the [access contract](docs/recovery-acceptance.md#v2-privacy--approved) for the target field/role matrix, including protected owner preparations.

Auth-disabled fixtures bypass role checks. Explicit public-origin or remote/production configuration enforces API host/origin; health is an internal probe exception. Current browser/access gaps are in [PROGRESS.md](PROGRESS.md).

`src/web/main.tsx` owns hash routing. Account-scoped job, agency and worker resources discard stale responses after account changes. The wallet adapter signs exact NEP-413 payloads with ed25519 verification; confirm-only/NEP-366 actions stay on the platform page.

Browser storage retains original invitation tokens and exact pending submission payloads/client keys, including compatible legacy reads. Accepted authenticated builders can use their named-account view without the invitation token. Public openings read MultiAgency/NEARN; the paginated Market board needs a server-held agent token independently of SDK agency setup.

## Runtime modes

| Mode | Behavior |
| --- | --- |
| `PLATFORM=fake` | In-process stand-in and fixture signing; provider state is lost on process replacement |
| Remote with `PLATFORM_STACK_DIR` | Actual SDK/gateway with an isolated simulated provider, chain and fixture signing |
| Remote without a stack | Requires HTTPS origin, durable DB, auth secret and server app credential; no demo signer/controls |

Fake platform mode alone does not disable external discovery reads; offline scripts inject source fixtures. The stack directory is refused in production. See [.env.example](.env.example), [README.md](README.md) and [PROGRESS.md](PROGRESS.md) for configuration, workflows and current limitations.
