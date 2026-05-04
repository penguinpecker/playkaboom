"use client";
import { useVault } from "@/hooks/use-vault";
import { accountExplorer, PROGRAM_ID } from "@/lib/cluster";

export default function VaultPage() {
  const { data: vault } = useVault();
  return (
    <div className="kinetic-grid min-h-screen px-6 pb-16 lg:px-8">
      <h1 className="mb-8 font-headline text-3xl font-black italic tracking-tighter">
        PLAYKABOOM <span className="text-primary">VAULT</span>
      </h1>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card label="Balance" value={`${vault?.balanceSol.toFixed(3) ?? "—"} SOL`} color="border-primary" valColor="text-primary" />
        <Card label="Max bet" value={`${vault?.maxBetSol.toFixed(3) ?? "—"} SOL`} color="border-secondary" valColor="text-secondary" />
        <Card label="Max payout" value={`${vault?.maxPayoutSol.toFixed(3) ?? "—"} SOL`} color="border-tertiary" valColor="text-tertiary" />
        <Card label="Health" value={`${vault?.healthPct ?? "—"}%`} color="border-emerald" valColor="text-emerald" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="stealth-card border border-outline-variant/10 bg-surface-container-low p-6">
          <h2 className="mb-4 font-headline text-xs font-bold uppercase tracking-widest text-on-surface">
            Vault config
          </h2>
          <div className="space-y-2.5">
            <Info label="House edge" value={`${((vault?.config?.houseEdgeBps ?? 0) / 100).toFixed(2)}%`} />
            <Info label="Max bet" value={`${(vault?.config?.maxBetBps ?? 0) / 100}%`} />
            <Info label="Max payout" value={`${(vault?.config?.maxPayoutBps ?? 0) / 100}%`} />
            <Info label="Total games" value={`${vault?.config?.totalGames.toString() ?? "0"}`} />
            <Info label="Total wagered" value={`${Number(vault?.config?.totalWagered ?? 0n) / 1e9} SOL`} />
            <Info label="Total payouts" value={`${Number(vault?.config?.totalPayouts ?? 0n) / 1e9} SOL`} />
            <Info label="Paused" value={vault?.config?.paused ? "yes" : "no"} />
          </div>
        </div>

        <div className="stealth-card border border-outline-variant/10 bg-surface-container-low p-5">
          <h3 className="mb-3 font-headline text-xs font-bold uppercase tracking-widest text-on-surface">
            Program
          </h3>
          <a
            href={accountExplorer(PROGRAM_ID.toBase58())}
            target="_blank"
            rel="noreferrer"
            className="break-all font-mono text-[10px] text-primary hover:underline"
          >
            {PROGRAM_ID.toBase58()}
          </a>
        </div>
      </div>
    </div>
  );
}

function Card({ label, value, color, valColor }: { label: string; value: string; color: string; valColor: string }) {
  return (
    <div className={`stealth-card border-l-4 border border-outline-variant/10 bg-surface-container-low p-4 ${color}`}>
      <div className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
        {label}
      </div>
      <div className={`font-headline text-xl font-bold ${valColor}`}>{value}</div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-outline-variant/[0.05] py-1.5">
      <span className="text-xs text-on-surface-variant/70">{label}</span>
      <span className="text-xs font-bold text-primary">{value}</span>
    </div>
  );
}
