-- Security hardening pass: constraints, triggers, RLS lockdown, role grants.

-- ── 1. CHECK constraints on data integrity ───────────────────────────────────
-- All values mirror program-side bounds. The program is the source of truth
-- but the index should never be able to store anything the program rejects.

alter table public.player_stats
  add constraint player_stats_games_played_nonneg check (games_played >= 0),
  add constraint player_stats_games_won_le_played check (games_won <= games_played),
  add constraint player_stats_total_wagered_nonneg check (total_wagered >= 0),
  add constraint player_stats_total_payouts_nonneg check (total_payouts >= 0),
  add constraint player_stats_biggest_win_nonneg check (biggest_win >= 0),
  add constraint player_stats_streak_nonneg check (current_streak >= 0 and best_streak >= 0),
  add constraint player_stats_mult_min check (biggest_multiplier_bps = 0 or biggest_multiplier_bps >= 10000);

alter table public.games
  add constraint games_bet_positive check (bet > 0),
  add constraint games_mine_count_range check (mine_count between 1 and 12),
  add constraint games_safe_reveals_range check (safe_reveals between 0 and 16),
  add constraint games_payout_nonneg check (payout >= 0),
  add constraint games_mult_range check (multiplier_bps >= 10000 or multiplier_bps = 0),
  add constraint games_layout_range check (mine_layout is null or (mine_layout >= 0 and mine_layout <= 65535)),
  add constraint games_commitment_hex_64 check (commitment ~ '^[0-9a-f]{64}$'),
  add constraint games_signature_len check (length(signature) between 64 and 96),
  add constraint games_slot_nonneg check (slot >= 0);

alter table public.referrals
  add constraint referrals_tier_range check (tier between 0 and 2),
  add constraint referrals_accrued_nonneg check (accrued_lamports >= 0),
  add constraint referrals_total_nonneg check (total_earned >= 0),
  add constraint referrals_count_nonneg check (referred_count >= 0),
  add constraint referrals_volume_nonneg check (referred_volume >= 0);

alter table public.referral_events
  add constraint ref_events_amount_nonneg check (amount >= 0),
  add constraint ref_events_tier_range check (tier between 0 and 2),
  add constraint ref_events_signature_len check (length(signature) between 64 and 96),
  add constraint ref_events_slot_nonneg check (slot >= 0);

-- ── 2. updated_at auto-touch trigger ─────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.touch_updated_at() from public;

drop trigger if exists touch_player_stats on public.player_stats;
create trigger touch_player_stats
  before update on public.player_stats
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_referrals on public.referrals;
create trigger touch_referrals
  before update on public.referrals
  for each row execute function public.touch_updated_at();

-- ── 3. RLS lockdown ──────────────────────────────────────────────────────────
-- processed_events is internal — drop public read access.
drop policy if exists "read all" on public.processed_events;

-- Force RLS for owners (no escape hatch via table owner).
alter table public.player_stats     force row level security;
alter table public.games            force row level security;
alter table public.referrals        force row level security;
alter table public.referral_events  force row level security;
alter table public.processed_events force row level security;

-- Explicit role permissions: anon and authenticated can read public tables;
-- only service_role can write (enforced by RLS + grant absence).
revoke all on table public.player_stats     from public, anon, authenticated;
revoke all on table public.games            from public, anon, authenticated;
revoke all on table public.referrals        from public, anon, authenticated;
revoke all on table public.referral_events  from public, anon, authenticated;
revoke all on table public.processed_events from public, anon, authenticated;

grant select on table public.player_stats    to anon, authenticated;
grant select on table public.games           to anon, authenticated;
grant select on table public.referrals       to anon, authenticated;
grant select on table public.referral_events to anon, authenticated;
-- processed_events: no anon/authenticated access at all (service_role only).

grant all on table public.player_stats     to service_role;
grant all on table public.games            to service_role;
grant all on table public.referrals        to service_role;
grant all on table public.referral_events  to service_role;
grant all on table public.processed_events to service_role;

-- View permissions
revoke all on public.leaderboard_alltime from public, anon, authenticated;
revoke all on public.leaderboard_volume  from public, anon, authenticated;
grant select on public.leaderboard_alltime to anon, authenticated, service_role;
grant select on public.leaderboard_volume  to anon, authenticated, service_role;

-- ── 4. Helper view: top players by best streak (for ranking variants) ────────
create or replace view public.leaderboard_streaks as
select
  player,
  best_streak,
  current_streak,
  games_played,
  games_won,
  last_played
from public.player_stats
where best_streak > 0
order by best_streak desc, last_played desc;

grant select on public.leaderboard_streaks to anon, authenticated, service_role;

-- ── 5. Audit-friendly default: reject INSERT into views ──────────────────────
-- (Postgres 15+: views are read-only by default unless rules added.)

-- ── 6. Tighten search_path for function safety ───────────────────────────────
-- Already applied to touch_updated_at(). No other functions for now.

-- ── 7. Comments — document table semantics for future operators ──────────────
comment on table public.player_stats is
  'Indexed mirror of on-chain PlayerStats PDA. Public read; updated by indexer (service_role).';
comment on table public.games is
  'One row per settled game tx. Public read; immutable once written.';
comment on table public.referrals is
  'Indexed mirror of on-chain ReferralAccount PDA. Public read; updated by indexer.';
comment on table public.referral_events is
  'Per-credit event log. Public read for transparency.';
comment on table public.processed_events is
  'Webhook idempotency ledger. Service role only.';
