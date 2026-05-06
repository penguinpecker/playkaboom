-- Phase 2 LP vault indexer schema. Mirrors on-chain VaultV2State + LpPosition
-- accounts. Rows are written by the Helius webhook receiver in response to
-- LpDeposited / LpWithdrawRequested / LpWithdrawCancelled / LpWithdrawCompleted
-- / VaultUnitValueUpdated / HouseDeposited / HouseWithdraw* events.

-- ── Per-user (and one __house__ sentinel) LP position snapshot ──────────────
create table if not exists public.lp_positions (
  -- Wallet base58, or the literal string '__house__' for the house's own
  -- position. The public API filters out the sentinel; it's tracked here for
  -- internal accounting only.
  user_address          text        primary key,
  units                 numeric     not null default 0,   -- u128 stored as numeric
  pending_units         numeric     not null default 0,
  pending_unlock_slot   bigint      not null default 0,
  -- Cumulative sums of historical lamports in/out, for "deposited" UI metric
  -- and P&L computation. Populated by lp_actions trigger / webhook.
  cumulative_deposited  bigint      not null default 0,
  cumulative_withdrawn  bigint      not null default 0,
  first_action_at       timestamptz,
  last_action_at        timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint lp_positions_units_nonneg     check (units         >= 0),
  constraint lp_positions_pending_nonneg   check (pending_units >= 0)
);

create index if not exists idx_lp_positions_units      on public.lp_positions (units desc);
create index if not exists idx_lp_positions_last_action on public.lp_positions (last_action_at desc);

-- ── Per-action append-only log ──────────────────────────────────────────────
create table if not exists public.lp_actions (
  signature        text        primary key,
  user_address     text        not null,
  action           text        not null check (action in (
    'deposit', 'request_withdraw', 'cancel_withdraw', 'complete_withdraw',
    'house_deposit', 'house_request_withdraw', 'house_cancel_withdraw', 'house_complete_withdraw'
  )),
  units_delta      numeric     not null,    -- signed; units minted (+) or burned (-)
  lamports_delta   bigint      not null,    -- signed; SOL in (+) or out (-)
  unit_value_lamports numeric  not null,    -- spot unit_value at action time (lamports per unit, with 18-decimal scale)
  slot             bigint      not null,
  block_time       timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists idx_lp_actions_user_time on public.lp_actions (user_address, block_time desc);
create index if not exists idx_lp_actions_action    on public.lp_actions (action);
create index if not exists idx_lp_actions_slot      on public.lp_actions (slot);

-- ── Vault unit_value time-series for APY computation ────────────────────────
-- Emitted on every settle_game. Indexer appends; APY is `(uv[now]/uv[now-30d])^(365/30)-1`.
create table if not exists public.vault_unit_value_history (
  slot              bigint      primary key,
  vault_assets      bigint      not null,    -- lamports
  total_units       numeric     not null,
  unit_value_e18    numeric     not null,    -- vault_assets * 1e18 / total_units, integer for stable arithmetic
  health_bps        int         not null,
  block_time        timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists idx_vault_uv_block_time on public.vault_unit_value_history (block_time desc);

-- RLS: public read, service-role-only writes (matches existing pattern).
alter table public.lp_positions             enable row level security;
alter table public.lp_actions               enable row level security;
alter table public.vault_unit_value_history enable row level security;

create policy "lp_positions_public_read"
  on public.lp_positions for select to anon, authenticated using (true);
create policy "lp_actions_public_read"
  on public.lp_actions for select to anon, authenticated using (true);
create policy "vault_uv_public_read"
  on public.vault_unit_value_history for select to anon, authenticated using (true);

-- Service role only writes
revoke all on public.lp_positions             from anon, authenticated;
revoke all on public.lp_actions               from anon, authenticated;
revoke all on public.vault_unit_value_history from anon, authenticated;
grant select on public.lp_positions             to anon, authenticated;
grant select on public.lp_actions               to anon, authenticated;
grant select on public.vault_unit_value_history to anon, authenticated;
grant all    on public.lp_positions             to service_role;
grant all    on public.lp_actions               to service_role;
grant all    on public.vault_unit_value_history to service_role;

-- updated_at trigger for lp_positions (matches existing pattern in 20260505000002_security.sql)
create trigger trg_lp_positions_updated_at
  before update on public.lp_positions
  for each row execute function public.touch_updated_at();
