import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import {
  buildLpDeposit,
  decodeVault,
  decodeVaultV2State,
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
    const [vaultInfo, v2Info] = await Promise.all([
      conn.getAccountInfo(vaultPda, "confirmed"),
      conn.getAccountInfo(v2Pda, "confirmed"),
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

    // Pre-flight cap check so we fail fast before the user signs.
    const health = healthBps(v2, vaultAssets);
    const cap = effectiveMaxUserPositionLamports(v2, vaultAssets, health);
    // We approximate post-deposit position as deposit value at current unit_value.
    // This will be checked exactly on-chain.
    if (cap < body.amountLamports) {
      throw new ApiError(
        400,
        `Deposit exceeds per-user cap (${cap.toString()} lamports remaining at health ${health}/10000)`,
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
