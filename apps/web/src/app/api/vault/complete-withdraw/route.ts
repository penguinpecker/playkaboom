import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { buildCompleteWithdraw, serializeIx } from "@playkaboom/sdk";
import { jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { programId } from "@/server/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ player: z.string().min(32) });

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, Body);
    await verifyPlayerAuth(req, body.player);
    const ix = buildCompleteWithdraw({
      ctx: { programId: programId() },
      user: new PublicKey(body.player),
    });
    return NextResponse.json({ instruction: serializeIx(ix) });
  } catch (err) {
    return jsonError(err);
  }
}
