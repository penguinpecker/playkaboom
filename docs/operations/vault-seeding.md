# Vault seeding

How much SOL to deposit into the vault before opening to real money, and how
the on-chain caps behave as the vault grows / shrinks.

## The math

The on-chain `start_game` rejects any bet whose worst-case payout exceeds
`available × max_payout_bps × health_bps / BPS²`. With our defaults:

- `max_payout_bps = 5000` (50% of vault per single game's worst case)
- `house_edge_bps = 200` (2%)
- `max_bet_bps = 200` (2% of vault per bet)
- Healthy vault → `health_bps ≈ 10000`

So the *effective* per-game max payout, fully healthy:
**`max_payout = available × 0.50 × 1.00 = 0.50 × available`**.

Translate that into bet size limits using the worst-case multiplier table
(2% house edge applied):

| Mines | Worst-case multiplier | Max bet for V SOL vault |
|---|---|---|
| 1 | 1.067× | `0.5V / 1.067 = 0.469 × V` |
| 3 | 1.345× | `0.372 × V` |
| 5 | 1.792× | `0.279 × V` |
| 7 | 2.604× | `0.192 × V` |
| 9 | 4.473× | `0.112 × V` |
| 11 | 12.250× | `0.0408 × V` |
| 12 | 24.500× | `0.0204 × V` |

The `max_bet_bps` cap (2% of vault) bites first for low mine counts; the
worst-case-payout cap bites for high mine counts.

## Worked seeding scenarios

**Scenario A — soft launch, max bet 0.5 SOL**

Per the table, supporting a 0.5 SOL bet at 12 mines requires
`0.5 / 0.0204 = 24.5 SOL` in the vault. Round up to a clean **30 SOL**
seed for headroom and to absorb early variance. With this seeding:

- Per-bet variance: a 0.5 SOL bet at 12 mines that wins = -12.25 SOL on the vault. Variance is high but bounded — health drops from ~100% to (30 - 12.25) / 30 ≈ 59%. Still above the 50% warn threshold.
- After 100 bets averaging 0.1 SOL with 4 mines, expected vault profit:
  100 × 0.1 × 0.02 = 0.2 SOL ≈ 0.7% growth.

**Scenario B — public launch, max bet 5 SOL**

Need `5 / 0.0204 = 245 SOL` to cover 5 SOL bets at 12 mines. Round to
**300 SOL** for headroom. A single 5 SOL × 12-mine win = -122.5 SOL,
dropping health to (300 - 122.5) / 300 ≈ 59%. Still healthy.

**Scenario C — whale-friendly, max bet 50 SOL**

Need ~2,500 SOL. This is where you start considering an LP campaign to
let depositors fund the bulk and earn yield, instead of seeding from
treasury alone.

## How the LP vault changes the math

Once LP depositors join, *their* deposits also count toward `available`,
so the vault grows organically. But pending withdrawals also count
toward obligations (`pending_value` in `calc_health_bps`), so:

```
available    = vault_lamports - rent
pending_value = total_pending_units × available / total_units
obligations  = total_outstanding_max_payout + pending_value
free         = available - obligations
health_bps   = free × BPS / available
```

A vault holding 200 SOL with 30 SOL of pending withdrawals + 50 SOL of
in-flight game obligations:
- obligations = 80 SOL
- free = 120 SOL
- health = 60% — above warn, below 100. Fine, but means new bets are
  capped at `120 × 0.50 = 60 SOL` worst-case payout.

**Implication**: as pending withdrawals accumulate, the vault's effective
betting capacity shrinks. The 3-day cooldown is the only thing
preventing this from cascading — without it, a coordinated withdrawal
attack (whale withdraws to make max bets shrink, plays at the lower cap,
profits, repeats) would be feasible.

## Operational thresholds (matches the alert webhook)

The vault-health cron at `/api/cron/vault-health` (runs every 15 min)
will fire alerts at:

- **Critical**: `health_bps < 2000` (20%) — new bets will start to error 6006. Top up immediately.
- **Critical**: `vault.paused == true` — someone toggled the kill-switch. Investigate before unpausing.
- **Warn**: `health_bps < 5000` (50%) — vault is over-leveraged. Plan a top-up; bigger bets are getting rejected.
- **Warn**: `lamports < rent_floor + 1 SOL` — vault is empty. Critical if not seeded urgently.

Configure `ALERT_WEBHOOK_URL` (Slack/Discord/PagerDuty) in Vercel env so
these page someone on-call. `ALERT_WEBHOOK_FORMAT` controls payload
shape: `slack` / `discord` / `raw`.

## Pre-launch checklist

```
[ ] Decide max-bet ceiling for launch day (Scenario A / B / C above)
[ ] Compute required SOL with 1.2× safety margin
[ ] Source SOL → wallet you control → call `deposit_to_vault` (or just
    SystemTransfer to vault PDA — same effect since the vault accepts
    direct deposits)
[ ] Verify vault balance via `solana balance <vault_pda>` matches plan
[ ] Verify health via /api/cron/vault-health → expect 100% pre-launch
[ ] Set ALERT_WEBHOOK_URL + ALERT_WEBHOOK_FORMAT in Vercel
[ ] Trigger one test alert: `curl -H "Authorization: Bearer $CRON_SECRET" $URL/api/cron/vault-health` after manually setting health_bps low (or just `vault.paused = true`)
[ ] Confirm GH Actions vault-health workflow runs every 15 min
```
