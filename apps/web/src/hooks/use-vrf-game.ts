"use client";
// VRF-mode game actions. Same shape as the commit-reveal actions in
// use-game-actions.ts, driving the SAME game store so Grid/Tile/BetControls
// work unchanged. Selected by the VRF_MODE_ENABLED flag (see use-game-actions).
//
// Player wallet (Privy) signs start_game_vrf + delegate_vrf; a per-game session
// keypair signs every reveal in the rollup (no popups). Session funding +
// settle are operator-driven (backend routes).

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { usePrivy } from "@privy-io/react-auth";
import { useSolanaWallets as useWallets, useSignTransaction } from "@privy-io/react-auth/solana";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  startVrfGame,
  revealTileVrf,
  cashOutVrf,
  settleAndUndelegateVrf,
  sweepSession,
  waitForCommittedResult,
  pollVrfGame,
  type SignTx,
  type VrfEngineConfig,
} from "@/lib/vrf/client";
import { deriveVrfClaimPda, decodeVrfClaim } from "@playkaboom/sdk";
import { apiVrfSettle, apiVrfRefund, ApiClientError } from "@/lib/api";
import { PROGRAM_ID, ER_RPC_URL, ER_WS_URL, VRF_QUEUE, VRF_MODE_ENABLED } from "@/lib/cluster";
import { useGameStore } from "@/stores/game-store";
import { useToast } from "@/components/providers/toast";

export interface VrfActions {
  startGame: () => Promise<void>;
  revealTile: (idx: number) => Promise<void>;
  cashOut: () => Promise<void>;
  resetGame: () => void;
  cleanupStuck: () => Promise<boolean>;
}

export function useVrfGame(): VrfActions {
  const { authenticated } = usePrivy();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const { connection } = useConnection();
  const store = useGameStore();
  const { toast } = useToast();

  const wallet = wallets[0];
  const sessionRef = useRef<Keypair | null>(null);
  const inflightRef = useRef(false);
  const recoveredRef = useRef<string | null>(null);

  // The session key is the ONLY key that can bring a game back out of the
  // rollup. Held in memory alone, closing the tab stranded the bet outright:
  // the result could never be committed to L1, and a still-delegated game is
  // deliberately not refundable (its L1 state is stale). So it is persisted for
  // the life of the game.
  //
  // localStorage, NOT sessionStorage — sessionStorage dies with the tab, which
  // is exactly the case this exists to survive.
  //
  // On the risk: this key is not harmless. It can drive reveals and cash-outs,
  // so anything able to read it can play the game out and lose the whole bet
  // (it cannot redirect the payout — settle always pays the recorded player).
  // The exposure is same-origin script execution, which would equally reach a
  // key held in a plain variable, so persisting costs little — but it is
  // bet-sized risk, not "gas dust". Cleared on every terminal path.
  const sessionStorageKey = wallet ? `kaboom:vrf-session:${wallet.address}` : null;

  const rememberSession = useCallback(
    (kp: Keypair | null) => {
      sessionRef.current = kp;
      if (!sessionStorageKey || typeof window === "undefined") return;
      try {
        if (kp) window.localStorage.setItem(sessionStorageKey, JSON.stringify(Array.from(kp.secretKey)));
        else window.localStorage.removeItem(sessionStorageKey);
      } catch {
        /* storage unavailable — in-memory still works for this tab */
      }
    },
    [sessionStorageKey],
  );

  const loadSession = useCallback((): Keypair | null => {
    if (sessionRef.current) return sessionRef.current;
    if (!sessionStorageKey || typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(sessionStorageKey);
      if (!raw) return null;
      const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
      sessionRef.current = kp;
      return kp;
    } catch {
      return null;
    }
  }, [sessionStorageKey]);

  // Dedicated rollup connection (public MagicBlock node, no proxy).
  //
  // Null when no endpoint is configured. On mainnet there is deliberately no
  // default — the endpoint must name the same node as the on-chain
  // vrf_validator pin — so this is the normal state until the mode is armed.
  // Constructing a Connection from an empty string throws, and because this
  // hook runs during prerender that would fail the whole build.
  const erConn = useMemo(
    () =>
      ER_RPC_URL
        ? new Connection(ER_RPC_URL, {
            wsEndpoint: ER_WS_URL || undefined,
            commitment: "confirmed",
          })
        : null,
    [],
  );

  // No rollup endpoint means the mode cannot function, so every action below
  // no-ops rather than locking a bet in a game that can never be played out.
  const cfg: VrfEngineConfig | null = useMemo(() => {
    if (!erConn) return null;
    return { l1: connection, er: erConn, programId: PROGRAM_ID, oracleQueue: VRF_QUEUE };
  }, [connection, erConn]);

  const signPlayer: SignTx = useCallback(
    async (tx: Transaction) => {
      const signed = await signTransaction({ transaction: tx, connection, address: wallet!.address });
      return signed as Transaction;
    },
    [signTransaction, connection, wallet],
  );

  const settleFlow = useCallback(
    async (player: PublicKey, session: Keypair, won: boolean) => {
      if (!cfg) return;
      await settleAndUndelegateVrf(cfg, player, session);
      await waitForCommittedResult(cfg, player);
      try {
        const res = await apiVrfSettle({ player: player.toBase58() });
        // Return the unused session gas before dropping the key — once it is
        // gone the remainder is unrecoverable.
        await sweepSession(cfg, session, player);
        rememberSession(null);
        if (won && res.status === "Won") {
          const payout = store.bet * store.multiplier;
          store.applyCashOut(payout);
        }
      } catch (e) {
        // Settle is permissionless + retried by the backend worker; a client
        // failure here doesn't lose funds. Surface but don't revert state.
        toast("Payout finalizing shortly…", "amber");
      }
    },
    [cfg, store, toast],
  );

  const startGame = useCallback(async () => {
    if (!cfg || !wallet || !authenticated || inflightRef.current) return;
    inflightRef.current = true;
    const player = new PublicKey(wallet.address);
    const betLamports = BigInt(Math.floor(store.bet * LAMPORTS_PER_SOL));
    try {
      store.setStatus("starting");
      // The session key is funded inside the start transaction (player-paid,
      // atomic with start_game_vrf) — no separate funding round-trip. It is
      // persisted via the callback BEFORE anything is sent, so a send that
      // throws on a transaction that actually landed cannot lose it.
      const started = await startVrfGame(
        cfg,
        player,
        signPlayer,
        store.mineCount,
        betLamports,
        rememberSession,
      );
      store.beginGame(started.gamePda.toBase58(), started.startSig);
    } catch (e) {
      const msg = e instanceof ApiClientError ? e.message : (e as Error)?.message ?? "start failed";
      store.setError(msg);
      store.setStatus("idle");
    } finally {
      inflightRef.current = false;
    }
  }, [cfg, wallet, authenticated, store, signPlayer]);

  const revealTile = useCallback(
    async (idx: number) => {
      if (!cfg || !wallet || inflightRef.current || store.status !== "playing") return;
      const session = sessionRef.current;
      if (!session) return;
      inflightRef.current = true;
      const player = new PublicKey(wallet.address);
      try {
        store.setPendingTile(idx);
        store.setStatus("revealing");
        const game = await revealTileVrf(cfg, player, session, idx);
        if (!game) {
          store.setStatus("playing");
          store.setPendingTile(null);
          store.setError("VRF draw timed out — tap again");
          return;
        }
        if (game.status === "Lost") {
          store.applyMineReveal(idx, "");
          await settleFlow(player, session, false);
        } else {
          store.applySafeReveal(idx, game.multiplierBps === 0n ? 1 : Number(game.multiplierBps) / 10_000, "");
          if (game.status === "Won") await settleFlow(player, session, true);
        }
      } catch (e) {
        // Never resurrect a decided game. The reveal itself may have landed and
        // set a terminal result on chain — only the settle round-trip failed —
        // so forcing the board back to "playing" would show a live grid that
        // rejects every tap, and hide a real win.
        store.setPendingTile(null);
        if (useGameStore.getState().status === "revealing") store.setStatus("playing");
        store.setError((e as Error)?.message ?? "reveal failed");
      } finally {
        inflightRef.current = false;
      }
    },
    [cfg, wallet, store, settleFlow],
  );

  const cashOut = useCallback(async () => {
    if (!cfg || !wallet || inflightRef.current || store.status !== "playing") return;
    const session = sessionRef.current;
    if (!session || store.safeTiles.size < 1) return;
    inflightRef.current = true;
    const player = new PublicKey(wallet.address);
    try {
      store.setStatus("cashing");
      await cashOutVrf(cfg, player, session);
      await settleFlow(player, session, true);
    } catch (e) {
      // Same reasoning as the reveal path: the cash-out may already have locked
      // the win on chain, so only step back if we are still mid-cash-out.
      if (useGameStore.getState().status === "cashing") store.setStatus("playing");
      store.setError((e as Error)?.message ?? "cash out failed");
    } finally {
      inflightRef.current = false;
    }
  }, [cfg, wallet, store, settleFlow]);

  const resetGame = useCallback(() => {
    rememberSession(null);
    store.reset();
  }, [store, rememberSession]);

  /**
   * Recover a game this browser walked away from.
   *
   * CASH OUT FIRST if the game made progress. A game abandoned mid-play is
   * still Playing, and settle only pays a terminal result — so falling straight
   * through to refund would hand back the bare bet and silently destroy the
   * accrued multiplier. Cashing out locks in what the player actually earned;
   * refund is the last resort, for a game that never revealed anything.
   *
   * Then commit back to L1 (a delegated game cannot be resolved from L1 at
   * all), then settle, then refund.
   */
  const cleanupStuck = useCallback(async (): Promise<boolean> => {
    if (!wallet) return false;
    const player = wallet.address;
    const playerKey = new PublicKey(player);
    const session = loadSession();
    if (cfg && session) {
      try {
        const live = await pollVrfGame(cfg.er, PROGRAM_ID, playerKey, () => true, 8_000);
        if (live && live.status === "Playing" && live.safeReveals > 0 && !live.pending) {
          await cashOutVrf(cfg, playerKey, session);
        }
      } catch {
        /* rollup unreachable — fall through to the L1 paths */
      }
      try {
        await settleAndUndelegateVrf(cfg, playerKey, session);
        await waitForCommittedResult(cfg, playerKey, 30_000);
      } catch {
        /* already undelegated, or the rollup is unreachable — fall through */
      }
    }
    const finish = async () => {
      if (cfg && session) await sweepSession(cfg, session, playerKey);
      rememberSession(null);
    };
    try {
      await apiVrfSettle({ player });
      await finish();
      return true;
    } catch {
      try {
        await apiVrfRefund({ player });
        await finish();
        return true;
      } catch {
        return false;
      }
    }
  }, [wallet, cfg, loadSession, rememberSession]);

  // Run recovery once per wallet on mount: a leftover claim means a previous
  // visit started a game and never finished it. Without this the funds sit
  // until someone manually intervenes, since nothing else calls cleanupStuck.
  // Gated on the mode flag — this hook is called unconditionally (React rules),
  // so without the gate every commit-reveal player would pay for an extra RPC
  // lookup on a mode that is switched off.
  useEffect(() => {
    if (!VRF_MODE_ENABLED) return;
    if (!cfg || !wallet || !authenticated) return;
    if (recoveredRef.current === wallet.address) return;
    recoveredRef.current = wallet.address;
    if (store.status !== "idle") return;
    let cancelled = false;
    void (async () => {
      const [claimPda] = deriveVrfClaimPda(PROGRAM_ID, new PublicKey(wallet.address));
      const info = await connection.getAccountInfo(claimPda, "confirmed").catch(() => null);
      if (!info || cancelled) return;
      try {
        if (decodeVrfClaim(info.data as Buffer).settled) return;
      } catch {
        return;
      }
      await cleanupStuck();
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg, wallet, authenticated, connection, store.status, cleanupStuck]);

  return { startGame, revealTile, cashOut, resetGame, cleanupStuck };
}
