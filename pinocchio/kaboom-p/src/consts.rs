//! Program ids, fixed PDAs, seeds and game constants (spec `shared.md` §0, §4.1, §4.2).
//! Values are copied from `programs/kaboom/src/{lib.rs,vrf_mode.rs}`; `tests/abi.rs` re-derives the PDAs.

use pinocchio::Address;

const fn a(s: &str) -> Address {
    Address::from_str_const(s)
}

/// NEW program id. Every PDA below derives from it.
pub const ID: Address = a("Ednka8zjoYbE7T6iF9NHHXotaXCrbJn4Mta376cunhju");
/// F1 (AUTH-1/MONEY-4/PINO-1): the only key that may sign `initialize_vault`. The vault PDA is a
/// singleton on a fresh program id; whoever initializes it first owns it for good.
pub const DEPLOYER: Address = a("qouUoXTxNrFYw9DA7yCAnPXfAi9ypNWq2HPf5UMF9WG");

pub const SYSTEM_PROGRAM_ID: Address = a("11111111111111111111111111111111");
pub const SLOT_HASHES_ID: Address = a("SysvarS1otHashes111111111111111111111111111");
pub const DELEGATION_PROGRAM_ID: Address = a("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
pub const MAGIC_PROGRAM_ID: Address = a("Magic11111111111111111111111111111111111111");
pub const MAGIC_CONTEXT_ID: Address = a("MagicContext1111111111111111111111111111111");
pub const VRF_PROGRAM_ID: Address = a("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
/// `VRF_ORACLE_QUEUE` (vrf_mode.rs), pinned ephemeral oracle queue.
pub const VRF_ORACLE_QUEUE: Address = a("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");

/// Vault PDA `[b"kaboom_vault"]` and its canonical bump.
pub const VAULT_PDA: Address = a("7dPQVB4GPQMGLWiuvALUFrnrWip83Csj2Qjgb2kYTeg7");
pub const VAULT_BUMP: u8 = 254;
/// VaultV2State PDA `[b"kaboom_v2_state"]` and its canonical bump.
pub const V2_PDA: Address = a("Gtkn8TeTHgMF6bhEYmXy3cDcmmQyjbbY3WHXtY3td8Ue");
pub const V2_BUMP: u8 = 255;
/// VRF caller identity `[b"identity"]` under this program (signs the VRF request).
pub const IDENTITY_PDA: Address = a("7LmGUyc5oTRr4RJpYmHf4g6gE5SeA2t5nW3DD2DepMuK");
pub const IDENTITY_BUMP: u8 = 253;
/// Scoped VRF callback signer `[b"identity", ID]` under the VRF program.
pub const SCOPED_VRF_IDENTITY: Address = a("DypFSEHLnVdULGoAiGq7NmKfi8w5vSCYEXKwkfVMcMbh");
pub const SCOPED_VRF_IDENTITY_BUMP: u8 = 255;

// ─── seeds ───────────────────────────────────────────────────────────────────
pub const VAULT_SEED: &[u8] = b"kaboom_vault";
pub const VAULT_V2_SEED: &[u8] = b"kaboom_v2_state";
pub const LP_SEED: &[u8] = b"kaboom_lp";
pub const GAME_SEED: &[u8] = b"kaboom_game";
pub const GAME_V2_SEED: &[u8] = b"game_v2";
pub const STATS_SEED: &[u8] = b"kaboom_stats";
pub const REFERRAL_SEED: &[u8] = b"kaboom_referral";
pub const VRF_CLAIM_SEED: &[u8] = b"kaboom_vrf_claim";
pub const VRF_GAME_SEED: &[u8] = b"kaboom_vrf_game";
pub const IDENTITY_SEED: &[u8] = b"identity";
/// DLP seeds: `[b"buffer", game]` under THIS program; the other two under DLP.
pub const DLP_BUFFER_SEED: &[u8] = b"buffer";
pub const DLP_DELEGATION_SEED: &[u8] = b"delegation";
pub const DLP_METADATA_SEED: &[u8] = b"delegation-metadata";
pub const DLP_UNDELEGATE_BUFFER_SEED: &[u8] = b"undelegate-buffer";

// ─── game / vault constants (lib.rs:50-125) ─────────────────────────────────
pub const GRID_SIZE: u8 = 16;
pub const MIN_MINES: u8 = 1;
pub const MAX_MINES: u8 = 15;
pub const BPS: u64 = 10_000;
pub const GAME_EXPIRY_SLOTS: u64 = 300;
pub const CLOSE_UNSETTLED_EXPIRY_SLOTS: u64 = 38;
pub const MIN_BET_LAMPORTS: u64 = 1_000_000;
pub const MAX_HOUSE_EDGE_BPS: u16 = 1_000;
pub const MAX_BET_BPS: u16 = 1_000;
pub const MAX_PAYOUT_BPS: u16 = 5_000;
pub const MAX_ALLOWLIST: usize = 8;
pub const REFERRAL_BRONZE_BPS: u16 = 50;
pub const REFERRAL_SILVER_BPS: u16 = 60;
pub const REFERRAL_GOLD_BPS: u16 = 70;
pub const SILVER_VOLUME_LAMPORTS: u64 = 10_000_000_000;
pub const GOLD_VOLUME_LAMPORTS: u64 = 100_000_000_000;
pub const ANTI_INFLATION_SEED_LAMPORTS: u64 = 1_000_000_000;
pub const DEFAULT_WITHDRAW_COOLDOWN_SLOTS: u64 = 648_000;
pub const MIN_WITHDRAW_COOLDOWN_SLOTS: u64 = 150;
/// F4 (MONEY-3): a matured user LP withdrawal can be completed for this many slots after
/// `pending_unlock_slot` (about 1 h at 400 ms), then it lapses (cancel + re-request). Not configurable:
/// the bound W/(C+W) assumes the cooldown C >> W (keep `withdraw_cooldown_slots >= 450_000`).
pub const WITHDRAW_CLAIM_WINDOW_SLOTS: u64 = 9_000;
pub const MIN_HEALTH_BPS_FLOOR: u16 = 100;
pub const DEFAULT_MIN_HOUSE_SHARE_BPS: u16 = 5_000;
pub const DEFAULT_MAX_USER_POSITION_BPS: u16 = 1_000;
pub const DEFAULT_MIN_HEALTH_BPS: u16 = 1_000;
pub const DEFAULT_MIN_LP_DEPOSIT_LAMPORTS: u64 = 10_000_000;
/// Literal in `initialize_vault`.
pub const DEFAULT_TREASURY_SPLIT_BPS: u16 = 5_000;

// ─── VRF mode constants (vrf_mode.rs:19-46) ─────────────────────────────────
pub const VRF_PLAYING: u8 = 0;
pub const VRF_WON: u8 = 1;
pub const VRF_LOST: u8 = 2;
/// F3 (MB-1): zero-progress game the house closed for inactivity. Refundable (refund_stalled_vrf); never
/// delegable, revealable, cash-outable or settleable. Only force_undelegate_vrf writes it.
pub const VRF_VOID: u8 = 3;
pub const NO_TILE: u8 = 255;
pub const STALL_SLOTS: u64 = 25;
pub const ABANDON_SLOTS: u64 = 216_000;
pub const COMMIT_FREQUENCY_MS: u32 = 1_000;
pub const MAX_VRF_REVEALS: usize = 16;

/// `GameStatus` enum bytes (GameSession.status).
pub const STATUS_PLAYING: u8 = 0;
pub const STATUS_WON: u8 = 1;
pub const STATUS_LOST: u8 = 2;
pub const STATUS_EXPIRED: u8 = 3;
