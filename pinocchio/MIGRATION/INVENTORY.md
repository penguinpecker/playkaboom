# MIGRATION INVENTORY (Railway + Postgres + raw house key + VRF-only + Pinocchio program)

Read-only inventory, 2026-11-04. Paths are relative to `/Users/pp/Projects/playkaboom`. Line numbers are from the tree as it
is on that date. Nothing here was edited except this file. "MUST" = required by a binding decision; "SHOULD" = needed
for correctness under the new stack; "FLAG" = a decision or a check for the lead.

New program: `Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju`. Deployer (F1): `qouUoXTxNrFYw9DA7yCAnPXfAi9ypNWq2HPf5UMF9WG`.
Old program: `9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh`.

---

## 1. Supabase (every use)

### 1.1 Client creation
| file:line | side | what | change |
|---|---|---|---|
| apps/web/src/server/db/supabase.ts:1-39 | server | `supabaseAdmin()` (service role, SUPABASE_URL ?? NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY), `supabasePublic()` (anon key, NEXT_PUBLIC_SUPABASE_ANON_KEY) | MUST replace with a `pg` Pool on `DATABASE_URL` (one module). Both "admin" and "public" become the same server pool; the RLS split disappears (browser has no DB access at all). |
| apps/web/src/lib/supabase-browser.ts:1-31 | **browser** | `getSupabaseBrowser()` anon client for Realtime | MUST delete the file. |
| apps/realtime/src/index.ts:47, 51-52, 61-68, 408-411 | relay | `createClient(SUPABASE_URL, SUPABASE_ANON_KEY)`; fatal exit if unset | MUST replace with `pg` Client + `LISTEN`. |
| apps/web/package.json:22 | dep | `@supabase/supabase-js` | MUST remove; add `pg` + `@types/pg` (NOT installed today: `node_modules/pg` absent). |
| apps/realtime/package.json:14 (+ description line 5) | dep | `@supabase/supabase-js` | MUST remove; add `pg` + `@types/pg`. |
| apps/web/src/server/indexer.ts:7 | server | `import type { PostgrestError }` used by `check()` 36-43; error `.code` = SQLSTATE (23505 etc., TERMINAL_PG_CODES 48-54) | MUST switch to `pg` `DatabaseError.code` (same SQLSTATE strings). |

### 1.2 Queries (all server-side unless marked browser)
Read routes (were `supabasePublic`, anon + RLS):
| file:line | table / object | op |
|---|---|---|
| apps/web/src/app/api/leaderboard/route.ts:26-27 | views `leaderboard_alltime` / `leaderboard_volume` / `leaderboard_streaks` (picked by `?view`, 19-24) | `select * limit 50` |
| apps/web/src/app/api/verify/route.ts:183-188 | `games` | select `settle_signature, player` where `signature = sig` maybeSingle |
| apps/web/src/app/api/activity/[wallet]/route.ts:26-59 | `games` (eq player), `lp_actions` (eq user_address), `referral_events` x2 (eq referrer / eq player) | 4 selects, order slot desc, limit 50 |
| apps/web/src/app/api/activity/global/route.ts:20-27 | `games` | select 9 cols order slot desc limit N |
| apps/web/src/app/api/vault/position/[wallet]/route.ts:79-93 | `lp_positions` (maybeSingle `cumulative_deposited, cumulative_withdrawn`), `lp_actions` (order block_time desc limit 50) | selects |
| apps/web/src/app/api/vault/state/route.ts:68-74 | `vault_unit_value_history` | `unit_value_e18, block_time` where block_time <= now-30d order desc limit 1 |

Write / service-role paths (were `supabaseAdmin`):
| file:line | table / object | op |
|---|---|---|
| apps/web/src/server/indexer.ts:121-144 (`recordVrfGame`) | `games` | upsert onConflict signature |
| apps/web/src/server/indexer.ts:163-175 | rpc `idx_apply_stats` | function call |
| apps/web/src/server/indexer.ts:214-232 | `processed_events` | INSERT-first claim, `.select("signature")`, 23505 = skip |
| apps/web/src/server/indexer.ts:246-249 | `processed_events` | delete claim on transient apply error |
| apps/web/src/server/indexer.ts:295-307 | rpc `idx_apply_stats` | StatsUpdated |
| apps/web/src/server/indexer.ts:327-357 | rpc `idx_apply_game_settled` (returns row count) | GameSettled |
| apps/web/src/server/indexer.ts:364-381, 396-413 | `games` | upsert GameWon / GameLost |
| apps/web/src/server/indexer.ts:427-438 | rpc `idx_apply_referrer_set`; `referrals` upsert ignoreDuplicates | ReferrerSet |
| apps/web/src/server/indexer.ts:443-464 | `referral_events` upsert; rpc `idx_apply_referral_accrued` | ReferralAccrued |
| apps/web/src/server/indexer.ts:469-474 | rpc `idx_apply_referral_tier` | |
| apps/web/src/server/indexer.ts:479-484 | rpc `idx_apply_referral_claimed` | |
| apps/web/src/server/indexer.ts:492-513, 518-538, 543-562, 569-592 | `lp_actions` upsert + rpc `idx_apply_lp_deposit` / `_request` / `_cancel` / `_complete` | LP events |
| apps/web/src/server/indexer.ts:598-610 | `vault_unit_value_history` upsert onConflict slot | |
| apps/web/src/server/indexer.ts:647-659 | `lp_actions` upsert (house_* actions, user `__house__`) | |
| apps/web/src/server/points.ts:111-130 (`awardPoints`) | `points_ledger` | upsert onConflict `source_key,source` ignoreDuplicates |
| apps/web/src/server/session-store.ts:41-43 | `game_sessions` | upsert onConflict game (legacy commit-reveal ciphertext) |
| apps/web/src/server/session-store.ts:97-101 | `game_sessions` | select `ciphertext, player` eq game |
| apps/web/src/server/session-store.ts:121 | `game_sessions` | delete eq game |
| apps/web/src/server/referral-codes.ts:35-70 (`getOrCreateCodeForWallet`) | `referral_codes` | select eq wallet; insert returning *; 23505 + message contains `one_code_per_wallet` (constraint name, keep it) |
| apps/web/src/server/referral-codes.ts:79-96 (`resolveAndCountVisit`) | `referral_codes` | select eq code; fire-and-forget update click_count (read-modify-write; SHOULD become `click_count = click_count + 1`) |
| apps/web/src/server/referral-tracking.ts:26-40 (`recordVisitClick`) | `referral_visits` | insert |
| apps/web/src/server/referral-tracking.ts:51-95 (`recordSignup`) | `referral_visits` select/update `.is("wallet", null)`; `referral_codes` select+update signup_count (RMW) | |
| apps/web/src/server/referral-tracking.ts:103-145 (`recordSetReferrerConfirmation`) | `referral_visits` select/update; `referral_codes` confirmed_count (RMW) | |
| apps/web/src/app/api/cron/index-events/route.ts:63-69, 152-160, 205-213 | `cron_indexer_state` (PK `program`) | select cursor, upsert x2 |
| apps/web/src/app/api/status/route.ts:252-266 | `cron_indexer_state` (last_slot), `games` (newest settled_at) | selects |
| apps/web/src/app/api/admin/release-stuck-obligations/route.ts:133-153, 203-208 | `game_sessions` | select ciphertext, delete |
| apps/web/src/app/api/admin/backfill-points/route.ts:53-71 | `games` | paged select `.range()` ordered settled_at |

Callers of the helpers above (no direct Supabase, but go through them): `app/api/commit` (saveSession), `app/api/reveal` (load/save/deleteSession, indexFreshSignature), `app/api/settle`, `app/api/cleanup`, `app/api/session/[player]` (loadSession), `app/api/ref/{signup,confirm,code/[wallet],[code]}`, `app/api/ingest`, `app/api/vrf/{settle,refund}`, `app/api/cron/vrf-settle`, `server/inline-ingest.ts`.

### 1.3 Realtime (browser + relay)
| file:line | what | change |
|---|---|---|
| apps/web/src/hooks/use-global-games.ts:4, 82-86 (doc), 184-208 | **browser** Layer 2: `postgres_changes` INSERT+UPDATE on `public.games` (channel `global-games-feed`). Receives the FULL row (replica identity full) incl. `mine_layout`/`salt` | MUST delete Layer 2 (decision). Keep Layer 1 (relay WS, 115-182) and Layer 3 (60 s TanStack poll, 102-113). |
| apps/realtime/src/index.ts:404-506 | relay upstream: `postgres_changes` INSERT + UPDATE on `public.games`, projects 12 safe cols (`pickSafeCols` 449-466) | MUST become `LISTEN <channel>` on a pg trigger. |
| apps/realtime/src/index.ts:629-631 | `supabase.removeChannel` on shutdown | replace with client.end() |
| supabase/migrations/20260509000001_realtime_games.sql:15-21, 20260509000003_realtime_scope_trim.sql:13 | `supabase_realtime` publication (games only after trim; lp_actions dropped) | do NOT port; replace with trigger + `pg_notify`. |

**WebSocket message shapes the browser consumes (must stay byte-compatible):**
- On connect: `{"type":"hello","clients":<n>,"upstream":<bool>,"ts":<ms>}` (index.ts:208-215). Browser ignores it.
- Per games INSERT/UPDATE: `{"type":"game_settled","event":"game_inserted"|"game_updated","data":{signature,game,player,bet,outcome,payout,multiplier_bps,safe_reveals,mine_count,settled_at,settle_signature,slot},"ts":<ms>}` (index.ts:467-481). Browser: `use-global-games.ts:142-147` accepts `type==="game_settled" && data`, parses with `rowToGame(GamesRow)`.
- `/health` JSON `{ok,clients,rpc_proxy_clients,upstream,alchemy_logs,uptime_s}` (index.ts:74-88) is read by `app/api/status/route.ts:327-345` (`upstream` boolean). Keep `upstream` meaning "DB listener connected".
- Trigger payload: NEVER include `mine_layout`, `salt`, `commitment` (the relay projection exists for this; pg_notify payload limit is 8000 bytes, the 12 cols fit). bigint cols (`bet`, `payout`, `slot`) must be sent as strings or numbers exactly as today (Supabase sent JSON numbers; `rowToGame` must accept the type the trigger emits).
- Only the `games` table is fanned out today. lp_actions is NOT (trimmed 2026-05-09).

### 1.4 Supabase in SQL (schema to port, see `pinocchio/MIGRATION/schema.md` if present)
- 31 migrations under `supabase/migrations/`. Tables (13, final): `games` (PK signature), `player_stats` (player), `referrals` (referrer), `referral_events` (signature), `processed_events` (signature), `cron_indexer_state` (program), `lp_positions` (user_address), `lp_actions` (signature), `vault_unit_value_history` (slot), `game_sessions` (game), `referral_codes` (code; unique constraint name `one_code_per_wallet` is matched by string in referral-codes.ts:56), `referral_visits` (uuid id, `gen_random_uuid()`), `points_ledger` (bigserial id; unique `uniq_points_per_source`). `game_session_keys` was created then dropped (20260521000002).
- Views: `leaderboard_alltime` (redefined in 20260510000001), `leaderboard_volume`, `leaderboard_streaks`, `points_balance`.
- Functions: `idx_apply_stats`, `idx_apply_game_settled` (returns int), `idx_apply_referrer_set`, `idx_apply_referral_accrued`, `idx_apply_referral_tier`, `idx_apply_referral_claimed`, `idx_apply_lp_deposit/request/cancel/complete`, `touch_updated_at` (security definer). Use the LAST definition of each (several are redefined 2-3 times).
- Triggers: `touch_player_stats`, `touch_referrals`, `trg_cron_indexer_state_updated_at`, `trg_game_sessions_updated_at`, `trg_lp_positions_updated_at`.
- Supabase-only constructs to strip: roles `anon`, `authenticated`, `service_role` in every GRANT/REVOKE (20260505000002_security.sql:52-114, lp_vault.sql:69-84, cron_indexer_state.sql:17-18, game_sessions.sql:30-31, points_ledger.sql:100-106, indexer_atomic_ops.sql REVOKE/GRANT block, biggest_loss.sql:46), RLS policies (`read all`, `lp_*_public_read`, `vault_uv_public_read`), `alter publication supabase_realtime`, `replica identity full`. `gen_random_uuid()` is core in PG 13+ (local server is PG 17.11).

### 1.5 Supabase in non-code
- apps/web/next.config.mjs:17 (comment), 38-39: CSP `https://*.supabase.co`, `wss://*.supabase.co` -> MUST remove.
- apps/web/src/server/logger.ts:48-49 redact `SUPABASE_SERVICE_ROLE_KEY` -> replace with `DATABASE_URL`, `databaseUrl` (+ `HOUSE_SECRET_KEY`, see 5).
- apps/web/src/app/privacy/page.tsx:48, 109, 151-154: names Supabase (and Turnkey, Vercel) as processors -> SHOULD update copy (Railway Postgres, no Turnkey).
- apps/web/src/server/db/types.ts:2-6: comment says generated from Supabase; types still valid for Postgres.
- Comments only: commit/route.ts:39,60,143; ref/referees/[wallet]/route.ts:22; referrals/page.tsx:116; ref/code/[wallet]/route.ts:24; lib/wallet-history.ts:2; session-store.ts:10-12,45.
- supabase/config.toml (local Supabase CLI config): obsolete.
- Ops scripts using Supabase REST directly (not on the runtime path; update or mark retired): scripts/check-invariants.mjs:29-30 (SUPABASE_URL/ANON_KEY; run by .github/workflows/invariants.yml:29-30), scripts/backfill-points.ts:57-58, scripts/audit-phase3.ts:132-133, scripts/health-diagnose.ts:79-80, scripts/repair-vault-mirror.ts:47-48, scripts/verify-sig.mjs, scripts/audit-multipliers.mjs, scripts/verify-deploy.sh:220 (CSP host check list includes supabase.co).

### 1.6 Data copy notes (for the one-shot copy script)
- Tables to copy: the 13 above (views are derived). Idempotent: `INSERT ... ON CONFLICT (pk) DO NOTHING` (or DO UPDATE) per PK listed in 1.4; `points_ledger` keep `id`, then `setval(pg_get_serial_sequence('points_ledger','id'), max(id))`; `referral_visits` keep uuid.
- PostgREST pages at 1000 rows by default: page with `Range`/`offset` + `order=<pk>`.
- **FLAG precision:** PostgREST serialises `bigint` as a JSON number; `JSON.parse` silently rounds values above 2^53 (lamport totals in `player_stats.total_wagered/total_payouts`, `vault_unit_value_history.vault_assets`, `lp_*`). The copy must request those columns as text (PostgREST `select=col::text` cast) or use `Accept: text/csv`. `numeric` columns (lp units, `unit_value_e18`) likewise.
- **FLAG history vs new program:** the aggregate mirrors are keyed by wallet, not by program: `idx_apply_stats` (indexer_atomic_ops.sql) OVERWRITES `games_played/games_won/total_wagered/total_payouts/current_streak` with the on-chain PlayerStats snapshot, and the new program's PlayerStats start at 0, so a returning player's carried-over totals drop to new-program totals on their first new game (biggest_win/best_streak survive via GREATEST). `referrals` pending/earned include old-program unclaimed amounts that cannot be claimed on the new program. `lp_positions` units/cumulatives from the old vault would be added to new-vault events by `idx_apply_lp_*`. `vault_unit_value_history` old rows feed the 30-day APY baseline in vault/state/route.ts:68-74 (old vault's unit value). `game_sessions` ciphertexts belong to old-program PDAs (useless but harmless). Owner decision: copy as-is (decision says "history to carry over") but either keep old aggregates in separate archive tables, or reset the aggregate tables and keep only event/history tables (`games`, `lp_actions`, `referral_events`, `points_ledger`, `referral_codes`, `referral_visits`).
- `cron_indexer_state` is keyed by program base58; the new program gets a new row automatically (index-events/route.ts:152, 205). `processed_events` is keyed by signature; old rows harmless.

---

## 2. Turnkey and the house signer

### 2.1 Interface callers rely on (keep exactly)
`apps/web/src/server/turnkey-signer.ts:7-10`
```ts
export interface HouseSigner {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
}
export function getHouseSigner(): HouseSigner   // :54-56
```
Plus `housePubkey(): PublicKey` from `server/env.ts:31-42`.

Only caller of `getHouseSigner`: `apps/web/src/server/solana.ts:11, 120` (`sendHouseTx`, L1 only, legacy `Transaction`, fee payer = house, CU price p75 [5k,50k], CU limit 200k, `skipPreflight:false`).

`housePubkey()` callers: app/api/reveal/route.ts:57; app/api/health/route.ts:21 (returned in JSON: pubkey only, fine); app/api/admin/release-stuck-obligations/route.ts:82; app/api/cleanup/route.ts:82; app/api/settle/route.ts:58; app/api/vrf/settle/route.ts:69; app/api/vrf/refund/route.ts:44; app/api/cron/vrf-settle/route.ts:87, 176.

### 2.2 Turnkey uses to remove
| file:line | what |
|---|---|
| apps/web/src/server/turnkey-signer.ts:3-4, 12-34, 54-56 | `@turnkey/sdk-server`, `@turnkey/solana`, `turnkeyHouseSigner()`, branch in `getHouseSigner`. Keep only the local keypair signer (36-52); MUST rename file (e.g. `house-signer.ts`) and update solana.ts:11. |
| apps/web/src/server/env.ts:9-25 | `houseAuthority()` reads **HOUSE_AUTHORITY_KEY**, JSON byte array only -> MUST read **HOUSE_SECRET_KEY**, accept base58 OR JSON array (decision), never log/return it. |
| apps/web/src/server/env.ts:27-29, 31-42 | `useTurnkey()` (USE_TURNKEY), `housePubkey()` Turnkey branch (TURNKEY_HOUSE_PUBKEY) -> derive from the keypair only. |
| apps/web/src/server/env.ts:58-78 | `TurnkeyConfig`, `turnkeyConfig()` (TURNKEY_ORG_ID, TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, TURNKEY_HOUSE_PUBKEY) -> delete. |
| apps/web/package.json:24-25 | `@turnkey/sdk-server`, `@turnkey/solana` -> remove. |
| apps/web/src/server/logger.ts:42-43, 50-51 | redact `HOUSE_AUTHORITY_KEY`, `TURNKEY_API_PRIVATE_KEY` -> add `HOUSE_SECRET_KEY`, `houseSecretKey`. |
| apps/web/src/lib/chain.ts:33-46 | hardcoded `TURNKEY_HOUSE_AUTHORITY_MAINNET = 7exwTWn1...prQp` shown on /vault as "Turnkey HSM (house signer)" -> MUST change (read `vault.house_authority` on chain, or a NEXT_PUBLIC pubkey var; label "House signer"). |
| apps/web/src/app/page.tsx:51 | marketing copy "House signing on Turnkey HSM" -> MUST change (now false). |
| apps/web/src/app/privacy/page.tsx:105-106, 151-154 | Turnkey as processor / "never leaves the enclave" -> MUST change. |
| apps/web/src/app/api/cron/vault-health/route.ts:38, 113-114, 120, 127 | alert text "Turnkey/house wallet" -> cosmetic. |
| scripts/init-vault-mainnet.ts:8, 14, 32, 57, 78 | `TURNKEY_HOUSE = 7exwT...` hardcoded as house_authority -> MUST become the new raw house pubkey (see 3). |
| scripts/rotate-house.ts:2-16, 42 | rotates house to TURNKEY_HOUSE_PUBKEY; devnet default RPC -> update or retire. |
| scripts/turnkey-transfer.ts (whole file) | Turnkey-signed transfer -> retire. |
| scripts/sign-smoke.ts | check (Turnkey smoke, per name) -> retire. |

### 2.3 New signing need (F3, cron 9.3.b)
`sendHouseTx` only targets L1 (`getConnection()`). The F3 force pass must sign and send `force_undelegate_vrf` **on the ER**: needs a server ER `Connection` (from `NEXT_PUBLIC_ER_RPC` or a server `ER_RPC`; today the server reads `process.env.NEXT_PUBLIC_ER_RPC` in session/[player]/route.ts:77 and status/route.ts:40) and a send helper with the ER blockhash and the house as fee payer (no priority-fee lookup on the ER; `getRecentPrioritizationFees` against the ER is not meaningful). The client-side pattern to copy is `lib/vrf/client.ts:110-160` (sign + send + poll on a given conn).

---

## 3. Old program ID, hardcoded addresses, IDL

### 3.1 Program ID (env-driven, set the new value)
| where | name | note |
|---|---|---|
| apps/web/src/server/env.ts:97-104 | `PROGRAM_ID` (server) | throws if unset |
| apps/web/src/lib/cluster.ts:100-103 | `NEXT_PUBLIC_PROGRAM_ID` (inlined at BUILD) | falls back to dummy `Kab1TestProgam1111...` if unset; SHOULD throw in production builds instead |
| apps/realtime/src/alchemy-logs.ts:59 | `KABOOM_PROGRAM_ID` | logsSubscribe filter |
| turbo.json:9 | `PROGRAM_ID` in `globalPassThroughEnv` (NEXT_PUBLIC_PROGRAM_ID is not listed; turbo cache could serve a bundle built with another ID) | SHOULD add NEXT_PUBLIC_PROGRAM_ID and the other NEXT_PUBLIC_* vars |
| apps/web/.env.local (untracked) | PROGRAM_ID, NEXT_PUBLIC_PROGRAM_ID | names only |

All SDK/TS PDA derivations take `programId` as a parameter (packages/sdk/src/pdas.ts, vrf.ts); nothing in packages/ hardcodes a program ID.

### 3.2 Scripts the lead will use (hardcoded old ID)
| file:line | change |
|---|---|
| scripts/init-vault-mainnet.ts:12, 31 | PROGRAM_ID -> `Ednka8...`; house (32) -> new raw house pubkey; signer must be the deployer `qouUo...9WG` (F1, 6055 otherwise). `DEPLOYER_PATH = keypairs/mainnet-deployer.json` (41): FLAG confirm its pubkey equals `qouUo...` (not read here). |
| scripts/init-v2-mainnet.ts:22 | PROGRAM_ID -> new. Default cooldown 648,000 slots satisfies the F4 rule (>= 450,000). |
| scripts/rotate-to-squads-mainnet.ts:31-32 | PROGRAM_ID -> new; Squads vault `464FeYiv...VP5` (FLAG: still the intended owner/treasury?). |
| scripts/verify-deploy.sh:28 | `PROGRAM_ID=9Xip2L...`; also Vercel API calls (22-63) and `$HOME/.keystores` token -> rewrite for Railway or retire. |
| scripts/diagnose-user.ts:12, health-diagnose.ts:11, list-stuck.ts:6, referrals-by.ts:4, show-referral.ts:4, repair-vault-mirror.ts:45 | hardcoded old ID (ops tools) |
| scripts/rotate-owner.ts, transfer-upgrade-authority.ts, upgrade-program-via-squads.ts, initialize-v2.ts, rotate-treasury.ts, squads-status.ts, init-vault.ts | devnet defaults (`api.devnet.solana.com`, `keypairs/squads-devnet.json`, 4rPEGz...) -> mainnet-only rule: do not use as-is |

**FLAG missing script:** nothing sets the VRF config on a fresh v2 state. VRF needs `update_v2_config(vrfModeEnabled=true, vrfValidator=MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57, vrfMaxPayoutBps=<owner value>)` (builder exists: packages/sdk/src/instructions.ts:466-517). Without it every `delegate_vrf` fails (VrfValidatorNotSet 6053). Also `fund_vault` / LP seed before init_v2 (init-v2 requires >= 1 SOL above rent, :59).

### 3.3 Hardcoded addresses in app/packages
| file:line | address | status |
|---|---|---|
| apps/web/src/lib/chain.ts:34-37 | Squads mainnet/devnet vaults, Turnkey house mainnet/devnet | MUST update house (2.2); Squads FLAG |
| apps/web/src/lib/cluster.ts:86-88 | `wss://kaboom-realtime-production.up.railway.app/rpc-ws` (browser WS for signature/account subscribe) | FLAG verify this is the live `kaboom-realtime` domain in project KABOOM_PINOCCOIO_MAGICBLOCK; SHOULD come from env |
| apps/web/next.config.mjs:50 | CSP `wss://kaboom-realtime-production.up.railway.app` | MUST match the relay host (comment 44-49 records a past silent break) |
| apps/web/src/lib/cluster.ts:160, packages/sdk/src/vrf.ts:26-38 | VRF queue `5hBR571x...`, DLP, VRF program, Magic program/context | MagicBlock constants, unchanged |
| apps/web/src/middleware.ts:22-23; next.config.mjs:156-170 | `status.playkaboom.gg`, `https://playkaboom.gg` host routing | keep; both hosts must be attached to the Railway service |
| apps/realtime/src/index.ts:53-56 | default ALLOWED_ORIGINS playkaboom.gg, www, localhost:3000 | keep / set env |

### 3.4 IDL
- `target/idl/kaboom.json`: `address` = old ID; `delegate_vrf.buffer_game` PDA has a `const` program = old ID bytes (32-byte array `[126,188,49,...]`). 55 errors (6000-6054), 42 instructions; no `expire_game` / `force_undelegate_vrf` / 6055-6057.
- **Nothing in apps/web, apps/realtime, packages or the mainnet scripts loads the IDL.** The SDK hand-rolls discriminators (`packages/sdk/src/discriminator.ts`: `sha256("global:"+name)[..8]`, `sha256("account:"+name)[..8]`) and derives `buffer` under `args.ctx.programId` (vrf.ts:61-63), so the stale IDL PDA const does not affect runtime. Only reference: comment in packages/sdk/src/errors.ts:8-10. `tests/anchor/runner.ts` (Anchor client, devnet ID) uses it; not in the turbo test pipeline.
- Do not regenerate it from `programs/` (Anchor, untouchable). If any tool needs it, hand-patch a copy for the new ID.

### 3.5 Error decoding differences under Pinocchio (D5)
The port logs no `AnchorError ... Error Number` lines, only the runtime's `custom program error: 0x..`. `extractAnchorFrameworkError` (packages/sdk/src/errors.ts:151-178) and `extractKaboomError` (84-99) already fall back to the hex form, but `account` names are never available (solana.ts:154-163 message loses the account). `isAccountNotInitializedError` still works via 0xbc4.

---

## 4. Vercel-specific things

| file:line | what | change |
|---|---|---|
| vercel.json (repo root) | build/install/output/ignoreCommand for Vercel | not runtime; SHOULD delete or leave unused (no crons in it) |
| turbo.json:5 | `VERCEL_ENV` in globalEnv | remove |
| apps/web/src/app/api/version/route.ts:26 | `VERCEL_DEPLOYMENT_ID ?? NEXT_PUBLIC_BUILD_ID ?? "dev"` (version-guard compares it; components/providers/version-guard.tsx) | MUST supply a per-deploy id on Railway: `RAILWAY_DEPLOYMENT_ID` (Railway-provided) or set `NEXT_PUBLIC_BUILD_ID` at build. Without it every deploy reports "dev" and stale-tab detection is dead. |
| apps/web/src/server/ratelimit.ts:29 | `VERCEL_ENV` only in a log line; comment 14 | cosmetic |
| `export const maxDuration = 60` | cron/index-events:13, cron/vrf-settle:26, admin/release-stuck-obligations:19 | ignored off Vercel; per-run caps (index-events:24 `MAX_SIGNATURES_PER_RUN=300`, vrf-settle:29 `MAX_SETTLE_PER_RUN=15`) were sized for Vercel's 60 s; may stay, but the single tick route must still finish inside one 60 s relay interval or the lock must skip overlapping ticks |
| `export const runtime = "nodejs"` (36 routes) | fine on Railway. No `edge` runtime anywhere. |
| apps/web/src/middleware.ts | Next middleware (runs in Next's edge sandbox under `next start` too; uses only `NextResponse`) | works on `next start`; keep |
| apps/web/src/server/api-helpers.ts:31-35 `clientIp` | takes FIRST `x-forwarded-for` entry (trusted on Vercel, which overwrites it) | FLAG verify Railway's proxy behaviour: if it appends rather than overwrites, the first hop is client-controlled and every rate-limit key (`commit:`, `reveal:`, `vrf-settle:`, `vrf-refund:`, `cleanup:` + `/api/rpc` per-IP) becomes spoofable. Use the last hop or Railway's real-IP header. |
| apps/web/src/server/auth.ts:15-18 (comment) | in-memory auth cache "per function process" | on Railway it is one long-lived process: fine, better hit rate |
| apps/web/src/server/ratelimit.ts:45-75 | in-process fallback limiter when Upstash unset | on a single Railway replica it becomes a real limiter; keep |
| apps/web/src/server/connection.ts:9 | comment about serverless cold starts | cosmetic |
| apps/web/src/lib/cluster.ts:58-98, components/providers/web3.tsx:85 | WS goes to the Railway relay `/rpc-ws` because Vercel functions cannot upgrade WS | keep as is |
| apps/web/next.config.mjs:139-143 | `/_next/static` CORP cross-origin "if hosted on Vercel CDN" | harmless |
| No `@vercel/*` package, no `vercel.json` crons, no `@vercel/kv|blob|edge-config` anywhere. |
| GitHub Actions `.github/workflows/{index-tick,vrf-settle,vault-health,release-stuck-obligations,index-events,invariants}.yml` | curl `https://www.playkaboom.gg/api/...` on cron (5 min / 15 min / manual) with `CRON_TICK_SECRET`, `ADMIN_RELEASE_SECRET`, `ADMIN_INDEX_RESET_SECRET`; invariants uses Supabase secrets | DO NOT EDIT (decision). FLAG for the migration doc: once DNS points at Railway these keep calling the new app every 5 min. Either keep the old per-pass routes under the same lock (duplicates become no-ops) or remove those routes and let the workflows 404/401; and disable them in the GitHub UI. invariants.yml will break when Supabase is gone. |
| scripts/deploy.sh, watch-deploy.sh, verify-deploy.sh | Vercel CLI/API deploy + verify | rewrite or retire |

Railway deploy config: `apps/realtime/railway.json` exists (NIXPACKS, numReplicas 1, healthcheck `/health`). **No Railway config exists for apps/web** (needs build `npm ci && npm run build --workspace=@playkaboom/web` from repo root, start `npm run start --workspace=@playkaboom/web`; `next start` honours `PORT`). Keep web at 1 replica or use a DB lock (pg advisory lock) for the tick.

---

## 5. Environment variables (every read)

S = server only, P = `NEXT_PUBLIC_*` (inlined into the browser bundle at build), R = relay.

| name | where read | side | migration |
|---|---|---|---|
| ADMIN_BACKFILL_SECRET | app/api/admin/backfill-points/route.ts:42 | S | keep |
| ADMIN_INDEX_RESET_SECRET | app/api/cron/index-events/route.ts:240 | S | keep |
| ADMIN_RELEASE_SECRET | app/api/admin/release-stuck-obligations/route.ts:63 | S | keep |
| ALERT_WEBHOOK_URL / ALERT_WEBHOOK_FORMAT | server/alerts.ts:38, 40 | S | keep |
| CRON_SECRET | admin/backfill-points:42, admin/release-stuck:63, cron/index-events:244-245, cron/vault-health:54, cron/vrf-settle:41, ingest:46 | S | legacy fallback everywhere; SHOULD drop on the fresh deploy |
| CRON_TICK_SECRET | cron/index-events:241, cron/vault-health:54, cron/vrf-settle:41 | S | the single tick route's secret (= relay CRON_TICK_AUTH) |
| HELIUS_WEBHOOK_AUTH | cron/index-events:245, ingest:47 | S | legacy fallback; drop |
| INGEST_SECRET | app/api/ingest/route.ts:45 | S | keep (= relay INGEST_AUTH) |
| HOUSE_AUTHORITY_KEY | server/env.ts:12 | S | **rename to HOUSE_SECRET_KEY** (base58 or JSON) |
| USE_TURNKEY, TURNKEY_ORG_ID, TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, TURNKEY_HOUSE_PUBKEY | server/env.ts:28, 35, 68-71 | S | **delete** |
| SUPABASE_URL | server/db/supabase.ts:13, 30; realtime/index.ts:51 | S/R | **delete** -> DATABASE_URL |
| SUPABASE_SERVICE_ROLE_KEY | server/db/supabase.ts:14 | S | **delete** |
| SUPABASE_ANON_KEY | realtime/index.ts:52 | R | **delete** |
| NEXT_PUBLIC_SUPABASE_URL | lib/supabase-browser.ts:18; server/db/supabase.ts:13, 30 | P | **delete** |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | lib/supabase-browser.ts:19; server/db/supabase.ts:31 | P | **delete** |
| (new) DATABASE_URL | — | S/R | Railway Postgres (private network URL for both services) |
| PROGRAM_ID | server/env.ts:100 | S | new ID |
| NEXT_PUBLIC_PROGRAM_ID | lib/cluster.ts:100 | P | new ID (build time) |
| KABOOM_PROGRAM_ID | realtime/alchemy-logs.ts:59 | R | new ID |
| SOLANA_RPC | server/env.ts:107 (defaults to **devnet**), api/rpc/[cluster]:68, 71, api/whoami:30 (host only) | S | SHOULD make the default fail or mainnet-only (mainnet-only rule) |
| SOLANA_MAINNET_RPC | api/rpc/[cluster]/route.ts:71 | S | keep |
| NEXT_PUBLIC_SOLANA_CLUSTER | lib/cluster.ts:4 (defaults to **devnet**), api/whoami:27 | P | must be `mainnet-beta` |
| NEXT_PUBLIC_SOLANA_RPC | lib/cluster.ts:44-46 | P | dev-only, tree-shaken in prod; leave unset |
| NEXT_PUBLIC_SOLANA_WS | lib/cluster.ts:93-95 | P | dev-only; leave unset |
| NEXT_PUBLIC_ER_RPC | lib/cluster.ts:135; also SERVER reads in api/session/[player]:77, api/status:40 | P (+S) | `https://as.magicblock.app/` (keep). Server F3 pass needs it too (or a server `ER_RPC`) |
| NEXT_PUBLIC_ER_WS | lib/cluster.ts:135 | P | keep |
| NEXT_PUBLIC_VRF_QUEUE | lib/cluster.ts:162-163 | P | optional override; leave unset |
| NEXT_PUBLIC_VRF_MODE_ENABLED | lib/cluster.ts:182 | P | VRF-only: SHOULD drop the flag (UI always VRF) or force `true` |
| VRF_MODE_ENABLED | server/env.ts:120; api/session/[player]:52 (reads env directly) | S | server kill switch for VRF money routes; keep (must be `true`) |
| NEXT_PUBLIC_REALTIME_WS_URL | hooks/use-global-games.ts:117; api/status:328 (server also reads it) | P | relay URL `wss://<kaboom-realtime host>` |
| NEXT_PUBLIC_PRIVY_APP_ID | components/providers/web3.tsx:60; server/auth.ts:45; api/whoami:25 | P | keep |
| PRIVY_APP_ID | server/auth.ts:45; api/whoami:25 | S | keep |
| PRIVY_APP_SECRET | server/auth.ts:46; api/whoami:26 (boolean only) | S | keep |
| SESSION_ENC_KEY | server/env.ts:83 | S | keep (legacy session ciphertext; still needed for wind-down + F2 cash branch) |
| TREASURY_PUBKEY | server/env.ts:52 | S | must equal new `vault.treasury` |
| UPSTASH_REDIS_REST_URL / _TOKEN | server/ratelimit.ts:24-25 | S | optional; keep |
| LOG_LEVEL | server/env.ts:124 | S | keep |
| NEXT_PUBLIC_BUILD_ID | api/version/route.ts:27 | P | set per build (see 4) |
| VERCEL_DEPLOYMENT_ID | api/version/route.ts:26 | S | replace with RAILWAY_DEPLOYMENT_ID |
| VERCEL_ENV | server/ratelimit.ts:29 | S | drop |
| NODE_ENV | next.config.mjs:3; ref/[code]:61, 69; lib/cluster.ts:43, 92; env.ts:124; ratelimit.ts:29 | — | standard |
| PORT | realtime/index.ts:50 (and `next start`) | R/S | Railway-provided |
| ALLOWED_ORIGINS | realtime/index.ts:54 | R | keep |
| ALCHEMY_WS_URL | realtime/alchemy-logs.ts:58; realtime/index.ts:239 | R | keep |
| INGEST_URL / INGEST_AUTH | realtime/alchemy-logs.ts:60-61 | R | point at the Railway web host |
| CRON_TICK_URL / CRON_TICK_AUTH | realtime/index.ts:516-517 | R | CRON_TICK_URL becomes the ONE tick route (comma list supported, 540) |

Names present in apps/web/.env.local but read by no code: SOLANA_WS, HELIUS_API_KEY, SENTRY_DSN, NEXT_PUBLIC_SENTRY_DSN (turbo.json lists NEXT_PUBLIC_SENTRY_DSN; no Sentry SDK installed).
No secret is in a NEXT_PUBLIC_* var today except the Supabase anon key (public by design), which goes away.

---

## 6. Commit-reveal (legacy) start path that VRF-only removes

On the new program `start_game` always fails 6057, so on this program ID **no legacy GameSession can ever exist**; every legacy wind-down path below is dead on arrival but the decision keeps the on-chain instructions.

### 6.1 Server: MUST remove
- `apps/web/src/app/api/commit/route.ts` (whole route, 1-165): `buildStartGame` + `createGameSession` + `saveSession`.
- `apps/web/src/lib/api.ts:83-94` `CommitResponse`, `apiCommit`.
- `packages/sdk/src/instructions.ts:82-115` `buildStartGame` (SHOULD keep for tests/ABI, or delete; no other caller).
- `packages/shared/src/schemas.ts:8-15` `StartGameInput` (only /api/commit uses it).
- `apps/web/src/server/game.ts` `createGameSession` (only /api/commit); keep `saltBuffer` (used by settle, cleanup, release-stuck).

### 6.2 UI: MUST remove
- `apps/web/src/hooks/use-game-actions.ts:265-414` legacy `startGame` (`apiCommit` at 290, ref/confirm at 385).
- `apps/web/src/hooks/use-game-actions.ts:796-802` mode selector `VRF_MODE_ENABLED ? vrf.x : x` -> always `vrf.*`.
- `apps/web/src/lib/cluster.ts:167-182` `VRF_MODE_ENABLED` (UI routing flag); consumers BetControls.tsx:11, 113; useContracts.tsx:24, 220; use-vrf-game.ts:37, 601; use-game-actions.ts:29.

### 6.3 Legacy PLAY paths (not "start"): FLAG keep-or-remove (removing = removing features; list for the lead)
They can never be reached on the new program; they still compile and touch the house key.
- Server: `app/api/reveal/route.ts` (house signs `reveal_tile`; loadSession/saveSession), `app/api/settle/route.ts` (cash_out ix + house `settle_game`), `lib/api.ts:96-127` apiReveal/apiSettle.
- UI: `use-game-actions.ts:416-561` legacy `revealTile`, `563-790` legacy `cashOut`, `194-263` legacy `cleanupStuck` (apiCleanup), `94-192` signAndBroadcast/signAndSend if unused after.
- Recommendation: remove reveal/settle routes and the legacy client actions together with start (they are unreachable and widen the house-key attack surface); keep the wind-down surface below.

### 6.4 Legacy wind-down surface: keep (decision: stray games can wind down)
- `app/api/cleanup/route.ts` (close_game / close_unsettled_game / refund_expired ixs for the player; house `settle_game` at 74-104 **without referrer** - see 7.4).
- `app/api/session/[player]/route.ts:135-190` legacy branch, `app/api/game/[player]/route.ts`.
- `components/game/GameRecoveryBanner.tsx` legacy branch (builds cash_out / refund_expired / close_unsettled / close_game client-side, 18, 38-50, 105-160).
- `server/session-store.ts` (game_sessions) - also needed by the F2 cash branch (settle_game needs layout+salt) and release-stuck-obligations.
- `server/solana.ts:185-273` confirmOutcomeSettled / playerHasActiveGame / requireActiveGame (legacy PDA probes).
- `@playkaboom/shared` GAME_EXPIRY_SLOTS / CLOSE_UNSETTLED_EXPIRY_SLOTS.

---

## 7. FIXES.md section 9 mapped to files

### 7.1 SDK (`packages/sdk`) - 9.2
| item | file | detail |
|---|---|---|
| `buildExpireGame` (F2) | packages/sdk/src/instructions.ts (legacy section, near buildRefundExpired 308) | disc `d0155783f22bfc90` (= ixDiscriminator("expire_game")), no args, accounts `[vault W, v2_state W, game W, player W (not signer)]` |
| `buildForceUndelegateVrf` (F3) | packages/sdk/src/vrf.ts (near buildSettleAndUndelegateVrf 259) | disc `da30a3da54f8e465` (= ixDiscriminator("force_undelegate_vrf")), no args, accounts `[house W+S, game W, MAGIC_PROGRAM r, MAGIC_CONTEXT W, vault r]` (vault read-only per spec order; FIXES 4.1 lists `vault` without W) |
| `buildCompleteWithdraw` user non-signer (F4) | packages/sdk/src/instructions.ts:534-573 | today `buildUserLpAction` hard-codes `writable(user, true)` (550); add `{ userSigns?: boolean }` (default true for the player UI, false for the keeper) - accounts `[vault W, v2 W, position W, user W]`, any fee payer |
| `VrfStatus` gains `"Void"` = 3 | packages/sdk/src/vrf.ts:350-351, 417 | `VRF_STATUS[r.u8()] ?? "Playing"` maps 3 to **"Playing"** today (dangerous: cron and UI treat it as live). Add "Void" at index 3; unknown index should throw, not default to Playing |
| error names 6055-6057 | packages/sdk/src/errors.ts:11-68 | append `NotDeployer`, `WithdrawWindowExpired`, `LegacyModeDisabled`; update comment 5-10 |
| IDL additions | n/a | no IDL consumer (3.4); covered by the builders |
| Tests | tests/sdk/instructions.test.ts | add disc checks for the 2 new builders and the complete_withdraw signer flag |

### 7.2 One house cron - 9.3 (single tick route, house key as fee payer, 60 s, under 1 h for F4)
Existing pieces: `app/api/cron/vrf-settle/route.ts` (a: settle pass 60-126; old 24 h refund pass 128-187), `app/api/cron/index-events/route.ts` (indexer), `app/api/cron/vault-health/route.ts` (alerts), `app/api/admin/release-stuck-obligations/route.ts` (POST, legacy settle). Relay calls `CRON_TICK_URL` every 60 s with an in-process `cronInflight` guard (realtime/index.ts:516-604) that only prevents overlap per relay instance.

New: one authenticated tick route (e.g. `app/api/cron/tick/route.ts`) that runs every pass on its own cadence under a DB lock (`pg_try_advisory_lock`) or in-process lock; passes in this order:
| pass | spec | today | to change |
|---|---|---|---|
| indexer | (not in 9.3; keep every tick) | cron/index-events GET | call the same function |
| a. VRF settle | settle every program-owned VrfGame with terminal status, referral PDA when referred (F5 mandatory) | vrf-settle:62-126 `game.status === "Playing"` skip; uses `fetchPlayerReferrer` | MUST also skip `Void` (settle_vrf fails 6003 on VOID) and skip games with no claim (F6 optional); referral handling per 7.4 |
| b. F3 force pass (ER) | claims whose game is DLP-owned; force when WON/LOST/VOID and claim >= 150 slots old, or PLAYING, !pending and 300 s since last ER activity or claim >= 4,500 slots old | none | new: scan VrfClaim on L1 (`getProgramAccounts` memcmp `accountDiscriminator("VrfClaim")`), game owner == DLP, read game on ER, send `force_undelegate_vrf` signed by house **on the ER** (2.3). "Last ER activity": e.g. ER `getSignaturesForAddress(gamePda, {limit:1}).blockTime` |
| c. F3 VOID refund | program-owned VrfGame raw status 3 -> house `refund_stalled_vrf` immediately | none (vrf-settle second pass only refunds Playing after 24 h, 145-187) | new |
| c'. never-delegated zero-progress | program-owned VrfGame status 0, safe@77 == 0, pending@79 == 0, claim >= 150 slots -> house `refund_stalled_vrf` | vrf-settle:145 `ABANDON_SLOTS = 216_000` (24 h) | MUST change threshold to 150 slots. The "safeReveals > 0 needs review" branch (169-172) becomes unreachable after the round-2 fix (a delegated-then-undelegated PLAYING game cannot exist) - keep it as an alert |
| d. F2 legacy expire | `getProgramAccounts(dataSize 180, memcmp @41 = 0)`, `slot > start_slot + 300`; refund branch (safe@87 == 0 or mult@88 < 10000) `expire_game` x10/tx; cash branch `[expire_game, settle_game(layout, salt, referrer)]`, delete session row only after confirmation | none | new (always empty on the new program; cheap) |
| e. release-stuck-obligations | same schedule, **pass the referrer** | admin/release-stuck-obligations:186-196 calls `buildSettleGame` WITHOUT `referrer` (skips the referral cut) and deletes the session row right after send, before confirmation (203-208) | MUST add `referrer: await fetchPlayerReferrer(game.player)`; delete only after confirmation |
| f. F4 LP auto-complete | LpPosition `dataSize 121`, pending@56 > 0 (u128), unlock@72 (u64) <= slot <= unlock + 9,000: ONE unsigned `complete_withdraw` per tx; skip positions whose payout < 890,880 lamports into a 0-lamport wallet; log positions past the window | none | new |
| vault-health | alerts | cron/vault-health (15 min via GH today) | call on its own cadence (e.g. every 15th tick) |

`sendHouseTx` (server/solana.ts:116-166) does not wait for confirmation; passes d/e need a confirm step before deleting `game_sessions` rows (pattern in vrf/settle/route.ts:89-103). Keep each tick under 60 s (relay interval) or rely on the lock to skip.

### 7.3 Offsets used by the passes (checked against SDK decoders)
- GameSession (180 B): disc 8 + player 32 -> bump @40, **status @41**, safe_reveals @87, multiplier_bps @88 (FIXES 9.3.d).
- VrfGame: status @8, player 9..41, session_key 41..73, bump @73, mine_count @74, edge 75..77, **safe @77**, reveal_count @78, **pending @79** (vrf.ts:414-436 order).
- LpPosition (121 B): user 8..40, units 40..56, **pending_units 56..72**, **pending_unlock_slot 72..80** (accounts.ts:225-236).

### 7.4 F5 relay hardening - 9.4
- `apps/web/src/server/player.ts:14-33` `fetchPlayerReferrer`: swallows RPC errors (28-30) and caches `null` for 60 s (31). MUST: never cache on error (rethrow or return "unknown"), and on a 6022 (`0x1786`) from `settle_vrf` bust the cache and retry once.
- Callers that build settle txs: app/api/vrf/settle/route.ts:62-63; app/api/cron/vrf-settle/route.ts:81-82; app/api/settle/route.ts:52 (legacy); **app/api/cleanup/route.ts:78-86 (legacy `buildSettleGame` without referrer - same bug as release-stuck)**; admin/release-stuck-obligations (7.2 e).

### 7.5 UI - 9.5
| item | file:line | change |
|---|---|---|
| Void terminal state | hooks/use-vrf-game.ts:365-370 (reveal result), 503, 533, 575 (`refundOnly` requires `status === "Playing"`), 655 (resume) | VOID = "closed for inactivity, bet refunded"; recovery `refundOnly` must accept Void; after the round-2 fix a self-undelegate of a zero-progress game yields VOID, not Playing |
| session-key reveal after a force fails 6003 | hooks/use-vrf-game.ts:323-384 revealTile; friendlyVrfError 56-69 | on 6003 (`0x1773`) re-read the game (it was forced WON/VOID) instead of a generic error; add 6044 (`0x179c` RevealPending) and 6050 (`0x17a2` GameAlreadyResolved) |
| wait helpers | lib/vrf/client.ts:443-449 `waitForCommittedResult` (Won/Lost only), 451-485 comment "a game being refunded stays Playing" | include Void |
| recovery banner | components/game/GameRecoveryBanner.tsx:165-175 (VRF hands off to cleanupStuck), status display | show Void |
| session probe | app/api/session/[player]/route.ts:73-88 (status from ER), 95 `VRF_STALL_SLOTS = 25` | pass through "Void"; refundable immediately |
| VRF settle route | app/api/vrf/settle/route.ts:55 `game.status === "Playing"` | treat Void as 409 "refund instead" (route to refund) |
| LP "completes automatically" | components/vault/lp-panel.tsx:84-92 (cooldownLabel "Ready to claim"), 356-363 (COMPLETE WITHDRAWAL button) | ready state text "completes automatically"; keep the manual button (player-signed path still valid) |
| LP expired state | lp-panel.tsx:84-92, 347-363; hooks/use-vault-lp.ts:64-96 `signAndSend` takes ONE instruction | expired when `slot > unlock + 9,000`; RESTART WITHDRAWAL = `[cancel_withdraw, request_withdraw(same units)]` in ONE tx -> needs a multi-ix `signAndSend` and a route returning both ixs (or build client-side with the SDK, as GameRecoveryBanner does) |
| LP copy | lp-panel.tsx:217, 331, 342 "3-day cooldown" | keep (cooldown unchanged) |
| error messages | apps/web/src/lib/program-errors.ts:12-75 | **pre-existing bug: 6001-6004 are wrong** (map says BetTooLow/InvalidTileIndex/TileAlreadyRevealed/GameNotPlaying; IDL/SDK/Pinocchio order is InvalidTileIndex, TileAlreadyRevealed, GameNotPlaying, BetTooLow) and 6041-6054 are missing. MUST add 6044, 6050, 6053, 6055 NotDeployer, 6056 WithdrawWindowExpired ("Withdrawal window expired - restart the withdrawal"), 6057 LegacyModeDisabled ("Classic mode is retired"). Better: derive names from `KABOOM_ERROR_NAMES` in the SDK |
| F6 optional | lib/vrf/client.ts:227-288 startVrfGame catch path; cron pass a | require the claim before treating a DLP-owned game as started; skip VrfGames with no claim |

### 7.6 Config rules - 9.6
`withdraw_cooldown_slots >= 450,000` (init-v2 default 648,000 ok); `vrf_max_payout_bps` / `max_payout_bps` owner choice. Not code.

---

## 8. Tests and how to run them

Baseline run 2026-11-04 (this inventory, foreground, unchanged tree): **all green**.
| command (from repo root) | result |
|---|---|
| `npm run typecheck --workspace=@playkaboom/shared` | pass |
| `npm run typecheck --workspace=@playkaboom/sdk` | pass |
| `npm run typecheck --workspace=@playkaboom/web` | pass |
| `npm run typecheck --workspace=@playkaboom/realtime` | pass |
| `npm run typecheck --workspace=@playkaboom/sdk-tests` | pass |
| `npm test --workspace=@playkaboom/sdk-tests` (vitest, tests/sdk) | 6 files, 711 tests pass (~0.5 s) |
| `npm run build --workspace=@playkaboom/web` (next build, reads apps/web/.env.local) | pass, ~33 s |
| `npm run build --workspace=@playkaboom/realtime` (tsc -> dist) | not run; typecheck passes |
| all at once | `npm run typecheck && npm test && npm run build` (turbo; what `.github/workflows/ci.yml:22-25` runs) |

- `packages/sdk` has `vitest run --passWithNoTests` but no test files; SDK tests live in `tests/sdk/` (anchor-errors, events-forgery, instructions, multiplier, multiplier-fixture, verify). `tests/sdk/anchor-errors.test.ts:11-27` and `events-forgery.test.ts:18, 41` use the old ID / old vault PDA as fixtures (harmless; update if they assert derived PDAs).
- `tests/anchor` (Anchor client + validator, devnet ID) is not in the turbo pipeline; do not run.
- No tests exist in apps/web or apps/realtime. Pinocchio program tests: `cargo test --manifest-path pinocchio/kaboom-p/Cargo.toml` and `pinocchio/difftest` (see STATUS.md); not part of this migration.
- Local DB for new tests: Postgres 17.11 at `/tmp:5432` (user `pp`); only `kaboom_rw_*` databases may be created/dropped.

---

## 9. Other findings for the lead (FLAG)
1. `apps/realtime/railway.json:12-13` pins 1 replica because the cron guard is in-process; same constraint now applies to the web tick unless a DB lock is used.
2. `server/env.ts:106-108` and `lib/cluster.ts:4-8` default to devnet when env is missing; mainnet-only rule suggests failing instead.
3. VRF mirror rows: `app/api/vrf/settle/route.ts:109` and `cron/vrf-settle:110` compute payout as `bet * mult / 10000`, ignoring the on-chain cap `min(payout, claim.reserved)` (PayoutExceedsReserved path); mirror can overstate a capped payout.
4. `use-global-games.ts:144-146` comment says the relay forwards Supabase's `payload.new` directly; it actually forwards the 12-column projection. `rowToGame` must tolerate missing `mine_layout`/`salt`.
5. `referral-codes.ts:89-95`, `referral-tracking.ts:82-92, 128-140` increment counters by read-modify-write; switch to `SET x = x + 1` while porting (free with raw SQL).
6. `app/api/health/route.ts:21` returns the house pubkey (public; fine). No route returns or logs the secret today; keep it that way in the new signer (no `logger.*({ env })`, no error message containing the raw value - `JSON.parse` / bs58 errors must not echo input).
7. CSP `connect-src` (next.config.mjs:34-70): remove `*.supabase.co` (38-39), keep `*.magicblock.app`, set the relay host (50) to the actual `kaboom-realtime` domain; the web app itself is `'self'`. If the web is served from a `*.up.railway.app` host during testing, nothing else changes.
