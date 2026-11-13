# Deploying the app server

The app server, with the web app it serves, is configured for Railway: project `paperwork`, one service `server`, built from this
repository's `Dockerfile` with the settings in `.railway/railway.ts`. Its target is `desk.multiagency.ai`.

`paperwork.multiagency.ai` already hosts Documenso. Keep that hostname and service intact; the Paperwork app uses `desk.multiagency.ai` while retaining deployment `multiagency-paperwork` and Railway project `paperwork`.

All of Paperwork lives at `desk.multiagency.ai`: private work, agency offers and approvals, public openings, onboarding and connected Market work. Use `PUBLIC_URL=https://desk.multiagency.ai` for the single service and mounted database. Public openings remain shareable at `/#/openings`; private views retain their named-party authorization. The separate Jobs host plan was dropped. Remove any nonempty `PAPERWORK_JOBS_PUBLIC_URL` from local/service configuration; startup rejects that retired setting. No browser state, accepted terms or pending payment is migrated between origins. See the [Desk walkthrough](jobs-portal.md). Hostname configuration and the scoped deployment are complete; further live changes require separate authorization.

**Deployed:** `https://desk.multiagency.ai`, source `ef73b585a5cf885d702a6c75d44c46c3c87f013d`, Linux AMD64. This is the one Paperwork environment: Railway project `paperwork`, environment `staging`, service `server`. It connects to `https://api.dev.multiagency.ai`, whose chain/funds are real. There is no separate Paperwork staging hostname. Documenso remains at `paperwork.multiagency.ai`.

The owner separately approved resource provisioning, one seven-day app credential, configuration/DNS changes, an initial exact-source deployment, and a separately approved state-preserving ef73b58 update with read-only checks. Those actions are complete; they grant no standing redeploy/restart, credential rotation, wallet-signature or funds authority. [Current deployment and acceptance record](deployment-update-ef73b58.json); [initial deployment checkpoint](deployment-acceptance.json). The credential expires November 19, 2026 at 21:07 UTC; renewal needs separate authorization.

The existing 50,000 MB `server-volume` remains mounted at `/data`; do not replace it. IaC now reflects that size and the verified `ON_FAILURE` / three-retry policy. The API's legacy `RAILPACK` enum coexists with effective `build.builder=DOCKERFILE` and `dockerfilePath=Dockerfile`; do not switch builders to resolve that representation difference. Local IaC alignment was not applied to the live service. Any future full IaC plan must independently verify existing resource IDs, variables and environment before application.

## The service

- **One replica, a volume at `/data`.** The SQLite database (contracts, payout requests, hires, DAO votes, jobs) is a
  file there with one writer, and the timers that follow payouts, hires and jobs run in the process, so the service
  never scales out. With `REQUIRED_MOUNT=/data` the server refuses to start unless Railway reports the volume mounted
  there (`RAILWAY_VOLUME_MOUNT_PATH`) and `DB_PATH` is on it, so a deploy without the volume never starts on the
  container's own disk, where every saved requestId would be lost on the next deploy.
- **Health check:** `GET /api/health`. It answers only once the configuration was checked at startup
  (`src/server/config.ts`), so a deploy that would fail to start never takes traffic.
- **No stand-in by accident.** With `NODE_ENV=production` (the image sets it) the server refuses to start without
  `PLATFORM`. `PLATFORM=remote` also requires `PLATFORM_URL`, the credential, `DB_PATH`, `BETTER_AUTH_SECRET` and an
  https `PUBLIC_URL`. Demo controls (`/api/sim/*`) exist only with the stand-in or a local stack.
- **Secrets as variables.** The credential, `BETTER_AUTH_SECRET` and the market worker's token and secret stay in
  server memory: never in `/api/config`, events, logs or URLs.

## Existing state during the rename

The new database path is `/data/paperwork.sqlite`; changing the default does not migrate or rename an older file. Keep any old database intact. Recover its records only with `DB_PATH` pointing to that file, its original `PLATFORM_DEPLOYMENT` and the credential issued for that deployment. Database/deployment mismatch is refused; an old pending payment is never adopted into `multiagency-paperwork`.

Existing job rows retain their original `covenant` signing recipient, including partial signatures; new jobs store `multiagency-paperwork`. New browser keys use `paperwork.*`, while recovery may read a legacy pending submission only under its original saved body and client key. A new project, filename or storage prefix does not authorize a replacement payment or submission.

## Variables

| Variable | Value |
| --- | --- |
| `PLATFORM` | `remote` |
| `PLATFORM_URL` | `https://api.dev.multiagency.ai` (staging) |
| `PLATFORM_DEPLOYMENT` | `multiagency-paperwork`: the credential's deployment |
| `PLATFORM_CREDENTIAL` | the `tap_…` token (secret) |
| `REQUIRED_MOUNT` | `/data` |
| `DB_PATH` | `/data/paperwork.sqlite` |
| `PUBLIC_URL` | `https://<host>`, the Paperwork entry (production target `https://desk.multiagency.ai`) |
| `BETTER_AUTH_SECRET` | Existing stable server-held secret; preserve its value |
| `SIWN_RECIPIENT` | the NEP-413 recipient sign-in names (default `multiagentic.near`) |
| `NEAR_RPC_URL` | optional: NEAR RPC for key checks and DAO roles (default `https://rpc.mainnet.fastnear.com`) |
| `GITHUB`, `GITHUB_TOKEN` | `github`, and a token for the GitHub API's rate limit (secret) |
| `NEARAI_API_KEY` | optional: the NEAR AI Cloud judge (secret); without it the rule-based judge runs |
| `MARKET_URL` | optional: the market's HTTP API (default `https://market.near.ai`) |
| `PAPERWORK_MARKET_BOARD_TOKEN` | optional server-held `aat_` token for the public Market board. Independent of worker/webhook/agency setup; falls back to the configured worker token. Never browser-visible |
| `MARKET_AGENT_TOKEN`, `MARKET_WEBHOOK_SECRET`, `MARKET_WORKER_AGENCY` | optional, all three or none: the worker side (secrets). The market's webhook URL is `<PUBLIC_URL>/api/market/webhook` |

`PORT` and `RAILWAY_VOLUME_MOUNT_PATH` are Railway's. `.env.example` lists the rest, each with a default.

Published MultiAgency openings use anonymous reads of `https://multiagency.ai/api/settings` and NEARN's public sponsor catalog. No credential is needed for that source. Market's board API requires its own agent token even though it returns the same public set to each caller; without one, that source shows an unavailable state and a direct Market link. Neither source forwards the visitor's cookies or creates a bid, application or payment.

## Service settings

`.railway/railway.ts` declares the service and its volume: build, health check and replicas. Railway keeps a required
mount unset when it's set from the file (as for Treasury's service), so the server checks the volume itself
(`REQUIRED_MOUNT`). Railway doesn't read the file during deploys; it stores what the last apply set. After changing it:

```sh
railway config plan    # read-only: what would change
railway config apply   # asks before changing anything
```

Variables are listed with `preserve()`, so their values stay in Railway. A variable added in Railway is added to the
file too, or the plan stops. `bun run typecheck` compiles the file against the `railway` package.

## The credential

The platform's operator issues it on the gateway, from the gateway's state directory, and the token prints once. Run it
in your own terminal, so the token goes nowhere but the variable above (as for Treasury's, `agentic-treasury/docs/deploy.md`):

```sh
railway ssh -p <platform project id> -e <platform staging environment id> -s <gateway service id> -- \
  sh -c 'cd /data/state && /app/node_modules/.bin/tsx /app/src/app-credential.ts issue multiagency-paperwork api.dev.multiagency.ai 7 "MultiAgency Paperwork"'
```

The current credential was issued for seven days, expiring November 19, 2026 at 21:07 UTC. Before expiry, the owner must separately authorize any issuance, binding, restart and revocation scope. Preserve the stable auth secret. Never print credential values into logs or receipts.

## Deploying

The live service uses manual source delivery and has no GitHub/image source connection. Keep automatic merge deployment disconnected. A future separately approved deployment builds from the reviewed `Dockerfile` and a clean export; do not upload a dirty checkout, local `.env` or database. The following commands are operator reference, not standing authorization:

```sh
railway config plan --detailed-exit-code   # review drift and resource identities; apply only with separate authorization
paperwork_export=$(mktemp -d /tmp/paperwork-deploy.XXXXXX)
git archive <reviewed-commit> | tar -x -C "$paperwork_export"
railway up "$paperwork_export" --path-as-root --service server --environment <approved-environment>
# Retain the export for provenance; remove only this exact directory after review.
```

The first deploy: set the variables, `railway config apply`, deploy, then `railway domain` for the service. Staging uses
the domain Railway shows; `desk.multiagency.ai` gets a CNAME at it once production is unpaused. Set `PUBLIC_URL` to the
domain before the first owner signs in.

Then: `GET https://<host>/api/health` answers `{"ok":true}`, `/api/config` shows `"platform":"remote"` and the
platform's host, and sign-in works with a NEAR wallet (not yet tested end to end).

## Checked locally (2026-11-11)

`docker build` of this `Dockerfile` (Bun 1.4.2), run with placeholder values and nothing contacting a platform:
- refused to start with no `PLATFORM`, with no volume mounted at `REQUIRED_MOUNT`, with an http `PUBLIC_URL`, and with
  `DB_PATH` off the volume;
- with all of them set: `/api/health` `{"ok":true}`, the web app served, the credential absent from `/api/config`,
  `/api/sim/*` 404, the agency list 401 signed out, and the database on the volume, kept across a restart.

Nothing was deployed, and no credential was issued.


> **Renamed 2026-11-11:** The app is now **MultiAgency Paperwork** (UI **Paperwork**), deployment `multiagency-paperwork`. Historical text, identifiers, commands and artifact paths above remain as recorded; they do not verify the renamed candidate. Current instructions are in the [README](../README.md).


## Local production packaging gate (2026-11-12)

The image now builds an immutable frontend once with `scripts/build-web.ts`. `PAPERWORK_WEB_DIST=/app/web-dist` selects manifest-verified static routes; assets are available immediately after startup, even before the HTML route is requested. Previously, runtime HTML bundling failed the asset-before-HTML restart check. Local development keeps Bun's HTML bundler when this variable is absent. Preserve the complete built frontend directory/manifest and previous release images/assets; do not delete old hashed assets during a future rollout. The local restart proof does not qualify cross-version backend rollback or automatic old-asset hosting across different images.

The Docker build context is allowlisted, and the image copies only the active `multiagency-sdk-0.5.9-252cba1.tgz`. Inactive vendor artifacts and local state never enter the image. The SDK's verified vendored pin remains unchanged after npm publication.

Local checks (no hosted access):

```sh
bun --no-env-file scripts/check-sdk-pin.ts
bun --no-env-file run typecheck
bun --no-env-file test
docker build -t paperwork-local:check .
bun --no-env-file scripts/check-container.ts paperwork-local:check /tmp/paperwork-container-check-unique
```

Use a fresh receipt directory per run. The container check uses `--network none`, fixture credentials and a generated disposable volume. It checks Linux/SDK identity, startup refusals, auth/private/public responses, no demo endpoints, no credential disclosure, real production assets and original synthetic SQLite job identity across a local container restart. It starts no real wallet/provider/payment flow. Image IDs, build input hashes and receipts for arm64/amd64 are in `/tmp/paperwork-local-release/verification.json`. Local Linux amd64 checks used Docker Desktop emulation; merged-main CI and the live AMD64 package now pass. See deployment-acceptance.json for exact evidence.

`.github/workflows/verify.yml` runs locked install, SDK binding, typecheck, tests, simulated job/security/browser/privacy checks and local container build/smoke with read-only repository permission. It has no deploy, registry login, image push or payment step. `actionlint` validates the workflow locally; both reviewed-head and merged-main GitHub checks passed. Frozen-gateway DAO/restart receipts remain separate because that external snapshot is not shipped in this checkout.
