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

/** Snapshot of an on-chain GameSession used to rehydrate the local UI when
 *  the player resumes a round on a different device or after a reload. */
export interface ResumeSnapshot {
  /** Bet in SOL (already converted from lamports). */
  bet: number;
  mineCount: number;
  /** Bitmask of all revealed tile indexes (bit i = tile i). */
  revealedMask: number;
  /** Bitmask of safe reveals only. For a Playing game this equals revealedMask
   *  (a mine reveal would have flipped status to Lost). */
  revealedSafeMask: number;
  /** Multiplier as a ratio (multiplier_bps / 10_000). */
  multiplier: number;
  /** SHA-256 commitment hex from the on-chain GameSession. */
  commitment: string;
  /** Encrypted server-side session payload — same value as setGameToken. */
  gameToken: string;
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
  /** True while a player-signed close ix from the previous round is still
   *  in flight (cashOut path setTimeout(3000) → close_game; mine reveal
   *  setTimeout(2000) → close_game). On-chain GameSession PDA still
   *  exists during this window — server returns 409 to a fresh commit.
   *  BetControls reads this and gates Engage. Cleared on close confirm. */
  pendingClose: boolean;
  setBet: (bet: number) => void;
  setMineCount: (count: number) => void;
  setError: (err: string | null) => void;
  setStatus: (s: GameStatus) => void;
  setPendingTile: (idx: number | null) => void;
  setGameToken: (t: string | null) => void;
  setPendingClose: (b: boolean) => void;
  hydrateResume: (snapshot: ResumeSnapshot) => void;
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
  | "pendingClose"
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
  pendingClose: false,
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
  setPendingClose: (pendingClose) => set({ pendingClose }),
  hydrateResume: (snapshot) => {
    // Translate the on-chain bitmasks into the Set<number> shapes the Tile
    // component reads. Without this hydration the player sees an apparently
    // unflipped grid post-resume and gets "Tile already revealed" when they
    // click a tile that the program already considers revealed.
    const safeTiles = new Set<number>();
    const mineTiles = new Set<number>();
    const revealedTiles = new Set<number>();
    for (let i = 0; i < 16; i++) {
      const bit = 1 << i;
      if ((snapshot.revealedMask & bit) !== 0) revealedTiles.add(i);
      if ((snapshot.revealedSafeMask & bit) !== 0) safeTiles.add(i);
      // The lone mine tile (if any) is the bit set in revealedMask but not
      // in revealedSafeMask. Only ever set on a Lost game, but handled here
      // for completeness so a resume on a Lost-but-unsettled game still
      // shows the correct boom tile.
      if ((snapshot.revealedMask & bit) !== 0 && (snapshot.revealedSafeMask & bit) === 0) {
        mineTiles.add(i);
      }
    }
    if (typeof window !== "undefined") {
      localStorage.setItem(TOKEN_KEY, snapshot.gameToken);
    }
    set({
      status: "playing",
      bet: snapshot.bet,
      mineCount: snapshot.mineCount,
      revealedTiles,
      safeTiles,
      mineTiles,
      multiplier: snapshot.multiplier,
      commitment: snapshot.commitment,
      gameToken: snapshot.gameToken,
      pendingTile: null,
      payout: 0,
      error: null,
    });
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
