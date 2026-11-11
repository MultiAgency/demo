# Deploying the app server

The app server, with the web app it serves, runs on Railway: project `jobs`, one service `server`, built from this
repository's `Dockerfile` with the settings in `.railway/railway.ts`. Its target is `jobs.multiagency.ai`.

**Not deployed yet.** Production deploys are paused (workspace `AGENTS.md`), and the market's live hires wait for the
platform's first staging hire, run by the owner with small amounts. Staging comes first: this service against the
platform at `api.dev.multiagency.ai`, on its Railway domain or a staging subdomain, not `jobs.multiagency.ai`.
`api.dev.multiagency.ai` runs on mainnet: real agents, owners and funds. When the platform's production host
(`api.multiagency.ai`) exists, the same service moves there by changing `PLATFORM_URL` and the credential, which is
issued per host.

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

## Variables

| Variable | Value |
| --- | --- |
| `PLATFORM` | `remote` |
| `PLATFORM_URL` | `https://api.dev.multiagency.ai` (staging) |
| `PLATFORM_DEPLOYMENT` | `multiagency-jobs`: the credential's deployment |
| `PLATFORM_CREDENTIAL` | the `tap_…` token (secret) |
| `REQUIRED_MOUNT` | `/data` |
| `DB_PATH` | `/data/jobs.sqlite` |
| `PUBLIC_URL` | `https://<host>`, the service's domain. Sign-in names this host, so it isn't changed once owners have signed in |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` (secret) |
| `SIWN_RECIPIENT` | the NEP-413 recipient sign-in names (default `multiagentic.near`) |
| `NEAR_RPC_URL` | optional: NEAR RPC for key checks and DAO roles (default `https://rpc.mainnet.fastnear.com`) |
| `GITHUB`, `GITHUB_TOKEN` | `github`, and a token for the GitHub API's rate limit (secret) |
| `NEARAI_API_KEY` | optional: the NEAR AI Cloud judge (secret); without it the rule-based judge runs |
| `MARKET_URL` | optional: the market's HTTP API (default `https://market.near.ai`) |
| `MARKET_AGENT_TOKEN`, `MARKET_WEBHOOK_SECRET`, `MARKET_WORKER_AGENCY` | optional, all three or none: the worker side (secrets). The market's webhook URL is `<PUBLIC_URL>/api/market/webhook` |

`PORT` and `RAILWAY_VOLUME_MOUNT_PATH` are Railway's. `.env.example` lists the rest, each with a default.

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
  sh -c 'cd /data/state && /app/node_modules/.bin/tsx /app/src/app-credential.ts issue multiagency-jobs api.dev.multiagency.ai 90 "MultiAgency Jobs"'
```

It lasts 90 days. Before it expires, issue a new one the same way, set the variable, restart, and revoke the old one
(`app-credential.ts revoke <id>`). A token that was ever shown anywhere else is revoked and reissued.

## Deploying

Railway builds from the `Dockerfile`. Either connect the service to this repository's `main` on GitHub (each merge
deploys; the health check holds a broken one back), or upload a clean export of a commit, so nothing untracked in a
checkout (a local `.env`, a database) goes with it:

```sh
railway config plan --detailed-exit-code   # exits 2 while .railway/railway.ts has changes not applied: apply them first
rm -rf /tmp/jobs-deploy && git worktree prune && git worktree add --detach /tmp/jobs-deploy <commit>
railway up /tmp/jobs-deploy --path-as-root --service server --environment <environment>
git worktree remove /tmp/jobs-deploy
```

The first deploy: set the variables, `railway config apply`, deploy, then `railway domain` for the service. Staging uses
the domain Railway shows; `jobs.multiagency.ai` gets a CNAME at it once production is unpaused. Set `PUBLIC_URL` to the
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
