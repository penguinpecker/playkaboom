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

/** Poll-based confirmation (browser-safe). */
export async function pollConfirm(conn: Connection, sig: string, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error("tx failed: " + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return;
    await sleep(500);
  }
  throw new Error("confirm timeout");
}

/** Build → sign → send → poll-confirm one or more instructions. */
async function sendIx(
  conn: Connection,
  ix: TransactionInstruction | TransactionInstruction[],
  feePayer: PublicKey,
  sign: SignTx,
): Promise<string> {
  const tx = new Transaction().add(...(Array.isArray(ix) ? ix : [ix]));
  tx.feePayer = feePayer;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  const signed = await sign(tx);
  // Preflight ON for player-signed transactions, matching the commit-reveal
  // path: a deterministic failure (bet over the cap, stale state) should be
  // rejected up front rather than costing the player a fee and surfacing as a
  // generic timeout 40s later.
  const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 5 });
  await pollConfirm(conn, sig);
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
): Promise<StartedVrfGame> {
  const session = Keypair.generate();
  onSession?.(session);
  const ctx = { programId: cfg.programId };
  const startSig = await sendIx(
    cfg.l1,
    [
      buildStartGameVrf({ ctx, player, mineCount, betLamports, sessionKey: session.publicKey }),
      SystemProgram.transfer({
        fromPubkey: player,
        toPubkey: session.publicKey,
        lamports: SESSION_FUND_LAMPORTS,
      }),
    ],
    player,
    signPlayer,
  );
  const delegateSig = await sendIx(cfg.l1, buildDelegateVrf({ ctx, player }), player, signPlayer);
  const [gamePda] = deriveVrfGamePda(cfg.programId, player);
  return { gamePda, session, startSig, delegateSig };
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
 * Return whatever gas is left on the session key to the player.
 *
 * Without this the funding is a pure loss every round — at the minimum bet the
 * abandoned dust would exceed the bet itself, and it never reaches the vault or
 * treasury either, so it is worse than a fee for everyone. Best-effort: a
 * failure here costs only dust, so callers should not treat it as fatal.
 */
export async function sweepSession(
  cfg: VrfEngineConfig,
  session: Keypair,
  player: PublicKey,
): Promise<string | null> {
  const balance = await cfg.l1.getBalance(session.publicKey, "confirmed");
  const FEE = 5000;
  if (balance <= FEE) return null;
  try {
    return await sendIx(
      cfg.l1,
      SystemProgram.transfer({
        fromPubkey: session.publicKey,
        toPubkey: player,
        lamports: balance - FEE,
      }),
      session.publicKey,
      keypairSigner(session),
    );
  } catch {
    return null;
  }
}

/** Wait for the committed (undelegated) game to show a terminal status on L1. */
export async function waitForCommittedResult(
  cfg: VrfEngineConfig,
  player: PublicKey,
  timeoutMs = 60_000,
): Promise<VrfGameAccount | null> {
  return pollVrfGame(cfg.l1, cfg.programId, player, (g) => g.status === "Won" || g.status === "Lost", timeoutMs);
}
