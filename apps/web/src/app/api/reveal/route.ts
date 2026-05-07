import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  buildCloseGame,
  buildRevealTile,
  buildSettleGame,
  serializeIx,
} from "@playkaboom/sdk";
import { RevealTileInput } from "@playkaboom/shared";
import { ApiError, clientIp, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { checkTile, saltBuffer } from "@/server/game";
import { encryptSession } from "@/server/session";
import { loadSession, saveSession } from "@/server/session-store";
import { sendHouseTx } from "@/server/solana";
import { housePubkey, programId } from "@/server/env";
import { enforceRateLimit } from "@/server/ratelimit";
import { logger } from "@/server/logger";
import { indexFreshSignature } from "@/server/inline-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, RevealTileInput);

    await verifyPlayerAuth(req, body.player);

    const rl = await enforceRateLimit(`reveal:${clientIp(req)}:${body.player}`);
    if (!rl.ok) throw new ApiError(429, "Too many requests");

    const session = await loadSession(body.player, body.gameToken);
    if (!session) throw new ApiError(404, "No active session — start a new game");
    if (session.player !== body.player) {
      throw new ApiError(403, "Player mismatch");
    }
    if (session.reveals.includes(body.tileIndex)) {
      throw new ApiError(409, "Tile already revealed");
    }

    const playerPk = new PublicKey(body.player);
    const housePk = housePubkey();
    const ctx = { programId: programId() };

    const { isMine, updated } = checkTile(session, body.tileIndex);
    const revealIx = buildRevealTile({
      ctx,
      player: playerPk,
      houseAuthority: housePk,
      tileIndex: body.tileIndex,
      isMine,
    });

    let signature: string;
    let closeInstruction: ReturnType<typeof serializeIx> | undefined;

    if (isMine) {
      // Atomic reveal + settle so the player can never see "lost but unsettled".
      const settleIx = buildSettleGame({
        ctx,
        player: playerPk,
        houseAuthority: housePk,
        mineLayout: updated.mineLayout,
        salt: saltBuffer(updated),
      });
      signature = await sendHouseTx([revealIx, settleIx]);
      closeInstruction = serializeIx(buildCloseGame({ ctx, player: playerPk }));
      // Auto-settle on mine — push to indexer immediately so the global
      // activity feed reflects the loss within seconds rather than waiting
      // up to 5min for the next cron run.
      await indexFreshSignature(signature);
    } else {
      signature = await sendHouseTx([revealIx]);
    }

    const safeReveals = updated.reveals.filter((t) => (updated.mineLayout & (1 << t)) === 0).length;

    logger.info(
      { player: body.player, tile: body.tileIndex, isMine, sig: signature },
      "reveal",
    );

    // Persist the updated session for cross-device recovery; also re-issue
    // the cookie-side token so the existing client keeps working.
    const newToken = await saveSession(body.player, updated, session.createdAt);
    void encryptSession; // keep import for type-only; saveSession encrypts

    return NextResponse.json({
      isMine,
      tileIndex: body.tileIndex,
      signature,
      safeReveals,
      gameToken: newToken,
      closeInstruction,
    });
  } catch (err) {
    return jsonError(err);
  }
}
