import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  buildCloseGame,
  decodeGameSession,
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
import {
  confirmOutcomeSettled,
  OnChainError,
  requireActiveGame,
  sendHouseTx,
} from "@/server/solana";
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

    // BIND THE TOKEN TO THIS EXACT GAME. Existence is not identity.
    //
    // Without this the only check on a caller-supplied gameToken is
    // `decoded.player === player` (server/session-store.ts), so a token kept
    // from ANY earlier round of the same wallet is accepted against a brand
    // new game. checkTile then answers from the OLD mine layout and the house
    // signs reveal_tile(is_mine) for it — and the program cannot catch this,
    // because `is_mine` is an INSTRUCTION PARAMETER (lib.rs:375) with no
    // layout to validate against until settle. cash_out pays
    // bet x multiplier_bps with no commitment check at all, so a player who
    // replays a token whose layout happens to mark a tile safe can farm
    // "safe" reveals against a game whose real layout says otherwise and cash
    // out a near-certain win. That is an unbounded vault drain.
    //
    // The commitment is the game's identity: it is fixed at start_game and
    // unique per round. Comparing it is exactly what
    // /api/admin/release-stuck-obligations already does before it trusts a
    // session, and it is what this hot path was missing.
    // Decode ONCE and treat the chain as truth for everything it records.
    // The encrypted session is a convenience copy: two reveals racing each
    // other both load it, both append their own tile and both save, so one
    // tile is silently dropped (last write wins). Every check below that was
    // computed from the session inherited that drift — which is how a player
    // could pass the perfect-game guard, clear the board on chain, and strand
    // the whole bet (status Won, cash_out reverts, settle pays nothing).
    const chainGame = decodeGameSession(onChainGame.data as Buffer);
    const onChainCommitment = Buffer.from(chainGame.commitment).toString("hex");
    if (session.commitment !== onChainCommitment) {
      // Do NOT delete the server-side session: the on-chain game is real and
      // may still be playable with the CORRECT token. Only the caller's token
      // is wrong.
      throw new ApiError(409, "That game token is for a different round — start a new round.", {
        needsCleanup: true,
      });
    }

    // Same reason: the chain knows every tile that actually landed, including
    // one this session copy never recorded. Re-revealing would fail on chain
    // anyway; catching it here keeps the house from paying for a doomed tx.
    if ((chainGame.revealedMask & (1 << body.tileIndex)) !== 0) {
      throw new ApiError(409, "Tile already revealed");
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
      // Counted from the CHAIN, not the session: `safe_reveals` on the game
      // account is what the on-chain handler compares against when it decides
      // to auto-flip the game to Won, so it is the only count that can predict
      // that flip. A session that lost a concurrent write reports fewer.
      const newSafeReveals = chainGame.safeReveals + 1;
      const totalSafe = GRID_SIZE - chainGame.mineCount;
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

      // Do NOT answer until the settle is locked in. sendHouseTx returns on
      // RPC acceptance, so until this resolves the game is still `Playing` on
      // chain — and a player who has been told "mine" can broadcast their own
      // cash_out with a higher priority fee and land it first, turning the
      // loss into a full payout. Fail closed: if we cannot establish that the
      // round is decided, we disclose nothing and the client retries.
      const decided = await confirmOutcomeSettled(signature, playerPk);
      if (!decided) {
        logger.warn(
          { player: body.player, sig: signature },
          "reveal settle unconfirmed — withholding outcome",
        );
        throw new ApiError(409, "Still resolving your tile — try again in a moment.", {
          settling: true,
        });
      }

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

    // Report the chain's count (plus this reveal when it was safe) so the
    // multiplier the player sees matches what cash_out will actually pay.
    const safeReveals = isMine ? chainGame.safeReveals : chainGame.safeReveals + 1;

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
