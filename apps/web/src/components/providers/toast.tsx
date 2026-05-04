"use client";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

interface Toast {
  id: number;
  message: string;
  color: string;
}

const ToastContext = createContext<{ toast: (msg: string, color?: string) => void } | null>(null);
let toastId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, color: string = "primary") => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, message, color }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  const colorMap: Record<string, string> = {
    primary: "border-primary/20",
    emerald: "border-emerald/20",
    amber: "border-amber/20",
    error: "border-error/20",
    secondary: "border-secondary/20",
  };
  const dotMap: Record<string, string> = {
    primary: "bg-primary",
    emerald: "bg-emerald",
    amber: "bg-amber",
    error: "bg-error",
    secondary: "bg-secondary",
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed top-14 right-3 z-[110] flex flex-col gap-2 w-72 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto px-3 py-2.5 bg-surface-container-low border ${colorMap[t.color] || colorMap.primary} flex items-center gap-2 shadow-[0_4px_16px_rgba(0,0,0,.5)] animate-slide-down`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${dotMap[t.color] || dotMap.primary} shrink-0`} />
            <span className="text-[11px] text-on-surface">{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
