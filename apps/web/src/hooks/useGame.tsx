"use client";
/**
 * Compatibility wrapper around the Zustand store + actions hook.
 * Lets the original page code use `useGame()` without changes.
 */
import { usePrivy } from "@privy-io/react-auth";
import { useSolanaWallets as useWallets } from "@privy-io/react-auth/solana";
import { useGameActions } from "./use-game-actions";
import { useGameStore, type GameStatus, type GameResult } from "@/stores/game-store";
import { useHistoryStore } from "@/stores/history-store";

export type { GameStatus, GameResult };

export function useGame() {
  const state = useGameStore();
  const actions = useGameActions();
  const history = useHistoryStore((s) => s.history);
  const { authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets[0];

  return {
    state: {
      // Date.parse(`${Date.now()}`) returns NaN — Date.parse expects a
      // date-formatted string, not a unix-ms integer-as-string. Use Date.now()
      // directly so the BigInt cast doesn't crash the page once the bet lands.
      gameId: state.status === "playing" ? BigInt(Date.now()) : null,
      status: state.status,
      bet: state.bet,
      mineCount: state.mineCount,
      revealedTiles: state.revealedTiles,
      safeTiles: state.safeTiles,
      mineTiles: state.mineTiles,
      multiplier: state.multiplier,
      commitment: state.commitment,
      payout: state.payout,
      pendingTile: state.pendingTile,
      sessionPnl: state.sessionPnl,
      sessionGames: state.sessionGames,
      error: state.error,
      lastTxHash: state.lastTxHash,
      pendingClose: state.pendingClose,
    },
    setBet: state.setBet,
    setMineCount: state.setMineCount,
    startGame: actions.startGame,
    revealTile: actions.revealTile,
    cashOut: actions.cashOut,
    resetGame: state.reset,
    gameHistory: history,
    walletAddress: wallet?.address ?? null,
    authenticated,
    login,
    logout,
  };
}

export function GameProvider({ children }: { children: React.ReactNode }) {
  // The store is global — no provider needed. Kept as a no-op so the layout
  // tree stays identical to the original.
  return <>{children}</>;
}
