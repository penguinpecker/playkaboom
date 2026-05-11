"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { txExplorer, accountExplorer } from "@/lib/cluster";

interface GameRow {
  signature: string;
  player: string | null;
  bet: number | null;
  mine_count: number | null;
  outcome: "won" | "lost" | "expired" | null;
  payout: number | null;
  multiplier_bps: number | null;
  safe_reveals: number | null;
  mine_layout: number | null;
  settled_layout: number | null;
  commitment: string | null;
  salt: string | null;
  settled_at: string;
  slot: number;
  /** Chain-direct verification flag. true ONLY when the server re-fetched
   *  the settle tx from RPC and SHA-256 matched on-chain. */
  verified: boolean;
  /** "chain" if a settle event was found+verified, "pending" if still
   *  waiting for settle (cashout-only). */
  verifySource: "chain" | "pending";
}

interface VerifyResponse {
  found: boolean;
  game?: GameRow;
  /** "input" = caller passed a settle sig directly. "lookup" = caller passed
   *  a cashout sig and the indexer's settle_signature pointer resolved it.
   *  "missing" = no settle event observed yet. */
  settleSource?: "input" | "lookup" | "missing";
  warning?: string;
}

export default function VerifyPage() {
  const params = useParams<{ sig: string }>();
  const sig = params.sig;
  const [data, setData] = useState<VerifyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/verify?sig=${encodeURIComponent(sig)}`)
      .then((r) => r.json() as Promise<VerifyResponse>)
      .then((j) => {
        if (!cancelled) setData(j);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Fetch failed");
      });
    return () => {
      cancelled = true;
    };
  }, [sig]);

  // Trust the chain-direct flag set by the server (which re-fetched the
  // settle event from RPC and ran SHA-256 there). No DB-cached recomputation.
  // verifySource "pending" → settle not yet observed, show pending state.
  const verified: boolean | null = !data?.found || !data.game
    ? null
    : data.game.verifySource === "pending"
      ? null
      : data.game.verified;

  return (
    <div className="px-6 lg:px-8 pb-16 min-h-screen kinetic-grid">
      <div className="mb-8">
        <p className="font-headline text-[10px] tracking-[.12em] text-on-surface-variant flex items-center gap-1 mb-1">
          <span className="status-dot" />PROVABLE FAIRNESS // PUBLIC VERIFIER
        </p>
        <h1 className="font-headline text-4xl font-black italic tracking-tighter text-on-surface">
          VERIFY <span className="text-primary italic">GAME</span>
        </h1>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 p-4 text-error text-xs font-mono mb-6">
          {error}
        </div>
      )}

      {!data && !error && (
        <div className="bg-surface-container-low border border-outline-variant/10 p-12 text-center">
          <p className="font-headline text-xs tracking-widest uppercase text-on-surface-variant">
            Loading…
          </p>
        </div>
      )}

      {data?.found === false && (
        <div className="bg-surface-container-low border border-outline-variant/10 p-12 text-center">
          <span
            className="material-symbols-outlined text-on-surface-variant/40 mi"
            style={{ fontSize: 48 }}
          >
            search_off
          </span>
          <p className="font-headline text-sm font-bold tracking-widest uppercase text-on-surface mt-4 mb-2">
            Signature not indexed
          </p>
          <p className="text-xs text-on-surface-variant mb-1 font-mono break-all">{sig}</p>
          <p className="text-xs text-on-surface-variant">
            The indexer hasn't recorded this game yet. Try again in a few seconds, or check the
            on-chain transaction directly.
          </p>
          <a
            href={txExplorer(sig)}
            target="_blank"
            rel="noreferrer"
            className="inline-block mt-6 border border-primary/30 px-5 py-2.5 font-headline text-[10px] font-bold tracking-widest text-primary hover:bg-primary/10"
          >
            VIEW ON SOLSCAN
          </a>
        </div>
      )}

      {data?.found && data.game && (
        <Verified game={data.game} verified={verified} sig={sig} />
      )}

      <div className="mt-8 text-center">
        <Link
          href="/leaderboard"
          className="font-headline text-[10px] text-on-surface-variant/40 hover:text-primary tracking-widest uppercase"
        >
          ← BACK TO LEADERBOARD
        </Link>
      </div>
    </div>
  );
}

function Verified({
  game,
  verified,
  sig,
}: {
  game: GameRow;
  verified: boolean | null;
  sig: string;
}) {
  const status =
    verified === true ? "verified" : verified === false ? "mismatch" : "pending";
  const banner =
    status === "verified"
      ? {
          color: "border-emerald bg-emerald/5 text-emerald",
          icon: "verified",
          title: "VERIFIED",
          body: "SHA-256 of (layout || mine_count || salt) matches the on-chain commitment, both fetched directly from Solana RPC. House did not cheat.",
        }
      : status === "mismatch"
        ? {
            color: "border-error bg-error/5 text-error",
            icon: "report",
            title: "MISMATCH",
            body: "Hash does not match commitment. Report this immediately — chain disagrees with the published proof.",
          }
        : {
            color: "border-amber bg-amber/5 text-amber",
            icon: "schedule",
            title: "PENDING",
            body: "Settle event not observed yet for this game. If you just won/cashed out, give the house signer a few seconds to publish the salt.",
          };

  return (
    <>
      <div className={`border p-6 mb-6 flex items-start gap-4 ${banner.color}`}>
        <span className="material-symbols-outlined mi" style={{ fontSize: 48 }}>
          {banner.icon}
        </span>
        <div>
          <h2 className="font-headline text-2xl font-black italic tracking-tighter mb-1">
            {banner.title}
          </h2>
          <p className="font-body text-sm">{banner.body}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6">
        {/* Proof inputs */}
        <div className="bg-surface-container-low border border-outline-variant/10 stealth-card p-6">
          <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface mb-4">
            Proof inputs
          </h3>
          <Field label="Signature" mono href={txExplorer(sig)} value={sig} />
          <Field
            label="Player"
            mono
            href={game.player ? `/profile/${game.player}` : undefined}
            value={game.player ?? "—"}
          />
          <Field
            label="Mine count"
            value={game.mine_count !== null ? game.mine_count.toString() : "— (settle pending)"}
          />
          <Field
            label="Mine layout (u16)"
            mono
            value={
              game.settled_layout !== null
                ? `0x${game.settled_layout.toString(16).padStart(4, "0")}  (${game.settled_layout.toString(2).padStart(16, "0")})`
                : "— (settle pending)"
            }
          />
          <Field label="Salt (hex)" mono value={game.salt ?? "— (settle pending)"} />
          <Field
            label="Commitment (hex)"
            mono
            value={game.commitment ?? "— (settle pending)"}
          />

          <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface mt-8 mb-4">
            Verification
          </h3>
          <div className="bg-surface-container-lowest p-4 font-mono text-[11px] text-on-surface-variant">
            <div>
              <span className="text-primary">computed</span> = SHA256(
              <span className="text-tertiary">layout_le</span> ‖{" "}
              <span className="text-tertiary">mine_count</span> ‖{" "}
              <span className="text-tertiary">salt</span>)
            </div>
            <div className="mt-1">
              <span className="text-primary">expected</span> = on-chain commitment
            </div>
            <div className="mt-3">
              <span
                className={
                  status === "verified"
                    ? "text-emerald"
                    : status === "mismatch"
                      ? "text-error"
                      : "text-amber"
                }
              >
                {status === "verified"
                  ? "✓ computed.equals(expected)"
                  : status === "mismatch"
                    ? "✗ computed != expected"
                    : "… awaiting settle"}
              </span>
            </div>
          </div>
        </div>

        {/* Game outcome */}
        <div className="space-y-4">
          <div className="bg-surface-container-low border border-outline-variant/10 p-5">
            <h3 className="font-headline text-xs font-bold uppercase tracking-widest text-on-surface mb-3">
              Outcome
            </h3>
            <Row
              label="Result"
              value={game.outcome?.toUpperCase() ?? "—"}
              color={
                game.outcome === "won"
                  ? "text-primary"
                  : game.outcome === "lost"
                    ? "text-error"
                    : "text-on-surface-variant"
              }
            />
            <Row
              label="Bet"
              value={
                game.bet !== null ? `${(game.bet / LAMPORTS_PER_SOL).toFixed(4)} SOL` : "—"
              }
              color="text-on-surface"
            />
            <Row
              label="Payout"
              value={
                game.payout !== null
                  ? `${(game.payout / LAMPORTS_PER_SOL).toFixed(4)} SOL`
                  : "—"
              }
              color="text-primary"
            />
            <Row
              label="Multiplier"
              value={
                game.multiplier_bps !== null
                  ? `${(game.multiplier_bps / 10_000).toFixed(2)}×`
                  : "—"
              }
              color="text-secondary"
            />
            <Row
              label="Safe reveals"
              value={game.safe_reveals !== null ? game.safe_reveals.toString() : "—"}
              color="text-tertiary"
            />
            <Row
              label="Slot"
              value={game.slot.toString()}
              color="text-on-surface-variant"
            />
            <Row
              label="Settled at"
              value={new Date(game.settled_at).toLocaleString()}
              color="text-on-surface-variant"
            />
          </div>

          {game.player && (
            <a
              href={accountExplorer(game.player)}
              target="_blank"
              rel="noreferrer"
              className="block text-center py-3 border border-primary/30 font-headline text-[10px] font-bold tracking-widest text-primary hover:bg-primary/10"
            >
              VIEW PLAYER ON-CHAIN
            </a>
          )}
        </div>
      </div>
    </>
  );
}

function Field({
  label,
  value,
  mono,
  href,
}: {
  label: string;
  value: string;
  mono?: boolean;
  href?: string | undefined;
}) {
  const cls = `${mono ? "font-mono" : "font-body"} text-[11px] text-primary break-all`;
  return (
    <div className="mb-3">
      <div className="font-headline text-[10px] text-on-surface-variant/40 tracking-widest uppercase mb-1">
        {label}
      </div>
      <div className="bg-surface-container-lowest p-2.5">
        {href ? (
          <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className={`${cls} hover:underline`}>
            {value}
          </a>
        ) : (
          <span className={cls}>{value}</span>
        )}
      </div>
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
