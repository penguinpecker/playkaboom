"use client";
import { useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
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
  const { setReferrer, claim } = useReferralActions();

  const { data: myReferral } = useReferralAccount(address);
  const { data: stats } = usePlayerStats(address);

  const [submitting, setSubmitting] = useState<"set" | "claim" | null>(null);
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const [refCode, setRefCode] = useState<string | null>(null);
  const [refClicks, setRefClicks] = useState<number | null>(null);
  const [refSignups, setRefSignups] = useState<number | null>(null);
  const [refConfirmed, setRefConfirmed] = useState<number | null>(null);
  const { getAccessToken } = usePrivy();

  useEffect(() => {
    setPendingRef(getPendingReferrer());
  }, [captured]);

  // Fetch (or mint) the wallet's short code. The API requires a signed
  // Privy bearer for the wallet, so this is the only place a code can be
  // claimed for `address`. Anybody else hitting GET /api/ref/code/<address>
  // gets 401 — that's the tamper-resistance.
  useEffect(() => {
    if (!address) {
      setRefCode(null);
      setRefClicks(null);
      setRefSignups(null);
      setRefConfirmed(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;
        const res = await fetch(`/api/ref/code/${address}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          code: string;
          clickCount: number;
          signupCount: number;
          confirmedCount: number;
        };
        if (!cancelled) {
          setRefCode(data.code);
          setRefClicks(data.clickCount);
          setRefSignups(data.signupCount);
          setRefConfirmed(data.confirmedCount);
        }
      } catch {
        /* silent — page still works without the short link, falls back below */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, getAccessToken]);

  const myLink = (() => {
    if (!address) return "";
    const origin =
      typeof window === "undefined" ? "https://playkaboom.gg" : window.location.origin;
    if (refCode) return `${origin}/r/${refCode}`;
    // Fallback: legacy long form. Still works because the URL handler in
    // useReferralFromURL keeps the ?ref= path. If the code endpoint is
    // down or rate-limited, the user can still share *something*.
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
  const tierEdgePct = (tierBps / 200) * 100; // bps over 2% house edge

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

  const handleSetReferrer = async () => {
    if (!pendingRef) return;
    setSubmitting("set");
    try {
      await setReferrer(pendingRef);
      toast("Referrer locked in. Welcome aboard!", "emerald");
      setPendingRef(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to set referrer", "error");
    } finally {
      setSubmitting(null);
    }
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
            25–35% of every house edge from players you bring in. Paid into your on-chain ReferralAccount, claim anytime.
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
          {/* Referrer prompt — pending from URL */}
          {pendingRef && stats?.referrer === null && (
            <div className="bg-gradient-to-br from-primary/10 to-secondary-container/10 border border-primary/20 p-6 mb-6">
              <div className="flex items-center gap-3 mb-3">
                <span
                  className="material-symbols-outlined text-primary mi"
                  style={{ fontSize: 24 }}
                >
                  link
                </span>
                <h3 className="font-headline text-sm font-bold uppercase tracking-widest text-primary">
                  You were invited
                </h3>
              </div>
              <p className="text-xs text-on-surface-variant mb-4">
                Confirm <span className="font-mono text-primary">{shortAddr(pendingRef, 6, 6)}</span> as your referrer (one-time, immutable on-chain).
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleSetReferrer}
                  disabled={submitting === "set"}
                  className="bg-gradient-to-r from-primary to-primary-container text-on-primary px-5 py-2.5 font-headline text-xs font-bold tracking-widest hover:brightness-110 active:scale-95 disabled:opacity-50"
                >
                  {submitting === "set" ? "CONFIRMING..." : "ACCEPT REFERRER"}
                </button>
                <button
                  onClick={() => {
                    if (typeof window !== "undefined")
                      localStorage.removeItem("playkaboom.referrer.v1");
                    setPendingRef(null);
                    toast("Pending referrer cleared", "amber");
                  }}
                  className="border border-outline-variant/15 px-5 py-2.5 font-headline text-xs font-bold tracking-widest text-on-surface-variant hover:bg-surface-container-highest"
                >
                  DECLINE
                </button>
              </div>
            </div>
          )}

          {/* My referral link */}
          <div className="bg-surface-container-low border border-outline-variant/10 stealth-card p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface">
                Your referral link
              </h2>
              {refClicks != null && (
                <div className="flex gap-3 font-headline text-[10px] uppercase tracking-widest">
                  <span className="text-on-surface-variant">
                    <span className="text-primary font-bold">{refClicks}</span> visits
                  </span>
                  <span className="text-on-surface-variant/60">→</span>
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
              <input
                value={myLink}
                readOnly
                className="flex-1 bg-surface-container-lowest font-mono text-[11px] text-primary px-3 py-2.5 outline-none border-none"
              />
              <button
                onClick={handleCopy}
                className="bg-gradient-to-r from-primary to-primary-container text-on-primary px-5 font-headline text-xs font-bold tracking-widest hover:brightness-110 active:scale-95"
              >
                COPY
              </button>
            </div>
            <p className="text-[10px] text-on-surface-variant/60">
              Share this link. When friends play their first game and accept you as referrer, you start accruing rakeback.
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
                  rate="25% / edge"
                  threshold="0+ SOL"
                  active={tier === 0}
                  reached={tier >= 0}
                />
                <TierBox
                  label="SILVER"
                  rate="30% / edge"
                  threshold="10+ SOL"
                  active={tier === 1}
                  reached={tier >= 1}
                />
                <TierBox
                  label="GOLD"
                  rate="35% / edge"
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
                    {(tierBps / 100).toFixed(2)}% of every bet ({tierEdgePct.toFixed(0)}% of edge)
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
                  <li>Every game they play credits you {tierEdgePct.toFixed(0)}% of the house edge.</li>
                  <li>Cuts accrue in your ReferralAccount PDA — claim anytime.</li>
                  <li>Hit volume thresholds to upgrade tier.</li>
                </ol>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
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
