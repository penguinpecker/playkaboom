"use client";
import { useCallback } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { usePrivy } from "@privy-io/react-auth";
import {
  useSolanaWallets as useWallets,
  useStandardSignTransaction,
} from "@privy-io/react-auth/solana";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { calcMultiplier } from "@playkaboom/shared";
import { deserializeIx, type SerializedIx } from "@playkaboom/sdk";
import { apiCleanup, apiCommit, apiReveal, apiSettle, ApiClientError } from "@/lib/api";
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
  const { signTransaction } = useStandardSignTransaction();
  const { connection } = useConnection();
  const store = useGameStore();
  const pushHistory = useHistoryStore((s) => s.push);
  const { toast } = useToast();

  const wallet = wallets[0];
  const walletAddress = wallet?.address;

  const signAndSend = useCallback(
    async (ix: TransactionInstruction): Promise<string> => {
      if (!wallet) throw new Error("No wallet");
      const tx = new Transaction().add(ix);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = new PublicKey(wallet.address);
      const serialized = tx.serialize({ requireAllSignatures: false });
      const { signedTransaction } = await signTransaction({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transaction: serialized as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wallet: wallet as any,
      });
      const raw =
        signedTransaction instanceof Uint8Array ? signedTransaction : Buffer.from(signedTransaction);
      const sig = await connection.sendRawTransaction(raw, { skipPreflight: false });
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      return sig;
    },
    [wallet, connection, signTransaction],
  );

  const cleanupStuck = useCallback(async (): Promise<boolean> => {
    if (!walletAddress) return false;
    store.setStatus("cleaning");
    try {
      const data = await apiCleanup({
        player: walletAddress,
        gameToken: store.gameToken ?? undefined,
      });
      if (!data.active) {
        store.setStatus("idle");
        return false;
      }
      const tryClose = async (ix?: SerializedIx) => {
        if (!ix) return false;
        try {
          await signAndSend(deserializeIx(ix));
          store.setGameToken(null);
          store.setStatus("idle");
          return true;
        } catch {
          return false;
        }
      };
      if (await tryClose(data.closeInstruction)) return true;
      if (data.refundInstruction) {
        try {
          await signAndSend(deserializeIx(data.refundInstruction));
          await new Promise((r) => setTimeout(r, 2000));
          if (await tryClose(data.closeInstruction)) return true;
        } catch {
          // fall through
        }
      }
      store.setStatus("idle");
      store.setError("Could not clean up stuck game. Try again in a moment.");
      return false;
    } catch (err) {
      store.setStatus("idle");
      store.setError(err instanceof Error ? err.message : "Cleanup failed");
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
          store.setError(retryErr instanceof Error ? retryErr.message : "Failed to start");
          return;
        }
      } else {
        store.setStatus("idle");
        store.setError(err instanceof Error ? err.message : "Failed to start");
        return;
      }
    }

    store.setGameToken(commit.gameToken);
    try {
      const sig = await signAndSend(deserializeIx(commit.instruction));
      store.beginGame(commit.commitment, sig);
    } catch (err) {
      store.setStatus("idle");
      store.setError(err instanceof Error ? err.message : "Sign failed");
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
        store.setStatus("playing");
        store.setPendingTile(null);
        store.setError(err instanceof Error ? err.message : "Reveal failed");
        toast(err instanceof Error ? err.message : "Reveal failed", "error");
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
      // Close game PDA in the background.
      setTimeout(() => {
        apiCleanup({ player: walletAddress })
          .then((c) => {
            if (c.active && c.closeInstruction) {
              return signAndSend(deserializeIx(c.closeInstruction));
            }
          })
          .catch(() => {});
      }, 3000);
    } catch (err) {
      store.setStatus("playing");
      store.setError(err instanceof Error ? err.message : "Cash out failed");
      toast(err instanceof Error ? err.message : "Cash out failed", "error");
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
