# Data layer: Supabase to Railway Postgres (apps/web, apps/realtime)

Date: 2026-11-04. Nothing was deployed or committed. Tests ran against the local server at `/tmp:5432` on throwaway databases `kaboom_rw_test` and `kaboom_rw_src`, and both were dropped afterwards.

## What changed

| Area | Before | Now |
|---|---|---|
| Server DB access | `server/db/supabase.ts` (`supabaseAdmin` service role, `supabasePublic` anon) | `server/db/pg.ts`: one `pg.Pool` on `DATABASE_URL` (max 10, idle 30 s, connect timeout 10 s, session `TimeZone=UTC`). Helpers `query(sql, params)`, `upsert(table, row, conflictCols, {ignoreDuplicates, returning})`, `rpc(fn, namedArgs)`, `pgCode(err)`. Every call site uses `$n` parameters. Table, column and function names come from code only, and `ident()` rejects anything else. |
| Browser | `lib/supabase-browser.ts` + Layer 2 `postgres_changes` in `hooks/use-global-games.ts` | Deleted. The browser keeps the relay WebSocket (Layer 1) and the 60 s `/api/activity/global` poll. It has no DB host, key or SDK (checked: `.next/static` contains no `supabase`, `pg-connection-string` or `DATABASE_URL`). |
| Relay | supabase-js Realtime channel | `pg.Client` + `LISTEN kaboom_events`. Reconnects with backoff from 1 s up to 30 s. A `select 1` ping runs every 30 s (with `query_timeout` 10 s) so a half-open socket gets noticed. It sends the same `{type:"game_settled", event:"game_inserted"\|"game_updated", data:<12 cols>, ts}` and `hello` messages as before, and `data` still goes through `pickSafeCols`. `/health.upstream` now means "DB LISTEN is active". `DATABASE_URL` is required, and the relay exits if it is missing, as it did before for SUPABASE_URL. |
| CSP | `https://*.supabase.co`, `wss://*.supabase.co` | Both removed. Kept the hardcoded `wss://kaboom-realtime-production.up.railway.app`, which `lib/cluster.ts` `/rpc-ws` uses. Added the origin of `NEXT_PUBLIC_REALTIME_WS_URL` at build time when it is a different host. |
| Logger redaction | `SUPABASE_SERVICE_ROLE_KEY` | `DATABASE_URL`, `databaseUrl`, `connectionString` |
| Copy | Privacy page named Supabase as processor | Changed to "Railway" / "Postgres on Railway" / "database credentials". The Turnkey and Vercel sentences are left for the signer and hosting lanes. |
| Deps | `@supabase/supabase-js` in web + realtime | Removed from both package.json files and the lockfile (`npm uninstall`). Added `pg@^8.23.1` and `@types/pg` to both. The lockfile has 0 `@supabase` entries. |
| Env | n/a | `apps/web/.env.railway.example`, `apps/realtime/.env.railway.example` (names only) |
| Copy script | n/a | `db/copy-from-supabase.mjs` (not run against Supabase; see below) |

Ported call sites: `server/indexer.ts` (all upserts, all `idx_apply_*` rpcs, the `processed_events` claim and release), `server/points.ts`, `server/session-store.ts`, `server/referral-codes.ts`, `server/referral-tracking.ts`, and the routes `leaderboard`, `verify`, `activity/[wallet]`, `activity/global`, `vault/position/[wallet]`, `vault/state`, `status`, `cron/index-events`, `admin/backfill-points` and `admin/release-stuck-obligations`.

## Semantics kept on purpose

- **Value shapes.** PostgREST returned `bigint`/`numeric` as JSON numbers and `timestamptz` as `2026-11-04T10:00:00.123456+00:00`. The pool installs type parsers that return the same shapes (int8/numeric → `Number`, timestamptz → that string), so no caller changed and every API response body keeps its shape. This keeps PostgREST's existing 2^53 rounding on reads. Writes still pass bigints as decimal strings, so they stay exact.
- **upsert.** This mirrors PostgREST. `INSERT` sets the given columns. `ON CONFLICT (cols)` either does `DO UPDATE SET` on exactly those columns or, with `ignoreDuplicates`, does `DO NOTHING`. Columns not given keep their default on insert and their existing value on update.
- **rpc.** `select public.fn(p_x => $1, ...)` uses named arguments, as PostgREST does. There are no overloads, so resolution is unambiguous. `idx_apply_game_settled`'s integer return is read as before.
- **Error handling.** supabase-js returned errors and never threw; pg throws. At each call site the old behaviour is kept:
  - The indexer `check()` sites still throw `IndexerApplyError` with the SQLSTATE, so `TERMINAL_PG_CODES` still applies.
  - The writes the old code never checked are wrapped so they stay non-fatal: lp_actions, referral_events, referrals, vault_unit_value_history, the cron cursor upserts, the session delete and the release-stuck delete. The indexer versions now log a warning, where before nothing was logged.
  - Reads that used `data ?? []` or `maybeSingle()` without checking `error` still read as empty or "not found" when the query fails.
  - The `processed_events` claim keeps its 23505 = skip rule.
  - `referral_codes` keeps the `one_code_per_wallet` message match.

## Not 1:1 (read these)

1. **Counter increments are now done in SQL.** `click_count`, `signup_count` and `confirmed_count` used to be read in the app and then written back. They are now `SET x = coalesce(x,0) + 1`. The single-request result is the same, and concurrent requests no longer lose a count (the inventory flagged this as SHOULD). The timestamps they set still come from the app clock, as before.
2. **Notification timestamps follow the writer's session time zone.** The trigger builds `settled_at` with `json_build_object`, which uses the writer's session `TimeZone`. The web pool forces UTC, so app writes match the old format, and the Railway Postgres default is UTC as well. A writer in another zone, such as a manual psql session from IST, sends `+05:30`. That is still a valid ISO instant for `new Date()`, but it is not byte-identical. The relay can't normalise this, because it only forwards what the trigger sent.
3. **No replay.** If the relay is disconnected (deploy, DB restart), the notifications sent during that window are lost. The 60 s browser poll fills the gap. The Supabase Realtime fallback that also covered this has been removed, as decided.
4. **The browser's Layer 2 used to receive the full row**, including `mine_layout` and `salt` once a game settled. Now only the 12-column projection reaches the browser. `rowToGame` only reads columns that are still in the projection, so the UI is unaffected.
5. **`DATABASE_URL` TLS.** The private network (`*.railway.internal`) is plain TCP. The public TCP proxy needs `?sslmode=no-verify` in the URL, because Railway's certificate is self-signed and pg treats `sslmode=require` as verify-full. The code has no separate SSL switch.
   - **Pool limits** (`apps/web/src/server/db/pg.ts`): `statement_timeout=30000` (server side, also bounds lock waits), `query_timeout` 35 s (client side, for a dead socket with no RST) and TCP keepAlive (10 s initial delay). supabase-js ran over fetch, whose default timeouts made a stuck call fail eventually; plain pg has none, and one hung query would hold the tick lock and stop every house pass. Migrations (`db/migrate.mjs`) and the copy script use their own client without these limits.
   - **Error text:** errors thrown by `query()` are tagged, and `jsonError` answers them with the generic "Server error" (full error in the log), because pg/socket messages name the private host, IP and DB user. `/api/activity/global` now goes through `jsonError` too.
   - **Roles:** kaboom-web connects as `kaboom_app`, the relay as `kaboom_relay` (`db/roles.mjs`, DEPLOY.md section 6 step 3); the copy script and the first migrate run as `postgres`.
6. **Still on the old path, not touched here (out of scope or other lanes):**
   - `scripts/*.mjs|ts` ops tools that call Supabase REST (check-invariants, backfill-points, audit-phase3, health-diagnose, repair-vault-mirror, verify-sig, audit-multipliers, verify-deploy.sh).
   - `supabase/` (config and the original migrations).
   - `.github/workflows/invariants.yml` uses Supabase secrets and will break once Supabase is gone. Workflows were deliberately not edited; disable it in the GitHub UI.
   - `apps/web/.env.local` still lists the Supabase names. It is a secrets file and was not touched.
   - Comment-only mentions remain in `app/api/commit/route.ts`, which the VRF-only lane removes.
7. **turbo cache.** `next.config.mjs` now reads `NEXT_PUBLIC_REALTIME_WS_URL` at build time for the CSP. turbo.json does not hash `NEXT_PUBLIC_*` variables (a pre-existing gap), so a turbo-cached build could carry an old relay origin. A Railway build that runs `npm run build --workspace=@playkaboom/web` is not affected.

## Copy script: db/copy-from-supabase.mjs

```
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... DATABASE_URL=postgres://... node db/copy-from-supabase.mjs
```

Run `db/migrate.mjs` on the target first, and stop the Supabase-side writers.

- **Tables:** the 13 tables, copied in FK-safe order. If the target's table list is not exactly those 13, the script aborts.
- **Reading:** it reads through PostgREST with the service-role key, 1000 rows per page, keyset-paged on the primary key. Every column is requested as `::text`, so bigint and numeric values are exact.
- **Writing:** it inserts with `json_populate_recordset` and `ON CONFLICT DO NOTHING`, keeping the source ids, in one transaction per table.
- **games:** the `trg_games_notify_relay` trigger is disabled inside the games transaction, so the relay never broadcasts history rows. If the copy fails, the rollback restores the trigger.
- **cron_indexer_state:** the old program's cursor row is copied, which is harmless. The target's `'kaboom'` seed row is kept, not overwritten.
- **Afterwards:** the `points_ledger_id_seq` sequence (and any other serial) is set past `max(id)`. The script then prints, per table, the source count (`Prefer: count=exact`), rows read, rows inserted and the target count, and exits 1 if any target table has fewer rows than its source.
- **Secrets:** the key is never printed. Only the host is.

Verified against a PostgREST stand-in backed by a local source database (`kaboom_rw_src`) holding:

- data-layer test rows
- 2,502 processed_events rows (3 pages)
- `total_payouts = 9223372036854775807`
- `total_units = 123456789012345678901234567890`
- an old-program cursor row

Results:

- **Run 1:** copied everything, and every table hashed identical to the source (`md5(string_agg(row::text))`). The only difference was the target's own `'kaboom'` row, as intended.
- **Run 2:** inserted 0 rows.
- **No broadcast:** a LISTEN session on the target got no notification during the copy.
- **Sequence:** `nextval('points_ledger_id_seq')` came out greater than `max(id)`.

**Owner decision still open (inventory 1.6 FLAG).** The aggregate mirrors are copied as-is, as the "history to carry over" decision says: `player_stats`, `referrals` and `lp_positions`. On a player's first game on the new program, `idx_apply_stats` overwrites their totals with the new program's on-chain snapshot. Old unclaimed referral balances can't be claimed on the new program. Old `vault_unit_value_history` rows feed the 30-day APY baseline.

## Tests and checks run (all foreground, all green)

- **Data-layer tests** in `apps/web/src/server/db/data-layer.test.ts`. Run with `DATABASE_URL=... npm run test:db --workspace=@playkaboom/web` (node:test + tsx, `--conditions=react-server`), on a freshly migrated empty database. The test refuses to run if `games` has rows. 7/7 pass:
  - The value-shape parsers. The local server's zone is Asia/Kolkata, so this also proves the UTC session option takes effect.
  - The indexer path: GameWon → games + points_ledger, GameSettled → mine_count/settle_signature, a replay is skipped through the 23505 claim, and the trigger sends INSERT then UPDATE with no pre-image fields.
  - A transient apply error releases the claim.
  - `recordVrfGame` upsert.
  - `awardPoints` is idempotent.
  - Referral codes and the visit funnel: get-or-create, unknown code, click/signup/confirm counters.
  - The session store: save, upsert, load, delete.
- **Typecheck:** `npm run typecheck` passes for web, realtime, shared and sdk. `npm test --workspace=@playkaboom/sdk-tests`: 711/711 pass.
- **Build:** `next build` passes; the pg server bundle builds clean. `next start` against the test DB: `/api/leaderboard` (alltime/volume/streak), `/api/activity/global`, `/api/activity/<wallet>` and `/api/ref/<unknown>` (404) all return the expected JSON shapes.
- **Relay smoke:** the relay ran locally (`tsx src/index.ts`, then `node dist/index.js` after `npm run build`) against the test DB. A WebSocket client received `hello` with `upstream:true`, then `game_inserted` and `game_updated` for a games insert and update. The data had exactly the 12 keys, numbers as numbers and `settled_at` as `...+00:00`. After `pg_terminate_backend` on the relay's LISTEN session, `/health.upstream` went false and then true, and the next insert was relayed. (The smoke script was a scratch file and is not in the repo.)

## For the lead

- **Before the web app starts:** run `db/migrate.mjs`, then the copy script, on the Railway database. `pg` is now hoisted to the root `node_modules`, so `node db/migrate.mjs` works from the repo root after `npm ci`.
- **Web app variables:** set `DATABASE_URL` on kaboom-web, plus the other names in `apps/web/.env.railway.example`. `HOUSE_SECRET_KEY` is listed by its target name; the signer lane switches the code from `HOUSE_AUTHORITY_KEY`.
- **Relay variables:** set `DATABASE_URL` on kaboom-realtime (same database), and remove `SUPABASE_URL` / `SUPABASE_ANON_KEY` there.
- **Pool budget:** the web pool allows up to 10 connections per replica and the relay holds 1. Railway Postgres defaults to `max_connections` 100.
