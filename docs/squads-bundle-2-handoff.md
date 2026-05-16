# Squads bundle #2 — handoff (2026-05-16)

Everything needed to execute the four bundled changes via Squads 2/2:

1. **Magicblock ER program upgrade** (already on main since PR #2)
2. **Unlock the 1 SOL anti-inflation seed** (new ix `unlock_seed`)
3. **50% treasury / 50% LP profit split** (now enforced in `settle_game` + `settle_game_er`)
4. **Referral auto-accept UI** (✅ already deployed to mainnet web app today)

Items 1-3 ship together in one program redeploy. Item 4 is web-only and already live.

---

## Binary

| Item | Value |
|---|---|
| Path | `target/deploy/kaboom.so` (916,648 bytes) |
| sha256 | `c693f2f9bc87cfaf704c754ac784ef041ba21ca82d3ee592ae0521bbf17575db` |
| Program ID (mainnet) | `9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh` |
| Upgrade authority | The Squads 2/2 multisig |
| Build commit | `7ef3c66` on branch `magicblock-bundle-2` (origin) |

---

## Constants

| Item | Value |
|---|---|
| Vault PDA | `9qDnHBWKvo5CjFk3mZmSFS3pq8bLfGSmTtXP6gHeeWAK` (bump 254) |
| V2 State PDA | `6cKDKGz4qEhJRWJUjEFcVyvKGtYXD7duy2fEkLkaM3zb` (bump 255) |
| House authority (Turnkey) | `7exwTWn1ChVyQZF5mTxZM1UNrPpj1nQKhhvXztR4prQp` |

---

## Step-by-step Squads votes

### Vote 1 — program upgrade (required, atomic with vote 2-3)

Use Squads' built-in **Program Upgrade** feature in the dashboard. Upload `target/deploy/kaboom.so`. Squads handles buffer upload + the BPF Upgradeable Loader `upgrade` ix.

**After execute lands:**
- ER instructions become callable on chain
- `settle_game` now requires 6 accounts (vault, v2_state, game, stats, house_authority, **treasury**)
- `settle_game_er` similarly
- `vault.er_enabled` defaults to false (existing `_reserved` bytes deserialize as false) — ER routing stays gated
- `treasury_split_bps` is still 5000 — the new split fires immediately on every settle once the binary is live

### Vote 2 — call `unlock_seed` (optional, can defer)

Recovers the 1 SOL anti-inflation seed.

**In Squads Tx Builder → Add Instruction → Raw:**
- Program ID: `9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh`
- Accounts:
  | # | Address | Writable | Signer |
  |---|---|---|---|
  | 1 | `9qDnHBWKvo5CjFk3mZmSFS3pq8bLfGSmTtXP6gHeeWAK` (Vault PDA) | ✅ | ❌ |
  | 2 | `6cKDKGz4qEhJRWJUjEFcVyvKGtYXD7duy2fEkLkaM3zb` (V2 State PDA) | ✅ | ❌ |
  | 3 | `<the Squads vault address>` (owner = multisig itself) | ❌ | ✅ |
  | 4 | `<destination — must already be on vault.withdraw_allowlist>` | ✅ | ❌ |
- **Raw data (base58):** `F4wNdVfbE2d`
- **Raw data (base64) (Buffer tab):** `VBs9OHDjK+I=`

### Vote 3 — call `update_v2_config(er_enabled = true)` (DEFER — only after Magicblock #182 answers)

This flips on Magicblock ER routing. **Do not execute until the force-undelegate question is answered.**

- Program ID: `9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh`
- Accounts:
  | # | Address | Writable | Signer |
  |---|---|---|---|
  | 1 | `9qDnHBWKvo5CjFk3mZmSFS3pq8bLfGSmTtXP6gHeeWAK` (Vault PDA) | ❌ | ❌ |
  | 2 | `6cKDKGz4qEhJRWJUjEFcVyvKGtYXD7duy2fEkLkaM3zb` (V2 State PDA) | ✅ | ❌ |
  | 3 | `<the Squads vault address>` (owner) | ❌ | ✅ |
- **Raw data (base58):** `NZSMavwST8wKBhDWDHjE`
- **Raw data (base64):** `DUlPVi8x5CgAAAAAAAEB`

### Vote 4 — `update_vault(treasury_split_bps = 5000)` (skip — value is already 5000)

Only needed if you want to change the split ratio from the existing 50%. Already 5000 by default. Listed here for completeness in case you want to switch to e.g. 70/30 (then treasury_split_bps = 7000).

---

## Web app deployment (Vercel)

The staging branch `magicblock-bundle-2` carries the matching web changes (web sends 6 accounts to settle_game; old web sends 5). **Do NOT merge to main until program upgrade has executed.**

### Vercel env vars to add before merge

| Name | Value | Scope |
|---|---|---|
| `TREASURY_PUBKEY` | `<vault.treasury value from on-chain Vault>` | Production (sensitive) |

To read the current `vault.treasury`:
```
solana account 9qDnHBWKvo5CjFk3mZmSFS3pq8bLfGSmTtXP6gHeeWAK \
  --url https://api.mainnet-beta.solana.com --output json | \
  python3 -c "import json,sys,base64; d=base64.b64decode(json.load(sys.stdin)['account']['data'][0]); \
    # Vault struct: 8 disc + 32 owner + 32 house_authority + 32 treasury
    import base58; print('treasury:', base58.b58encode(d[72:104]).decode())"
```

### Merge order (CRITICAL)

```
1. Submit Squads Vote 1 (program upgrade)
2. Member 2 votes & executes → new program live on mainnet
3. IMMEDIATELY (within ~30s):
   a. Set TREASURY_PUBKEY env in Vercel
   b. Merge magicblock-bundle-2 into main (gh pr merge --merge or web UI)
4. Verify /api/health stays 200 + try a small test game settle
5. (Optional) Submit Squads Vote 2 (unlock_seed)
```

The window between (2) and (3b) (~30s of pushing) will see settle calls fail with `account constraint failed` because old web sends 5 accounts but new program expects 6. Players in-flight see the existing cleanup recovery flow.

If the brief window is unacceptable, alternative: pause the vault (`update_vault(paused = true)`) during the upgrade, then unpause after merge. Adds two extra Squads votes but eliminates the gap.

---

## Rollback

If anything goes wrong:

- **Program rollback**: BPF Upgradeable Loader supports re-upgrade. The pre-bundle binary is preserved at commit `8669845`'s `target/deploy/kaboom.so` (would need to rebuild from that commit).
- **Web rollback**: `git push origin pre-magicblock-push:main --force-with-lease` (tag is on origin at `7d37d52`).
- **DB rollback**: migrations applied today are additive (new tables/columns). Drop with `DROP TABLE game_session_keys; ALTER TABLE ... DROP COLUMN delegated_at;` — safe to do anytime since flag is off.

---

## What's NOT in this bundle (for clarity)

- Mainnet program upgrade is needed for ER ixs to be callable — but `vault.er_enabled = false` keeps ER routing OFF even after the upgrade.
- Force-undelegate answer from Magicblock (issue #182) is still required before ANY real ER traffic.
- Vercel env `MAGICBLOCK_ENABLED` is also still unset — defaults to OFF.

So even with the upgrade landed + `treasury_split_bps` actively splitting + seed unlocked, **no ER traffic flows** until both flags flip. The treasury split and unlock_seed work the moment the program upgrades, independently of ER.
