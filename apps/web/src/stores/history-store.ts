"use client";
import { create } from "zustand";
import type { GameResult } from "./game-store";

const KEY = "playkaboom.history.v1";
const MAX = 200;

interface HistoryState {
  history: GameResult[];
  push: (r: GameResult) => void;
  refresh: () => void;
  clear: () => void;
}

function load(): GameResult[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as GameResult[];
  } catch {
    return [];
  }
}

export const useHistoryStore = create<HistoryState>((set) => ({
  history: typeof window === "undefined" ? [] : load(),
  push: (r) =>
    set((state) => {
      const history = [r, ...state.history].slice(0, MAX);
      if (typeof window !== "undefined") {
        localStorage.setItem(KEY, JSON.stringify(history));
      }
      return { history };
    }),
  refresh: () => set({ history: load() }),
  clear: () => {
    if (typeof window !== "undefined") localStorage.removeItem(KEY);
    set({ history: [] });
  },
}));
