# On-chain integration for the relaunch (raw house key, VRF-only, Pinocchio program)

Date: 2026-11-04. Lane: apps/web, apps/realtime, packages, scripts. Nothing was deployed, committed, signed or sent on
chain. Read-only mainnet RPC was used once (see "Deployed program check").

Program `Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju`, deployer (F1) `qouUoXTxNrFYw9DA7yCAnPXfAi9ypNWq2HPf5UMF9WG`,
MagicBlock validator `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` (`https://as.magicblock.app/`), unchanged.

## Deployed program check (read-only, 2026-11-04)

A simulated `start_game` against mainnet returns **3012 AccountNotInitialized, not 6057**. The deployed program is the
F1-F6 build (202,904 bytes), not the VRF-only upgrade (195,800 bytes, sha256 `bb291333...023c`, = the local
`kaboom-p/target/deploy/kaboom.so`). The vault is not initialized.

**Order matters:** deploy the VRF-only upgrade BEFORE `initialize_vault`. Between an init and the upgrade the old build
accepts `start_game`, and with a raw house key on the server that is the drain the upgrade closes.
`scripts/init-vault-mainnet.ts` enforces it: it simulates `start_game` and aborts unless the program answers 6057.

## Bootstrap order (lead)

1. `solana program deploy` the VRF-only `.so` as an upgrade (fits the existing ProgramData, no `extend`).
2. `DRY_RUN=1 npx tsx scripts/init-vault-mainnet.ts --house <HOUSE_PUBKEY>`, then without `DRY_RUN`.
   Signs with `keypairs/mainnet-deployer.json`; refuses unless that key is `qouUo...9WG` (else 6055). `--house` takes
   the PUBLIC key of the keypair that becomes `HOUSE_SECRET_KEY` (`solana-keygen pubkey <file>`); the secret is never
   an input to any script. Args unchanged: edge 200, max bet 200, max payout 5000 bps; treasury = deployer (temporary).
3. `fund_vault` (>= 1 SOL above rent; no script, use the SDK builder or the CLI).
4. `npx tsx scripts/init-v2-mainnet.ts` (now computes the rent floor from chain instead of a stale constant).
5. `npx tsx scripts/enable-vrf-mainnet.ts --max-payout-bps <BPS>` (NEW): `update_v2_config(vrf_mode_enabled=true,
   vrf_validator=MAS1Dt9q..., vrf_max_payout_bps)`. Without it every `delegate_vrf` fails 6053. Warns if
   `withdraw_cooldown_slots < 450,000` (F4 rule; the init default 648,000 is fine).
6. `npx tsx scripts/rotate-to-squads-mainnet.ts` when ready (program id updated only; Squads vault `464FeYiv...VP5`
   unchanged, confirm it is still the intended owner/treasury).
7. Fund the house key (fees for settle, refunds, ER forces, LP completions; vault-health warns < 0.1 SOL).
8. Owner-run mainnet check of F3 on the real ER at minimum bet (FIXES 4.2): the ER accepts the house-signed
   `force_undelegate_vrf`, the house can pay ER fees, the commit carries the status, the VOID refund lands.

## 1. House signer (Turnkey removed)

- `apps/web/src/server/house-signer.ts` (replaces `turnkey-signer.ts`): same `HouseSigner` interface
  (`publicKey`, `signTransaction`) and `getHouseSigner()`. Reads `HOUSE_SECRET_KEY` as base58 or a JSON byte array,
  64 bytes, public half checked against the secret (web3.js validation). Errors name the problem only; the JSON parse
  error (which quotes input) is never rethrown. Only the pubkey leaves the module.
- Boot check: `apps/web/src/instrumentation.ts` validates the key when the server starts (not during `next build`).
  Production: a missing or malformed key prints `[boot] <reason>` and exits 1 (Next alone would keep serving 500s).
  Dev without a key: a warning. Verified with `next start`: `[1,2,3]` exits 1; a valid key logs the pubkey.
- `server/env.ts`: `housePubkey()` = signer pubkey; Turnkey config gone; `PROGRAM_ID` defaults to the relaunch id
  and refuses any other value; `SOLANA_RPC` has no devnet default (throws); new `erRpc()` (`ER_RPC` or
  `NEXT_PUBLIC_ER_RPC`, no default).
- Logger redacts `HOUSE_SECRET_KEY`, `houseSecretKey`, `secretKey`; the Turnkey/HOUSE_AUTHORITY_KEY names removed.
- `@turnkey/sdk-server`, `@turnkey/solana` uninstalled (lockfile has 0 `@turnkey`). Scripts that imported them were
  deleted: `turnkey-transfer.ts`, `sign-smoke.ts`, `full-game-smoke.ts`, `test-referral-end-to-end.ts` (the last two
  also drove the legacy start, now 6057). `rotate-house.ts` now takes `--house <pubkey>`, mainnet RPC required.
- UI/copy: `/vault` shows the house signer read from chain (`/api/vault/state` now returns `houseAuthority`) instead
  of the hardcoded Turnkey address; the home page drops "House signing on Turnkey HSM"; the privacy page drops Turnkey
  and Vercel (Railway hosts app + DB; the house key is a server-side Railway secret).
- vault-health pass alerts when the `HOUSE_SECRET_KEY` pubkey differs from `vault.house_authority`.

## 2. Program id everywhere

- `packages/shared`: `KABOOM_PROGRAM_ID`, `KABOOM_DEPLOYER`, `WITHDRAW_CLAIM_WINDOW_SLOTS = 9_000`.
- Server `programId()` and client `PROGRAM_ID` (`lib/cluster.ts`) default to it; a different `PROGRAM_ID` /
  `NEXT_PUBLIC_PROGRAM_ID` throws (the build fails on the client side). Client cluster defaults to `mainnet-beta`.
- Relay `alchemy-logs.ts`: always subscribes to the relaunch id; a different `KABOOM_PROGRAM_ID` env value is ignored with a warning.
- Scripts: `init-vault-mainnet.ts`, `init-v2-mainnet.ts`, `rotate-to-squads-mainnet.ts`, `rotate-house.ts`,
  `enable-vrf-mainnet.ts` (new), `diagnose-user.ts`, `health-diagnose.ts`, `list-stuck.ts`, `referrals-by.ts`,
  `show-referral.ts`, `repair-vault-mirror.ts`, `verify-deploy.sh` (id only; its Vercel API sections do not apply on
  Railway, noted in its header). Devnet-default scripts (`rotate-owner`, `transfer-upgrade-authority`,
  `upgrade-program-via-squads`, `initialize-v2`, `rotate-treasury`, `squads-status`, `init-vault`, `test-*`) untouched:
  mainnet-only rule, do not use.
- IDL: `target/idl/kaboom.json` still embeds the old id (in `delegate_vrf` buffer PDA). Nothing in apps or packages
  loads it; the SDK derives every PDA under `ctx.programId`, and `sdk_flows.rs` proves `delegate_vrf` byte-equal to
  the harness builder derived under the new id. Not regenerated (Anchor sources are off limits).
- Not in code (lead): Railway env values; docs `HANDOFF.md`, `README.md`, `docs/*` still show the old id/PDAs.

New fixed addresses (checked by `tests/sdk/relaunch.test.ts`): vault `7dPQVB4GPQMGLWiuvALUFrnrWip83Csj2Qjgb2kYTeg7`
(bump 254), v2 `Gtkn8TeTHgMF6bhEYmXy3cDcmmQyjbbY3WHXtY3td8Ue` (255), identity
`7LmGUyc5oTRr4RJpYmHf4g6gE5SeA2t5nW3DD2DepMuK`.

## 3. SDK, server and UI per FIXES.md 9

SDK (`packages/sdk`):
- `buildExpireGame` (disc `d0155783f22bfc90`, `[vault W, v2 W, game W, player W]`).
- `buildForceUndelegateVrf` (disc `da30a3da54f8e465`, `[house WS, game W, magic r, magic_context W, vault r]`).
- `buildCompleteWithdraw({ userSigns })`, default true; the keeper passes false.
- `VrfStatus` gains `"Void"` (3); an unknown status byte now throws instead of reading as Playing.
- Error names 6055 `NotDeployer`, 6056 `WithdrawWindowExpired`, 6057 `LegacyModeDisabled`.
- `buildStartGame` kept (ABI coverage, and the init script's 6057 probe); documented as rejected.

Server (`apps/web`):
- VRF-only: `/api/commit`, `/api/reveal`, `/api/settle` deleted (commit-reveal start and play); with them
  `StartGameInput`/`RevealTileInput`/`SettleInput`, `createGameSession`/`generateMineLayout`/`checkTile`,
  `apiCommit`/`apiReveal`/`apiSettle`, and the now-unused `requireActiveGame`/`playerHasActiveGame`/
  `confirmOutcomeSettled` and `lib/ws-confirm.ts`. Wind-down kept: `/api/cleanup`, the legacy branch of
  `/api/session/[player]` and `GameRecoveryBanner`, `session-store`, `/api/admin/release-stuck-obligations`, and the
  cron's `expire_game` pass.
- F5: `fetchPlayerReferrer` no longer swallows RPC errors or caches them; `bustPlayerReferrer` added.
  `server/vrf-settle.ts::sendSettleVrf` passes the referral PDA and on a 6022 busts the cache and retries once; used by
  `/api/vrf/settle` and the cron. Legacy `settle_game` now always passes the referrer too: `/api/cleanup` and
  release-stuck-obligations used to skip the referrer's cut.
- `/api/vrf/settle`: VOID -> 409 "refund instead"; mirror write only after the settle confirms (shared helper).
- `/api/session/[player]`: reads the L1 game once it is program-owned (a forced game shows Won/Void) and the ER only
  while delegated; uses `vrfModeEnabled()` and `ER_RPC`.
- `server/solana.ts`: `sendHouseErTx` (house-signed ER tx: ER blockhash, no compute-budget ixs, preflight on) and
  `waitConfirmed`. `server/connection.ts`: `getErConnection()`.
- `/api/version` uses `RAILWAY_DEPLOYMENT_ID` (stale-tab guard: an old tab reloads instead of calling the deleted
  commit-reveal routes).

UI:
- `use-game-actions.ts` is VRF-only (thin wrapper over `use-vrf-game`); `VRF_MODE_ENABLED` is now
  `ER_RPC_URL.length > 0` (`NEXT_PUBLIC_VRF_MODE_ENABLED` dropped). **`NEXT_PUBLIC_ER_RPC` must be set at build time
  on mainnet or nobody can start a game.**
- Referral bundling moved: the legacy start used to put `set_referrer` in the player's first start tx; that now
  happens in the VRF start tx (`[set_referrer, start_game_vrf, fund session, delegate_vrf]`, one signature), then
  `/api/ref/confirm` as before. Tested on the port (CU < 200k).
- Void: `use-vrf-game` treats a 6003 from a session-key reveal/cash-out as "closed for inactivity", re-reads the game
  through recovery (settle if Won, refund if Void) and toasts; recovery waits for undelegation even when its own
  undelegate is refused (the house already scheduled it), then reads the committed L1 copy; `refundOnly` accepts Void;
  `waitForCommittedResult` accepts Void. F6: the start catch path requires a claim before treating a DLP-owned game as
  started. `GameRecoveryBanner`: "ROUND CLOSED FOR INACTIVITY" with an instant refund.
- `lp-panel.tsx`: ready state "Ready — completes automatically" (+ the manual button stays); expired state
  (`slot > unlock + 9,000`) with RESTART WITHDRAWAL = `[cancel_withdraw, request_withdraw(same units)]` in one tx
  (`use-vault-lp.ts::restartWithdraw`, built client-side with the SDK; `signAndSend` takes several instructions).
- `lib/program-errors.ts` is keyed by name from the SDK list (fixes the pre-existing wrong 6001-6004 mapping, adds
  6041-6057).

## 4. Crons

See `crons.md`: one authenticated tick route `/api/cron/tick`, advisory lock, passes indexer, vrf (9.3 a/b/c/c'),
legacy (d/e), lp-complete (f), vault-health, invariants. `/api/cron/vrf-settle` and `/api/cron/vault-health` removed.

## 5. Tests (all foreground, all green)

| check | result |
|---|---|
| `npx turbo run typecheck --force` (web, realtime, sdk, shared, sdk-tests, anchor-tests) | 6/6 |
| `npm test --workspace=@playkaboom/sdk-tests` | 719/719 (711 + 8 new in `tests/sdk/relaunch.test.ts`: discs and metas of the 2 new builders, unsigned complete, Void + unknown status, 6055-6057, fixed PDAs) |
| `npm test --workspace=@playkaboom/web` (new) | 3/3 `house-signer.test.ts`: base58 = JSON, 6 malformed inputs with messages that never contain the input, boot check, valid signature |
| `npm run test:db --workspace=@playkaboom/web` on a fresh migrated `kaboom_rw_test` | 11/11 (7 data-layer + 4 new `cron/tick.test.ts`) |
| `npm run build --workspace=@playkaboom/web` / `@playkaboom/realtime` | pass (web needs `NEXT_PUBLIC_PROGRAM_ID` unset or = the new id; the local `.env.local` value was overridden on the command line) |
| `next start` smoke | bad key exits 1; tick 401 without/with wrong bearer; full tick ran; concurrent ticks gave one `ran:false` |
| difftest `tests/sdk_flows.rs` (new, port `.so` sha `bb291333...`) | 7/7, see below; `smoke` 8/8 and `spec_table` 2/2 rerun |

`pinocchio/difftest/sdk_fixture.ts` writes `fixtures/sdk_ixs.txt` from the real TS SDK for the harness's keys;
`sdk_flows.rs` then:
- `sdk_builders_byte_exact`: 22 SDK instructions equal the IDL builders (Anchor-era) or FIXES.md (the 2 new ones),
  program id + every meta + data; discs equal `sha256("global:<name>")[..8]`.
- `sdk_start_delegate_settle_with_referral`: the web's 4-ix start tx (both programs agree, CPIs equal), ER reveal +
  callback, cash-out, settle_and_undelegate, process_undelegation, then the same settle without the referral PDA is
  refused 6022 by the port (simulated) and the SDK settle with it pays the referrer.
- `sdk_refund_never_delegated` (9.3.c'), `sdk_force_undelegate_then_void_refund` (9.3.b + c, port-only: VOID then
  refund), `sdk_expire_legacy_game` (9.3.d, port-only, Expired + bet back), `sdk_lp_complete_unsigned_by_keeper`
  (Anchor 3010, port pays position.user), `sdk_lp_restart_after_window` (6056 after unlock+9,001, then
  `[cancel, request]` accepted with a new cooldown).
Regenerate after any SDK change: `npx tsx pinocchio/difftest/sdk_fixture.ts` (repo root), then
`cargo test --test sdk_flows -- --test-threads=2` in `pinocchio/difftest`.

## 6. Removed (list for the lead)

- Routes `/api/commit`, `/api/reveal`, `/api/settle`, `/api/cron/vrf-settle`, `/api/cron/vault-health`.
- Client legacy start/reveal/cash-out/cleanup actions in `use-game-actions.ts` (the recovery banner keeps the legacy
  wind-down instructions).
- Scripts `turnkey-transfer.ts`, `sign-smoke.ts`, `full-game-smoke.ts`, `test-referral-end-to-end.ts`.
- Env: `HOUSE_AUTHORITY_KEY` (now `HOUSE_SECRET_KEY`), `USE_TURNKEY`, `TURNKEY_*`, `NEXT_PUBLIC_VRF_MODE_ENABLED`;
  the tick route does not accept `CRON_SECRET`.

## 7. Open items

- Upgrade before init (top of this file). The F3 force path is not proven against the real ER (harness uses a noop
  magic program): owner check 8 above, and whether the ER accepts the house (an L1-only account) as fee payer.
- `apps/web/src/server/api-helpers.ts::clientIp` trusts the first `x-forwarded-for` hop (inventory 4): verify
  Railway's proxy before relying on per-IP rate limits. Not changed here.
- FIXES section 10 residuals (dust-game cycling, F4-0 LP self-timing) remain owner decisions.
- `scripts/health-diagnose.ts` and `scripts/repair-vault-mirror.ts` still import `@supabase/supabase-js` (gone from
  the lockfile); they no longer run. `test-stuck-game-recovery.ts` still uses the legacy start (6057).
- turbo.json does not pass through `NEXT_PUBLIC_ER_RPC` / `NEXT_PUBLIC_PROGRAM_ID` (cache key gap, data-layer note).
