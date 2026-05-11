/**
 * Anchor's error codes for the kaboom program. The numeric value is
 * `6000 + index` (Anchor's offset for user errors).
 */
// MUST stay in the EXACT order of `pub enum KaboomError` in
// programs/kaboom/src/lib.rs (line ~2272). Anchor assigns user error codes
// as `6000 + index`; an out-of-order entry here decodes the wrong name.
// Last cross-checked with on-chain enum on 2026-05-11.
export const KABOOM_ERROR_NAMES = [
  "InvalidMineCount",
  "InvalidTileIndex",
  "TileAlreadyRevealed",
  "GameNotPlaying",
  "BetTooLow",
  "BetExceedsMax",
  "VaultInsufficientFunds",
  "Unauthorized",
  "MathOverflow",
  "InvalidAmount",
  "InvalidConfig",
  "InvalidCommitment",
  "VaultPaused",
  "GameExpired",
  "GameNotExpired",
  "CommitmentMismatch",
  "RevealMismatch",
  "GameAlreadySettled",
  "GameNotFinished",
  "NoTilesRevealed",
  "SelfReferral",
  "ReferrerAlreadySet",
  "ReferralMismatch",
  "NothingToClaim",
  "DestinationNotAllowlisted",
  "AllowlistFull",
  "AlreadyAllowlisted",
  "AddressNotInAllowlist",
  "NoPendingOwner",
  // ─── Phase 2: LP vault ──────────────────────────────────────────────────
  "V2AlreadyInitialized",
  "V2NotInitialized",
  "DepositBelowMin",
  "UserPositionCapExceeded",
  "HouseShareFloorBreached",
  "HealthFloorBreached",
  "PendingWithdrawAlreadyExists",
  "NoPendingWithdraw",
  "CooldownNotElapsed",
  "InsufficientUnits",
  "InsufficientLiquidity",
  "LpPositionNotEmpty",
] as const;

export type KaboomErrorName = (typeof KABOOM_ERROR_NAMES)[number];

const ERROR_BASE = 6000;

export function kaboomErrorByCode(code: number): KaboomErrorName | undefined {
  const idx = code - ERROR_BASE;
  if (idx < 0 || idx >= KABOOM_ERROR_NAMES.length) return undefined;
  return KABOOM_ERROR_NAMES[idx];
}

/**
 * Best-effort extraction of the program error name from a `SendTransactionError`
 * or its `logs`. Useful for surfacing actionable UX strings to players.
 */
export function extractKaboomError(err: unknown): KaboomErrorName | undefined {
  const logs = collectLogs(err);
  for (const line of logs) {
    const m = /Error Code: ([A-Z][A-Za-z]+)\.?/.exec(line) ?? /custom program error: 0x([0-9a-fA-F]+)/.exec(line);
    if (!m) continue;
    if (/^[A-Z]/.test(m[1] ?? "")) {
      const name = m[1] as KaboomErrorName;
      if (KABOOM_ERROR_NAMES.includes(name)) return name;
    } else {
      const code = parseInt(m[1] ?? "0", 16);
      const name = kaboomErrorByCode(code);
      if (name) return name;
    }
  }
  return undefined;
}

function collectLogs(err: unknown): string[] {
  if (!err || typeof err !== "object") return [];
  const e = err as { logs?: string[]; message?: string };
  const out: string[] = [];
  if (Array.isArray(e.logs)) out.push(...e.logs);
  if (typeof e.message === "string") out.push(e.message);
  return out;
}

/**
 * Anchor framework error codes (programs/anchor/lang/src/error.rs). These
 * are emitted by Anchor's account constraints — *not* a program's custom
 * KaboomError enum (which lives at 6000+). Most useful for distinguishing
 * "this account doesn't exist on chain" (3012) from a program-rejected
 * business-rule error.
 */
export interface AnchorFrameworkError {
  /** Anchor's numeric error code, e.g. 3012. */
  code: number;
  /** Anchor's enum variant name, e.g. "AccountNotInitialized". */
  name: string;
  /** Name of the account that failed the constraint, if Anchor surfaced one. */
  account?: string;
}

const ANCHOR_FRAMEWORK_NAMES: Record<string, number> = {
  AccountNotInitialized: 3012,
  AccountDiscriminatorAlreadySet: 3000,
  AccountDiscriminatorNotFound: 3001,
  AccountDiscriminatorMismatch: 3002,
  AccountDidNotDeserialize: 3003,
  AccountDidNotSerialize: 3004,
  AccountNotEnoughKeys: 3005,
  AccountNotMutable: 3006,
  AccountOwnedByWrongProgram: 3007,
  InvalidProgramId: 3008,
  InvalidProgramExecutable: 3009,
  AccountNotSigner: 3010,
  AccountNotSystemOwned: 3011,
};

/**
 * Best-effort decode of an Anchor framework error from a thrown
 * SendTransactionError / SimulatedTransactionResponse / generic error
 * carrying `.logs`. Returns the matched framework error, or undefined.
 *
 * Anchor's structured log format is stable since 0.27:
 *   "Program log: AnchorError caused by account: <name>. Error Code:
 *    <Name>. Error Number: <N>. Error Message: …"
 * Older / non-Anchor RPC log paths sometimes only emit
 *   "custom program error: 0xN"
 * — covered as a fallback. Custom user errors (6000+) are intentionally
 * NOT mapped here; use `extractKaboomError` for those.
 */
export function extractAnchorFrameworkError(err: unknown): AnchorFrameworkError | undefined {
  const logs = collectLogs(err);
  for (const line of logs) {
    const struct =
      /AnchorError caused by account: (\S+?)\. Error Code: (\w+)\. Error Number: (\d+)/.exec(line) ??
      /AnchorError occurred\. Error Code: (\w+)\. Error Number: (\d+)/.exec(line);
    if (struct) {
      const hasAccount = struct.length === 4;
      const name = hasAccount ? struct[2]! : struct[1]!;
      const code = Number(hasAccount ? struct[3] : struct[2]);
      if (Number.isFinite(code) && code >= 3000 && code < 6000) {
        return { code, name, account: hasAccount ? struct[1] : undefined };
      }
    }
    const custom = /custom program error: 0x([0-9a-fA-F]+)/.exec(line);
    if (custom) {
      const code = parseInt(custom[1] ?? "", 16);
      if (Number.isFinite(code) && code >= 3000 && code < 6000) {
        const name =
          Object.entries(ANCHOR_FRAMEWORK_NAMES).find(([, v]) => v === code)?.[0] ?? `Anchor_${code}`;
        return { code, name };
      }
    }
  }
  return undefined;
}

/**
 * True iff the error carries Anchor's `AccountNotInitialized` (3012) in its
 * logs. This is the deterministic signal that an account a constraint
 * expected to exist did not exist at simulation time. Use it to decide
 * between "retry, propagation may not have landed" and "give up, account
 * is gone".
 */
export function isAccountNotInitializedError(err: unknown): boolean {
  const fw = extractAnchorFrameworkError(err);
  return fw?.code === 3012 || fw?.name === "AccountNotInitialized";
}
