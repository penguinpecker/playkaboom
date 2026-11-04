# kaboom-p port notes (read before touching a handler)

Pinocchio port of `programs/kaboom` (Anchor 0.31.1, git `e82f2c5`). The ABI must stay byte-identical; only
the program id changes (`Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju`). Specs: `pinocchio/spec/*.md`
(`shared.md` first, then your group file). Lead decisions D1-D15 in the task override the spec text.

## Module layout

| file | what | who edits |
|---|---|---|
| `src/lib.rs` | entrypoint (`MAX_ACCOUNTS = 10`, `no_allocator!`), security.txt, `process_instruction` (4100 / 101 / 1500, logs `Instruction: <Name>`, calls the handler) | lead only |
| `src/ix/mod.rs` | the 42-entry table: discriminators (`ix::disc::*`), log names, routing | lead only |
| `src/ix/<group>.rs` | the handlers of one spec group | **that group's owner only** |
| `src/consts.rs` | program ids, fixed PDAs + bumps, seeds, game constants | lead only |
| `src/state.rs` | account offsets (`state::vault::OWNER`, ...), `DISC`, `SPACE`, `TYPE`, `load()`, `rd_*` / `wr_*` | lead only |
| `src/error.rs` | `KaboomError` (6000+i), `AnchorError` (framework codes), `err()` | lead only |
| `src/events.rs` | one serializer per event (`events::game_won(..) -> [u8; 105]`) + `emit()` | lead only |
| `src/helpers.rs` | checks, PDAs, init / close, lamports, `Args` reader, sysvars, all shared math | lead only |
| `tests/abi.rs` | host ABI test vs the IDL + multiplier fixture | lead only |

Group files: `vault_admin.rs` (vault-admin.md), `referral.rs`, `legacy_game.rs`, `v2_lp.rs`, `house.rs`,
`vrf.rs` (vrf.md, incl. `process_undelegation`). Shared files are read-only per group: six groups
edit in parallel. If you need a helper that is missing, write it as a private `fn` in your own file and
name it in your summary so the lead can promote it. You may add `tests/<group>.rs` host tests.

All 42 handlers are ported; `helpers::NOT_PORTED` has been removed. Current state: `STATUS.md`.

## Handler contract

```rust
#[inline(never)]
pub fn settle_game(accounts: &mut [AccountView], args: &[u8]) -> ProgramResult
```

- `args` = instruction data **after** the 8-byte discriminator. A spec offset "`@8`" is `args[0]`.
- Do **not** log `Instruction: X`; the dispatcher already did, before the handler runs. Log nothing else
  either (no error text, decision D5).
- Keep `#[inline(never)]` on every handler and on any big local helper. The final build must print zero
  `Stack offset ... exceeded` warnings (4 KB frame). Large CPI buffers go in their own `#[inline(never)]` fn.
- `no_std`, no allocator: no `Vec`, `String`, `format!`, `Box`. Allocation aborts at runtime.
- No `unwrap()` / `expect()` / indexing on untrusted lengths before they are checked. Offsets into an
  account are safe once `load()` passed (it checks `len >= SPACE`). Panics that Anchor also has
  (`overflow-checks`, `1u16 << tile` with tile >= 16 from rollup state) are kept for parity.

## Anchor order you must reproduce (shared.md §5.1-5.6, decision D4)

```
1. args      Borsh decode with helpers::Args            -> 102 (trailing bytes ignored)
2. Pass A    each account in struct order:
               fewer accounts than declared             -> 3005
               Account<T>: state::load(acc, &T::TYPE)   -> 3012 / 3007 / 3001 / 3002 / 3003
               Signer: check_signer                     -> 3010
               Program<T>: check_program / check_system_program -> 3008 / 3009
               init / init_if_needed fields: nothing yet
3. Pass B    init fields in order: helpers::init_pda / init_if_needed_pda
4. Pass C    each NON-init field in order: seeds (2006) -> mut (2000) -> constraint @E -> close self-target (2011) -> address (2012 or @E)
5. handler   the body, in source order
6. exit      `close = target` fields in struct order: helpers::close_to (LAST)
```

Skeleton:

```rust
use pinocchio::{AccountView, ProgramResult};
use crate::consts::*;
use crate::error::{AnchorError, KaboomError};
use crate::events::{self, emit};
use crate::helpers::{self, *};
use crate::state::{self, game_session as gs, vault as vt, rd_u64, wr_u64, rd_pk};

#[inline(never)]
pub fn close_game(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [game, player, ..] = accounts else { return Err(AnchorError::AccountNotEnoughKeys.into()) };
    // Pass A
    load(game, &gs::TYPE)?;
    check_signer(player)?;
    // Pass C: game: seeds (stored bump) -> mut -> constraints -> close target
    {
        let d = game.try_borrow()?;
        check_pda_bump(game, &[GAME_SEED, rd_pk(&d, gs::PLAYER)], d[gs::BUMP])?;
    }
    check_mut(game)?;
    // ... constraint = ... @ KaboomError::X  ->  require(cond, KaboomError::X)?;
    check_close_target(game, player)?;
    check_mut(player)?;
    // handler body ...
    // exit
    close_to(game, player)
}
```

Accounts beyond the declared list are `remaining_accounts` (`settle_game` / `settle_vrf` / `delegate_vrf`
use `rem.first()` via `let [a, b, .., rem @ ..] = accounts`). The entrypoint keeps at most 10 accounts.

## Accounts and data

- Offsets: `state::<type>::<FIELD>` (absolute, disc included), e.g. `state::vault::TOTAL_GAMES`. Types:
  `game_session`, `lp_position`, `player_stats`, `referral_account`, `vault`, `vault_v2_state`,
  `vrf_claim`, `vrf_game`; raw-only `game_session_v2`. Each has `DISC`, `SPACE`, `TYPE`.
- Read/write in place: `let mut d = acc.try_borrow_mut()?; wr_u64(&mut d, vt::TOTAL_GAMES, v);`.
  Read: `rd_u8` = `d[off]`, `rd_u16/u32/u64/i64/u128`, `rd_pk(&d, off) -> &[u8; 32]`.
- **Write each field at the moment the Anchor handler mutates the struct field.** Shared helpers that take
  `v2d: &[u8]` (`calc_health_bps`, `enforce_min_health`, `user_units_total`, `admin_spendable`) read the
  live bytes, which then equal Anchor's in-memory struct. Lamports are always live (Anchor too).
- Writes that Anchor's exit does: only changed fields are needed (identical bytes are a no-op). Init
  accounts need the **full image**: write `TYPE.disc`/`DISC` to `0..8` and every field.
- Borrows: drop every `try_borrow*` guard (scope it with `{ }`) before any CPI or `close_to` /
  `zero_close_to`; the CPI and close fail with AccountBorrowFailed otherwise. Never hold two borrows of
  accounts that a client could pass as the same key (Anchor allows duplicates; pinocchio would fail).
- `PlayerStats.referrer`: tag @106, key @107. Set = write tag 1 + key; never touch `_reserved`.
- Keys: `acc.address()` is `&Address`; `acc.address().as_array()` is `&[u8; 32]`. Compare a key with
  stored bytes as `acc.address().as_array() == rd_pk(&d, off)`. Default key = `[0u8; 32]`.

## PDAs (D2, D14)

- Vault / VaultV2State seeds: `check_vault_seeds(vault)` / `check_v2_seeds(v2)` (const key + stored bump
  254 / 255, else 2006). Call after `load`.
- `seeds = [...], bump = x.bump` (stored): `check_pda_bump(acc, &[SEED, key], stored_bump)`.
- `seeds = [...], bump` (canonical, non-init): `check_pda_find(acc, &[SEED, key]) -> bump`.
- Any other address: `find_pda(seeds)` / `find_pda_for(seeds, &program)` (try_find; `None` -> 2006).
- Never call a panicking `find_program_address`, ours or vendored (`ephemeral_rollups_pinocchio::pda::*`,
  `instruction::delegate_account`, `instruction::undelegate` all use it). VRF identity: sign with the
  constants `IDENTITY_PDA` / `IDENTITY_BUMP`; callback signer is `SCOPED_VRF_IDENTITY`.

## init / init_if_needed / close (D8, D11)

- `init`: `let bump = init_pda(payer, acc, &[SEED, key], state::x::SPACE, &rent)?;` then write the full image.
- `init_if_needed`: `let (bump, _created) = init_if_needed_pda(payer, acc, &[SEED, key], &state::x::TYPE, state::x::SPACE, &rent)?;`
  "first time" is still detected by a zero key field, like the Anchor handlers.
- Both implement Anchor's pre-funded path (transfer top-up `max(rent,1) - lamports`, Allocate, Assign) and
  the post-checks (2019 / 2004 / 2005 / 2000 / 2005). A plain `init` on an existing account fails in Allocate.
- `close = target`: `close_to(acc, target)` at the very end, in struct field order.
- Manual zero-close (refund_stalled_vrf, admin_close_orphaned_game_v2): `zero_close_to(acc, player)`.

## Lamports, sysvars

- Out of a program-owned account: `move_lamports(from, to, amount)` (checked, 6008).
- Into the vault from a signer (bets, deposits, fund): `transfer(from, to, amount)` (system CPI).
- `let rent = rent()?;` and `let clock = clock()?;` once per handler. `rent_min(&rent, space)`,
  `vault_assets(vault, &rent)` (= lamports - rent(428), saturating). D1: no threshold handling.

## Events

`emit(&events::game_settled(player, game, mine_count, layout, &salt, &commitment, verified, clock.slot));`
One `sol_log_data` slice, exactly like Anchor `emit!`. Order of emits matters (shared.md §2 table).
Emit from the handler body; the VRF instructions and close_game / close_unsettled_game emit nothing.

## Errors

- Custom: `return Err(KaboomError::Unauthorized.into());` or `require(cond, KaboomError::Unauthorized)?;`
- Framework: `Err(AnchorError::ConstraintSeeds.into())`. Codes in `error.rs`.
- System-program / borrow / CPI errors pass through unchanged, like Anchor.

## Math

All of lib.rs:1790-1967 is in `helpers`: `calc_multiplier`, `mul_div_floor`, `worst_case_payout`,
`vault_assets`, `deposit_to_units`, `units_to_assets`, `user_units_total`, `calc_health_bps`,
`enforce_min_health`, `enforce_house_floor`, `enforce_user_position_cap`, plus `admin_spendable`,
`decide_mine`, `check_vrf_game_delegable` (vrf_mode.rs) and `referral_cut_bps` / `tier_for_volume`
(settle_game's inline tier logic). `helpers::sha256(&[a, b, c])` is the `sol_sha256` syscall
(on-chain only; host tests must use the `sha2` dev-dependency).

## MagicBlock (vrf.rs only)

- VRF request: vendored (patched) `ephemeral_rollups_pinocchio::vrf::{instruction::RequestRandomnessCpi, types::RequestRandomness}`, signer `[IDENTITY_SEED, [IDENTITY_BUMP]]`.
- `settle_and_undelegate_vrf`: hard-coded ScheduleIntentBundle bytes + host test vs the sdk builder (D12).
  Never the legacy `commit_and_undelegate_accounts`.
- `delegate_vrf`: own buffer create (pre-funded path, D8) + DLP Delegate CPI; do not call vendored `delegate_account`.
- `process_undelegation`: own code. Buffer must be a signer, DLP-owned, and equal
  `find_pda_for(&[DLP_UNDELEGATE_BUFFER_SEED, base], &DELEGATION_PROGRAM_ID)` (InvalidSeeds); Anchor-tolerant
  `Vec<Vec<u8>>` parsing (D9). If the vendored crate must be patched, append the diff to
  `pinocchio/vendor/vendor-extra.patch`.

## Build and test

```
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cargo test --manifest-path /Users/pp/Projects/playkaboom/pinocchio/kaboom-p/Cargo.toml
cargo-build-sbf --manifest-path /Users/pp/Projects/playkaboom/pinocchio/kaboom-p/Cargo.toml
```

Foreground only, one build at a time. Other work may edit the same tree: a compile error in another
group's file is not yours (keep yours compiling after every edit; write whole functions per edit).

`cargo-build-sbf` auto-generated `target/deploy/kaboom-keypair.json` (pubkey `5JLD...`); it is NOT the
program id. The deploy must use the `Ednka8...` keypair the owner holds, never that file.
