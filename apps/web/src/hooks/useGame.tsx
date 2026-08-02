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
      // The on-chain commitment IS the round's identity — stable for the life
      // of the game and verifiable. Date.now() changed on every render, so the
      // "#" chip on the grid was a meaningless number that never matched
      // anything a player could look up.
      gameId: state.commitment ?? null,
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
    // Exposed so GameRecoveryBanner can recover a VRF round. Its legacy
    // single-instruction path (refund_expired etc.) does not apply there:
    // a rollup game must be undelegated before refund_stalled_vrf will run.
    cleanupStuck: actions.cleanupStuck,
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
