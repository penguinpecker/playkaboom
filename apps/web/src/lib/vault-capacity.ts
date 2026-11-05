import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { VaultAccount, VaultV2StateAccount } from "@playkaboom/sdk";
import { MAX_MINES, MIN_MINES, calcMultiplierBps } from "@playkaboom/shared";

const HOUSE_EDGE_BPS_DEFAULT = 200;

/**
 * The strict, on-chain-equivalent capacity reader. Returns the maximum
 * bet that would *actually* pass start_game's
 * `worst_payout <= max_payout` check for the supplied mine_count, plus
 * a structured reason when the cap is zero (so the UI can explain
 * "vault paused" vs "outstanding obligations" vs "rent floor").
 *
 * Mirror of start_game_vrf (pinocchio/kaboom-p/src/ix/vrf.rs). If you change
 * the on-chain check, change this too — the start tx will simulate fail
 * otherwise and players see error 6006.
 */
export interface CapacityResult {
  maxBetSol: number;
  maxBetLamports: bigint;
  /** available × effectiveMaxPayoutBps / 10_000 — the program's max_payout. */
  maxPayoutLamports: bigint;
  healthBps: number;
  effectiveMaxPayoutBps: number;
  worstCasePayoutSol: number;
  /** "ok" | "paused" | "v2_not_ready" | "vault_empty" | "obligations_full"
   *  | "exceeds_cap" — UI maps these to user-readable copy. */
  reason: string;
}

/**
 * Pure core of the capacity check, shared by the game page's bet controls,
 * the /vault and /logs headline numbers and /api/vault/state. Duplicating this
 * formula is how the UI and the program drift apart, which is exactly the bug
 * that let players pick a mine count the program would always reject.
 *
 * `rentLamports` is the vault's rent floor (`available = lamports - rent`);
 * `vrfMode` selects the VRF payout cap min(max_payout_bps, vrf_max_payout_bps).
 */
export function computeCapacity(
  lamports: bigint,
  vault: VaultAccount | null,
  v2: VaultV2StateAccount | null,
  betSol: number,
  mineCount: number,
  rentLamports: bigint,
  vrfMode: boolean,
): CapacityResult {
  {
    const empty: CapacityResult = {
      maxBetSol: 0,
      maxBetLamports: 0n,
      maxPayoutLamports: 0n,
      healthBps: 0,
      effectiveMaxPayoutBps: 0,
      worstCasePayoutSol: 0,
      reason: "vault_empty",
    };
    if (!vault) return empty;
    if (vault.paused) return { ...empty, reason: "paused" };
    if (lamports <= rentLamports) return empty;
    const available = lamports - rentLamports;

    // Health (mirrors calc_health_bps).
    let healthBps = 10_000;
    let obligations = 0n;
    if (v2) {
      const pendingValue =
        v2.totalUnits > 0n
          ? (v2.totalPendingUnits * available) / v2.totalUnits
          : 0n;
      obligations = v2.totalOutstandingMaxPayout + pendingValue;
      const free = obligations >= available ? 0n : available - obligations;
      healthBps = Number((free * 10_000n) / available);
      if (healthBps <= 0) {
        return { ...empty, reason: "obligations_full" };
      }
    }

    // VRF games are capped by min(vault.maxPayoutBps, v2.vrfMaxPayoutBps) —
    // see start_game_vrf. Using vault.maxPayoutBps alone here offered bets up
    // to 10x what the program would accept, so the UI handed the player a
    // "max" that always failed with VaultInsufficientFunds. Mirror the program
    // exactly.
    const payoutCapBps =
      vrfMode && v2 && v2.vrfMaxPayoutBps > 0
        ? Math.min(vault.maxPayoutBps, v2.vrfMaxPayoutBps)
        : vault.maxPayoutBps;
    const effectiveMaxPayoutBps = Math.floor((payoutCapBps * healthBps) / 10_000);
    // Convert "max payout" to "max bet" by dividing by the worst-case
    // multiplier for the chosen mine_count. The worst case is when the
    // player reveals every safe tile (safeReveals = GRID_SIZE - mineCount).
    const safeReveals = 16 - mineCount;
    if (safeReveals <= 0) return empty;
    const houseEdgeBps = vault.houseEdgeBps ?? HOUSE_EDGE_BPS_DEFAULT;
    const multBps = Number(calcMultiplierBps(safeReveals, mineCount, houseEdgeBps));
    if (multBps <= 0) return empty;

    // max_payout_lamports = available × effectiveMaxPayoutBps / 10_000
    // max_bet_lamports    = max_payout_lamports × 10_000 / multBps
    const maxPayoutLamports = (available * BigInt(effectiveMaxPayoutBps)) / 10_000n;
    // Also clamp by max_bet_bps × healthBps × available (the BetExceedsMax check).
    const effectiveMaxBetBps = Math.floor((vault.maxBetBps * healthBps) / 10_000);
    const maxBetByBetCap = (available * BigInt(effectiveMaxBetBps)) / 10_000n;
    const maxBetByPayout = (maxPayoutLamports * 10_000n) / BigInt(multBps);
    const maxBetLamports = maxBetByBetCap < maxBetByPayout ? maxBetByBetCap : maxBetByPayout;
    const maxBetSol = Number(maxBetLamports) / LAMPORTS_PER_SOL;

    const worstCasePayoutSol = (betSol * multBps) / 10_000;
    const reason = betSol > maxBetSol ? "exceeds_cap" : "ok";

    return {
      maxBetSol,
      maxBetLamports,
      maxPayoutLamports,
      healthBps,
      effectiveMaxPayoutBps,
      worstCasePayoutSol,
      reason,
    };
  }
}

/**
 * One headline "max bet" / "max payout" for pages that show a single number
 * (/vault, /logs, /api/vault/state): the largest bet ANY mine count accepts,
 * and the program's payout cap. Same maths as the bet controls, per mine count.
 */
export function vaultLimits(
  lamports: bigint,
  vault: VaultAccount | null,
  v2: VaultV2StateAccount | null,
  rentLamports: bigint,
  vrfMode: boolean,
): { maxBetLamports: bigint; maxPayoutLamports: bigint } {
  let maxBetLamports = 0n;
  let maxPayoutLamports = 0n;
  for (let m = MIN_MINES; m <= MAX_MINES; m++) {
    const c = computeCapacity(lamports, vault, v2, 0, m, rentLamports, vrfMode);
    if (c.maxBetLamports > maxBetLamports) maxBetLamports = c.maxBetLamports;
    if (c.maxPayoutLamports > maxPayoutLamports) maxPayoutLamports = c.maxPayoutLamports;
  }
  return { maxBetLamports, maxPayoutLamports };
}
