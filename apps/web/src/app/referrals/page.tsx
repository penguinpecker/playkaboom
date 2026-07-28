"use client";
import { useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useQueryClient } from "@tanstack/react-query";
import {
  GOLD_VOLUME_LAMPORTS,
  REFERRAL_BRONZE_BPS,
  REFERRAL_GOLD_BPS,
  REFERRAL_SILVER_BPS,
  REFERRAL_TIER_LABELS,
  SILVER_VOLUME_LAMPORTS,
} from "@playkaboom/shared";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useAccount } from "@/lib/compat";
import { usePlayerStats } from "@/hooks/use-player-stats";
import {
  getPendingReferrer,
  useReferralAccount,
  useReferralActions,
  useReferralCapture,
} from "@/hooks/use-referral";
import { useToast } from "@/hooks/useToast";
import { shortAddr } from "@/lib/format";

export default function ReferralsPage() {
  const { address, isConnected } = useAccount();
  const captured = useReferralCapture();
  const { toast } = useToast();
  const { claim } = useReferralActions();

  const { data: myReferral } = useReferralAccount(address);
  const { data: stats } = usePlayerStats(address);

  const [submitting, setSubmitting] = useState<"set" | "claim" | null>(null);
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const [refCode, setRefCode] = useState<string | null>(null);
  const [refClicks, setRefClicks] = useState<number | null>(null);
  const [refSignups, setRefSignups] = useState<number | null>(null);
  const [refConfirmed, setRefConfirmed] = useState<number | null>(null);
  type RefereeRow = {
    player: string;
    gamesPlayed: string;
    totalWagered: string;
    totalPayouts: string;
    lastPlayedUnix: number;
  };
  const [referees, setReferees] = useState<RefereeRow[] | null>(null);
  const { getAccessToken } = usePrivy();

  useEffect(() => {
    setPendingRef(getPendingReferrer());
  }, [captured]);

  const qc = useQueryClient();

  // Fetch (or mint) the wallet's short code. PrivyAuthBridge prefetches
  // this query on first authentication via useReferralCodePrefetch — so
  // by the time the user navigates here, the cache is usually warm and
  // we render the link immediately. Falls through to a fresh fetch if
  // the cache is empty (direct page load before the prefetch resolves).
  useEffect(() => {
    if (!address) {
      setRefCode(null);
      setRefClicks(null);
      setRefSignups(null);
      setRefConfirmed(null);
      return;
    }
    let cancelled = false;
    type RefCodeData = {
      code: string;
      clickCount: number;
      signupCount: number;
      confirmedCount: number;
    };
    // Synchronous cache read — populated by useReferralCodePrefetch.
    const cached = qc.getQueryData<RefCodeData>(["ref-code", address]);
    if (cached) {
      setRefCode(cached.code);
      setRefClicks(cached.clickCount);
      setRefSignups(cached.signupCount);
      setRefConfirmed(cached.confirmedCount);
      return;
    }
    void (async () => {
      try {
        const data = await qc.fetchQuery<RefCodeData>({
          queryKey: ["ref-code", address],
          staleTime: 5 * 60_000,
          queryFn: async () => {
            const token = await getAccessToken();
            if (!token) throw new Error("no auth");
            const res = await fetch(`/api/ref/code/${address}`, {
              headers: { Authorization: `Bearer ${token}` },
              cache: "no-store",
            });
            if (!res.ok) throw new Error(`ref-code ${res.status}`);
            return (await res.json()) as RefCodeData;
          },
        });
        if (cancelled) return;
        setRefCode(data.code);
        setRefClicks(data.clickCount);
        setRefSignups(data.signupCount);
        setRefConfirmed(data.confirmedCount);
      } catch {
        if (!cancelled) setRefClicks(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, getAccessToken, qc]);

  // Fetch the wallet's on-chain referees list. Scans PlayerStats via
  // getProgramAccounts so the result is ground-truth, not Supabase-funnel
  // dependent. Auth-gated (only the wallet owner can pull their list).
  useEffect(() => {
    if (!address) {
      setReferees(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;
        const res = await fetch(`/api/ref/referees/${address}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`referees ${res.status}`);
        const data = (await res.json()) as { referees: RefereeRow[] };
        if (!cancelled) setReferees(data.referees);
      } catch {
        if (!cancelled) setReferees([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, getAccessToken]);

  // refCodeLoading: while the /api/ref/code/<wallet> call is in flight we
  // render a placeholder rather than the legacy ?ref=<addr> form, which
  // looked terrible flickering on screen for ~500ms before being replaced
  // by the short link. We only fall back to the long form if the API
  // outright errors (refCode stays null after the request settles).
  const refCodeLoading = !!address && refClicks === null && refCode === null;
  const myLink = (() => {
    if (!address || refCodeLoading) return "";
    const origin =
      typeof window === "undefined" ? "https://playkaboom.gg" : window.location.origin;
    if (refCode) return `${origin}/r/${refCode}`;
    // Hard fallback: API returned an error (table missing, network 500).
    // The legacy ?ref= path is still wired to set the referrer in
    // localStorage, so the share link remains functional even if the
    // server-side mapping is unavailable.
    return `${origin}/?ref=${address}`;
  })();

  const tier = myReferral?.tier ?? 0;
  const tierLabel = REFERRAL_TIER_LABELS[tier] ?? REFERRAL_TIER_LABELS[0];
  const accrued = myReferral ? Number(myReferral.accruedLamports) / LAMPORTS_PER_SOL : 0;
  const totalEarned = myReferral ? Number(myReferral.totalEarned) / LAMPORTS_PER_SOL : 0;
  const referredCount = myReferral?.referredCount ?? 0;
  const referredVolume = myReferral
    ? Number(myReferral.referredVolume) / LAMPORTS_PER_SOL
    : 0;

  const tierBps =
    tier === 2 ? REFERRAL_GOLD_BPS : tier === 1 ? REFERRAL_SILVER_BPS : REFERRAL_BRONZE_BPS;
  // Quote the rate as a share of the BET, which is what the program actually
  // guarantees: settle_game credits mul_div_floor(bet, tier_bps, 10_000).
  // The old copy divided by a hardcoded 200 to express it as a share of the
  // house edge — true only while house_edge_bps happens to be 200, and
  // update_vault permits up to 1000, at which point the advertised figure
  // would have been silently wrong by 5x. The edge is not read on this page,
  // so it is not claimed here.
  const tierPctOfBet = tierBps / 100;

  const nextThreshold =
    tier === 0
      ? Number(SILVER_VOLUME_LAMPORTS) / LAMPORTS_PER_SOL
      : tier === 1
        ? Number(GOLD_VOLUME_LAMPORTS) / LAMPORTS_PER_SOL
        : null;
  const progressPct = nextThreshold
    ? Math.min(100, (referredVolume / nextThreshold) * 100)
    : 100;

  const handleCopy = () => {
    if (!myLink) return;
    navigator.clipboard?.writeText(myLink);
    toast("Referral link copied!", "emerald");
  };

  const handleClaim = async () => {
    if (accrued <= 0) return;
    setSubmitting("claim");
    try {
      const sig = await claim();
      toast(`Claimed ${accrued.toFixed(4)} SOL — tx ${sig.slice(0, 8)}…`, "emerald");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Claim failed", "error");
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="px-6 lg:px-8 pb-16 min-h-screen">
      {/* Header */}
      <div className="flex justify-between items-end mb-8">
        <div>
          <p className="font-headline text-[10px] tracking-[.12em] text-on-surface-variant flex items-center gap-1 mb-1">
            <span className="status-dot" />REFERRAL PROGRAM // ON-CHAIN
          </p>
          <h1 className="font-headline text-4xl font-black italic tracking-tighter text-on-surface">
            EARN <span className="text-primary italic">RAKEBACK</span>
          </h1>
          <p className="font-body text-sm text-on-surface-variant mt-2 max-w-xl">
            0.50–0.70% of every bet your referrals place — win or lose. Paid into your on-chain ReferralAccount, claim anytime.
          </p>
        </div>
      </div>

      {!isConnected ? (
        <div className="bg-surface-container-low border border-outline-variant/10 p-12 text-center">
          <span
            className="material-symbols-outlined text-on-surface-variant/40 mi"
            style={{ fontSize: 48 }}
          >
            account_balance_wallet
          </span>
          <p className="font-headline text-sm font-bold tracking-widest uppercase text-on-surface mt-4 mb-2">
            Connect to start earning
          </p>
          <p className="text-xs text-on-surface-variant">
            Once connected, you'll get a unique referral link.
          </p>
        </div>
      ) : (
        <>
          {/* Referrer prompt removed 2026-05-16 — set_referrer is now
              auto-bundled into the player's first start_game (see
              apps/web/src/hooks/use-game-actions.ts:336). No confirm
              step is required; the referrer is locked in atomically
              with the first game on chain. The legacy "Accept Referrer"
              button + handleSetReferrer handler were removed in the
              same commit. */}

          {/* My referral link */}
          <div className="bg-surface-container-low border border-outline-variant/10 stealth-card p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface">
                Your referral link
              </h2>
              {refClicks != null && (
                <div className="flex gap-3 font-headline text-[10px] uppercase tracking-widest">
                  <span className="text-on-surface-variant">
                    <span className="text-secondary font-bold">{refSignups ?? 0}</span> signups
                  </span>
                  <span className="text-on-surface-variant/60">→</span>
                  <span className="text-on-surface-variant">
                    <span className="text-emerald font-bold">{refConfirmed ?? 0}</span> confirmed
                  </span>
                </div>
              )}
            </div>
            <div className="flex gap-2 mb-3">
              {refCodeLoading ? (
                <div className="flex-1 bg-surface-container-lowest h-[42px] animate-pulse" />
              ) : (
                <input
                  value={myLink}
                  readOnly
                  className="flex-1 bg-surface-container-lowest font-mono text-[11px] text-primary px-3 py-2.5 outline-none border-none"
                />
              )}
              <button
                onClick={handleCopy}
                disabled={refCodeLoading}
                className="bg-gradient-to-r from-primary to-primary-container text-on-primary px-5 font-headline text-xs font-bold tracking-widest hover:brightness-110 active:scale-95 disabled:opacity-50"
              >
                COPY
              </button>
            </div>
            <p className="text-[10px] text-on-surface-variant/60">
              Share this link. The referrer is set automatically when your invitee plays their first game — no confirmation step. Rakeback starts accruing immediately.
              {refCode && (
                <>
                  {" "}Code <span className="text-primary font-mono">{refCode}</span> — only you can claim it (signed wallet bearer required).
                </>
              )}
            </p>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <Card label="Tier" value={tierLabel} valColor={tierColor(tier)} border={tierBorder(tier)} />
            <Card
              label="Accrued"
              value={`${accrued.toFixed(4)} SOL`}
              valColor="text-primary"
              border="border-primary"
            />
            <Card
              label="Total earned"
              value={`${totalEarned.toFixed(4)} SOL`}
              valColor="text-secondary"
              border="border-secondary"
            />
            <Card
              label="Referred"
              value={`${referredCount} ops`}
              valColor="text-tertiary"
              border="border-tertiary"
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6">
            {/* Tier ladder + claim */}
            <div className="bg-surface-container-low border border-outline-variant/10 p-6 stealth-card">
              <h2 className="font-headline text-xs font-bold tracking-widest text-on-surface uppercase mb-4">
                Tier progress
              </h2>
              <div className="mb-3">
                <div className="flex justify-between mb-2 text-[10px] font-headline uppercase tracking-widest">
                  <span className="text-on-surface-variant">
                    Referred volume: {referredVolume.toFixed(2)} SOL
                  </span>
                  {nextThreshold && (
                    <span className={tierColor(tier + 1)}>
                      Next: {nextThreshold.toFixed(0)} SOL → {REFERRAL_TIER_LABELS[tier + 1]}
                    </span>
                  )}
                </div>
                <div className="h-3 bg-surface-container-highest rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-primary to-primary-container transition-all"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 mt-6">
                <TierBox
                  label="BRONZE"
                  rate="0.50% / bet"
                  threshold="0+ SOL"
                  active={tier === 0}
                  reached={tier >= 0}
                />
                <TierBox
                  label="SILVER"
                  rate="0.60% / bet"
                  threshold="10+ SOL"
                  active={tier === 1}
                  reached={tier >= 1}
                />
                <TierBox
                  label="GOLD"
                  rate="0.70% / bet"
                  threshold="100+ SOL"
                  active={tier === 2}
                  reached={tier >= 2}
                />
              </div>

              <div className="mt-6 flex justify-between items-center bg-surface-container-lowest/50 p-4 border-l-4 border-emerald">
                <div>
                  <div className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
                    Current rate
                  </div>
                  <div className="font-headline font-bold text-emerald text-lg">
                    {tierPctOfBet.toFixed(2)}% of every bet
                  </div>
                </div>
                <button
                  onClick={handleClaim}
                  disabled={accrued <= 0 || submitting === "claim"}
                  className="border-2 border-emerald text-emerald font-headline font-black text-xs tracking-widest px-6 py-3 hover:bg-emerald/10 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {submitting === "claim"
                    ? "CLAIMING..."
                    : accrued > 0
                      ? `CLAIM ${accrued.toFixed(4)} SOL`
                      : "NOTHING TO CLAIM"}
                </button>
              </div>
            </div>

            {/* Sidebar: my referrer + how it works */}
            <div className="space-y-4">
              <div className="bg-surface-container-low border border-outline-variant/10 p-5">
                <h3 className="font-headline text-xs font-bold tracking-widest text-on-surface uppercase mb-3">
                  Your referrer
                </h3>
                {stats?.referrer ? (
                  <div className="bg-surface-container-lowest p-3">
                    <div className="font-headline text-[10px] text-on-surface-variant/40 tracking-widest uppercase mb-1">
                      Locked
                    </div>
                    <div className="font-mono text-[11px] text-primary break-all">
                      {stats.referrer.toBase58()}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-on-surface-variant">
                    None set. If a friend invited you, accept their link above.
                  </p>
                )}
              </div>

              <div className="bg-surface-container-low border border-outline-variant/10 p-5">
                <h3 className="font-headline text-xs font-bold tracking-widest text-on-surface uppercase mb-3">
                  How it works
                </h3>
                <ol className="text-xs text-on-surface-variant space-y-2 list-decimal list-inside">
                  <li>Share your link.</li>
                  <li>Friend connects and accepts (one-time, on-chain).</li>
                  <li>Every settled game they play — win or lose — credits you {tierPctOfBet.toFixed(2)}% of their bet.</li>
                  <li>Cuts accrue in your ReferralAccount PDA — claim anytime.</li>
                  <li>Hit volume thresholds to upgrade tier.</li>
                </ol>
              </div>
            </div>
          </div>

          {/* Referees list — on-chain ground truth via PlayerStats scan */}
          <div className="bg-surface-container-low border border-outline-variant/10 stealth-card p-6 mt-6">
            <h2 className="font-headline text-xs font-bold tracking-widest text-on-surface uppercase mb-4">
              Your referees{referees ? ` (${referees.length})` : ""}
            </h2>
            {referees == null ? (
              <div className="font-mono text-xs text-on-surface-variant/60">Loading…</div>
            ) : referees.length === 0 ? (
              <div className="font-mono text-xs text-on-surface-variant/60">
                No referees yet. Share your link above — referees show up here as soon as they complete <code>set_referrer</code> on-chain.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left font-headline text-[10px] uppercase tracking-widest text-on-surface-variant/70 border-b border-outline-variant/10">
                      <th className="py-2 pr-3">Wallet</th>
                      <th className="py-2 pr-3 text-right">Games</th>
                      <th className="py-2 pr-3 text-right">Wagered (SOL)</th>
                      <th className="py-2 pr-3 text-right">Payouts (SOL)</th>
                      <th className="py-2 text-right">Last played</th>
                    </tr>
                  </thead>
                  <tbody>
                    {referees.map((r) => {
                      const wageredSol = Number(BigInt(r.totalWagered)) / LAMPORTS_PER_SOL;
                      const payoutsSol = Number(BigInt(r.totalPayouts)) / LAMPORTS_PER_SOL;
                      const last = r.lastPlayedUnix > 0
                        ? formatRelativeAgo(Date.now() / 1000 - r.lastPlayedUnix)
                        : "never";
                      return (
                        <tr key={r.player} className="border-b border-outline-variant/5 last:border-b-0">
                          <td className="py-2 pr-3 font-mono text-on-surface">{shortAddr(r.player)}</td>
                          <td className="py-2 pr-3 font-mono text-right text-on-surface-variant">{r.gamesPlayed}</td>
                          <td className="py-2 pr-3 font-mono text-right text-primary">{wageredSol.toFixed(4)}</td>
                          <td className="py-2 pr-3 font-mono text-right text-secondary">{payoutsSol.toFixed(4)}</td>
                          <td className="py-2 font-mono text-right text-on-surface-variant/70">{last}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function formatRelativeAgo(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function tierColor(tier: number): string {
  return tier === 2 ? "text-amber" : tier === 1 ? "text-on-surface-variant" : "text-primary";
}
function tierBorder(tier: number): string {
  return tier === 2
    ? "border-amber"
    : tier === 1
      ? "border-on-surface-variant"
      : "border-primary";
}

function Card({
  label,
  value,
  valColor,
  border,
}: {
  label: string;
  value: string;
  valColor: string;
  border: string;
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

function TierBox({
  label,
  rate,
  threshold,
  active,
  reached,
}: {
  label: string;
  rate: string;
  threshold: string;
  active: boolean;
  reached: boolean;
}) {
  return (
    <div
      className={`p-3 border ${
        active
          ? "bg-emerald/5 border-emerald/30"
          : reached
            ? "bg-primary/5 border-primary/15"
            : "bg-surface-container-lowest border-outline-variant/10"
      }`}
    >
      <div
        className={`font-headline text-[10px] font-bold tracking-widest mb-1 ${
          active ? "text-emerald" : reached ? "text-primary" : "text-on-surface-variant/40"
        }`}
      >
        {label} {active && "← YOU"}
      </div>
      <div className="font-headline text-sm font-bold text-on-surface">{rate}</div>
      <div className="font-headline text-[9px] text-on-surface-variant/40 mt-1 uppercase">
        {threshold}
      </div>
    </div>
  );
}
