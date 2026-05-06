# Pre-mainnet threat model

External research pass on Solana / Anchor / Squads V4 / Privy attack surfaces, mapped to our `programs/kaboom/src/lib.rs`. Last reviewed 2026-05-07 (commit `7d91800`+).

This complements `program-audit.md` (which is line-by-line internal review). Where the two overlap, this doc is the broader-ecosystem version.

## Critical (action required pre-mainnet)

### C1. Settle: referral PDA explicit-key derivation

**Where**: `settle_game` ~line 550 — `Account::try_from(referral_info)` accepts any `ReferralAccount` whose internal `referrer` field matches `stats.referrer`. The discriminator + program-owner check passes; the PDA seed-derived address is NOT explicitly compared against `referral_info.key()`.

**Risk**: today this is implicitly safe because (a) the referral PDA is seeded by `[REFERRAL_SEED, referrer.key()]` so a `ReferralAccount` with a forged `referrer` field cannot exist as a PDA, and (b) the `require!(ra.referrer == referrer_key)` runtime check would reject it. But "implicit" is a bug magnet — a future refactor that moves the PDA seed could re-open this.

**Fix**: in `settle_game`, derive the expected PDA from `stats.referrer` and `require!(referral_info.key() == expected_pda)`. One `find_program_address` call. Belt-and-suspenders.

### C2. Lamport-transfer write-demotion on raw destinations

**Where**: `withdraw_to_treasury` lines 786-794. The destination is an `UncheckedAccount` that's only validated against the allowlist.

**Risk**: if an allowlisted destination is ever a sysvar, precompile, or executable account, the runtime silently demotes write-perm and the tx fails — or worse, future feature-gates can brick a previously-fine address. Player/referrer sites are signers (already non-executable), so this is `withdraw_to_treasury`-specific.

**Fix**: add `require!(!ctx.accounts.destination.executable, ...)` in `withdraw_to_treasury`. ([OtterSec, May 2025](https://osec.io/blog/2025-05-14-king-of-the-sol/))

### C3. Squads V4 durable-nonce replay window (operational)

**Where**: every privileged role (`vault.owner`, `vault.treasury`, BPF upgrade authority) is now a Squads V4 multisig.

**Risk**: if a malicious member proposes a multisig tx using a *durable nonce* instead of a recent blockhash, the ~90-second blockhash-expiry safety doesn't apply — signatures stay valid indefinitely. A bad-faith proposer could collect the second signature over hours/days and execute when most damaging. Same family: if `config_authority` of a Squads multisig is itself a hot wallet, a single-key compromise can lower the threshold.

**Fix**: by policy, refuse durable-nonce proposals. Set `config_authority = None` (immutable config) on each multisig once members are finalized — operational step, not code. Document in deploy runbook. ([Squads V4 Security Measures](https://squads.xyz/blog/v4-security-measures))

### C4. BPF Upgradeable Loader: buffer hijack risk

**Where**: every program upgrade goes through `solana program write-buffer` → `Upgrade`.

**Risk**: between buffer creation and upgrade, the buffer authority is a key (the deployer, in our flow until we transfer to Squads). If that key is leaked OR `set-buffer-authority` is fat-fingered, an attacker can substitute their bytecode at upgrade time.

**Fix**: every upgrade is built locally, the buffer's authority is set to Squads vault PDA before proposing the Upgrade ix, and the deploy runbook verifies `solana program show <PROGRAM_ID>` upgrade-authority before AND after. We have this script: `scripts/upgrade-program-via-squads.ts`. The only single-key window is the buffer-write step where the buffer briefly belongs to the deployer; if that key leaks during the few minutes of write+set-authority, attacker substitutes bytecode. **Mitigation**: keep the deploy-keypair offline + use it only on a hardened machine. Long-term plan: set program upgrade authority to `None` (frozen) once mainnet is stable.

## High

### H1. First-depositor share inflation — **mitigated**

`initialize_v2` carves `ANTI_INFLATION_SEED_LAMPORTS = 1 SOL` into permanent `seed_units` from existing vault balance. `total_units` starts at full assets, so attacker cannot front-run the first LP deposit. Plus `min_lp_deposit = 0.01 SOL` floor reduces precision-loss skim. No action needed.

### H2. Donation/skim attack on vault NAV — **mitigated by 3-day cooldown**

Anyone can `system_program::transfer` raw SOL into the vault PDA, inflating `vault_assets()` without minting units. This is a *gift to existing LPs*, not a steal. Combined with the 3-day withdraw cooldown, no atomic donate-and-withdraw is possible. Edge case: a griefer donates SOL right before someone's `lp_deposit` so the depositor gets fewer units than expected. Magnitude is bounded by `min_lp_deposit` precision.

**Optional fix**: slippage-protected `lp_deposit(amount, min_units_out)`. Not blocking.

### H3. Close-then-revive in same tx

Account-close patterns can be revived by a `system_program::transfer` of lamports back into the closed PDA in a later ix of the same tx. Anchor `close = ...` since 0.30 sets `CLOSED_ACCOUNT_DISCRIMINATOR` and zero-realloc's data, which prevents reuse. Our `Cargo.toml` pins `anchor-lang = "0.31.1"`, so we're covered.

### H4. `init_if_needed` reinitialization

`set_referrer`, `start_game.player_stats`, and `lp_deposit.position` use `init_if_needed`. Currently guarded with `if x == Pubkey::default()` checks. Risk: a future refactor that zeros a field re-opens init logic.

**Fix**: add explicit `version != 0` short-circuits at the top of each init block. Belt-and-suspenders.

### H5. Privy embedded-wallet popup spoofing

Off-chain UX risk. The Privy iframe shows the signing UI; if the parent app allows headless signatures (developer-triggered without a modal) OR the modal doesn't surface tx detail, a compromised front-end could sign arbitrary ixs. The JWT itself is Ed25519-signed by Privy and infeasible to forge, but a stolen JWT replays within token TTL.

**Mitigations**: never enable headless Solana signing for player game txs (only for `reveal_tile` proxied through the house). Keep JWT TTL short (Privy default is 1h; consider 15min for high-stakes). Surface tx details in the Privy modal. Optionally enable Privy MFA for cash-outs > N SOL.

## Medium

### M1. Pyth oracle staleness — N/A

We use Pyth Hermes for SOL/USD UI display only, not on-chain math. No risk to vault.

### M2. Reentrancy via self-CPI — mitigated by runtime

Solana runtime forbids A → B → A self-reentrancy at depth >1; account locking prevents two writable handles to the vault in one tx. We make exactly one CPI per ix (`system_program::transfer`).

### M3. `update_v2_config`: zero-cooldown footgun

**Where**: line 1035, `if let Some(v) = withdraw_cooldown_slots { v2.withdraw_cooldown_slots = v; }` accepts 0.

**Risk**: a Squads vote to set cooldown=0 enables atomic donate-and-withdraw NAV griefing (combined with H2). Same applies to `min_health_bps = 0` and `min_house_share_bps = 0` footguns.

**Fix**: enforce non-zero floors in `update_v2_config`:

```rust
if let Some(v) = withdraw_cooldown_slots {
    require!(v >= MIN_WITHDRAW_COOLDOWN_SLOTS, KaboomError::InvalidConfig);  // e.g. 150 ≈ 1 min
    v2.withdraw_cooldown_slots = v;
}
```

### M4. Manual key constraints vs `has_one` — stylistic

Many ixs use `constraint = X.key() == vault.Y` instead of `#[account(has_one = Y)]`. Functionally equivalent in Anchor; manual is just easier to forget on a future ix. Optional refactor.

### M5. Anchor 1.0 aliasing default

Pre-Anchor 1.0, two account fields could resolve to the same address (aliasing) unless explicitly checked. We're on 0.31.1; current constraints make exploits unreachable, but Anchor 1.0 makes the default safer. **Optional**: add `require!(destination.key() != vault.key(), ...)` in `withdraw_to_treasury` as belt-and-suspenders.

## Low

### L1. SPL Token interactions — **N/A**

We are SOL-only. Risks dodged: token-account owner spoofing, mint substitution, decimals confusion, freeze-authority griefing, Token-2022 transfer-hook reentrancy, fake-mint spoofing.

### L2. Sysvar / clock manipulation

`Clock::get()?` is fetched fresh every ix; slot is monotonic within a single bank. `start_slot + 300/600` cooldowns are robust.

### L3. PDA seed collision — none

Distinct seed prefixes (`kaboom_vault`, `kaboom_v2_state`, `kaboom_lp`, `kaboom_game`, `kaboom_stats`, `kaboom_referral`). `bump = vault.bump` (canonical bump cached) prevents bump-grinding.

### L4. `UncheckedAccount` use sites

- `referrer` in `set_referrer` (1779): used to derive the `referral_account` PDA — pubkey is implicitly validated.
- `house_authority` and `treasury` at init: no signature needed at init; only the pubkey is recorded. Acceptable.
- `destination` in `withdraw_to_treasury` (1972): allowlist runtime-check + see C2 above.

### L5. Saturating arithmetic on counters

`vault.total_games`, `vault.total_wagered`, `vault.total_payouts`, `stats.*` use `saturating_add`. These are stats, not consensus; saturation is correct.

## Action plan

| # | Item | Severity | Effort | Status |
|---|---|---|---|---|
| 1 | C1: explicit PDA-key check in `settle_game` referral path | Critical | 5 LOC | TODO |
| 2 | C2: reject executable destinations in `withdraw_to_treasury` | Critical | 1 LOC | TODO |
| 3 | C3: disallow durable nonces in Squads, freeze config_authority | Critical | runbook | docs only |
| 4 | C4: deploy runbook with pre/post upgrade-authority verification | Critical | runbook | docs only |
| 5 | M3: non-zero floors in `update_v2_config` | Medium | 10 LOC | TODO |
| 6 | H4: `version != 0` short-circuit at init paths | High (defense) | 6 LOC | TODO |
| 7 | M5: aliasing assert in `withdraw_to_treasury` | Medium | 1 LOC | TODO |

Items 1, 2, 5, 6, 7 are a single Rust patch. Items 3 and 4 are operational and live in the deploy runbook.

## Sources

- [Zellic — Vulnerabilities You'll Write With Anchor](https://www.zellic.io/blog/the-vulnerabilities-youll-write-with-anchor/)
- [OtterSec — Hidden dangers of lamport transfers (May 2025)](https://osec.io/blog/2025-05-14-king-of-the-sol/)
- [Helius — Hitchhiker's Guide to Solana Program Security](https://www.helius.dev/blog/a-hitchhikers-guide-to-solana-program-security)
- [Solana Foundation — Reinitialization Attacks](https://solana.com/developers/courses/program-security/reinitialization-attacks)
- [RareSkills — init_if_needed and the reinit attack](https://rareskills.io/post/init-if-needed-anchor)
- [FuzzingLabs — Revival Attacks](https://fuzzinglabs.com/revival-attacks-solana-programs/)
- [Sec3 — Auditing Anchor (Part 4)](https://www.sec3.dev/blog/how-to-audit-solana-smart-contracts-part-4-the-anchor-framework)
- [Sec3 — Solana Deploy/Upgrade internals](https://www.sec3.dev/blog/solana-internals-part-2-how-is-a-solana-program-deployed-and-upgraded)
- [Squads V4 Security Measures](https://squads.xyz/blog/v4-security-measures)
- [Privy security FAQ](https://docs.privy.io/security/security-faqs)
- [Mixbytes — Inflation Attack overview](https://mixbytes.io/blog/overview-of-the-inflation-attack)
- [Neodyme — Common Solana Pitfalls](https://neodyme.io/en/blog/solana_common_pitfalls/)
