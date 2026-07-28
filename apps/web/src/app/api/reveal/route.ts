import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  buildCloseGame,
  buildRevealTile,
  buildSettleGame,
  deriveGamePda,
  serializeIx,
} from "@playkaboom/sdk";
import { GRID_SIZE, RevealTileInput } from "@playkaboom/shared";
import { ApiError, clientIp, jsonError, parseBody } from "@/server/api-helpers";
import { verifyPlayerAuth } from "@/server/auth";
import { checkTile, saltBuffer } from "@/server/game";
import { fetchPlayerReferrer } from "@/server/player";
import { encryptSession } from "@/server/session";
import { loadSession, saveSession, deleteSession } from "@/server/session-store";
import { OnChainError, requireActiveGame, sendHouseTx } from "@/server/solana";
import { housePubkey, programId, treasuryPubkey } from "@/server/env";
import { enforceRateLimit } from "@/server/ratelimit";
import { logger } from "@/server/logger";
import { indexFreshSignature } from "@/server/inline-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let bodyPlayer: string | null = null;
  try {
    const body = await parseBody(req, RevealTileInput);
    bodyPlayer = body.player;

    // Auth + ratelimit + session-load are independent → run in parallel.
    // Saves 100-300ms on the hot reveal path. Note: rate limit consumes
    // a slot even if auth fails; that's the desired anti-abuse behavior.
    const [, rl, session] = await Promise.all([
      verifyPlayerAuth(req, body.player),
      enforceRateLimit(`reveal:${clientIp(req)}:${body.player}`),
      loadSession(body.player, body.gameToken),
    ]);
    if (!rl.ok) throw new ApiError(429, "Too many requests");
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

    // On-chain truth wins over the encrypted session token. Two desync paths
    // produced opaque 500s before this gate landed:
    //   1) Stale localStorage token from a previously-closed game.
    //   2) Tile click landing before start_game propagated (optimistic UI).
    // requireActiveGame retries 3×250ms for (2); a null after retries means
    // the PDA is truly absent. Returning 409+needsCleanup reuses the
    // existing /api/commit recovery contract — the client already knows how
    // to wipe its token and call /api/cleanup.
    const onChainGame = await requireActiveGame(playerPk);
    if (!onChainGame) {
      await deleteSession(body.player);
      throw new ApiError(409, "Game session no longer active — start a new round.", {
        needsCleanup: true,
      });
    }

    const { isMine, updated } = checkTile(session, body.tileIndex);

    // Perfect-game trap defense (G1). The on-chain `reveal_tile` handler
    // auto-flips status → Won when safe_reveals == GRID_SIZE - mine_count
    // (programs/kaboom/src/lib.rs:397-400). After that, `cash_out` rejects
    // with GameNotPlaying and `settle_game` doesn't pay out — the player's
    // winnings are stuck. Refuse to dispatch the final safe reveal here;
    // the player must `cash_out` first to claim. Mine reveals are not
    // affected (those auto-settle into Lost).
    if (!isMine) {
      const newSafeReveals = updated.reveals.filter(
        (t) => (updated.mineLayout & (1 << t)) === 0,
      ).length;
      const totalSafe = GRID_SIZE - session.mineCount;
      if (newSafeReveals >= totalSafe) {
        throw new ApiError(
          409,
          "That was the last safe tile — cash out now to claim your winnings.",
          { needsCashOut: true },
        );
      }
    }

    let signature: string;
    let closeInstruction: ReturnType<typeof serializeIx> | undefined;

    const revealIx = buildRevealTile({
      ctx,
      player: playerPk,
      houseAuthority: housePk,
      tileIndex: body.tileIndex,
      isMine,
    });

    if (isMine) {
      // Atomic reveal + settle so the player can never see "lost but unsettled".
      //
      // The referrer MUST be passed here, exactly as the cash-out path does.
      // settle_game credits referral rakeback on losses as well as wins — the
      // on-chain code is outcome-agnostic — but it can only do so when the
      // ReferralAccount is supplied as a remaining account. Omitting it here
      // silently skipped the credit on every losing game, so referrers were
      // paid on roughly half the volume their referees actually wagered while
      // the site advertised "every game they play credits you".
      const referrer = await fetchPlayerReferrer(playerPk);
      const settleIx = buildSettleGame({
        ctx,
        player: playerPk,
        houseAuthority: housePk,
        treasury: treasuryPubkey(),
        mineLayout: updated.mineLayout,
        salt: saltBuffer(updated),
        referrer: referrer ?? undefined,
      });
      signature = await sendHouseTx([revealIx, settleIx]);
      closeInstruction = serializeIx(buildCloseGame({ ctx, player: playerPk }));
      // Auto-settle on mine — push to indexer in the background. Don't
      // await: the cron tickler + (when configured) the Helius webhook
      // both pick up the same sig within seconds, and `processed_events`
      // dedups any double-apply. Awaiting was costing the response 1.3s
      // p50 / 5.2s p99 on every mine reveal.
      void indexFreshSignature(signature);
    } else {
      signature = await sendHouseTx([revealIx]);
    }

    const safeReveals = updated.reveals.filter((t) => (updated.mineLayout & (1 << t)) === 0).length;

    logger.info(
      { player: body.player, tile: body.tileIndex, isMine, sig: signature },
      "reveal",
    );

    // G4: on mine the game is Lost+settled on-chain in the same tx; delete
    // the server-side session so the next /api/session probe returns
    // gameToken=null and the recovery banner shows the FORCE-CLOSE path (not
    // RESUME with a stale token). Return an empty token so the client clears
    // localStorage too.
    let newToken = "";
    if (!isMine) {
      newToken = await saveSession(body.player, updated, session.createdAt);
    } else {
      await deleteSession(body.player);
    }
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
    // TOCTOU defense: if the PDA disappeared between requireActiveGame's
    // probe and sendHouseTx's broadcast, Anchor sim returns
    // AccountNotInitialized (3012). Translate to the same 409+needsCleanup
    // contract so the client still recovers via cleanupStuck.
    if (err instanceof OnChainError && err.kind === "account_not_initialized") {
      if (bodyPlayer) await deleteSession(bodyPlayer).catch(() => {});
      return jsonError(
        new ApiError(409, "Game session no longer active — start a new round.", {
          needsCleanup: true,
        }),
      );
    }
    return jsonError(err);
  }
}
