"use client";
import { useEffect } from "react";
import { setRateLimitHandler } from "@/lib/api";
import { useToast } from "@/components/providers/toast";

/**
 * Bridges the api.ts global rate-limit handler to the live ToastProvider.
 *
 * This component MUST be rendered INSIDE <ToastProvider>. It used to live
 * in `web3.tsx`/`PrivyAuthBridge`, but Web3Provider wraps ToastProvider in
 * `layout.tsx`, and `useToast()` outside its provider tree throws — which
 * broke the SSG of `/_not-found` (the 2026-05-11 deploy failure).
 *
 * The auth-failure (401) handler stays in `PrivyAuthBridge` because it only
 * needs to call Privy `login()`, which is provider-independent.
 */
export function AuthToastBridge() {
  const { toast } = useToast();
  useEffect(() => {
    setRateLimitHandler(() => {
      toast("Too many requests — wait a moment and try again", "amber");
    });
  }, [toast]);
  return null;
}
