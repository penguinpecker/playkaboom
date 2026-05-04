"use client";
import { useModal } from "@/hooks/useModal";
import { type ReactNode, useEffect } from "react";

export function ModalShell({ children, title }: { children: ReactNode; title: string }) {
  const { close } = useModal();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [close]);

  return (
    <div
      className="fixed inset-0 z-[90] modal-backdrop flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="bg-surface-container-low border border-outline-variant/[0.12] w-[90vw] max-w-[420px] animate-scale-in">
        <div className="px-5 py-3 border-b border-outline-variant/[0.08] flex justify-between items-center">
          <span className="font-headline text-xs font-bold tracking-widest uppercase text-on-surface">
            {title}
          </span>
          <button
            onClick={close}
            className="text-on-surface-variant hover:text-primary transition-colors"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
