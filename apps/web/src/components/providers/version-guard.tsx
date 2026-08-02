"use client";
import { useEffect, useRef, useState } from "react";
import { useGameStore } from "@/stores/game-store";

/**
 * Refuse to keep running stale client code.
 *
 * A browser tab holds the JS chunks it loaded for as long as it stays open, so
 * shipping a client fix does NOT reach anyone already on the page. Every
 * client bug fixed on 2026-07-30/31 kept "reproducing" for exactly this
 * reason — the player was running code that no longer existed in production,
 * and the reported symptom pointed at an already-deleted code path.
 *
 * On a money app that is a correctness problem, not a polish one: stale code
 * can send transactions the current on-chain state rejects, or mishandle a
 * recovery path whose semantics changed, stranding a live bet.
 *
 * Policy:
 *   - poll the deployed build id every 60s, and on tab refocus
 *   - MID-ROUND: never interrupt. Show nothing, keep checking. Reloading with
 *     a bet in flight is far worse than running slightly old code for a minute.
 *   - IDLE: reload automatically. There is nothing to lose and the player
 *     should not have to know what a hard refresh is.
 */
export function VersionGuard() {
  const seen = useRef<string | null>(null);
  const [stale, setStale] = useState(false);
  const status = useGameStore((s) => s.status);
  const inRound = status !== "idle";

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        if (!r.ok) return;
        const { buildId } = (await r.json()) as { buildId?: string };
        if (!buildId || cancelled) return;
        if (seen.current === null) {
          seen.current = buildId;
          return;
        }
        if (seen.current !== buildId) setStale(true);
      } catch {
        /* offline / transient — a failed check must never disrupt play */
      }
    };
    void check();
    const id = setInterval(check, 60_000);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    // Reload the moment it is safe to: stale AND not mid-round.
    if (stale && !inRound) {
      window.location.reload();
    }
  }, [stale, inRound]);

  if (!stale || !inRound) return null;
  // Mid-round: inform, do not act. It reloads itself once the round ends.
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-amber-400/40 bg-amber-950/90 px-4 py-2.5 text-center text-xs text-amber-200 backdrop-blur">
      An update shipped while you were playing. This page refreshes
      automatically once your round finishes.
    </div>
  );
}
