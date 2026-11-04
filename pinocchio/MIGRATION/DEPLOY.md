# Deploy on Railway: kaboom-web + Postgres + kaboom-realtime

Date: 2026-11-04. Nothing here has been run against Railway yet; every step is for the lead. The local gate at the end
was run on this machine (foreground, throwaway `kaboom_rw_*` databases, since dropped).

**2026-11-05: carried out; this is the live setup.** One change from the plan: **DNS stays on Vercel.** The Vercel
project serves the frontend on playkaboom.gg / www / status and proxies `/api/*` to kaboom-web (sections 2 and 4).
Supabase and Turnkey are retired.

Project: **KABOOM_PINOCCOIO_MAGICBLOCK** (account digitalpenguinapp). The CLI rejects the workspace token; use the
project token: `RAILWAY_TOKEN=$(cat ~/.keystores/railway-kaboom-pinocchio.project-token) railway ...` (never echo it).

## 1. Services

| service | source | build | start | health |
|---|---|---|---|---|
| **Postgres** (new) | Railway Postgres template ("+ New" -> Database -> PostgreSQL) | - | - | - |
| **kaboom-web** (new) | repo ROOT (npm workspaces). `railway up --service kaboom-web` from `/Users/pp/Projects/playkaboom`, or GitHub with root directory `/` | `apps/web/Dockerfile` (node:22-bookworm-slim, `npm ci --workspace=@playkaboom/web`, `next build` of web only) | `next start` on `$PORT` (Dockerfile CMD, node is PID 1) | `/api/healthz` (200 = serving + DB reachable, 503 = DB unreachable) |
| **kaboom-realtime** (live) | `apps/realtime` folder: `cd apps/realtime && railway up --service kaboom-realtime` | `apps/realtime/railway.json` (unchanged): `npm install --include=dev && npm run build` | `npm run start` | `/health` |

kaboom-web settings (Service -> Settings):
- **Config-as-code / Railway config file:** `/apps/web/railway.json`. It sets: builder DOCKERFILE,
  `dockerfilePath apps/web/Dockerfile`, `preDeployCommand node /app/db/migrate.mjs` (applies pending migrations, idempotent,
  advisory-locked, before the new deployment takes traffic), healthcheck `/api/healthz` (120 s), restart ON_FAILURE x5,
  **numReplicas 1** (cron passes run in-process; see crons.md). If the dashboard shows the file was not picked up, set the
  service variable `RAILWAY_DOCKERFILE_PATH=apps/web/Dockerfile` and enter the healthcheck path, pre-deploy command and
  replicas = 1 by hand.
- The build context is filtered by the root `.dockerignore` (allow-list): only root manifests + `.npmrc`,
  `tsconfig.base.json`, `apps/web`, `packages`, the other workspaces' `package.json`, `db/`, and
  `scripts/known-corruption-allow.txt` enter the image. `keypairs/`, every `.env*`, `target/`, `pinocchio/` and the
  operator logs never do. (`railway up` already skips `.gitignore`d paths; the upload is about 6 MB.)
- Node 22 comes from the Dockerfile base image. `RAILPACK_NODE_VERSION` does not apply to kaboom-web.
- Region: same as Postgres and the relay.
- Keep the relay's existing `RAILPACK_NODE_VERSION=22` (memory note: the live relay was built with Railpack). Its code now
  needs only `pg` + `ws`, so Node 20 or 22 both work.

## 2. Variables (names only; values in the dashboard, secrets as **Sealed** variables)

Full lists with one-line descriptions: `apps/web/.env.railway.example`, `apps/realtime/.env.railway.example`.

kaboom-web:
- `KABOOM_APP_DB_PASSWORD` (sealed; the same value given to `db/roles.mjs`) and
  `DATABASE_URL=postgresql://kaboom_app:${{KABOOM_APP_DB_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{Postgres.PGDATABASE}}`
  (private network, no TLS needed). NOT `${{Postgres.DATABASE_URL}}`: that is the `postgres` superuser. kaboom_app is a
  non-superuser that owns the public schema objects, so the pre-deploy migrate works as it; it cannot `COPY ... PROGRAM`,
  touch roles or other databases. After `db/roles.mjs` has run, run migrations only as kaboom_app (the pre-deploy
  command does); if one is ever run as `postgres`, re-run `db/roles.mjs` so kaboom_app owns the new objects.
- Server: `SOLANA_RPC`, `SOLANA_MAINNET_RPC`, `TREASURY_PUBKEY`, `HOUSE_SECRET_KEY`, `ER_RPC` (or rely on
  `NEXT_PUBLIC_ER_RPC`), `SESSION_ENC_KEY`, `VRF_MODE_ENABLED=true`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`,
  `CRON_TICK_SECRET`, `INGEST_SECRET`, `ADMIN_BACKFILL_SECRET`, `ADMIN_INDEX_RESET_SECRET`, `ADMIN_RELEASE_SECRET`;
  optional `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_FORMAT`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `LOG_LEVEL`.
  Optional `PROGRAM_ID` (any value other than `Ednka8...unhju` is refused).
- Build time (Docker build args, declared in the Dockerfile): `NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta`,
  `NEXT_PUBLIC_PRIVY_APP_ID` (25 chars; missing or malformed **fails the build**), `NEXT_PUBLIC_ER_RPC`
  (`https://as.magicblock.app/`; **without it nobody can start a game**), `NEXT_PUBLIC_ER_WS`,
  `NEXT_PUBLIC_REALTIME_WS_URL=wss://kaboom-realtime-production.up.railway.app`; optional `NEXT_PUBLIC_PROGRAM_ID`,
  `NEXT_PUBLIC_VRF_QUEUE`, `NEXT_PUBLIC_BUILD_ID`. Changing any `NEXT_PUBLIC_*` needs a **redeploy (rebuild)**.
- Do not set: `PORT`, `RAILWAY_DEPLOYMENT_ID` (Railway provides both; `/api/version` reports the deployment id, which
  drives the stale-tab reload). Retired, do not carry over to Railway or Vercel: `SUPABASE_*`, `NEXT_PUBLIC_SUPABASE_*`
  (Supabase retired), `TURNKEY_*`, `USE_TURNKEY` (Turnkey retired), `HOUSE_AUTHORITY_KEY` (old name of
  `HOUSE_SECRET_KEY`), `NEXT_PUBLIC_VRF_MODE_ENABLED`, `CRON_SECRET`, `HELIUS_WEBHOOK_AUTH`, `VERCEL_*` (Vercel's own
  system variables). Reasons per name: `apps/web/.env.railway.example`.

kaboom-realtime (changes against what is live today):
- ADD `KABOOM_RELAY_DB_PASSWORD` (sealed) and
  `DATABASE_URL=postgresql://kaboom_relay:${{KABOOM_RELAY_DB_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{Postgres.PGDATABASE}}`.
  kaboom_relay can connect and `LISTEN` and nothing else (no table, function or schema access), so a compromised relay
  or a leaked relay env gives no access to game data. REMOVE `SUPABASE_URL`, `SUPABASE_ANON_KEY`.
- `CRON_TICK_URL=https://<kaboom-web domain>/api/cron/tick` (ONE url), `CRON_TICK_AUTH` = the web's `CRON_TICK_SECRET`.
- `INGEST_URL=https://<kaboom-web domain>/api/ingest`, `INGEST_AUTH` = the web's `INGEST_SECRET`, `ALCHEMY_WS_URL`
  (new Alchemy key; also turns the `/rpc-ws` proxy back on). Without these three the push indexer is off and the tick's
  indexer pass (every 60 s) is the only indexer.
- `ALLOWED_ORIGINS=https://playkaboom.gg,https://www.playkaboom.gg` (+ the kaboom-web `*.up.railway.app` origin while
  testing directly on Railway; remove it after).
- The relay code changed (Supabase -> `pg` LISTEN), so it must be **redeployed**, not just re-configured.

Vercel (frontend; the project that holds `playkaboom.gg`, `www.playkaboom.gg`, `status.playkaboom.gg`):
- Variables, each of type **Sensitive**: `KABOOM_API_ORIGIN=https://kaboom-web-production.up.railway.app` (https and
  host only, no path, or the build fails), `NEXT_PUBLIC_SOLANA_CLUSTER`, `NEXT_PUBLIC_PRIVY_APP_ID`,
  `NEXT_PUBLIC_ER_RPC`, `NEXT_PUBLIC_ER_WS`, `NEXT_PUBLIC_REALTIME_WS_URL`. That is the whole list. None is a secret
  (`NEXT_PUBLIC_*` values ship in the browser bundle); all are build-time, so a change needs a frontend redeploy.
- With `KABOOM_API_ORIGIN` set, `next.config.mjs` proxies every `/api/*` except `/api/version` to kaboom-web, and
  `src/instrumentation.ts` skips the house-key check: the Vercel deployment never signs and never opens the database.
- Vercel must **NOT** hold `HOUSE_SECRET_KEY`, `DATABASE_URL` or `PRIVY_APP_SECRET` (nor any other kaboom-web server
  secret, nor any retired name above). If one is found there, delete it and rotate it.

House key: generate it offline (`solana-keygen new --no-bip39-passphrase -o <file outside the repo>`), paste the file
content into the sealed `HOUSE_SECRET_KEY` in the dashboard yourself, keep only its pubkey for `--house`. Never in chat,
never in a script argument. Keep the house wallet at a fee float (vault-health warns under 0.1 SOL). FLAG: the 10-21
Railway breach note says env values may have been readable; that is the residual risk of a raw key on Railway, which
the VRF-only upgrade bounds (a thief can no longer start a commit-reveal game; see chain.md).

## 3. Cron wiring

The relay is the only scheduler: every 60 s it GETs `CRON_TICK_URL` with `Authorization: Bearer $CRON_TICK_AUTH`.
`/api/cron/tick` runs indexer, vrf, legacy, lp-complete, vault-health and invariants on their own cadences under one
Postgres advisory lock (crons.md). Check after wiring: kaboom-web logs show no `[cron] ... HTTP 401` on the relay side;
a manual `curl -H "Authorization: Bearer ..." https://<web>/api/cron/tick` answers `{"ran":true|false,...}`.

GitHub Actions (not edited): disable `index-tick.yml`, `vrf-settle.yml`, `vault-health.yml`, `invariants.yml` in the
GitHub UI once the Vercel frontend proxies `/api` to kaboom-web (they would 404 or break on Supabase; table in
crons.md). `ci.yml` still runs on Node 20 with `engine-strict`; the root `engines` stays `>=20` for that reason.

## 4. Domains (playkaboom.gg): DNS stays on Vercel

The first version of this section moved playkaboom.gg to Railway. **That was not done and is superseded.** No DNS record
changes.

1. kaboom-web -> Settings -> Networking: "Generate domain" (`kaboom-web-production.up.railway.app`). That is
   kaboom-web's only public domain; do not add custom domains to Railway.
2. `playkaboom.gg`, `www.playkaboom.gg`, `status.playkaboom.gg` stay on the Vercel project, which is built with
   `KABOOM_API_ORIGIN=https://kaboom-web-production.up.railway.app` (section 2, Vercel). Every `/api/*` except
   `/api/version` is proxied to kaboom-web; `/api/version` stays on Vercel so the stale-tab reload tracks the frontend's
   own deployment. `src/middleware.ts` still limits the status host to the status page and `/api/status` and 308s the
   rest to `https://playkaboom.gg`.
3. Do not remove the domains from Vercel. HSTS (`preload`) is already sent: https only.
4. CSP: `connect-src` already lists `wss://kaboom-realtime-production.up.railway.app` (the live relay domain, also
   hardcoded for `/rpc-ws` in `apps/web/src/lib/cluster.ts`) and adds the `NEXT_PUBLIC_REALTIME_WS_URL` origin at build.
   If the relay domain ever changes, change both places and rebuild. No database host is in the CSP.
5. FLAG `clientIp` (`apps/web/src/server/api-helpers.ts`) trusts the FIRST `x-forwarded-for` hop. Before relying on
   per-IP rate limits, send one request with a forged `X-Forwarded-For: 1.2.3.4` through `playkaboom.gg` (the Vercel
   proxy) and one to the Railway domain, and check which IP the limiter keys on (Railway's edge also sets
   `X-Real-IP`). Not changed in this lane.

## 5. Privy

Dashboard -> app (same app id as today) -> Allowed origins: `https://playkaboom.gg`, `https://www.playkaboom.gg` (both
served by Vercel), and the kaboom-web `*.up.railway.app` origin only while testing directly on Railway (remove it
after). `status.playkaboom.gg` does not log in. `PRIVY_APP_ID` / `PRIVY_APP_SECRET` / `NEXT_PUBLIC_PRIVY_APP_ID` keep
today's values.

## 6. Cutover order

The requested order was "copy data, migrate, deploy web, set relay CRON_TICK_URL, init vault". The copy script needs
the schema, so **migrate comes before copy**:

1. **Program upgrade first** (chain.md): the deployed build still answers `start_game` with 3012, not 6057. Deploy the
   VRF-only `.so` before anything initialises the vault.
2. **Postgres:** create the service. Railway's template usually creates a public TCP proxy (`DATABASE_PUBLIC_URL`)
   with the service; it is needed only for steps 3-4 (laptop access) and must be removed right after step 4.
   `sslmode=no-verify` (required: the proxy cert is self-signed) encrypts but does not authenticate the server, and the
   URL carries the superuser password, so run steps 3-4 from a trusted network in one sitting, not over public Wi-Fi.
3. **Migrate, then roles:** `DATABASE_URL='<DATABASE_PUBLIC_URL>?sslmode=no-verify' node db/migrate.mjs` from the repo
   root (after `npm ci`; `pg` is hoisted). Expect `32 applied`. A second run prints `0 applied`. Then generate two
   passwords (`openssl rand -hex 32`, each straight into the sealed `KABOOM_APP_DB_PASSWORD` / `KABOOM_RELAY_DB_PASSWORD`
   variables) and run `DATABASE_URL='<same>' KABOOM_APP_DB_PASSWORD=... KABOOM_RELAY_DB_PASSWORD=... node db/roles.mjs`
   (read them from a file with `$(cat ...)`, not typed into shell history). Expect `0 relations, 0 functions` not
   owned by kaboom_app. Idempotent; a rerun also resets the passwords to the given values.
4. **Copy history:** owner decision on the aggregate tables first (data-layer.md "Owner decision still open"). Then
   `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DATABASE_URL='<public url>?sslmode=no-verify' node db/copy-from-supabase.mjs`.
   It exits 1 if any target table ends up with fewer rows than its source; a rerun inserts 0. The copy runs as the
   `postgres` owner (public URL), not kaboom_app.
   **Then close the proxy and check it:** Postgres -> Settings -> Networking -> remove the TCP proxy. Verify: the
   `DATABASE_PUBLIC_URL` variable is gone or empty on the Postgres service, and a connect to the old proxy host:port
   (`node -e "require('net').connect(<port>,'<proxy host>').on('connect',()=>{console.log('STILL OPEN');process.exit(1)}).on('error',()=>console.log('closed'))"`)
   prints `closed`. Do not continue to step 5 while it prints `STILL OPEN`. Optional hardening: rotate the `postgres`
   password afterwards (it was sent through a no-verify TLS session); kaboom-web and the relay do not use it.
5. **Deploy kaboom-web:** set the variables (section 2), `railway up --service kaboom-web` from the repo root. The
   pre-deploy migrate prints `0 applied`; the boot log prints `[boot] house signer <pubkey>` (a bad key exits 1 and the
   deploy fails). Check on the Railway domain: `/api/healthz` 200, `/api/version` = the deployment id, `/api/status`,
   `/api/leaderboard` (carried-over rows), `/api/vault/state` 503 "Vault PDA missing" until step 8 (expected).
6. **Relay:** set/remove its variables (section 2) incl. `CRON_TICK_URL`/`CRON_TICK_AUTH`, redeploy from
   `apps/realtime`. Check `/health` -> `"upstream":true`; within a minute the web logs show the tick's vault-health
   alert ("Vault PDA missing") until step 8.
7. **Privy origins, then the Vercel frontend** (sections 2, 4, 5): set the Vercel variables, including
   `KABOOM_API_ORIGIN`, and redeploy the frontend. No DNS change. Disable the obsolete GitHub workflows.
8. **Chain bootstrap** (chain.md "Bootstrap order" 2-7): `init-vault-mainnet.ts --house <HOUSE pubkey>` (refuses unless
   the program answers 6057), `fund_vault`, `init-v2-mainnet.ts`, `enable-vrf-mainnet.ts --max-payout-bps <BPS>`, fund
   the house key, Squads rotation when ready. `TREASURY_PUBKEY` must equal `vault.treasury` (the deployer at init,
   until the rotation); update it after rotating. The vault-health pass alerts if `HOUSE_SECRET_KEY`'s pubkey differs
   from `vault.house_authority`.
9. Owner min-bet mainnet game, including the F3 force check on the real ER (chain.md step 8).

## 7. Local gate run (2026-11-04)

Clean build context = exactly the `.dockerignore` allow-list copied to the scratchpad (no `.env*`, no
`next-env.d.ts`), Node 22.23.4, the Dockerfile's commands run by hand (Docker daemon not available here):
`npm ci --workspace=@playkaboom/web` 23 s, `next build` 17 s, pass. Then `next start` from that build (PORT 18080,
NODE_ENV production, throwaway house key / secrets, `api.mainnet-beta.solana.com` read-only) and the repo relay
`node dist/index.js` (PORT 18081, `CRON_TICK_URL` -> the local tick) against a fresh migrated `kaboom_rw_e2e`.
The pre-deploy command `node <ctx>/db/migrate.mjs` run from `<ctx>/apps/web` resolved `pg` and reported 0 pending.

Repo gate: `npm ci` ok; `npx turbo run typecheck --force` 6/6; `npm test -w @playkaboom/sdk-tests` 719/719;
`npm test -w @playkaboom/web` 3/3; `npm run test:db -w @playkaboom/web` (kaboom_rw_test) 11/11; `next build` (web) and
`tsc` (relay) pass.

| route | status | note |
|---|---|---|
| GET /api/healthz | 200 | `{"ok":true}`; 503 `{"ok":false}` when the DB login failed (seen on the first start) |
| GET /api/version | 200 | `buildId` = `RAILWAY_DEPLOYMENT_ID` |
| GET /api/health | 200 | vault balance 0, house pubkey |
| GET /api/status | 200 | `operational` |
| GET /api/whoami | 200 | unauthenticated |
| GET /api/leaderboard (+ `?view=volume`, `?view=streak`) | 200 | empty rows |
| GET /api/activity/global | 200 | |
| GET /api/activity/{wallet} | 200 | |
| GET /api/vault/state | 503 | `Vault PDA missing` (explicit, vault not initialised; no 500) |
| GET /api/vault/position/{wallet} | 503 | `Vault not initialised` (explicit) |
| GET /api/game/{player} | 200 | `{"active":false}` |
| GET /api/session/{player} | 401 | needs Privy token |
| GET /api/ref/{code} | 400 / 404 | bad format / unknown code |
| GET /api/ref/code/{wallet}, /api/ref/referees/{wallet} | 401 | need Privy token |
| GET /api/verify?sig= | 200 | `{"found":false}` |
| GET /api/verify/{signature} | 404 | `Transaction not found` |
| GET /api/cron/index-events | 401 / 200 | no auth / bearer |
| GET /api/admin/backfill-points | 401 | no auth |
| GET /api/cron/tick | 401 / 401 / 200 | no auth / wrong bearer / bearer: `ran:true`, indexer ok, vrf ok (0 claims), lp-complete "vault not initialized", others not_due (the relay's own tick at +5 s had just run them; vault-health logged the expected "Vault PDA missing" alert) |
| pages `/`, `/install`, `/leaderboard`, `/logs`, `/play`, `/privacy`, `/profile/{w}`, `/r/{code}`, `/referrals`, `/status`, `/terms`, `/vault`, `/verify/{sig}` | 200 | |
| `/does-not-exist` | 404 | |
| Host `status.playkaboom.gg`: `/`, `/api/status` / `/play` | 200 / 308 | 308 -> `https://playkaboom.gg/play` |
| Host `healthcheck.railway.app`: `/api/healthz` | 200 | Railway's probe host is not redirected |
| relay `/health` | 200 | `upstream:true` |
| relay WS | ok | `hello`, then `game_inserted` and `game_updated` for a games insert/update, exactly the 12 safe keys; `/api/activity/global` showed the row |

Web log: no error-level line after the first start; 2 warnings (expected vault alert, the rate-limiter notice, whose
"fail-open" wording is stale: the code uses its in-process limiter). The throwaway house key, session key and tick
secret did not appear in either log; the browser bundle holds no `postgres://`, `DATABASE_URL` or `HOUSE_SECRET`.
Servers stopped, `kaboom_rw_e2e` and `kaboom_rw_test` dropped.

Not exercised locally: the Docker build itself (no daemon), Railway's build-arg passing, POST routes that need a Privy
login or a signed transaction, and the Alchemy push path (no key).

## 8. Review fixes and gate re-run (2026-11-04, later)

Fixed: DL-1 (pool `statement_timeout` / `query_timeout` / keepAlive), DL-4 (DB error text never returned), DL-5
(schema.md TLS mode), F3 idle (a game the ER never touched is idle since its start), F3 terminal grace (from the last
ER tx, plus a 60 s L1 grace before the house settles), F3 UI (a round the cron already closed resets the board), F4
(dust skips do not use the cap; start rotates), relay program id pinned, SEC-1 (`db/roles.mjs`: `kaboom_app`,
`kaboom_relay`), SEC-3 (admin release and reset rescan under the tick lock, 409 when held), SEC-4 (lock-lost flag +
`assertTickLockHeld()` before every house send), SEC-5 (proxy close check in step 4 above).

Gate: `npx turbo run typecheck --force` 6/6; `npx turbo run test --force` 3/3 tasks (sdk-tests 719/719, web 3/3);
`npm run test:db -w @playkaboom/web` 12/12 **as kaboom_app** (new test: lock session killed mid-tick -> sends stop,
later passes skipped); relay `tsc` ok; `next build` in a clean `.dockerignore` context ok. Fresh `kaboom_rw_final`:
migrate as the superuser (32 applied), `db/roles.mjs` (0 objects left unowned; rerun idempotent), migrate as kaboom_app
(0 applied), kaboom_app can DDL its own schema but not `COPY ... PROGRAM`; kaboom_relay can `LISTEN`, and gets
"permission denied for schema public" on games, game_sessions and an insert. Route sweep (web as kaboom_app, relay as
kaboom_relay): same results as the section 7 table except `GET /api/verify?sig=abc` 500 (RPC "WrongSize" text; a
pre-existing route behaviour, not DB), plus: release-stuck and `index-events?reset=1` answer 409 while the lock is held
(tick `{ran:false}`), release-stuck without auth 401, `/api/activity/global` with the games table renamed answers
`{"error":"Server error"}` 500 (detail only in the log), relay WS sent `game_inserted` / `game_updated` with 12 keys,
relay ignored a stale `KABOOM_PROGRAM_ID` with a warning. No secret in either log or in `.next/static`. Program lane:
`build.sh` (both `.so` up to date; kaboom-p `.so` 195,800 bytes, sha256 `bb291333...2023c`), crate tests 20/20,
difftest 761/761 over 30 files, each run on its own with `--test-threads=2`. `kaboom_rw_final` and the two test roles
dropped afterwards.

Note: `next build` run in the repo itself fails ("NEXT_PUBLIC_PROGRAM_ID must be Ednka8...") because
`apps/web/.env.local` still holds the old id. That is the guard working; the file is a secrets file and was not
touched. Railway builds do not see it (`.dockerignore` excludes `.env*`).
