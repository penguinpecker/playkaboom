import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { decodeGameSession, deriveGamePda } from "@playkaboom/sdk";
import { getConnection } from "@/server/connection";
import { programId } from "@/server/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ player: string }> }) {
  try {
    const { player } = await params;
    const playerPk = new PublicKey(player);
    const [pda] = deriveGamePda(programId(), playerPk);
    const info = await getConnection().getAccountInfo(pda, "confirmed");
    if (!info) return NextResponse.json({ active: false });
    const decoded = decodeGameSession(info.data);
    return NextResponse.json({
      active: true,
      gamePda: pda.toBase58(),
      status: decoded.status,
      bet: decoded.bet.toString(),
      mineCount: decoded.mineCount,
      safeReveals: decoded.safeReveals,
      multiplierBps: decoded.multiplierBps.toString(),
      startSlot: decoded.startSlot.toString(),
      settled: decoded.settled,
    });
  } catch {
    return NextResponse.json({ active: false });
  }
}
