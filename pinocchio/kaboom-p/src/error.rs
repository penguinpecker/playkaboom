//! Error codes (spec `shared.md` §3). Numeric codes are the ABI; no text is logged (decision D5).
//!
//! Return them with `?`/`Err(..)`: `Err(KaboomError::MathOverflow.into())` or `Err(err(AnchorError::ConstraintSeeds))`.

use pinocchio::error::ProgramError;

macro_rules! kaboom_errors {
    ($($name:ident),* $(,)?) => {
        /// `KaboomError` (`#[error_code]`): code = 6000 + index, same order as lib.rs:2711-2824.
        #[repr(u32)]
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum KaboomError { $($name),* }

        impl KaboomError {
            /// Variant names in declaration order (host ABI test only; never linked on-chain).
            pub const NAMES: &'static [&'static str] = &[$(stringify!($name)),*];
            pub const ALL: &'static [KaboomError] = &[$(KaboomError::$name),*];
        }
    };
}

kaboom_errors! {
    InvalidMineCount, InvalidTileIndex, TileAlreadyRevealed, GameNotPlaying, BetTooLow, BetExceedsMax,
    VaultInsufficientFunds, Unauthorized, MathOverflow, InvalidAmount, InvalidConfig, InvalidCommitment,
    VaultPaused, GameExpired, GameNotExpired, CommitmentMismatch, RevealMismatch, GameAlreadySettled,
    GameNotFinished, NoTilesRevealed, SelfReferral, ReferrerAlreadySet, ReferralMismatch, NothingToClaim,
    DestinationNotAllowlisted, AllowlistFull, AlreadyAllowlisted, AddressNotInAllowlist, NoPendingOwner,
    V2AlreadyInitialized, V2NotInitialized, DepositBelowMin, UserPositionCapExceeded, HouseShareFloorBreached,
    HealthFloorBreached, PendingWithdrawAlreadyExists, NoPendingWithdraw, CooldownNotElapsed, InsufficientUnits,
    InsufficientLiquidity, LpPositionNotEmpty, NoOperatorUnitsToUnlock, VrfModeDisabled, BadSessionKey,
    RevealPending, NoRevealPending, TooManyReveals, ReplayMismatch, NotStalledYet, BadGameAccount,
    GameAlreadyResolved, PayoutExceedsReserved, GameStillDelegated, VrfValidatorNotSet, WrongVrfValidator,
    // Appended after the Anchor IDL: 6055 F1, 6056 F4, 6057 VRF-only (legacy start_game disabled).
    NotDeployer, WithdrawWindowExpired, LegacyModeDisabled,
}

impl KaboomError {
    #[inline(always)]
    pub const fn code(self) -> u32 {
        6000 + self as u32
    }
}

impl From<KaboomError> for ProgramError {
    #[inline(always)]
    fn from(e: KaboomError) -> Self {
        ProgramError::Custom(e.code())
    }
}

/// Anchor 0.31.1 framework codes this program can raise (`anchor-lang/src/error.rs`).
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnchorError {
    InstructionFallbackNotFound = 101,
    InstructionDidNotDeserialize = 102,
    EventInstructionStub = 1500,
    ConstraintMut = 2000,
    ConstraintHasOne = 2001,
    ConstraintRaw = 2003,
    ConstraintOwner = 2004,
    ConstraintRentExempt = 2005,
    ConstraintSeeds = 2006,
    ConstraintClose = 2011,
    ConstraintAddress = 2012,
    ConstraintSpace = 2019,
    AccountDiscriminatorNotFound = 3001,
    AccountDiscriminatorMismatch = 3002,
    AccountDidNotDeserialize = 3003,
    AccountNotEnoughKeys = 3005,
    AccountOwnedByWrongProgram = 3007,
    InvalidProgramId = 3008,
    InvalidProgramExecutable = 3009,
    AccountNotSigner = 3010,
    AccountNotInitialized = 3012,
    DeclaredProgramIdMismatch = 4100,
    TryingToInitPayerAsProgramAccount = 4101,
}

impl From<AnchorError> for ProgramError {
    #[inline(always)]
    fn from(e: AnchorError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

/// Shorthand: `return Err(err(AnchorError::ConstraintSeeds))` / `err(KaboomError::Unauthorized)`.
#[inline(always)]
pub fn err<E: Into<ProgramError>>(e: E) -> ProgramError {
    e.into()
}
