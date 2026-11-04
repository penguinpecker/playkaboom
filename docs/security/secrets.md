# Secrets management

Last reviewed: 2026-11-05 (relaunch: Pinocchio program `Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju`, API on
Railway, frontend on Vercel).

Every secret used by playkaboom.gg, where it lives, what a leak lets someone do, and how to rotate it. **Names
only.** Never write a value, a fragment of one, or a URL that carries a key into this file or any tracked file.

Where secrets live:

- **Railway, sealed variables.** Every server secret. Sealed values cannot be read back in the dashboard, CLI or
  API; only the running service sees them. Two services: kaboom-web (API + crons) and kaboom-realtime (relay).
- **Vercel, type Sensitive.** The frontend only. It holds no secret at all (see below).
- **Local operator files**, outside the repo or gitignored. Listed by name only.

Turnkey and Supabase are retired (2026-11-04). No `TURNKEY_*` or `SUPABASE_*` variable belongs anywhere.

## Railway: kaboom-web (sealed)

| Var | Risk if leaked (blast radius) | Rotation |
|---|---|---|
| `HOUSE_SECRET_KEY` | Signs as `vault.house_authority`. Bounded to cleanup and settlement: VRF settle, force-undelegate and refund, legacy wind-down, LP auto-complete. It cannot start a commit-reveal game (the program is VRF-only), change config, move treasury funds or upgrade the program. It can spend the house wallet's fee float. | Generate a new keypair offline (`solana-keygen new -o <file outside the repo>`), paste it into the sealed var yourself, and in the same window run `scripts/rotate-house.ts --house <new pubkey>` signed by the vault owner (a Squads `update_vault` proposal once ownership moves). House txs fail with 6007 while the two disagree. Then fund the new house wallet and sweep the old one. |
| `DATABASE_URL`, `KABOOM_APP_DB_PASSWORD` | Read and write every app table as `kaboom_app` (not a superuser: no `COPY ... PROGRAM`, no roles, no other databases). | New password (`openssl rand -hex 32`) into the sealed var, rerun `db/roles.mjs` as the `postgres` owner (it resets both role passwords; see `pinocchio/MIGRATION/DEPLOY.md` step 3), redeploy kaboom-web and the relay. |
| `PRIVY_APP_SECRET` | Call Privy's server API as this app: mint server-issued auth tokens, impersonate any user. | Privy dashboard → rotate, set on Railway, redeploy. |
| `SESSION_ENC_KEY` | Decrypt stored legacy commit-reveal session rows (`game_sessions`). The VRF-only program opens no new ones. | `openssl rand -hex 32`, set, redeploy. Rows encrypted under the old key become unreadable. |
| `SOLANA_RPC`, `SOLANA_MAINNET_RPC` | Both carry the Alchemy API key: quota drain (cost, denial of service). Read-only RPC, no account data beyond quota. | New key in the Alchemy dashboard; update both, plus the relay's `ALCHEMY_WS_URL`. |
| `CRON_TICK_SECRET` | Call `/api/cron/tick` early. Low: every pass is idempotent and runs under one advisory lock. | `openssl rand -hex 32`; same value into the relay's `CRON_TICK_AUTH`. |
| `INGEST_SECRET` | Ask `/api/ingest` to index a transaction signature. Low: the server fetches the transaction from RPC itself, so the cost is RPC load. | New value; same value into the relay's `INGEST_AUTH`. |
| `ADMIN_RELEASE_SECRET` | Trigger the legacy stuck-obligation release early (the tick's `legacy` pass does the same thing). Low. | New value, set, redeploy. |
| `ADMIN_INDEX_RESET_SECRET` | Reset the indexer cursor and force a full rescan: load and a stale feed until it catches up. | New value, set, redeploy. |
| `ADMIN_BACKFILL_SECRET` | Rerun the points backfill. Low. | New value, set, redeploy. |
| `UPSTASH_REDIS_REST_TOKEN` (optional) | Read or reset rate-limit counters. | Upstash dashboard → reset token. |
| `ALERT_WEBHOOK_URL` (optional) | The URL is the credential: post messages into the alerts channel. | Delete and recreate the webhook in Discord/Slack. |

Not secret, set on kaboom-web as plain config: `PRIVY_APP_ID`, `TREASURY_PUBKEY`, `ER_RPC`, `VRF_MODE_ENABLED`,
`PROGRAM_ID`, `LOG_LEVEL`, `ALERT_WEBHOOK_FORMAT`, `UPSTASH_REDIS_REST_URL`, and the build-time `NEXT_PUBLIC_*`.

Leave unset: `CRON_SECRET`, `HELIUS_WEBHOOK_AUTH`. They are old shared bearers that a few admin and index routes
still accept as a fallback, so setting one re-opens an old credential.

## Railway: kaboom-realtime (sealed)

| Var | Risk if leaked (blast radius) | Rotation |
|---|---|---|
| `DATABASE_URL`, `KABOOM_RELAY_DB_PASSWORD` | Connect and `LISTEN` as `kaboom_relay`. No table, function or schema access. | Same `db/roles.mjs` rerun as above. |
| `CRON_TICK_AUTH` | Same as kaboom-web's `CRON_TICK_SECRET`. | Rotate together. |
| `INGEST_AUTH` | Same as kaboom-web's `INGEST_SECRET`. | Rotate together. |
| `ALCHEMY_WS_URL` | Carries the Alchemy API key (quota drain). | With `SOLANA_RPC`. |

## Railway: Postgres service

The template's `postgres` superuser password (Railway-managed, on the Postgres service). Full control of the
database. Neither app uses it. Rotate it from the Postgres service if it was ever sent over the public TCP proxy, and
keep that proxy closed (`pinocchio/MIGRATION/DEPLOY.md` step 4).

## Vercel: frontend (type Sensitive)

`KABOOM_API_ORIGIN`, `NEXT_PUBLIC_SOLANA_CLUSTER`, `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_ER_RPC`,
`NEXT_PUBLIC_ER_WS`, `NEXT_PUBLIC_REALTIME_WS_URL`. That is the whole list. None is a secret: `KABOOM_API_ORIGIN` is
the public Railway URL and every `NEXT_PUBLIC_*` value ships in the browser bundle. They are stored as Sensitive
anyway.

**Vercel must NOT hold** `HOUSE_SECRET_KEY`, `DATABASE_URL`, `PRIVY_APP_SECRET` or any other server secret above, nor
any retired `SUPABASE_*` / `TURNKEY_*` name. With `KABOOM_API_ORIGIN` set, the Vercel build proxies `/api/*` to
Railway and never signs or opens the database. If a server secret is ever found on Vercel, delete it there and rotate
it.

Never put a secret in a `NEXT_PUBLIC_*` variable: it is inlined into the JavaScript every visitor downloads.

## Local operator files (names only, never in the repo)

| File | What it can do if leaked | Rotation |
|---|---|---|
| `keypairs/mainnet-deployer.json` (gitignored) | The deployer `qouUoXTxNrFYw9DA7yCAnPXfAi9ypNWq2HPf5UMF9WG`: today the program's upgrade authority, `vault.owner` and `vault.treasury`, so it can upgrade the program, change vault config, rotate the house key and receive the treasury split. The highest-value key until the Squads handover. | Cannot be rotated in place; hand the authorities to the Squads vault `464FeYivixKQ3azagAoKJDH6NTKGrQodYSeMyyPP8VP5`. |
| `~/.keystores/railway-kaboom-pinocchio.project-token` | Deploy code to the Railway project, which would then see the sealed values. | Railway project settings → tokens → regenerate. |
| `~/.keystores/vercel-kaboomweb3.token` | Deploy the frontend (could serve a changed bundle or point `/api` elsewhere). | Vercel account settings → tokens. |
| `~/.keystores/kaboom-deploy-rpc.txt` | RPC URL with a key in it: quota drain. | With the Alchemy key. |

`.gitignore` covers `keypairs/`, `.env`, `.env.local` and `.env.*.local`. The env templates in the repo
(`apps/web/.env.railway.example`, `apps/realtime/.env.railway.example`) hold names and no values.

## Retired, revoke if still present

- **Turnkey** (house signer until 2026-11-04). The old Turnkey house wallet
  `7exwTWn1ChVyQZF5mTxZM1UNrPpj1nQKhhvXztR4prQp` still holds about 0.97 SOL: sweep it from the Turnkey dashboard,
  then delete the Turnkey API keys.
- **Supabase** (database until 2026-11-04). Reset or delete the project's service-role key once the data copy is no
  longer needed.
- Any server secret still set on the Vercel project from before the relaunch.

## Known exposure: old Alchemy key in git history

An earlier Alchemy key was hard-coded in tracked scripts and printed in an older revision of this file. It is in the
public git history, so removing it from the working tree did not un-expose it. Treat that key as compromised and
make sure none of the RPC variables above use it.

## Rotation runbook

Rotate on a calendar (every 90 days) and immediately after a confirmed leak, the departure of anyone with Railway or
Vercel access, or a platform incident that may have exposed environment variables (for example the 2026-10-21
Railway breach note: treat every Railway-held value as possibly read).

After rotating a Railway variable, redeploy the service so the running process picks it up. After changing a Vercel
variable, redeploy the frontend (they are build-time values).

## What we do not store anywhere

- Player private keys: held by Privy in user-controlled embedded wallets; we have zero access.
- Mine layouts: VRF games have none. Each tile is drawn from the VRF oracle when tapped and replayed on chain at
  settle. Old commit-reveal session rows are stored only encrypted under `SESSION_ENC_KEY`.

## Checklist (state 2026-11-05)

- [x] Server secrets only as sealed Railway variables; Vercel holds only the frontend's public build values
- [x] `.env` / `.env.local` files and `keypairs/` gitignored; the `.env.railway.example` templates hold names only
- [x] Server-only secrets never exposed via `NEXT_PUBLIC_*`
- [x] CSP `connect-src` host-allowlisted
- [x] House key bounded by the VRF-only program
- [ ] Sweep the old Turnkey house wallet, then delete the Turnkey API keys
- [ ] Squads 2-of-2 on the upgrade authority and treasury (handover pending)
- [ ] Calendar reminder for 90-day rotation
- [ ] `secret-scan` GitHub Action so a stray commit fails CI
