import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  decodeLpPosition,
  decodeVault,
  decodeVaultV2State,
  deriveLpPositionPda,
  deriveV2StatePda,
  deriveVaultPda,
} from "@playkaboom/sdk";
import { programId } from "@/server/env";
import { getConnection } from "@/server/connection";
import { supabasePublic } from "@/server/db/supabase";
import { jsonError } from "@/server/api-helpers";
import { lamportsToSol, unitsToLamports } from "@/server/vault-math";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ wallet: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    const { wallet: walletStr } = await ctx.params;
    let wallet: PublicKey;
    try {
      wallet = new PublicKey(walletStr);
    } catch {
      return NextResponse.json({ error: "Invalid wallet" }, { status: 400 });
    }

    const conn = getConnection();
    const [vaultPda] = deriveVaultPda(programId());
    const [v2Pda] = deriveV2StatePda(programId());
    const [posPda] = deriveLpPositionPda(programId(), wallet);

    const [vaultInfo, v2Info, posInfo] = await Promise.all([
      conn.getAccountInfo(vaultPda, "confirmed"),
      conn.getAccountInfo(v2Pda, "confirmed"),
      conn.getAccountInfo(posPda, "confirmed"),
    ]);

    if (!vaultInfo || !v2Info) {
      return NextResponse.json({ error: "Vault not initialised" }, { status: 503 });
    }

    const vaultLamports = BigInt(vaultInfo.lamports);
    const rent = BigInt(
      await conn.getMinimumBalanceForRentExemption(vaultInfo.data.length),
    );
    const vaultAssets = vaultLamports > rent ? vaultLamports - rent : 0n;
    const v2 = decodeVaultV2State(v2Info.data);

    if (!posInfo) {
      // No position yet — return zeros.
      return NextResponse.json({
        wallet: walletStr,
        units: "0",
        pendingUnits: "0",
        pendingUnlockSlot: "0",
        currentValueLamports: "0",
        currentValueSol: 0,
        deposited: 0,
        withdrawn: 0,
        netDeposited: 0,
        pnlLamports: 0,
        pnlPercent: null,
        history: [],
      });
    }

    const pos = decodeLpPosition(posInfo.data);
    const totalUnits = pos.units + pos.pendingUnits;
    const value = unitsToLamports(totalUnits, vaultAssets, v2.totalUnits);

    // Pull deposit/withdrawal history from indexer.
    const sb = supabasePublic();
    const [{ data: posRow }, { data: actions }] = await Promise.all([
      sb
        .from("lp_positions")
        .select("cumulative_deposited, cumulative_withdrawn")
        .eq("user_address", walletStr)
        .maybeSingle(),
      sb
        .from("lp_actions")
        .select(
          "signature, action, units_delta, lamports_delta, unit_value_lamports, slot, block_time",
        )
        .eq("user_address", walletStr)
        .order("block_time", { ascending: false })
        .limit(50),
    ]);

    const cumulativeDeposited = posRow?.cumulative_deposited ?? 0;
    const cumulativeWithdrawn = posRow?.cumulative_withdrawn ?? 0;
    const netDeposited = cumulativeDeposited - cumulativeWithdrawn;
    const pnl = Number(value) - netDeposited;
    const pnlPercent = netDeposited > 0 ? pnl / netDeposited : null;

    return NextResponse.json({
      wallet: walletStr,
      units: pos.units.toString(),
      pendingUnits: pos.pendingUnits.toString(),
      pendingUnlockSlot: pos.pendingUnlockSlot.toString(),
      currentValueLamports: value.toString(),
      currentValueSol: lamportsToSol(value),
      deposited: cumulativeDeposited,
      withdrawn: cumulativeWithdrawn,
      netDeposited,
      pnlLamports: pnl,
      pnlPercent,
      history: actions ?? [],
    });
  } catch (err) {
    return jsonError(err);
  }
}
