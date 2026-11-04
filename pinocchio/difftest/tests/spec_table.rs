//! The generated builders (src/idl.rs, from the IDL) must match spec/shared.md section 9: discriminator,
//! log name, account names in order, W/S flags. No VM needed.
use difftest::{ids, ix, PROGRAM_ID};

const SPEC: &str = include_str!("../../spec/shared.md");

#[test]
fn builders_match_spec_table() {
    let rows: Vec<&str> = SPEC.split("## 9. Instruction index").nth(1).unwrap()
        .lines().filter(|l| l.starts_with("| `")).collect();
    assert_eq!(rows.len(), 42, "spec rows");
    assert_eq!(ix::ALL.len(), 42, "builders");
    for row in rows {
        let cells: Vec<&str> = row.split(" | ").collect();
        let log = cells[1].trim_matches('`');
        let disc = cells[2].trim_matches('`');
        let (d, name, accs) = ix::ALL.iter().find(|e| e.1 == log).unwrap_or_else(|| panic!("no builder for {log}"));
        let hex: String = d.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, disc, "{name} disc");
        // accounts cell: `name`(W|S|WS) [note], ...
        let parts: Vec<&str> = cells[4].split('`').collect();
        let spec: Vec<(String, bool, bool)> = (1..parts.len()).step_by(2).map(|i| {
            let flags = parts.get(i + 1).and_then(|r| r.strip_prefix('(')).map(|r| r.split(')').next().unwrap()).unwrap_or("");
            let flags = if flags.chars().all(|c| c == 'W' || c == 'S') { flags } else { "" };
            (parts[i].to_string(), flags.contains('W'), flags.contains('S'))
        }).collect();
        let got: Vec<(String, bool, bool)> = accs.iter().map(|a| (a.0.to_string(), a.1, a.2)).collect();
        assert_eq!(got, spec, "{name} accounts");
    }
}

#[test]
fn defaults_use_new_ids() {
    let d = ix::DelegateVrf::default();
    assert_eq!(d.owner_program, PROGRAM_ID);
    assert_eq!(d.v2_state, ids::V2_STATE);
    assert_eq!(ix::FundVault::default().vault, ids::VAULT);
    let r = ix::RevealRequestVrf::default();
    assert_eq!((r.program_identity, r.oracle_queue, r.vrf_program, r.slot_hashes), (ids::IDENTITY, ids::ORACLE_QUEUE, ids::VRF_PROGRAM, ids::SLOT_HASHES));
    let s = ix::SettleAndUndelegateVrf::default();
    assert_eq!((s.magic_program, s.magic_context), (ids::MAGIC_PROGRAM, ids::MAGIC_CONTEXT));
    let scoped = difftest::pda::find(&[b"identity", PROGRAM_ID.as_ref()], &ids::VRF_PROGRAM).0;
    assert_eq!(scoped, ids::SCOPED_VRF_IDENTITY);
}
