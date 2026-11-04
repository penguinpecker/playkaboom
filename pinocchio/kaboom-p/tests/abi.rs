//! Host ABI test: every discriminator, size, error code and the multiplier math must equal the
//! Anchor build (`target/idl/kaboom.json`, `tests/fixtures/multiplier.json`). Run: `cargo test`.

use kaboom::consts::*;
use kaboom::error::{AnchorError, KaboomError};
use kaboom::helpers::{self, Args};
use kaboom::{events, ix, process_instruction, state, ID};
use pinocchio::{error::ProgramError, Address};
use serde_json::Value;
use sha2::{Digest, Sha256};

const IDL: &str = include_str!("../../../target/idl/kaboom.json");
const FIXTURE: &str = include_str!("../../../tests/fixtures/multiplier.json");

fn idl() -> Value {
    serde_json::from_str(IDL).unwrap()
}
fn disc_of(v: &Value) -> [u8; 8] {
    let b: Vec<u8> = v["discriminator"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect();
    b.try_into().unwrap()
}
fn sha8(s: &str) -> [u8; 8] {
    Sha256::digest(s.as_bytes())[..8].try_into().unwrap()
}
fn pascal(snake: &str) -> String {
    snake.split('_').map(|p| p[..1].to_uppercase() + &p[1..]).collect()
}
/// Max Borsh size of an IDL type (Option counted as Some).
fn size(t: &Value, types: &Value) -> usize {
    if let Some(s) = t.as_str() {
        return match s {
            "u8" | "bool" => 1,
            "u16" => 2,
            "u32" => 4,
            "u64" | "i64" => 8,
            "u128" => 16,
            "pubkey" => 32,
            _ => panic!("{s}"),
        };
    }
    if let Some(a) = t.get("array") {
        return size(&a[0], types) * a[1].as_u64().unwrap() as usize;
    }
    if let Some(o) = t.get("option") {
        return 1 + size(o, types);
    }
    let name = t["defined"]["name"].as_str().unwrap();
    let def = types.as_array().unwrap().iter().find(|x| x["name"] == name).unwrap();
    if def["type"]["kind"] == "enum" {
        return 1;
    }
    def["type"]["fields"].as_array().unwrap().iter().map(|f| size(&f["type"], types)).sum()
}
fn struct_size(name: &str, types: &Value) -> usize {
    let def = types.as_array().unwrap().iter().find(|x| x["name"] == name).unwrap();
    def["type"]["fields"].as_array().unwrap().iter().map(|f| size(&f["type"], types)).sum()
}

#[test]
fn instructions_match_idl() {
    let idl = idl();
    let list = idl["instructions"].as_array().unwrap();
    assert_eq!(list.len(), 42);
    // F-fix additions, appended after the 42 Anchor instructions in this order (INTENDED: F2, F3).
    let extra = ["expire_game", "force_undelegate_vrf"];
    assert_eq!(ix::INSTRUCTIONS.len(), 42 + extra.len());
    for (k, snake) in extra.iter().enumerate() {
        let (name, d) = ix::INSTRUCTIONS[42 + k];
        assert_eq!((name, d), (pascal(snake).as_str(), sha8(&format!("global:{snake}"))), "{snake}");
        assert!(list.iter().all(|i| disc_of(i) != d), "{snake} collides with an Anchor discriminator");
        let (line, _) = ix::route(u64::from_le_bytes(d)).unwrap();
        assert_eq!(line, format!("Instruction: {name}"));
    }
    for i in list {
        let snake = i["name"].as_str().unwrap();
        let d = disc_of(i);
        assert_eq!(d, sha8(&format!("global:{snake}")), "{snake}");
        let ours = ix::INSTRUCTIONS.iter().find(|(n, _)| *n == pascal(snake)).unwrap_or_else(|| panic!("missing {snake}"));
        assert_eq!(ours.1, d, "{snake} disc");
        let (line, _) = ix::route(u64::from_le_bytes(d)).unwrap();
        assert_eq!(line, format!("Instruction: {}", pascal(snake)));
    }
}

#[test]
fn accounts_match_idl() {
    let idl = idl();
    let list = idl["accounts"].as_array().unwrap();
    assert_eq!(list.len(), state::ACCOUNTS.len());
    for a in list {
        let name = a["name"].as_str().unwrap();
        let (_, d, space) = state::ACCOUNTS.iter().find(|(n, ..)| *n == name).unwrap();
        assert_eq!(*d, disc_of(a), "{name}");
        assert_eq!(*d, sha8(&format!("account:{name}")), "{name}");
        assert_eq!(*space, 8 + struct_size(name, &idl["types"]), "{name} space");
    }
    assert_eq!(state::game_session_v2::DISC, sha8("account:GameSessionV2"));
    // END (generated from the IDL) == SPACE (Anchor constants) for every type.
    assert_eq!(state::game_session::END, 180);
    assert_eq!(state::lp_position::END, 121);
    assert_eq!(state::player_stats::END, 203);
    assert_eq!(state::referral_account::END, 103);
    assert_eq!(state::vault::END, 428);
    assert_eq!(state::vault_v2_state::END, 191);
    assert_eq!(state::vrf_claim::END, 69);
    assert_eq!(state::vrf_game::END, 621);
    // Raw offsets the handlers and off-chain code rely on (shared.md §1, §8).
    assert_eq!(state::vrf_game::STATUS, 8);
    assert_eq!(state::vrf_game::SAFE_REVEALS, 77);
    assert_eq!(state::vrf_game::PENDING, 79);
    assert_eq!(state::VRF_GAME_MIN_RAW_LEN, 80);
    assert_eq!(state::player_stats::REFERRER, 107);
    assert_eq!(state::game_session_v2::MIN_RAW_LEN, 156);
}

#[test]
fn events_match_idl() {
    let idl = idl();
    let list = idl["events"].as_array().unwrap();
    assert_eq!(list.len(), 34);
    assert_eq!(events::EVENTS.len(), 34);
    for e in list {
        let name = e["name"].as_str().unwrap();
        let (_, d, total) = events::EVENTS.iter().find(|(n, ..)| *n == name).unwrap();
        assert_eq!(*d, disc_of(e), "{name}");
        assert_eq!(*d, sha8(&format!("event:{name}")), "{name}");
        assert_eq!(*total, 8 + struct_size(name, &idl["types"]), "{name} size");
    }
    // Spot-check one serializer byte for byte (GameWon, shared.md §2).
    let b = events::game_won(&[1; 32], &[2; 32], 3, 4, 5, 6, 7);
    assert_eq!(b.len(), 105);
    assert_eq!(b[..8], events::GAME_WON);
    assert_eq!(b[8..40], [1; 32]);
    assert_eq!(b[40..72], [2; 32]);
    assert_eq!(b[72..80], 3u64.to_le_bytes());
    assert_eq!(b[80..88], 4u64.to_le_bytes());
    assert_eq!(b[88..96], 5u64.to_le_bytes());
    assert_eq!(b[96], 6);
    assert_eq!(b[97..105], 7u64.to_le_bytes());
}

#[test]
fn errors_match_idl() {
    let idl = idl();
    let list = idl["errors"].as_array().unwrap();
    // The IDL errors are a prefix; the F-fix codes are appended after them (INTENDED: F1, F4, VRF-only).
    assert_eq!(list.len(), 55);
    assert_eq!(&KaboomError::NAMES[55..], ["NotDeployer", "WithdrawWindowExpired", "LegacyModeDisabled"]);
    assert_eq!(KaboomError::NotDeployer.code(), 6055);
    assert_eq!(KaboomError::WithdrawWindowExpired.code(), 6056);
    assert_eq!(KaboomError::LegacyModeDisabled.code(), 6057);
    assert_eq!(ProgramError::from(KaboomError::LegacyModeDisabled), ProgramError::Custom(6057));
    for (i, e) in list.iter().enumerate() {
        assert_eq!(e["code"].as_u64().unwrap() as u32, KaboomError::ALL[i].code());
        assert_eq!(e["name"].as_str().unwrap(), KaboomError::NAMES[i]);
        assert_eq!(ProgramError::from(KaboomError::ALL[i]), ProgramError::Custom(6000 + i as u32));
    }
    assert_eq!(ProgramError::from(AnchorError::AccountNotInitialized), ProgramError::Custom(3012));
    assert_eq!(AnchorError::ConstraintSeeds as u32, 2006);
    assert_eq!(AnchorError::ConstraintSpace as u32, 2019);
    assert_eq!(AnchorError::AccountOwnedByWrongProgram as u32, 3007);
}

#[test]
fn pdas_and_ids() {
    let pid = Address::from_str_const("Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju");
    assert_eq!(ID, pid);
    assert_eq!(hex(ID.as_array()), "ca9491fbe79556899ffa2905be5399d9f46cef073b08cce9869a5bfa8c00a2c0");
    let f = |s: &[&[u8]], p: &Address| Address::try_find_program_address(s, p).unwrap();
    assert_eq!(f(&[VAULT_SEED], &ID), (VAULT_PDA, VAULT_BUMP));
    assert_eq!(f(&[VAULT_V2_SEED], &ID), (V2_PDA, V2_BUMP));
    assert_eq!(f(&[IDENTITY_SEED], &ID), (IDENTITY_PDA, IDENTITY_BUMP));
    assert_eq!(f(&[IDENTITY_SEED, ID.as_ref()], &VRF_PROGRAM_ID), (SCOPED_VRF_IDENTITY, SCOPED_VRF_IDENTITY_BUMP));
    assert_eq!(SYSTEM_PROGRAM_ID.as_array(), &[0u8; 32]);
    // F1: the hard-coded initialize_vault signer.
    assert_eq!(DEPLOYER.to_string(), "qouUoXTxNrFYw9DA7yCAnPXfAi9ypNWq2HPf5UMF9WG");
    // The vendored crate agrees on the external ids.
    assert_eq!(DELEGATION_PROGRAM_ID, ephemeral_rollups_pinocchio::consts::DELEGATION_PROGRAM_ID);
    assert_eq!(MAGIC_PROGRAM_ID, ephemeral_rollups_pinocchio::consts::MAGIC_PROGRAM_ID);
    assert_eq!(MAGIC_CONTEXT_ID, ephemeral_rollups_pinocchio::consts::MAGIC_CONTEXT_ID);
    assert_eq!(VRF_PROGRAM_ID, ephemeral_rollups_pinocchio::vrf::consts::VRF_PROGRAM_ID);
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[test]
fn dispatch_framework_codes() {
    let mut none: [pinocchio::AccountView; 0] = [];
    let other = Address::new_from_array([7; 32]);
    let c = |e: AnchorError| Err(ProgramError::Custom(e as u32));
    assert_eq!(process_instruction(&other, &mut none, &[0; 8]), c(AnchorError::DeclaredProgramIdMismatch));
    assert_eq!(process_instruction(&ID, &mut none, &[1, 2, 3]), c(AnchorError::InstructionFallbackNotFound));
    assert_eq!(process_instruction(&ID, &mut none, &[0; 8]), c(AnchorError::InstructionFallbackNotFound));
    // Anchor IDL-management prefix is dropped (D6) -> 101.
    let idl_ix = [0x40, 0xf4, 0xbc, 0x78, 0xa7, 0xe9, 0x69, 0x0a, 0];
    assert_eq!(process_instruction(&ID, &mut none, &idl_ix), c(AnchorError::InstructionFallbackNotFound));
    let ev = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
    assert_eq!(process_instruction(&ID, &mut none, &ev), c(AnchorError::EventInstructionStub));
}

#[test]
fn borsh_args_reader() {
    const BAD: ProgramError = ProgramError::Custom(102);
    let mut a = Args::new(&[1, 0x34, 0x12, 9, 9]);
    assert_eq!(a.opt_u16(), Ok(Some(0x1234)));
    assert_eq!(a.u8(), Ok(9)); // trailing byte left unread is fine
    assert_eq!(Args::new(&[2]).bool(), Err(BAD));
    assert_eq!(Args::new(&[2, 0, 0]).opt_u16(), Err(BAD));
    assert_eq!(Args::new(&[1, 0]).u64(), Err(BAD));
    assert_eq!(Args::new(&[0]).opt_pk(), Ok(None));
}

// ─── math: fixture + the ported lib.rs:3146-3286 tests ──────────────────────

#[test]
fn calc_multiplier_matches_shared_fixture() {
    let v: Value = serde_json::from_str(FIXTURE).unwrap();
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 675);
    for r in rows {
        let g = |k: &str| r[k].as_u64().unwrap();
        let got = helpers::calc_multiplier(g("safe_reveals") as u8, g("mine_count") as u8, g("edge_bps") as u16).unwrap();
        assert_eq!(got, g("expected_bps"), "{r}");
    }
}

#[test]
fn calc_multiplier_zero_reveals_is_unit() {
    for m in 1..=MAX_MINES {
        for e in [0u16, 100, 200, 500, MAX_HOUSE_EDGE_BPS] {
            assert_eq!(helpers::calc_multiplier(0, m, e).unwrap(), BPS);
        }
    }
}

#[test]
fn calc_multiplier_rejects_overfilled_grid() {
    let e = Err(ProgramError::Custom(KaboomError::InvalidMineCount.code()));
    assert_eq!(helpers::calc_multiplier(15, 2, 200), e);
    assert_eq!(helpers::calc_multiplier(16, 1, 200), e);
    assert_eq!(helpers::calc_multiplier(2, 15, 200), e);
}

#[test]
fn worst_case_payout_monotonic_in_bet() {
    let a = helpers::worst_case_payout(1_000_000, 3, 200).unwrap();
    let b = helpers::worst_case_payout(2_000_000, 3, 200).unwrap();
    assert_eq!(b, a * 2);
}

#[test]
fn mul_div_floor_handles_max_bet() {
    let r = helpers::mul_div_floor(u64::MAX / 2, 5000, BPS).unwrap();
    assert!(r > 0 && r < u64::MAX);
    assert!(helpers::mul_div_floor(1, 1, 0).is_err());
}

#[test]
fn vrf_payout_never_exceeds_reserved() {
    let bet: u64 = 1_000_000_000;
    for mines in MIN_MINES..=MAX_MINES {
        for edge in [0u16, 200, 500] {
            let reserved = helpers::worst_case_payout(bet, mines, edge).unwrap();
            for safe in 1..=(GRID_SIZE - mines) {
                let mult = helpers::calc_multiplier(safe, mines, edge).unwrap();
                assert!(helpers::mul_div_floor(bet, mult, BPS).unwrap() <= reserved);
            }
        }
    }
}

#[test]
fn vrf_forged_full_clear_is_far_above_a_real_reservation() {
    let bet: u64 = 1_000_000;
    let forged = helpers::mul_div_floor(bet, helpers::calc_multiplier(8, 8, 0).unwrap(), BPS).unwrap();
    let real_1_mine = helpers::worst_case_payout(bet, 1, 200).unwrap();
    assert!(forged > real_1_mine * 800);
}

#[test]
fn zero_assets_with_live_units_blocks_deposits() {
    assert!(helpers::deposit_to_units(1_000_000_000, 0, 49).is_err());
    assert!(helpers::deposit_to_units(1_000_000_000, 1, 49).is_ok());
    assert_eq!(helpers::deposit_to_units(1_000_000_000, 0, 0).unwrap(), 1_000_000_000u128);
    assert!(helpers::deposit_to_units(3_000_000_000, 778, 49).is_ok());
}

#[test]
fn vrf_decide_mine_is_uniform_over_each_period() {
    for mines in 1u8..=15 {
        for safe in 0u8..(GRID_SIZE - mines) {
            let remaining = (GRID_SIZE - safe) as u64;
            let hits = (0..remaining)
                .filter(|x| {
                    let mut r = [0u8; 32];
                    r[0..8].copy_from_slice(&x.to_le_bytes());
                    helpers::decide_mine(&r, safe, mines)
                })
                .count();
            assert_eq!(hits as u64, mines as u64, "mines={mines} safe={safe}");
        }
    }
}

#[test]
fn lp_math_edges() {
    // health / caps on a hand-built V2 image (offsets from state.rs).
    let mut v2 = [0u8; 191];
    state::wr_u128(&mut v2, state::vault_v2_state::TOTAL_UNITS, 100);
    state::wr_u128(&mut v2, state::vault_v2_state::TOTAL_PENDING_UNITS, 10);
    state::wr_u64(&mut v2, state::vault_v2_state::TOTAL_OUTSTANDING_MAX_PAYOUT, 100);
    // assets 1000: pending value 100, obligations 200, free 800 -> 8000 bps.
    assert_eq!(helpers::calc_health_bps(&v2, 1000), Ok(8000));
    assert_eq!(helpers::calc_health_bps(&v2, 0), Ok(0));
    state::wr_u16(&mut v2, state::vault_v2_state::MIN_HEALTH_BPS, 8001);
    assert_eq!(helpers::enforce_min_health(&v2, 1000), Err(KaboomError::HealthFloorBreached.into()));
    assert_eq!(helpers::enforce_house_floor(1, 1, 5000), Ok(()));
    assert_eq!(helpers::enforce_house_floor(1, 2, 5000), Err(KaboomError::HouseShareFloorBreached.into()));
    // cap = ((1000*1000)/10000 * 8000)/10000 = 80
    assert_eq!(helpers::enforce_user_position_cap(80, 1000, 8000, 1000), Ok(()));
    assert_eq!(helpers::enforce_user_position_cap(81, 1000, 8000, 1000), Err(KaboomError::UserPositionCapExceeded.into()));
    assert_eq!(helpers::user_units_total(&v2), Ok(100));
    assert_eq!(helpers::units_to_assets(0, 5, 5), Ok(0));
    assert_eq!(helpers::tier_for_volume(SILVER_VOLUME_LAMPORTS - 1), 0);
    assert_eq!(helpers::tier_for_volume(SILVER_VOLUME_LAMPORTS), 1);
    assert_eq!(helpers::tier_for_volume(GOLD_VOLUME_LAMPORTS), 2);
    assert_eq!(helpers::referral_cut_bps(7), REFERRAL_GOLD_BPS);
}
