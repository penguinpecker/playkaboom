# difftest: Anchor reference vs kaboom-p, same tx, two LiteSVMs

Every test builds one transaction and runs it on two VMs:

- **anchor**: `../anchor-ref`, the Anchor source at `e82f2c5` with `ephemeral-rollups-sdk` bumped to `=0.16.2` and `declare_id!` set to the new id. Its `.so` is 1,035,960 bytes.
- **port**: `../kaboom-p/target/deploy/kaboom.so`.

Both VMs use program id `Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju` and the same fixtures. The harness then compares the two runs as the DIFF POLICY requires.

## Run

```sh
./build.sh                         # rebuild both .so files (foreground, ~35 s cold)
./build.sh test                    # rebuild, then run every test file
./build.sh test smoke              # rebuild, then run only tests/smoke.rs
./build.sh test smoke vrf_full     # ... and only tests whose name contains "vrf_full"
cargo test --test my_group -- --test-threads=2 --nocapture   # no rebuild
```

Notes:

- `rust-toolchain.toml` pins rustc **1.98.1**, which is installed. litesvm 0.18.2 needs at least 1.97.1, and the default stable here is 1.95.
- `cargo-build-sbf` runs on its own toolchain.
- Use at most `--test-threads=2`, and run only one `cargo test` process at a time. Each `Pair` holds two VMs.
- Put each scenario group in its own file, `tests/<group>.rs`, and start it with `use difftest::*;`.

## Diff policy as implemented (`Pair::run` -> `Diff`)

A disagreement goes into `d.diffs`, and `assert_same()` panics on it. The panic prints the report and both log sets. These count as disagreements:

1. **Result.** The two sides do not end the same way. Either one succeeds and the other fails, or both fail with a different `TransactionError`. The error comparison is exact (custom code, framework code, or system error).
2. **Instruction log lines.** The `Program log: Instruction: X` lines differ, compared in order.
3. **Events.** The `Program data:` payloads differ. They are compared decoded, in order, at all depths. The report names each event.
4. **Accounts.** Any message key except the kaboom program ends the tx with a different account. The checks are existence, lamports, owner, executable, data length and data bytes. The report gives the range of bytes that differ, with hex for both sides.
5. **CU.** The port uses more than **200,000 CU**. Both VMs run with a 1,400,000 limit, so Anchor-side CU never changes the outcome. `d.cu()` returns `(anchor, port)`.

Accepted deviations go into `d.accepted` and do not fail the test:

- Anchor fails with `ProgramFailedToComplete` (a panic) while the port returns any error from the same instruction.
- The port returns `3005` while Anchor fails differently, and the instruction has fewer accounts than the IDL declares.

Two other accepted deviations need no harness code. The `AnchorError ...` text lines are never compared. The 7 IDL-management instructions (Anchor handles them, the port returns 101) should not be diffed.

CPIs (program, resolved account keys, data, stack height) are compared too, but they go into `d.cpi_diffs` and are **not** part of `assert_same`. Call `.assert_cpi_same()` where the CPI bytes matter: VRF request, DLP delegate, magic intent, system CPIs. One known accepted CPI-level difference: `delegate_vrf` closes the buffer with a lamport move, not a system Transfer. It is invisible when the buffer holds 0 lamports, the normal case.

## API (src/lib.rs, src/idl.rs)

| item | what |
|---|---|
| `Pair::new()` | Two VMs set up as follows. Mainnet feature set and Rent (5080 lamports/byte, threshold 1.0). Clock `START_SLOT = 465_000_000`, `START_UNIX = 1_793_000_000`. sigverify, blockhash check and tx history are off. Fixtures loaded. `p.payer` is the default fee payer, with 1M SOL. |
| `p.run(&[ix..]) -> Diff` / `p.run_as(fee_payer, ..)` | One tx on both sides. Signatures are placeholders, so any `AccountMeta { is_signer: true }` counts as signed, PDAs included. |
| `p.ok(&[ix])` | `run` + `assert_ok` |
| `Diff::assert_same / assert_ok / assert_err(code) / assert_failed / assert_cpi_same` | Each one asserts same-ness first. `assert_err(6007)` requires both sides to return `Custom(6007)`. |
| `d.anchor`, `d.port` (`Outcome`) | Fields: `err`, `code()`, `cu`, `logs`, `ix_lines`, `events`, `cpis`, `post` |
| `d.report()`, `d.is_same()`, `d.cu()` | Report text, a bool, and `(anchor CU, port CU)` |
| `p.set_account(k, Account)` | Same account on both sides |
| `p.run_legacy(&[ix..]) -> Diff` / `p.run_legacy_as(fee_payer, ..)` | VRF-only upgrade: a tx with a legacy `start_game`. Asserts the port failed 6057 (`LEGACY_MODE_DISABLED`) after logging `Instruction: StartGame`, then copies Anchor's post-state of every message key onto the port, so legacy wind-down tests keep running on both sides. Panics if the sides already disagree on an account of the tx. `p.start_game(..)` uses it. |
| `Diff::vrf_only / anchor_ok / anchor_err(code) / anchor_failed` | Port refused with 6057; the `anchor_*` forms also check the Anchor reference's own result. |
| `DEPLOYER` / `p.deployer() -> key` | F1: the only key the port lets sign `initialize_vault`; `deployer()` funds it with 100 SOL. `init_vault` / `house_world` use it as the owner. |
| `p.fund(k, lamports)` / `p.user("label") -> key` | System account. `user` derives a deterministic key from the label and gives it 100 SOL. |
| `p.set_data(k, owner, bytes)` / `p.set_program_account(k, bytes)` | Rent-exempt account with these bytes. Use it for fake state. |
| `p.patch(k, \|data\| ..)` | Edit the bytes of an existing account on both sides |
| `p.warp(slot)` / `p.slot()` | Set the slot on both sides (Clock sysvar) |
| `p.get(k)` | Returns the account. Panics if the two sides have already diverged on it. `p.get_both(k)` returns both sides. `p.lamports(k)` returns the balance. |
| `p.read(&k, accounts::Vault::decode)` | Decodes the account. Both sides must agree. |
| `ix::<Pascal> { .., ..Default::default() }.ix(args..)` | Builders for all 42 instructions, generated from the IDL. See below. |
| `ix::<Pascal>::DISC / NAME / ACCOUNTS`, `ix::ALL`, `ix::by_disc` | Discriminator, log name, and `(name, writable, signer)` for each account |
| `accounts::{GameSession, LpPosition, PlayerStats, ReferralAccount, Vault, VaultV2State, VrfClaim, VrfGame, GameStatus, VrfReveal}` | Borsh structs. `T::decode(&data)` checks the discriminator. `t.encode()` writes the discriminator, then Borsh, padded to `T::SPACE`. |
| `ids::*` | Fixed addresses: `SYSTEM`, `DLP`, `VRF_PROGRAM`, `ORACLE_QUEUE`, `MAGIC_PROGRAM`, `MAGIC_CONTEXT`, `SLOT_HASHES`, `VAULT`, `V2_STATE`, `IDENTITY`, `SCOPED_VRF_IDENTITY` |
| `pda::*` | `game`, `game_v2`, `stats`, `lp`, `referral`, `vrf_claim`, `vrf_game`, `buffer(game)` (under the program), `delegation_record`, `delegation_metadata`, `undelegate_buffer(base)` (under the DLP), `find(seeds, program)` |
| `key(label)`, `rent_min(len)`, `commitment(layout, mines, &salt)`, `event_name(payload)`, `fmt_err(&err)` | Small helpers |
| `delegate_vrf_ix(player)` | `delegate_vrf` with all its PDAs. Push the validator onto `.accounts` yourself. |

### Builders

Each builder struct has one field per account, in IDL order. `Default` fills in these fields:

- fixed addresses: system, DLP, VRF, magic program and context, SlotHashes, oracle queue;
- `owner_program`, set to the NEW id (the IDL still shows the old one);
- the constant-seed PDAs: `vault`, `v2_state`, `program_identity`.

Every other field defaults to the zero address, so set every one you need. A forgotten field fails the same way on both sides and so passes silently.

`.ix(args)` encodes `disc ‖ borsh(args)` and returns a plain `Instruction`. Negative tests edit the returned instruction:

```rust
let mut i = ix::SettleGame { game, player_stats, house_authority: w.house, treasury: w.treasury, ..Default::default() }.ix(layout, salt);
i.accounts[4].is_signer = false;                                  // missing signer   -> 3010
i.accounts[0].is_writable = false;                                // not mut          -> 2000
i.accounts.push(AccountMeta::new(pda::referral(&r), false));      // remaining_accounts[0]
i.data.truncate(20);                                              // short args       -> 102
i.data[8] = 2;                                                    // bad bool/Option tag (where the arg is one)
i.accounts.truncate(3);                                           // 3005 (accepted early-3005 deviation)
p.run(&[i]).assert_err(3010);
```

`tests/spec_table.rs` checks every builder against `spec/shared.md` section 9: discriminator, log name, account order and W/S flags. To regenerate the builders, run `python3 -I gen_idl.py`. It reads `../../target/idl/kaboom.json`.

## Quick setups (each one asserts zero diffs as it goes)

```rust
let mut p = Pair::new();
let w = p.house_world();      // initialize_vault(100, 100, 1000) + fund_vault(50 SOL) + initialize_v2 -> World { owner, house, treasury }
// or step by step: p.init_vault(edge, max_bet, max_payout); p.fund_vault(funder, amt); p.init_v2(&w);
let lp = p.user("lp");
p.ok(&[ix::LpDeposit { position: pda::lp(&lp), user: lp, ..Default::default() }.ix(LAMPORTS_PER_SOL)]);
let player = p.user("player");
let game = p.start_game(player, 1, 10_000_000, 0b100, [7; 32]);   // legacy game (Anchor starts it, port 6057 + mirrored); commitment computed for you
p.enable_vrf(&w, key("validator"));                              // vrf_mode on, validator pinned, vrf_max_payout_bps 1000
let vgame = p.start_game_vrf(player2, 1, 10_000_000, session);
```

Sizing: the vault holds about 50 SOL and `max_payout_bps` is 1000, so the worst-case payout must stay under about 5 SOL × health. For example, 3 mines with a 0.01 SOL bet fails with 6006. To skip instructions entirely, write state directly, for example `p.set_program_account(ids::VAULT, accounts::Vault { .. }.encode())`. Use the stored bumps: vault 254, v2 255.

## Faking delegated / ER state

| situation | how |
|---|---|
| Delegated on L1 | Run `delegate_vrf` for real: the mainnet DLP is loaded (`p.delegate_vrf(player)`, or `delegate_vrf_ix` plus the validator account). Afterwards `game` is DLP-owned and keeps its bytes. You can also fake it: `p.set_data(game, ids::DLP, bytes)`. |
| ER view (reveal_request / callback / cash_out_vrf / settle_and_undelegate) | `p.er_game(game, bytes)`, which sets the account as program-owned. Use `p.get(&game).unwrap().data` from after the delegate, or `accounts::VrfGame { .. }.encode()`. The ER and L1 share one VM; only ownership changes. |
| Oracle queue | `ids::ORACLE_QUEUE` holds the mainnet bytes (`fixtures/oracle_queue.bin`), owned by the **VRF program** (its ER view; on L1 it is DLP-owned). The real VRF program runs, so `reveal_request_vrf` really queues a request. |
| VRF callback | Call `reveal_callback_vrf` directly with `vrf_program_identity: ids::SCOPED_VRF_IDENTITY`. Its builder flag is already signer, and sigverify is off. To test the wrong-signer case, use another key (2012) or clear `is_signer` (3010). |
| Pending reveal without the VRF CPI | `p.patch(game, \|g\| { g[79] = 1; g[80] = tile; })` sets `pending` (offset 79) and `pending_tile` (offset 80). |
| settle_and_undelegate_vrf | `ids::MAGIC_PROGRAM` is the SPL **noop** program (`fixtures/noop.so`) and `MAGIC_CONTEXT` is an empty account owned by it. The CPI succeeds, and `assert_cpi_same` compares its 33 bytes and metas. No commit or undelegation happens. |
| process_undelegation (DLP callback) | Set `base` to 0 lamports and system-owned, which is what the DLP leaves behind. Fill `pda::undelegate_buffer(&base)` with `p.set_data(buf, ids::DLP, er_bytes)`. Build the ix, then set `accounts[1].is_signer = true` (buffer) and `accounts[2].is_signer = true` (payer, which funds the CreateAccount). See `tests/smoke.rs::vrf_full_lifecycle`. Negative cases: a non-canonical buffer gives InvalidSeeds, a non-DLP owner gives InvalidAccountOwner, an unsigned buffer gives MissingRequiredSignature. |
| Pre-funded PDA (init / init_if_needed / delegate buffer) | Run `p.fund(pda, 1)` before the instruction. |
| GameSessionV2 (admin_close_orphaned_game_v2) | It cannot exist under the new id. Write the raw bytes (shared.md §1, disc `640fad5758afa964`) with `p.set_data(pda::game_v2(&player), PROGRAM_ID or ids::DLP, bytes)`. |
| Time | `p.warp(p.slot() + 301)` for expiry, stall (25) and abandon (216,000). `unix_timestamp` stays at `START_UNIX`. |

## Fixtures (`fixtures/`, read-only dumps from mainnet-beta at slot 465,181,840)

| file | address | sha256 |
|---|---|---|
| `dlp.so` | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` | `a4898d1a…f7800667` |
| `vrf.so` | `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz` | `32b21724…f4a94fd` |
| `noop.so` | `noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV`, loaded at `Magic111…` | `3ebf49dd…abdce8db7` |
| `oracle_queue.base.json` / `.bin` | `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc` (9,500 bytes, DLP-owned on L1) | `.bin` `91d38247…347f9c0` |

The Magic program (`Magic111…`) is native to the ER validator and has no account on mainnet, so it cannot be dumped.

## Limits (what this harness cannot show)

- **Magic program semantics.** The noop stand-in accepts any instruction, so commit and undelegate scheduling, and any check the real magic program makes on `magic_context` or the payer, are not modelled. Only the CPI bytes and metas are compared.
- **The DLP's own Undelegate instruction** (which drains the account and CPIs `process_undelegation`) is not run. It needs validator-signed commit state. `process_undelegation` is called directly with faked DLP output.
- **Oracle fulfilment.** The VRF oracle's proof and its `provide_randomness` are not run. The callback is invoked at the top level by the scoped identity, not by CPI from the VRF program. The handler path is the same.
- **Signatures.** With sigverify off, "a PDA cannot sign" is not enforced by the runtime. A missing signer is modelled by clearing `is_signer`.
- **ER validator loading the port .so** is not covered (shared.md Q6).
- **IDL management instructions** (prefix `40f4bc78a7e9690a`): Anchor handles them and the port returns 101 (accepted D6). Do not diff them.
- **`AnchorError` text logs** are never compared (accepted D5).
- **Runtime.** CU comes from litesvm 0.18.2 / agave 4.3.2 with the mainnet feature set. Mainnet validators may count slightly differently.
- **OSABI byte (deploy blocker, see `port_elf_is_deployable`).** The kaboom-p build sets ELF `EI_OSABI = 3` (GNU). Every sbpf loader rejects that byte ("Incompatible ELF: wrong ABI"), including agave 3.1 (sbpf 0.13) and 4.x, so `solana program deploy` would fail. The harness zeroes the byte in memory so the behaviour can still be diffed, and `port_elf_is_deployable` fails until the build is fixed. The cause is `#[used]` on `SECURITY_TXT` in `kaboom-p/src/lib.rs`: it sets `SHF_GNU_RETAIN` on `.data.rel.ro`. Removing that one line, tested on a scratch copy, gives OSABI 0. The `.so` stays 195,040 bytes and security.txt is kept, because `#[no_mangle]` keeps the symbol.
