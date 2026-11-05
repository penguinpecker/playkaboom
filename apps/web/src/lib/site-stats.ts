import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { GRID_SIZE, MINE_OPTIONS, calcMultiplier } from "@playkaboom/shared";

/**
 * Site-wide figures from /api/leaderboard?view=alltime (one row per player in
 * player_stats). Settled games only, so a voided/refunded round is not counted,
 * unlike vault.totalGames which counts every start.
 * ponytail: the API returns the top 50 rows; past 50 players these undercount.
 * Add a totals field to /api/leaderboard then.
 */
export function leaderboardTotals(
  rows: readonly { games_played: number; total_wagered: number; total_payouts: number }[],
) {
  let gamesPlayed = 0;
  let pnlLamports = 0;
  for (const r of rows) {
    gamesPlayed += Number(r.games_played);
    pnlLamports += Number(r.total_payouts) - Number(r.total_wagered);
  }
  return { players: rows.length, gamesPlayed, pnlSol: pnlLamports / LAMPORTS_PER_SOL };
}

/**
 * Highest full-clear multiplier among the mine counts /play actually offers:
 * those the vault can cover at the minimum bet (the rest are greyed out).
 * null while nothing is coverable / the vault has not loaded.
 */
export function maxOfferedMultiplier(
  maxBetByMines: Record<number, number>,
  minBetSol: number,
  houseEdgeBps: number,
  options: readonly number[] = MINE_OPTIONS,
): number | null {
  let best: number | null = null;
  for (const m of options) {
    if ((maxBetByMines[m] ?? 0) < minBetSol) continue;
    const mult = calcMultiplier(GRID_SIZE - m, m, houseEdgeBps);
    if (best === null || mult > best) best = mult;
  }
  return best;
}

export function isValidWallet(addr: string): boolean {
  try {
    new PublicKey(addr);
    return true;
  } catch {
    return false;
  }
}

/** Parse a JSON API response; a non-2xx throws the API's own `error` text. */
export async function readJsonOrThrow<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
