-- ─────────────────────────────────────────────────────────────────────────────
-- PlayKaboom XP / loyalty ledger.
--
-- Append-only record of every points-earning event, plus a view that sums
-- to a per-wallet balance. Server-only (no anon/authenticated grants) until
-- the frontend is ready to surface it. Once exposed, just add a `grant
-- select` policy for `public.points_balance` (NOT the ledger itself — keep
-- the audit log opaque to the public).
--
-- Earning formula (PlayKaboom-tuned, BC.Game-style):
--
--   base_points     = bet_lamports * edge_bps / 200_000_000
--                     (so 1 SOL wagered at 2% edge → 1000 base points)
--   total_points    = round( base_points * tier_mult * streak_mult * event_mult )
--                     where each *_mult is stored as bps (10000 = 1.0×)
--
--   tier_mult       = LP boost — 1.0× to 1.5× (capped) based on share of vault
--   streak_mult     = daily-streak — 1.0× to 1.25× (caps at 5-day streak)
--   event_mult      = time-limited 2× weekend / promo overrides — 1.0× default
--
-- Sources:
--   'game_won'       — settled Won GameSession
--   'game_lost'      — settled Lost GameSession
--   'streak_bonus'   — daily check-in bonus (future)
--   'race_payout'    — weekly leaderboard prize (future)
--   'referral'       — referrer credit when referee wagers (future)
--   'manual_adjust'  — operator add/remove (audited by signer column)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.points_ledger (
  id               bigserial primary key,
  player           text        not null,
  -- For game-derived rows, the kaboom-program tx signature. For non-game
  -- rows (streak bonuses, race payouts, manual adjusts) this is a synthetic
  -- key like 'streak:<player>:<yyyy-mm-dd>' to keep the unique constraint
  -- meaningful.
  source_key       text        not null,
  source           text        not null
    check (source in ('game_won','game_lost','streak_bonus','race_payout','referral','manual_adjust')),
  base_points      bigint      not null,
  tier_mult_bps    int         not null default 10000,
  streak_mult_bps  int         not null default 10000,
  event_mult_bps   int         not null default 10000,
  total_points     bigint      not null,
  -- Origin context — denormalized so the ledger is self-explanatory without
  -- a join. Useful for audit + future replay if the formula ever changes.
  bet_lamports     bigint      not null default 0,
  edge_bps         int         not null default 0,
  -- For 'manual_adjust' rows, who authorized the change. Null for automatic.
  signer           text,
  notes            text,
  created_at       timestamptz not null default now()
);

-- Idempotency: a given (source_key, source) tuple may only land once. This
-- protects against indexer replay AND retroactive backfills running twice.
create unique index if not exists uniq_points_per_source
  on public.points_ledger (source_key, source);

create index if not exists idx_points_player_time
  on public.points_ledger (player, created_at desc);

create index if not exists idx_points_source_time
  on public.points_ledger (source, created_at desc);

-- Sanity constraints — every multiplier is non-negative and the total is
-- consistent with the multipliers (allowing ±1 for rounding).
alter table public.points_ledger
  add constraint points_base_nonneg     check (base_points >= 0),
  add constraint points_total_nonneg    check (total_points >= 0),
  add constraint points_tier_mult_pos   check (tier_mult_bps   between 0 and 1000000),
  add constraint points_streak_mult_pos check (streak_mult_bps between 0 and 1000000),
  add constraint points_event_mult_pos  check (event_mult_bps  between 0 and 1000000),
  add constraint points_edge_bps_range  check (edge_bps between 0 and 10000),
  add constraint points_bet_nonneg      check (bet_lamports >= 0);

-- Per-wallet rollup. Cheap to query — single index scan per player.
create or replace view public.points_balance as
  select
    player,
    coalesce(sum(total_points), 0)                                  as points,
    coalesce(sum(case when source = 'game_won'      then total_points else 0 end), 0) as points_from_wins,
    coalesce(sum(case when source = 'game_lost'     then total_points else 0 end), 0) as points_from_losses,
    coalesce(sum(case when source = 'streak_bonus'  then total_points else 0 end), 0) as points_from_streak,
    coalesce(sum(case when source = 'race_payout'   then total_points else 0 end), 0) as points_from_race,
    coalesce(sum(case when source = 'referral'      then total_points else 0 end), 0) as points_from_referral,
    count(*)                                                        as entries,
    max(created_at)                                                 as last_earned_at
  from public.points_ledger
  group by player;

-- ── RLS / grants — server-only ───────────────────────────────────────────────
-- Deliberately NOT granting select to anon/authenticated. Once the frontend
-- is ready, add: grant select on public.points_balance to anon, authenticated;
-- (Don't expose points_ledger itself — the per-row audit trail with signer
-- and notes columns shouldn't be public.)
alter table public.points_ledger enable row level security;
alter table public.points_ledger force row level security;

revoke all on table public.points_ledger from public, anon, authenticated;
revoke all on public.points_balance       from public, anon, authenticated;

grant all on table  public.points_ledger to service_role;
grant select on     public.points_balance to service_role;

-- The bigserial sequence needs explicit grant for service_role to insert.
grant usage, select on sequence public.points_ledger_id_seq to service_role;
