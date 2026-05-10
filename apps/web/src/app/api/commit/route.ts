import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { StartGameInput } from "@playkaboom/shared";
import { buildStartGame, deriveGamePda, serializeIx } from "@playkaboom/sdk";
import { ApiError, clientIp, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { createGameSession } from "@/server/game";
import { saveSession } from "@/server/session-store";
import { playerHasActiveGame } from "@/server/solana";
import { programId, useMagicblock } from "@/server/env";
import { getConnection } from "@/server/connection";
import { enforceRateLimit } from "@/server/ratelimit";
import { logger } from "@/server/logger";
import { buildStartGameEr, deriveGameV2Pda } from "@/server/er-instructions";
import { generateGameSessionKey, storeSessionKey } from "@/server/session-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, StartGameInput);

    const playerPk = new PublicKey(body.player);

    // Auth, ratelimit, and the two RPC checks all run in parallel. They
    // share no state and were cumulatively adding ~700ms p50 sequential.
    // Rate limit consumes a slot even if auth fails — desired anti-abuse.
    const [, rl, activeGame, slot] = await Promise.all([
      verifyPlayerAuth(req, body.player),
      enforceRateLimit(`commit:${clientIp(req)}:${body.player}`),
      playerHasActiveGame(playerPk),
      // `processed` is fine here: we just need a recent slot for the
      // session start_slot (used for the refund window). Saves ~150ms vs
      // confirmed because processed lands on the leader's first response.
      getConnection().getSlot("processed"),
    ]);
    if (!rl.ok) throw new ApiError(429, "Too many requests");

    if (activeGame) {
      throw new ApiError(409, "Active game exists. Close it first.", { needsCleanup: true });
    }

    const { payload, commitment } = createGameSession(body.player, body.mineCount);

    // Magicblock ER path (additive). When enabled we:
    //   1) generate a per-game ephemeral session keypair
    //   2) build start_game_er with the session pubkey baked in
    //   3) persist the encrypted secret server-side keyed by GameSession PDA
    // The delegate_game ix (Turnkey-signed) is intentionally NOT bundled
    // into the client-facing instruction — the player only signs start_game_er.
    // delegate_game runs server-side immediately after the player's start
    // tx is confirmed, in a separate Turnkey-signed L1 tx. (Handled by a
    // follow-up server call; see /api/reveal which will short-circuit if
    // the game isn't yet delegated.)
    if (useMagicblock()) {
      const session = generateGameSessionKey();
      const ix = buildStartGameEr({
        ctx: { programId: programId() },
        player: playerPk,
        mineCount: body.mineCount,
        betLamports: BigInt(body.betLamports),
        commitment,
        sessionKey: session.publicKey,
      });
      const [gamePda] = deriveGameV2Pda(programId(), playerPk);
      await storeSessionKey(gamePda, session.secretKey);

      const gameToken = await saveSession(body.player, payload, slot, {
        betLamports: BigInt(body.betLamports),
        mineCount: body.mineCount,
        startSlot: slot,
      });

      logger.info(
        {
          player: body.player,
          mineCount: body.mineCount,
          bet: body.betLamports.toString(),
          mode: "er",
          sessionKey: session.publicKey.toBase58(),
        },
        "commit",
      );

      return NextResponse.json({
        commitment: commitment.toString("hex"),
        instruction: serializeIx(ix),
        gameToken,
        mode: "er",
        sessionKey: session.publicKey.toBase58(),
        // `delegateInstruction` is intentionally absent — the server runs
        // delegate_game via sendHouseTx after the player's start tx lands.
      });
    }

    const ix = buildStartGame({
      ctx: { programId: programId() },
      player: playerPk,
      mineCount: body.mineCount,
      betLamports: BigInt(body.betLamports),
      commitment,
    });
    // Mirror the encrypted session to Supabase keyed by GameSession PDA so
    // the player can recover from any device. Function returns the same
    // ciphertext we'd have produced with encryptSession alone.
    const gameToken = await saveSession(body.player, payload, slot, {
      betLamports: BigInt(body.betLamports),
      mineCount: body.mineCount,
      startSlot: slot,
    });

    logger.info(
      { player: body.player, mineCount: body.mineCount, bet: body.betLamports.toString() },
      "commit",
    );

    return NextResponse.json({
      commitment: commitment.toString("hex"),
      instruction: serializeIx(ix),
      gameToken,
    });
  } catch (err) {
    return jsonError(err);
  }
}
