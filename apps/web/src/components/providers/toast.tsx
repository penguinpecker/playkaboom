"use client";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

interface Toast {
  id: number;
  message: string;
  color: "primary" | "emerald" | "amber" | "error" | "secondary";
}

interface ToastApi {
  toast: (msg: string, color?: Toast["color"]) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback<ToastApi["toast"]>((message, color = "primary") => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, color }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3200);
  }, []);

  const dot: Record<Toast["color"], string> = {
    primary: "bg-primary",
    emerald: "bg-emerald",
    amber: "bg-amber",
    error: "bg-error",
    secondary: "bg-secondary",
  };

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed right-3 top-16 z-[110] flex w-72 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex animate-slide-down items-center gap-2 border border-outline-variant/20 bg-surface-container-low px-3 py-2.5 shadow-[0_4px_16px_rgba(0,0,0,.5)]"
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot[t.color]}`} />
            <span className="text-[11px] text-on-surface">{t.message}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}
