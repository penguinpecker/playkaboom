import { NextResponse } from "next/server";
import {
  decodeVaultV2State,
  deriveV2StatePda,
  deriveVaultPda,
} from "@playkaboom/sdk";
import { programId } from "@/server/env";
import { getConnection, msPerSlot } from "@/server/connection";
import { trailingApy } from "@/server/vault-history";
import { jsonError } from "@/server/api-helpers";
import { vaultLimits } from "@/lib/vault-capacity";
import {
  maxDepositLamports,
  healthBps,
  lamportsToSol,
  unitValueE18,
} from "@/server/vault-math";
import { decodeVault } from "@playkaboom/sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VAULT_RENT_MIN_LAMPORTS = 3_415_390n; // matches Vault::SPACE rent on devnet/mainnet

export async function GET() {
  try {
    const conn = getConnection();
    const [vaultPda] = deriveVaultPda(programId());
    const [v2Pda] = deriveV2StatePda(programId());

    const [vaultInfo, v2Info] = await Promise.all([
      conn.getAccountInfo(vaultPda, "confirmed"),
      conn.getAccountInfo(v2Pda, "confirmed"),
    ]);

    if (!vaultInfo) {
      return NextResponse.json({ error: "Vault PDA missing" }, { status: 503 });
    }

    const vault = decodeVault(vaultInfo.data);
    const lamports = BigInt(vaultInfo.lamports);
    const rent = BigInt(
      await conn.getMinimumBalanceForRentExemption(vaultInfo.data.length),
    );
    const vaultAssets = lamports > rent ? lamports - rent : 0n;

    if (!v2Info) {
      // Pre-migration fallback: only return baseline data.
      return NextResponse.json({
        v2Initialized: false,
        programId: programId().toBase58(),
        vaultPda: vaultPda.toBase58(),
        houseAuthority: vault.houseAuthority.toBase58(),
        vaultBalanceLamports: lamports.toString(),
        vaultAssetsLamports: vaultAssets.toString(),
        vaultBalanceSol: lamportsToSol(lamports),
        timestamp: new Date().toISOString(),
      });
    }

    const v2 = decodeVaultV2State(v2Info.data);
    const health = healthBps(v2, vaultAssets);
    const uvE18 = unitValueE18(vaultAssets, v2.totalUnits);
    // The program is VRF-only (legacy start_game returns 6057), so the VRF
    // payout cap and the per-mine worst case are the real limits.
    const limits = vaultLimits(lamports, vault, v2, rent, true);
    const slotMs = await msPerSlot(conn);

    // APY: this program's newest unit_value reading >= 30 days old, annualised by its real age.
    const now = new Date();
    const apy30d = await trailingApy(uvE18, now);

    return NextResponse.json({
      v2Initialized: true,
      programId: programId().toBase58(),
      vaultPda: vaultPda.toBase58(),
      // The house signer, read from chain (public key only).
      houseAuthority: vault.houseAuthority.toBase58(),
      vaultBalanceLamports: lamports.toString(),
      vaultAssetsLamports: vaultAssets.toString(),
      vaultBalanceSol: lamportsToSol(lamports),
      // Aggregate units (does NOT break out house_units to user-facing view).
      totalUnits: v2.totalUnits.toString(),
      totalPendingUnits: v2.totalPendingUnits.toString(),
      unitValueE18: uvE18.toString(),
      // Health-factor and effective caps so the frontend can disable buttons.
      healthBps: health,
      minHealthBps: v2.minHealthBps,
      // 0 ⇒ per-user deposit cap disabled on-chain.
      maxUserPositionBps: v2.maxUserPositionBps,
      // Largest bet any mine count accepts (1 mine), and the VRF payout cap.
      effectiveMaxBetSol: lamportsToSol(limits.maxBetLamports),
      effectiveMaxPayoutSol: lamportsToSol(limits.maxPayoutLamports),
      // Per-user cap AND the house-share floor (6033); 0 when no deposit can
      // pass, the "no limit" sentinel only when neither applies.
      effectiveMaxUserDepositSol: lamportsToSol(
        maxDepositLamports(v2, vaultAssets, health),
      ),
      withdrawCooldownSlots: v2.withdrawCooldownSlots.toString(),
      // Measured slot time, not a nominal 400 ms (mainnet runs ~214 ms).
      withdrawCooldownDays: (Number(v2.withdrawCooldownSlots) * slotMs) / 86_400_000,
      msPerSlot: slotMs,
      minLpDepositLamports: v2.minLpDeposit.toString(),
      apy30d,
      timestamp: now.toISOString(),
    });
  } catch (err) {
    return jsonError(err);
  }
}
