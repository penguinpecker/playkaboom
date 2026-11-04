# Crons on Railway: one tick route

Date: 2026-11-04. Code: `apps/web/src/server/cron/*`, route `apps/web/src/app/api/cron/tick/route.ts`.

## Scheduler

- The relay (`kaboom-realtime`) already GETs `CRON_TICK_URL` every 60 s with `Authorization: Bearer $CRON_TICK_AUTH`
  (`apps/realtime/src/index.ts`, unchanged code). Set `CRON_TICK_URL=https://<kaboom-web host>/api/cron/tick` (one URL)
  and `CRON_TICK_AUTH` = the web's `CRON_TICK_SECRET`. The route accepts only `CRON_TICK_SECRET` (no `CRON_SECRET` /
  `HELIUS_WEBHOOK_AUTH` fallback), compared in constant time.
- Every pass runs inside one session-level Postgres advisory lock (`pg_try_advisory_lock(118066007469933)`, "kaboom").
  A tick that finds it held (the previous tick still running, another replica, a manual call) returns `{ "ran": false }`
  at once. The lock is released in a `finally`; if the unlock fails the connection is destroyed, which also releases it.
- Lock lost mid-tick (DB restart, network drop, `pg_terminate_backend`): Postgres frees the lock while the passes are
  still running. The lock client's `error`/`end` events set a flag, and `sendHouseTx` / `sendHouseErTx` call
  `assertTickLockHeld()` first (a `select 1` round-trip on the lock session), so the old tick stops sending house
  transactions and skips its remaining passes instead of racing the next tick. Outside a lock (player routes) it is a
  no-op.
- DB calls are bounded: the web pool sets `statement_timeout=30000` (server side), `query_timeout` 35 s (client side)
  and TCP keepAlive, so a query stuck behind a lock or on a dead socket fails instead of holding the tick lock forever.
- Each pass has its own cadence. Last-success times live in process memory (ponytail note in `tick.ts`: with more than
  one replica a pass can run once per replica per cadence; every pass is idempotent). A failed pass is logged, reported
  in the response, does not stop the passes after it, and runs again on the next tick.
- Response: `{ ran: true, passes: { <name>: { status: "ok"|"error"|"not_due", ms, result|error } } }`.

| order | pass | cadence | what | FIXES.md 9.3 |
|---|---|---|---|---|
| 1 | `indexer` | every tick | `indexProgramEvents()` (moved from `/api/cron/index-events`): new signatures of the program -> events -> DB | (existing) |
| 2 | `vrf` | every tick | one scan of VrfClaim + program-owned VrfGame: settle WON/LOST once the last successful L1 tx on the game is >= 60 s old (the player's client settles first; referral PDA mandatory) or the claim is >= 4,500 slots old, refund VOID, refund never-delegated zero-progress games older than 150 slots, force-undelegate idle delegated games on the ER (any status but pending PLAYING once the claim is >= 4,500 slots old: the idle signal is spoofable, audit A1) | a, c, c', b |
| 3 | `legacy` | 5 min | one scan of GameSession (dataSize 180): `expire_game` x10/tx for expired refund-branch games; `[expire_game, settle_game(+referrer)]` for the cash branch; settle Won/Lost unsettled games that still have a session (release-stuck-obligations, now with the referrer); session rows deleted only after the settle confirms | d, e |
| 4 | `lp-complete` | every tick | matured LP withdrawals inside `unlock..unlock+9000`: ONE unsigned `complete_withdraw` per tx; skips payouts below the 0-byte rent minimum into an empty wallet (skips do not count toward the cap); the start index rotates each tick so positions that keep failing cannot starve later ones; logs lapsed ones | f |
| 5 | `vault-health` | 15 min | health / paused / low balance / house balance alerts, plus a new alert when `HOUSE_SECRET_KEY`'s pubkey != `vault.house_authority` | (existing) |
| 6 | `invariants` | 24 h | port of `scripts/check-invariants.mjs`: multiplier (edge 200 or the live vault edge), popcount, commitment over `public.games`; allowlist `scripts/known-corruption-allow.txt`; one alert on any violation | (existing, was GitHub) |

Pass b thresholds (FIXES 9.3.b): terminal (WON/LOST/VOID) on the ER and no ER transaction on the game for 60 s (so
the player's own undelegate after a cash-out or loss lands first; the FIXES text says claim >= 150 slots, this is
stricter); or PLAYING, not pending, and claim >= 4,500 slots old or no ER transaction on the game for 300 s. Idle time
comes from ER `getSignaturesForAddress` (limit 1); a game with no ER transaction (delegated, never revealed) or no
`blockTime` counts as idle since its start (claim age x 400 ms). On an RPC error: PLAYING waits for the age rule, a
terminal game is forced only once it is 4,500 slots old. Caps per tick: 15 settles, 15 refunds, 15 forces, 15 legacy txs, 20 LP
completions.

Order note: FIXES lists c' after e because it was added in round 2; it runs inside the `vrf` pass here. No pass depends
on the order of another inside one tick (a forced game is settled or refunded on a later tick, once it is back on L1).

## Routes after the change

| route | state |
|---|---|
| `GET /api/cron/tick` | NEW, the only scheduler |
| `GET /api/cron/index-events` | kept: the manual `?reset=1&confirm=<cursor prefix>` rescan. Both paths run under the tick lock; the rescan answers 409 while a tick runs, and while it runs (it can take minutes) every tick returns `{ran:false}`, so house passes wait for it |
| `GET /api/cron/vrf-settle` | REMOVED (pass `vrf`) |
| `GET /api/cron/vault-health` | REMOVED (pass `vault-health`) |
| `POST /api/admin/release-stuck-obligations` | kept as the manual trigger of pass e (same code, now with referrer and delete-after-confirm); runs under the tick lock, 409 while a tick runs |

## GitHub Actions (`.github/workflows`, NOT edited)

They all call `https://www.playkaboom.gg/...`. Once DNS points at Railway they reach the new app.

| workflow | schedule | after the move | action for the lead |
|---|---|---|---|
| `index-tick.yml` | every 5 min | still works (index-events, normal path, under the tick lock: a no-op or a skip) | OBSOLETE: disable in the GitHub UI |
| `vrf-settle.yml` | every 5 min | 404 (route removed) and the run fails | OBSOLETE: disable |
| `vault-health.yml` | every 15 min | 404 (route removed) and the run fails | OBSOLETE: disable |
| `invariants.yml` | daily 03:00 UTC | breaks: uses `SUPABASE_URL`/`SUPABASE_ANON_KEY` | OBSOLETE (pass `invariants`): disable |
| `index-events.yml` | manual (reset) | works (`ADMIN_INDEX_RESET_SECRET`) | keep |
| `release-stuck-obligations.yml` | manual | works (`ADMIN_RELEASE_SECRET`) | keep (optional: the tick runs it every 5 min) |
| `ci.yml`, `codeql.yml` | push / PR | unaffected | keep |

## Tests

- `apps/web/src/server/cron/tick.test.ts` (in `npm run test:db`, real Postgres): overlapping ticks (second gets
  `ran:false`, the pass ran once), a lock held by another session blocks the tick, a throwing pass is reported while
  the next one still runs and the lock is free afterwards, cadence and retry-after-failure.
- Runtime: `next start` against `kaboom_rw_test` + public mainnet RPC: unauthenticated and wrong-bearer ticks get 401;
  a tick ran all six passes (vault not initialized yet, so vault-health reports it and lp-complete skips); two
  simultaneous ticks gave one `ran:true` and one `ran:false`; cadence showed `not_due` for legacy and invariants.
