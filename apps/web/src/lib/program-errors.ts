/**
 * Translates Anchor custom error codes to human-readable messages.
 *
 * Anchor reports errors as "{InstructionError:[<ix_index>,{Custom:<code>}]}".
 * Codes start at 6000 and align 1:1 with the order of variants in our
 * KaboomError enum (programs/kaboom/src/lib.rs ~line 2143).
 *
 * Keep this list in sync with the on-chain enum. If you add a new variant
 * mid-list, every code below it shifts by one — re-run a quick smoke
 * test after updating the program.
 */
const KABOOM_ERROR_BY_CODE: Record<number, { name: string; ui: string }> = {
  6000: { name: "InvalidMineCount", ui: "Invalid mine count." },
  6001: { name: "BetTooLow", ui: "Bet is below the minimum." },
  6002: { name: "InvalidTileIndex", ui: "Invalid tile index." },
  6003: { name: "TileAlreadyRevealed", ui: "Tile already revealed." },
  6004: { name: "GameNotPlaying", ui: "Game is no longer active." },
  6005: { name: "BetExceedsMax", ui: "Bet exceeds the per-wager cap. Try a smaller bet." },
  6006: {
    name: "VaultInsufficientFunds",
    ui: "Vault liquidity is too low for this bet right now. Try a smaller bet, or wait a few minutes for the next vault deposit / settlement.",
  },
  6007: { name: "Unauthorized", ui: "Not authorized for this action." },
  6008: { name: "MathOverflow", ui: "Arithmetic overflow." },
  6009: { name: "InvalidAmount", ui: "Invalid amount." },
  6010: { name: "InvalidConfig", ui: "Invalid configuration parameter." },
  6011: { name: "InvalidCommitment", ui: "Invalid commitment hash." },
  6012: { name: "VaultPaused", ui: "Vault is paused — gameplay temporarily disabled." },
  6013: { name: "GameExpired", ui: "Game has expired." },
  6014: { name: "GameNotExpired", ui: "Game has not expired yet — wait for the cooldown." },
  6015: { name: "CommitmentMismatch", ui: "Commitment hash does not match." },
  6016: { name: "RevealMismatch", ui: "Revealed tiles do not match the layout." },
  6017: { name: "GameAlreadySettled", ui: "Game already settled." },
  6018: { name: "GameNotFinished", ui: "Game not yet finished." },
  6019: { name: "NoTilesRevealed", ui: "No tiles revealed yet." },
  6020: { name: "SelfReferral", ui: "You can't refer yourself." },
  6021: { name: "ReferrerAlreadySet", ui: "Referrer is already set." },
  6022: { name: "ReferralMismatch", ui: "Referral account doesn't match player_stats.referrer." },
  6023: { name: "NothingToClaim", ui: "Nothing to claim." },
  6024: { name: "DestinationNotAllowlisted", ui: "Withdrawal destination is not allowlisted." },
  6025: { name: "AllowlistFull", ui: "Allowlist is full." },
  6026: { name: "AlreadyAllowlisted", ui: "Address is already allowlisted." },
  6027: { name: "AddressNotInAllowlist", ui: "Address is not on the allowlist." },
  6028: { name: "NoPendingOwner", ui: "No pending owner to accept or cancel." },
  6029: { name: "V2AlreadyInitialized", ui: "V2 already initialized." },
  6030: { name: "V2NotInitialized", ui: "V2 not yet initialized." },
  6031: { name: "DepositBelowMin", ui: "Deposit is below the minimum amount." },
  6032: {
    name: "UserPositionCapExceeded",
    ui: "Deposit would exceed your per-user position cap.",
  },
  6033: {
    name: "HouseShareFloorBreached",
    ui: "Deposit would push vault below minimum house share — try a smaller deposit.",
  },
  6034: {
    name: "HealthFloorBreached",
    ui: "This action would push the vault below its minimum health threshold.",
  },
  6035: {
    name: "PendingWithdrawAlreadyExists",
    ui: "You already have a pending withdrawal — cancel it first.",
  },
  6036: { name: "NoPendingWithdraw", ui: "No pending withdrawal to cancel or complete." },
  6037: {
    name: "CooldownNotElapsed",
    ui: "Withdrawal cooldown not yet elapsed — try again later.",
  },
  6038: { name: "InsufficientUnits", ui: "Insufficient units in your LP position." },
  6039: {
    name: "InsufficientLiquidity",
    ui: "Vault doesn't have enough liquidity for this withdrawal right now.",
  },
  6040: { name: "LpPositionNotEmpty", ui: "LP position still has units; cannot close." },
};

/**
 * Tries to find a "Custom":N code anywhere inside an error message and
 * returns the matching UI string. Falls back to the original message
 * (or a generic line) if we can't recognize the shape.
 */
export function decodeProgramError(rawMessage: string | undefined | null): string {
  if (!rawMessage) return "Transaction failed.";
  // Match patterns like:
  //   {"InstructionError":[2,{"Custom":6006}]}
  //   custom program error: 0x1786
  //   Error Code: VaultInsufficientFunds. Error Number: 6006
  const decimalMatch = rawMessage.match(/"Custom"\s*:\s*(\d+)/);
  const hexMatch = rawMessage.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  const codeMatch = rawMessage.match(/Error Number:\s*(\d+)/);
  let code: number | null = null;
  if (decimalMatch) code = Number(decimalMatch[1]);
  else if (hexMatch) code = parseInt(hexMatch[1]!, 16);
  else if (codeMatch) code = Number(codeMatch[1]);
  if (code != null) {
    const known = KABOOM_ERROR_BY_CODE[code];
    if (known) return known.ui;
    return `On-chain error ${code} — see explorer logs for detail.`;
  }
  // User-rejected sign in Privy looks like "user denied" or similar.
  if (/user (denied|rejected)/i.test(rawMessage)) return "Transaction cancelled.";
  if (/blockhash.*expired/i.test(rawMessage))
    return "Transaction timed out — network congestion. Please retry.";
  return rawMessage;
}
