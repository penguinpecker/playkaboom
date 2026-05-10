"use client";
import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  useLpActions,
  useLpPosition,
  useVaultState,
} from "@/hooks/use-vault-lp";
import { useToast } from "@/components/providers/toast";

const fmtSol = (lamports: bigint | number) =>
  (Number(typeof lamports === "bigint" ? lamports : BigInt(lamports)) /
    LAMPORTS_PER_SOL).toFixed(4);

const fmtPct = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(2)}%`;

export function VaultLpPanel() {
  const { connection } = useConnection();
  const { data: state } = useVaultState();
  const { authenticated, login, walletAddress, deposit, requestWithdraw, cancelWithdraw, completeWithdraw } = useLpActions();
  const { data: position } = useLpPosition(walletAddress);
  const { toast } = useToast();

  const [amount, setAmount] = useState("0.1");
  const [withdrawSol, setWithdrawSol] = useState("");
  const [busy, setBusy] = useState(false);
  const [currentSlot, setCurrentSlot] = useState<number | null>(null);

  // Poll the current slot every 5s so the withdraw cooldown countdown
  // actually progresses while the user has the panel open. Previously
  // this was a useMemo that ran once at mount — the countdown stayed
  // frozen for hours and the COMPLETE WITHDRAWAL button never appeared
  // (cooldownReady gate stuck at false), forcing users to hard-refresh
  // to claim their LP withdrawal. The useMemo cleanup return was also
  // dead — useMemo doesn't honor cleanup; useEffect does.
  useEffect(() => {
    let cancelled = false;
    const fetchSlot = () => {
      connection
        .getSlot("confirmed")
        .then((s) => {
          if (!cancelled) setCurrentSlot(s);
        })
        .catch(() => {});
    };
    fetchSlot();
    const i = setInterval(fetchSlot, 5_000);
    return () => {
      cancelled = true;
      clearInterval(i);
    };
  }, [connection]);

  const tvlSol = state?.vaultBalanceSol ?? 0;
  const apyLabel = state?.apy30d == null ? "—" : fmtPct(state.apy30d);
  const healthLabel = state?.healthBps != null ? `${(state.healthBps / 100).toFixed(1)}%` : "—";
  const maxDepositSol = state?.effectiveMaxUserDepositSol ?? 0;

  const positionUnits = position ? BigInt(position.units) : 0n;
  const pendingUnits = position ? BigInt(position.pendingUnits) : 0n;
  const totalUnits = positionUnits + pendingUnits;
  const valueSol = position?.currentValueSol ?? 0;
  const netDepositedSol = position ? position.netDeposited / LAMPORTS_PER_SOL : 0;
  const indexerStale = position?.indexerStale ?? false;
  const pnlSol = position?.pnlLamports == null ? null : position.pnlLamports / LAMPORTS_PER_SOL;
  const pnlPct = position?.pnlPercent ?? null;

  const unlockSlot = position ? Number(position.pendingUnlockSlot) : 0;
  const slotsLeft =
    pendingUnits > 0n && currentSlot != null
      ? Math.max(0, unlockSlot - currentSlot)
      : 0;
  const cooldownReady = pendingUnits > 0n && slotsLeft === 0;
  const cooldownLabel = (() => {
    if (pendingUnits === 0n) return null;
    if (slotsLeft === 0) return "Ready to claim";
    const seconds = slotsLeft * 0.4;
    if (seconds < 60) return `${seconds.toFixed(0)}s`;
    if (seconds < 3600) return `${(seconds / 60).toFixed(0)}m`;
    if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
    return `${(seconds / 86400).toFixed(1)}d`;
  })();

  const run = (label: string, fn: () => Promise<unknown>) => () => {
    if (!authenticated) {
      login();
      return;
    }
    setBusy(true);
    fn()
      .then((res) => {
        const sig = typeof res === "string" ? res : "";
        toast(`${label} confirmed`, "success");
        if (sig) console.log(label, "sig:", sig);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "failed";
        toast(`${label} failed: ${msg}`, "error");
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="bg-surface-container-low p-6 border border-outline-variant/10 stealth-card mt-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="font-headline text-[10px] tracking-[.12em] text-on-surface-variant flex items-center gap-1">
            <span className="status-dot bg-emerald" />
            COMMUNITY VAULT — LP POSITION
          </p>
          <h2 className="font-headline text-2xl font-black italic tracking-tighter text-on-surface mt-1">
            DEPOSIT, EARN, <span className="text-primary">SHARE THE HOUSE EDGE</span>
          </h2>
        </div>
        <div className="text-right">
          <div className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
            APY (30d)
          </div>
          <div className="font-headline text-3xl font-bold text-emerald">{apyLabel}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Stat label="TVL" value={`${tvlSol.toFixed(3)} SOL`} valColor="text-primary" />
        <Stat label="Health" value={healthLabel} valColor="text-emerald" />
        <Stat
          label="Max single deposit"
          value={`${maxDepositSol.toFixed(3)} SOL`}
          valColor="text-secondary"
        />
        <Stat
          label="Cooldown"
          value={state?.withdrawCooldownDays ? `${state.withdrawCooldownDays.toFixed(1)} days` : "—"}
          valColor="text-tertiary"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Deposit */}
        <div className="bg-surface-container-lowest p-4 border border-outline-variant/10">
          <h3 className="font-headline text-xs font-bold tracking-widest uppercase mb-3">
            Deposit
          </h3>
          <input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full bg-surface-container-low border-none font-headline font-bold text-lg text-primary px-3 py-2 mb-3 outline-none"
          />
          <button
            disabled={busy}
            onClick={run("Deposit", () => deposit(amount))}
            className="w-full py-3 bg-gradient-to-r from-primary to-primary-container text-on-primary font-headline font-bold text-xs tracking-widest disabled:opacity-50 hover:brightness-110 active:scale-95 transition-all"
          >
            {!authenticated ? "CONNECT TO DEPOSIT" : busy ? "CONFIRMING…" : "DEPOSIT SOL"}
          </button>
          <p className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant/40 mt-3">
            Min {state?.minLpDepositLamports
              ? fmtSol(BigInt(state.minLpDepositLamports))
              : "0.01"} SOL · 3-day withdraw cooldown
          </p>
        </div>

        {/* My position */}
        <div className="bg-surface-container-lowest p-4 border border-outline-variant/10">
          <h3 className="font-headline text-xs font-bold tracking-widest uppercase mb-3">
            My Position
          </h3>
          {!authenticated ? (
            <p className="font-mono text-xs text-on-surface-variant/60">
              Connect a wallet to view your position.
            </p>
          ) : (
            <div className="space-y-2">
              <Row label="Active" value={`${(Number(positionUnits) / LAMPORTS_PER_SOL).toFixed(4)} units`} />
              <Row
                label="Current value"
                value={`${valueSol.toFixed(4)} SOL`}
                valueColor="text-primary"
              />
              <Row
                label="Net deposited"
                value={indexerStale ? "indexing…" : `${netDepositedSol.toFixed(4)} SOL`}
              />
              <Row
                label="P&L"
                value={
                  pnlSol == null
                    ? "—"
                    : `${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL (${fmtPct(pnlPct)})`
                }
                valueColor={pnlSol == null ? "text-on-surface-variant/50" : pnlSol >= 0 ? "text-emerald" : "text-error"}
              />
              {indexerStale && (
                <p className="font-mono text-[10px] text-on-surface-variant/40 italic">
                  Off-chain indexer catching up; P&L will populate after the next webhook event.
                </p>
              )}
              {pendingUnits > 0n && (
                <div className="mt-3 p-3 bg-surface-container-low border border-outline-variant/10">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`status-dot ${cooldownReady ? "bg-emerald" : "bg-tertiary"}`} />
                    <div className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
                      Pending withdrawal
                    </div>
                  </div>
                  <div className="font-mono text-xs text-on-surface">
                    {(Number(pendingUnits) / LAMPORTS_PER_SOL).toFixed(4)} units ·{" "}
                    <span className={cooldownReady ? "text-emerald" : "text-tertiary"}>
                      {cooldownLabel}
                    </span>
                  </div>
                </div>
              )}
              {positionUnits > 0n && pendingUnits === 0n && (() => {
                const positionSol = (Number(positionUnits) * (state?.unitValueE18 ? Number(BigInt(state.unitValueE18)) / 1e18 : 1)) / LAMPORTS_PER_SOL;
                const inputSol = Number(withdrawSol);
                const valid = Number.isFinite(inputSol) && inputSol > 0 && inputSol <= positionSol + 1e-9;
                // Convert SOL → units: floor(amount_lamports * total_units / vault_assets).
                // We approximate with the user's local position ratio for the preview;
                // on-chain math is the source of truth.
                const wantUnits = (() => {
                  if (!valid) return 0n;
                  const ratio = Number(positionUnits) / Math.max(1, positionSol * LAMPORTS_PER_SOL);
                  return BigInt(Math.floor(inputSol * LAMPORTS_PER_SOL * ratio));
                })();
                const isFull = valid && wantUnits >= positionUnits - 1n;
                const fmtSolInput = (n: number) =>
                  n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
                return (
                  <div className="mt-4 pt-3 border-t border-outline-variant/10">
                    <div className="flex items-center justify-between mb-2">
                      <label className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
                        Withdraw amount (SOL)
                      </label>
                      <button
                        type="button"
                        onClick={() => setWithdrawSol(fmtSolInput(positionSol))}
                        className="font-headline text-[10px] uppercase tracking-widest text-primary hover:text-primary-container transition-colors"
                      >
                        MAX {positionSol.toFixed(4)}
                      </button>
                    </div>
                    <input
                      type="number"
                      step="0.001"
                      min="0"
                      max={positionSol}
                      value={withdrawSol}
                      onChange={(e) => setWithdrawSol(e.target.value)}
                      placeholder={`0.0000`}
                      className="w-full bg-surface-container-low border-none font-headline font-bold text-lg text-primary px-3 py-2 outline-none focus:ring-0"
                    />
                    <div className="grid grid-cols-3 gap-1 mt-2">
                      {[25, 50, 100].map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          onClick={() => setWithdrawSol(fmtSolInput((positionSol * pct) / 100))}
                          className="bg-surface-container-highest py-1.5 font-headline text-[10px] font-bold text-on-surface hover:bg-primary/20 transition-colors"
                        >
                          {pct}%
                        </button>
                      ))}
                    </div>
                    <button
                      disabled={busy || !valid}
                      onClick={run("Withdraw request", () =>
                        requestWithdraw(isFull ? positionUnits : wantUnits),
                      )}
                      className="w-full mt-3 py-3 bg-gradient-to-r from-primary to-primary-container text-on-primary font-headline font-bold text-xs tracking-widest hover:brightness-110 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                      title={
                        valid
                          ? `Burns ${((Number(wantUnits) / Number(positionUnits)) * 100).toFixed(1)}% of your position into a 3-day cooldown`
                          : "Enter an amount up to your position size"
                      }
                    >
                      {busy
                        ? "REQUESTING…"
                        : valid
                          ? `REQUEST WITHDRAW · ${inputSol.toFixed(4)} SOL`
                          : "ENTER AMOUNT"}
                    </button>
                    <p className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant/40 mt-3">
                      3-day cooldown · pending units keep earning P&L · cancel anytime before unlock
                    </p>
                  </div>
                );
              })()}
              {pendingUnits > 0n && !cooldownReady && (
                <button
                  disabled={busy}
                  onClick={run("Cancel withdrawal", () => cancelWithdraw())}
                  className="w-full mt-2 py-2.5 border border-outline-variant/30 text-on-surface font-headline font-bold text-xs tracking-widest hover:bg-surface-container active:scale-95 transition-all disabled:opacity-50"
                >
                  CANCEL WITHDRAWAL
                </button>
              )}
              {cooldownReady && (
                <button
                  disabled={busy}
                  onClick={run("Complete withdrawal", () => completeWithdraw())}
                  className="w-full mt-2 py-2.5 bg-emerald text-on-primary font-headline font-bold text-xs tracking-widest hover:brightness-110 active:scale-95 transition-all disabled:opacity-50"
                >
                  COMPLETE WITHDRAWAL
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, valColor }: { label: string; value: string; valColor: string }) {
  return (
    <div className="bg-surface-container-lowest p-3 border border-outline-variant/10">
      <div className="font-headline text-[10px] text-on-surface-variant uppercase tracking-widest">
        {label}
      </div>
      <div className={`font-headline text-lg font-bold ${valColor}`}>{value}</div>
    </div>
  );
}

function Row({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div className="flex justify-between text-xs py-1 border-b border-outline-variant/[0.05]">
      <span className="text-on-surface-variant/60">{label}</span>
      <span className={`font-bold ${valueColor ?? "text-on-surface"}`}>{value}</span>
    </div>
  );
}
