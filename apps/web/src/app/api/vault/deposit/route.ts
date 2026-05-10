import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import {
  buildLpDeposit,
  decodeLpPosition,
  decodeVault,
  decodeVaultV2State,
  deriveLpPositionPda,
  deriveV2StatePda,
  deriveVaultPda,
  serializeIx,
} from "@playkaboom/sdk";
import { ApiError, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { getConnection } from "@/server/connection";
import { programId } from "@/server/env";
import {
  effectiveMaxUserPositionLamports,
  healthBps,
  unitsToLamports,
} from "@/server/vault-math";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  player: z.string().min(32),
  amountLamports: z.coerce.bigint().refine((v) => v > 0n, "amount must be > 0"),
});

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, Body);
    await verifyPlayerAuth(req, body.player);

    const conn = getConnection();
    const [vaultPda] = deriveVaultPda(programId());
    const [v2Pda] = deriveV2StatePda(programId());
    const [lpPda] = deriveLpPositionPda(programId(), new PublicKey(body.player));
    const [vaultInfo, v2Info, lpInfo] = await Promise.all([
      conn.getAccountInfo(vaultPda, "confirmed"),
      conn.getAccountInfo(v2Pda, "confirmed"),
      conn.getAccountInfo(lpPda, "confirmed"),
    ]);
    if (!vaultInfo || !v2Info) {
      throw new ApiError(503, "Vault not initialised");
    }
    const vault = decodeVault(vaultInfo.data);
    const v2 = decodeVaultV2State(v2Info.data);
    const lamports = BigInt(vaultInfo.lamports);
    const rent = BigInt(
      await conn.getMinimumBalanceForRentExemption(vaultInfo.data.length),
    );
    const vaultAssets = lamports > rent ? lamports - rent : 0n;

    if (body.amountLamports < v2.minLpDeposit) {
      throw new ApiError(
        400,
        `Below minimum deposit (${v2.minLpDeposit.toString()} lamports)`,
      );
    }

    // V4 fix: pre-flight cap check matches the ON-CHAIN check at
    // programs/kaboom/src/lib.rs `lp_deposit` — total position (existing
    // units + pending units, valued at current unit_value, plus the new
    // deposit) must be <= per-user cap. The previous version compared
    // the cap to JUST the new deposit amount, which falsely passed any
    // user already near the cap and the on-chain ix then reverted —
    // user paid gas + got a confusing error after signing.
    const currentUnits = (() => {
      if (!lpInfo) return 0n;
      try {
        const lp = decodeLpPosition(lpInfo.data);
        return lp.units + lp.pendingUnits;
      } catch {
        return 0n;
      }
    })();
    const currentPositionLamports = unitsToLamports(
      currentUnits,
      vaultAssets,
      v2.totalUnits,
    );
    const health = healthBps(v2, vaultAssets);
    const cap = effectiveMaxUserPositionLamports(v2, vaultAssets, health);
    const newPositionLamports = currentPositionLamports + body.amountLamports;
    if (cap < newPositionLamports) {
      const headroom = cap > currentPositionLamports ? cap - currentPositionLamports : 0n;
      throw new ApiError(
        400,
        `Deposit would exceed per-user cap. You hold ${currentPositionLamports.toString()} lamports; cap is ${cap.toString()} at health ${health}/10000. Max deposit right now: ${headroom.toString()} lamports.`,
      );
    }

    void vault; // referenced to keep the destructure for clarity
    const ix = buildLpDeposit({
      ctx: { programId: programId() },
      user: new PublicKey(body.player),
      amountLamports: body.amountLamports,
    });
    return NextResponse.json({ instruction: serializeIx(ix) });
  } catch (err) {
    return jsonError(err);
  }
}
