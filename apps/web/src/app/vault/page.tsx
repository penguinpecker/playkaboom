"use client";
import { formatEther } from "@/lib/compat";
import {
  useVaultBalance,
  useVaultMaxBet,
  useVaultMaxPayout,
  useVaultHealth,
  useRiskLevel,
  useGameCounter,
} from "@/hooks/useContracts";
import { CLUSTER, CLUSTER_LABEL, accountExplorer } from "@/lib/cluster";
import { CONTRACTS } from "@/lib/chain";
import { VaultLpPanel } from "@/components/vault/lp-panel";

const RISK_LABELS = ["Healthy", "Caution", "Emergency"];
const RISK_COLORS = ["text-emerald", "text-amber", "text-error"];

export default function VaultPage() {
  const { data: balance } = useVaultBalance();
  const { data: maxBet } = useVaultMaxBet();
  const { data: maxPayout } = useVaultMaxPayout();
  const { data: health } = useVaultHealth();
  const { data: riskLevel } = useRiskLevel();
  const { data: gameCount } = useGameCounter();

  const fmt = (v: bigint | undefined) => (v ? Number(formatEther(v)).toFixed(2) : "—");
  const healthNum = health ?? 0;
  const riskIdx = riskLevel;

  return (
    <div className="px-6 lg:px-8 pb-16 min-h-screen kinetic-grid">
      <div className="mb-8">
        <p className="font-headline text-[10px] tracking-[.12em] text-on-surface-variant flex items-center gap-1 mb-0.5">
          <span className="status-dot" />VAULT STATUS:{" "}
          {riskIdx === undefined
            ? "LOADING"
            : (RISK_LABELS[riskIdx]?.toUpperCase() ?? "—")}
        </p>
        <h1 className="font-headline text-3xl font-black italic tracking-tighter text-on-surface">
          KABOOM <span className="text-primary">VAULT</span>
        </h1>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard
          label="Balance"
          value={`${fmt(balance)} SOL`}
          color="border-primary"
          valColor="text-primary"
        />
        <StatCard
          label="Max Bet"
          value={`${fmt(maxBet)} SOL`}
          color="border-secondary"
          valColor="text-secondary"
        />
        <StatCard
          label="Max Payout"
          value={`${fmt(maxPayout)} SOL`}
          color="border-tertiary"
          valColor="text-tertiary"
        />
        <StatCard
          label="Health"
          value={health === undefined ? "—" : `${healthNum}%`}
          color="border-emerald"
          valColor="text-emerald"
        />
      </div>

      <VaultLpPanel />

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6 mt-6">
        <div className="bg-surface-container-low p-6 border border-outline-variant/10 stealth-card">
          <h2 className="font-headline text-xs font-bold tracking-widest text-on-surface uppercase mb-4">
            Vault Health
          </h2>
          <div className="relative h-3 bg-surface-container-highest rounded-full overflow-hidden mb-2">
            <div
              className="absolute inset-0 h-full bg-gradient-to-r from-emerald via-primary to-primary-container rounded-full transition-all"
              style={{ width: `${healthNum}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] font-headline text-on-surface-variant/30 tracking-widest mb-6">
            <span>0%</span>
            <span className="text-error">EMERGENCY</span>
            <span className="text-amber">CAUTION</span>
            <span className="text-emerald">HEALTHY</span>
            <span>100%</span>
          </div>

          <h3 className="font-headline text-xs font-bold tracking-widest text-on-surface uppercase mb-3">
            System Info
          </h3>
          <div className="space-y-2.5">
            <InfoRow
              label="Risk Level"
              value={riskIdx === undefined ? "—" : (RISK_LABELS[riskIdx] ?? "—")}
              valueColor={riskIdx === undefined ? "text-on-surface" : (RISK_COLORS[riskIdx] ?? "text-on-surface")}
            />
            <InfoRow
              label="Total Games"
              value={gameCount ? gameCount.toString() : "—"}
              valueColor="text-secondary"
            />
            <InfoRow label="Hash" value="SHA-256" valueColor="text-primary" />
            <InfoRow label="Fairness" value="Commit-Reveal" valueColor="text-primary" />
            <InfoRow label="House Edge" value="2.00%" valueColor="text-primary" />
            <InfoRow
              label="Chain"
              value={CLUSTER_LABEL[CLUSTER]}
              valueColor="text-primary"
            />
          </div>
        </div>

        <div className="space-y-4">
          <div className="bg-surface-container-low p-5 border border-outline-variant/10">
            <h3 className="font-headline text-xs font-bold tracking-widest text-on-surface uppercase mb-3">
              Trust Anchors
            </h3>
            <div className="space-y-2">
              {Object.entries(CONTRACTS).map(([name, addr]) => (
                <div key={name}>
                  <span className="font-headline text-[10px] text-on-surface-variant/30 block">
                    {name}
                  </span>
                  <a
                    href={accountExplorer(addr)}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[9px] text-primary hover:underline break-all"
                  >
                    {addr}
                  </a>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
  valColor,
}: {
  label: string;
  value: string;
  color: string;
  valColor: string;
}) {
  return (
    <div
      className={`bg-surface-container-low p-4 border border-outline-variant/10 stealth-card border-l-4 ${color}`}
    >
      <div className="font-headline text-[10px] text-on-surface-variant uppercase tracking-widest">
        {label}
      </div>
      <div className={`font-headline text-xl font-bold ${valColor}`}>{value}</div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor: string;
}) {
  return (
    <div className="flex justify-between py-1.5 border-b border-outline-variant/[0.05]">
      <span className="text-xs text-on-surface-variant/50">{label}</span>
      <span className={`text-xs font-bold ${valueColor}`}>{value}</span>
    </div>
  );
}
