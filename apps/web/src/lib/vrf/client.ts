// Per-click VRF-in-Ephemeral-Rollup game engine (client-side, framework-agnostic).
//
// Ports the proven spike flow onto the @playkaboom/sdk VRF builders. React
// wiring (Privy signing, the game store) lives in the hook that calls this.
//
// Signing model: the PLAYER's real wallet signs start_game_vrf + delegate_vrf
// (two popups at game start); a per-game ephemeral SESSION keypair signs every
// reveal in the rollup (no popups). settle_vrf / refund_stalled_vrf are
// permissionless (driven by the backend worker) so the player needs no closing
// popup.
//
// Browser note: web3.js WS `confirmTransaction` is unreliable in-browser, so we
// build → sign → sendRaw → POLL getSignatureStatuses.

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  buildStartGameVrf,
  buildDelegateVrf,
  buildRevealRequestVrf,
  buildCashOutVrf,
  buildSettleAndUndelegateVrf,
  deriveVrfGamePda,
  decodeVrfGame,
  type VrfGameAccount,
} from "@playkaboom/sdk";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A player-side signer: takes a Transaction, returns it signed (e.g. Privy). */
export type SignTx = (tx: Transaction) => Promise<Transaction>;

/**
 * Poll-based confirmation (browser-safe).
 *
 * Two things this has to get right, both learned the hard way:
 *
 * 1. POLL LONG ENOUGH. 40s was too short. sendRawTransaction keeps
 *    rebroadcasting until the blockhash dies (~150 blocks, 60-90s), so a
 *    congested slot can land the transaction AFTER a 40s window gave up — the
 *    player saw "confirm timeout" for a start_game_vrf that had in fact landed,
 *    locking their bet in a game the UI believed never began. Poll to the real
 *    deadline instead of an arbitrary one.
 *
 * 2. ASK PROPERLY BEFORE DECLARING FAILURE. getSignatureStatuses only consults
 *    the recent-status cache; anything older returns null, which is
 *    indistinguishable from "never landed". So the final word is a lookup with
 *    searchTransactionHistory — otherwise we report failure for a transaction
 *    that is sitting on chain, confirmed.
 */
export async function pollConfirm(conn: Connection, sig: string, tries = 180): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error("tx failed: " + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return;
    await sleep(500);
  }
  // Authoritative last check before calling it lost.
  try {
    const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
    if (st?.err) throw new Error("tx failed: " + JSON.stringify(st.err));
    if (st) return; // it landed after all
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("tx failed")) throw e;
    /* history lookup unavailable — fall through to the timeout below */
  }
  throw new Error(
    `Transaction was submitted but not confirmed in time (${sig.slice(0, 8)}…). ` +
      "It may still land — reload before retrying so you don't start a second game.",
  );
}

/**
 * Does this error mean the transaction's blockhash aged out before it landed?
 *
 * Matched on message text because the error surfaces from several layers —
 * the RPC ("Blockhash not found"), web3.js
 * (TransactionExpiredBlockheightExceededError) and the wallet adapter — with
 * no shared error code between them.
 */
function isBlockhashExpired(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase();
  return (
    m.includes("blockhash not found") ||
    m.includes("block height exceeded") ||
    m.includes("blockheightexceeded") ||
    m.includes("transaction expired")
  );
}

/** Build → sign → send → poll-confirm one or more instructions. */
async function sendIx(
  conn: Connection,
  ix: TransactionInstruction | TransactionInstruction[],
  feePayer: PublicKey,
  sign: SignTx,
  /**
   * Optional check of the EFFECT this transaction was meant to have.
   *
   * Confirmation polling is a proxy for "did it work", and a lossy one: RPC
   * status caches lag, a node can miss a signature it did not index, and the
   * poll can simply expire while the transaction is landing. Treating that
   * proxy as authoritative is what produced "submitted but not confirmed in
   * time" on transactions that had, in fact, executed — sending the player to
   * a recovery flow for a game that was live and playable.
   *
   * When supplied, this outranks the poll: if the intended state exists on
   * chain, the operation succeeded, whatever the poll believed.
   */
  effectLanded?: () => Promise<boolean>,
): Promise<string> {
  const build = async () => {
    const t = new Transaction().add(...(Array.isArray(ix) ? ix : [ix]));
    t.feePayer = feePayer;
    t.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    return sign(t);
  };

  // A blockhash is only valid for ~150 blocks (60-90s), and it is fetched
  // BEFORE the player approves in their wallet. Take longer than that to hit
  // confirm and the send is rejected outright: no transaction ever reaches the
  // chain, the bet never starts, and all the player sees is a timeout. Sign
  // again against a fresh blockhash rather than losing the round.
  //
  // Safe to retry: nothing landed. A genuinely-landed transaction cannot
  // produce this error, and the duplicate would be rejected on its own terms
  // anyway (start_game_vrf hits "account already in use", reveals hit
  // TileAlreadyRevealed). Retried ONCE, and ONLY on an expiry signal — never
  // blind-retry a money instruction.
  let signed: Transaction;
  try {
    signed = await build();
  } catch (e) {
    if (!isBlockhashExpired(e)) throw e;
    signed = await build();
  }
  // Preflight ON for player-signed transactions, matching the commit-reveal
  // path: a deterministic failure (bet over the cap, stale state) should be
  // rejected up front rather than costing the player a fee and surfacing as a
  // generic timeout 40s later.
  let sig: string;
  try {
    sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 5 });
  } catch (e) {
    if (!isBlockhashExpired(e)) throw e;
    // Approval outlived the blockhash. Re-sign against a current one.
    const fresh = await build();
    sig = await conn.sendRawTransaction(fresh.serialize(), { skipPreflight: false, maxRetries: 5 });
  }
  try {
    await pollConfirm(conn, sig);
  } catch (e) {
    // The poll gave up. Before surfacing a failure that would send the player
    // into recovery, ask the chain whether the work actually happened. Retried
    // briefly because a transaction landing right at the deadline needs a
    // moment to become visible.
    if (effectLanded) {
      for (let i = 0; i < 6; i++) {
        try {
          if (await effectLanded()) return sig;
        } catch {
          /* transient RPC — keep trying */
        }
        await sleep(1_000);
      }
    }
    throw e;
  }
  return sig;
}

/** Wrap a raw Keypair as a SignTx (for the session key). */
export function keypairSigner(kp: Keypair): SignTx {
  return async (tx: Transaction) => {
    tx.partialSign(kp);
    return tx;
  };
}

export interface VrfEngineConfig {
  /** Base-layer (L1) connection — the app's RPC proxy. */
  l1: Connection;
  /** Ephemeral-rollup connection (MagicBlock ER RPC/WS). */
  er: Connection;
  programId: PublicKey;
  /** VRF oracle queue for this cluster (omit for devnet default). */
  oracleQueue?: PublicKey;
}

/**
 * Gas budget handed to the throwaway session key so it can sign reveals in the
 * rollup without wallet popups. Rollup fees are ~free and VRF is free on the ER,
 * so this is generous headroom for a 16-reveal game plus the commit.
 *
 * The PLAYER funds this, not the house, and it rides inside the start
 * transaction (see below). An operator-sponsored version of this was a
 * replayable faucet — a read-then-pay endpoint with no idempotency, so anyone
 * could loop it and drain the shared house signer — and it was also badly
 * loss-making, sponsoring far more per game than the house edge earns.
 */
export const SESSION_FUND_LAMPORTS = Math.floor(0.002 * LAMPORTS_PER_SOL);

export interface StartedVrfGame {
  gamePda: PublicKey;
  /** Ephemeral session keypair, funded in the start tx; signs all reveals. */
  session: Keypair;
  startSig: string;
  delegateSig: string;
}

/**
 * L1: player signs start_game_vrf (bet locked, worst-case reserved) + delegate_vrf
 * (reveal PDA handed to the ER).
 *
 * Session funding is ATOMIC with the game start — same transaction, so it can
 * happen exactly once per game: `start_game_vrf` uses `init`, so a replay of
 * this transaction fails on the already-initialised PDA and the transfer dies
 * with it. That property is what makes the funding un-farmable.
 */
export async function startVrfGame(
  cfg: VrfEngineConfig,
  player: PublicKey,
  signPlayer: SignTx,
  mineCount: number,
  betLamports: bigint,
  /**
   * Invoked with the session keypair the instant it is generated, BEFORE any
   * transaction is sent. Persist it here.
   *
   * This ordering is load-bearing. A send can throw for a transaction that
   * actually landed (poll timeout, RPC hiccup), so if the key were only handed
   * back on the fully-successful path, a delegate that lands-but-throws would
   * discard the one key able to bring that game back out of the rollup — and a
   * delegated game is deliberately not refundable. The bet would be stranded.
   */
  onSession?: (session: Keypair) => void,
  /**
   * Instructions to run first in the same atomic tx (set_referrer on a
   * referred player's first game: one signature, and settle_vrf can then
   * always find the referral PDA).
   */
  preIxs: TransactionInstruction[] = [],
): Promise<StartedVrfGame> {
  const session = Keypair.generate();
  onSession?.(session);
  const ctx = { programId: cfg.programId };
  const [gamePda] = deriveVrfGamePda(cfg.programId, player);

  // ONE ATOMIC TRANSACTION: start + fund the session key + delegate.
  //
  // This used to be TWO transactions with two confirmations. That gave the
  // flow a half-started state with no owner: if the first landed and the
  // second never fired — a confirm timeout, a dropped packet, a slow wallet —
  // the player's bet sat in a game that existed on L1 but had never reached
  // the rollup, so it could not be played, only refunded. Every "engage
  // failed but my SOL is gone" report traced to that window, and it recurred
  // every few games because it is a race, not a bug you can test away.
  //
  // Solana transactions are atomic, so folding delegate_vrf in removes the
  // window entirely: either the game exists AND is delegated AND the session
  // key is funded, or nothing happened at all. There is no third outcome to
  // recover from. Measured at 616 bytes of the 1232 limit and ~80k CU, so it
  // fits with room to spare.
  const sig = await sendIx(
    cfg.l1,
    [
      ...preIxs,
      buildStartGameVrf({ ctx, player, mineCount, betLamports, sessionKey: session.publicKey }),
      SystemProgram.transfer({
        fromPubkey: player,
        toPubkey: session.publicKey,
        lamports: SESSION_FUND_LAMPORTS,
      }),
      buildDelegateVrf({ ctx, player }),
    ],
    player,
    signPlayer,
    // Confirmation is advisory here, not authoritative. The chain is.
    async () => {
      const info = await cfg.l1.getAccountInfo(gamePda, "confirmed");
      // Delegated => the whole atomic transaction executed.
      return info !== null && !info.owner.equals(cfg.programId);
    },
  );
  return { gamePda, session, startSig: sig, delegateSig: sig };
}

/** Poll the reveal-state PDA (from L1 or ER) until `done` or timeout. */
export async function pollVrfGame(
  conn: Connection,
  programId: PublicKey,
  player: PublicKey,
  done: (g: VrfGameAccount) => boolean,
  timeoutMs: number,
): Promise<VrfGameAccount | null> {
  const [gamePda] = deriveVrfGamePda(programId, player);
  const t0 = Date.now();
  let last: VrfGameAccount | null = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const ai = await conn.getAccountInfo(gamePda, "processed");
      if (ai) {
        last = decodeVrfGame(ai.data as Buffer);
        if (done(last)) return last;
      }
    } catch {
      /* transient */
    }
    await sleep(700);
  }
  return last;
}

/**
 * ER: session-signed reveal of one tile, then poll until the VRF callback lands.
 * Returns the post-reveal game state (status 1=Won, 2=Lost, 0=still playing).
 */
export async function revealTileVrf(
  cfg: VrfEngineConfig,
  player: PublicKey,
  session: Keypair,
  tileIndex: number,
): Promise<VrfGameAccount | null> {
  const ctx = { programId: cfg.programId };
  const clientSeed = Math.floor(Math.random() * 256);
  await sendIx(
    cfg.er,
    buildRevealRequestVrf({ ctx, player, session: session.publicKey, tileIndex, clientSeed, oracleQueue: cfg.oracleQueue }),
    session.publicKey,
    keypairSigner(session),
  );
  return pollVrfGame(cfg.er, cfg.programId, player, (g) => !g.pending, 45_000);
}

/** ER: session (or player) signs cash_out — locks in the current multiplier. */
export async function cashOutVrf(
  cfg: VrfEngineConfig,
  player: PublicKey,
  session: Keypair,
): Promise<string> {
  const ctx = { programId: cfg.programId };
  return sendIx(
    cfg.er,
    buildCashOutVrf({ ctx, player, signer: session.publicKey }),
    session.publicKey,
    keypairSigner(session),
  );
}

/**
 * ER → L1: commit the reveal state back to base and undelegate. After this
 * lands and the committed game shows Won/Lost on L1, the backend settle worker
 * runs settle_vrf to pay the player.
 */
export async function settleAndUndelegateVrf(
  cfg: VrfEngineConfig,
  player: PublicKey,
  session: Keypair,
): Promise<string> {
  const ctx = { programId: cfg.programId };
  return sendIx(
    cfg.er,
    buildSettleAndUndelegateVrf({ ctx, player, payer: session.publicKey }),
    session.publicKey,
    keypairSigner(session),
  );
}

/**
 * Undelegate using the PLAYER's own wallet instead of the session key.
 *
 * `settle_and_undelegate_vrf` accepts `g.player` as well as `g.session_key`
 * (vrf_mode.rs: `signer == g.player || signer == g.session_key`), and this is
 * the ONLY route out of a delegated game when the session key is gone — a
 * cleared localStorage, a different browser, a different device.
 *
 * Without it the game is unrecoverable from the UI: `reveal_request_vrf`
 * demands the exact session key, `cash_out_vrf` needs safe_reveals > 0, and
 * `refund_stalled_vrf` deliberately refuses while the account is still
 * delegated. So the bet sits locked with no path forward.
 */
export async function settleAndUndelegateVrfAsPlayer(
  cfg: VrfEngineConfig,
  player: PublicKey,
  sign: SignTx,
): Promise<string> {
  const ctx = { programId: cfg.programId };
  return sendIx(
    cfg.er,
    buildSettleAndUndelegateVrf({ ctx, player, payer: player }),
    player,
    sign,
  );
}

/**
 * Cash out with the player's wallet. Same dual-signer allowance as above, so a
 * game that made progress still pays its earned multiplier when the session
 * key is gone, instead of being refunded down to the bare bet.
 */
export async function cashOutVrfAsPlayer(
  cfg: VrfEngineConfig,
  player: PublicKey,
  sign: SignTx,
): Promise<string> {
  const ctx = { programId: cfg.programId };
  return sendIx(cfg.er, buildCashOutVrf({ ctx, player, signer: player }), player, sign);
}

/**
 * Return whatever gas is left on the session key to the player.
 *
 * Without this the funding is a pure loss every round — at the minimum bet the
 * abandoned dust would exceed the bet itself, and it never reaches the vault or
 * treasury either, so it is worse than a fee for everyone.
 *
 * Returns true once the key holds nothing a sweep could move (swept now, or
 * already empty) — ONLY then may the caller forget the key. false means the
 * lamports are still there: keep the key and retry later. Forgetting a key
 * whose sweep failed lost 0.002 SOL (20% of a minimum bet) on 2026-11-05 (g18).
 *
 * g18 failed preflight with "Transaction simulation failed" and EMPTY logs: the
 * transaction never reached the program, i.e. the load-balanced RPC node that
 * simulated it was behind the one that served the blockhash/balance (same
 * transient as server/solana.ts isTransientPreflightError). So each attempt
 * re-reads the balance and sendIx signs against a fresh blockhash.
 *
 * Fee: asked of the cluster for this exact message, not assumed. The session
 * pays its own fee and must end at exactly 0 lamports — a guess that is low
 * fails the transfer, one that is high leaves a sub-rent remainder, which
 * fails too (InsufficientFundsForRent).
 */
export async function sweepSession(
  cfg: VrfEngineConfig,
  session: Keypair,
  player: PublicKey,
  attempts = 3,
): Promise<boolean> {
  const from = session.publicKey;
  const transfer = (lamports: number) => SystemProgram.transfer({ fromPubkey: from, toPubkey: player, lamports });
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(1_000 * i);
    try {
      const balance = await cfg.l1.getBalance(from, "confirmed");
      if (balance === 0) return true;
      const probe = new Transaction().add(transfer(balance));
      probe.feePayer = from;
      probe.recentBlockhash = (await cfg.l1.getLatestBlockhash("confirmed")).blockhash;
      const fee =
        (await cfg.l1.getFeeForMessage(probe.compileMessage(), "confirmed").then((r) => r.value, () => null)) ??
        5_000; // 1 signature, no priority fee
      if (balance <= fee) return true; // can't even pay its own fee: nothing recoverable
      await sendIx(cfg.l1, transfer(balance - fee), from, keypairSigner(session), async () =>
        (await cfg.l1.getBalance(from, "confirmed")) === 0,
      );
      return true;
    } catch (e) {
      console.warn(`[vrf] session sweep attempt ${i + 1}/${attempts} failed:`, e);
    }
  }
  return false;
}

/** Storage surface for keys awaiting a sweep (window.localStorage in the app). */
export type KeyStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** localStorage slot holding session keys of FINISHED rounds that still need a sweep. */
export const pendingSweepKey = (wallet: string) => `kaboom:vrf-sweep:${wallet}`;

export function readPendingSweeps(store: KeyStore | null, key: string): Keypair[] {
  let raw: string | null = null;
  try {
    raw = store?.getItem(key) ?? null;
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as number[][]).flatMap((s) => {
      try {
        return [Keypair.fromSecretKey(Uint8Array.from(s))];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function writePendingSweeps(store: KeyStore | null, key: string, kps: Keypair[]): void {
  try {
    if (kps.length) store?.setItem(key, JSON.stringify(kps.map((k) => Array.from(k.secretKey))));
    else store?.removeItem(key);
  } catch {
    /* storage unavailable — the in-tab sweep still runs */
  }
}

/** Record a finished round's session key so it survives until its sweep lands. */
export function addPendingSweep(store: KeyStore | null, key: string, kp: Keypair): void {
  const list = readPendingSweeps(store, key);
  if (!list.some((k) => k.publicKey.equals(kp.publicKey))) writePendingSweeps(store, key, [...list, kp]);
}

/**
 * The live slot is about to hold `next`. A DIFFERENT key still in it (a start
 * whose open-round read failed could not retire it) goes on the sweep list
 * first, so overwriting the slot never forgets a funded key. Parked only at the
 * moment it is overwritten, so a key the live slot still points at is never swept.
 */
export function parkReplacedSession(store: KeyStore | null, liveSlot: string, sweepSlot: string, next: Keypair): void {
  let prev: Keypair;
  try {
    const raw = store?.getItem(liveSlot);
    if (!raw) return;
    prev = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
  } catch {
    return;
  }
  if (!prev.publicKey.equals(next.publicKey)) addPendingSweep(store, sweepSlot, prev);
}

// Per-key single flight: the VRF hook is mounted in ~6 components at once.
const sweepsInFlight = new Set<string>();

/**
 * Sweep every pending key (plus `extra`) and forget ONLY the ones `sweep`
 * reports empty. A failed sweep stays on the list for the next mount or the
 * next round. Never throws.
 */
export async function sweepPendingSessions(
  store: KeyStore | null,
  key: string,
  sweep: (kp: Keypair) => Promise<boolean>,
  extra: Keypair[] = [],
): Promise<void> {
  await Promise.all(
    [...readPendingSweeps(store, key), ...extra].map(async (kp) => {
      const id = kp.publicKey.toBase58();
      if (sweepsInFlight.has(id)) return;
      sweepsInFlight.add(id);
      try {
        if (await sweep(kp)) {
          // Re-read: a key added while this sweep ran must not be dropped.
          writePendingSweeps(store, key, readPendingSweeps(store, key).filter((k) => !k.publicKey.equals(kp.publicKey)));
        }
      } catch {
        /* keep it for the next attempt */
      } finally {
        sweepsInFlight.delete(id);
      }
    }),
  );
}

/**
 * Wait for the committed (undelegated) game to show a terminal status on L1:
 * Won, Lost, or Void (F3: an undelegate of a zero-progress round ends it Void).
 */
export async function waitForCommittedResult(
  cfg: VrfEngineConfig,
  player: PublicKey,
  timeoutMs = 60_000,
): Promise<VrfGameAccount | null> {
  return pollVrfGame(cfg.l1, cfg.programId, player, (g) => g.status !== "Playing", timeoutMs);
}

/**
 * Wait only for the rollup to hand the game account back to the program.
 *
 * The RECOVERY path must not use waitForCommittedResult: that waits for a
 * TERMINAL status (Won/Lost), and a game being refunded stays `Playing`
 * forever — so the predicate can never pass and the caller eats the entire
 * timeout before doing anything. That was a flat ~32s of dead waiting on every
 * refund, measured twice on chain to the second. (Since the F3 round-2 fix an
 * undelegated zero-progress game reads Void, not Playing; refund takes both.)
 *
 * Undelegation is the only precondition that actually matters here, because
 * refund_stalled_vrf refuses while the account is still owned by the
 * delegation program. Ownership flips back in a few seconds, and polling for
 * exactly that turns a 32s wait into a ~2s one.
 *
 * A missing account also counts as done: it means the game was already
 * settled or refunded and closed.
 */
export async function waitForUndelegation(
  cfg: VrfEngineConfig,
  player: PublicKey,
  timeoutMs = 20_000,
): Promise<boolean> {
  const [gamePda] = deriveVrfGamePda(cfg.programId, player);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const ai = await cfg.l1.getAccountInfo(gamePda, "processed");
      if (!ai || ai.owner.equals(cfg.programId)) return true;
    } catch {
      /* transient RPC */
    }
    await sleep(400);
  }
  return false;
}
