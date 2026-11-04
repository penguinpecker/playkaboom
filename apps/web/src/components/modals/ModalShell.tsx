"use client";
import { useModal } from "@/hooks/useModal";
import { type ReactNode, useEffect, useId, useRef } from "react";

export function ModalShell({ children, title }: { children: ReactNode; title: string }) {
  const { close } = useModal();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [close]);

  // Screen readers: move focus into the dialog on open, hand it back to
  // whatever opened it on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[90] modal-backdrop flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="bg-surface-container-low border border-outline-variant/[0.12] w-[90vw] max-w-[420px] animate-scale-in outline-none"
      >
        <div className="px-5 py-3 border-b border-outline-variant/[0.08] flex justify-between items-center">
          <span id={titleId} className="font-headline text-xs font-bold tracking-widest uppercase text-on-surface">
            {title}
          </span>
          <button
            onClick={close}
            aria-label="Close"
            className="text-on-surface-variant hover:text-primary transition-colors"
          >
            <span className="material-symbols-outlined text-lg" aria-hidden="true">close</span>
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
