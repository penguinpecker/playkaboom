import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { StartGameInput } from "@playkaboom/shared";
import { buildStartGame, deriveGamePda, serializeIx } from "@playkaboom/sdk";
import { ApiError, clientIp, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { createGameSession } from "@/server/game";
import { saveSession } from "@/server/session-store";
import { buildAndPartialSignPlayerTx, playerHasActiveGame } from "@/server/solana";
import { housePubkey, programId, useMagicblock } from "@/server/env";
import { getConnection } from "@/server/connection";
import { enforceRateLimit } from "@/server/ratelimit";
import { logger } from "@/server/logger";
import { buildDelegateGame, buildStartGameEr, deriveGameV2Pda } from "@/server/er-instructions";
import { getValidatorPubkey } from "@/server/magicblock";
import { ensureSessionKey } from "@/server/session-keys";

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

    // Magicblock ER atomic-bundle path. Both `start_game_er` and
    // `delegate_game` ride in one transaction:
    //   - Player signs the fee-payer slot + start_game_er's player slot
    //   - Turnkey (house) pre-signs the delegate_game payer slot server-side
    //   - Both ixs land or neither lands. Solves the previous strand-on-fail
    //     bug where start_game_er would allocate the V2 PDA, the subsequent
    //     delegate_game would fail (bad account layout), and the PDA was
    //     locked forever with no on-chain refund path.
    //
    // Session keypair persistence uses ensureSessionKey() — INSERT-then-
    // conflict-resolve so concurrent /api/commit retries cannot overwrite
    // a live keypair. This pairs with the on-chain init_if_needed + handler
    // guard in start_game_er (lib.rs ~L1742-1768): if the V2 PDA already
    // exists in Playing state on a retry, the program rejects with
    // GameAlreadyInProgress; the user goes through reset_stranded_v2_session
    // first to recover the old bet + close the PDA, then retries.
    if (useMagicblock(body.player)) {
      const [gamePda] = deriveGameV2Pda(programId(), playerPk);
      const { publicKey: sessionPubkey } = await ensureSessionKey(gamePda);

      const startIx = buildStartGameEr({
        ctx: { programId: programId() },
        player: playerPk,
        mineCount: body.mineCount,
        betLamports: BigInt(body.betLamports),
        commitment,
        sessionKey: sessionPubkey,
      });
      const delegateIx = buildDelegateGame({
        ctx: { programId: programId() },
        player: playerPk,
        houseAuthority: housePubkey(),
        validator: getValidatorPubkey(),
      });

      const { partialTx, blockhash, lastValidBlockHeight } =
        await buildAndPartialSignPlayerTx(playerPk, [startIx, delegateIx]);

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
          mode: "er-atomic",
          sessionKey: sessionPubkey.toBase58(),
        },
        "commit",
      );

      return NextResponse.json({
        commitment: commitment.toString("hex"),
        partialTx,
        blockhash,
        lastValidBlockHeight,
        gameToken,
        mode: "er-atomic",
        sessionKey: sessionPubkey.toBase58(),
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
