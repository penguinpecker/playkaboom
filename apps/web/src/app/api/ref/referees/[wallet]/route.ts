import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { decodePlayerStats } from "@playkaboom/sdk";
import { jsonError } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { getConnection } from "@/server/connection";
import { programId } from "@/server/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ wallet: string }>;
}

const PLAYER_STATS_SIZE = 203;
const REFERRER_OFFSET = 107; // Option<Pubkey>: 1-byte tag at 106, pk at 107

/**
 * Lists every wallet that has set this wallet as their on-chain referrer.
 * Scans PlayerStats accounts via getProgramAccounts with a memcmp filter,
 * so the answer is ground-truth on-chain — no Supabase visit funnel
 * dependency. Authed: only the wallet's owner can pull their list.
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const { wallet } = await ctx.params;
    let referrer: PublicKey;
    try {
      referrer = new PublicKey(wallet);
    } catch {
      return NextResponse.json({ error: "Invalid wallet" }, { status: 400 });
    }
    await verifyPlayerAuth(req, wallet);

    const conn = getConnection();
    const accounts = await conn.getProgramAccounts(programId(), {
      filters: [
        { dataSize: PLAYER_STATS_SIZE },
        { memcmp: { offset: REFERRER_OFFSET, bytes: referrer.toBase58() } },
      ],
      commitment: "confirmed",
    });

    const referees: Array<{
      player: string;
      gamesPlayed: string;
      totalWagered: string;
      totalPayouts: string;
      lastPlayedUnix: number;
    }> = [];
    for (const a of accounts) {
      let s;
      try {
        s = decodePlayerStats(a.account.data);
      } catch {
        continue;
      }
      if (!s.referrer || !s.referrer.equals(referrer)) continue;
      referees.push({
        player: s.player.toBase58(),
        gamesPlayed: s.gamesPlayed.toString(),
        totalWagered: s.totalWagered.toString(),
        totalPayouts: s.totalPayouts.toString(),
        lastPlayedUnix: Number(s.lastPlayed),
      });
    }
    referees.sort(
      (a, b) => Number(BigInt(b.totalWagered) - BigInt(a.totalWagered)),
    );

    return NextResponse.json({
      referrer: referrer.toBase58(),
      count: referees.length,
      referees,
    });
  } catch (err) {
    return jsonError(err);
  }
}
