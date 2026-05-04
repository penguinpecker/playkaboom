"use client";
import { create } from "zustand";
import { GRID_SIZE, MINE_OPTIONS } from "@playkaboom/shared";

export type GameStatus =
  | "idle"
  | "starting"
  | "playing"
  | "revealing"
  | "cashing"
  | "won"
  | "lost"
  | "cleaning";

export interface GameResult {
  gameId: string;
  player: string;
  won: boolean;
  bet: number;
  payout: number;
  multiplier: number;
  mineCount: number;
  tilesCleared: number;
  txHash: string;
  timestamp: number;
}

interface GameState {
  status: GameStatus;
  bet: number;
  mineCount: number;
  revealedTiles: Set<number>;
  safeTiles: Set<number>;
  mineTiles: Set<number>;
  multiplier: number;
  commitment: string;
  payout: number;
  pendingTile: number | null;
  sessionPnl: number;
  sessionGames: number;
  error: string | null;
  lastTxHash: string | null;
  gameToken: string | null;
  setBet: (bet: number) => void;
  setMineCount: (count: number) => void;
  setError: (err: string | null) => void;
  setStatus: (s: GameStatus) => void;
  setPendingTile: (idx: number | null) => void;
  setGameToken: (t: string | null) => void;
  beginGame: (commitment: string, txHash: string) => void;
  applySafeReveal: (idx: number, multiplier: number, txHash: string) => void;
  applyMineReveal: (idx: number, txHash: string) => void;
  applyCashOut: (payout: number) => void;
  reset: () => void;
}

const TOKEN_KEY = "playkaboom.gameToken.v1";

const initial: Pick<
  GameState,
  | "status"
  | "bet"
  | "mineCount"
  | "revealedTiles"
  | "safeTiles"
  | "mineTiles"
  | "multiplier"
  | "commitment"
  | "payout"
  | "pendingTile"
  | "sessionPnl"
  | "sessionGames"
  | "error"
  | "lastTxHash"
  | "gameToken"
> = {
  status: "idle",
  bet: 0.001,
  mineCount: MINE_OPTIONS[1] ?? 3,
  revealedTiles: new Set(),
  safeTiles: new Set(),
  mineTiles: new Set(),
  multiplier: 1,
  commitment: "",
  payout: 0,
  pendingTile: null,
  sessionPnl: 0,
  sessionGames: 0,
  error: null,
  lastTxHash: null,
  gameToken: null,
};

export const useGameStore = create<GameState>((set) => ({
  ...initial,
  setBet: (bet) => set({ bet }),
  setMineCount: (mineCount) => set({ mineCount }),
  setError: (error) => set({ error }),
  setStatus: (status) => set({ status }),
  setPendingTile: (pendingTile) => set({ pendingTile }),
  setGameToken: (gameToken) => {
    if (typeof window !== "undefined") {
      if (gameToken) localStorage.setItem(TOKEN_KEY, gameToken);
      else localStorage.removeItem(TOKEN_KEY);
    }
    set({ gameToken });
  },
  beginGame: (commitment, txHash) =>
    set({
      status: "playing",
      revealedTiles: new Set(),
      safeTiles: new Set(),
      mineTiles: new Set(),
      multiplier: 1,
      commitment,
      lastTxHash: txHash,
      pendingTile: null,
      payout: 0,
      error: null,
    }),
  applySafeReveal: (idx, multiplier, txHash) =>
    set((state) => {
      const safeTiles = new Set(state.safeTiles);
      safeTiles.add(idx);
      const revealedTiles = new Set(state.revealedTiles);
      revealedTiles.add(idx);
      const totalSafe = GRID_SIZE - state.mineCount;
      return {
        safeTiles,
        revealedTiles,
        multiplier,
        pendingTile: null,
        lastTxHash: txHash,
        status: safeTiles.size >= totalSafe ? "won" : "playing",
      };
    }),
  applyMineReveal: (idx, txHash) =>
    set((state) => {
      const mineTiles = new Set(state.mineTiles);
      mineTiles.add(idx);
      const revealedTiles = new Set(state.revealedTiles);
      revealedTiles.add(idx);
      return {
        mineTiles,
        revealedTiles,
        pendingTile: null,
        lastTxHash: txHash,
        status: "lost",
        sessionGames: state.sessionGames + 1,
        sessionPnl: state.sessionPnl - state.bet,
      };
    }),
  applyCashOut: (payout) =>
    set((state) => ({
      status: "won",
      payout,
      sessionGames: state.sessionGames + 1,
      sessionPnl: state.sessionPnl + (payout - state.bet),
    })),
  reset: () =>
    set((state) => ({
      ...initial,
      bet: state.bet,
      mineCount: state.mineCount,
      sessionPnl: state.sessionPnl,
      sessionGames: state.sessionGames,
    })),
}));

if (typeof window !== "undefined") {
  const stored = localStorage.getItem(TOKEN_KEY);
  if (stored) useGameStore.setState({ gameToken: stored });
}
