import { NextResponse } from "next/server";
import {
  decodeVaultV2State,
  deriveV2StatePda,
  deriveVaultPda,
} from "@playkaboom/sdk";
import { programId } from "@/server/env";
import { getConnection } from "@/server/connection";
import { supabasePublic } from "@/server/db/supabase";
import { jsonError } from "@/server/api-helpers";
import {
  effectiveMaxBetLamports,
  effectiveMaxPayoutLamports,
  effectiveMaxUserPositionLamports,
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
        vaultBalanceLamports: lamports.toString(),
        vaultAssetsLamports: vaultAssets.toString(),
        vaultBalanceSol: lamportsToSol(lamports),
        timestamp: new Date().toISOString(),
      });
    }

    const v2 = decodeVaultV2State(v2Info.data);
    const health = healthBps(v2, vaultAssets);
    const uvE18 = unitValueE18(vaultAssets, v2.totalUnits);

    // APY: lookup unit_value at now − 30 days, annualise.
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    const sb = supabasePublic();
    const { data: history } = await sb
      .from("vault_unit_value_history")
      .select("unit_value_e18, block_time")
      .lte("block_time", thirtyDaysAgo.toISOString())
      .order("block_time", { ascending: false })
      .limit(1);

    let apy30d: number | null = null;
    if (history && history.length > 0 && uvE18 > 0n && history[0]) {
      const past = BigInt(history[0].unit_value_e18 as unknown as string);
      if (past > 0n) {
        // ratio = uvE18 / past; annualise: ratio^(365/30) - 1
        const ratio = Number(uvE18) / Number(past);
        if (Number.isFinite(ratio) && ratio > 0) {
          apy30d = Math.pow(ratio, 365 / 30) - 1;
        }
      }
    }

    return NextResponse.json({
      v2Initialized: true,
      programId: programId().toBase58(),
      vaultPda: vaultPda.toBase58(),
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
      effectiveMaxBetSol: lamportsToSol(
        effectiveMaxBetLamports(vaultAssets, vault.maxBetBps, health),
      ),
      effectiveMaxPayoutSol: lamportsToSol(
        effectiveMaxPayoutLamports(vaultAssets, vault.maxPayoutBps, health),
      ),
      effectiveMaxUserDepositSol: lamportsToSol(
        effectiveMaxUserPositionLamports(v2, vaultAssets, health),
      ),
      withdrawCooldownSlots: v2.withdrawCooldownSlots.toString(),
      withdrawCooldownDays: Number(v2.withdrawCooldownSlots) * 0.4 / 86_400,
      minLpDepositLamports: v2.minLpDeposit.toString(),
      apy30d,
      timestamp: now.toISOString(),
      // Used internally; never display in UX (rule from VAULT_LP_PLAN.md §1.7).
      __internal: { suppress: "house_units, seed_units" },
    });
  } catch (err) {
    return jsonError(err);
  }
}
