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
| House generates biased layout | Salt mixes with on-chain slot hash at start (mitigates server-side determinism); roadmap: replace with Switchboard On-Demand VRF |
| Owner drains vault | Treasury withdrawal is the design intent (it's house capital). Player active bets are protected by expiry refund |
| Compromised session token | AES-256-GCM authenticated encryption; tokens are tied to `(player, commitment)` and rotated on every reveal |
| Replay of stale token | Token has `nonce` field, server tracks last-seen nonce per game PDA |

## Cryptographic primitives

| Primitive | Algorithm | Library |
|---|---|---|
| Commitment hash | SHA-256 | `sha2` crate (program), `node:crypto` (server) |
| Session encryption | AES-256-GCM (12-byte IV, 16-byte tag) | `node:crypto` |
| Session signing | HMAC-SHA256 | `node:crypto` |
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
