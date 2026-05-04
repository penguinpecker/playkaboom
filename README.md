# PlayKaboom

Production-grade provably-fair Mines on Solana. Same UI as the original `kaboom-solana`, rebuilt with a Stake-style architecture.

## Architecture

```
playkaboom/
├── apps/
│   └── web/                    Next.js 15 app (UI + API routes / house server)
├── programs/
│   └── kaboom/                 Anchor program (Rust)
├── packages/
│   ├── sdk/                    Typed client SDK (IDL-based, no hand-rolled discriminators)
│   └── shared/                 Constants + zod schemas shared between web and tests
├── tests/
│   ├── anchor/                 Anchor program integration tests
│   ├── sdk/                    Vitest unit tests for the SDK
│   └── e2e/                    Playwright end-to-end tests
├── Anchor.toml
├── Cargo.toml
└── turbo.json
```

## Why a rewrite

The original `kaboom-solana` is a fine MVP, but for production these are upgraded:

| Area | Original | PlayKaboom |
|---|---|---|
| Hash function | Code: SHA-256, docs: keccak256 (mismatch) | SHA-256 throughout, verifier matches |
| Cluster | Hardcoded "Mainnet" copy on devnet deploy | `NEXT_PUBLIC_SOLANA_CLUSTER` env-driven |
| AES key | Reuses ed25519 seed bytes | Dedicated `SESSION_ENC_KEY` (32 random bytes) |
| Instruction builders | Hand-rolled discriminators | IDL-derived via Anchor + a thin SDK package |
| State | useState + refs | Zustand store + TanStack Query for chain data |
| API validation | Loose | Zod schemas, structured pino logs |
| Rate limiting | None | Upstash sliding-window per-IP + per-wallet |
| Tests | One PDA-existence smoke test | Full Anchor flow tests, SDK unit, E2E |
| Leaderboard | Per-device localStorage | On-chain account scan + indexer hook |
| RPC | Single endpoint | Primary + fallback + connection pooling |
| Observability | console.log | Pino + Sentry (server) + browser Sentry |
| Game token | One source of truth | Versioned (`v1:` prefix), rotatable, tied to player+slot |

## Getting started

### Prereqs

- Node 20+ (`nvm use`)
- Rust + Solana CLI + Anchor (only needed to build the program)
  - `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
  - `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`
  - `cargo install --git https://github.com/coral-xyz/anchor avm --locked && avm install latest && avm use latest`

### Install + run web app

```bash
npm install
cp .env.example .env.local           # fill in HOUSE_AUTHORITY_KEY + SESSION_ENC_KEY
npm run dev
```

### Build + deploy program

```bash
npm run anchor:build
npm run anchor:deploy:devnet
```

### Tests

```bash
npm run test                          # all packages
npm run anchor:test                   # program integration tests against devnet
```

## Security model

See [`SECURITY.md`](./SECURITY.md). Highlights:

- Server-assisted commit-reveal (mine layout never on-chain during play)
- SHA-256 commitment binding `mine_layout || mine_count || salt`
- Settlement verifies every reveal against the committed layout — server cannot lie
- 300-slot expiry gives the player a refund if the house disappears
- Owner / house-authority / treasury are three separate keys
- Withdraws are timelocked to a 24-hour delay (not in MVP — flagged in roadmap)

## Roadmap

- [ ] Switchboard On-Demand VRF as the salt source (currently `randomBytes`)
- [ ] Treasury withdrawal timelock
- [ ] Helius webhook → Postgres index for global leaderboard
- [ ] WebSocket account subscriptions for live vault stats
- [ ] Responsible-gambling self-exclusion list
- [ ] Multi-tenant support (multiple vaults)

## License

MIT
