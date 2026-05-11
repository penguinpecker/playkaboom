"use client";
import { useEffect, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { usePrivy } from "@privy-io/react-auth";
import {
  useSolanaWallets as useWallets,
  useSignTransaction,
} from "@privy-io/react-auth/solana";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { ModalShell } from "./ModalShell";
import { useModal } from "@/hooks/useModal";
import { useToast } from "@/hooks/useToast";
import { useGame } from "@/hooks/useGame";
import { CLUSTER, CLUSTER_LABEL, RPC_URL, PROGRAM_ID, txExplorer } from "@/lib/cluster";
import { confirmByPolling } from "@/lib/confirm";
import { appendWalletActivity } from "@/lib/wallet-history";
import { deriveVaultPda } from "@playkaboom/sdk";

export function ModalRoot() {
  const { modal } = useModal();
  if (!modal) return null;
  switch (modal) {
    case "wallet":
      return <WalletModal />;
    case "profile":
      return <ProfileModal />;
    case "deposit":
      return <DepositModal />;
    case "withdraw":
      return <WithdrawModal />;
    case "fair":
      return <FairModal />;
    case "referral":
      return <ReferralModal />;
    case "settings":
      return <SettingsModal />;
    case "win":
      return <WinModal />;
    case "lose":
      return <LoseModal />;
    default:
      return null;
  }
}

function WalletModal() {
  const { login } = usePrivy();
  const { close } = useModal();
  return (
    <ModalShell title="Connect Wallet">
      <p className="text-xs text-on-surface-variant mb-3">{CLUSTER_LABEL[CLUSTER]}</p>
      <button
        onClick={() => {
          login();
          close();
        }}
        className="w-full flex items-center gap-3 px-3 py-4 bg-surface-container-highest border border-outline-variant/10 hover:border-primary/25 hover:bg-primary/5 transition-all mb-2 group"
      >
        <div className="w-10 h-10 rounded bg-surface-bright flex items-center justify-center">
          <span
            className="material-symbols-outlined text-primary mi"
            style={{ fontSize: 22 }}
          >
            account_balance_wallet
          </span>
        </div>
        <div className="flex-1 text-left">
          <div className="font-headline text-sm font-bold text-on-surface group-hover:text-primary">
            Connect Wallet
          </div>
          <div className="font-headline text-[10px] text-on-surface-variant/50">
            Phantom, Backpack, Solflare, or email
          </div>
        </div>
        <span className="material-symbols-outlined text-on-surface-variant/30 text-sm group-hover:text-primary">
          arrow_forward
        </span>
      </button>
    </ModalShell>
  );
}

function ProfileModal() {
  const { open, close } = useModal();
  const { logout } = usePrivy();
  const { wallets } = useWallets();
  const publicKey = wallets[0]?.address ? { toBase58: () => wallets[0]!.address } : null;
  const { connection } = useConnection();
  const { toast } = useToast();
  const [bal, setBal] = useState("—");
  const short = publicKey
    ? `${publicKey.toBase58().slice(0, 6)}…${publicKey.toBase58().slice(-4)}`
    : "";

  useEffect(() => {
    if (!publicKey || !connection) return;
    void import("@solana/web3.js")
      .then(({ PublicKey: PK }) => connection.getBalance(new PK(publicKey.toBase58())))
      .then((b) => setBal((b / LAMPORTS_PER_SOL).toFixed(3)))
      .catch(() => undefined);
  }, [publicKey, connection]);

  return (
    <ModalShell title="Wallet">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary/25 to-tertiary-container/15 flex items-center justify-center">
          <span className="material-symbols-outlined text-primary mi">person</span>
        </div>
        <div>
          <div className="font-headline text-sm font-bold text-primary">{short}</div>
          <div className="font-headline text-[10px] text-on-surface-variant/50">
            {CLUSTER_LABEL[CLUSTER]} • Connected
          </div>
        </div>
      </div>
      <div className="bg-surface-container-lowest p-3 mb-3 flex justify-between items-center">
        <span className="font-headline text-[10px] text-on-surface-variant tracking-widest uppercase">
          Balance
        </span>
        <span className="font-headline text-xl font-bold text-primary">{bal} SOL</span>
      </div>
      <div className="flex gap-2 mb-2">
        <a
          href={publicKey ? `/profile/${publicKey.toBase58()}` : "#"}
          onClick={(e) => {
            if (!publicKey) e.preventDefault();
            close();
          }}
          className="flex-1 text-center py-2.5 bg-surface-container-highest border border-outline-variant/15 font-headline font-bold text-[10px] tracking-widest text-on-surface hover:border-primary/30"
        >
          MY DOSSIER
        </a>
        <a
          href="/referrals"
          onClick={() => close()}
          className="flex-1 text-center py-2.5 bg-surface-container-highest border border-outline-variant/15 font-headline font-bold text-[10px] tracking-widest text-on-surface hover:border-primary/30"
        >
          REFERRALS
        </a>
      </div>
      <div className="flex gap-2 mb-2">
        <button
          onClick={() => {
            close();
            setTimeout(() => open("deposit"), 100);
          }}
          className="flex-1 py-2.5 bg-gradient-to-r from-primary to-primary-container text-on-primary font-headline font-bold text-[10px] tracking-widest hover:brightness-110"
        >
          DEPOSIT
        </button>
        <button
          onClick={() => {
            close();
            setTimeout(() => open("withdraw"), 100);
          }}
          className="flex-1 py-2.5 bg-surface-bright border border-primary/40 text-primary font-headline font-bold text-[10px] tracking-widest hover:bg-primary/10"
        >
          WITHDRAW
        </button>
      </div>
      <button
        onClick={() => {
          void logout();
          toast("Disconnected", "amber");
          close();
        }}
        className="w-full py-2.5 border border-error/15 text-error/60 font-headline font-bold text-[10px] tracking-widest hover:bg-error/5"
      >
        DISCONNECT
      </button>
    </ModalShell>
  );
}

function DepositModal() {
  const { toast } = useToast();
  const { wallets } = useWallets();
  const publicKey = wallets[0]?.address ? { toBase58: () => wallets[0]!.address } : null;
  const addr = publicKey ? publicKey.toBase58() : "Connect wallet first";

  const copyAddress = () => {
    if (publicKey) {
      navigator.clipboard?.writeText(publicKey.toBase58());
      toast("Address copied!", "emerald");
    }
  };

  return (
    <ModalShell title="Fund Wallet">
      <p className="text-xs text-on-surface-variant mb-4">
        Send SOL to this address to start playing.
      </p>
      <div className="bg-surface-container-lowest p-4 mb-3">
        <div className="font-headline text-[10px] text-on-surface-variant/40 tracking-widest uppercase mb-1">
          Your Wallet Address
        </div>
        <div className="font-mono text-sm text-primary break-all select-all">{addr}</div>
      </div>
      <button
        onClick={copyAddress}
        className="w-full py-3 bg-gradient-to-r from-primary to-primary-container text-on-primary font-headline font-black text-xs tracking-widest hover:brightness-110 active:scale-95 mb-2"
      >
        COPY ADDRESS
      </button>
    </ModalShell>
  );
}

// Reserve enough lamports for tx fee so a "max" send doesn't underfund the
// signer and fail at simulation. 5_000 is the standard signature fee; we
// leave a 2x cushion since priority fees can spike.
const TX_FEE_RESERVE_LAMPORTS = 10_000;

function WithdrawModal() {
  const { close } = useModal();
  const { connection } = useConnection();
  const { wallets } = useWallets();
  // Privy *embedded* wallets use useSignTransaction (takes a Transaction
  // object, returns a signed Transaction). useStandardSignTransaction is
  // only for external Wallet-Standard wallets and throws
  // "n.serializeMessage is not a function" against the legacy txs Privy
  // embeds use. Same pattern as use-vault-lp.ts.
  const { signTransaction } = useSignTransaction();
  const { toast } = useToast();
  const wallet = wallets[0];
  const fromAddr = wallet?.address;
  const [dest, setDest] = useState("");
  const [amount, setAmount] = useState("");
  const [bal, setBal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // Sync mirror of busy — see lp-panel.tsx for the same pattern. Prevents
  // a fast double-click on SEND from broadcasting two transfer txs with
  // different blockhashes (both would land, sending double the SOL).
  const busyRef = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  // Two-stage modal: form view (default) → success view once a tx confirms.
  // Success view stays open until the user dismisses, so they can copy the
  // signature or click through to the explorer.
  const [successSig, setSuccessSig] = useState<string | null>(null);
  const [successAmount, setSuccessAmount] = useState<number | null>(null);
  const [successDest, setSuccessDest] = useState<string | null>(null);

  // Poll wallet balance every 5s while the modal is open. Previously
  // this fetched once on mount, so MAX + the "exceeds spendable" guard
  // could be stale by hundreds of ms (post-deposit) to whole SOL (after
  // a side tx in another tab). Stale-low blocked legitimate sends;
  // stale-high made MAX overshoot and the on-chain tx fail confusingly.
  useEffect(() => {
    if (!fromAddr || !connection) return;
    let cancelled = false;
    const refresh = () => {
      void connection
        .getBalance(new PublicKey(fromAddr))
        .then((b) => {
          if (!cancelled) setBal(b / LAMPORTS_PER_SOL);
        })
        .catch(() => undefined);
    };
    refresh();
    const i = setInterval(refresh, 5_000);
    return () => {
      cancelled = true;
      clearInterval(i);
    };
  }, [fromAddr, connection]);

  const maxSendable =
    bal !== null
      ? Math.max(0, bal - TX_FEE_RESERVE_LAMPORTS / LAMPORTS_PER_SOL)
      : 0;

  const setMax = () => {
    if (bal === null) return;
    // FLOOR to 6dp instead of toFixed(6) (which rounds). Rounding can
    // produce a value 1e-7 SOL above maxSendable, which then trips the
    // "Amount exceeds spendable balance" guard at submit time and the
    // user can't actually MAX-send.
    const floored = Math.floor(maxSendable * 1_000_000) / 1_000_000;
    setAmount(floored.toFixed(6));
  };

  const submit = async () => {
    if (busyRef.current) return;
    setErr(null);
    if (!wallet || !fromAddr) {
      setErr("Wallet not connected.");
      return;
    }
    let toPubkey: PublicKey;
    try {
      toPubkey = new PublicKey(dest.trim());
    } catch {
      setErr("Invalid destination address.");
      return;
    }
    if (toPubkey.toBase58() === fromAddr) {
      setErr("Destination is your own wallet.");
      return;
    }
    const sol = parseFloat(amount);
    if (!Number.isFinite(sol) || sol <= 0) {
      setErr("Enter a positive SOL amount.");
      return;
    }
    if (bal !== null && sol > maxSendable) {
      setErr(`Amount exceeds spendable balance (${maxSendable.toFixed(4)} SOL).`);
      return;
    }
    const lamports = Math.round(sol * LAMPORTS_PER_SOL);
    try {
      busyRef.current = true;
      setBusy(true);
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: new PublicKey(fromAddr),
          toPubkey,
          lamports,
        }),
      );
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = new PublicKey(fromAddr);
      const signed = await signTransaction({
        transaction: tx,
        connection,
        address: fromAddr,
      });
      const raw =
        signed instanceof VersionedTransaction
          ? signed.serialize()
          : (signed as Transaction).serialize();
      const sig = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
        maxRetries: 3,
      });
      await confirmByPolling(connection, sig, blockhash, lastValidBlockHeight);
      // Persist to local wallet-activity ledger so /logs can show it under
      // "MY WALLET ACTIVITY". Indexed by source wallet.
      appendWalletActivity(fromAddr, {
        kind: "withdraw",
        signature: sig,
        amountLamports: String(lamports),
        otherAddress: toPubkey.toBase58(),
        time: new Date().toISOString(),
      });
      setSuccessSig(sig);
      setSuccessAmount(sol);
      setSuccessDest(toPubkey.toBase58());
      toast(`Sent ${sol} SOL`, "emerald");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg.length > 200 ? msg.slice(0, 200) + "…" : msg);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (successSig && successAmount != null && successDest) {
    return (
      <ModalShell title="Sent ✓">
        <div className="bg-emerald/10 border-l-2 border-emerald p-3 mb-4">
          <div className="font-headline text-[10px] tracking-widest uppercase text-emerald mb-1">
            Confirmed on-chain
          </div>
          <div className="font-headline text-2xl font-bold text-emerald">
            {successAmount} SOL
          </div>
          <div className="font-mono text-[10px] text-on-surface-variant mt-2 break-all">
            → {successDest}
          </div>
        </div>
        <div className="bg-surface-container-lowest p-3 mb-3">
          <div className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant/40 mb-1">
            Transaction
          </div>
          <div className="font-mono text-[10px] text-primary break-all select-all">
            {successSig}
          </div>
        </div>
        <a
          href={txExplorer(successSig)}
          target="_blank"
          rel="noreferrer"
          className="w-full block text-center py-3 bg-gradient-to-r from-primary to-primary-container text-on-primary font-headline font-black text-xs tracking-widest hover:brightness-110 active:scale-95 mb-2"
        >
          VIEW ON EXPLORER
        </a>
        <button
          onClick={close}
          className="w-full py-2.5 border border-outline-variant/15 text-on-surface-variant font-headline font-bold text-[10px] tracking-widest hover:bg-surface-container-highest"
        >
          DONE
        </button>
        <p className="font-headline text-[9px] text-on-surface-variant/40 tracking-widest uppercase text-center mt-3">
          Recorded in /logs → MY WALLET ACTIVITY
        </p>
      </ModalShell>
    );
  }

  return (
    <ModalShell title="Withdraw SOL">
      <p className="text-xs text-on-surface-variant mb-4">
        Send SOL from your connected wallet to another address.
      </p>
      <div className="bg-surface-container-lowest p-3 mb-3 flex justify-between items-center">
        <span className="font-headline text-[10px] text-on-surface-variant tracking-widest uppercase">
          Available
        </span>
        <span className="font-headline text-base font-bold text-primary">
          {bal === null ? "—" : `${bal.toFixed(4)} SOL`}
        </span>
      </div>
      <label className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant mb-2 block">
        Destination Address
      </label>
      <input
        type="text"
        value={dest}
        onChange={(e) => setDest(e.target.value)}
        placeholder="Solana wallet address"
        disabled={busy}
        className="w-full bg-surface-container-lowest font-mono text-xs text-primary px-3 py-3 mb-3 focus:outline-none focus:ring-1 focus:ring-primary/40 disabled:opacity-50 break-all"
      />
      <label className="font-headline text-[10px] uppercase tracking-widest text-on-surface-variant mb-2 block">
        Amount (SOL)
      </label>
      <div className="relative mb-3">
        <input
          type="number"
          step="0.001"
          min={0}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.000"
          disabled={busy}
          className="w-full bg-surface-container-lowest font-headline font-bold text-base text-primary px-3 py-3 pr-16 focus:outline-none focus:ring-1 focus:ring-primary/40 disabled:opacity-50"
        />
        <button
          onClick={setMax}
          disabled={busy || bal === null}
          className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-1 bg-surface-container-highest text-[10px] font-headline font-bold text-on-surface hover:bg-primary/20 disabled:opacity-30"
        >
          MAX
        </button>
      </div>
      {err && (
        <div className="bg-error/10 border-l-2 border-error p-2.5 mb-3">
          <p className="font-mono text-[11px] text-error leading-relaxed break-words">{err}</p>
        </div>
      )}
      <button
        onClick={submit}
        disabled={busy || !dest || !amount}
        className="w-full py-3 bg-gradient-to-r from-primary to-primary-container text-on-primary font-headline font-black text-xs tracking-widest hover:brightness-110 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {busy ? (
          <>
            <span className="material-symbols-outlined animate-spin" style={{ fontSize: 18 }}>
              progress_activity
            </span>
            SENDING...
          </>
        ) : (
          "SEND"
        )}
      </button>
      <p className="font-headline text-[9px] text-on-surface-variant/40 tracking-widest uppercase text-center mt-3">
        ~0.00001 SOL network fee
      </p>
    </ModalShell>
  );
}

function FairModal() {
  const { state } = useGame();
  const lastTx = state.lastTxHash;
  return (
    <ModalShell title="Provably Fair">
      <p className="text-xs text-on-surface-variant mb-3">
        Server-assisted commit-reveal. Mine layout is committed via SHA-256 before the game and
        revealed on-chain at settlement so anyone can verify.
      </p>
      <div className="space-y-3">
        <div>
          <div className="font-headline text-[10px] text-on-surface-variant/40 tracking-widest uppercase mb-0.5">
            Commitment (this game)
          </div>
          <div className="bg-surface-container-lowest p-2 font-mono text-[9px] text-primary break-all select-all">
            {state.commitment || "Play a game to see commitment"}
          </div>
        </div>
        {lastTx && (
          <a
            href={`/verify/${lastTx}`}
            className="block text-center py-2.5 bg-gradient-to-r from-primary to-primary-container text-on-primary font-headline font-bold text-[10px] tracking-widest hover:brightness-110"
          >
            VERIFY THIS GAME
          </a>
        )}
        <div className="bg-emerald/5 border-emerald/15 border p-3 flex items-center gap-2.5">
          <span
            className="material-symbols-outlined mi text-emerald"
            style={{ fontSize: 20 }}
          >
            verified_user
          </span>
          <div>
            <div className="font-headline text-xs font-bold text-emerald">SHA-256 Commit-Reveal</div>
            <div className="text-[10px] text-on-surface-variant">
              Same scheme used by leading crypto casinos.
            </div>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

function ReferralModal() {
  const { toast } = useToast();
  const { wallets } = useWallets();
  const publicKey = wallets[0]?.address ? { toBase58: () => wallets[0]!.address } : null;
  const link = publicKey ? `https://playkaboom.gg/?ref=${publicKey.toBase58()}` : "Connect wallet";
  return (
    <ModalShell title="Referral Program">
      <div className="bg-gradient-to-br from-secondary-container/15 to-surface-container p-3 border border-secondary/15 mb-3">
        <div className="font-headline text-xl font-bold text-secondary">Earn 1% of every bet</div>
        <p className="text-xs text-on-surface-variant mt-1">Coming soon on Solana.</p>
      </div>
      <div className="flex mb-3">
        <input
          className="flex-1 bg-surface-container-lowest font-mono text-[9px] text-primary px-2.5 py-2 outline-none"
          value={link}
          readOnly
        />
        <button
          onClick={() => {
            navigator.clipboard?.writeText(link);
            toast("Copied!", "emerald");
          }}
          className="px-3 bg-primary/15 text-primary font-headline text-[10px] font-bold tracking-widest hover:bg-primary/25"
        >
          COPY
        </button>
      </div>
    </ModalShell>
  );
}

function SettingsModal() {
  const [vaultPda] = deriveVaultPda(PROGRAM_ID);
  return (
    <ModalShell title="Settings">
      <div className="space-y-3 text-xs text-on-surface-variant">
        <div className="flex justify-between gap-3">
          <span>RPC</span>
          <span className="text-primary font-mono text-[10px] truncate max-w-[220px]">{RPC_URL}</span>
        </div>
        <div className="flex justify-between">
          <span>Chain</span>
          <span className="text-primary">{CLUSTER_LABEL[CLUSTER]}</span>
        </div>
        <div className="flex justify-between">
          <span>Explorer</span>
          <span className="text-primary">solscan.io</span>
        </div>
        <div className="flex justify-between">
          <span>Fairness</span>
          <span className="text-primary">SHA-256 Commit-Reveal</span>
        </div>
        <div className="flex justify-between">
          <span>House Edge</span>
          <span className="text-primary">2%</span>
        </div>
        <div className="pt-2 border-t border-outline-variant/10">
          <div className="font-headline text-[10px] text-on-surface-variant/40 tracking-widest uppercase mb-1">
            Program
          </div>
          <div className="bg-surface-container-lowest p-2 font-mono text-[9px] text-primary break-all">
            {PROGRAM_ID.toBase58()}
          </div>
        </div>
        <div>
          <div className="font-headline text-[10px] text-on-surface-variant/40 tracking-widest uppercase mb-1">
            Vault PDA
          </div>
          <div className="bg-surface-container-lowest p-2 font-mono text-[9px] text-primary break-all">
            {vaultPda.toBase58()}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

function WinModal() {
  const { close } = useModal();
  const { state, resetGame } = useGame();
  return (
    <div
      className="fixed inset-0 z-[90] modal-backdrop flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="bg-surface-container-low border border-primary/15 w-[90vw] max-w-[420px] text-center py-8 px-6">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-primary/10 border-2 border-primary flex items-center justify-center">
          <span
            className="material-symbols-outlined text-primary mi"
            style={{ fontSize: 36 }}
          >
            emoji_events
          </span>
        </div>
        <h2 className="font-headline text-2xl font-black italic tracking-tighter text-primary mb-1">
          EXTRACTION SUCCESS
        </h2>
        <p className="text-on-surface-variant text-xs mb-6">
          Grid cleared. Assets secured on-chain.
        </p>
        <div className="flex justify-center gap-6 mb-6">
          <div>
            <div className="font-headline text-[10px] text-on-surface-variant tracking-widest mb-0.5">
              MULTIPLIER
            </div>
            <div className="font-headline text-2xl font-bold text-secondary">
              {state.multiplier.toFixed(2)}×
            </div>
          </div>
          <div className="w-px bg-outline-variant/15" />
          <div>
            <div className="font-headline text-[10px] text-on-surface-variant tracking-widest mb-0.5">
              PAYOUT
            </div>
            <div className="font-headline text-2xl font-bold text-primary">
              +{state.payout.toFixed(3)} SOL
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              close();
              resetGame();
            }}
            className="flex-1 py-3 bg-gradient-to-r from-primary to-primary-container text-on-primary font-headline font-bold text-xs tracking-widest hover:brightness-110 active:scale-95"
          >
            PLAY AGAIN
          </button>
          <button
            onClick={close}
            className="py-3 px-5 border border-outline-variant/15 text-on-surface-variant font-headline font-bold text-xs tracking-widest hover:bg-surface-container-highest"
          >
            CLOSE
          </button>
        </div>
      </div>
    </div>
  );
}

function LoseModal() {
  const { close } = useModal();
  const { state, resetGame } = useGame();
  return (
    <div
      className="fixed inset-0 z-[90] modal-backdrop flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="bg-surface-container-low border border-tertiary-container/15 w-[90vw] max-w-[420px] text-center py-8 px-6">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-tertiary-container/10 border-2 border-tertiary-container flex items-center justify-center">
          <span
            className="material-symbols-outlined text-tertiary mi"
            style={{ fontSize: 36 }}
          >
            emergency
          </span>
        </div>
        <h2 className="font-headline text-2xl font-black italic tracking-tighter text-tertiary-container mb-1">
          DETONATION
        </h2>
        <p className="text-on-surface-variant text-xs mb-6">Mine triggered. Bet lost on-chain.</p>
        <div className="flex justify-center gap-6 mb-6">
          <div>
            <div className="font-headline text-[10px] text-on-surface-variant tracking-widest mb-0.5">
              CLEARED
            </div>
            <div className="font-headline text-2xl font-bold text-on-surface">
              {state.safeTiles.size}
            </div>
          </div>
          <div className="w-px bg-outline-variant/15" />
          <div>
            <div className="font-headline text-[10px] text-on-surface-variant tracking-widest mb-0.5">
              LOST
            </div>
            <div className="font-headline text-2xl font-bold text-error">
              -{state.bet.toFixed(3)} SOL
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              close();
              resetGame();
            }}
            className="flex-1 py-3 bg-gradient-to-r from-tertiary-container to-tertiary text-on-primary font-headline font-bold text-xs tracking-widest hover:brightness-110 active:scale-95"
          >
            TRY AGAIN
          </button>
          <button
            onClick={close}
            className="py-3 px-5 border border-outline-variant/15 text-on-surface-variant font-headline font-bold text-xs tracking-widest hover:bg-surface-container-highest"
          >
            CLOSE
          </button>
        </div>
      </div>
    </div>
  );
}
