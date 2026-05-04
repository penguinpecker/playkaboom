"use client";
import { useGameStore } from "@/stores/game-store";
import { useGameActions } from "@/hooks/use-game-actions";
import { useModal } from "@/components/providers/modal";

export function ModalRoot() {
  const { modal, close } = useModal();
  if (!modal) return null;
  if (modal === "win") return <WinModal close={close} />;
  if (modal === "lose") return <LoseModal close={close} />;
  if (modal === "profile") return <ProfileModal close={close} />;
  return null;
}

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="modal-backdrop fixed inset-0 z-[90] flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

function WinModal({ close }: { close: () => void }) {
  const multiplier = useGameStore((s) => s.multiplier);
  const payout = useGameStore((s) => s.payout);
  const { resetGame } = useGameActions();
  return (
    <Backdrop onClose={close}>
      <div className="w-[90vw] max-w-[420px] border border-primary/20 bg-surface-container-low px-6 py-8 text-center">
        <h2 className="mb-1 font-headline text-2xl font-black italic tracking-tighter text-primary">
          EXTRACTION SUCCESS
        </h2>
        <p className="mb-6 text-xs text-on-surface-variant">Grid cleared. Assets secured on-chain.</p>
        <div className="mb-6 flex justify-center gap-6">
          <Stat label="MULT" value={`${multiplier.toFixed(2)}×`} color="text-secondary" />
          <Stat label="PAYOUT" value={`+${payout.toFixed(3)} SOL`} color="text-primary" />
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              close();
              resetGame();
            }}
            className="flex-1 bg-gradient-to-r from-primary to-primary-container py-3 font-headline text-xs font-bold tracking-widest text-on-primary hover:brightness-110 active:scale-95"
          >
            PLAY AGAIN
          </button>
          <button
            type="button"
            onClick={close}
            className="border border-outline-variant/15 px-5 py-3 font-headline text-xs font-bold tracking-widest text-on-surface-variant hover:bg-surface-container-highest"
          >
            CLOSE
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function LoseModal({ close }: { close: () => void }) {
  const safeCount = useGameStore((s) => s.safeTiles.size);
  const bet = useGameStore((s) => s.bet);
  const { resetGame } = useGameActions();
  return (
    <Backdrop onClose={close}>
      <div className="w-[90vw] max-w-[420px] border border-tertiary-container/15 bg-surface-container-low px-6 py-8 text-center">
        <h2 className="mb-1 font-headline text-2xl font-black italic tracking-tighter text-tertiary">
          DETONATION
        </h2>
        <p className="mb-6 text-xs text-on-surface-variant">Mine triggered. Bet lost on-chain.</p>
        <div className="mb-6 flex justify-center gap-6">
          <Stat label="CLEARED" value={`${safeCount}`} color="text-on-surface" />
          <Stat label="LOST" value={`-${bet.toFixed(3)} SOL`} color="text-error" />
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              close();
              resetGame();
            }}
            className="flex-1 bg-gradient-to-r from-tertiary-container to-tertiary py-3 font-headline text-xs font-bold tracking-widest text-on-primary hover:brightness-110 active:scale-95"
          >
            TRY AGAIN
          </button>
          <button
            type="button"
            onClick={close}
            className="border border-outline-variant/15 px-5 py-3 font-headline text-xs font-bold tracking-widest text-on-surface-variant hover:bg-surface-container-highest"
          >
            CLOSE
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function ProfileModal({ close }: { close: () => void }) {
  const { walletAddress, logout } = useGameActions();
  return (
    <Backdrop onClose={close}>
      <div className="w-[90vw] max-w-[420px] border border-outline-variant/15 bg-surface-container-low px-6 py-8">
        <h2 className="mb-4 font-headline text-lg font-bold tracking-widest text-on-surface">
          Wallet
        </h2>
        <div className="mb-4 break-all bg-surface-container-lowest p-3 font-mono text-xs text-primary">
          {walletAddress ?? "—"}
        </div>
        <button
          type="button"
          onClick={() => {
            void logout();
            close();
          }}
          className="w-full border border-error/15 py-2.5 font-headline text-[10px] font-bold tracking-widest text-error/60 hover:bg-error/5"
        >
          DISCONNECT
        </button>
      </div>
    </Backdrop>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div className="mb-0.5 font-headline text-[10px] uppercase tracking-widest text-on-surface-variant">
        {label}
      </div>
      <div className={`font-headline text-2xl font-bold ${color}`}>{value}</div>
    </div>
  );
}
