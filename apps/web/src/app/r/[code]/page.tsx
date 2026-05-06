"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

const REFERRER_LOCAL_KEY = "playkaboom.referrer.v1";

/**
 * Short referral landing. Resolves /r/<code> → wallet via the API, stores
 * the wallet in localStorage so the existing useReferralFromURL hook
 * picks it up on /play, then redirects to /. The 6-char code is the
 * only thing the URL exposes; the wallet stays inside the API response.
 *
 * If the code is invalid we still redirect to / but show a one-line
 * notice so users don't blame the site for "doing nothing."
 */
export default function ReferralLandingPage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = params?.code;
    if (!code) {
      router.replace("/");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/ref/${code}`);
        if (!res.ok) {
          if (!cancelled) {
            setError(res.status === 404 ? "Unknown referral code" : "Couldn't resolve link");
            // Still bounce home so the user isn't stuck on a noop page.
            setTimeout(() => router.replace("/"), 1200);
          }
          return;
        }
        const { wallet } = (await res.json()) as { wallet: string };
        if (cancelled) return;
        try {
          localStorage.setItem(REFERRER_LOCAL_KEY, wallet);
        } catch {
          /* private mode / disabled storage — referrer simply won't persist */
        }
        router.replace("/");
      } catch {
        if (!cancelled) {
          setError("Couldn't resolve link");
          setTimeout(() => router.replace("/"), 1200);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params, router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface kinetic-grid px-6">
      <div className="bg-surface-container-low p-6 stealth-card border border-outline-variant/10 max-w-sm w-full">
        <p className="font-headline text-[10px] tracking-[.12em] text-on-surface-variant flex items-center gap-2 mb-2">
          <span className="status-dot bg-primary" />
          REFERRAL LINK
        </p>
        <h1 className="font-headline text-base font-black italic tracking-tight text-on-surface mb-3">
          {error ? "LINK FAILED" : "REGISTERING REFERRER…"}
        </h1>
        <p className="font-mono text-xs text-on-surface-variant leading-relaxed">
          {error ?? "You'll be redirected to the home page in a second."}
        </p>
      </div>
    </div>
  );
}
