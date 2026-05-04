"use client";
import { useEffect } from "react";
import { useHistoryStore } from "@/stores/history-store";

export function useGameHistory() {
  const { history, refresh, clear } = useHistoryStore();
  useEffect(() => {
    const onFocus = () => refresh();
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key.startsWith("playkaboom.history")) refresh();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("storage", onStorage);
    const id = setInterval(refresh, 2_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
      clearInterval(id);
    };
  }, [refresh]);
  return { history, refresh, clearHistory: clear };
}
