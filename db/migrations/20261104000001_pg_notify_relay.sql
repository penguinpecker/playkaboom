-- Railway-only (new): replaces Supabase Realtime for the live-feed relay.
--
-- apps/realtime used to subscribe to postgres_changes INSERT + UPDATE on
-- public.games and fan each row out over WebSocket. Here a trigger sends the
-- same change on ONE notify channel; the relay LISTENs with 'pg'.
--
-- Channel: kaboom_events
-- Payload: {"table": "games", "op": "INSERT" | "UPDATE", "row": {...}}
--
-- "row" carries only the closed allowlist the relay already forwards
-- (apps/realtime/src/index.ts pickSafeCols). The fairness pre-image
-- (mine_layout, settled_layout, salt, commitment) is deliberately NOT in the
-- payload, so a LISTENing session never sees it. Contract documented in
-- pinocchio/MIGRATION/schema.md.
--
-- NOTIFY is delivered on COMMIT only; identical payloads inside one
-- transaction are collapsed by Postgres. Payload limit is 8000 bytes; this
-- row is ~600 bytes worst case.

CREATE OR REPLACE FUNCTION public.notify_relay_games()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_notify('kaboom_events', json_build_object(
    'table', TG_TABLE_NAME,
    'op',    TG_OP,
    'row',   json_build_object(
      'signature',        NEW.signature,
      'game',             NEW.game,
      'player',           NEW.player,
      'bet',              NEW.bet,
      'outcome',          NEW.outcome,
      'payout',           NEW.payout,
      'multiplier_bps',   NEW.multiplier_bps,
      'safe_reveals',     NEW.safe_reveals,
      'mine_count',       NEW.mine_count,
      'settled_at',       NEW.settled_at,
      'settle_signature', NEW.settle_signature,
      'slot',             NEW.slot
    )
  )::text);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_relay_games() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_games_notify_relay ON public.games;
CREATE TRIGGER trg_games_notify_relay
  AFTER INSERT OR UPDATE ON public.games
  FOR EACH ROW EXECUTE FUNCTION public.notify_relay_games();
