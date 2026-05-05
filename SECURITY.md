# Security model

## Threat model

| Actor | Powers |
|---|---|
| Player | Place bets, click tiles, cash out, refund expired games |
| House authority | Generate mine layouts, reveal tiles, settle games, push proofs on-chain |
| Owner | Initialize vault, withdraw house profits, update config, pause |
| Treasury | Receives house withdrawals (separate key from owner) |
| Attacker | Anyone — including a hostile player or compromised house key |

### Critical invariant

> A player must never know mine positions before clicking tiles.

Solana account data is publicly readable. Storing mine positions on-chain during gameplay is therefore unacceptable. PlayKaboom uses a server-assisted commit-reveal scheme, the same model used by Stake, Rollbit, and other production crypto casinos.

## Commit-reveal

```
1. House: layout = uniformRandom(C(16, mine_count))
          salt   = csprng(32 bytes)
          commitment = SHA256(layout_le || mine_count || salt)
2. Player → start_game(bet, mine_count, commitment)        // bet locked, commitment immutable
3. Player → click tile  →  House → reveal_tile(idx, isMine)
4. Player → cash_out  OR  House → reveal_tile(_, isMine=true)
5. House → settle_game(layout, salt)
   Program checks:
     SHA256(layout || mine_count || salt) == commitment
     count_ones(layout) == mine_count
     revealed_safe_mask & layout == 0
     revealed_mine_mask & layout == revealed_mine_mask
6. Anyone can recompute the SHA-256 from the now-public (layout, salt) and verify.
```

## Trust boundaries

| Attack | Mitigation |
|---|---|
| House changes mine layout mid-game | Commitment is immutable; settlement enforces SHA-256 equality |
| House lies about a tile (says "mine" on safe) | Settlement rejects: `revealed_safe_mask & layout == 0` |
| House refuses to settle | Player calls `refund_expired` after `GAME_EXPIRY_SLOTS` (≈2 min) |
| House generates biased layout | P2: Switchboard On-Demand VRF supplies salt entropy on-chain; server cannot bias the layout |
| Owner drains vault | `treasury` is a separate Squads multisig from `owner`; withdrawals only land in pre-allowlisted addresses; player active bets always recoverable via expiry refund |
| Compromised session token | AES-256-GCM authenticated encryption; tokens are tied to `(player, commitment)` and rotated on every reveal |
| Replay of stale token | Token has `nonce` field, server tracks last-seen nonce per game PDA |
| Compromised house authority key | Can lose games by lying about reveals → settlement detects mismatch and rejects with `RevealMismatch`; **cannot** drain vault (owner-only) or move funds (treasury-only) |
| Compromised owner key | Can update config (edge, caps, pause) but cannot move funds; treasury withdrawals require treasury signer + allowlisted destination |
| Compromised treasury key | Can withdraw vault profits, but only to allowlisted addresses; owner can rotate treasury via `update_vault` |

## Accepted risks (documented, not mitigated)

| Risk | Why accepted |
|---|---|
| No formal audit before mainnet | Defended by: on-chain bet/payout caps (2% / 50% of vault), 24-hour treasury timelock, public bug bounty on Immunefi, open-source program code with reproducible builds |
| No geographic restrictions | Player base is intended to be self-selecting crypto-native users; ToS displays clearly that participation is at the user's discretion under their jurisdiction's laws; no fiat on/off ramps reduce regulated-money exposure |

## Defence-in-depth controls

### API authorization

Every player-mutating route (`/api/commit`, `/api/reveal`, `/api/settle`, `/api/cleanup`) calls `verifyPlayerAuth(req, body.player)` before any business logic. That function:

1. Pulls the Privy access token from `Authorization: Bearer …` or the `privy-token` cookie.
2. Verifies it via `PrivyClient.verifyAuthToken()` against `PRIVY_APP_SECRET`.
3. Confirms the claimed `player` pubkey is one of the user's linked Solana wallets.

Anyone can hit the endpoints, but only the true owner of a wallet can drive its game. A claim mismatch is a `403`.

### Webhook signing

`/api/webhook/helius` (P2) verifies `Authorization` (or `x-helius-signature`) against `HELIUS_WEBHOOK_AUTH` using `crypto.timingSafeEqual`. Two acceptable forms: literal shared secret (Helius default) or HMAC-SHA256 over the raw body.

### Server-only modules

`server/auth.ts`, `server/env.ts`, `server/session.ts`, `server/solana.ts`, `server/db/supabase.ts`, `server/game.ts`, `server/player.ts`, `server/webhook-auth.ts` all start with `import "server-only"`. Any accidental import from a client component fails the build, preventing service-role keys or house-authority secrets from leaking into the browser bundle.

### Database — RLS + role grants

| Table | Anon | Authenticated | service_role |
|---|---|---|---|
| `player_stats` | SELECT | SELECT | ALL |
| `games` | SELECT | SELECT | ALL |
| `referrals` | SELECT | SELECT | ALL |
| `referral_events` | SELECT | SELECT | ALL |
| `processed_events` | none | none | ALL |

RLS is on AND `FORCE` for every table — even the table owner can't bypass policies. Only `service_role` (which only the server has) can write. The Helius webhook handler is the only writer in the system.

### Database — schema integrity

CHECK constraints on every numeric field (bet > 0, mine_count 1-12, multiplier ≥ 1.0×, tier 0-2, etc.) — the index can never store anything the program would reject. SHA-256 commitments are validated by regex (64 lowercase hex chars). Tx signatures by length range (64–96).

`updated_at` columns are auto-set by triggers via a `SECURITY DEFINER` function with `search_path = ''` to defeat search-path injection.

### Transport — security headers

Set in `apps/web/next.config.mjs` for every response:

| Header | Value |
|---|---|
| `Content-Security-Policy` | strict allow-list (self + Privy + Solana + Supabase + Pyth + WalletConnect) |
| `X-Frame-Options` | `DENY` |
| `frame-ancestors` (CSP) | `'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` (assets: `cross-origin`) |
| `Strict-Transport-Security` (prod) | `max-age=63072000; includeSubDomains; preload` |

`object-src 'none'` blocks legacy plugin embedding. `upgrade-insecure-requests` enforces HTTPS in prod.

### Transport — rate limiting

Sliding-window 30 req / 10s per `(IP, player)` tuple via Upstash. Defends against brute-forcing the commit endpoint or replaying stale game tokens.

### Key management — current

| Key | Storage | Rotation |
|---|---|---|
| `HOUSE_AUTHORITY_KEY` | env var, Vercel encrypted secrets | manual; rotate after personnel change |
| `SESSION_ENC_KEY` | env var, encrypted | rotate every 30 days |
| `SUPABASE_SERVICE_ROLE_KEY` | env var, server-only | rotate via Supabase dashboard if exposed |
| `PRIVY_APP_SECRET` | env var, server-only | rotate via Privy dashboard if exposed |
| Treasury private key | Squads multisig (cold) | per-key holder rotation in Squads |
| Owner private key | Squads multisig | per-key holder rotation in Squads |

### Key management — roadmap

| Improvement | Phase |
|---|---|
| House authority moved to AWS KMS / 1Password Connect | P3 |
| Per-environment env-var encryption with Vercel Encrypted Env | P2 |
| Session-key rotation on schedule (cron) | P3 |

### Audit + incident response

- Every house-signed transaction is logged via pino with `request_id` and player pubkey
- Sentry captures unhandled errors (P2)
- Better Stack uptime monitor + status page (P2)
- Bug bounty live on Immunefi at GA (no audits prior — accepted risk)

## Cryptographic primitives

| Primitive | Algorithm | Library |
|---|---|---|
| Commitment hash | SHA-256 | `sha2` crate (program), `@noble/hashes` (server + browser) |
| Session encryption | AES-256-GCM (12-byte IV, 16-byte tag) | `node:crypto` |
| Webhook auth | HMAC-SHA256 + `timingSafeEqual` | `node:crypto` |
| Mine selection | Fisher-Yates with rejection-sampled `randomBytes` | `node:crypto` |

## Key management

- `HOUSE_AUTHORITY_KEY` — ed25519 secret key, signs `reveal_tile` and `settle_game`. **Never used as an encryption key.**
- `SESSION_ENC_KEY` — 32 random bytes, AES-GCM key for game tokens. Independent rotation cycle.
- Vault `owner` and `treasury` should be separate signers (multisig recommended for treasury).

## Public verification

```ts
import { createHash } from "node:crypto";

export function verifyGame(
  mineLayout: number,
  mineCount: number,
  salt: Buffer,
  commitment: Buffer,
): boolean {
  const layoutBytes = Buffer.alloc(2);
  layoutBytes.writeUInt16LE(mineLayout, 0);
  const preimage = Buffer.concat([layoutBytes, Buffer.from([mineCount]), salt]);
  const hash = createHash("sha256").update(preimage).digest();
  return hash.equals(commitment);
}
```

(Available as `verifyGame()` in `@playkaboom/sdk`.)
