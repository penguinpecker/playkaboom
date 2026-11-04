# Database: Supabase to Railway Postgres

## What exists

| Path | What it is |
|---|---|
| `db/migrations/*.sql` | 31 files ported one-for-one from `supabase/migrations/` (same filenames) plus `20261104000001_pg_notify_relay.sql` (new) |
| `db/migrate.mjs` | Runner. `DATABASE_URL=... node db/migrate.mjs`. Applies files in filename order, one transaction per file, and records each in `public.schema_migrations(name, applied_at)`. Holds `pg_advisory_lock(hashtext('kaboom_migrate'))` so two runners can't overlap. A second run does nothing. |
| `db/selftest.mjs` | Runs every function once and checks the notify contract. It writes rows, so it refuses to run if `public.games` already has any. Use it only on a throwaway `kaboom_rw_*` database. |
| `db/package.json` | Holds only `pg`. If apps/web or apps/realtime adds `pg` as a workspace dependency, npm hoists it to the root `node_modules`, and `db/migrate.mjs` can find it from there. |

## What changed from Supabase

- **Removed:** every `enable`/`force row level security`, every `create`/`drop policy`, and every grant or revoke that names `anon`, `authenticated` or `service_role`. Each removal left a `-- [railway] removed Supabase-only: ...` line in its place. The browser has no database role any more. All reads go through API routes, which connect as `kaboom_app`: a non-superuser login that owns the public schema objects (created by `db/roles.mjs`, see DEPLOY.md). The relay connects as `kaboom_relay` (CONNECT only, enough for `LISTEN`).
- **Kept:** `REVOKE ... FROM PUBLIC` (for example `... FROM PUBLIC, anon, authenticated` became `... FROM PUBLIC`). PUBLIC is a normal Postgres role.
- **Emptied (Realtime only), now just `select 1;`:**
  - `20260509000001` (the `supabase_realtime` publication and `replica identity full`)
  - `20260509000003`
- **Emptied (one-time data fixes on production rows), now just `select 1;`:**
  - `20260509000004`
  - `20260509000005`
  - `20260511000003`
  - the one-row backfill at the end of `20260511000005` (its function part is kept)

  The Supabase rows reach the new database with these fixes already applied, via the copy script. On an empty database these statements would do nothing. Removing them also means a re-run can never repeat the destructive reset.
- **Unchanged:** every other table, column, CHECK, index (including partial and unique ones), trigger, view and function body.
- **Verified:** I applied the original Supabase migrations to a scratch database, with the role names swapped for PUBLIC and a stub publication. Then I diffed its `pg_dump -s --no-privileges` output against the ported database. The only differences were:
  - the 7 removed policies
  - `notify_relay_games` and its trigger
  - `schema_migrations`

## Realtime contract (replaces Supabase postgres_changes)

- **Channel:** `kaboom_events` (the relay runs `LISTEN kaboom_events`)
- **Fires on:** `AFTER INSERT OR UPDATE ON public.games FOR EACH ROW`. These are the same two events the relay used to subscribe to.
- **Payload** (JSON text):

```json
{"table":"games","op":"INSERT"|"UPDATE","row":{
  "signature":"…","game":"…","player":"…","bet":123,"outcome":"won|lost|expired",
  "payout":0,"multiplier_bps":0,"safe_reveals":0,"mine_count":0,
  "settled_at":"2026-11-04T10:00:00.123456+00:00","settle_signature":null,"slot":0}}
```

- `row` holds exactly the 12 allowlisted fields of `pickSafeCols` in `apps/realtime/src/index.ts`. The fairness pre-image (`mine_layout`, `settled_layout`, `salt`, `commitment`) is never in the payload.
- Number columns arrive as JSON numbers. Timestamps arrive as ISO strings.
- The relay should keep sending the same message to browsers: `{type:"game_settled", event: op==="INSERT" ? "game_inserted" : "game_updated", data: row, ts}`.
- Notifications are delivered only when the writing transaction commits. If one transaction sends identical payloads, Postgres delivers them once. The payload limit is 8000 bytes; a full payload is under 1 KB.
- **No replay:** while the relay is disconnected, notifications are lost. On reconnect the relay has to `LISTEN` again. The browser's 60-second API poll covers the gap.

## Running it

```
DATABASE_URL=postgres://… node db/migrate.mjs
```

Railway's private-network URL (`*.railway.internal`) needs no TLS. The public proxy URL needs `?sslmode=no-verify`: Railway's proxy certificate is self-signed, and pg (pg-connection-string 2.x) treats `sslmode=require` as verify-full, so `require` fails with a certificate error. `no-verify` encrypts but does not authenticate the server (see DEPLOY.md section 6 on keeping the proxy window short). Postgres 17 was tested locally; Supabase production also ran 17.

## Notes for other lanes

- **Copy script (Supabase to Railway):**
  - Run the migrations first, then copy.
  - Don't copy `schema_migrations`.
  - `cron_indexer_state.kaboom` holds the OLD program's last signature, so reset it rather than carrying it over.
  - `game_session_keys` no longer exists.
  - `points_ledger.id` is a `bigserial`. After copying ids, run `select setval('points_ledger_id_seq', (select max(id) from points_ledger))`.
- **No drift check against production:** neither Supabase account I can reach lists a PlayKaboom project (only Moleswap and Gridzero). So I couldn't compare the live schema with the migrations. Anything created in the Supabase dashboard rather than in a migration file is not covered by this port.
