-- 2026-11-05 — K Points for LP providers (owner): K_POINTS_LP_PER_SOL_HOUR (default
-- 10) K Points per SOL of LP value per hour, credited every UTC hour by the cron
-- pass apps/web/src/server/cron/lp-points-pass.ts. Re-runnable.
--
-- 1. lp_points_accrual: one row per LP position (its PDA is [kaboom_lp, owner], so
--    per owner). accrued_e15 is the lifetime accrual in 1e-15 K Points (lamports x
--    rate in millionths), exact, so fractions carry from hour to hour; the points
--    already credited are floor(accrued_e15 / 1e15). last_hour is the UTC hour last
--    credited: the once-per-hour guard.
-- 2. points_ledger.source gains 'lp_hourly'. The original check is an unnamed column
--    constraint, so whichever check covers the source column is found by catalog.

CREATE TABLE IF NOT EXISTS public.lp_points_accrual (
  owner        text        PRIMARY KEY,
  accrued_e15  numeric     NOT NULL DEFAULT 0 CHECK (accrued_e15 >= 0),
  last_hour    timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE public.lp_points_accrual FROM PUBLIC;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE con.conrelid = 'public.points_ledger'::regclass AND con.contype = 'c' AND att.attname = 'source'
  LOOP
    EXECUTE format('ALTER TABLE public.points_ledger DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.points_ledger ADD CONSTRAINT points_ledger_source_check
  CHECK (source IN ('game_won','game_lost','streak_bonus','race_payout','referral','manual_adjust','lp_hourly'));
