//! Differential harness: the same transaction on the Anchor reference build (`../anchor-ref`) and on
//! kaboom-p (`../kaboom-p`), both at the new program id on their own LiteSVM. See HARNESS.md.

pub mod idl;
pub use idl::{accounts, ix, PROGRAM_ID};

use base64::Engine;
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
pub use solana_account::Account;
pub use solana_address::Address;
pub use solana_instruction::{AccountMeta, Instruction};
pub use solana_instruction_error::InstructionError;
use solana_message::Message;
use solana_transaction::Transaction;
pub use solana_transaction_error::TransactionError;

/// Clients send every kaboom tx with this CU limit. `Diff` flags a port run above it.
pub const CLIENT_CU_LIMIT: u64 = 200_000;
/// Both VMs run with this limit so Anchor-side CU never changes the outcome; CU is reported, not enforced.
pub const RUN_CU_LIMIT: u64 = 1_400_000;
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
/// Mainnet Rent sysvar (read 2026-11-04): 5080 lamports/byte, threshold 1.0, burn 50.
pub const RENT_PER_BYTE: u64 = 5080;
/// Clock at `Pair::new()`.
pub const START_SLOT: u64 = 465_000_000;
pub const START_UNIX: i64 = 1_793_000_000;
/// F1: the only key the port lets sign `initialize_vault` (`kaboom-p/src/consts.rs`). Sigverify is off,
/// so the harness can use it as the vault owner without its private key.
pub const DEPLOYER: Address = Address::from_str_const("qouUoXTxNrFYw9DA7yCAnPXfAi9ypNWq2HPf5UMF9WG");
/// VRF-only upgrade: the port's legacy `start_game` always fails with this code (`LegacyModeDisabled`).
pub const LEGACY_MODE_DISABLED: u32 = 6057;

const DIR: &str = env!("CARGO_MANIFEST_DIR");
pub fn anchor_so() -> String { format!("{DIR}/../anchor-ref/target/deploy/kaboom.so") }
pub fn port_so() -> String { format!("{DIR}/../kaboom-p/target/deploy/kaboom.so") }
pub fn fixture(name: &str) -> String { format!("{DIR}/fixtures/{name}") }

pub mod ids {
    use super::Address;
    pub const SYSTEM: Address = Address::from_str_const("11111111111111111111111111111111");
    pub const DLP: Address = Address::from_str_const("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
    pub const VRF_PROGRAM: Address = Address::from_str_const("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
    pub const ORACLE_QUEUE: Address = Address::from_str_const("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
    pub const MAGIC_PROGRAM: Address = Address::from_str_const("Magic11111111111111111111111111111111111111");
    pub const MAGIC_CONTEXT: Address = Address::from_str_const("MagicContext1111111111111111111111111111111");
    pub const SLOT_HASHES: Address = Address::from_str_const("SysvarS1otHashes111111111111111111111111111");
    pub const VAULT: Address = Address::from_str_const("7dPQVB4GPQMGLWiuvALUFrnrWip83Csj2Qjgb2kYTeg7");
    pub const V2_STATE: Address = Address::from_str_const("Gtkn8TeTHgMF6bhEYmXy3cDcmmQyjbbY3WHXtY3td8Ue");
    /// `[b"identity"]` under the program: the VRF request signer.
    pub const IDENTITY: Address = Address::from_str_const("7LmGUyc5oTRr4RJpYmHf4g6gE5SeA2t5nW3DD2DepMuK");
    /// `[b"identity", PROGRAM_ID]` under the VRF program: the only valid `reveal_callback_vrf` signer.
    pub const SCOPED_VRF_IDENTITY: Address = Address::from_str_const("DypFSEHLnVdULGoAiGq7NmKfi8w5vSCYEXKwkfVMcMbh");
}

/// PDAs under the new program id (or the DLP where noted).
pub mod pda {
    use super::{ids, Address, PROGRAM_ID};
    pub fn find(seeds: &[&[u8]], program: &Address) -> (Address, u8) { Address::find_program_address(seeds, program) }
    fn k(seed: &[u8], key: &Address) -> Address { find(&[seed, key.as_ref()], &PROGRAM_ID).0 }
    pub fn game(player: &Address) -> Address { k(b"kaboom_game", player) }
    pub fn game_v2(player: &Address) -> Address { k(b"game_v2", player) }
    pub fn stats(player: &Address) -> Address { k(b"kaboom_stats", player) }
    pub fn lp(user: &Address) -> Address { k(b"kaboom_lp", user) }
    pub fn referral(referrer: &Address) -> Address { k(b"kaboom_referral", referrer) }
    pub fn vrf_claim(player: &Address) -> Address { k(b"kaboom_vrf_claim", player) }
    pub fn vrf_game(player: &Address) -> Address { k(b"kaboom_vrf_game", player) }
    /// `[b"buffer", game]` under THIS program (delegate_vrf).
    pub fn buffer(game: &Address) -> Address { k(b"buffer", game) }
    pub fn delegation_record(game: &Address) -> Address { find(&[b"delegation", game.as_ref()], &ids::DLP).0 }
    pub fn delegation_metadata(game: &Address) -> Address { find(&[b"delegation-metadata", game.as_ref()], &ids::DLP).0 }
    /// `[b"undelegate-buffer", base]` under the DLP: the only buffer process_undelegation accepts (0.16.2 fix).
    pub fn undelegate_buffer(base: &Address) -> Address { find(&[b"undelegate-buffer", base.as_ref()], &ids::DLP).0 }
}

/// Deterministic test key from a label (not on-curve-checked; sigverify is off).
pub fn key(label: &str) -> Address { Address::new_from_array(Sha256::digest(label.as_bytes()).into()) }
/// Rent-exempt minimum under the mainnet Rent sysvar.
pub fn rent_min(data_len: usize) -> u64 { (data_len as u64 + 128) * RENT_PER_BYTE }
/// GameSession commitment: sha256(mine_layout LE ++ [mine_count] ++ salt).
pub fn commitment(mine_layout: u16, mine_count: u8, salt: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(mine_layout.to_le_bytes());
    h.update([mine_count]);
    h.update(salt);
    h.finalize().into()
}

fn new_svm(program_so: &str) -> LiteSVM {
    assert!(std::path::Path::new(program_so).exists(), "{program_so} missing: run ./build.sh first");
    let nest8 = LiteSVM::mainnet_feature_set().is_active(&agave_feature_set::raise_cpi_nesting_limit_to_8::ID);
    let budget = solana_compute_budget::compute_budget::ComputeBudget {
        compute_unit_limit: RUN_CU_LIMIT,
        ..solana_compute_budget::compute_budget::ComputeBudget::new_with_defaults(nest8)
    };
    let mut svm = LiteSVM::new()
        .with_sigverify(false)
        .with_blockhash_check(false)
        .with_transaction_history(0)
        .with_log_bytes_limit(None)
        .with_compute_budget(budget);
    #[allow(deprecated)]
    let rent = solana_rent::Rent { lamports_per_byte: RENT_PER_BYTE, exemption_threshold: 1.0f64.to_le_bytes(), burn_percent: 50 };
    svm.set_sysvar(&rent);
    let mut clock = svm.get_sysvar::<solana_clock::Clock>();
    clock.slot = START_SLOT;
    clock.unix_timestamp = START_UNIX;
    svm.set_sysvar(&clock);
    // ponytail: a .so with EI_OSABI != 0 (kaboom-p's `#[used]` security.txt sets SHF_GNU_RETAIN -> OSABI GNU) is
    // rejected by every sbpf loader ("Incompatible ELF: wrong ABI"), on mainnet too. It is zeroed here so behaviour
    // can still be diffed; tests/smoke.rs `port_elf_is_deployable` keeps failing until the build is fixed.
    let mut so = std::fs::read(program_so).unwrap();
    so[7] = 0;
    svm.add_program(PROGRAM_ID, &so).unwrap();
    svm.add_program_from_file(ids::DLP, fixture("dlp.so")).unwrap();
    svm.add_program_from_file(ids::VRF_PROGRAM, fixture("vrf.so")).unwrap();
    // ponytail: the ER magic program is native and cannot be dumped; the SPL noop program stands in so the
    // ScheduleIntentBundle CPI succeeds and its bytes show up in `Outcome::cpis`. Real ER behaviour is not modelled.
    svm.add_program_from_file(ids::MAGIC_PROGRAM, fixture("noop.so")).unwrap();
    svm.set_account(ids::MAGIC_CONTEXT, Account { lamports: rent_min(0), data: vec![], owner: ids::MAGIC_PROGRAM, executable: false, rent_epoch: 0 }).unwrap();
    // ER view of the oracle queue: on mainnet L1 it is delegated (owner DLP); in the ER it is VRF-program owned.
    svm.set_account(ids::ORACLE_QUEUE, oracle_queue_er()).unwrap();
    svm
}

/// Mainnet oracle queue bytes (fixtures/oracle_queue.bin, from oracle_queue.base.json) with owner = VRF
/// program (the ER view). Lamports as on mainnet at dump time.
pub fn oracle_queue_er() -> Account {
    let data = std::fs::read(fixture("oracle_queue.bin")).unwrap();
    Account { lamports: 67_010_880, data, owner: ids::VRF_PROGRAM, executable: false, rent_epoch: 0 }
}

/// One CPI seen by the runtime (LiteSVM inner instructions), keys resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cpi {
    pub program: Address,
    pub accounts: Vec<Address>,
    pub data: Vec<u8>,
    pub stack_height: u8,
}

/// Result of one tx on one side.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub err: Option<TransactionError>,
    pub cu: u64,
    pub logs: Vec<String>,
    /// `Program log: Instruction: X` lines, in order.
    pub ix_lines: Vec<String>,
    /// Decoded `Program data:` payloads, in order (all depths).
    pub events: Vec<Vec<u8>>,
    pub cpis: Vec<Cpi>,
    /// Post-tx state of every message key except the kaboom program itself.
    pub post: Vec<(Address, Option<Account>)>,
}

impl Outcome {
    pub fn ok(&self) -> bool { self.err.is_none() }
    /// Custom error code (any instruction index), if the tx failed with one.
    pub fn code(&self) -> Option<u32> {
        match &self.err {
            Some(TransactionError::InstructionError(_, InstructionError::Custom(c))) => Some(*c),
            _ => None,
        }
    }
}

fn exec(svm: &mut LiteSVM, tx: Transaction, keys: &[Address]) -> Outcome {
    let (err, meta) = match svm.send_transaction(tx) {
        Ok(m) => (None, m),
        Err(f) => (Some(f.err), f.meta),
    };
    let ix_lines = meta.logs.iter().filter(|l| l.starts_with("Program log: Instruction: ")).cloned().collect();
    let events = meta.logs.iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .map(|b| b.split(' ').map(|p| base64::engine::general_purpose::STANDARD.decode(p).unwrap()).collect::<Vec<_>>().concat())
        .collect();
    let cpis = meta.inner_instructions.iter().flatten().map(|ii| Cpi {
        program: keys[ii.instruction.program_id_index as usize],
        accounts: ii.instruction.accounts.iter().map(|i| keys[*i as usize]).collect(),
        data: ii.instruction.data.clone(),
        stack_height: ii.stack_height,
    }).collect();
    let post = keys.iter().filter(|k| **k != PROGRAM_ID).map(|k| (*k, svm.get_account(k))).collect();
    Outcome { err, cu: meta.compute_units_consumed, logs: meta.logs, ix_lines, events, cpis, post }
}

/// Both sides of one tx plus every disagreement found (DIFF POLICY).
#[derive(Debug, Clone)]
pub struct Diff {
    pub anchor: Outcome,
    pub port: Outcome,
    /// Policy violations. Empty = the two programs agree.
    pub diffs: Vec<String>,
    /// Disagreements covered by an accepted deviation (Anchor panic vs port error; early 3005).
    pub accepted: Vec<String>,
    /// CPI differences (program, accounts, data). Informational: `assert_same` ignores them.
    pub cpi_diffs: Vec<String>,
}

pub fn fmt_err(e: &Option<TransactionError>) -> String {
    match e {
        None => "ok".into(),
        Some(TransactionError::InstructionError(i, InstructionError::Custom(c))) => {
            let name = idl::ERRORS.iter().find(|x| x.0 == *c).map(|x| x.1).unwrap_or("");
            format!("ix{i} Custom({c}{}{name})", if name.is_empty() { "" } else { " " })
        }
        Some(e) => format!("{e:?}"),
    }
}

pub fn event_name(payload: &[u8]) -> &'static str {
    idl::EVENTS.iter().find(|e| payload.len() >= 8 && payload[..8] == e.0).map(|e| e.1).unwrap_or("?")
}

fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }

fn account_diff(k: &Address, a: &Option<Account>, p: &Option<Account>) -> Option<String> {
    match (a, p) {
        (None, None) => None,
        (Some(_), None) | (None, Some(_)) => Some(format!("account {k}: exists anchor={} port={}", a.is_some(), p.is_some())),
        (Some(a), Some(p)) => {
            let mut v = vec![];
            if a.lamports != p.lamports { v.push(format!("lamports anchor={} port={}", a.lamports, p.lamports)); }
            if a.owner != p.owner { v.push(format!("owner anchor={} port={}", a.owner, p.owner)); }
            if a.executable != p.executable { v.push(format!("executable anchor={} port={}", a.executable, p.executable)); }
            if a.data.len() != p.data.len() { v.push(format!("data_len anchor={} port={}", a.data.len(), p.data.len())); }
            let offs: Vec<usize> = (0..a.data.len().min(p.data.len())).filter(|i| a.data[*i] != p.data[*i]).collect();
            if let (Some(&f), Some(&l)) = (offs.first(), offs.last()) {
                let s = f.saturating_sub(4);
                let e = (l + 5).min(a.data.len()).min(p.data.len()).min(s + 48);
                v.push(format!("data: {} bytes differ in [{f}..={l}]; [{s}..{e}] anchor={} port={}", offs.len(), hex(&a.data[s..e]), hex(&p.data[s..e])));
            }
            (!v.is_empty()).then(|| format!("account {k}: {}", v.join("; ")))
        }
    }
}

impl Diff {
    fn new(ixs: &[Instruction], anchor: Outcome, port: Outcome) -> Self {
        let mut diffs = vec![];
        let mut accepted = vec![];
        if anchor.err != port.err {
            let (a, p) = (fmt_err(&anchor.err), fmt_err(&port.err));
            match (&anchor.err, &port.err) {
                (Some(TransactionError::InstructionError(i, InstructionError::ProgramFailedToComplete)),
                 Some(TransactionError::InstructionError(j, _))) if i == j =>
                    accepted.push(format!("result: anchor panicked ({a}), port errored ({p})")),
                (Some(TransactionError::InstructionError(i, _)), Some(TransactionError::InstructionError(j, InstructionError::Custom(3005))))
                    if i == j && short_accounts(&ixs[*i as usize]) =>
                    accepted.push(format!("result: port 3005 before anchor's {a} (short account list)")),
                _ => diffs.push(format!("result: anchor={a} port={p}")),
            }
        }
        if anchor.ix_lines != port.ix_lines {
            diffs.push(format!("ix log lines: anchor={:?} port={:?}", anchor.ix_lines, port.ix_lines));
        }
        if anchor.events != port.events {
            let n = anchor.events.len().max(port.events.len());
            for i in 0..n {
                let (a, p) = (anchor.events.get(i), port.events.get(i));
                if a != p {
                    let f = |e: Option<&Vec<u8>>| e.map(|e| format!("{} {}", event_name(e), hex(e))).unwrap_or("<none>".into());
                    diffs.push(format!("event #{i}: anchor={} port={}", f(a), f(p)));
                }
            }
        }
        for ((k, a), (_, p)) in anchor.post.iter().zip(port.post.iter()) {
            if let Some(d) = account_diff(k, a, p) { diffs.push(d); }
        }
        if port.cu > CLIENT_CU_LIMIT {
            diffs.push(format!("cu: port used {} > client limit {CLIENT_CU_LIMIT} (anchor {})", port.cu, anchor.cu));
        }
        let mut cpi_diffs = vec![];
        if anchor.cpis != port.cpis {
            let n = anchor.cpis.len().max(port.cpis.len());
            for i in 0..n {
                let (a, p) = (anchor.cpis.get(i), port.cpis.get(i));
                if a != p {
                    let f = |c: Option<&Cpi>| c.map(|c| format!("[h{} {} accts={:?} data={}]", c.stack_height, c.program,
                        c.accounts.iter().map(|x| x.to_string()).collect::<Vec<_>>(), hex(&c.data))).unwrap_or("<none>".into());
                    cpi_diffs.push(format!("cpi #{i}: anchor={} port={}", f(a), f(p)));
                }
            }
        }
        Diff { anchor, port, diffs, accepted, cpi_diffs }
    }

    pub fn is_same(&self) -> bool { self.diffs.is_empty() }
    /// (anchor CU, port CU).
    pub fn cu(&self) -> (u64, u64) { (self.anchor.cu, self.port.cu) }

    pub fn report(&self) -> String {
        let mut s = format!("anchor: {} ({} CU) | port: {} ({} CU)\n", fmt_err(&self.anchor.err), self.anchor.cu, fmt_err(&self.port.err), self.port.cu);
        for d in &self.diffs { s += &format!("  DIFF {d}\n"); }
        for d in &self.accepted { s += &format!("  accepted {d}\n"); }
        for d in &self.cpi_diffs { s += &format!("  cpi {d}\n"); }
        s
    }
    fn fail(&self, why: &str) -> ! {
        panic!("{why}\n{}\n--- anchor logs ---\n{}\n--- port logs ---\n{}", self.report(), self.anchor.logs.join("\n"), self.port.logs.join("\n"))
    }
    /// Panics with the full report (and both log sets) if any DIFF POLICY item disagrees.
    pub fn assert_same(&self) -> &Self {
        if !self.is_same() { self.fail("anchor and port disagree"); }
        self
    }
    /// assert_same + the tx succeeded.
    pub fn assert_ok(&self) -> &Self {
        self.assert_same();
        if !self.anchor.ok() { self.fail("expected success"); }
        self
    }
    /// assert_same + both failed with this custom code (6000+ or an Anchor framework code).
    pub fn assert_err(&self, code: u32) -> &Self {
        self.assert_same();
        if self.anchor.code() != Some(code) || self.port.code() != Some(code) { self.fail(&format!("expected Custom({code})")); }
        self
    }
    /// assert_same + both failed (any error).
    pub fn assert_failed(&self) -> &Self {
        self.assert_same();
        if self.anchor.ok() { self.fail("expected failure"); }
        self
    }
    /// INTENDED: VRF-only. The port refused a legacy `start_game` with 6057 after logging
    /// `Instruction: StartGame`. The Anchor side is not compared; `anchor_ok/err/failed` check it.
    pub fn vrf_only(&self) -> &Self {
        if self.port.code() != Some(LEGACY_MODE_DISABLED) { self.fail("expected port Custom(6057) LegacyModeDisabled"); }
        if self.port.ix_lines.last().map(String::as_str) != Some("Program log: Instruction: StartGame") {
            self.fail("port must log Instruction: StartGame before failing");
        }
        self
    }
    /// vrf_only + the Anchor reference succeeded.
    pub fn anchor_ok(&self) -> &Self {
        if !self.vrf_only().anchor.ok() { self.fail("expected anchor success"); }
        self
    }
    /// vrf_only + the Anchor reference failed with this custom code.
    pub fn anchor_err(&self, code: u32) -> &Self {
        if self.vrf_only().anchor.code() != Some(code) { self.fail(&format!("expected anchor Custom({code})")); }
        self
    }
    /// vrf_only + the Anchor reference failed (any error).
    pub fn anchor_failed(&self) -> &Self {
        if self.vrf_only().anchor.ok() { self.fail("expected anchor failure"); }
        self
    }
    /// The CPIs (program, account keys, data, depth) are identical too.
    pub fn assert_cpi_same(&self) -> &Self {
        if !self.cpi_diffs.is_empty() { self.fail("CPIs differ"); }
        self
    }
}

fn short_accounts(ix: &Instruction) -> bool {
    ix.program_id == PROGRAM_ID && ix::by_disc(&ix.data).is_some_and(|e| ix.accounts.len() < e.2.len())
}

/// Keys created by `Pair::house_world`.
#[derive(Debug, Clone, Copy)]
pub struct World {
    pub owner: Address,
    pub house: Address,
    pub treasury: Address,
}

/// Two LiteSVMs (Anchor ref, port) at the same program id with the same fixtures.
pub struct Pair {
    pub anchor: LiteSVM,
    pub port: LiteSVM,
    /// Default fee payer (funded system account). Fees: 5000 lamports per signature, same on both sides.
    pub payer: Address,
}

impl Default for Pair {
    fn default() -> Self { Self::new() }
}

impl Pair {
    pub fn new() -> Self {
        let mut p = Pair { anchor: new_svm(&anchor_so()), port: new_svm(&port_so()), payer: key("fee-payer") };
        p.fund(p.payer, 1_000_000 * LAMPORTS_PER_SOL);
        p
    }

    // ---- state ----
    pub fn set_account(&mut self, key: Address, acc: Account) {
        self.anchor.set_account(key, acc.clone()).unwrap();
        self.port.set_account(key, acc).unwrap();
    }
    /// System-owned account with `lamports`.
    pub fn fund(&mut self, key: Address, lamports: u64) {
        self.set_account(key, Account { lamports, data: vec![], owner: ids::SYSTEM, executable: false, rent_epoch: 0 });
    }
    /// New deterministic key funded with 100 SOL.
    pub fn user(&mut self, label: &str) -> Address {
        let k = key(label);
        self.fund(k, 100 * LAMPORTS_PER_SOL);
        k
    }
    /// `DEPLOYER` funded with 100 SOL (the vault owner every test initializes with, F1).
    pub fn deployer(&mut self) -> Address {
        self.fund(DEPLOYER, 100 * LAMPORTS_PER_SOL);
        DEPLOYER
    }
    /// Account with `owner` and `data`, rent-exempt lamports (fake state, e.g. ER/delegated accounts).
    pub fn set_data(&mut self, key: Address, owner: Address, data: Vec<u8>) {
        let lamports = rent_min(data.len());
        self.set_account(key, Account { lamports, data, owner, executable: false, rent_epoch: 0 });
    }
    /// Program-owned account (encoded struct bytes), rent-exempt.
    pub fn set_program_account(&mut self, key: Address, data: Vec<u8>) { self.set_data(key, PROGRAM_ID, data) }
    /// Replace the bytes of an existing account on both sides (lamports and owner kept).
    /// Panics if the two sides already disagree on it.
    pub fn patch(&mut self, key: Address, f: impl FnOnce(&mut Vec<u8>)) {
        let mut a = self.get(&key).expect("patch: account missing");
        f(&mut a.data);
        self.set_account(key, a);
    }
    pub fn warp(&mut self, slot: u64) {
        self.anchor.warp_to_slot(slot);
        self.port.warp_to_slot(slot);
    }
    pub fn slot(&self) -> u64 { self.anchor.get_sysvar::<solana_clock::Clock>().slot }
    pub fn get_both(&self, key: &Address) -> (Option<Account>, Option<Account>) { (self.anchor.get_account(key), self.port.get_account(key)) }
    /// The account (anchor side); panics if the sides disagree on lamports/owner/data.
    pub fn get(&self, key: &Address) -> Option<Account> {
        let (a, p) = self.get_both(key);
        if let Some(d) = account_diff(key, &a, &p) { panic!("sides diverged: {d}"); }
        a
    }
    pub fn lamports(&self, key: &Address) -> u64 { self.get(key).map(|a| a.lamports).unwrap_or(0) }
    /// Decode an account (both sides must agree), e.g. `p.read(&ids::VAULT, accounts::Vault::decode)`.
    pub fn read<T>(&self, key: &Address, f: fn(&[u8]) -> std::io::Result<T>) -> T {
        let a = self.get(key).unwrap_or_else(|| panic!("{key}: no account"));
        f(&a.data).unwrap_or_else(|e| panic!("{key}: decode failed: {e}"))
    }

    // ---- execution ----
    /// Run one tx (fee payer `self.payer`) on both sides.
    pub fn run(&mut self, ixs: &[Instruction]) -> Diff {
        let payer = self.payer;
        self.run_as(payer, ixs)
    }
    /// Run one tx with an explicit fee payer.
    pub fn run_as(&mut self, fee_payer: Address, ixs: &[Instruction]) -> Diff {
        let msg = Message::new(ixs, Some(&fee_payer));
        let keys = msg.account_keys.clone();
        let tx = Transaction::new_unsigned(msg);
        let a = exec(&mut self.anchor, tx.clone(), &keys);
        let p = exec(&mut self.port, tx, &keys);
        Diff::new(ixs, a, p)
    }
    /// INTENDED: VRF-only. Run a tx that starts a legacy game: the port must refuse it (6057). Then the Anchor
    /// post-state of every message key is copied onto the port (set_account), so the legacy wind-down
    /// instructions (reveal, cash_out, settle, refund, close, expire) still run on both sides from the same state.
    /// Only while both sides agree on the tx's accounts (checked): a port-only divergence would be overwritten.
    pub fn run_legacy(&mut self, ixs: &[Instruction]) -> Diff {
        let payer = self.payer;
        self.run_legacy_as(payer, ixs)
    }
    pub fn run_legacy_as(&mut self, fee_payer: Address, ixs: &[Instruction]) -> Diff {
        for k in ixs.iter().flat_map(|i| i.accounts.iter().map(|m| m.pubkey)) {
            let (a, p) = self.get_both(&k);
            if let Some(d) = account_diff(&k, &a, &p) { panic!("run_legacy: sides already diverged: {d}"); }
        }
        let d = self.run_as(fee_payer, ixs);
        d.vrf_only();
        for (k, a) in &d.anchor.post {
            match a {
                Some(a) if !a.executable => self.port.set_account(*k, a.clone()).unwrap(),
                Some(_) => {}
                None => assert!(self.port.get_account(k).is_none(), "run_legacy: {k} gone on anchor, present on port"),
            }
        }
        d
    }
    /// Run and assert_ok.
    pub fn ok(&mut self, ixs: &[Instruction]) -> Diff {
        let d = self.run(ixs);
        d.assert_ok();
        d
    }

    // ---- quick setups (each asserts zero diffs) ----
    /// initialize_vault(edge 100, max_bet 100, max_payout 1000) + fund_vault(50 SOL from owner) + initialize_v2.
    pub fn house_world(&mut self) -> World {
        let w = self.init_vault(100, 100, 1_000);
        self.fund_vault(w.owner, 50 * LAMPORTS_PER_SOL);
        self.init_v2(&w);
        w
    }
    pub fn init_vault(&mut self, house_edge_bps: u16, max_bet_bps: u16, max_payout_bps: u16) -> World {
        let w = World { owner: self.deployer(), house: self.user("house"), treasury: self.user("treasury") };
        self.ok(&[ix::InitializeVault { house_authority: w.house, treasury: w.treasury, owner: w.owner, ..Default::default() }
            .ix(house_edge_bps, max_bet_bps, max_payout_bps)]);
        w
    }
    pub fn fund_vault(&mut self, funder: Address, amount: u64) {
        self.ok(&[ix::FundVault { funder, ..Default::default() }.ix(amount)]);
    }
    pub fn init_v2(&mut self, w: &World) {
        self.ok(&[ix::InitializeV2 { owner: w.owner, ..Default::default() }.ix()]);
    }
    /// update_v2_config: vrf_mode_enabled = true, vrf_validator, vrf_max_payout_bps = 1000.
    pub fn enable_vrf(&mut self, w: &World, validator: Address) {
        self.ok(&[ix::UpdateV2Config { owner: w.owner, ..Default::default() }
            .ix(None, None, None, None, None, Some(true), Some(validator), Some(1_000))]);
    }
    /// start_game with commitment(mine_layout, mine_count, salt). Returns the game PDA.
    /// INTENDED: VRF-only: Anchor starts the game, the port fails 6057 and gets Anchor's state (`run_legacy`).
    pub fn start_game(&mut self, player: Address, mine_count: u8, bet: u64, mine_layout: u16, salt: [u8; 32]) -> Address {
        let game = pda::game(&player);
        self.run_legacy(&[ix::StartGame { game, player_stats: pda::stats(&player), player, ..Default::default() }
            .ix(mine_count, bet, commitment(mine_layout, mine_count, &salt))]).anchor_ok();
        game
    }
    /// start_game_vrf (needs enable_vrf). Returns the VrfGame PDA.
    pub fn start_game_vrf(&mut self, player: Address, mine_count: u8, bet: u64, session_key: Address) -> Address {
        let game = pda::vrf_game(&player);
        self.ok(&[ix::StartGameVrf { player, claim: pda::vrf_claim(&player), game, player_stats: pda::stats(&player), ..Default::default() }
            .ix(mine_count, bet, session_key)]);
        game
    }
    /// delegate_vrf with the real mainnet DLP. Returns the game PDA (now DLP-owned on L1).
    pub fn delegate_vrf(&mut self, player: Address) -> Address {
        let game = pda::vrf_game(&player);
        self.ok(&[delegate_vrf_ix(player)]);
        game
    }
    /// Fake the ER view of a delegated VrfGame: owner = program, data = the bytes the DLP holds in custody
    /// (what the ER clones). Use after `delegate_vrf`, or with hand-made `accounts::VrfGame` bytes.
    pub fn er_game(&mut self, game: Address, data: Vec<u8>) { self.set_program_account(game, data) }
}

/// delegate_vrf with every PDA derived for `player`.
pub fn delegate_vrf_ix(player: Address) -> Instruction {
    let game = pda::vrf_game(&player);
    ix::DelegateVrf {
        player,
        buffer_game: pda::buffer(&game),
        delegation_record_game: pda::delegation_record(&game),
        delegation_metadata_game: pda::delegation_metadata(&game),
        game,
        ..Default::default()
    }.ix()
}
