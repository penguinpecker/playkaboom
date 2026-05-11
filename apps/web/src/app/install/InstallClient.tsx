"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { KaboomLogo } from "@/components/ui/KaboomLogo";

const PACKAGE_ID = "gg.playkaboom.twa";
const DEEP_LINK = `solanadappstore://details?id=${PACKAGE_ID}`;
const DAPP_STORE_HOME = "https://dapp-store.solanamobile.com/";

type Platform = "android" | "ios" | "desktop" | "unknown";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent || "";
  if (/Android/i.test(ua)) return "android";
  if (/iPad|iPhone|iPod/i.test(ua)) return "ios";
  return "desktop";
}

export function InstallClient() {
  const [platform, setPlatform] = useState<Platform>("unknown");
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    const p = detectPlatform();
    setPlatform(p);
    if (p === "android") {
      window.location.href = DEEP_LINK;
      setAttempted(true);
    }
  }, []);

  return (
    <section className="relative min-h-[80vh] flex items-center justify-center overflow-hidden kinetic-grid">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] sm:w-[600px] h-[400px] sm:h-[600px] bg-primary/10 blur-[80px] sm:blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute top-1/4 right-4 sm:right-10 w-[200px] sm:w-[300px] h-[200px] sm:h-[300px] bg-secondary/10 blur-[60px] sm:blur-[100px] rounded-full pointer-events-none" />

      <div className="container mx-auto px-4 sm:px-6 relative z-10 flex flex-col items-center text-center py-12 sm:py-16 max-w-2xl">
        <div className="mb-6 animate-float">
          <KaboomLogo
            size={120}
            glow
            className="drop-shadow-[0_0_40px_rgba(208,188,255,0.4)] sm:hidden"
          />
          <KaboomLogo
            size={180}
            glow
            className="drop-shadow-[0_0_60px_rgba(208,188,255,0.5)] hidden sm:block"
          />
        </div>

        <div className="inline-flex items-center gap-2 px-3 sm:px-4 py-1 bg-surface-container-high rounded-full mb-6 border border-outline-variant/15">
          <span className="status-dot" />
          <span className="font-headline text-[9px] sm:text-[10px] uppercase tracking-[0.15em] sm:tracking-[0.2em] text-on-surface-variant">
            Solana dApp Store // Seeker
          </span>
        </div>

        <h1 className="font-headline text-4xl sm:text-6xl font-black italic tracking-tighter text-on-surface mb-4 leading-none">
          INSTALL <span className="text-primary">KABOOM</span>
        </h1>

        <p className="font-body text-sm sm:text-base text-on-surface-variant max-w-md mb-8">
          {platform === "android" && attempted
            ? "Opening Solana dApp Store… If nothing happened, your Seeker may not have the dApp Store installed yet."
            : platform === "ios"
            ? "Kaboom installs on Solana Seeker only — the Solana dApp Store isn't available on iOS. You can still play in your browser."
            : platform === "desktop"
            ? "Kaboom installs on your Solana Seeker via the Solana dApp Store. Open this page on your Seeker to install, or scan the link below from your phone."
            : "Preparing your install link…"}
        </p>

        {/* Primary CTA stack — adapts to detected platform */}
        <div className="w-full flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-center mb-10">
          {platform === "android" ? (
            <a
              href={DEEP_LINK}
              className="group relative px-8 py-4 font-headline text-base sm:text-lg font-black italic tracking-tighter text-on-primary bg-gradient-to-br from-primary to-primary-container transition-all hover:scale-105 active:scale-95 text-center"
            >
              <span className="relative z-10">OPEN dAPP STORE</span>
              <div className="absolute inset-0 bg-primary blur-xl opacity-0 group-hover:opacity-30 transition-opacity" />
            </a>
          ) : (
            <a
              href={DAPP_STORE_HOME}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative px-8 py-4 font-headline text-base sm:text-lg font-black italic tracking-tighter text-on-primary bg-gradient-to-br from-primary to-primary-container transition-all hover:scale-105 active:scale-95 text-center"
            >
              <span className="relative z-10">VISIT dAPP STORE</span>
              <div className="absolute inset-0 bg-primary blur-xl opacity-0 group-hover:opacity-30 transition-opacity" />
            </a>
          )}
          <Link
            href="/play"
            className="px-6 py-4 font-headline text-sm sm:text-base font-bold tracking-widest text-on-surface-variant border border-outline-variant/20 hover:bg-surface-container-high hover:text-on-surface transition-all text-center"
          >
            PLAY IN BROWSER
          </Link>
        </div>

        {/* Manual fallback for power users */}
        <div className="bg-surface-container-lowest/60 backdrop-blur-md border border-outline-variant/10 rounded-lg p-4 sm:p-5 w-full max-w-md text-left">
          <div className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant mb-2">
            Manual link
          </div>
          <code className="font-mono text-xs sm:text-sm text-primary break-all block">
            {DEEP_LINK}
          </code>
          <div className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant mt-3 mb-1">
            Package
          </div>
          <code className="font-mono text-xs text-on-surface break-all block">
            {PACKAGE_ID}
          </code>
        </div>
      </div>
    </section>
  );
}
