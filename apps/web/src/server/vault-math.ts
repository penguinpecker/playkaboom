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

/** Effective per-user position cap (in lamports), scaled by health. */
export function effectiveMaxUserPositionLamports(
  v2: VaultV2StateAccount,
  vaultAssets: bigint,
  health: number,
): bigint {
  if (v2.maxUserPositionBps === 0) return vaultAssets; // disabled
  return (
    (((vaultAssets * BigInt(v2.maxUserPositionBps)) / BPS) * BigInt(health)) /
    BPS
  );
}

export function effectiveMaxBetLamports(
  vaultAssets: bigint,
  baseMaxBetBps: number,
  health: number,
): bigint {
  return (
    (((vaultAssets * BigInt(baseMaxBetBps)) / BPS) * BigInt(health)) / BPS
  );
}

export function effectiveMaxPayoutLamports(
  vaultAssets: bigint,
  baseMaxPayoutBps: number,
  health: number,
): bigint {
  return (
    (((vaultAssets * BigInt(baseMaxPayoutBps)) / BPS) * BigInt(health)) / BPS
  );
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
