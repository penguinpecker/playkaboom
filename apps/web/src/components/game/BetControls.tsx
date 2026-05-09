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

// Hard lockout window after a click fires. The Privy popup + RPC simulate +
// tx send round-trip can take a few seconds, and during that window React
// hasn't repainted the disabled state yet. Without this, fast double-clicks
// race past the `isStarting` guard and try to open a second start_game tx
// against the same player PDA — which the program rejects, leaving the
// player thinking the game is "stuck". 5s is well past the worst-case
// confirm latency we see on devnet.
const ENGAGE_LOCKOUT_MS = 5_000;

export function BetControls() {
  const { state, setBet, setMineCount, startGame, cashOut } = useGame();
  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const publicKey = wallets[0]?.address ? { toBase58: () => wallets[0]!.address } : null;
  const { connection } = useConnection();
  // useVaultCapacity is the SINGLE SOURCE OF TRUTH for "can the vault
  // pay if I win?" — it mirrors the on-chain check exactly (health-aware,
  // mine-count-aware, obligations-aware). Use it instead of the simpler
  // useVaultMaxBet which only knows about maxBetBps and not the
  // worst-case payout the player might trigger.
  const capacity = useVaultCapacity(state.bet, state.mineCount);
  const { data: pyth } = usePythSolUsd();
  const [walletBalance, setWalletBalance] = useState(0);
  // Synchronous lockout — flipped on click before any React re-render so a
  // second click in the same event-loop tick is dropped.
  const lockoutUntilRef = useRef(0);
  const [lockoutRemaining, setLockoutRemaining] = useState(0);

  const isPlaying = state.status === "playing";
  const isStarting = state.status === "starting";
  const isCashing = state.status === "cashing";
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
  const engageLocked = lockoutRemaining > 0;

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

  // Drive the visible countdown while the lockout is active. Cleared once
  // it reaches 0 or the component unmounts.
  useEffect(() => {
    if (!engageLocked) return;
    const tick = () => {
      const remaining = Math.max(0, lockoutUntilRef.current - Date.now());
      setLockoutRemaining(remaining);
    };
    const i = setInterval(tick, 100);
    return () => clearInterval(i);
  }, [engageLocked]);

  // Release the lockout the moment the store transitions out of "starting".
  // status → "playing" means success (the CASH OUT button takes over anyway,
  // but we clear so the next round starts fresh).
  // status → "idle" means the tx was rejected/failed — let the player retry
  // without staring at a 5s countdown for no reason.
  useEffect(() => {
    if (state.status === "playing" || state.status === "idle") {
      lockoutUntilRef.current = 0;
      setLockoutRemaining(0);
    }
  }, [state.status]);

  const handleStart = () => {
    if (!authenticated) {
      login();
      return;
    }
    // Drop redundant clicks: ref check is synchronous so it catches the
    // double-tap before the disabled prop or store status can update.
    if (Date.now() < lockoutUntilRef.current) return;
    if (isStarting || isPlaying) return;
    if (state.bet > walletBalance || state.bet > maxBet) return;
    if (wouldExceedLiquidity) return;
    lockoutUntilRef.current = Date.now() + ENGAGE_LOCKOUT_MS;
    setLockoutRemaining(ENGAGE_LOCKOUT_MS);
    void startGame();
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
                    setBet(Number(safe.toFixed(6)));
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
                LOCKED · {Math.ceil(lockoutRemaining / 1000)}s
              </>
            ) : !authenticated ? (
              <>
                <span className="material-symbols-outlined" style={{ fontSize: 24 }}>
                  account_balance_wallet
                </span>
                CONNECT WALLET
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
