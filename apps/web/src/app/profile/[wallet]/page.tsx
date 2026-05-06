"use client";
import { useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { REFERRAL_TIER_LABELS } from "@playkaboom/shared";
import { usePlayerStats } from "@/hooks/use-player-stats";
import { useReferralAccount } from "@/hooks/use-referral";
import { useGameHistory } from "@/hooks/useGameHistory";
import { useAccount } from "@/lib/compat";
import { accountExplorer, txExplorer } from "@/lib/cluster";
import { shortAddr } from "@/lib/format";

export default function ProfilePage() {
  const params = useParams<{ wallet: string }>();
  const wallet = params.wallet;
  const { address } = useAccount();
  const isMe = !!address && address.toLowerCase() === wallet.toLowerCase();

  const { data: stats, isLoading: statsLoading } = usePlayerStats(wallet);
  const { data: referral } = useReferralAccount(wallet);
  const { history } = useGameHistory();

  const myGames = useMemo(
    () => history.filter((g) => g.player.toLowerCase() === wallet.toLowerCase()).slice(0, 10),
    [history, wallet],
  );

  if (statsLoading) {
    return (
      <div className="px-6 lg:px-8 pb-16 min-h-screen">
        <div className="py-24 text-center text-on-surface-variant text-sm">Loading…</div>
      </div>
    );
  }

  const lamportsToSol = (v: bigint | undefined) =>
    v === undefined ? 0 : Number(v) / LAMPORTS_PER_SOL;

  const gamesPlayed = stats ? Number(stats.gamesPlayed) : 0;
  const gamesWon = stats ? Number(stats.gamesWon) : 0;
  const winRate = gamesPlayed > 0 ? (gamesWon / gamesPlayed) * 100 : 0;
  const totalWagered = lamportsToSol(stats?.totalWagered);
  const totalPayouts = lamportsToSol(stats?.totalPayouts);
  const netPnl = totalPayouts - totalWagered;
  const biggestWin = lamportsToSol(stats?.biggestWin);
  const biggestMult = stats ? Number(stats.biggestMultiplierBps) / 10_000 : 0;
  const currentStreak = stats?.currentStreak ?? 0;
  const bestStreak = stats?.bestStreak ?? 0;
  const lastPlayed = stats?.lastPlayed ? new Date(Number(stats.lastPlayed) * 1000) : null;

  return (
    <div className="px-6 lg:px-8 pb-16 min-h-screen kinetic-grid">
      {/* Header */}
      <div className="mb-8">
        <p className="font-headline text-[10px] tracking-[.12em] text-on-surface-variant flex items-center gap-1 mb-1">
          <span className="status-dot" />
          {isMe ? "YOUR PROFILE" : "OPERATIVE PROFILE"}
        </p>
        <div className="flex items-end justify-between">
          <div>
            <h1 className="font-headline text-4xl font-black italic tracking-tighter text-on-surface">
              {isMe ? (
                <>
                  YOUR <span className="text-primary italic">DOSSIER</span>
                </>
              ) : (
                <>
                  <span className="text-primary italic">{shortAddr(wallet, 6, 6)}</span>
                </>
              )}
            </h1>
            <a
              href={accountExplorer(wallet)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[11px] text-primary/60 hover:text-primary mt-1 inline-block break-all"
            >
              {wallet}
            </a>
          </div>
        </div>
      </div>

      {!stats && (
        <div className="bg-surface-container-low border border-outline-variant/10 stealth-card p-12 text-center mb-8">
          <span
            className="material-symbols-outlined text-on-surface-variant/40 mi"
            style={{ fontSize: 48 }}
          >
            casino
          </span>
          <p className="font-headline text-sm font-bold tracking-widest uppercase text-on-surface mt-4 mb-2">
            No on-chain stats yet
          </p>
          <p className="text-xs text-on-surface-variant">
            {isMe
              ? "Play your first game to populate your dossier."
              : "This operative hasn't played yet."}
          </p>
          {isMe && (
            <Link
              href="/play"
              className="inline-block mt-6 bg-gradient-to-r from-primary to-primary-container text-on-primary px-8 py-3 font-headline text-xs font-black tracking-widest hover:brightness-110 active:scale-95"
            >
              ENGAGE FIRST GAME
            </Link>
          )}
        </div>
      )}

      {stats && (
        <>
          {/* KPI grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <Card
              label="Games"
              value={gamesPlayed.toString()}
              border="border-primary"
              valColor="text-primary"
            />
            <Card
              label="Win rate"
              value={`${winRate.toFixed(1)}%`}
              border="border-secondary"
              valColor="text-secondary"
            />
            <Card
              label="Net PnL"
              value={`${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(3)} SOL`}
              border={netPnl >= 0 ? "border-emerald" : "border-error"}
              valColor={netPnl >= 0 ? "text-emerald" : "text-error"}
            />
            <Card
              label="Biggest win"
              value={`${biggestWin.toFixed(3)} SOL`}
              border="border-amber"
              valColor="text-amber"
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6">
            {/* Lifetime stats panel */}
            <div className="bg-surface-container-low border border-outline-variant/10 stealth-card p-6">
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface mb-4">
                Lifetime stats
              </h2>
              <div className="space-y-2.5">
                <Row
                  label="Games played"
                  value={gamesPlayed.toString()}
                  color="text-on-surface"
                />
                <Row label="Games won" value={gamesWon.toString()} color="text-secondary" />
                <Row
                  label="Win rate"
                  value={`${winRate.toFixed(2)}%`}
                  color="text-secondary"
                />
                <Row
                  label="Total wagered"
                  value={`${totalWagered.toFixed(3)} SOL`}
                  color="text-on-surface"
                />
                <Row
                  label="Total won"
                  value={`${totalPayouts.toFixed(3)} SOL`}
                  color="text-primary"
                />
                <Row
                  label="Net PnL"
                  value={`${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(3)} SOL`}
                  color={netPnl >= 0 ? "text-emerald" : "text-error"}
                />
                <Row
                  label="Biggest win"
                  value={`${biggestWin.toFixed(3)} SOL`}
                  color="text-amber"
                />
                <Row
                  label="Biggest multiplier"
                  value={`${biggestMult.toFixed(2)}×`}
                  color="text-tertiary"
                />
                <Row
                  label="Current streak"
                  value={currentStreak.toString()}
                  color={currentStreak > 0 ? "text-emerald" : "text-on-surface-variant"}
                />
                <Row label="Best streak" value={bestStreak.toString()} color="text-amber" />
                <Row
                  label="Last played"
                  value={lastPlayed ? lastPlayed.toLocaleString() : "—"}
                  color="text-on-surface-variant"
                />
              </div>

              {/* Recent activity for this wallet, sourced from on-chain
                  settle events indexed into the public database. */}
              {myGames.length > 0 && (
                <>
                  <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface mt-8 mb-4">
                    Recent activity
                  </h3>
                  <div className="space-y-1">
                    {myGames.map((g) => (
                      <div
                        key={`${g.gameId}-${g.timestamp}`}
                        className="grid grid-cols-5 gap-2 items-center py-2 border-b border-outline-variant/[0.04]"
                      >
                        <span className="font-headline text-[10px] text-on-surface-variant uppercase tracking-widest">
                          {g.won ? "WIN" : "LOSS"}
                        </span>
                        <span className="font-headline text-xs text-on-surface">
                          {g.bet.toFixed(3)} SOL
                        </span>
                        <span
                          className={`font-headline text-xs font-bold ${g.won ? "text-primary" : "text-on-surface-variant"}`}
                        >
                          ×{g.won ? g.multiplier.toFixed(2) : "0.00"}
                        </span>
                        <span
                          className={`font-headline text-xs font-bold ${g.won ? "text-primary" : "text-error"}`}
                        >
                          {g.won ? "+" : "-"}
                          {(g.won ? g.payout : g.bet).toFixed(3)} SOL
                        </span>
                        <span className="text-right">
                          {g.txHash ? (
                            <a
                              href={txExplorer(g.txHash)}
                              target="_blank"
                              rel="noreferrer"
                              className="material-symbols-outlined text-on-surface-variant/40 hover:text-primary"
                              style={{ fontSize: 16 }}
                            >
                              visibility
                            </a>
                          ) : (
                            <span className="text-on-surface-variant/20">—</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Sidebar: referral status */}
            <div className="space-y-4">
              <div className="bg-surface-container-low border border-outline-variant/10 p-5">
                <h3 className="font-headline text-xs font-bold tracking-widest text-on-surface uppercase mb-3">
                  Referrer
                </h3>
                {stats.referrer ? (
                  <a
                    href={`/profile/${stats.referrer.toBase58()}`}
                    className="block bg-surface-container-lowest p-3 hover:bg-surface-container-highest transition-colors"
                  >
                    <div className="font-headline text-[10px] text-on-surface-variant/40 tracking-widest uppercase mb-1">
                      Locked
                    </div>
                    <div className="font-mono text-[11px] text-primary break-all">
                      {shortAddr(stats.referrer.toBase58(), 8, 6)}
                    </div>
                  </a>
                ) : (
                  <p className="text-xs text-on-surface-variant">No referrer set.</p>
                )}
              </div>

              {referral && (
                <div className="bg-gradient-to-br from-primary/5 to-secondary-container/5 border border-primary/10 p-5">
                  <h3 className="font-headline text-xs font-bold tracking-widest text-primary uppercase mb-3">
                    Referral activity
                  </h3>
                  <div className="space-y-2">
                    <Row
                      label="Tier"
                      value={REFERRAL_TIER_LABELS[referral.tier] ?? "Bronze"}
                      color={
                        referral.tier === 2
                          ? "text-amber"
                          : referral.tier === 1
                            ? "text-on-surface-variant"
                            : "text-primary"
                      }
                    />
                    <Row
                      label="Operatives"
                      value={referral.referredCount.toString()}
                      color="text-secondary"
                    />
                    <Row
                      label="Volume"
                      value={`${(Number(referral.referredVolume) / LAMPORTS_PER_SOL).toFixed(2)} SOL`}
                      color="text-on-surface"
                    />
                    <Row
                      label="Earned"
                      value={`${(Number(referral.totalEarned) / LAMPORTS_PER_SOL).toFixed(4)} SOL`}
                      color="text-primary"
                    />
                    <Row
                      label="Unclaimed"
                      value={`${(Number(referral.accruedLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL`}
                      color="text-emerald"
                    />
                  </div>
                  {isMe && (
                    <Link
                      href="/referrals"
                      className="block text-center mt-3 py-2 border border-primary/30 font-headline text-[10px] font-bold tracking-widest text-primary hover:bg-primary/10"
                    >
                      MANAGE REFERRALS
                    </Link>
                  )}
                </div>
              )}

              {isMe && (
                <div className="bg-surface-container-low border border-outline-variant/10 p-5">
                  <h3 className="font-headline text-xs font-bold tracking-widest text-on-surface uppercase mb-3">
                    Quick actions
                  </h3>
                  <Link
                    href="/play"
                    className="block text-center py-3 mb-2 bg-gradient-to-r from-primary to-primary-container text-on-primary font-headline font-bold text-xs tracking-widest hover:brightness-110"
                  >
                    PLAY
                  </Link>
                  <Link
                    href="/logs"
                    className="block text-center py-2.5 border border-outline-variant/15 font-headline text-[10px] font-bold tracking-widest text-on-surface-variant hover:bg-surface-container-highest"
                  >
                    FULL COMBAT LOG
                  </Link>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Card({
  label,
  value,
  border,
  valColor,
}: {
  label: string;
  value: string;
  border: string;
  valColor: string;
}) {
  return (
    <div
      className={`bg-surface-container-low p-4 border border-outline-variant/10 stealth-card border-l-4 ${border}`}
    >
      <div className="font-headline text-[10px] text-on-surface-variant uppercase tracking-widest">
        {label}
      </div>
      <div className={`font-headline text-xl font-bold ${valColor}`}>{value}</div>
    </div>
  );
}

function Row({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex justify-between py-1.5 border-b border-outline-variant/[0.05]">
      <span className="text-xs text-on-surface-variant/70">{label}</span>
      <span className={`text-xs font-bold ${color}`}>{value}</span>
    </div>
  );
}
