-- Postgres NOTIFY triggers for the Railway-hosted live-feed relay.
--
-- The relay (`apps/realtime/`) holds a long-lived LISTEN connection on
-- channels `game_settled` and `lp_action`. Inserts into the underlying
-- tables fire pg_notify() with a JSON payload, which the relay parses
-- and broadcasts over WebSocket to every connected playkaboom.gg
-- browser client. This is the primary push path; Supabase Realtime
-- (added in 20260509000001) is a fallback, and 60s polling is the
-- last-resort safety net inside the web client.
--
-- Why a separate notify channel rather than reusing supabase_realtime:
-- the Railway relay can serve every client off ONE Postgres connection
-- regardless of viewer count, while Supabase Realtime burns one
-- connection per client (200-cap on free tier). At scale the relay is
-- the cheaper path; before scale, both running in parallel = belt-and-
-- suspenders with idempotent client-side dedup on `signature`.

-- ── games table ──────────────────────────────────────────────────────
create or replace function public.notify_game_settled() returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  perform pg_notify(
    'game_settled',
    json_build_object(
      'signature', NEW.signature,
      'player', NEW.player,
      'outcome', NEW.outcome,
      'bet', NEW.bet::text,
      'payout', NEW.payout::text,
      'multiplier_bps', NEW.multiplier_bps,
      'mine_count', NEW.mine_count,
      'settled_at', NEW.settled_at,
      'slot', NEW.slot
    )::text
  );
  return NEW;
end;
$$;

drop trigger if exists games_notify_settled on public.games;
create trigger games_notify_settled
  after insert on public.games
  for each row execute function public.notify_game_settled();

-- ── lp_actions table ─────────────────────────────────────────────────
create or replace function public.notify_lp_action() returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  perform pg_notify(
    'lp_action',
    json_build_object(
      'signature', NEW.signature,
      'user_address', NEW.user_address,
      'action', NEW.action,
      'lamports_delta', NEW.lamports_delta::text,
      'units_delta', NEW.units_delta::text,
      'slot', NEW.slot,
      'created_at', NEW.created_at
    )::text
  );
  return NEW;
end;
$$;

drop trigger if exists lp_actions_notify on public.lp_actions;
create trigger lp_actions_notify
  after insert on public.lp_actions
  for each row execute function public.notify_lp_action();
