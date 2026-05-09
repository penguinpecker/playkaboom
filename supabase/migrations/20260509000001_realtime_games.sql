-- Enable Supabase Realtime broadcasts for the games table so the /logs
-- and /play live feeds get instant push updates instead of relying on
-- 8-second polling that mobile-tab background suspension stalls.
--
-- Mechanism: Supabase Realtime listens to a Postgres logical replication
-- publication called `supabase_realtime`. Adding a table to it makes
-- INSERT/UPDATE/DELETE events on that table fan out via WebSocket to
-- subscribed clients. Replica identity full ships the full row payload
-- (vs only changed cols) so the client doesn't need a follow-up SELECT.
--
-- Cost: free-tier Realtime supports 200 concurrent connections + 5M
-- messages/month. PlayKaboom's current scale (2 mainnet players) sits
-- at ~1% of either ceiling.

alter publication supabase_realtime add table public.games;
alter table public.games replica identity full;

-- Same treatment for lp_actions so vault deposits/withdrawals appear
-- live on the /vault LP panel without a refresh.
alter publication supabase_realtime add table public.lp_actions;
alter table public.lp_actions replica identity full;
