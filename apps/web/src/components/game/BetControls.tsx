"use client";
import { useEffect, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { usePrivy } from "@privy-io/react-auth";
import { useSolanaWallets as useWallets } from "@privy-io/react-auth/solana";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useGame } from "@/hooks/useGame";
import { useVaultCapacity } from "@/hooks/useContracts";
import { usePythSolUsd, formatUsd, solToUsd } from "@/hooks/use-pyth";
import { GAME_CONFIG } from "@/lib/chain";
import { useToast } from "@/components/providers/toast";
import type { StuckGameInfo } from "@/hooks/use-game-resume";

// Safety ceiling on the lock — if the busy state genuinely hangs for
// longer than this, force-release so the player can retry instead of
// staring at an indefinite spinner. Normal confirms are sub-2s; this only
// fires on a real RPC hang.
const LOCK_SAFETY_CEILING_MS = 60_000;

interface Props {
  /** Live on-chain GameSession state from useGameResume (mounted once at
   *  /play). When `active` we MUST disable Engage — start_game would
   *  return 409 because the program rejects a second start with an
   *  existing GameSession PDA, and the user gets the broken "nothing
   *  happens" experience. The recovery banner above handles all three
   *  recovery actions (resume / refund / force-close). */
  stuckInfo?: StuckGameInfo;
}

const fmtSeconds = (s: number) => {
  if (s <= 0) return "now";
  if (s < 60) return `${s}s`;
  return `${Math.ceil(s / 60)}m`;
};

export function BetControls({ stuckInfo }: Props = {}) {
  const { state, setBet, setMineCount, startGame, cashOut } = useGame();
  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const publicKey = wallets[0]?.address ? { toBase58: () => wallets[0]!.address } : null;
  const { connection } = useConnection();
  const { toast } = useToast();
  // useVaultCapacity is the SINGLE SOURCE OF TRUTH for "can the vault
  // pay if I win?" — it mirrors the on-chain check exactly (health-aware,
  // mine-count-aware, obligations-aware). Use it instead of the simpler
  // useVaultMaxBet which only knows about maxBetBps and not the
  // worst-case payout the player might trigger.
  const capacity = useVaultCapacity(state.bet, state.mineCount);
  const { data: pyth } = usePythSolUsd();
  const [walletBalance, setWalletBalance] = useState(0);
  // Dynamic busy timer (replaces the fixed 5s ENGAGE_LOCKOUT countdown).
  // Captures wall-clock at the moment the busy state begins; ticks every
  // 200ms while busy; clears the moment status/pendingClose resolves.
  // Display is "LOCKED · Ns" with N = real elapsed seconds, NOT a fake
  // countdown — lock holds for as long as the actual confirm takes.
  const lockStartedAtRef = useRef<number | null>(null);
  const [lockElapsedMs, setLockElapsedMs] = useState(0);

  const isPlaying = state.status === "playing";
  const isStarting = state.status === "starting";
  const isCashing = state.status === "cashing";
  const isPendingClose = state.pendingClose;
  // Mid-round: bet panel is read-only and re-betting is impossible until
  // the round ends, so any vault-capacity warning is irrelevant noise that
  // makes the player think their in-flight game is at risk. Suppress all
  // capacity-derived UI signals for the duration of the round.
  const inLiveRound = isPlaying || isStarting || isCashing;
  const safeTilesTotal = GAME_CONFIG.GRID_SIZE - state.mineCount;
  const progress = isPlaying ? Math.round((state.safeTiles.size / safeTilesTotal) * 100) : 0;
  const maxBet = capacity.maxBetSol;
  const wouldExceedLiquidity = !inLiveRound && capacity.reason === "exceeds_cap";
  const vaultUnavailable =
    !inLiveRound &&
    (capacity.reason === "paused" ||
      capacity.reason === "vault_empty" ||
      capacity.reason === "obligations_full");
  // Human-readable explanation surfaced under the bet input. Only set when
  // the bet *can't* go through — otherwise the input stays clean. Hidden
  // entirely while the player is in a live round (see inLiveRound above).
  const blockReason: string | null = inLiveRound
    ? null
    : capacity.reason === "paused"
      ? "Vault paused. Gameplay is temporarily disabled."
      : capacity.reason === "obligations_full"
        ? "Vault is fully obligated to in-flight games + pending withdrawals — wait a few minutes for settlements."
        : capacity.reason === "vault_empty"
          ? "Vault is empty. Liquidity needs to be deposited before games can run."
          : capacity.reason === "exceeds_cap"
            ? `Bet exceeds vault capacity for ${state.mineCount} mines. Worst-case payout would be ${capacity.worstCasePayoutSol.toFixed(3)} SOL — limit is ${maxBet.toFixed(3)} SOL.`
            : null;
  // The lock is "true" while ANY of: starting (commit→sign→confirm in
  // flight), cashing (cashOut tx in flight), or pendingClose (background
  // close-game ix from previous round still in flight). Engage stays
  // disabled for the entire window and the timer ticks up showing real
  // elapsed time.
  const isLocked = isStarting || isCashing || isPendingClose;
  const engageLocked = isLocked;

  // Block Engage entirely when the wallet has an unresolved on-chain
  // GameSession. Does NOT apply when the player is mid-round on THIS
  // device (Engage button isn't rendered then anyway — CASH OUT takes
  // its place). Recovery banner above handles the actual unblock UX.
  const hasStuckGame = !inLiveRound && stuckInfo?.active === true;
  // Sub-state for the button label so the user knows WHY it's disabled:
  //   "resume"   = on-chain game with recoverable server session
  //   "force"    = stuck, slot timer elapsed → close button is live above
  //   "wait"     = stuck, slot timer NOT elapsed yet → countdown
  const stuckSubstate: "resume" | "force" | "wait" | null = hasStuckGame
    ? stuckInfo!.recoverable
      ? "resume"
      : stuckInfo!.refundable
        ? "force"
        : "wait"
    : null;

  useEffect(() => {
    if (!publicKey || !connection) return;
    let cancelled = false;
    const f = async () => {
      try {
        const { PublicKey: PK } = await import("@solana/web3.js");
        const b = await connection.getBalance(new PK(publicKey.toBase58()));
        if (!cancelled) setWalletBalance(b / LAMPORTS_PER_SOL);
      } catch {
        /* noop */
      }
    };
    void f();
    const i = setInterval(f, 8_000);
    // Re-fire immediately when the tab returns or the network comes back so
    // the balance recovers from mobile-suspension drift instead of waiting
    // up to 8s (or longer if the timer was throttled into oblivion).
    const onWake = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void f();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);
    window.addEventListener("pageshow", onWake);
    return () => {
      cancelled = true;
      clearInterval(i);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
      window.removeEventListener("pageshow", onWake);
    };
  }, [publicKey, connection]);

  // When the busy state begins, capture wall-clock and start ticking.
  // When it ends (status leaves the busy set AND pendingClose is false),
  // clear immediately. The ticker shows REAL elapsed seconds, not a
  // fake countdown — so the user sees how long their tx is actually
  // taking and the lock auto-clears the instant confirm lands.
  useEffect(() => {
    if (isLocked) {
      if (lockStartedAtRef.current == null) {
        lockStartedAtRef.current = Date.now();
        setLockElapsedMs(0);
      }
    } else {
      lockStartedAtRef.current = null;
      setLockElapsedMs(0);
    }
  }, [isLocked]);

  useEffect(() => {
    if (!isLocked) return;
    const tick = () => {
      if (lockStartedAtRef.current == null) return;
      const elapsed = Date.now() - lockStartedAtRef.current;
      setLockElapsedMs(elapsed);
      // Safety: if we've been busy past the ceiling, something is wrong
      // (RPC hang, stuck status). Force-release so the user can retry
      // instead of staring at "LOCKED · 60s" forever. The store status
      // change won't auto-fire here, but releasing the visual lock lets
      // them click Engage again and the server's 409 path will catch
      // any genuine still-active state.
      if (elapsed >= LOCK_SAFETY_CEILING_MS) {
        lockStartedAtRef.current = null;
        setLockElapsedMs(0);
      }
    };
    const i = setInterval(tick, 200);
    return () => clearInterval(i);
  }, [isLocked]);

  const handleStart = () => {
    if (!authenticated) {
      login();
      return;
    }
    // Block: the player has an unresolved on-chain GameSession. Don't even
    // dispatch start_game — it would 409 from the server and the user gets
    // the "nothing happens" UX. Surface the right action via toast.
    if (hasStuckGame) {
      const msg =
        stuckSubstate === "resume"
          ? "You have an in-flight game above — RESUME or REFUND it first."
          : stuckSubstate === "force"
            ? "Stuck on-chain game — click FORCE CLOSE above to unblock."
            : `Stuck on-chain game above — closable in ${fmtSeconds(stuckInfo!.secondsUntilRefund)}.`;
      toast(msg, "amber");
      return;
    }
    // Loud guards (used to silently early-return — clicks looked dead).
    // Each path now toasts so the user sees WHY nothing fired.
    if (lockStartedAtRef.current != null) {
      // Double-tap caught by the sync ref; no toast since the visual
      // LOCKED state is already showing.
      return;
    }
    if (isStarting) {
      toast("Already starting a round — wait for it to confirm.", "amber");
      return;
    }
    if (isPlaying) {
      toast("Game already in progress — reveal a tile or cash out.", "amber");
      return;
    }
    if (isPendingClose) {
      toast("Finalizing previous round — try again in a second.", "amber");
      return;
    }
    if (state.bet > walletBalance) {
      toast(`Bet exceeds wallet balance (${walletBalance.toFixed(4)} SOL).`, "error");
      return;
    }
    if (state.bet > maxBet) {
      toast(`Bet exceeds vault max bet (${maxBet.toFixed(4)} SOL).`, "error");
      return;
    }
    if (wouldExceedLiquidity) {
      toast("Bet would exceed vault capacity — lower the amount or pick fewer mines.", "error");
      return;
    }
    // Begin the dynamic lock. The ticker effect will start counting up
    // and the disabled state above the button will repaint.
    lockStartedAtRef.current = Date.now();
    setLockElapsedMs(0);
    // Belt-and-suspenders release: if startGame returns early without
    // flipping isLocked (rare but happened in production: Privy
    // !authenticated race during hydration), the useEffect that
    // watches isLocked never fires and lockStartedAtRef stays set
    // → every click after gets silently dropped at the lockedRef
    // guard above. Always release on settle. The reactive isLocked
    // (status-based) is the persistent lock if startGame did
    // transition status, so this finally is safe.
    void startGame().finally(() => {
      // Only release if the reactive lock isn't holding it. If status
      // transitioned to "starting" / "playing" / "cashing", isLocked
      // is true and the useEffect[isLocked] handles the lifecycle.
      // If status stayed "idle" (early-return path), this clears the
      // sync ref so the next click can fire.
      const cur = state.status;
      if (cur === "idle") {
        lockStartedAtRef.current = null;
        setLockElapsedMs(0);
      }
    });
  };

  return (
    <div className="space-y-6">
      <section className="bg-surface-container-low p-4 sm:p-6 stealth-card border border-outline-variant/10">
        <div className="flex justify-between items-center mb-4 sm:mb-6">
          <h2 className="font-headline text-xs font-bold tracking-widest text-on-surface uppercase">
            Engagement Parameters
          </h2>
          <span
            className="material-symbols-outlined text-on-surface-variant"
            style={{ fontSize: 18 }}
          >
            tune
          </span>
        </div>
        <div className="space-y-4">
          <div>
            <label className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant mb-2 block">
              Bet Amount (SOL)
            </label>
            <div className="relative">
              <input
                type="number"
                step="0.001"
                min={0.001}
                value={state.bet}
                onChange={(e) => setBet(Number(e.target.value) || 0)}
                disabled={isPlaying || isStarting}
                className="w-full bg-surface-container-lowest border-none font-headline font-bold text-lg text-primary px-4 py-3 focus:ring-0 focus:outline-none disabled:opacity-50"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
                <button
                  onClick={() => setBet(Math.max(0.001, state.bet / 2))}
                  disabled={isPlaying || isStarting}
                  className="bg-surface-container-highest px-3 py-1 text-[10px] font-headline font-bold text-on-surface hover:bg-primary/20 transition-colors disabled:opacity-30"
                >
                  1/2
                </button>
                <button
                  onClick={() => setBet(Math.min(maxBet, state.bet * 2))}
                  disabled={isPlaying || isStarting}
                  className="bg-surface-container-highest px-3 py-1 text-[10px] font-headline font-bold text-on-surface hover:bg-primary/20 transition-colors disabled:opacity-30"
                >
                  2X
                </button>
                <button
                  onClick={() => {
                    // Cap to whichever is smaller of (vault max bet) or
                    // (wallet balance), then keep 10% of wallet for rent +
                    // network fees. 1% was nowhere near enough to cover the
                    // 3-PDA rent inits a first-game flow can require; 10%
                    // scales with the player's balance so it's tight on
                    // funded wallets and still safe on small ones.
                    const ceiling = Math.min(maxBet, walletBalance * 0.9);
                    const safe = Math.max(0.001, ceiling);
                    // FLOOR to 6dp (1000-lamport precision). toFixed(6)
                    // rounds, which on borderline maxBet values (e.g.
                    // 0.0105695 → "0.010570") pushes the bet a fraction-
                    // of-a-lamport OVER the cap and re-fires "CANNOT BET"
                    // immediately after the click. Flooring is always safe.
                    setBet(Math.floor(safe * 1_000_000) / 1_000_000);
                  }}
                  disabled={isPlaying || isStarting || walletBalance <= 0 || maxBet <= 0}
                  className="bg-surface-container-highest px-3 py-1 text-[10px] font-headline font-bold text-primary hover:bg-primary/20 transition-colors disabled:opacity-30"
                >
                  MAX
                </button>
              </div>
            </div>
            <div className="flex justify-between mt-1 text-[9px] font-headline text-on-surface-variant/40">
              <span>
                Balance: {walletBalance.toFixed(3)} SOL
                {pyth && walletBalance > 0 && (
                  <span className="text-on-surface-variant/30">
                    {" "}
                    ≈ {formatUsd(solToUsd(walletBalance, pyth))}
                  </span>
                )}
              </span>
              <span>
                {pyth && state.bet > 0 && (
                  <span className="text-emerald/70 mr-2">
                    ≈ {formatUsd(solToUsd(state.bet, pyth))}
                  </span>
                )}
                Max safe bet: <span className={wouldExceedLiquidity ? "text-error" : "text-on-surface-variant"}>{maxBet.toFixed(3)} SOL</span>
              </span>
            </div>
            {/* Worst-case payout preview — only when the bet is set and the
                vault has capacity. Lets the player see the actual amount
                the on-chain check is comparing against the vault. */}
            {state.bet > 0 && capacity.worstCasePayoutSol > 0 && !blockReason && (
              <div className="mt-2 text-[10px] font-headline uppercase tracking-widest text-on-surface-variant/50">
                Worst-case payout if you reveal all{" "}
                <span className="text-primary">{GAME_CONFIG.GRID_SIZE - state.mineCount}</span>{" "}
                safe tiles:{" "}
                <span className="text-emerald">
                  {capacity.worstCasePayoutSol.toFixed(3)} SOL
                </span>
              </div>
            )}
            {blockReason && (
              <div className="mt-3 p-3 bg-error/10 border-l-2 border-error">
                <p className="font-headline text-[10px] uppercase tracking-widest text-error mb-1">
                  Cannot bet
                </p>
                <p className="font-mono text-[11px] text-on-surface-variant leading-relaxed">
                  {blockReason}
                </p>
              </div>
            )}
          </div>
          <div>
            <label className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant mb-2 block">
              Mine Density
            </label>
            <div className="grid grid-cols-5 gap-2">
              {GAME_CONFIG.MINE_OPTIONS.map((n) => (
                <button
                  key={n}
                  onClick={() => setMineCount(n)}
                  disabled={isPlaying || isStarting}
                  className={`bg-surface-container-highest py-2 font-headline font-bold text-xs transition-all disabled:opacity-30 ${
                    n === state.mineCount
                      ? "text-on-surface border border-primary/40"
                      : "text-on-surface-variant hover:text-on-surface"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>

        {!isPlaying && state.status !== "cashing" ? (
          <button
            onClick={handleStart}
            disabled={
              isStarting ||
              engageLocked ||
              hasStuckGame ||
              (authenticated && (wouldExceedLiquidity || vaultUnavailable))
            }
            className="w-full mt-8 py-5 bg-gradient-to-r from-primary to-primary-container text-on-primary font-headline font-black text-lg tracking-[0.2em] glow-primary hover:brightness-125 transition-all active:scale-95 flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed disabled:grayscale"
          >
            {isStarting ? (
              <>
                <span
                  className="material-symbols-outlined animate-spin"
                  style={{ fontSize: 24 }}
                >
                  progress_activity
                </span>
                CONFIRMING...
              </>
            ) : engageLocked ? (
              <>
                <span
                  className="material-symbols-outlined animate-spin"
                  style={{ fontSize: 24 }}
                >
                  progress_activity
                </span>
                LOCKED · {Math.max(1, Math.ceil(lockElapsedMs / 1000))}s
              </>
            ) : !authenticated ? (
              <>
                <span className="material-symbols-outlined" style={{ fontSize: 24 }}>
                  account_balance_wallet
                </span>
                CONNECT WALLET
              </>
            ) : hasStuckGame ? (
              <>
                <span className="material-symbols-outlined" style={{ fontSize: 24 }}>
                  lock
                </span>
                {stuckSubstate === "resume"
                  ? "RESUME GAME ABOVE"
                  : stuckSubstate === "force"
                    ? "CLOSE STUCK GAME ABOVE"
                    : `STUCK GAME · READY IN ${fmtSeconds(stuckInfo!.secondsUntilRefund)}`}
              </>
            ) : vaultUnavailable ? (
              <>
                <span className="material-symbols-outlined" style={{ fontSize: 24 }}>
                  block
                </span>
                VAULT UNAVAILABLE
              </>
            ) : wouldExceedLiquidity ? (
              <>
                <span className="material-symbols-outlined" style={{ fontSize: 24 }}>
                  warning
                </span>
                LOWER YOUR BET
              </>
            ) : (
              <>
                <span className="material-symbols-outlined mi" style={{ fontSize: 24 }}>
                  bolt
                </span>
                ENGAGE BET
              </>
            )}
          </button>
        ) : (
          <button
            onClick={cashOut}
            disabled={isCashing || state.safeTiles.size === 0}
            className="w-full mt-8 py-5 border-2 border-emerald text-emerald font-headline font-black text-lg tracking-[0.15em] hover:bg-emerald/10 transition-all active:scale-95 flex items-center justify-center gap-3 disabled:opacity-50"
          >
            {isCashing ? (
              <>
                <span
                  className="material-symbols-outlined animate-spin"
                  style={{ fontSize: 24 }}
                >
                  progress_activity
                </span>
                CASHING OUT...
              </>
            ) : (
              <>
                <span className="material-symbols-outlined mi" style={{ fontSize: 24 }}>
                  savings
                </span>
                EXIT &amp; WITHDRAW — {(state.bet * state.multiplier).toFixed(4)} SOL
              </>
            )}
          </button>
        )}
      </section>

      {state.commitment && state.status === "playing" && (
        <section className="bg-surface-container-low p-4 border border-outline-variant/10">
          <div className="flex items-center gap-2 mb-2">
            <span
              className="material-symbols-outlined text-emerald mi"
              style={{ fontSize: 16 }}
            >
              lock
            </span>
            <span className="font-headline text-[10px] font-bold tracking-widest text-emerald uppercase">
              SHA-256 Commitment
            </span>
          </div>
          <div className="font-mono text-[9px] text-primary/60 break-all select-all">
            {state.commitment}
          </div>
        </section>
      )}

      {isPlaying && (
        <section className="bg-surface-container-low p-4 border border-outline-variant/10">
          <div className="flex justify-between mb-2">
            <span className="font-headline text-[10px] text-on-surface-variant tracking-widest uppercase">
              Clear Progress
            </span>
            <span className="font-headline text-sm text-primary font-bold">{progress}%</span>
          </div>
          <div className="w-full h-2 bg-surface-container-highest rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-primary to-primary-container rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </section>
      )}

      {state.pendingTile !== null && (
        <div className="bg-primary/5 border border-primary/10 p-3 flex items-center gap-2 text-xs text-primary">
          <span
            className="material-symbols-outlined animate-spin"
            style={{ fontSize: 16 }}
          >
            progress_activity
          </span>
          Revealing tile {state.pendingTile}... waiting for on-chain confirmation
        </div>
      )}
    </div>
  );
}
