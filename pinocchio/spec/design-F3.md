# design-F3: idle delegated VRF games freeze play (MB-1)

Status: design only, nothing is implemented yet. Repro: `difftest/tests/audit_magicblock.rs::mb1_idle_delegated_games_pin_bankroll`.

## 1. The finding, restated

`start_game_vrf` reserves the game's worst-case payout in `v2.total_outstanding_max_payout`. The reservation
is released only on L1, by `settle_vrf` / `refund_stalled_vrf` / `admin_release_vrf_claim`. While `VrfGame`
is delegated:

- L1 can't touch it: it is DLP-owned, so `refund_stalled_vrf` returns 6052 and `settle_vrf` returns 3007.
- Only `player` or `session_key` can call `settle_and_undelegate_vrf` on the ER.
- `admin_release_vrf_claim` needs 24 h and a Squads vote.

Capital doesn't limit the attack. At 5-7 mines a 0.001 SOL bet reserves 4-11 SOL (`worst <= max_payout` is the
only cap), so about 10-20 wallets with a dust bet each push health to the floor. Every bet comes back later
(undelegate, then refund). The attack is free and it lasts until the 24 h admin backstop.

## 2. What MagicBlock lets us do (checked, not assumed)

| Lever | Finding | Usable for F3? |
|---|---|---|
| ER-side `ScheduleCommitAndUndelegate` from our program (what `settle_and_undelegate_vrf` already does) | Our program can schedule it for any account it owns on the ER. The magic program does not care who signed the outer tx. Today only our handler's own check (`payer == player \|\| session`) limits it. | **Yes.** This is the fix. |
| DLP `RequestUndelegation` (disc 26) + `UndelegateWithRollbackAfterTimeout` (disc 27) | These exist in the **mainnet DLP we dumped** (`fixtures/dlp.so`, slot 465181840). The binary contains `UndelegationRequestNotExpired`, `request.expires_at_slot` and `undelegation_request.rs`. Source: magicblock-labs/delegation-program `dlp-v2`, `program/src/legacy/processor/fast/{request_undelegation,undelegate_with_rollback_after_timeout}.rs`. The timeout is `DEFAULT_UNDELEGATION_REQUEST_TIMEOUT_SLOTS = 9000` (~1 h). **The request needs `payer == delegation_metadata.rent_payer` as a signer.** For us that is the **player** (`delegate_game` passes `player` as the DLP payer). Rollback returns the *last finalized L1 state*, and the source warns it "might cause data-loss". | **No.** The house can't sign a request. Moving the rent payer to a program PDA would change `delegate_vrf`'s money flows. Even then, the 1 h rollback restores stale state and could wipe an honest uncommitted win. It is worth keeping as a *player-signed* escape hatch for a dead validator (MB-2 / F6 territory). It is out of scope here. |
| ER clock | Read-only RPC on 2026-11-04: `as.magicblock.app` Clock = slot 848,894,941, epoch 0, `unix_timestamp` 1793780743. Mainnet at the same moment: slot 465,234,061, same `unix_timestamp`. **ER slots are unrelated to L1 slots, and the wall clock agrees.** | An ER-side check can't compare against `claim.start_slot` (L1 slots). An on-chain idle check would need a stored unix timestamp, and no account has a free field for one (see Option A'). |
| Hydra / ScheduleTask ER cranks | Exist (SDK 0.17.x). | Not needed. The house relay already runs crons. |

## 3. Options

### Option A (CHOSEN): house-run ER crank `force_undelegate_vrf`, plus a `VOID` status

A new ER instruction, signed by `vault.house_authority`. It closes an idle delegated game in an EV-neutral way
and schedules commit + undelegate in the same instruction:

- `PLAYING`, no pending reveal, `safe_reveals > 0`: set `status = WON`. This is exactly what `cash_out_vrf`
  does, and `multiplier_bps` is already `calc_multiplier(safe)`.
- `PLAYING`, no pending reveal, `safe_reveals == 0`: set `status = VOID` (new value 3).
- `WON` / `LOST` / `VOID`: leave the data unchanged and only undelegate. This also lets the house undelegate
  a committed loss that the player is withholding (MB-2) whenever the ER is live.
- `pending == 1`: fail with `RevealPending`. The relay retries after the callback lands, which takes under 1 s.

Then, on L1 (unchanged paths): `WON` / `LOST` go through `settle_vrf`, which is permissionless and which the
existing cron already runs. `VOID` goes through `refund_stalled_vrf`. Its only change is that it now accepts
status `VOID` as well as `PLAYING`. Both paths release the reservation. `VOID` is not `PLAYING`, so the
existing checks already block every way back into play: `delegate_vrf` returns 6050, `cash_out_vrf` and
`reveal_request_vrf` return 6003, and `settle_vrf` returns 6003. That closes the re-delegation race
(attacker re-delegates between undelegation and refund).

- **Pros:** about 40 lines of program code. No change to any existing instruction's accounts, args or
  discriminator. No new errors. No state layout change. Zero ripple in the 684 existing parity tests, because
  only the new instruction and the new status value behave differently. Honest players never lose an accrued
  win, and the forced result equals what the player would get by cashing out or refunding.
- **Cons:** it needs the pinned ER validator to be up. If it is down we fall back to the 24 h admin release,
  which is the same as today. The idle timing is relay policy, not enforced on chain (see the trade-offs). An
  attacker bot can still *cycle* (start new games after each clear), at fee cost (section 9).

### Option A': A plus an on-chain idle floor

The same as A, plus storing a last-activity unix timestamp in the game. `start_game_vrf` would write the L1
clock, and `reveal_callback_vrf` / `cash_out_vrf` would write the ER clock. `force_undelegate_vrf` would then
require `now - last >= IDLE_SECS`. The only free bytes are `VrfGame.reveals[15]` (offsets 588..621, 33 bytes).
That slot is never written, because the maximum `reveal_count` is 16 - mines <= 15. It is not declared
reserved, though, and both the IDL and the SDK decode it as a reveal. The bigger cost: every existing VRF
parity test that starts a game or lands a callback would diverge on those bytes.

- **Pros:** the house can't end a game early.
- **Cons:** it gives no fund protection beyond A, because A's forced outcome is already EV-neutral and needs
  `pending == 0`. It abuses non-reserved bytes. Large test ripple.

Not chosen. It is the upgrade path if the owner wants an on-chain bound on the house later.

### Option B: DLP owner-requested undelegation + rollback after timeout

This is L1-only and survives a dead validator, but the house can't create the request (section 2). It would
need `delegate_vrf` to use a program-PDA rent payer: new accounts, rent routed back to players at
settle/refund, and a CPI path that has never been tested. Rollback restores the last *finalized* state, so a
player who won on the ER but whose commit hadn't finalized gets the stale state. The minimum timeout is
1 h. Rejected for F3.

### Option C: release the L1 reservation after a short timeout, keep the game

C would zero `claim.reserved` after T, and settle would recompute the cap from bet, mines and edge. It
breaks the solvency invariant, because a released game can still win on the ER without backing. It also
doesn't bound anything: the attacker refunds the bet and re-reserves. Rejected.

### Option D: caps (global VRF reservation cap, per-wallet cap)

Per-wallet caps are sybil-able at about 0.012 SOL of refundable rent per wallet. A global VRF cap only
shields legacy mode, and VRF mode still freezes. Not chosen. It can be stacked on A later if the owner wants
legacy mode insulated.

## 4. Exact spec (Option A)

### 4.1 Constant (`kaboom-p/src/consts.rs`, VRF block)

```rust
/// Zero-progress game the house closed for inactivity. Refundable (refund_stalled_vrf); never
/// delegable, revealable, cash-outable or settleable. Only force_undelegate_vrf writes it.
pub const VRF_VOID: u8 = 3;
```

There are **no new slot/timeout constants on chain.** The timing lives in the relay (4.6). Note that
`VrfGame.status` is a plain `u8` in the IDL and `vg::TYPE.checks` has no status entry, so 3 loads fine.

### 4.2 New instruction `force_undelegate_vrf` (runs on the ER only)

- Discriminator `sha256("global:force_undelegate_vrf")[..8]` = `[0xda, 0x30, 0xa3, 0xda, 0x54, 0xf8, 0xe4, 0x65]`.
- Log line `Instruction: ForceUndelegateVrf`.
- Table row (`ix/mod.rs`, appended last):
  `(FORCE_UNDELEGATE_VRF, [0xda,0x30,0xa3,0xda,0x54,0xf8,0xe4,0x65], "ForceUndelegateVrf", vrf::force_undelegate_vrf)`.
- Args: none. Trailing data is ignored, like every no-arg handler.
- Accounts (the first 4 mirror `settle_and_undelegate_vrf`, and the vault is appended):

| # | name | flags | check |
|---|---|---|---|
| 0 | house | W S | signer (3010), mut (2000), `== vault.house_authority` (6007) |
| 1 | game | W | `load(VrfGame)` (3012/3007/3001/3002/3003), seeds `[VRF_GAME_SEED, game.player]` with stored bump (2006), mut (2000) |
| 2 | magic_program | | `check_program(MAGIC_PROGRAM_ID)` (3008/3009) |
| 3 | magic_context | W | mut (2000), `== MAGIC_CONTEXT_ID` (2012) |
| 4 | vault | | `load(Vault)`, `check_vault_seeds` (2006). On the ER this is the read-only clone of the L1 vault. |

Fewer than 5 accounts returns 3005. On L1 the game is DLP-owned, so `load` returns 3007. That is the natural
"ER only" guard, and no extra check is needed.

Handler (load-bearing, write it this way):

```rust
pub fn force_undelegate_vrf(accounts: &mut [AccountView], _args: &[u8]) -> ProgramResult {
    let [house, game, magic_program, magic_context, vault, ..] = accounts else {
        return Err(NOT_ENOUGH_KEYS.into());
    };
    // Pass A
    check_signer(house)?;
    load(game, &vg::TYPE)?;
    check_program(magic_program, &MAGIC_PROGRAM_ID)?;
    load(vault, &vt::TYPE)?;
    // Pass C
    check_mut(house)?;
    check_game_seeds(game)?;
    check_mut(game)?;
    check_mut(magic_context)?;
    check_address(magic_context, &MAGIC_CONTEXT_ID)?;
    check_vault_seeds(vault)?;
    require(house.address().as_array() == rd_pk(&vault.try_borrow()?, vt::HOUSE_AUTHORITY), K::Unauthorized)?;
    // Handler: EV-neutral close of a live game; terminal states are only undelegated.
    {
        let mut d = game.try_borrow_mut()?;
        if d[vg::STATUS] == VRF_PLAYING {
            require(d[vg::PENDING] == 0, K::RevealPending)?;
            d[vg::STATUS] = if d[vg::SAFE_REVEALS] > 0 { VRF_WON } else { VRF_VOID };
        }
    }
    schedule_undelegate(house, magic_context, game, magic_program)
}
```

Refactor `settle_and_undelegate_vrf`'s last 6 lines into a shared helper
`fn schedule_undelegate(payer, magic_context, game, magic_program) -> ProgramResult`, using the same metas
`[payer WS, magic_context W, game W]` and the same `SCHEDULE_CAU_GAME` bytes. Both handlers call it. The CPI
bytes of `settle_and_undelegate_vrf` don't change, and its `assert_cpi_same` tests prove that.

Why `WON` is correct for `safe > 0`: `reveal_callback_vrf` always leaves `multiplier_bps = calc_multiplier(safe)`.
So `settle_vrf`'s replay accepts it exactly as it accepts a player `cash_out_vrf`: `lost = false`, `safe > 0`,
committed multiplier equals expected.

### 4.3 Changed instruction `refund_stalled_vrf` (one line)

`kaboom-p/src/ix/vrf.rs` line 739, before and after:

```rust
require(d[vg::STATUS] == VRF_PLAYING, K::GameAlreadyResolved)?;
require(d[vg::STATUS] == VRF_PLAYING || d[vg::STATUS] == VRF_VOID, K::GameAlreadyResolved)?;
```

Nothing else changes. The house branch (`safe_reveals == 0 && pending == 0`) holds for `VOID` by
construction. `STALL_SLOTS` has always passed by the time a VOID game reaches L1. Accounts, args and the
reservation release are unchanged.

### 4.4 Unchanged, and relied on

- `delegate_vrf`: `check_vrf_game_delegable` rejects non-PLAYING with 6050, so a VOID game can't re-enter the ER.
- `cash_out_vrf` / `reveal_request_vrf`: they require `PLAYING` (6003).
- `settle_vrf`: `replay` requires `WON|LOST` (6003 on VOID).
- `admin_release_vrf_claim`, `process_undelegation`: no change.

### 4.5 State, errors, events

- State: **no layout change, no reserved bytes used.** Only the new status value 3.
- Errors: **none appended.** It reuses 6007 `Unauthorized` and 6044 `RevealPending`. F3 takes no slot in the
  appended-code sequence, so the other designs can append freely.
- Events: none. The VRF instructions emit none today. The relay logs each force, and the settle/refund mirror
  write already feeds the indexer.
- `INSTRUCTIONS` grows from 42 to 43: update the host ABI test (`tests/abi.rs` count and table) and the IDL
  generator if it is checked against the table.
- CU: the same order as `settle_and_undelegate_vrf` (two loads, one PDA re-derive, one magic CPI), well under 200k.

### 4.6 House relay policy (apps/web: spec only, not edited here)

The relay adds one cron pass (in `/api/cron/vrf-settle`, which runs every 5 min via `.github/workflows/vrf-settle.yml`):

1. List live claims: `getProgramAccounts(VrfClaim disc)`. For each one whose game PDA is **DLP-owned on L1**,
   read the game from the ER RPC (`NEXT_PUBLIC_ER_RPC`).
2. Force (send `force_undelegate_vrf` to the **ER**, signed by the house key, ER blockhash) when any of these holds:
   - status `WON|LOST|VOID` and `nowSlot - claim.start_slot >= TERMINAL_GRACE_SLOTS = 150` (~60 s). This is a
     finished game the client never undelegated.
   - status `PLAYING`, `!pending`, and either
     - `IDLE_SECS = 300` have passed since the last ER activity, taken as the blockTime of
       `getSignaturesForAddress(game, {limit: 1})` on the ER, or `claim.start_slot` if there is none, or
     - `nowSlot - claim.start_slot >= MAX_AGE_SLOTS = 4_500` (~30 min). The age cap bounds an attacker who
       keeps the game "active" with reveals. Each reveal is real risk, and a game ends after at most
       16 - mines reveals.
3. Refund pass: for **program-owned** games whose raw status byte (`readVrfGameStatusByte`) is `3`, call
   `refund_stalled_vrf` as the house **immediately**, with no 24 h wait. The existing settle pass already
   handles forced `WON` / `LOST` once the validator undelegates (seconds).
   - Optional: inside the same run, poll the game owner for up to about 20 s after forcing, so force and
     refund finish in one cycle.
4. SDK `packages/sdk/src/vrf.ts`: `VrfStatus` gains `"Void"` (index 3). Today `VRF_STATUS[3] ?? "Playing"`
   maps it to Playing. Without the SDK change, VOID games are still refunded, but only by the existing
   24 h sweep, and the reservation stays held until then.

Worst-case freeze per attack game: 5 min idle + up to one cron cadence (5 min, GH Actions jitter can double
it) + seconds of undelegation + the refund pass. That is about 15-20 min, cleared automatically with no
Squads vote.

## 5. Coordination with F6 (same release path)

- `force_undelegate_vrf` takes **no claim**. It can bring back a game whose claim was already closed by
  `admin_release_vrf_claim`, which is exactly the F6 orphan. F6's orphan-close path must therefore accept
  any status, including `VOID` (3), and close the game when it is program-owned with no live claim.
- After F3 the 24 h `admin_release_vrf_claim` is needed only when the ER validator is down. F6 should keep
  it, and should close the game there too when it is program-owned.
- The player-signed DLP `RequestUndelegation` + rollback (section 2) is the natural future self-help for a
  dead validator. That belongs to F6 / MB-2, not to F3.

## 6. Honest-player outcomes (vs the Anchor program)

| Situation | Anchor | After F3 | Funds lost? |
|---|---|---|---|
| Active player (taps within 5 min, game < 30 min) | plays | unchanged (relay never forces) | no |
| Zero reveals, walked away >= 5 min, still delegated | bet locked until they return and refund, or a 24 h sweep | VOID, then full bet refund (+ claim/game rent) | no |
| k safe reveals, idle >= 5 min or game >= 30 min | can cash out later at mult(k) | cashed out at mult(k) automatically | no. Same amount; loses only the *option* to keep playing |
| Won/cashed out but client died before undelegating | stuck until the player undelegates | undelegated after ~60 s and settled by the cron | no (faster) |
| Lost but never undelegated | stuck; at 24 h the admin release *refunds the lost bet* (MB-2) | undelegated and booked as a loss | no (closes MB-2 while the ER is live) |
| Reveal in flight at crank time | n/a | force fails 6044 and retries later; the reveal resolves normally | no |
| Player's reveal / cash-out races the force on the ER | n/a | ER serialises them. Either the player's tx wins (the relay sees activity) or the force wins and the player's tx fails 6003 / undelegating. The accrued multiplier is paid either way | no |

**Explicit trade-off:** an idle player with progress is cashed out at the current multiplier rather than left
to continue. Because `calc_multiplier` applies the edge once (`fair(k) x (1 - edge)`), continuing has
EV = current multiplier (to within floor rounding, < 1 bps). The forced cash-out is therefore EV-neutral.
The player loses variance, not value. A forced result is never `LOST`.

## 7. Tests (new file `difftest/tests/fix_f3.rs`)

Harness: Anchor has no `force_undelegate_vrf` (it returns 101), so these tests assert on the port side.
The minimal harness addition, shared by all F-fix tests, is `Pair::run_port(&mut self, ixs) -> Outcome`
(the existing private `exec` on `self.port` only) plus reads through `p.port.get_account(&k)`.

1. **`f3_force_zero_progress_voids_then_refunds`**: start a max-bet game and delegate it. Put the game in its
   ER view with `er_game`. House runs force: port ok, status 3. The CPI to `MAGIC_PROGRAM_ID` has data
   `SCHEDULE_CAU_GAME` and metas `[house WS, MAGIC_CONTEXT W, game W]`. Then run `undeleg_setup` +
   `process_undelegation`. Assert that `delegate_vrf` gives 6050, `cash_out_vrf` gives 6003 and `settle_vrf`
   gives 6003. Warp to START+26. House `refund_stalled_vrf` succeeds: the player gains bet + game rent +
   claim rent, `total_outstanding_max_payout == 0`, and claim and game are closed.
2. **`f3_force_with_progress_pays_cash_out`**: 1 mine, 2 safe callbacks, then force. Assert status 1 and
   `multiplier_bps == calc_multiplier(2,1,edge)`. Undelegate, then `settle_vrf` by the house. The player gain
   must equal a control world where the player called `cash_out_vrf` and settled (same lamports, same stats).
3. **`f3_force_terminal_unchanged`**: (a) a LOST game, (b) a full-clear WON game. Force succeeds and the game
   data bytes are identical before and after. After undelegation, `settle_vrf` books the loss or pays the win.
4. **`f3_force_pending_rejected`**: `pending = 1` gives 6044. After the callback the force succeeds.
5. **`f3_force_auth_and_accounts`**: stranger, player and session as signer each give 6007. Unsigned house
   gives 3010, read-only house or game gives 2000, a wrong magic_context gives 2012, magic_program = VRF
   program gives 3008. A vault copied to a fake address gives 2006, a game copied to a fake address gives
   2006, the claim passed as game gives 3002, and a DLP-owned game (L1 view) gives 3007. Four accounts give
   3005. A rotated `house_authority` (patch vault offset 40): the old key gives 6007 and the new key passes.
6. **`f3_force_void_idempotent`**: force twice in the simulated ER view; status stays 3 and both succeed.
7. **`f3_player_refunds_own_void`**: after undelegation the player's own `refund_stalled_vrf` on a VOID
   game succeeds.
8. **`f3_mb1_cleared`** (port-side rewrite of `mb1_idle_delegated_games_pin_bankroll`): the same 10+
   max-bet attackers, and the honest start fails. For each attacker: force, undelegate, house refund. Then the
   honest `start_game_vrf` **and** the legacy `start_game` succeed and outstanding is back to 0. Re-delegating
   any VOID attacker game gives 6050.
9. **Regression**: the full existing suite stays green with zero new diffs, in particular
   `sau_happy` / `sau_errors` (`assert_cpi_same`, which proves the helper extraction) and the refund
   `status 1 -> 6050` cases. `mb1_*` and `mb2_*` in `audit_magicblock.rs` keep asserting the inherited
   behaviour on both sides for existing instructions, which is still true. Add a comment pointing to
   `fix_f3.rs`.
10. **CU**: print the port CU of force. Assert it is < 200,000 and within +3k of `settle_and_undelegate_vrf`.
11. Host ABI test: 43 instructions, and the new discriminator equals `sha256("global:force_undelegate_vrf")[..8]`.

**Must also be checked on mainnet before announcing (owner-run, min-bet game).** These
can't be shown in LiteSVM:
- the ER loads the 5-account tx and serves the vault clone;
- the house key works as the ER fee payer;
- the committed L1 state carries the status written in the same instruction;
- the house refund of the VOID game succeeds.

## 8. Client impact

- No existing instruction changes its discriminator, args or accounts. The web client and SDK keep working.
- SDK: add `"Void"` to `VrfStatus`. Add a `buildForceUndelegateVrf({ctx, house, player})` builder (5 accounts, order above).
- Relay: one new ER-sending pass plus an immediate VOID refund (4.6). It needs an ER `Connection` on the
  server and house signing of ER txs.
- Game UI (`use-vrf-game.ts`, `GameRecoveryBanner.tsx`): treat `Void` as terminal ("closed for
  inactivity, bet refunded"). A session-key reveal after a force fails 6003, and the UI should re-read the
  game rather than show a generic error.

## 9. Residual risk

- **Cycling is not eliminated.** A bot can start fresh games after each clear and hold the bankroll near the
  floor for as long as it runs. Each game-cycle costs about 2 L1 tx fees plus refundable rent churn, and the
  freeze lifts within about 15-20 min of the bot stopping. This meets the "short and automatically cleared by
  a house crank" bar, not "pays real cost". Making zero-progress cancels costly would also charge honest
  cancels, because the attacker can self-undelegate and self-refund before the crank. So no cheap cost lever
  exists. Owner levers: a lower `vrf_max_payout_bps` (more games needed), and a faster crank cadence.
- **ER dependency:** if the pinned validator is down, the crank can't run, and the fallback is the 24 h
  Squads `admin_release_vrf_claim` (today's behaviour).
- **House trust is extended:** a compromised house key can end any live delegated game at any moment. It
  gains nothing: the outcome is EV-neutral, there is no information edge because `pending == 0` is required,
  and it can't force a loss or pay itself. It is still a griefing power. Option A' is the on-chain upgrade.
- **ER vault clone staleness:** right after a `house_authority` rotation the ER may briefly accept the old key.
- **Unchanged:** validator trust (MB-7; a forged commit could also write VOID, which only means a refund) and
  MB-4 stale fulfilment.
