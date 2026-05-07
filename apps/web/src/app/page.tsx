"use client";
import Link from "next/link";
import { formatEther } from "@/lib/compat";
import { useVaultBalance, useVaultHealth, useGameCounter } from "@/hooks/useContracts";
import { CLUSTER, CLUSTER_LABEL, accountExplorer, PROGRAM_ID } from "@/lib/cluster";
import { KaboomLogo } from "@/components/ui/KaboomLogo";
import { GlobalActivityFeed } from "@/components/GlobalActivityFeed";

export default function HomePage() {
  return (
    <>
      <HeroSection />
      <StatsBanner />
      <HowItWorks />
      <FeatureMatrix />
      <ReactiveModules />
      <RealTimeIntel />
      <SolanaFooter />
    </>
  );
}

/**
 * Marketing feature matrix. Six cards with icons + one-liners covering the
 * differentiators: provably fair, embedded wallet, vault yield, no custody,
 * mobile-native, audit-friendly. Replaces the empty space between
 * "How It Works" and "Reactive Modules".
 */
function FeatureMatrix() {
  const features = [
    {
      icon: "verified",
      title: "PROVABLY FAIR",
      body: "SHA-256 commit-reveal. Every settled game's salt + layout are public — anyone can re-hash and verify.",
      color: "primary",
    },
    {
      icon: "bolt",
      title: "ONE-CLICK PLAY",
      body: "Privy embedded wallet auto-signs every reveal. No popup tax, no extension dance.",
      color: "secondary",
    },
    {
      icon: "savings",
      title: "LP YIELD VAULT",
      body: "Deposit SOL, earn the house edge. Units pegged to vault NAV. 3-day cooldown protects against JIT drain.",
      color: "tertiary",
    },
    {
      icon: "lock",
      title: "NON-CUSTODIAL",
      body: "Your wallet, your keys. House signing on Turnkey HSM. Treasury withdrawals allowlisted on-chain.",
      color: "primary",
    },
    {
      icon: "phone_android",
      title: "MOBILE NATIVE",
      body: "Engage from any device — your in-flight game state syncs via encrypted server mirror.",
      color: "secondary",
    },
    {
      icon: "shield",
      title: "MEV-AWARE",
      body: "Dynamic priority fees, no public mempool exposure, on-chain commitment locked at start_game.",
      color: "tertiary",
    },
  ];
  const colorMap: Record<string, string> = {
    primary: "bg-primary/10 border-primary/20 text-primary",
    secondary: "bg-secondary/10 border-secondary/20 text-secondary",
    tertiary: "bg-tertiary/10 border-tertiary/20 text-tertiary",
  };
  return (
    <section className="container mx-auto px-4 sm:px-6 lg:px-12 py-16 lg:py-24">
      <h2 className="font-headline text-3xl sm:text-4xl font-black italic tracking-tight text-on-surface mb-3 border-l-4 border-tertiary pl-4 sm:pl-6">
        BUILT DIFFERENT
      </h2>
      <p className="font-body text-sm text-on-surface-variant mb-12 pl-5 sm:pl-7">
        Six things that make Kaboom the cleanest on-chain Mines you'll play.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        {features.map((f) => (
          <div
            key={f.title}
            className="bg-surface-container-low p-5 sm:p-6 stealth-card border border-outline-variant/10 hover:border-primary/20 transition-colors group"
          >
            <div
              className={`w-10 h-10 rounded-lg flex items-center justify-center mb-4 border ${colorMap[f.color]} group-hover:scale-110 transition-transform`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
                {f.icon}
              </span>
            </div>
            <h3 className="font-headline text-sm font-bold tracking-widest uppercase text-on-surface mb-2">
              {f.title}
            </h3>
            <p className="font-body text-xs text-on-surface-variant leading-relaxed">
              {f.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function HeroSection() {
  return (
    <section className="relative min-h-[600px] sm:min-h-[720px] lg:min-h-[870px] flex items-center justify-center overflow-hidden kinetic-grid">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] sm:w-[600px] lg:w-[800px] h-[400px] sm:h-[600px] lg:h-[800px] bg-secondary/5 blur-[80px] lg:blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute top-1/4 right-4 lg:right-10 w-[200px] lg:w-[400px] h-[200px] lg:h-[400px] bg-primary/10 blur-[60px] lg:blur-[100px] rounded-full pointer-events-none" />
      <div className="absolute bottom-1/4 left-4 lg:left-10 w-[200px] lg:w-[300px] h-[200px] lg:h-[300px] bg-tertiary/10 blur-[60px] lg:blur-[80px] rounded-full pointer-events-none" />
      <div className="container mx-auto px-4 sm:px-6 relative z-10 flex flex-col items-center text-center py-12 sm:py-16">
        {/* Hero logo — branded mark sits above everything as the visual anchor.
            Sized to feel substantial without crowding the headline below. */}
        <div className="mb-6 sm:mb-8 animate-float">
          <KaboomLogo size={160} glow className="drop-shadow-[0_0_40px_rgba(208,188,255,0.4)] sm:hidden" />
          <KaboomLogo size={240} glow className="drop-shadow-[0_0_60px_rgba(208,188,255,0.5)] hidden sm:block" />
        </div>
        <div className="inline-flex items-center gap-2 px-3 sm:px-4 py-1 bg-surface-container-high rounded-full mb-6 sm:mb-8 border border-outline-variant/15">
          <span className="status-dot" />
          <span className="font-headline text-[9px] sm:text-[10px] uppercase tracking-[0.15em] sm:tracking-[0.2em] text-on-surface-variant">
            System Online // {CLUSTER_LABEL[CLUSTER]}
          </span>
        </div>
        <h1 className="font-headline text-4xl sm:text-6xl md:text-7xl lg:text-8xl font-black italic tracking-tighter text-on-surface mb-4 sm:mb-6 leading-none px-2">
          DOMINATE <span className="text-primary">THE GRID</span>
        </h1>
        <p className="font-body text-sm sm:text-base lg:text-lg text-on-surface-variant max-w-2xl mb-8 sm:mb-12 px-2">
          A Fully Onchain Minesweeper Style Game with Community owned Defi Vault!
        </p>
        {/* Mini stat strip — no auth needed, builds trust above the fold */}
        <div className="grid grid-cols-3 gap-2 sm:gap-4 mb-8 sm:mb-12 w-full max-w-md">
          <div className="bg-surface-container-high p-2 sm:p-3 stealth-card border-l-2 border-primary">
            <div className="font-headline text-[8px] sm:text-[10px] uppercase tracking-widest text-on-surface-variant">
              Edge
            </div>
            <div className="font-headline text-base sm:text-xl font-bold text-primary">2%</div>
          </div>
          <div className="bg-surface-container-high p-2 sm:p-3 stealth-card border-l-2 border-secondary">
            <div className="font-headline text-[8px] sm:text-[10px] uppercase tracking-widest text-on-surface-variant">
              Max
            </div>
            <div className="font-headline text-base sm:text-xl font-bold text-secondary">
              ×24.5
            </div>
          </div>
          <div className="bg-surface-container-high p-2 sm:p-3 stealth-card border-l-2 border-tertiary">
            <div className="font-headline text-[8px] sm:text-[10px] uppercase tracking-widest text-on-surface-variant">
              Settle
            </div>
            <div className="font-headline text-base sm:text-xl font-bold text-tertiary">~2s</div>
          </div>
        </div>
        <div className="relative mb-8 sm:mb-16 p-3 sm:p-4 bg-surface-container-lowest/50 backdrop-blur-md rounded-xl border border-outline-variant/10">
          <div className="grid grid-cols-4 gap-2 sm:gap-3 w-56 sm:w-64 md:w-80 h-56 sm:h-64 md:h-80">
            {Array.from({ length: 16 }).map((_, i) => {
              if (i === 2)
                return (
                  <div
                    key={i}
                    className="bg-primary/20 border border-primary shadow-[inset_0_0_20px_rgba(164,201,255,0.2)] flex items-center justify-center animate-pulse"
                  >
                    <span
                      className="material-symbols-outlined text-primary"
                      style={{ fontSize: 20 }}
                    >
                      bolt
                    </span>
                  </div>
                );
              if (i === 5)
                return (
                  <div
                    key={i}
                    className="bg-tertiary/10 border border-tertiary/30 flex items-center justify-center"
                  >
                    <span
                      className="material-symbols-outlined text-tertiary"
                      style={{ fontSize: 20 }}
                    >
                      dangerous
                    </span>
                  </div>
                );
              if (i === 11)
                return (
                  <div
                    key={i}
                    className="bg-primary/20 border border-primary shadow-[inset_0_0_20px_rgba(164,201,255,0.2)]"
                  />
                );
              return (
                <div
                  key={i}
                  className="bg-surface-container-high border border-primary/20 hover:border-primary transition-all"
                />
              );
            })}
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 items-center w-full sm:w-auto">
          <Link
            href="/play"
            className="group relative w-full sm:w-auto px-8 sm:px-12 py-4 sm:py-5 font-headline text-lg sm:text-2xl font-black italic tracking-tighter text-on-primary bg-gradient-to-br from-primary to-primary-container transition-all hover:scale-105 active:scale-95 text-center"
          >
            <span className="relative z-10">ENGAGE NOW</span>
            <div className="absolute inset-0 bg-primary blur-xl opacity-0 group-hover:opacity-30 transition-opacity" />
          </Link>
          <Link
            href="/leaderboard"
            className="w-full sm:w-auto px-6 py-4 sm:py-5 font-headline text-sm sm:text-base font-bold tracking-widest text-on-surface-variant border border-outline-variant/20 hover:bg-surface-container-high hover:text-on-surface transition-all text-center"
          >
            VIEW LEADERBOARD
          </Link>
        </div>
      </div>
    </section>
  );
}

function StatsBanner() {
  const { data: vaultBal } = useVaultBalance();
  const { data: vaultHealth } = useVaultHealth();
  const { data: gameCount } = useGameCounter();

  return (
    <section className="bg-surface-container-low border-y border-outline-variant/10 py-6">
      <div className="container mx-auto px-4 sm:px-6 lg:px-12 flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 lg:gap-6">
        <div className="flex items-center gap-3 lg:gap-4">
          <span className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
            On-Chain Stats
          </span>
          <div className="h-px w-12 bg-outline-variant/30" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6 lg:gap-12 w-full lg:w-auto">
          <div className="flex flex-col">
            <span className="font-headline text-[10px] text-on-surface-variant uppercase tracking-widest">
              Vault Balance
            </span>
            <span className="font-headline text-2xl font-bold text-primary">
              {vaultBal ? Number(formatEther(vaultBal)).toFixed(2) : "—"} SOL
            </span>
          </div>
          <div className="flex flex-col">
            <span className="font-headline text-[10px] text-on-surface-variant uppercase tracking-widest">
              Vault Health
            </span>
            <span className="font-headline text-2xl font-bold text-emerald">
              {vaultHealth ? vaultHealth.toString() : "—"}%
            </span>
          </div>
          <div className="flex flex-col">
            <span className="font-headline text-[10px] text-on-surface-variant uppercase tracking-widest">
              Total Games
            </span>
            <span className="font-headline text-2xl font-bold text-secondary">
              {gameCount ? gameCount.toString() : "0"}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="font-headline text-[10px] text-on-surface-variant uppercase tracking-widest">
              Network
            </span>
            <span className="font-headline text-2xl font-bold text-tertiary">
              {CLUSTER_LABEL[CLUSTER].split(" ")[1] ?? CLUSTER}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="py-16 lg:py-24 container mx-auto px-4 sm:px-6 lg:px-12">
      <h2 className="font-headline text-3xl sm:text-4xl font-black italic tracking-tight text-on-surface mb-10 lg:mb-16 border-l-4 border-primary pl-4 sm:pl-6">
        HOW IT WORKS
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 lg:gap-8">
        <Step
          n="01"
          icon="payments"
          color="primary"
          title="SET YOUR STAKE"
          body="Choose bet amount + mine density. Higher mines = higher multiplier. 2% house edge, provably fair via SHA-256."
        >
          <div className="p-4 bg-surface-container-lowest rounded border border-outline-variant/10">
            <div className="flex justify-between items-center mb-2">
              <span className="font-headline text-[10px] text-on-surface-variant uppercase">
                Bet Amount
              </span>
              <span className="font-headline text-[10px] text-primary">MAX STAKE</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex-grow h-1 bg-surface-container-highest overflow-hidden">
                <div className="h-full bg-primary w-[40%]" />
              </div>
              <span className="font-headline text-sm font-bold">0.10 SOL</span>
            </div>
          </div>
        </Step>
        <Step
          n="02"
          icon="grid_view"
          color="secondary"
          title="REVEAL TILES"
          body="Click tiles on the 4×4 grid. Each safe tile increases your multiplier. Hit a mine and you lose your bet."
        >
          <div className="grid grid-cols-4 gap-1 p-2 bg-surface-container-lowest rounded border border-outline-variant/10 w-32 mx-auto">
            {[1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0].map((t, i) => (
              <div
                key={i}
                className={`aspect-square ${t === 1 ? "bg-primary/40" : t === 2 ? "bg-tertiary/40" : "bg-surface-container-highest"}`}
              />
            ))}
          </div>
        </Step>
        <Step
          n="03"
          icon="trending_up"
          color="tertiary"
          title="CASH OUT OR CLIMB"
          body="Cash out anytime to lock your multiplier. Or push deeper for exponential gains. Payout from vault, auto-signed via Privy."
        >
          <div className="flex items-end gap-1 h-12 justify-center">
            <div className="w-3 bg-tertiary/20 h-1/4" />
            <div className="w-3 bg-tertiary/40 h-2/4" />
            <div className="w-3 bg-tertiary/60 h-3/4" />
            <div className="w-3 bg-tertiary h-full relative">
              <span className="font-headline text-[10px] font-black absolute -top-5 -left-2">
                12.5×
              </span>
            </div>
          </div>
        </Step>
      </div>
    </section>
  );
}

function Step({
  n,
  icon,
  color,
  title,
  body,
  children,
}: {
  n: string;
  icon: string;
  color: "primary" | "secondary" | "tertiary";
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  const colorRing: Record<string, string> = {
    primary: "bg-primary/10 border-primary/20 text-primary",
    secondary: "bg-secondary/10 border-secondary/20 text-secondary",
    tertiary: "bg-tertiary/10 border-tertiary/20 text-tertiary",
  };
  return (
    <div className="bg-surface-container p-8 rounded-lg relative overflow-hidden group hover:bg-surface-container-high transition-all">
      <span className="absolute -top-4 -right-4 text-8xl font-black text-on-surface/5 italic font-headline">
        {n}
      </span>
      <div
        className={`w-12 h-12 rounded-lg flex items-center justify-center mb-6 border ${colorRing[color]}`}
      >
        <span className="material-symbols-outlined">{icon}</span>
      </div>
      <h3 className="font-headline text-xl font-bold text-on-surface mb-4">{title}</h3>
      <p className="font-body text-sm text-on-surface-variant mb-6 leading-relaxed">{body}</p>
      {children}
    </div>
  );
}

function ReactiveModules() {
  const modules = [
    {
      title: "RISK GUARDIAN",
      icon: "shield",
      badge: "LIVE",
      badgeColor: "bg-emerald/20 text-emerald border-emerald/30",
      desc: "Watches vault health & game outcomes. Auto-pauses if reserves drop below the safety threshold.",
      stat: "AUTO-PAUSE",
      statSub: "if health < 50%",
      gradient: "from-primary/10 via-surface-container to-emerald/5",
      ring: "border-emerald/20 hover:border-emerald/40",
    },
    {
      title: "LEADERBOARD",
      icon: "leaderboard",
      badge: "LIVE",
      badgeColor: "bg-secondary/20 text-secondary border-secondary/30",
      desc: "Ranks players by biggest win, longest streak, total volume. Updates on every game settlement.",
      stat: "REAL-TIME",
      statSub: "every settle event",
      gradient: "from-secondary/10 via-surface-container to-primary/5",
      ring: "border-secondary/20 hover:border-secondary/40",
    },
    {
      title: "WHALE ALERT",
      icon: "trending_up",
      badge: "SOON",
      badgeColor: "bg-amber/20 text-amber border-amber/30",
      desc: "Detects oversized bets in real time, highlights referral activity, pings Telegram on rare multipliers.",
      stat: "100×+",
      statSub: "win threshold",
      gradient: "from-tertiary/10 via-surface-container to-amber/5",
      ring: "border-tertiary/20 hover:border-tertiary/40",
    },
  ];

  return (
    <section className="py-16 lg:py-24 bg-surface-container-lowest">
      <div className="container mx-auto px-4 sm:px-6 lg:px-12">
        <div className="flex justify-between items-end mb-10 lg:mb-16">
          <div>
            <h2 className="font-headline text-3xl sm:text-4xl font-black italic tracking-tight text-on-surface mb-2">
              REACTIVE MODULES
            </h2>
            <p className="font-body text-sm text-on-surface-variant">
              Autonomous on-chain subscriptions
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 lg:gap-6">
          {modules.map((m) => (
            <div
              key={m.title}
              className={`group relative overflow-hidden h-72 lg:h-80 bg-surface-container-high border ${m.ring} hover:translate-y-[-4px] transition-all duration-300 stealth-card`}
            >
              <div className={`absolute inset-0 bg-gradient-to-br ${m.gradient}`} />
              <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/30 to-transparent" />
              {/* Badge floats top-right, no longer competing with the title for space */}
              <span
                className={`absolute top-4 right-4 font-headline text-[9px] font-bold tracking-widest px-2 py-0.5 uppercase border ${m.badgeColor}`}
              >
                {m.badge}
              </span>
              {/* Module icon top-left */}
              <div className="absolute top-4 left-4 w-10 h-10 bg-surface/40 backdrop-blur-sm border border-outline-variant/20 flex items-center justify-center">
                <span className="material-symbols-outlined text-on-surface" style={{ fontSize: 20 }}>
                  {m.icon}
                </span>
              </div>
              {/* Bottom text block */}
              <div className="absolute bottom-0 p-5 lg:p-6 w-full">
                <div className="font-headline text-2xl sm:text-3xl font-black italic text-on-surface mb-1 leading-tight">
                  {m.title}
                </div>
                <div className="flex items-baseline gap-2 mb-3">
                  <span className="font-headline text-xs font-bold text-primary">{m.stat}</span>
                  <span className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant/60">
                    · {m.statSub}
                  </span>
                </div>
                <p className="font-body text-xs text-on-surface-variant leading-relaxed">
                  {m.desc}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function RealTimeIntel() {
  const { data: gameCount } = useGameCounter();
  const { data: vaultBal } = useVaultBalance();

  return (
    <section className="py-16 lg:py-24 container mx-auto px-4 sm:px-6 lg:px-12">
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8 lg:gap-12 items-start">
        <div className="lg:col-span-1">
          <h2 className="font-headline text-4xl font-black italic tracking-tight text-on-surface mb-6">
            REAL-TIME INTEL
          </h2>
          <p className="font-body text-sm text-on-surface-variant mb-8 leading-relaxed">
            Live games settled on-chain, indexed into our public database. Every
            row links to a verifiable proof.
          </p>
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="status-dot" />
              <span className="font-headline text-[10px] uppercase tracking-widest text-on-surface">
                {gameCount ? gameCount.toString() : "0"} Games Played
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-1.5 h-1.5 rounded-full bg-primary status-dot" />
              <span className="font-headline text-[10px] uppercase tracking-widest text-on-surface">
                {vaultBal ? Number(formatEther(vaultBal)).toFixed(2) : "—"} SOL in Vault
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-1.5 h-1.5 rounded-full bg-tertiary status-dot" />
              <span className="font-headline text-[10px] uppercase tracking-widest text-on-surface">
                Program Verified
              </span>
            </div>
          </div>
        </div>
        <div className="lg:col-span-3">
          {/* Same component as /play below the grid — DB-backed, indexed
              from on-chain settle events by the cron worker. Everyone sees
              everyone's games, not just their own. */}
          <GlobalActivityFeed limit={20} title="" maxHeight={420} />
        </div>
      </div>
    </section>
  );
}

function SolanaFooter() {
  return (
    <footer className="w-full flex flex-col md:flex-row justify-between items-center px-4 sm:px-6 lg:px-12 py-8 gap-4 bg-surface-container-lowest border-t border-outline-variant/15">
      <span className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
        © {new Date().getFullYear()} PlayKaboom Kinetic Engine. All Systems Operational.{" "}
        {CLUSTER_LABEL[CLUSTER]}.
      </span>
      <div className="flex gap-8">
        <a
          className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant hover:text-tertiary transition-colors"
          href={accountExplorer(PROGRAM_ID.toBase58())}
          target="_blank"
          rel="noreferrer"
        >
          Explorer
        </a>
        <a
          className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant hover:text-tertiary transition-colors"
          href="https://github.com/penguinpecker/playkaboom"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
      </div>
    </footer>
  );
}
