"use client";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

export type ModalKey =
  | "wallet"
  | "profile"
  | "deposit"
  | "fair"
  | "referral"
  | "settings"
  | "win"
  | "lose"
  | null;

const Ctx = createContext<{
  modal: ModalKey;
  open: (key: ModalKey) => void;
  close: () => void;
} | null>(null);

export function ModalProvider({ children }: { children: ReactNode }) {
  const [modal, setModal] = useState<ModalKey>(null);
  const open = useCallback((key: ModalKey) => setModal(key), []);
  const close = useCallback(() => setModal(null), []);
  return <Ctx.Provider value={{ modal, open, close }}>{children}</Ctx.Provider>;
}

export function useModal() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useModal must be used inside ModalProvider");
  return ctx;
}
