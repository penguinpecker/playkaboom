"use client";
// VRF-mode game actions. Same shape as the commit-reveal actions in
// use-game-actions.ts, driving the SAME game store so Grid/Tile/BetControls
// work unchanged. VRF is the only game mode (see use-game-actions).
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
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  startVrfGame,
  revealTileVrf,
  cashOutVrf,
  cashOutVrfAsPlayer,
  settleAndUndelegateVrf,
  settleAndUndelegateVrfAsPlayer,
  sweepSession,
  addPendingSweep,
  parkReplacedSession,
  pendingSweepKey,
  sweepPendingSessions,
  waitForCommittedResult,
  waitForUndelegation,
  pollVrfGame,
  type KeyStore,
  type SignTx,
  type VrfEngineConfig,
} from "@/lib/vrf/client";
import {
  buildSetReferrer,
  decodePlayerStats,
  derivePlayerStatsPda,
  deriveVrfClaimPda,
  deriveVrfGamePda,
  decodeVrfClaim,
  decodeVrfGame,
} from "@playkaboom/sdk";
import { clearPendingReferrer, getPendingReferrer } from "./use-referral";
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

/**
 * Turn a raw program/RPC error into something a player can act on.
 *
 * "custom program error: 0x179b" tells a player nothing. Each of these codes
 * has a known cause and a known next step; anything unrecognised falls back to
 * a generic line rather than leaking internals.
 */
function friendlyVrfError(e: unknown): string {
  const m = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase();
  if (isGameNotPlaying(e))
    return "This round was closed for inactivity — wins are paid at your current multiplier, an untouched bet is refunded.";
  if (m.includes("0x179c"))
    return "The randomness draw is still resolving — try again in a moment.";
  if (m.includes("0x17a2") || m.includes("gamealreadyresolved"))
    return "This round is already finished — reload to see the result.";
  if (m.includes("0x17a9") || m.includes("legacymodedisabled"))
    return "Classic mode is retired — reload the page to play.";
  if (m.includes("0x179b") || m.includes("badsessionkey"))
    return "This browser no longer holds the key for that round — use Recover to close it out.";
  if (m.includes("0x1776") || m.includes("vaultinsufficientfunds"))
    return "The bankroll can't cover that bet right now — try a smaller bet or fewer mines.";
  if (m.includes("already in use") || m.includes("0x0"))
    return "You already have a round open — reload to resume it.";
  if (m.includes("blockhash") || m.includes("expired"))
    return "That took too long to confirm — please try again.";
  if (m.includes("revealpending") || m.includes("pending"))
    return "The randomness draw is still resolving — try again in a moment.";
  return "Something went wrong with that action. Please try again.";
}

/**
 * 6003 GameNotPlaying from a session-key reveal or cash-out: the game is no
 * longer PLAYING on the rollup. In practice the house force-closed it for
 * inactivity (F3): progress became WON, no progress became VOID.
 */
function isGameNotPlaying(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase();
  return m.includes("0x1773") || m.includes("gamenotplaying");
}

/**
 * False only when the player's VrfClaim is confirmed gone (or settled): the
 * round is fully closed, e.g. the house forced it and a later cron tick paid or
 * refunded it. An RPC error counts as open, so nothing is closed on a guess.
 */
async function claimOpen(connection: Connection, player: PublicKey): Promise<boolean> {
  try {
    const info = await connection.getAccountInfo(deriveVrfClaimPda(PROGRAM_ID, player)[0], "confirmed");
    return info !== null && !decodeVrfClaim(info.data as Buffer).settled;
  } catch {
    return true;
  }
}

function keyStore(): KeyStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function useVrfGame(): VrfActions {
  const { authenticated, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const { connection } = useConnection();
  const store = useGameStore();
  const { toast } = useToast();

  const wallet = wallets[0];
  const sessionRef = useRef<Keypair | null>(null);
  const inflightRef = useRef(false);
  const recoveredRef = useRef<string | null>(null);
  // revealTile / cashOut are defined before cleanupStuck; they reach it here.
  const cleanupRef = useRef<() => Promise<boolean>>(async () => false);
  const closeForcedRef = useRef(false);

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
        if (kp) {
          parkReplacedSession(window.localStorage, sessionStorageKey, pendingSweepKey(wallet!.address), kp);
          window.localStorage.setItem(sessionStorageKey, JSON.stringify(Array.from(kp.secretKey)));
        } else window.localStorage.removeItem(sessionStorageKey);
      } catch {
        /* storage unavailable — in-memory still works for this tab */
      }
    },
    [sessionStorageKey, wallet],
  );

  const loadSession = useCallback((): Keypair | null => {
    // localStorage is the SINGLE SOURCE OF TRUTH, checked before the ref.
    //
    // This hook runs in ~6 components at once (BetControls, Grid, Tile,
    // ModalRoot, the play page, the recovery banner) and each instance has its
    // OWN sessionRef. startGame runs in ONE of them, so only that instance's
    // ref learns the new key — every other instance still holds the PREVIOUS
    // game's key. Returning the ref first meant the component handling tile
    // clicks signed reveals with a stale key and the program rejected them
    // with BadSessionKey (6043 / 0x179b).
    //
    // That is exactly the "first game works, second game's tiles do nothing"
    // report: on the first game the refs are all null so everyone falls
    // through to storage and agrees; from the second game on they diverge.
    if (sessionStorageKey && typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(sessionStorageKey);
        if (raw) {
          const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
          sessionRef.current = kp;
          return kp;
        }
        // Storage was explicitly cleared (game ended) — the ref is stale too.
        sessionRef.current = null;
        return null;
      } catch {
        /* unreadable storage — fall back to whatever this instance holds */
      }
    }
    return sessionRef.current;
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

  /** Sweep finished rounds' keys still holding gas (+ `extra`). Never throws. */
  const sweepLeftovers = useCallback(
    (extra: Keypair[] = []) => {
      if (!cfg || !wallet) return Promise.resolve();
      const player = new PublicKey(wallet.address);
      return sweepPendingSessions(keyStore(), pendingSweepKey(wallet.address), (kp) => sweepSession(cfg, kp, player), extra);
    },
    [cfg, wallet],
  );

  /**
   * A round is over: put its session key on the sweep list, THEN drop it from
   * the live slot, then return its gas in the background.
   *
   * The key used to be forgotten right after a sweep that swallowed its own
   * failure, which threw away the gas for good (g18, 2026-11-05). Now it is
   * forgotten only once its sweep confirms the key empty; a failed sweep stays
   * on the list and is retried on the next mount and before the next round.
   * Its own slot, so the next round's key can never overwrite it.
   */
  const retireSession = useCallback(
    (kp: Keypair | null) => {
      if (kp && wallet) addPendingSweep(keyStore(), pendingSweepKey(wallet.address), kp);
      const live = loadSession();
      // Clear the live slot only if it still holds THIS key, never a newer round's.
      if (!kp || !live || live.publicKey.equals(kp.publicKey)) rememberSession(null);
      if (kp) void sweepLeftovers([kp]);
    },
    [wallet, loadSession, rememberSession, sweepLeftovers],
  );

  const signPlayer: SignTx = useCallback(
    async (tx: Transaction) => {
      const signed = await signTransaction({ transaction: tx, connection, address: wallet!.address });
      return signed as Transaction;
    },
    [signTransaction, connection, wallet],
  );

  /**
   * Player signer for ROLLUP transactions.
   *
   * Must hand the wallet the ER connection, not the L1 one. These transactions
   * carry an ER blockhash and touch an account that L1 sees as owned by the
   * delegation program — so any preflight the wallet runs against L1 fails on
   * a transaction that is perfectly valid on the rollup. Signing with the
   * wrong connection is how the recovery flow kept dying silently after CSP
   * was opened: settle_and_undelegate simulates clean on the rollup
   * (err: null) but never landed from the browser.
   */
  const signPlayerEr: SignTx = useCallback(
    async (tx: Transaction) => {
      const signed = await signTransaction({
        transaction: tx,
        connection: erConn ?? connection,
        address: wallet!.address,
      });
      return signed as Transaction;
    },
    [signTransaction, erConn, connection, wallet],
  );

  const settleFlow = useCallback(
    async (player: PublicKey, session: Keypair, won: boolean) => {
      if (!cfg) return;
      // Mark the post-result chain as in flight. Between a terminal result and
      // the settle landing, the on-chain claim still exists, so the session
      // probe reports an active game and GameRecoveryBanner rendered
      // "STUCK GAME ON-CHAIN — UNBLOCK YOUR WALLET" over a perfectly normal
      // loss, while BetControls locked Engage. The banner and BetControls
      // already honour pendingClose (the legacy path sets it); VRF never did.
      store.setPendingClose(true);
      try {
      await settleAndUndelegateVrf(cfg, player, session);
      await waitForCommittedResult(cfg, player);
      let settled = false;
      try {
        // The fast path: the house settles now. Retry the transient answers
        // (result not visible to the server's RPC yet, 429, 5xx, network) a few
        // times instead of falling back to the 60 s cron on the first miss.
        let res: Awaited<ReturnType<typeof apiVrfSettle>> | null = null;
        for (let attempt = 0; ; attempt++) {
          try {
            res = await apiVrfSettle({ player: player.toBase58() });
            break;
          } catch (e) {
            const status = e instanceof ApiClientError ? e.status : 0;
            const transient =
              status === 0 || status === 429 || status >= 500 ||
              (status === 409 && /not finished/i.test((e as Error).message));
            if (!transient || attempt >= 5) throw e;
            await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
          }
        }
        // TELL THE PLAYER THEY WON *FIRST*.
        //
        // This used to sit after sweepSession, so a throw while returning
        // leftover session gas skipped it entirely: the game settled on chain,
        // the payout landed in the wallet, and the UI showed only a vague
        // "Payout finalizing shortly…" with no win modal and no status change.
        // Sweeping dust is housekeeping and must never gate the result.
        if (won && res.status === "Won") {
          // Read the LIVE store, not the closure snapshot. `store` here is the
          // object captured when this callback was built; zustand allocates a
          // new state object on every set, so on a full clear the multiplier
          // had already advanced past what this closure could see and the win
          // modal under-reported the payout that actually landed.
          const { bet, multiplier } = useGameStore.getState();
          const payout = bet * multiplier;
          store.applyCashOut(payout);
        }
        settled = true;
      } catch {
        // Settle is permissionless + retried by the backend worker; a client
        // failure here doesn't lose funds. Surface but don't revert state.
        toast("Payout finalizing shortly…", "amber");
      }
      // Cleanup runs regardless, and its failure is never the player's problem:
      // the gas sweep runs in the background and a failed one keeps the key.
      retireSession(session);
      return settled;
      } finally {
        // Always clear, even on a thrown settle — otherwise the genuine
        // recovery affordance would stay hidden forever.
        store.setPendingClose(false);
      }
    },
    [cfg, store, toast, retireSession],
  );

  const startGame = useCallback(async () => {
    if (!cfg || !wallet || !authenticated || inflightRef.current) return;
    inflightRef.current = true;
    const player = new PublicKey(wallet.address);
    const betLamports = BigInt(Math.floor(store.bet * LAMPORTS_PER_SOL));
    try {
      // Preflight: an unsettled claim means a previous round is still open.
      // start_game_vrf would fail inside the System Program with "Allocate:
      // account already in use" (custom error 0x0), which surfaces as a raw
      // simulation dump the player cannot act on. Say what is actually wrong.
      const [existingClaim] = deriveVrfClaimPda(PROGRAM_ID, player);
      const prior = await connection.getAccountInfo(existingClaim, "confirmed").catch(() => undefined);
      if (prior) {
        let unsettled = false;
        try {
          unsettled = !decodeVrfClaim(prior.data as Buffer).settled;
        } catch {
          unsettled = true;
        }
        if (unsettled) {
          store.setError(
            "You already have a round open — reload to resume it, or use Recover to close it out.",
          );
          store.setStatus("idle");
          return;
        }
      }
      // No open round (read OK, not an RPC error): a key still in the live slot
      // is a FINISHED round's, and this round's key is about to overwrite it.
      // Retire it first. Either way earlier failed sweeps get another go. Not
      // awaited — a sweep never holds up the start.
      const stale = prior !== undefined ? loadSession() : null;
      if (stale) retireSession(stale);
      else void sweepLeftovers();
      store.setStatus("starting");
      // Referral link: bundle set_referrer into the player's first start (one
      // signature, atomic). Skipped on any error; /referrals keeps the manual
      // "Confirm referrer" button as the fallback.
      const preIxs: TransactionInstruction[] = [];
      const pendingRef = getPendingReferrer();
      if (pendingRef && pendingRef !== wallet.address) {
        try {
          const [statsPda] = derivePlayerStatsPda(PROGRAM_ID, player);
          const info = await connection.getAccountInfo(statsPda, "confirmed");
          const hasReferrer =
            info && info.owner.equals(PROGRAM_ID) ? decodePlayerStats(info.data as Buffer).referrer !== null : false;
          if (!hasReferrer) {
            preIxs.push(
              buildSetReferrer({ ctx: { programId: PROGRAM_ID }, player, referrer: new PublicKey(pendingRef) }),
            );
          }
        } catch {
          /* start without it */
        }
      }
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
        preIxs,
      );
      store.beginGame(started.gamePda.toBase58(), started.startSig);
      if (preIxs.length > 0) {
        // The on-chain set_referrer is what counts; /api/ref/confirm only
        // decorates the referral_visits row. Best-effort.
        clearPendingReferrer();
        void (async () => {
          try {
            const token = await getAccessToken();
            if (!token) return;
            await fetch("/api/ref/confirm", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ wallet: wallet.address, signature: started.startSig }),
              credentials: "include",
            });
          } catch {
            /* analytics — silent */
          }
        })();
      }
    } catch (e) {
      // LAST-DITCH: the start is ONE atomic transaction now, so if the game is
      // delegated on chain then everything succeeded — bet locked, session key
      // funded, rollup ready — regardless of what the send path reported. Drop
      // the player into the live game rather than an error they cannot act on.
      try {
        const [gamePda] = deriveVrfGamePda(PROGRAM_ID, player);
        const [claimPda] = deriveVrfClaimPda(PROGRAM_ID, player);
        const [gi, ci] = await Promise.all([
          connection.getAccountInfo(gamePda, "confirmed"),
          connection.getAccountInfo(claimPda, "confirmed"),
        ]);
        // F6: a DLP-owned game with no claim is an orphan of an admin
        // release, not this start; only a live claim proves the start landed.
        if (gi && !gi.owner.equals(PROGRAM_ID) && ci) {
          store.beginGame(gamePda.toBase58(), "");
          return;
        }
      } catch {
        /* fall through to the real error */
      }
      const msg = e instanceof ApiClientError ? e.message : (e as Error)?.message ?? "start failed";
      store.setError(msg);
      store.setStatus("idle");
    } finally {
      inflightRef.current = false;
    }
  }, [cfg, wallet, authenticated, store, signPlayer, connection, rememberSession, getAccessToken, loadSession, retireSession, sweepLeftovers]);

  const revealTile = useCallback(
    async (idx: number) => {
      if (!cfg || !wallet || inflightRef.current || store.status !== "playing") return;
      // loadSession(), NOT sessionRef.current. The ref is in-memory only, so a
      // reload or a remount leaves it null while the key is sitting in
      // localStorage — and a bare `return` here strands a live, delegated game
      // with no error and nothing in the console. That is exactly what the
      // persistence above exists to prevent, so it has to be read here.
      const session = loadSession();
      if (!session) {
        store.setError(
          "Session key for this game is missing in this browser — use Recover to close it out.",
        );
        return;
      }
      inflightRef.current = true;
      const player = new PublicKey(wallet.address);
      try {
        store.setPendingTile(idx);
        store.setStatus("revealing");
        const game = await revealTileVrf(cfg, player, session, idx);
        // A RESULT IS ONLY A RESULT ONCE THE ORACLE HAS ANSWERED.
        //
        // Checking `!game` alone was not enough: the poll can return a game
        // object whose draw has NOT resolved (`pending` still set, or this
        // tile's bit not yet in revealedMask). Everything below then treats a
        // non-Lost read as a confirmed SAFE tile and advances the multiplier —
        // so the board could show a win on a tile the chain had not decided,
        // and contradict itself when the real result landed. Treat an
        // unresolved draw exactly like a timeout: nothing is lost, the tile is
        // still tappable, and the chain remains the only source of truth.
        if (!game || game.pending || (game.revealedMask & (1 << idx)) === 0) {
          store.setStatus("playing");
          store.setPendingTile(null);
          store.setError(
            // Not "tap again": while the draw is still pending on chain BOTH
            // reveal_request_vrf and cash_out_vrf require !pending, so every tap
            // would be rejected until the oracle answers.
            "The randomness draw is still resolving — this tile will unlock in a moment.",
          );
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
        store.setError(friendlyVrfError(e));
        // F3: the house force-closed this round (WON or VOID). Re-read the
        // game and close it out instead of leaving a board that rejects taps.
        // The cron may also have finished the round already (claim gone), in which
        // case the ER can refuse the reveal with some other error.
        if (isGameNotPlaying(e) || !(await claimOpen(connection, player))) closeForcedRef.current = true;
      } finally {
        inflightRef.current = false;
      }
      if (closeForcedRef.current) {
        closeForcedRef.current = false;
        if (await cleanupRef.current()) {
          store.reset();
          toast("Round closed for inactivity — any win was paid, an untouched bet refunded.", "amber");
        }
      }
    },
    [cfg, wallet, store, settleFlow, loadSession, toast, connection],
  );

  const cashOut = useCallback(async () => {
    if (!cfg || !wallet || inflightRef.current || store.status !== "playing") return;
    // Same reasoning as revealTile: read through to localStorage, and say so
    // when the key is genuinely gone rather than no-opping on the cash-out
    // button of a game holding real money.
    const session = loadSession();
    if (!session) {
      store.setError(
        "Session key for this game is missing in this browser — use Recover to close it out.",
      );
      return;
    }
    if (store.safeTiles.size < 1) return;
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
      store.setError(friendlyVrfError(e));
      if (isGameNotPlaying(e) || !(await claimOpen(connection, player))) closeForcedRef.current = true;
    } finally {
      inflightRef.current = false;
    }
    if (closeForcedRef.current) {
      closeForcedRef.current = false;
      if (await cleanupRef.current()) {
        store.reset();
        toast("Round closed for inactivity — any win was paid, an untouched bet refunded.", "amber");
      }
    }
  }, [cfg, wallet, store, settleFlow, loadSession, toast, connection]);

  const resetGame = useCallback(() => {
    retireSession(loadSession());
    store.reset();
  }, [store, retireSession, loadSession]);

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
    const stored = loadSession();
    // F3: a round the house forced and a later tick already settled/refunded
    // has no claim left; both L1 routes would 404. It is resolved: sweep the
    // key and report success so the board resets.
    if (!(await claimOpen(connection, playerKey))) {
      retireSession(stored);
      return true;
    }
    // A STORED KEY IS NOT NECESSARILY THIS GAME'S KEY. localStorage survives
    // across rounds, so it can hold a session key from an earlier game. The
    // program checks `signer == g.session_key` exactly and rejects anything
    // else with BadSessionKey (6043 / 0x179b) — even the correct player —
    // which is precisely how recovery kept failing: the code preferred a
    // stale key over the player's wallet, which WOULD have been accepted.
    //
    // So the stored key is only usable once it matches the live game.
    let session: Keypair | null = null;
    let live: Awaited<ReturnType<typeof pollVrfGame>> = null;
    // UNDELEGATED HAS TWO COMPLETELY DIFFERENT MEANINGS. Both leave the game
    // account on L1 owned by our program, and telling them apart is the whole
    // job here:
    //
    //   a) NEVER delegated — the start landed but delegate_vrf never fired
    //      (a confirm timeout between the two start transactions). Status is
    //      Playing with zero reveals. Nothing was played; REFUND.
    //   b) delegated, played, and COMMITTED BACK — the normal end of a round.
    //      Status is Won or Lost, carrying the earned multiplier. SETTLE, and
    //      pay the player.
    //
    // A previous version of this treated undelegated as (a) unconditionally
    // and tried to refund a WON game — /api/vrf/refund returned 400 because
    // refund_stalled_vrf rightly refuses to convert a win into a bet refund.
    // Read the committed L1 state and let the STATUS decide, never ownership.
    let delegated = false;
    let committed: Awaited<ReturnType<typeof pollVrfGame>> = null;
    try {
      const [gamePda] = deriveVrfGamePda(PROGRAM_ID, playerKey);
      const gi = await connection.getAccountInfo(gamePda, "confirmed");
      delegated = gi !== null && !gi.owner.equals(PROGRAM_ID);
      if (gi && !delegated) {
        try {
          committed = decodeVrfGame(gi.data as Buffer);
        } catch {
          /* not decodable — fall through, refund path will report */
        }
      }
    } catch {
      /* transient — assume delegated and let the ER steps report */
      delegated = true;
    }
    if (cfg && delegated) {
      try {
        // WAIT FOR THE DRAW TO LAND before deciding anything.
        //
        // This used to read once (`() => true, 8_000`), so a recovery that ran
        // during an in-flight VRF draw saw pending=true — which disqualifies
        // the cash-out below and used to strand the round. The draw normally
        // resolves in about a second; giving it the same 45s the reveal path
        // allows turns the common race straight back into the correct
        // cash-out instead of an unrecoverable state.
        live = await pollVrfGame(cfg.er, PROGRAM_ID, playerKey, (g) => !g.pending, 45_000);
      } catch (e) {
        console.warn("[vrf] could not read the rollup game:", e);
      }
      if (stored && live && stored.publicKey.equals(live.sessionKey)) {
        session = stored;
      } else if (stored && live) {
        console.warn(
          `[vrf] stored session ${stored.publicKey.toBase58()} does not match this game's ` +
            `${live.sessionKey.toBase58()} — using the player wallet instead`,
        );
      }

      const needsCashOut = !!live && live.status === "Playing" && live.safeReveals > 0;
      let cashedOut = false;
      try {
        if (needsCashOut && !live!.pending) {
          if (session) await cashOutVrf(cfg, playerKey, session);
          else await cashOutVrfAsPlayer(cfg, playerKey, signPlayerEr);
          cashedOut = true;
        }
      } catch (e) {
        // Surface, don't swallow. A silent catch here meant the ONLY thing the
        // player ever saw was the downstream 409/400 from the L1 routes, which
        // describe a symptom ("game not finished", "still delegated") and say
        // nothing about the rollup step that actually failed.
        console.warn("[vrf] rollup cash-out step failed:", e);
      }

      // NEVER COMMIT BACK WHILE VALUE IS STILL RESCUABLE IN THE ROLLUP.
      //
      // Undelegating is the irreversible step. Doing it to a game that is
      // still `Playing` with reveals on the board produces a state with NO
      // exit: settle_vrf demands a terminal status, and the house-relayed
      // refund is refused because refund_stalled_vrf only accepts a non-player
      // caller when safe_reveals == 0 && pending == 0. The bet plus the earned
      // multiplier then sit until the owner's ~24h admin release, which
      // returns the bet and destroys the winnings.
      //
      // Leaving the game DELEGATED is the safe failure: it stays playable and
      // the player can retry recovery once the draw lands.
      const safeToUndelegate =
        live !== null &&
        (live.status !== "Playing" || cashedOut || (live.safeReveals === 0 && !live.pending));
      if (!safeToUndelegate) {
        store.setError(
          "Your round is still resolving — nothing was changed. Try Recover again in a moment.",
        );
        return false;
      }
      let undelegateErr: unknown = null;
      try {
        if (session) await settleAndUndelegateVrf(cfg, playerKey, session);
        else await settleAndUndelegateVrfAsPlayer(cfg, playerKey, signPlayerEr);
      } catch (e) {
        // A round the house already force-closed (F3) has its undelegation
        // scheduled, so ours may be refused; the wait below still sees it land.
        undelegateErr = e;
        console.warn("[vrf] undelegate step failed:", e);
      }
      // Wait for UNDELEGATION, not for a terminal result: a refund needs only
      // the account back on L1 (Playing/Void), not Won/Lost.
      const back = await waitForUndelegation(cfg, playerKey, 20_000);
      if (!back && undelegateErr) {
        store.setError(
          `Could not bring the game back from the rollup: ${(undelegateErr as Error)?.message ?? "unknown"}`,
        );
      }
      // The committed L1 copy is now the truth (a forced game reads Won/Void).
      if (back) {
        try {
          const gi = await connection.getAccountInfo(deriveVrfGamePda(PROGRAM_ID, playerKey)[0], "confirmed");
          if (gi && gi.owner.equals(PROGRAM_ID)) {
            committed = decodeVrfGame(gi.data as Buffer);
            delegated = false;
          }
        } catch {
          /* keep the rollup copy */
        }
      }
    }
    const finish = async () => {
      // Sweep whatever key we HAVE, not only the one that matched a delegated
      // game. When recovery runs on an already-undelegated round `session` is
      // null but a funded key may still sit in storage — clearing it without
      // sweeping permanently abandoned ~0.002 SOL of the player's own money.
      retireSession(session ?? stored);
    };
    // STATUS decides, not ownership. A game carrying a terminal result must be
    // SETTLED — that is how the player gets paid — and only a game that is
    // still `Playing` with nothing revealed can honestly be refunded.
    // `state` is whichever copy is authoritative: the rollup's while
    // delegated, the committed L1 copy once it is back.
    const state = delegated ? live : committed;
    // VOID (F3: closed for inactivity, nothing revealed) is refund-only too.
    const refundOnly =
      state !== null &&
      (state.status === "Void" || (state.status === "Playing" && state.safeReveals === 0));
    if (!refundOnly) {
      try {
        await apiVrfSettle({ player });
        await finish();
        return true;
      } catch {
        /* not settleable — fall through to refund */
      }
    }
    try {
      await apiVrfRefund({ player });
      await finish();
      return true;
    } catch {
      return false;
    }
  }, [wallet, cfg, connection, loadSession, retireSession, signPlayerEr, store]);
  cleanupRef.current = cleanupStuck;

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
    // Retry gas sweeps that failed on an earlier visit. Background, never blocks.
    void sweepLeftovers();
    if (store.status !== "idle") return;
    let cancelled = false;
    void (async () => {
      const playerKey = new PublicKey(wallet.address);
      const [claimPda] = deriveVrfClaimPda(PROGRAM_ID, playerKey);
      // Read BEFORE the claim, so a round started meanwhile (new key) is never retired below.
      const liveKey = loadSession();
      const info = await connection.getAccountInfo(claimPda, "confirmed").catch(() => undefined);
      if (info === undefined || cancelled) return; // RPC error: decide nothing
      let claim: ReturnType<typeof decodeVrfClaim> | null;
      try {
        claim = info ? decodeVrfClaim(info.data as Buffer) : null;
      } catch {
        return;
      }
      if (!claim || claim.settled) {
        // No open round, so a key left in the live slot is a finished round's
        // (e.g. the tab closed before its sweep): retire it before the next
        // round's key overwrites it.
        if (liveKey) retireSession(liveKey);
        return;
      }

      // RESUME BEFORE CLEANUP. An unsettled claim does not mean the game is
      // broken — the common case is a game still happily Playing in the
      // rollup that this browser simply lost its in-memory state for. Closing
      // that out destroys a live round; worse, if the close fails the UI drops
      // back to idle and the next Engage collides with the existing claim
      // ("Allocate: account already in use"), which is a dead end the player
      // cannot escape from the UI at all.
      //
      // So: if the game is still playable AND we still hold the session key,
      // rehydrate the board and let them keep playing. Only fall through to
      // cleanupStuck when the game genuinely cannot be continued.
      const session = loadSession();
      if (session && cfg) {
        try {
          // A game is only playable if it is ACTUALLY IN THE ROLLUP. When the
          // start landed but the delegate never fired (poll timeout between
          // the two start transactions), the game sits on L1 owned by our
          // program and the ER merely mirrors it — resuming that paints a
          // live board where every tile fails, because the rollup cannot
          // write an account that was never delegated to it. Those games are
          // interrupted starts with zero reveals; recovery refunds them.
          const [gamePda] = deriveVrfGamePda(PROGRAM_ID, playerKey);
          const gi = await connection.getAccountInfo(gamePda, "confirmed").catch(() => null);
          const delegated = gi !== null && !gi.owner.equals(PROGRAM_ID);
          if (cancelled) return;
          const live = delegated
            ? await pollVrfGame(cfg.er, PROGRAM_ID, playerKey, () => true, 8_000)
            : null;
          if (cancelled) return;
          // Only resume when the stored key IS this game's session key. Since
          // reveal_request_vrf accepts nothing else, resuming on a mismatch
          // would paint a live board where every single tap fails with
          // BadSessionKey. Fall through to recovery instead.
          if (
            live &&
            live.status === "Playing" &&
            !live.pending &&
            session.publicKey.equals(live.sessionKey)
          ) {
            const safeMask = live.revealedMask & ~live.mineMask;
            store.hydrateResume({
              bet: Number(claim.bet) / LAMPORTS_PER_SOL,
              mineCount: claim.mineCount,
              revealedMask: live.revealedMask,
              revealedSafeMask: safeMask,
              multiplier:
                live.multiplierBps === 0n ? 1 : Number(live.multiplierBps) / 10_000,
              // VRF has no SHA-256 commitment; the game PDA is the on-chain
              // handle the UI shows in that slot.
              commitment: claimPda.toBase58(),
              // VRF carries no server-side session token — the session keypair
              // in localStorage is the equivalent, and it is already loaded.
              gameToken: "",
            });
            return;
          }
        } catch {
          /* rollup unreachable — fall through and try to close it out */
        }
      }
      await cleanupStuck();
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg, wallet, authenticated, connection, store.status, cleanupStuck, loadSession, store, retireSession, sweepLeftovers]);

  return { startGame, revealTile, cashOut, resetGame, cleanupStuck };
}
