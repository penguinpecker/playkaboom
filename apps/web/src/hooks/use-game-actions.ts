"use client";
import { useCallback } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { usePrivy } from "@privy-io/react-auth";
import {
  useSolanaWallets as useWallets,
  useSignTransaction,
} from "@privy-io/react-auth/solana";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { calcMultiplier } from "@playkaboom/shared";
import { deserializeIx, type SerializedIx } from "@playkaboom/sdk";
import { apiCleanup, apiCommit, apiReveal, apiSettle, ApiClientError } from "@/lib/api";
import { confirmByPolling } from "@/lib/confirm";
import { buildPriorityIxs } from "@/lib/priority-fee";
import { PROGRAM_ID } from "@/lib/cluster";
import { decodeProgramError } from "@/lib/program-errors";
import { useGameStore, type GameResult } from "@/stores/game-store";
import { useHistoryStore } from "@/stores/history-store";
import { useToast } from "@/components/providers/toast";

const HOUSE_EDGE_BPS = 200;

interface ActionsResult {
  authenticated: boolean;
  walletAddress: string | undefined;
  startGame: () => Promise<void>;
  revealTile: (idx: number) => Promise<void>;
  cashOut: () => Promise<void>;
  resetGame: () => void;
  cleanupStuck: () => Promise<boolean>;
  login: () => void;
  logout: () => Promise<void>;
}

export function useGameActions(): ActionsResult {
  const { authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  // useSignTransaction is for Privy embedded wallets and accepts a Transaction
  // object directly (returns a signed Transaction). useStandardSignTransaction
  // expects pre-serialized bytes for external Wallet-Standard wallets — wrong
  // hook for our embedded-wallet config and was throwing
  // "n.serializeMessage is not a function" because Privy's standard handler
  // tried to deserialize our legacy-tx bytes as a VersionedTransaction.
  const { signTransaction } = useSignTransaction();
  const { connection } = useConnection();
  const store = useGameStore();
  const pushHistory = useHistoryStore((s) => s.push);
  const { toast } = useToast();

  const wallet = wallets[0];
  const walletAddress = wallet?.address;

  const signAndSend = useCallback(
    async (ix: TransactionInstruction): Promise<string> => {
      if (!wallet) throw new Error("No wallet");
      const payer = new PublicKey(wallet.address);
      // Run blockhash + priority-fee fetch in parallel so the priority-fee
      // RPC roundtrip is overlapped with blockhash (already on the critical
      // path). Net additional latency: ~0ms.
      const [{ blockhash, lastValidBlockHeight }, priorityIxs] = await Promise.all([
        // `processed` blockhash is one slot newer than `confirmed` and still
        // valid for the full ~150-block window — saves ~150-200ms vs confirmed.
        connection.getLatestBlockhash("processed"),
        buildPriorityIxs(connection, PROGRAM_ID),
      ]);
      const tx = new Transaction();
      // ComputeBudget ixs MUST come before the program ix in the tx order.
      for (const pix of priorityIxs) tx.add(pix);
      tx.add(ix);
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = payer;
      const signed = await signTransaction({
        transaction: tx,
        connection,
        address: wallet.address,
      });
      const raw =
        signed instanceof VersionedTransaction
          ? signed.serialize()
          : (signed as Transaction).serialize();
      // skipPreflight: server already built + validated the ix. Saves
      // ~200-400ms of RPC simulate before forwarding. If the tx is
      // somehow malformed we lose the slot fee (~5k lamports) — acceptable
      // trade for the latency win.
      const sig = await connection.sendRawTransaction(raw, { skipPreflight: true });
      // G3: confirmByPolling can throw (timeout or "blockhash expired")
      // even when the tx actually landed in the very last valid block. If
      // we just propagate the error, the caller treats this as failure
      // and the local store reverts to "playing" while on-chain is in a
      // post-tx state — every subsequent reveal then errors GameNotPlaying.
      // Do one last-ditch status check before bubbling the error.
      try {
        await confirmByPolling(connection, sig, blockhash, lastValidBlockHeight);
      } catch (confirmErr) {
        try {
          const { value } = await connection.getSignatureStatuses([sig]);
          const s = value[0];
          if (
            s &&
            !s.err &&
            (s.confirmationStatus === "confirmed" ||
              s.confirmationStatus === "finalized")
          ) {
            // Tx confirmed despite confirm-loop bailing. Treat as success.
            return sig;
          }
        } catch {
          /* fall through to the original error */
        }
        throw confirmErr;
      }
      return sig;
    },
    [wallet, connection, signTransaction],
  );

  // Cleanup a stuck on-chain GameSession PDA from a previous interrupted
  // round. The server determines which recovery ix to dispatch based on the
  // current on-chain status (close_game / close_unsettled_game /
  // refund_expired) and tells us if the slot timer has elapsed yet.
  //
  // Always emits a toast on non-success so the user sees feedback even when
  // they're not looking at the inline error block in Grid.
  const cleanupStuck = useCallback(async (): Promise<boolean> => {
    if (!walletAddress) return false;
    store.setStatus("cleaning");
    try {
      const data = await apiCleanup({
        player: walletAddress,
        gameToken: store.gameToken ?? undefined,
      });
      if (!data.active) {
        store.setGameToken(null);
        store.setStatus("idle");
        return true;
      }

      const trySend = async (ix: SerializedIx) => {
        try {
          await signAndSend(deserializeIx(ix));
          store.setGameToken(null);
          store.setStatus("idle");
          store.setError(null);
          return true;
        } catch (err) {
          const friendly = decodeProgramError(
            err instanceof Error ? err.message : "Cleanup tx failed",
          );
          store.setStatus("idle");
          store.setError(friendly);
          toast(friendly, "error");
          return false;
        }
      };

      switch (data.action) {
        case "close_game":
        case "close_unsettled_game":
        case "refund_expired":
          return await trySend(data.instruction);
        case "wait_close_unsettled": {
          const secs = data.secondsUntilReady;
          const msg = `Stuck game from a previous round. Force-close available in ~${secs}s. Scroll down for FORCE CLOSE button.`;
          store.setStatus("idle");
          store.setError(msg);
          toast(msg, "amber");
          return false;
        }
        case "wait_refund": {
          const secs = data.secondsUntilReady;
          const msg = `Active game in progress. Refund available in ~${secs}s. Scroll down for REFUND BET button.`;
          store.setStatus("idle");
          store.setError(msg);
          toast(msg, "amber");
          return false;
        }
        case "unknown": {
          // Fallback path — server couldn't decode, try close then refund.
          if (await trySend(data.closeInstruction)) return true;
          return await trySend(data.refundInstruction);
        }
      }
      return false;
    } catch (err) {
      const friendly = decodeProgramError(
        err instanceof Error ? err.message : "Cleanup failed",
      );
      store.setStatus("idle");
      store.setError(friendly);
      toast(friendly, "error");
      return false;
    }
  }, [walletAddress, store, signAndSend, toast]);

  const startGame = useCallback(async () => {
    if (!authenticated) {
      login();
      return;
    }
    if (!walletAddress) {
      store.setError("Wallet not ready");
      return;
    }
    store.setStatus("starting");
    store.setError(null);

    const betLamports = BigInt(Math.round(store.bet * LAMPORTS_PER_SOL));
    const tryCommit = () =>
      apiCommit({ player: walletAddress, mineCount: store.mineCount, betLamports });

    let commit;
    try {
      commit = await tryCommit();
    } catch (err) {
      const isCleanupNeeded =
        err instanceof ApiClientError && err.payload.needsCleanup === true;
      if (isCleanupNeeded) {
        const cleaned = await cleanupStuck();
        if (cleaned) {
          try {
            commit = await tryCommit();
          } catch (retryErr) {
            const msg = decodeProgramError(
              retryErr instanceof Error ? retryErr.message : "Failed to start",
            );
            store.setStatus("idle");
            store.setError(msg);
            toast(msg, "error");
            return;
          }
        } else {
          // cleanupStuck has already set its own precise error/toast
          // (wait_close_unsettled / wait_refund / on-chain failure).
          // Don't overwrite it with the generic 409 message.
          store.setStatus("idle");
          return;
        }
      } else {
        const msg = decodeProgramError(err instanceof Error ? err.message : "Failed to start");
        store.setStatus("idle");
        store.setError(msg);
        toast(msg, "error");
        return;
      }
    }

    store.setGameToken(commit.gameToken);
    try {
      const sig = await signAndSend(deserializeIx(commit.instruction));
      store.beginGame(commit.commitment, sig);
    } catch (err) {
      store.setStatus("idle");
      store.setError(decodeProgramError(err instanceof Error ? err.message : "Sign failed"));
      // Game token still useful for cleanup
    }
  }, [authenticated, walletAddress, store, signAndSend, cleanupStuck, login]);

  const revealTile = useCallback(
    async (idx: number) => {
      const s = useGameStore.getState();
      if (s.status !== "playing" || s.pendingTile !== null) return;
      if (s.revealedTiles.has(idx)) return;
      if (!walletAddress || !s.gameToken) return;

      store.setPendingTile(idx);
      store.setStatus("revealing");

      try {
        const data = await apiReveal({
          player: walletAddress,
          tileIndex: idx,
          gameToken: s.gameToken,
        });
        if (data.isMine) {
          // G4: server already deleted its session row and returned an empty
          // gameToken. Clear localStorage immediately (don't wait for the
          // close ix to land) so a tab-close in the next 2s can't leave an
          // orphan token pointing at a Lost game.
          store.setGameToken(null);
          store.applyMineReveal(idx, data.signature);
          pushHistory(makeResult(s, walletAddress, false, 0, data.signature));
          if (data.closeInstruction) {
            // Mark close in flight — BetControls disables Engage until
            // confirm. Reveal-on-mine bundles [reveal, settle] in the
            // same on-chain tx, so once apiReveal returns the prereq
            // state for close_game (Lost+settled) is at least ack'd by
            // the leader. Short 500ms grace lets the RPC node we'll
            // query for close_game catch up; on the rare race-failure
            // we retry once after another 800ms before giving up.
            store.setPendingClose(true);
            const closeIxBytes = data.closeInstruction;
            void (async () => {
              try {
                await new Promise((r) => setTimeout(r, 500));
                try {
                  await signAndSend(deserializeIx(closeIxBytes));
                } catch {
                  await new Promise((r) => setTimeout(r, 800));
                  await signAndSend(deserializeIx(closeIxBytes)).catch(() => {});
                }
              } finally {
                store.setPendingClose(false);
              }
            })();
          }
        } else {
          // Safe reveal: server returned the rotated session token; persist it.
          store.setGameToken(data.gameToken);
          const next = calcMultiplier(s.safeTiles.size + 1, s.mineCount, HOUSE_EDGE_BPS);
          store.applySafeReveal(idx, next, data.signature);
        }
      } catch (err) {
        // G1: server refused to fire the FINAL safe reveal because that
        // would auto-flip on-chain status to Won and lock out cash_out.
        // Surface a clear prompt + leave status on "playing" so the Cash
        // Out button stays live. Do NOT attempt an automatic cashOut —
        // user explicitly initiates the claim.
        if (err instanceof ApiClientError && err.payload.needsCashOut === true) {
          const msg =
            "That was the last safe tile — click EXIT & WITHDRAW to claim your winnings.";
          store.setStatus("playing");
          store.setPendingTile(null);
          store.setError(msg);
          toast(msg, "amber");
          return;
        }
        const friendly = decodeProgramError(
          err instanceof Error ? err.message : "Reveal failed",
        );
        store.setStatus("playing");
        store.setPendingTile(null);
        store.setError(friendly);
        toast(friendly, "error");
      }
    },
    [walletAddress, store, signAndSend, pushHistory, toast],
  );

  const cashOut = useCallback(async () => {
    const s = useGameStore.getState();
    if (s.status !== "playing" || s.safeTiles.size === 0) return;
    if (!walletAddress || !s.gameToken) return;
    store.setStatus("cashing");

    try {
      const cashRes = await apiSettle({ player: walletAddress, gameToken: s.gameToken });
      // G2: bare return here previously left status: "cashing" forever, no
      // toast, no error — the spinner spun until the user reloaded. If the
      // server didn't return the cash-out ix shape we expected, surface
      // the issue and put the player back into "playing" so they can retry.
      if (!("phase" in cashRes) || cashRes.phase !== "cashout") {
        const msg = "Unexpected cash-out response from server. Try again.";
        store.setStatus("playing");
        store.setError(msg);
        toast(msg, "error");
        return;
      }
      await signAndSend(deserializeIx(cashRes.instruction));

      const payout = s.bet * s.multiplier;
      store.applyCashOut(payout);
      pushHistory(makeResult(s, walletAddress, true, payout, ""));
      store.setGameToken(null);

      // Mark close window open BEFORE the async chain so BetControls
      // gates Engage from this exact moment, not after the WinModal
      // dismiss/Play Again click.
      store.setPendingClose(true);

      // Capture into local non-null vars before the IIFE so TS doesn't
      // re-widen them when the closure runs after applyCashOut/setGameToken.
      const settleToken = s.gameToken;
      const player = walletAddress;

      // Settle + close-game in a tight inline chain (no fixed setTimeout
      // wait). Was: fire-and-forget settle + setTimeout(3000) +
      // apiCleanup + close. Removing the 3s heuristic delay cuts the
      // post-cashout busy window from 5-7s to ~2-3s. Settle is awaited
      // (was parallel) so cleanup never sees a !settled state and
      // doesn't accidentally pick the close_unsettled path.
      void (async () => {
        try {
          await apiSettle({ player, gameToken: settleToken, phase: "settle" });
          const c = await apiCleanup({ player });
          if (c.active && (c.action === "close_game" || c.action === "close_unsettled_game")) {
            await signAndSend(deserializeIx(c.instruction));
          }
        } catch {
          /* swallow — server cron + banner cover any leftover state */
        } finally {
          store.setPendingClose(false);
        }
      })();
    } catch (err) {
      const friendly = decodeProgramError(
        err instanceof Error ? err.message : "Cash out failed",
      );
      store.setStatus("playing");
      store.setError(friendly);
      toast(friendly, "error");
    }
  }, [walletAddress, store, signAndSend, pushHistory, toast]);

  return {
    authenticated,
    walletAddress,
    startGame,
    revealTile,
    cashOut,
    resetGame: store.reset,
    cleanupStuck,
    login,
    logout,
  };
}

function makeResult(
  s: ReturnType<typeof useGameStore.getState>,
  player: string,
  won: boolean,
  payout: number,
  txHash: string,
): GameResult {
  return {
    gameId: String(Date.now()),
    player,
    won,
    bet: s.bet,
    payout,
    multiplier: won ? s.multiplier : 0,
    mineCount: s.mineCount,
    tilesCleared: s.safeTiles.size,
    txHash,
    timestamp: Date.now(),
  };
}
