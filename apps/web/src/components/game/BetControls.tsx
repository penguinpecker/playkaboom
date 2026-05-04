"use client";
import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { usePrivy } from "@privy-io/react-auth";
import { useSolanaWallets as useWallets } from "@privy-io/react-auth/solana";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useGame } from "@/hooks/useGame";
import { useVaultMaxBet } from "@/hooks/useContracts";
import { GAME_CONFIG } from "@/lib/chain";

export function BetControls() {
  const { state, setBet, setMineCount, startGame, cashOut } = useGame();
  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const publicKey = wallets[0]?.address ? { toBase58: () => wallets[0]!.address } : null;
  const { connection } = useConnection();
  const { data: maxBetWei } = useVaultMaxBet();
  const [walletBalance, setWalletBalance] = useState(0);

  const isPlaying = state.status === "playing";
  const isStarting = state.status === "starting";
  const isCashing = state.status === "cashing";
  const safeTilesTotal = GAME_CONFIG.GRID_SIZE - state.mineCount;
  const progress = isPlaying ? Math.round((state.safeTiles.size / safeTilesTotal) * 100) : 0;
  const maxBet = maxBetWei ? Number(maxBetWei) / LAMPORTS_PER_SOL : 999;

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
    return () => {
      cancelled = true;
      clearInterval(i);
    };
  }, [publicKey, connection]);

  const handleStart = () => {
    if (!authenticated) {
      login();
      return;
    }
    if (state.bet > walletBalance || state.bet > maxBet) return;
    void startGame();
  };

  return (
    <div className="space-y-6">
      <section className="bg-surface-container-low p-6 stealth-card border border-outline-variant/10">
        <div className="flex justify-between items-center mb-6">
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
              </div>
            </div>
            <div className="flex justify-between mt-1 text-[9px] font-headline text-on-surface-variant/40">
              <span>Balance: {walletBalance.toFixed(3)} SOL</span>
              <span>Max bet: {maxBet.toFixed(2)} SOL</span>
            </div>
          </div>
          <div>
            <label className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant mb-2 block">
              Mine Density
            </label>
            <div className="grid grid-cols-6 gap-2">
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
            disabled={isStarting || !authenticated}
            className="w-full mt-8 py-5 bg-gradient-to-r from-primary to-primary-container text-on-primary font-headline font-black text-lg tracking-[0.2em] glow-primary hover:brightness-125 transition-all active:scale-95 flex items-center justify-center gap-3 disabled:opacity-50"
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
            ) : !authenticated ? (
              <>
                <span className="material-symbols-outlined" style={{ fontSize: 24 }}>
                  account_balance_wallet
                </span>
                CONNECT WALLET
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
