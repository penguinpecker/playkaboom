"use client";
import { GRID_SIZE, MINE_OPTIONS } from "@playkaboom/shared";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";
import { useGameStore } from "@/stores/game-store";
import { useGameActions } from "@/hooks/use-game-actions";
import { useVault, useWalletBalance } from "@/hooks/use-vault";

export function BetControls() {
  const status = useGameStore((s) => s.status);
  const bet = useGameStore((s) => s.bet);
  const mineCount = useGameStore((s) => s.mineCount);
  const setBet = useGameStore((s) => s.setBet);
  const setMineCount = useGameStore((s) => s.setMineCount);
  const multiplier = useGameStore((s) => s.multiplier);
  const safeTiles = useGameStore((s) => s.safeTiles);
  const pendingTile = useGameStore((s) => s.pendingTile);

  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets[0];
  const { startGame, cashOut } = useGameActions();

  const { data: vault } = useVault();
  const { data: walletBalance = 0 } = useWalletBalance(wallet?.address);

  const isPlaying = status === "playing";
  const isStarting = status === "starting";
  const isCashing = status === "cashing";
  const safeTotal = GRID_SIZE - mineCount;
  const progressPct = isPlaying ? Math.round((safeTiles.size / safeTotal) * 100) : 0;
  const maxBet = vault?.maxBetSol ?? 999;

  const onStart = () => {
    if (!authenticated) {
      login();
      return;
    }
    if (bet > walletBalance || bet > maxBet) return;
    void startGame();
  };

  return (
    <div className="space-y-6">
      <section className="stealth-card border border-outline-variant/10 bg-surface-container-low p-6">
        <h2 className="mb-6 font-headline text-xs font-bold uppercase tracking-widest text-on-surface">
          Engagement parameters
        </h2>

        <div className="space-y-4">
          <div>
            <label className="mb-2 block font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
              Bet amount (SOL)
            </label>
            <div className="relative">
              <input
                type="number"
                step="0.001"
                min={0.001}
                value={bet}
                disabled={isPlaying || isStarting}
                onChange={(e) => setBet(Number(e.target.value) || 0)}
                className="w-full border-none bg-surface-container-lowest px-4 py-3 font-headline text-lg font-bold text-primary focus:outline-none disabled:opacity-50"
              />
              <div className="absolute right-2 top-1/2 flex -translate-y-1/2 gap-1">
                <button
                  type="button"
                  disabled={isPlaying || isStarting}
                  onClick={() => setBet(Math.max(0.001, bet / 2))}
                  className="bg-surface-container-highest px-3 py-1 font-headline text-[10px] font-bold transition-colors hover:bg-primary/20 disabled:opacity-30"
                >
                  ½
                </button>
                <button
                  type="button"
                  disabled={isPlaying || isStarting}
                  onClick={() => setBet(Math.min(maxBet, bet * 2))}
                  className="bg-surface-container-highest px-3 py-1 font-headline text-[10px] font-bold transition-colors hover:bg-primary/20 disabled:opacity-30"
                >
                  2×
                </button>
              </div>
            </div>
            <div className="mt-1 flex justify-between font-headline text-[9px] text-on-surface-variant/40">
              <span>Balance: {walletBalance.toFixed(3)} SOL</span>
              <span>Max bet: {maxBet.toFixed(2)} SOL</span>
            </div>
          </div>

          <div>
            <label className="mb-2 block font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
              Mine density
            </label>
            <div className="grid grid-cols-6 gap-2">
              {MINE_OPTIONS.map((n) => (
                <button
                  type="button"
                  key={n}
                  disabled={isPlaying || isStarting}
                  onClick={() => setMineCount(n)}
                  className={`bg-surface-container-highest py-2 font-headline text-xs font-bold transition-all disabled:opacity-30 ${
                    n === mineCount ? "border border-primary/40 text-on-surface" : "text-on-surface-variant hover:text-on-surface"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>

        {!isPlaying && status !== "cashing" ? (
          <button
            type="button"
            onClick={onStart}
            disabled={isStarting || !authenticated}
            className="glow-primary mt-8 flex w-full items-center justify-center gap-3 bg-gradient-to-r from-primary to-primary-container py-5 font-headline text-lg font-black tracking-[0.2em] text-on-primary transition-all hover:brightness-125 active:scale-95 disabled:opacity-50"
          >
            {isStarting ? "CONFIRMING…" : !authenticated ? "CONNECT WALLET" : "ENGAGE BET"}
          </button>
        ) : (
          <button
            type="button"
            onClick={cashOut}
            disabled={isCashing || safeTiles.size === 0}
            className="mt-8 flex w-full items-center justify-center gap-3 border-2 border-emerald py-5 font-headline text-lg font-black tracking-[0.15em] text-emerald transition-all hover:bg-emerald/10 active:scale-95 disabled:opacity-50"
          >
            {isCashing
              ? "CASHING OUT…"
              : `EXIT & WITHDRAW — ${(bet * multiplier).toFixed(4)} SOL`}
          </button>
        )}
      </section>

      {isPlaying && (
        <section className="border border-outline-variant/10 bg-surface-container-low p-4">
          <div className="mb-2 flex justify-between">
            <span className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
              Clear progress
            </span>
            <span className="font-headline text-sm font-bold text-primary">{progressPct}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-container-highest">
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary to-primary-container transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </section>
      )}

      {pendingTile !== null && (
        <div className="flex items-center gap-2 border border-primary/10 bg-primary/5 p-3 text-xs text-primary">
          Revealing tile {pendingTile}…
        </div>
      )}
    </div>
  );
}
