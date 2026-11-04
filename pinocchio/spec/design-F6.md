# F6 (MB-6): orphan VrfGame after `admin_release_vrf_claim` — design

Status: design only, no code changed. Target: `pinocchio/kaboom-p/src/ix/vrf.rs` (`start_game_vrf`).

## 1. The hole

`admin_release_vrf_claim` closes the `VrfClaim` to the player and leaves the `VrfGame` PDA
(`[b"kaboom_vrf_game", player]`) where it is. The Anchor source says (vrf_mode.rs:893-895) that the game's
rent "is recovered separately if the rollup ever releases it", but no instruction can do that:

| Instruction | Why it can't clear the orphan |
|---|---|
| `settle_vrf` | `load(claim)` fails with 3012 because the claim is gone |
| `refund_stalled_vrf` | same (`load(claim)`) |
| `start_game_vrf` | `init` on the game PDA: `Allocate` fails ("already in use") |
| `delegate_vrf` / `cash_out_vrf` | they act on a live game; neither one closes it |

The result: the wallet can never play VRF mode again, and the game's rent (`rent_min(621)`, which is
3,804,920 lamports at the harness rate) is stuck. Repro: `difftest/tests/audit_magicblock.rs::mb6_admin_release_orphans_game_and_locks_wallet`.

An orphan can be in one of two states after the release:
- **(a) program-owned.** The game was never delegated, or it came back to L1 through `process_undelegation`
  with any status (Playing, Won or Lost).
- **(b) DLP-owned.** The game is still delegated. The program cannot write to it at all.

Invariant this design relies on (true today; F3 must keep it): **a `VrfClaim` is only ever closed together
with its `VrfGame`, except by `admin_release_vrf_claim`.** `settle_vrf` closes both, `refund_stalled_vrf`
closes both, and `start_game_vrf` creates both in the same instruction. So "a program-owned VrfGame exists
but the player has no VrfClaim" means only one thing: an orphan whose money is already settled.

## 2. Options

| | A. New `close_orphan_vrf_game` (permissionless) | B. `admin_release_vrf_claim` also closes the game (optional trailing account) | **C. `start_game_vrf` reuses an orphan game PDA** |
|---|---|---|---|
| What it does | New instruction [caller(S), player(W), claim, game(W)]. It requires that the claim PDA is not program-owned and that the game is program-owned with the VrfGame disc, then zero-closes the game to the player. | If `remaining_accounts[0]` is the game PDA and it is program-owned, it is zero-closed to the player in the same instruction. | In Pass B, after the claim `init` succeeds: if the game PDA is program-owned and carries the VrfGame disc, zero its data and use it as the new game instead of `init`. |
| Covers (a) never-delegated | yes | yes | yes |
| Covers (a) came back from the ER later | yes | **no** (that happens after the release) | yes |
| Covers (b) | no (nothing on L1 can) | no | no |
| Lockout cleared | when a crank or client calls it | at release time only | **the moment the player tries to play** |
| Rent back to the player | right away, through the crank | right away | carried into the new game, paid back when that game closes |
| ABI surface | new disc, IDL, SDK builder, cron branch, client pre-step | new optional account, SDK change | **none** (same disc, args, accounts, errors) |
| Code | about 30 lines plus the dispatcher, SDK and cron | about 10 lines | **about 12 lines** |
| Needs the apps changed before it helps | yes (cron and client) | yes (release script) | **no**: the web client's preflight only checks the claim, so it already sends `start_game_vrf` for an orphan |
| Anchor parity cost | none (additive) | `admin_release` diverges when the extra account is passed | `start_game_vrf` diverges in exactly one state, which Anchor can only fail on |

B alone is not enough: the common orphan (released while delegated, back on L1 later) needs a second path
anyway. A works, but it only helps once the cron and the client learn to call it. C fixes the root cause at
the one call that is blocked, and it covers every way an orphan can arise: today's `admin_release_vrf_claim`
and any house release that F3 adds.

**Pick: C.** Skipped: A's instant rent refund for a player who never plays VRF again. Add A if that rent
(about 0.0038 SOL per released wallet) turns out to matter.

## 3. Exact spec (option C)

### 3.1 Changed instruction: `start_game_vrf`
Same discriminator, args (`mine_count u8, bet u64, session_key pubkey`) and accounts
(`player(WS), vault(W), v2_state(W), claim(W), game(W), player_stats(W), system_program`).

The only change is Pass B for `game`. Replace `vrf.rs:82`:

```rust
let game_bump = init_pda(player, game, &[VRF_GAME_SEED, &pk], vg::SPACE, &rent)?;
```

with:

```rust
let game_bump = match reuse_orphan_game(game, &pk)? {
    Some(b) => b,
    None => init_pda(player, game, &[VRF_GAME_SEED, &pk], vg::SPACE, &rent)?,
};
```

and add this function next to `check_game_seeds`:

```rust
/// F6 (MB-6): a program-owned VrfGame at the player's PDA with no claim is an orphan left by
/// admin_release_vrf_claim (the only path that closes a claim without its game). The claim `init`
/// just above proved no live claim exists, so wipe the dead game and start the new one in it; its
/// rent carries over. Anything else (DLP-owned, zero-closed, foreign) falls through to `init`, which
/// fails exactly like Anchor.
#[inline(never)]
fn reuse_orphan_game(game: &AccountView, pk: &[u8; 32]) -> Result<Option<u8>, ProgramError> {
    if !game.owned_by(&ID) || game.try_borrow()?.get(..8) != Some(&vg::DISC[..]) {
        return Ok(None);
    }
    let bump = check_pda_find(game, &[VRF_GAME_SEED, pk])?; // 2006, before any write
    check_mut(game)?; // 2000
    game.try_borrow_mut()?.fill(0);
    Ok(Some(bump))
}
```

Why each clause is there:
- **Order matters.** The claim is initialised first (`vrf.rs:81`, unchanged). If the player still has a
  live claim, the start fails there, as today, so a live game can never be reused.
- **`owned_by(&ID)`.** A still-delegated orphan (DLP-owned) is never touched. It falls through to `init`
  and fails as before.
- **Disc check.** A game zero-closed by `refund_stalled_vrf` earlier in the same transaction (still owned
  by the program, data zeroed) is not reused. It falls through to `init` and fails as before, so the
  existing differential tests `audit_refund_then_restart_same_tx` and
  `audit_zero_closed_game_recredited_same_tx` stay byte-identical.
- **`check_pda_find`** runs before `fill(0)`. Without it, a player could pass someone else's orphan in the
  game slot and take it over.
- **`fill(0)`.** The handler writes only the non-zero fields because it assumes fresh zeroed data
  (`vrf.rs:129`). Wiping the data keeps that assumption true. Stale reveals, `mine_mask`, `safe_reveals`
  and `pending` from the released game must not survive.
- **Checks deliberately left out:**
  - Data length: the program only ever creates this account at 621 bytes, and `process_undelegation`
    copies the same length back.
  - Rent-exempt: the program never debits game lamports except when closing it.
  - The `vg::PLAYER` field: the PDA seeds already bind the address to `pk`.

  In all three cases a broken account would make the transaction fail anyway, either through an
  out-of-bounds panic or the runtime rent check.

The handler is unchanged after Pass B. It writes the disc, status, player, session key, bump, mine count,
edge, pending tile and multiplier. The claim, the stats, the vault counters, `total_outstanding_max_payout
+= worst` and `enforce_min_health` all behave as for a fresh game.

Money effects of a reuse:
- The player pays the bet plus the claim rent, and no game rent.
- The game keeps its old lamports (the old rent, plus any dust someone sent to it). `settle_vrf` or
  `refund_stalled_vrf` returns them to the player when the new game closes.
- Nothing moves to or from the vault beyond the normal bet.

### 3.2 Everything else: none
- New instructions or discriminators: none.
- New error codes: none (the reuse path raises only 2006 and 2000, which `init` already raises).
- Events: none (`start_game_vrf` emits none).
- State or reserved bytes: none. VrfGame and VrfClaim have no reserved bytes, and none are needed.
- Constants or timeouts: none. A reuse is only possible after a release, which already enforces
  `ABANDON_SLOTS` (216,000 slots), or whatever window F3 sets.
- CU: the reuse path skips the `CreateAccount` CPI, so it is cheaper than a fresh start. Well within
  200,000.
- Docs: add an "F6 deviation" note to `spec/vrf.md` §1 Pass B and to `vrf.impl.md`.

## 4. Tests

New file `difftest/tests/fix_f6.rs`, using the same `world()`, `start_ix`, `release_ix`, `settle_ix`,
`refund_ix` and `deleg_ix` helpers as `audit_magicblock.rs`. After the divergent start, read the port side
with `p.port.get_account(&k)`. `p.get` panics once the two sides have diverged. Later `p.run` calls are
fine: inspect `d.port` and ignore `d.anchor`. The harness needs no change.

| # | Test | Asserts | Kills mutant |
|---|---|---|---|
| T1 | `f6_released_never_delegated_game_is_reused` (the MB-6 repro, flipped): start(1 mine, BET), warp `START_SLOT+216_001`, `admin_release` | `refund`/`settle` still fail (`assert_same`). `start(2 mines, BET, key("s2"))` fails on Anchor and is OK on the port. Port game decode: status 0, mine_count 2, session `s2`, reveal_count 0, safe 0, masks 0, pending false, pending_tile 255, mult 10_000. Game lamports equal the pre-start lamports. The player is debited exactly `BET + rent_min(69)`. The claim's `start_slot` is the new slot, and port `outstanding == claim.reserved`. Then warp +26, `refund_stalled_vrf(player)` is OK on the port, and the player gets back `BET + rent_min(69) + old game lamports`. Print the CU. | the whole fix |
| T2 | `f6_released_game_back_from_er_with_result_is_wiped`: start, `deleg_ix`, patch the DLP copy to Lost with reveal_count 1, masks and `reveals[0]` (as in MB-2), warp, `admin_release` while DLP-owned, then `process_undelegation` with those bytes (as in MB-1/MB-7) | `settle_vrf` still fails (`assert_same`). `start_ix` is OK on the port. In the port game data, `[93..621]` (the reveals) is all zero, `mine_mask` is 0, `safe_reveals` is 0 and status is Playing. Then `deleg_ix` is OK on the port. A second copy of the world runs `[start_ix, deleg_ix]` in ONE tx (the web client's atomic start) and is OK on the port. | dropping `fill(0)` |
| T3 | `f6_still_delegated_orphan_not_reused`: start, delegate, warp, `admin_release` while DLP-owned | `start_ix` → `assert_same().assert_failed()` (same system error on both sides) | dropping `owned_by(&ID)`: the mutant writes to a DLP-owned account and the runtime error differs |
| T4 | `f6_cannot_take_over_another_wallets_orphan`: make an orphan for A (as in T1). B's start with `game = pda::vrf_game(&A)` in slot 4 | `assert_err(2006)` on both sides. A's port game is unchanged (still A's player, status, lamports). | dropping `check_pda_find` |
| T5 | `f6_readonly_orphan_game_slot`: orphan as in T1, start with the game meta readonly | port code 2000 | dropping `check_mut` |
| T6 | existing tests, unchanged and still `assert_same`: `audit_refund_then_restart_same_tx`, `audit_zero_closed_game_recredited_same_tx` (audit_pinocchio.rs), and `sgv_second_start_fails`, `sgv_init_pda_owned_elsewhere`, `sgv_wrong_pdas`, `sgv_prefunded_claim_game_stats` (vrf.rs) | unchanged | dropping the disc check (the zeroed program-owned game would be reused and the parity breaks); a reuse while a live claim exists |
| T7 | `audit_magicblock.rs::mb6_*`: change the final `start_ix` assert from `assert_failed()` to "Anchor fails, port OK" (or delete it and keep T1). Nothing else in the 684-test suite changes. | full suite green: `cd difftest && cargo test -- --test-threads=2`, after `build.sh` | — |

Mutation check (on request): apply each mutant from the "Kills mutant" column to a scratch build and
confirm that the listed test fails.

## 5. Coordination with F3 (MB-1)

- F6 covers the aftermath of any F3 release. If F3 adds a house-run or permissionless release for idle
  delegated games that closes the claim and leaves the game (like `admin_release` does), every such game
  becomes an F6 orphan. Under C, that wallet can play again as soon as the game is back on L1. F3 needs no
  extra game-handling code for this.
- Contract F3 must keep:
  1. Any release must **close** the claim with `close_to` (owner → System, 0 lamports), not only mark it
     `settled`. Otherwise the claim `init` in `start_game_vrf` keeps failing and C never runs.
  2. F3 must not add any path that closes a claim while the game's L1 state can still be redeemed for
     money. C wipes that state on the next start.
- Case (b), still delegated: nothing on L1 can touch a DLP-owned account. If F3 lets the house call
  `settle_and_undelegate_vrf` after a timeout (today only the player or session key can), that must not
  depend on the claim (today it reads only the game). The house can then also undelegate an orphan, and C
  heals it on the next start. That shrinks case (b) to "the ER validator is dead", which is MB-7's trust
  domain anyway.

## 6. Client impact
- Required: none. The disc, args and accounts are unchanged. `use-vrf-game.ts` already sends
  `start_game_vrf` when no unsettled claim exists, which is exactly the orphan case, and the atomic
  `[start, delegate]` works on a reused game (T2).
- The player's balance preflight may over-estimate by one game rent. That is harmless.
- Optional follow-ups, not part of this fix:
  1. `api/cron/vrf-settle` first pass: skip a VrfGame whose claim PDA is missing. Today an orphan with a
     terminal status fails a `settle_vrf` preflight on every run. It costs no fees but adds log noise. This
     is already true under Anchor.
  2. In the `use-vrf-game.ts` start catch path, a DLP-owned game is taken as "start succeeded". For a
     still-delegated orphan (no claim), that drops the player into a dead game. Also require the claim to
     exist there.

## 7. Trade-offs and residual risk
- Honest players lose nothing compared with Anchor. Under Anchor the wallet was locked out for good and the
  rent was lost. Now it plays again and gets the rent back at the end of the next game.
- The released game's committed L1 result (for example a Won status that came back after the release) is
  overwritten when the player restarts. The money was already settled by the release (the bet was
  refunded), and the bytes stay in transaction history. If the owner wants to make good a win that a
  release cut short, they must read the game before the player restarts.
- Residual: in case (b), when the ER never undelegates, the wallet stays locked out of VRF mode (legacy
  mode still works) and the game rent stays with the DLP, as under Anchor. The F3 house-undelegate path, if
  adopted, narrows this.
- Residual: a player who never plays VRF again leaves one game rent in the PDA, as under Anchor. Option A
  would refund it; skipped as too small to justify a new instruction.
- MB-4 (stale fulfilment): a game that comes back with `pending = 1` and is then reused carries the same
  exposure as a game that was closed and re-created at the same address. The exposure does not get wider.
- Parity: `start_game_vrf` now diverges from Anchor in exactly one state (a program-owned, VrfGame-disc'd
  game PDA with no claim), where Anchor can only fail.
