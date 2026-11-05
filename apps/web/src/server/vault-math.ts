import "server-only";
import type { VaultV2StateAccount, LpPositionAccount } from "@playkaboom/sdk";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

const BPS = 10_000n;
const SCALE = 10n ** 18n;

/**
 * Mirrors the on-chain `calc_health_bps` helper. Returns 0..10000.
 * `vaultAssets` should be `vault.lamports - rentMinimum`.
 */
export function healthBps(v2: VaultV2StateAccount, vaultAssets: bigint): number {
  if (vaultAssets <= 0n) return 0;
  const pendingValue =
    v2.totalUnits === 0n
      ? 0n
      : (v2.totalPendingUnits * vaultAssets) / v2.totalUnits;
  const obligations = v2.totalOutstandingMaxPayout + pendingValue;
  const free = vaultAssets > obligations ? vaultAssets - obligations : 0n;
  const h = (free * BPS) / vaultAssets;
  return Number(h > BPS ? BPS : h);
}

/** unit_value scaled by 1e18 for stable storage. */
export function unitValueE18(vaultAssets: bigint, totalUnits: bigint): bigint {
  if (totalUnits === 0n) return 0n;
  return (vaultAssets * SCALE) / totalUnits;
}

/** Convert units → lamports at the current unit_value (floor div, vault-favorable). */
export function unitsToLamports(
  units: bigint,
  vaultAssets: bigint,
  totalUnits: bigint,
): bigint {
  if (totalUnits === 0n || units === 0n) return 0n;
  return (units * vaultAssets) / totalUnits;
}

/** Convert lamports → units (floor div, vault-favorable on deposit). */
export function lamportsToUnits(
  amount: bigint,
  vaultAssetsPre: bigint,
  totalUnitsPre: bigint,
): bigint {
  if (totalUnitsPre === 0n) return amount;
  if (vaultAssetsPre <= 0n) return 0n;
  return (amount * totalUnitsPre) / vaultAssetsPre;
}

/** Effective per-user position cap (in lamports), scaled by health.
 *
 * When the on-chain `max_user_position_bps` is 0 the cap is DISABLED —
 * no per-user limit at all. We return `2^60` here (≈ 1.15 BILLION SOL,
 * far past any plausible deposit) so the pre-flight comparison in
 * /api/vault/deposit never blocks. Prior code returned `vaultAssets`,
 * which wrongly capped a "disabled" deposit at the current vault size
 * and produced confusing UI errors when an operator tried to refund a
 * large position into a small vault. */
const POSITION_CAP_DISABLED_SENTINEL = 1n << 60n;
export function effectiveMaxUserPositionLamports(
  v2: VaultV2StateAccount,
  vaultAssets: bigint,
  health: number,
): bigint {
  if (v2.maxUserPositionBps === 0) return POSITION_CAP_DISABLED_SENTINEL;
  return (
    (((vaultAssets * BigInt(v2.maxUserPositionBps)) / BPS) * BigInt(health)) /
    BPS
  );
}

/**
 * "Max single deposit": the per-user cap above, further limited by the
 * house-share floor lp_deposit enforces (6033, pinocchio/kaboom-p ix/v2_lp.rs):
 *   units  = floor(amount × total_units / vault_assets)        (deposit_to_units)
 *   user   = total − seed − house − house_pending + units      (user_units_total)
 *   passes iff house × 10_000 ≥ min_house_share_bps × (house + user)
 * The floor is the same for every depositor. 0 when not even min_lp_deposit can
 * pass; the sentinel only when neither limit applies.
 */
export function maxDepositLamports(
  v2: VaultV2StateAccount,
  vaultAssets: bigint,
  health: number,
): bigint {
  let max = effectiveMaxUserPositionLamports(v2, vaultAssets, health);
  const bps = BigInt(v2.minHouseShareBps);
  if (bps > 0n) {
    const user = v2.totalUnits - v2.seedUnits - v2.houseUnits - v2.housePendingUnits;
    const room = (v2.houseUnits * (BPS - bps)) / bps - user; // most units one deposit may mint
    const byFloor =
      room <= 0n ? 0n
      : v2.totalUnits === 0n ? room
      : vaultAssets <= 0n ? 0n
      // floor(a × T / A) ≤ room  ⇔  a ≤ ((room + 1) × A − 1) / T
      : ((room + 1n) * vaultAssets - 1n) / v2.totalUnits;
    if (byFloor < max) max = byFloor;
  }
  return max < v2.minLpDeposit ? 0n : max;
}

/**
 * The unit_value (×1e18) an lp_deposit was priced at, i.e. just BEFORE it, from
 * its LpDeposited event (which carries the after-state): assets_after =
 * assets_pre + amount, total_units_after = total_pre + units_minted. The first
 * deposit into an empty vault mints one unit per lamport.
 */
export function depositUnitValueE18(ev: {
  amountLamports: bigint;
  unitsMinted: bigint;
  totalUnitsAfter: bigint;
  vaultAssetsAfter: bigint;
}): bigint {
  const totalPre = ev.totalUnitsAfter - ev.unitsMinted;
  return totalPre === 0n ? SCALE : unitValueE18(ev.vaultAssetsAfter - ev.amountLamports, totalPre);
}

export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

/**
 * Position summary for a single user: principal value at current unit_value,
 * including pending. Active+pending share P&L identically (per design).
 */
export function lpPositionSummary(
  pos: LpPositionAccount,
  v2: VaultV2StateAccount,
  vaultAssets: bigint,
): {
  units: string;
  pendingUnits: string;
  totalUnits: string;
  currentValueLamports: string;
  pendingUnlockSlot: string;
} {
  const total = pos.units + pos.pendingUnits;
  const value = unitsToLamports(total, vaultAssets, v2.totalUnits);
  return {
    units: pos.units.toString(),
    pendingUnits: pos.pendingUnits.toString(),
    totalUnits: total.toString(),
    currentValueLamports: value.toString(),
    pendingUnlockSlot: pos.pendingUnlockSlot.toString(),
  };
}
