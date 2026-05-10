-- Add `biggest_loss` to leaderboard_alltime so the UI can show the largest
-- single losing bet per player instead of the (less informative)
-- biggest_multiplier_bps. Computed on-the-fly from the games table — no new
-- column on player_stats, no indexer change required.
--
-- The subquery is bounded by an existing per-player index pattern; for
-- typical top-leaderboard counts (~50 rows × O(games-per-player)) this is
-- cheap. Add a (player, outcome) index to keep it that way as the games
-- table grows.

create index if not exists idx_games_player_outcome
  on public.games (player, outcome);

create or replace view public.leaderboard_alltime as
select
  ps.player,
  ps.games_played,
  ps.games_won,
  case when ps.games_played > 0
    then round((ps.games_won::numeric * 10000 / ps.games_played))::int
    else 0
  end as win_rate_bps,
  ps.total_wagered,
  ps.total_payouts,
  ps.biggest_win,
  ps.biggest_multiplier_bps,
  coalesce(bl.biggest_loss, 0)::bigint as biggest_loss,
  ps.best_streak,
  ps.current_streak,
  ps.last_played
from public.player_stats ps
left join (
  select player, max(bet) as biggest_loss
  from public.games
  where outcome = 'lost'
  group by player
) bl on bl.player = ps.player
order by ps.biggest_win desc;

-- Re-grant: create or replace view preserves grants in Postgres but be
-- explicit so a fresh deploy from scratch matches the security migration.
grant select on public.leaderboard_alltime to anon, authenticated;
