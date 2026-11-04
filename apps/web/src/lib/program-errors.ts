import { kaboomErrorByCode, type KaboomErrorName } from "@playkaboom/sdk";

/**
 * Player-facing text for each program error. Codes come from the SDK's
 * KABOOM_ERROR_NAMES (6000 + index, the deployed program's order), so a code
 * can no longer drift from its name here: this table is keyed by NAME, and the
 * Record type makes a missing name a compile error.
 * The program reports errors as {"InstructionError":[i,{"Custom":N}]} or
 * "custom program error: 0x..".
 */
const UI_BY_NAME: Record<KaboomErrorName, string> = {
  InvalidMineCount: "Invalid mine count.",
  BetTooLow: "Bet is below the minimum.",
  InvalidTileIndex: "Invalid tile index.",
  TileAlreadyRevealed: "Tile already revealed.",
  GameNotPlaying: "This round is no longer active.",
  BetExceedsMax: "Bet exceeds the per-wager cap. Try a smaller bet.",
  VaultInsufficientFunds:
    "Vault liquidity is too low for this bet right now. Try a smaller bet, or wait a few minutes for the next vault deposit / settlement.",
  Unauthorized: "Not authorized for this action.",
  MathOverflow: "Arithmetic overflow.",
  InvalidAmount: "Invalid amount.",
  InvalidConfig: "Invalid configuration parameter.",
  InvalidCommitment: "Invalid commitment hash.",
  VaultPaused: "Vault is paused — gameplay temporarily disabled.",
  GameExpired: "Game has expired.",
  GameNotExpired: "Game has not expired yet — wait for the cooldown.",
  CommitmentMismatch: "Commitment hash does not match.",
  RevealMismatch: "Revealed tiles do not match the layout.",
  GameAlreadySettled: "Game already settled.",
  GameNotFinished: "Game not yet finished.",
  NoTilesRevealed: "No tiles revealed yet.",
  SelfReferral: "You can't refer yourself.",
  ReferrerAlreadySet: "Referrer is already set.",
  ReferralMismatch: "Referral account doesn't match player_stats.referrer.",
  NothingToClaim: "Nothing to claim.",
  DestinationNotAllowlisted: "Withdrawal destination is not allowlisted.",
  AllowlistFull: "Allowlist is full.",
  AlreadyAllowlisted: "Address is already allowlisted.",
  AddressNotInAllowlist: "Address is not on the allowlist.",
  NoPendingOwner: "No pending owner to accept or cancel.",
  V2AlreadyInitialized: "V2 already initialized.",
  V2NotInitialized: "V2 not yet initialized.",
  DepositBelowMin: "Deposit is below the minimum amount.",
  UserPositionCapExceeded: "Deposit would exceed your per-user position cap.",
  HouseShareFloorBreached:
    "Deposit would push vault below minimum house share — try a smaller deposit.",
  HealthFloorBreached: "This action would push the vault below its minimum health threshold.",
  PendingWithdrawAlreadyExists: "You already have a pending withdrawal — cancel it first.",
  NoPendingWithdraw: "No pending withdrawal to cancel or complete.",
  CooldownNotElapsed: "Withdrawal cooldown not yet elapsed — try again later.",
  InsufficientUnits: "Insufficient units in your LP position.",
  InsufficientLiquidity: "Vault doesn't have enough liquidity for this withdrawal right now.",
  LpPositionNotEmpty: "LP position still has units; cannot close.",
  NoOperatorUnitsToUnlock: "No operator units to unlock.",
  VrfModeDisabled: "Play is switched off right now — try again later.",
  BadSessionKey:
    "This browser no longer holds the key for that round — use Recover to close it out.",
  RevealPending: "The randomness draw is still resolving — try again in a moment.",
  NoRevealPending: "No randomness draw is pending.",
  TooManyReveals: "Too many reveals for this round.",
  ReplayMismatch: "The round result did not verify — contact support.",
  NotStalledYet: "This round can be refunded in a few seconds.",
  BadGameAccount: "Round account mismatch.",
  GameAlreadyResolved: "This round is already finished — reload to see the result.",
  PayoutExceedsReserved: "Payout exceeds the amount reserved for this round.",
  GameStillDelegated: "The round is still in the rollup — use Recover to bring it back first.",
  VrfValidatorNotSet: "Play is not configured yet — try again later.",
  WrongVrfValidator: "Wrong rollup validator for this round.",
  NotDeployer: "Only the program deployer can initialize the vault.",
  WithdrawWindowExpired: "Withdrawal window expired — restart the withdrawal.",
  LegacyModeDisabled: "Classic mode is retired — reload the page to play.",
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
    const name = kaboomErrorByCode(code);
    if (name) return UI_BY_NAME[name];
    return `On-chain error ${code} — see explorer logs for detail.`;
  }
  // User-rejected sign in Privy looks like "user denied" or similar.
  if (/user (denied|rejected)/i.test(rawMessage)) return "Transaction cancelled.";
  if (/blockhash.*expired/i.test(rawMessage))
    return "Transaction timed out — network congestion. Please retry.";
  return rawMessage;
}
