-- PlayKaboom indexer schema.
-- Source of truth is on-chain. These tables are an indexed cache populated by
-- the Helius webhook listener. Anyone can rebuild them by replaying program
-- events from any Solana RPC.

-- ── Player stats (mirrors on-chain PlayerStats PDA) ──────────────────────────
create table if not exists public.player_stats (
  player                  text        primary key,
  games_played            bigint      not null default 0,
  games_won               bigint      not null default 0,
  total_wagered           bigint      not null default 0, -- lamports
  total_payouts           bigint      not null default 0, -- lamports
  biggest_win             bigint      not null default 0, -- lamports (net)
  biggest_multiplier_bps  bigint      not null default 0,
  current_streak          int         not null default 0,
  best_streak             int         not null default 0,
  last_played             timestamptz,
  referrer                text,
  updated_at              timestamptz not null default now()
);

create index if not exists idx_player_stats_biggest_win
  on public.player_stats (biggest_win desc);
create index if not exists idx_player_stats_total_wagered
  on public.player_stats (total_wagered desc);
create index if not exists idx_player_stats_best_streak
  on public.player_stats (best_streak desc);
create index if not exists idx_player_stats_referrer
  on public.player_stats (referrer);

-- ── Per-game record ──────────────────────────────────────────────────────────
create table if not exists public.games (
  signature       text        primary key,
  player          text        not null,
  bet             bigint      not null,
  mine_count      int         not null,
  outcome         text        not null check (outcome in ('won','lost','expired')),
  payout          bigint      not null default 0,
  multiplier_bps  bigint      not null default 0,
  safe_reveals    int         not null default 0,
  mine_layout     int,
  commitment      text        not null,
  settled_at      timestamptz not null default now(),
  slot            bigint      not null
);

create index if not exists idx_games_player_time
  on public.games (player, settled_at desc);
create index if not exists idx_games_settled_at
  on public.games (settled_at desc);

-- ── Referral aggregates (mirrors on-chain ReferralAccount PDA) ───────────────
create table if not exists public.referrals (
  referrer          text        primary key,
  tier              int         not null default 0,
  accrued_lamports  bigint      not null default 0,
  total_earned      bigint      not null default 0,
  referred_count    int         not null default 0,
  referred_volume   bigint      not null default 0, -- sum of friends' wagers
  updated_at        timestamptz not null default now()
);

create index if not exists idx_referrals_total_earned
  on public.referrals (total_earned desc);

-- ── Per-credit event log ─────────────────────────────────────────────────────
create table if not exists public.referral_events (
  signature   text        primary key,
  referrer    text        not null,
  player      text        not null,
  amount      bigint      not null,
  tier        int         not null,
  occurred_at timestamptz not null default now(),
  slot        bigint      not null
);

create index if not exists idx_ref_events_referrer
  on public.referral_events (referrer, occurred_at desc);
create index if not exists idx_ref_events_player
  on public.referral_events (player, occurred_at desc);

-- ── Webhook deduplication ────────────────────────────────────────────────────
-- One row per processed signature. Lets the webhook handler be idempotent.
create table if not exists public.processed_events (
  signature   text        primary key,
  ix_kind     text        not null,
  processed_at timestamptz not null default now()
);

-- ── Row-level security ───────────────────────────────────────────────────────
-- Public read for everyone, server-only writes via service_role.
alter table public.player_stats     enable row level security;
alter table public.games            enable row level security;
alter table public.referrals        enable row level security;
alter table public.referral_events  enable row level security;
alter table public.processed_events enable row level security;

-- Anonymous read access (these mirror public on-chain data anyway).
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='player_stats' and policyname='read all') then
    create policy "read all" on public.player_stats for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='games' and policyname='read all') then
    create policy "read all" on public.games for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='referrals' and policyname='read all') then
    create policy "read all" on public.referrals for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='referral_events' and policyname='read all') then
    create policy "read all" on public.referral_events for select using (true);
  end if;
end$$;

-- ── Leaderboard view ─────────────────────────────────────────────────────────
create or replace view public.leaderboard_alltime as
select
  player,
  games_played,
  games_won,
  case when games_played > 0
    then round((games_won::numeric * 10000 / games_played))::int
    else 0
  end as win_rate_bps,
  total_wagered,
  total_payouts,
  biggest_win,
  biggest_multiplier_bps,
  best_streak,
  current_streak,
  last_played
from public.player_stats
order by biggest_win desc;

create or replace view public.leaderboard_volume as
select
  player,
  total_wagered,
  total_payouts,
  games_played,
  last_played
from public.player_stats
order by total_wagered desc;
