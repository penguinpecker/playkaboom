# PlayKaboom — Production Roadmap

Authoritative source of truth for what is shipping, when, and why. Keep this current with every meaningful design decision.

## North star

A provably-fair on-chain Mines casino on Solana. Player money is on-chain. UX is wallet-less from the player's POV (Privy embedded). House cannot cheat (commit-reveal + on-chain VRF). Every game is independently verifiable.

## Milestones

| Phase | Cluster | Gate |
|---|---|---|
| P1 — Devnet alpha | Devnet | Internal testing, full game flow, on-chain stats + referrals |
| P2 — Mainnet closed beta | Mainnet | ORAO VRF live, indexer running, hot-wallet KMS, status page |
| P3 — Mainnet GA | Mainnet | PWA, Pyth USD overlay, full leaderboard, growth loops |

## Locked decisions (2026-05-05)

| # | Decision |
|---|---|
| 1 | Domain: `playkaboom.gg` |
| 2 | Game roster: Mines only |
| 3 | Geo-block: none — accepted risk, documented in SECURITY.md |
| 4 | Multisig: 2-of-2 Squads, both `owner` and `treasury` |
| 5 | Audits: skipped before mainnet — accepted risk, mitigated with on-chain bet caps + bug bounty |
| 6 | VRF: Switchboard On-Demand (TEE-attested, on-chain submission) |
| 7 | Treasury split: 50% to treasury, 50% retained as vault liquidity — editable + withdrawal allowlist |
| 8 | Stats + leaderboard: PlayerStats PDA on-chain (truth) + Helius webhook → Supabase (fast queries) |
| 9 | Referrals: 25/30/35% of house edge, on-chain accrual, manual claim |
| 10 | Hosting: Vercel (frontend + API) + Supabase (Postgres) — no Railway |

## Tech stack

| Layer | Pick |
|---|---|
| Runtime | Node 20, Next.js 15, React 19 |
| Auth | Privy (embedded wallets + social login) |
| RPC primary | Helius Professional |
| RPC fallback | Triton One |
| VRF | Switchboard On-Demand |
| Indexer | Helius Webhooks → Supabase Postgres |
| DB | Supabase Postgres |
| Cache / RL | Upstash Redis |
| Queue | Upstash QStash |
| Email | Resend |
| Errors | Sentry |
| Uptime | Better Stack |
| Hosting | Vercel Pro |
| Multisig | Squads |
| Bug bounty | Immunefi |

## Approximate run-rate at GA

| Item | Monthly |
|---|---|
| Helius Professional | $99 |
| Triton fallback | $50 |
| Vercel Pro | $20 |
| Supabase Pro | $25 |
| Upstash Redis + QStash | $20 |
| Better Stack | $24 |
| Resend | $20 |
| Sentry team | $26 |
| Total | $284 |

One-time: bug-bounty starter pool ($10–50k), Squads setup (free), domain ($30/yr).

## Open follow-ups

- Confirm bug-bounty pool size and Immunefi listing timing
- Decide whether to add Discord/Telegram big-win bots before P3
- Decide whether to add USDC support in P3 or P3+
