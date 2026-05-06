import { NextResponse } from "next/server";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { deriveVaultPda } from "@playkaboom/sdk";
import { housePubkey, programId } from "@/server/env";
import { getConnection } from "@/server/connection";
import { jsonError } from "@/server/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [vaultPda] = deriveVaultPda(programId());
    const lamports = await getConnection().getBalance(vaultPda, "confirmed");
    return NextResponse.json({
      status: "ok",
      programId: programId().toBase58(),
      vaultPda: vaultPda.toBase58(),
      vaultBalanceSol: lamports / LAMPORTS_PER_SOL,
      vaultBalanceLamports: lamports,
      houseAuthority: housePubkey().toBase58(),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return jsonError(err);
  }
}
