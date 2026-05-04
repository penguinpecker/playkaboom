/**
 * Anchor's error codes for the kaboom program. The numeric value is
 * `6000 + index` (Anchor's offset for user errors).
 */
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
