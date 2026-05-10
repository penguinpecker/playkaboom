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
import { buildJitoTipIx, sendViaSender } from "@/lib/sender";
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
      // Jito tip ix → eligible for Helius Sender's SWQoS-only routing.
      // ~5000 lamports (~$0.001 at $200/SOL) per tx, paid by the player.
      tx.add(buildJitoTipIx(payer));
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
      // Submit via Helius Sender → fans out to staked SWQoS connections from
      // 7 regions, lands ~400-800ms vs 2-4s on naive sendRawTransaction.
      // Falls back to RPC sendRawTransaction if Sender is unreachable
      // (network blip, region issue) so a Helius outage doesn't break play.
      let sig: string;
      try {
        sig = await sendViaSender(raw);
      } catch (senderErr) {
        // eslint-disable-next-line no-console
        console.warn("[sender] failed, falling back to RPC", senderErr);
        sig = await connection.sendRawTransaction(raw, { skipPreflight: true });
      }
      await confirmByPolling(connection, sig, blockhash, lastValidBlockHeight);
      return sig;
    },
    [wallet, connection, signTransaction],
  );

  // Cleanup a stuck on-chain GameSession PDA from a previous interrupted
  // round. The server determines which recovery ix to dispatch based on the
  // current on-chain status (close_game / close_unsettled_game /
  // refund_expired) and tells us if the slot timer has elapsed yet.
  //
  // For the not-yet-ready cases (Won/Lost & !settled before slot+600,
  // Playing before slot+300) we set a precise countdown error and let the
  // GameRecoveryBanner on /play handle the wait + retry flow.
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
          return true;
        } catch (err) {
          store.setStatus("idle");
          store.setError(
            decodeProgramError(err instanceof Error ? err.message : "Cleanup tx failed"),
          );
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
          store.setStatus("idle");
          store.setError(
            `Stuck game from a previous round. Force-close becomes available in ~${secs}s — use the FORCE CLOSE button below the bet controls.`,
          );
          return false;
        }
        case "wait_refund": {
          const secs = data.secondsUntilReady;
          store.setStatus("idle");
          store.setError(
            `Active game in progress. Refund becomes available in ~${secs}s — use the REFUND BET button below the bet controls.`,
          );
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
      store.setStatus("idle");
      store.setError(decodeProgramError(err instanceof Error ? err.message : "Cleanup failed"));
      return false;
    }
  }, [walletAddress, store, signAndSend]);

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
      if (isCleanupNeeded && (await cleanupStuck())) {
        try {
          commit = await tryCommit();
        } catch (retryErr) {
          store.setStatus("idle");
          store.setError(
            decodeProgramError(retryErr instanceof Error ? retryErr.message : "Failed to start"),
          );
          return;
        }
      } else {
        store.setStatus("idle");
        store.setError(decodeProgramError(err instanceof Error ? err.message : "Failed to start"));
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
        store.setGameToken(data.gameToken);
        if (data.isMine) {
          store.applyMineReveal(idx, data.signature);
          pushHistory(makeResult(s, walletAddress, false, 0, data.signature));
          if (data.closeInstruction) {
            // Best-effort close — let it run async to reclaim rent.
            setTimeout(() => {
              if (!data.closeInstruction) return;
              signAndSend(deserializeIx(data.closeInstruction))
                .then(() => store.setGameToken(null))
                .catch(() => {});
            }, 2000);
          } else {
            store.setGameToken(null);
          }
        } else {
          const next = calcMultiplier(s.safeTiles.size + 1, s.mineCount, HOUSE_EDGE_BPS);
          store.applySafeReveal(idx, next, data.signature);
        }
      } catch (err) {
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
      if (!("phase" in cashRes) || cashRes.phase !== "cashout") return;
      await signAndSend(deserializeIx(cashRes.instruction));

      // Best-effort: server publishes proof.
      apiSettle({ player: walletAddress, gameToken: s.gameToken, phase: "settle" }).catch(() => {});

      const payout = s.bet * s.multiplier;
      store.applyCashOut(payout);
      pushHistory(makeResult(s, walletAddress, true, payout, ""));
      store.setGameToken(null);
      // Close game PDA in the background. After cash_out → settle the game
      // is Won+settled, so server returns action "close_game" with the
      // ready-to-send ix. Other actions (wait_*) are no-ops here — the
      // banner handles those.
      setTimeout(() => {
        apiCleanup({ player: walletAddress })
          .then((c) => {
            if (!c.active) return;
            if (c.action === "close_game" || c.action === "close_unsettled_game") {
              return signAndSend(deserializeIx(c.instruction));
            }
          })
          .catch(() => {});
      }, 3000);
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
