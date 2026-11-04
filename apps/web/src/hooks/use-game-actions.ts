"use client";
import { usePrivy } from "@privy-io/react-auth";
import { useSolanaWallets as useWallets } from "@privy-io/react-auth/solana";
import { useVrfGame } from "./use-vrf-game";

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

/**
 * Game actions. VRF-only: every round is a MagicBlock per-click VRF game in the
 * ephemeral rollup (use-vrf-game). The commit-reveal start/reveal/settle path
 * is gone; the program rejects start_game with 6057 LegacyModeDisabled. A stray
 * legacy game still winds down through GameRecoveryBanner (/api/cleanup) and
 * the house cron's expire_game pass.
 */
export function useGameActions(): ActionsResult {
  const { authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const vrf = useVrfGame();
  return {
    authenticated,
    walletAddress: wallets[0]?.address,
    startGame: vrf.startGame,
    revealTile: vrf.revealTile,
    cashOut: vrf.cashOut,
    resetGame: vrf.resetGame,
    cleanupStuck: vrf.cleanupStuck,
    login,
    logout,
  };
}
