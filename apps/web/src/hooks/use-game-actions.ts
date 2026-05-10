"use client";
import { useCallback } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { usePrivy } from "@privy-io/react-auth";
import {
  useSolanaWallets as useWallets,
  useSignTransaction,
} from "@privy-io/react-auth/solana";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { calcMultiplier } from "@playkaboom/shared";
import { deriveGamePda, deserializeIx, type SerializedIx } from "@playkaboom/sdk";
import { apiCleanup, apiCommit, apiReveal, apiSettle, ApiClientError } from "@/lib/api";
import { confirmByPolling } from "@/lib/confirm";
import { buildPriorityIxs } from "@/lib/priority-fee";
import { PROGRAM_ID } from "@/lib/cluster";
import { decodeProgramError } from "@/lib/program-errors";
import { awaitAccountChangeWs, awaitSigConfirmedWs } from "@/lib/ws-confirm";
import { useGameStore, type GameResult } from "@/stores/game-store";
import { useHistoryStore } from "@/stores/history-store";
import { useToast } from "@/components/providers/toast";

const HOUSE_EDGE_BPS = 200;

interface ActionsResult {
  authenticated: boolean;
  walletAddress: string | undefined;
  startGame: () => Promise<void>;
  revealTile: (idx: number) => Promise<void>;
  cashOut: () => Promise<void>;
  resetGame: () => void;
  cleanupStuck: () => Promise<boolean>;
  login: () => void;
  logout: () => Promise<void>;
}

export function useGameActions(): ActionsResult {
  const { authenticated, login, logout, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  // useSignTransaction is for Privy embedded wallets and accepts a Transaction
  // object directly (returns a signed Transaction). useStandardSignTransaction
  // expects pre-serialized bytes for external Wallet-Standard wallets — wrong
  // hook for our embedded-wallet config and was throwing
  // "n.serializeMessage is not a function" because Privy's standard handler
  // tried to deserialize our legacy-tx bytes as a VersionedTransaction.
  const { signTransaction } = useSignTransaction();
  const { connection } = useConnection();
  const store = useGameStore();
  const pushHistory = useHistoryStore((s) => s.push);
  const { toast } = useToast();

  const wallet = wallets[0];
  const walletAddress = wallet?.address;

  // Sign + broadcast a player tx, returning the signature AND a
  // confirmation promise. Caller updates UI on `sig` immediately
  // (optimistic — RPC has acknowledged the tx) and attaches a follow-up
  // .then/.catch to `confirmation` for the eventual outcome.
  //
  // This split exists because awaiting confirmByPolling before returning
  // (the old shape) gave the UI no way to render an in-flight tx for the
  // 1.5-3s confirm window. Worse: if confirmByPolling threw on
  // "blockhash expired" while the tx actually landed in the last valid
  // block, the caller treated it as failure and reverted local state to
  // idle — but the on-chain game stayed active. Refreshing the page
  // surfaced "you have an active game". Optimistic return + background
  // confirm fixes both: UI updates within ~200ms of click, and a tx that
  // lands but never gets a confirm signal still produces correct local
  // state (because we set "playing" the moment we have a sig).
  const signAndBroadcast = useCallback(
    async (ix: TransactionInstruction): Promise<{ sig: string; confirmation: Promise<string> }> => {
      if (!wallet) throw new Error("No wallet");
      const payer = new PublicKey(wallet.address);
      const [{ blockhash, lastValidBlockHeight }, priorityIxs] = await Promise.all([
        connection.getLatestBlockhash("processed"),
        buildPriorityIxs(connection, PROGRAM_ID),
      ]);
      const tx = new Transaction();
      for (const pix of priorityIxs) tx.add(pix);
      tx.add(ix);
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = payer;
      const signed = await signTransaction({ transaction: tx, connection, address: wallet.address });
      const raw =
        signed instanceof VersionedTransaction
          ? signed.serialize()
          : (signed as Transaction).serialize();
      const sig = await connection.sendRawTransaction(raw, { skipPreflight: true });
      // Confirmation: race awaitSigConfirmedWs (Connection's WS,
      // includes pre-flight status check that short-circuits for
      // already-finalized sigs) against confirmByPolling. Whichever
      // resolves first wins. AggregateError from Promise.any unwrapped
      // to its most useful cause for the caller's toast.
      const confirmation = (async () => {
        try {
          await Promise.any([
            awaitSigConfirmedWs(connection, sig, "confirmed", 12_000).then(() => "ws"),
            confirmByPolling(connection, sig, blockhash, lastValidBlockHeight).then(() => "poll"),
          ]);
          return sig;
        } catch (raceErr) {
          // Last-ditch sigStatus before bubbling — handles
          // "blockhash expired but tx landed" race.
          try {
            const { value } = await connection.getSignatureStatuses([sig]);
            const s = value[0];
            if (
              s &&
              !s.err &&
              (s.confirmationStatus === "processed" ||
                s.confirmationStatus === "confirmed" ||
                s.confirmationStatus === "finalized")
            ) {
              return sig;
            }
          } catch {
            /* fall through */
          }
          // Prefer the polling rejection's message over the
          // AggregateError wrapper; polling carries actionable text
          // ("blockhash expired", etc).
          if (raceErr instanceof AggregateError) {
            const pollErr = raceErr.errors.find(
              (e) => e instanceof Error && !/ws (sig|account)/.test(e.message),
            );
            throw pollErr ?? raceErr.errors[0] ?? raceErr;
          }
          throw raceErr instanceof Error ? raceErr : new Error(String(raceErr));
        }
      })();
      return { sig, confirmation };
    },
    [wallet, connection, signTransaction],
  );

  // Backwards-compatible "await confirm before returning" wrapper for the
  // few callers that genuinely need the post-confirm guarantee (e.g. close
  // ix in cashOut chain). The optimistic signAndBroadcast above is the
  // default for anything user-initiated where UI responsiveness matters.
  const signAndSend = useCallback(
    async (ix: TransactionInstruction): Promise<string> => {
      const { confirmation } = await signAndBroadcast(ix);
      return confirmation;
    },
    [signAndBroadcast],
  );

  // Cleanup a stuck on-chain GameSession PDA from a previous interrupted
  // round. The server determines which recovery ix to dispatch based on the
  // current on-chain status (close_game / close_unsettled_game /
  // refund_expired) and tells us if the slot timer has elapsed yet.
  //
  // Always emits a toast on non-success so the user sees feedback even when
  // they're not looking at the inline error block in Grid.
  const cleanupStuck = useCallback(async (): Promise<boolean> => {
    if (!walletAddress) return false;
    store.setStatus("cleaning");
    try {
      const data = await apiCleanup({
        player: walletAddress,
        gameToken: store.gameToken ?? undefined,
      });
      if (!data.active) {
        store.setGameToken(null);
        store.setStatus("idle");
        return true;
      }

      const trySend = async (ix: SerializedIx) => {
        try {
          await signAndSend(deserializeIx(ix));
          store.setGameToken(null);
          store.setStatus("idle");
          store.setError(null);
          return true;
        } catch (err) {
          const friendly = decodeProgramError(
            err instanceof Error ? err.message : "Cleanup tx failed",
          );
          store.setStatus("idle");
          store.setError(friendly);
          toast(friendly, "error");
          return false;
        }
      };

      switch (data.action) {
        case "close_game":
        case "close_unsettled_game":
        case "refund_expired":
          return await trySend(data.instruction);
        case "wait_close_unsettled": {
          const secs = data.secondsUntilReady;
          const msg = `Stuck game from a previous round. Force-close available in ~${secs}s. Scroll down for FORCE CLOSE button.`;
          store.setStatus("idle");
          store.setError(msg);
          toast(msg, "amber");
          return false;
        }
        case "wait_refund": {
          const secs = data.secondsUntilReady;
          const msg = `Active game in progress. Refund available in ~${secs}s. Scroll down for REFUND BET button.`;
          store.setStatus("idle");
          store.setError(msg);
          toast(msg, "amber");
          return false;
        }
        case "unknown": {
          // Fallback path — server couldn't decode, try close then refund.
          if (await trySend(data.closeInstruction)) return true;
          return await trySend(data.refundInstruction);
        }
      }
      return false;
    } catch (err) {
      const friendly = decodeProgramError(
        err instanceof Error ? err.message : "Cleanup failed",
      );
      store.setStatus("idle");
      store.setError(friendly);
      toast(friendly, "error");
      return false;
    }
  }, [walletAddress, store, signAndSend, toast]);

  const startGame = useCallback(async () => {
    // CRITICAL: setStatus FIRST, before any early-return paths. If we
    // bail before flipping isLocked, BetControls' lockStartedAtRef
    // (set synchronously by handleStart) never transitions out of the
    // pending state and EVERY subsequent click is silently dropped
    // until something else clears it — exactly the "button stuck,
    // game starts later" symptom. Flipping status to "starting" first
    // guarantees the reactive lock fires; if we bail, we revert.
    store.setStatus("starting");
    store.setError(null);
    // eslint-disable-next-line no-console
    console.log("[startGame] click received, status=starting");

    if (!authenticated) {
      // eslint-disable-next-line no-console
      console.warn("[startGame] not authenticated — redirecting to login");
      store.setStatus("idle");
      login();
      return;
    }
    if (!walletAddress) {
      // eslint-disable-next-line no-console
      console.warn("[startGame] no wallet address — Privy hydration race?");
      store.setStatus("idle");
      store.setError("Wallet not ready — try again in a second.");
      toast("Wallet not ready — try again in a second.", "amber");
      return;
    }

    const betLamports = BigInt(Math.round(store.bet * LAMPORTS_PER_SOL));
    const tryCommit = () =>
      apiCommit({ player: walletAddress, mineCount: store.mineCount, betLamports });

    let commit;
    try {
      commit = await tryCommit();
    } catch (err) {
      const isCleanupNeeded =
        err instanceof ApiClientError && err.payload.needsCleanup === true;
      if (isCleanupNeeded) {
        const cleaned = await cleanupStuck();
        if (cleaned) {
          try {
            commit = await tryCommit();
          } catch (retryErr) {
            const msg = decodeProgramError(
              retryErr instanceof Error ? retryErr.message : "Failed to start",
            );
            store.setStatus("idle");
            store.setError(msg);
            toast(msg, "error");
            return;
          }
        } else {
          // cleanupStuck has already set its own precise error/toast
          // (wait_close_unsettled / wait_refund / on-chain failure).
          // Don't overwrite it with the generic 409 message.
          store.setStatus("idle");
          return;
        }
      } else {
        const msg = decodeProgramError(err instanceof Error ? err.message : "Failed to start");
        store.setStatus("idle");
        store.setError(msg);
        toast(msg, "error");
        return;
      }
    }

    store.setGameToken(commit.gameToken);
    try {
      // Optimistic flow: as soon as the RPC ACKs the tx (~200ms), flip
      // the local UI to "playing" with the sig. This is the fix for the
      // recurring "I clicked ENGAGE, nothing happened on screen, but a
      // game started in the background" report — the OLD code awaited
      // confirmByPolling (1.5-3s) before updating UI, and on confirm
      // timeout it reverted to idle while the tx landed anyway.
      const { sig, confirmation } = await signAndBroadcast(deserializeIx(commit.instruction));
      store.beginGame(commit.commitment, sig);
      // Background confirm. If it fails after we've optimistically
      // entered "playing", the next /api/session probe will reveal
      // truth (on-chain game exists or not) and the banner will show.
      // We deliberately do NOT setStatus("idle") here — that would
      // recreate the original race the optimistic path is solving.
      void confirmation.catch((err) => {
        const msg = err instanceof Error ? err.message : "Confirmation timed out";
        // eslint-disable-next-line no-console
        console.warn("[startGame] confirmation problem:", msg);
        toast(`Confirmation slow — your game may take an extra moment to load`, "amber");
      });
    } catch (err) {
      // sendRawTransaction or sign actually threw (user rejected, RPC
      // rejected the tx outright, etc.) — no sig was produced, safe to
      // revert.
      store.setStatus("idle");
      store.setError(decodeProgramError(err instanceof Error ? err.message : "Sign failed"));
    }
  }, [authenticated, walletAddress, store, signAndBroadcast, cleanupStuck, login, toast]);

  const revealTile = useCallback(
    async (idx: number) => {
      const s = useGameStore.getState();
      if (s.status !== "playing" || s.pendingTile !== null) return;
      if (s.revealedTiles.has(idx)) return;
      if (!walletAddress || !s.gameToken) return;

      store.setPendingTile(idx);
      store.setStatus("revealing");

      try {
        const data = await apiReveal({
          player: walletAddress,
          tileIndex: idx,
          gameToken: s.gameToken,
        });
        if (data.isMine) {
          // G4: server already deleted its session row and returned an empty
          // gameToken. Clear localStorage immediately (don't wait for the
          // close ix to land) so a tab-close in the next 2s can't leave an
          // orphan token pointing at a Lost game.
          store.setGameToken(null);
          store.applyMineReveal(idx, data.signature);
          pushHistory(makeResult(s, walletAddress, false, 0, data.signature));
          if (data.closeInstruction) {
            // Mark close in flight — BetControls disables Engage until
            // the on-chain GameSession PDA is verifiably closed (or 30s
            // deadline elapses, in which case the recovery banner takes
            // over). Reveal-on-mine bundles [reveal, settle] in the
            // same on-chain tx, so once apiReveal returns the prereq
            // state for close_game (Lost+settled) is at least ack'd by
            // the leader. 500ms grace before first attempt; retry once
            // after 800ms; pendingClose holds until on-chain truth.
            store.setPendingClose(true);
            const closeIxBytes = data.closeInstruction;
            const player = walletAddress;
            void (async () => {
              try {
                await new Promise((r) => setTimeout(r, 500));
                try {
                  await signAndSend(deserializeIx(closeIxBytes));
                } catch {
                  await new Promise((r) => setTimeout(r, 800));
                  await signAndSend(deserializeIx(closeIxBytes)).catch(() => {});
                }
              } catch {
                /* sign errors handled inside signAndSend */
              }
              // ALWAYS wait for on-chain truth before releasing the
              // lock. Mirrors cashOut/bg — the close ix may have
              // landed even if signAndSend's confirmation threw, and
              // /api/commit reads the same chain state for its
              // playerHasActiveGame check. Releasing too early ⇒ user
              // clicks engage ⇒ 409.
              try {
                const [gamePda] = deriveGamePda(PROGRAM_ID, new PublicKey(player));
                const wsClosed = awaitAccountChangeWs(
                  connection,
                  gamePda,
                  (info) => info === null || info.lamports === 0,
                  30_000,
                );
                const pollClosed = (async () => {
                  const deadline = Date.now() + 30_000;
                  while (Date.now() < deadline) {
                    try {
                      const info = await connection.getAccountInfo(gamePda, "confirmed");
                      if (info === null) return;
                    } catch {
                      /* network blip — try again */
                    }
                    await new Promise((r) => setTimeout(r, 1_000));
                  }
                  throw new Error("poll deadline reached");
                })();
                await Promise.any([wsClosed, pollClosed]);
                // eslint-disable-next-line no-console
                console.log("[mine/bg] on-chain GameSession verified gone");
              } catch {
                // eslint-disable-next-line no-console
                console.warn("[mine/bg] PDA still present after 30s — releasing lock anyway; banner will show recovery");
              } finally {
                store.setPendingClose(false);
              }
            })();
          }
        } else {
          // Safe reveal: server returned the rotated session token; persist it.
          store.setGameToken(data.gameToken);
          const next = calcMultiplier(s.safeTiles.size + 1, s.mineCount, HOUSE_EDGE_BPS);
          store.applySafeReveal(idx, next, data.signature);
        }
      } catch (err) {
        // G1: server refused to fire the FINAL safe reveal because that
        // would auto-flip on-chain status to Won and lock out cash_out.
        // Surface a clear prompt + leave status on "playing" so the Cash
        // Out button stays live. Do NOT attempt an automatic cashOut —
        // user explicitly initiates the claim.
        if (err instanceof ApiClientError && err.payload.needsCashOut === true) {
          const msg =
            "That was the last safe tile — click EXIT & WITHDRAW to claim your winnings.";
          store.setStatus("playing");
          store.setPendingTile(null);
          store.setError(msg);
          toast(msg, "amber");
          return;
        }
        const friendly = decodeProgramError(
          err instanceof Error ? err.message : "Reveal failed",
        );
        store.setStatus("playing");
        store.setPendingTile(null);
        store.setError(friendly);
        toast(friendly, "error");
      }
    },
    [walletAddress, store, signAndSend, pushHistory, toast],
  );

  const cashOut = useCallback(async () => {
    const s = useGameStore.getState();
    // Loud guards: previously these returned silently and the click looked
    // dead to the user. Now every blocked path either toasts or attempts
    // recovery (re-fetch session from server when local token is missing).
    if (!walletAddress) {
      const msg = "Wallet not connected — reconnect and try again.";
      store.setError(msg);
      toast(msg, "error");
      return;
    }
    if (s.status !== "playing") {
      const msg = `Cannot cash out from status "${s.status}" — refresh the page.`;
      store.setError(msg);
      toast(msg, "error");
      return;
    }
    if (s.safeTiles.size === 0) {
      const msg = "No safe tiles revealed yet — reveal at least one before cashing out.";
      store.setError(msg);
      toast(msg, "error");
      return;
    }
    // Recovery: gameToken missing locally → fetch from server's session
    // mirror, hydrate the store, then proceed with cashOut. Most common
    // cause is a state desync after a "Tile already revealed" or other
    // mid-game error that left the client out of step with the server.
    let token = s.gameToken;
    if (!token) {
      try {
        const accessToken = await getAccessToken();
        const res = await fetch(`/api/session/${walletAddress}`, {
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
          cache: "no-store",
        });
        if (res.ok) {
          const data = (await res.json()) as { gameToken?: string | null };
          if (data.gameToken) {
            token = data.gameToken;
            store.setGameToken(token);
          }
        }
      } catch {
        /* fall through to error below */
      }
      if (!token) {
        const msg = "Game session lost — use FORCE CLOSE in the recovery banner above to refund and start a new round.";
        store.setError(msg);
        toast(msg, "error");
        return;
      }
    }
    store.setStatus("cashing");

    try {
      // eslint-disable-next-line no-console
      console.log("[cashOut] requesting cashout ix from server");
      const cashRes = await apiSettle({ player: walletAddress, gameToken: token });
      if (!("phase" in cashRes) || cashRes.phase !== "cashout") {
        const msg = "Unexpected cash-out response from server. Try again.";
        store.setStatus("playing");
        store.setError(msg);
        toast(msg, "error");
        // eslint-disable-next-line no-console
        console.warn("[cashOut] unexpected response shape:", cashRes);
        return;
      }
      // eslint-disable-next-line no-console
      console.log("[cashOut] signing + broadcasting cash_out ix");

      // OPTIMISTIC pattern (same as startGame): broadcast the tx, get
      // the sig back immediately (~200ms after RPC ACK), then update
      // local state as if it succeeded. Confirmation runs in background.
      // The OLD code awaited full confirm before applying payout, which
      // meant the user stared at "CASHING OUT…" for 1.5-3s with no
      // progress; if confirm timed out before the tx landed, we toasted
      // an error and reverted to "playing" while the SOL had actually
      // moved on chain. Net: user "lost" their cashout from the UI's
      // perspective even though the on-chain state was correct.
      const { sig, confirmation } = await signAndBroadcast(
        deserializeIx(cashRes.instruction),
      );
      // eslint-disable-next-line no-console
      console.log("[cashOut] tx broadcast, sig:", sig);

      const payout = s.bet * s.multiplier;
      store.applyCashOut(payout);
      pushHistory(makeResult(s, walletAddress, true, payout, sig));
      store.setGameToken(null);
      store.setPendingClose(true);

      // Confirmation + downstream settle/close all run in background.
      // UI is already at "won" with the WinModal opening; if any of
      // this fails, we toast a warning but DO NOT revert the won state
      // — the cash_out tx itself is what moved the SOL, so the player
      // got paid as long as that one landed.
      const settleToken: string = token;
      const player = walletAddress;

      void confirmation
        .then(() => {
          // eslint-disable-next-line no-console
          console.log("[cashOut] cash_out tx confirmed");
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn("[cashOut] confirm failed:", err);
          toast("Cashout confirmation slow — winnings will arrive momentarily", "amber");
        });

      void (async () => {
        // Wait for cash_out to confirm on chain before calling /api/settle.
        // settle_game requires game.status == Won|Lost, and cash_out is what
        // flips status from Playing → Won. If we don't wait, settle_game
        // lands first and errors GameNotPlaying.
        // Swallow rejection (toast already fired in the parallel
        // confirmation handler above) — try the bg work anyway.
        await confirmation.catch(() => {});

        // Server-side settle + close: best-effort. If anything here
        // throws we still fall through to the PDA-close watch below
        // (which is what the engage-button lock actually waits on).
        try {
          // eslint-disable-next-line no-console
          console.log("[cashOut/bg] running server settle + close");
          const settleRes = await apiSettle({ player, gameToken: settleToken, phase: "settle" });

          // CRITICAL: await on-chain confirmation of settle_game before
          // calling /api/cleanup. /api/settle returns the sig as soon as
          // RPC ACKs the send (sendHouseTx doesn't await confirmation).
          // If we call /api/cleanup immediately, it reads game state at
          // "confirmed" and sees Won+!settled (the just-sent settle_game
          // hasn't propagated yet). Server then tries to re-settle, but
          // the session row was deleted by /api/settle on its successful
          // send — so /api/cleanup falls back to wait_close_unsettled
          // and returns no actionable ix. The bg flow then sends nothing,
          // the PDA stays alive, and the 30s deadline below fires. This
          // is the "[cashOut/bg] PDA still present after 30s" stuck case.
          if ("signature" in settleRes) {
            await awaitSigConfirmedWs(connection, settleRes.signature, "confirmed", 12_000)
              .catch(() => {
                // Fall back to a short status poll — confirmByPolling
                // would need a blockhash we don't have, so just spin
                // getSignatureStatuses for up to 6s.
                return (async () => {
                  const deadline = Date.now() + 6_000;
                  while (Date.now() < deadline) {
                    try {
                      const r = await connection.getSignatureStatuses([settleRes.signature]);
                      const v = r.value[0];
                      if (v && !v.err && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) return;
                    } catch { /* network blip */ }
                    await new Promise((r) => setTimeout(r, 500));
                  }
                })();
              });
          }

          const c = await apiCleanup({ player });
          if (c.active && (c.action === "close_game" || c.action === "close_unsettled_game")) {
            // Fire-and-forget — don't strictly await confirmation here
            // because confirmByPolling can throw "expired" while the tx
            // actually landed. We poll on-chain below for the PDA's
            // actual deletion, which is the source of truth.
            void signAndSend(deserializeIx(c.instruction)).catch(() => {});
          } else if (c.active) {
            // eslint-disable-next-line no-console
            console.warn("[cashOut/bg] cleanup returned non-actionable:", c.action);
          }
        } catch (bgErr) {
          // eslint-disable-next-line no-console
          console.warn("[cashOut/bg] settle/cleanup non-fatal:", bgErr);
        }

        // Engage button stays locked via pendingClose until the on-chain
        // GameSession PDA is verifiably gone (or the 30s deadline
        // elapses, in which case the recovery banner takes over). This
        // block runs unconditionally — even if settle/cleanup above
        // failed, we still wait for chain truth before unlocking, so
        // the player can never start a new game while the previous PDA
        // is still alive on chain.
        try {
          const [gamePda] = deriveGamePda(PROGRAM_ID, new PublicKey(player));
          const wsClosed = awaitAccountChangeWs(
            connection,
            gamePda,
            (info) => info === null || info.lamports === 0,
            30_000,
          );
          const pollClosed = (async () => {
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
              try {
                const info = await connection.getAccountInfo(gamePda, "confirmed");
                if (info === null) return;
              } catch {
                /* network blip — try again */
              }
              await new Promise((r) => setTimeout(r, 1_000));
            }
            throw new Error("poll deadline reached");
          })();
          await Promise.any([wsClosed, pollClosed]);
          // eslint-disable-next-line no-console
          console.log("[cashOut/bg] on-chain GameSession verified gone");
        } catch {
          // eslint-disable-next-line no-console
          console.warn("[cashOut/bg] PDA still present after 30s — releasing lock anyway; banner will show recovery");
        } finally {
          store.setPendingClose(false);
        }
      })();
    } catch (err) {
      // This catch only fires for failures BEFORE the tx is broadcast
      // (apiSettle 4xx/5xx, sign rejected, sendRawTransaction error).
      // Once we have a sig, the optimistic path above runs and the
      // confirmation .catch handles post-broadcast issues without
      // reverting UI. So this path is "true failure, no tx in flight".
      const friendly = decodeProgramError(
        err instanceof Error ? err.message : "Cash out failed",
      );
      // eslint-disable-next-line no-console
      console.error("[cashOut] pre-broadcast failure:", err);
      store.setStatus("playing");
      store.setError(friendly);
      toast(friendly, "error");
    }
  }, [walletAddress, store, signAndBroadcast, signAndSend, pushHistory, toast, getAccessToken]);

  return {
    authenticated,
    walletAddress,
    startGame,
    revealTile,
    cashOut,
    resetGame: store.reset,
    cleanupStuck,
    login,
    logout,
  };
}

function makeResult(
  s: ReturnType<typeof useGameStore.getState>,
  player: string,
  won: boolean,
  payout: number,
  txHash: string,
): GameResult {
  return {
    gameId: String(Date.now()),
    player,
    won,
    bet: s.bet,
    payout,
    multiplier: won ? s.multiplier : 0,
    mineCount: s.mineCount,
    tilesCleared: s.safeTiles.size,
    txHash,
    timestamp: Date.now(),
  };
}
