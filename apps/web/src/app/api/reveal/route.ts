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
import { encryptSession } from "@/server/session";
import { loadSession, saveSession, deleteSession } from "@/server/session-store";
import { OnChainError, requireActiveGame, sendErTx, sendHouseTx } from "@/server/solana";
import { housePubkey, programId, treasuryPubkey, useMagicblock } from "@/server/env";
import { enforceRateLimit } from "@/server/ratelimit";
import { logger } from "@/server/logger";
import { indexFreshSignature } from "@/server/inline-ingest";
import { buildDelegateGame, buildRevealTileEr, deriveGameV2Pda } from "@/server/er-instructions";
import {
  claimDelegationSlot,
  isDelegated,
  loadSessionKeypair,
  releaseDelegationSlot,
} from "@/server/session-keys";
import { getValidatorPubkey } from "@/server/magicblock";

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
    //
    // For ER (Magicblock) games the on-chain game state lives at the V2 PDA
    // (`game_v2` seed) — the V1 `kaboom_game` PDA never exists. If the player
    // is in ER mode, check the V2 PDA instead so this gate doesn't bounce
    // every ER reveal with a stale-V1 401. requireActiveGame retries 3×250ms;
    // we replicate that pattern for V2 below via a small inline poll.
    if (useMagicblock(body.player)) {
      const { getConnection } = await import("@/server/connection");
      const conn = getConnection();
      const [gameV2Pda] = deriveGameV2Pda(programId(), playerPk);
      let v2Info = await conn.getAccountInfo(gameV2Pda, "confirmed");
      for (let i = 0; i < 2 && !v2Info; i++) {
        await new Promise((r) => setTimeout(r, 250));
        v2Info = await conn.getAccountInfo(gameV2Pda, "confirmed");
      }
      if (!v2Info) {
        await deleteSession(body.player);
        throw new ApiError(409, "Game session no longer active — start a new round.", {
          needsCleanup: true,
        });
      }
      // V2 PDA exists — could be owned by our program (delegate pending) OR
      // by the DLP (delegated). Both states are valid for reveals on the ER
      // hot path; the program enforces the actual semantics. Skip the V1
      // probe entirely.
    } else {
      const onChainGame = await requireActiveGame(playerPk);
      if (!onChainGame) {
        await deleteSession(body.player);
        throw new ApiError(409, "Game session no longer active — start a new round.", {
          needsCleanup: true,
        });
      }
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

    if (useMagicblock(body.player)) {
      // Magicblock ER hot path: session-key signs reveal_tile_er, sent
      // directly to the ER endpoint. No Turnkey involvement per-tile.
      //
      // First reveal lazily runs delegate_game (Turnkey-signed, L1) so the
      // GameSessionV2 PDA flips into ER ownership before the reveal_tile_er
      // hits the validator. Subsequent reveals on the same game skip the
      // delegate. claimDelegationSlot is the atomic write that prevents two
      // concurrent first-reveals from both firing delegate_game.
      //
      // On mine: settle no longer rides in the same tx (commit_and_undelegate
      // is its own ix issued via /api/settle). The reveal tx alone records
      // the mine inside the ER; the client should follow up with a settle
      // call. closeInstruction is not emitted on the ER path because the
      // GameSession PDA undelegates + settles atomically server-side later.
      const [gamePda] = deriveGameV2Pda(programId(), playerPk);
      const sessionKp = await loadSessionKeypair(gamePda);

      const needsDelegation = !(await isDelegated(gamePda));
      if (needsDelegation && (await claimDelegationSlot(gamePda))) {
        try {
          const delegateIx = buildDelegateGame({
            ctx,
            player: playerPk,
            houseAuthority: housePk,
            validator: getValidatorPubkey(),
          });
          const delegateSig = await sendHouseTx([delegateIx]);
          logger.info(
            { gamePda: gamePda.toBase58(), sig: delegateSig },
            "delegate_game landed",
          );
        } catch (delegateErr) {
          // Release the slot so the next reveal can retry. Don't swallow —
          // the player needs to know this reveal didn't land.
          await releaseDelegationSlot(gamePda);
          throw delegateErr;
        }
      }

      const revealErIx = buildRevealTileEr({
        ctx,
        player: playerPk,
        sessionKey: sessionKp.publicKey,
        tileIndex: body.tileIndex,
        isMine,
      });
      signature = await sendErTx([revealErIx], [sessionKp]);
      logger.debug(
        { tile: body.tileIndex, isMine, sig: signature, mode: "er" },
        "reveal via ER",
      );
      // ER signatures are not L1 sigs — don't push them to the inline
      // indexer (which expects L1 sigs). The eventual L1 commit-back from
      // settle_game_er surfaces a real L1 sig that does get indexed.
    } else {
      const revealIx = buildRevealTile({
        ctx,
        player: playerPk,
        houseAuthority: housePk,
        tileIndex: body.tileIndex,
        isMine,
      });

      if (isMine) {
        // Atomic reveal + settle so the player can never see "lost but unsettled".
        const settleIx = buildSettleGame({
          ctx,
          player: playerPk,
          houseAuthority: housePk,
          treasury: treasuryPubkey(),
          mineLayout: updated.mineLayout,
          salt: saltBuffer(updated),
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
    }

    const safeReveals = updated.reveals.filter((t) => (updated.mineLayout & (1 << t)) === 0).length;

    logger.info(
      { player: body.player, tile: body.tileIndex, isMine, sig: signature },
      "reveal",
    );

    // G4: on mine in L1 mode the game is Lost+settled on-chain in the same
    // tx; delete the server-side session so the next /api/session probe
    // returns gameToken=null and the recovery banner shows the FORCE-CLOSE
    // path (not RESUME with a stale token). Return an empty token so the
    // client clears localStorage too.
    //
    // In ER mode the mine-tile reveal does NOT also settle (settle is a
    // separate commit_and_undelegate ix issued via /api/settle), so we keep
    // the session row around until settle runs.
    let newToken = "";
    if (!isMine) {
      newToken = await saveSession(body.player, updated, session.createdAt);
    } else if (useMagicblock(body.player)) {
      // ER mine: persist updated reveals so /api/settle can read mineLayout
      // + salt; deletion happens at settle.
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
