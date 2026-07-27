// Per-click VRF-in-Ephemeral-Rollup mode — SDK layer.
//
// Mirrors the on-chain `vrf_mode.rs`: raw instruction builders + PDA derivations
// + account decoders for the second (rollup) game mode. Follows the same
// hand-rolled pattern as instructions.ts / pdas.ts / accounts.ts (no Anchor
// client, manual Anchor discriminators via ixDiscriminator).
//
// Account orders and PDA seeds are taken verbatim from the built program IDL —
// keep them in lockstep with vrf_mode.rs.

import {
  PublicKey,
  SystemProgram,
  SYSVAR_SLOT_HASHES_PUBKEY,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { ixDiscriminator, accountDiscriminator } from "./discriminator";

// ── seeds & fixed program ids ────────────────────────────────────────────────

export const VRF_CLAIM_SEED = "kaboom_vrf_claim";
export const VRF_GAME_SEED = "kaboom_vrf_game";

/** MagicBlock delegation program (DLP). */
export const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
/** MagicBlock ephemeral VRF program. */
export const VRF_PROGRAM = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
/** MagicBlock magic program + its context account (fixed addresses). */
export const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
export const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");

/**
 * Ephemeral VRF oracle queue. This is the SDK-wide default queue and the same
 * address on devnet and mainnet (verified live on mainnet, owned by the DLP) —
 * it is not devnet-specific despite the name it originally shipped under.
 */
export const DEFAULT_VRF_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
/** @deprecated Misleading name — the queue is not devnet-only. Use DEFAULT_VRF_QUEUE. */
export const DEVNET_VRF_QUEUE = DEFAULT_VRF_QUEUE;

const VRF_CLAIM_SEED_BYTES = Buffer.from(VRF_CLAIM_SEED, "utf8");
const VRF_GAME_SEED_BYTES = Buffer.from(VRF_GAME_SEED, "utf8");

const writable = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const readonly = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

// ── PDA derivations ──────────────────────────────────────────────────────────

/** L1 escrow claim (money-side; never delegated). */
export function deriveVrfClaimPda(programId: PublicKey, player: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VRF_CLAIM_SEED_BYTES, player.toBuffer()], programId);
}

/** Reveal-state PDA (delegated to the ER during play). */
export function deriveVrfGamePda(programId: PublicKey, player: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VRF_GAME_SEED_BYTES, player.toBuffer()], programId);
}

/** ER delegation PDAs (derivations taken from the IDL). */
export function deriveDelegationBuffer(programId: PublicKey, game: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("buffer"), game.toBuffer()], programId)[0];
}
export function deriveDelegationRecord(game: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("delegation"), game.toBuffer()], DELEGATION_PROGRAM)[0];
}
export function deriveDelegationMetadata(game: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), game.toBuffer()], DELEGATION_PROGRAM)[0];
}
/** VRF caller identity PDA (under the owner program). */
export function deriveVrfProgramIdentity(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("identity")], programId)[0];
}

// ── instruction builders ─────────────────────────────────────────────────────

export interface VrfCtx {
  programId: PublicKey;
}

/** L1: lock the bet, open escrow claim + reveal state, register the session key. */
export function buildStartGameVrf(args: {
  ctx: VrfCtx;
  player: PublicKey;
  mineCount: number;
  betLamports: bigint;
  sessionKey: PublicKey;
}): TransactionInstruction {
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("kaboom_vault")], args.ctx.programId);
  const [v2] = PublicKey.findProgramAddressSync([Buffer.from("kaboom_v2_state")], args.ctx.programId);
  const [claim] = deriveVrfClaimPda(args.ctx.programId, args.player);
  const [game] = deriveVrfGamePda(args.ctx.programId, args.player);
  // Created here and paid for by the player — settle must never fund it, or the
  // house would pay unreclaimable rent for every fresh wallet.
  const [stats] = PublicKey.findProgramAddressSync(
    [Buffer.from("kaboom_stats"), args.player.toBuffer()],
    args.ctx.programId,
  );
  const data = Buffer.alloc(8 + 1 + 8 + 32);
  ixDiscriminator("start_game_vrf").copy(data, 0);
  data.writeUInt8(args.mineCount, 8);
  data.writeBigUInt64LE(args.betLamports, 9);
  args.sessionKey.toBuffer().copy(data, 17);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      writable(args.player, true),
      writable(vault),
      writable(v2),
      writable(claim),
      writable(game),
      writable(stats),
      readonly(SystemProgram.programId),
    ],
    data,
  });
}

/**
 * L1, owner-gated: release a VRF game the rollup never gave back.
 *
 * Last-resort recovery. Frees the game's reserved obligation (which otherwise
 * throttles BOTH game modes and LP withdrawals forever) and returns the bet.
 * Only valid long after the game started — see ABANDON_SLOTS on chain.
 */
export function buildAdminReleaseVrfClaim(args: {
  ctx: VrfCtx;
  owner: PublicKey;
  player: PublicKey;
}): TransactionInstruction {
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("kaboom_vault")], args.ctx.programId);
  const [v2] = PublicKey.findProgramAddressSync([Buffer.from("kaboom_v2_state")], args.ctx.programId);
  const [claim] = deriveVrfClaimPda(args.ctx.programId, args.player);
  const data = Buffer.alloc(8);
  ixDiscriminator("admin_release_vrf_claim").copy(data, 0);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      readonly(args.owner, true),
      writable(args.player),
      writable(claim),
      writable(vault),
      writable(v2),
    ],
    data,
  });
}

/**
 * L1 -> ER: delegate the reveal-state PDA to the rollup. Player-signed.
 *
 * The target validator is NOT passed here — the program reads it from owner-set
 * on-chain config (v2_state.vrf_validator) so the caller cannot redirect custody
 * of the reveal state. Unset config = the instruction rejects.
 */
export function buildDelegateVrf(args: { ctx: VrfCtx; player: PublicKey }): TransactionInstruction {
  const [game] = deriveVrfGamePda(args.ctx.programId, args.player);
  const [v2] = PublicKey.findProgramAddressSync([Buffer.from("kaboom_v2_state")], args.ctx.programId);
  const bufferGame = deriveDelegationBuffer(args.ctx.programId, game);
  const record = deriveDelegationRecord(game);
  const metadata = deriveDelegationMetadata(game);
  const data = Buffer.alloc(8);
  ixDiscriminator("delegate_vrf").copy(data, 0);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      writable(args.player, true),
      writable(bufferGame),
      writable(record),
      writable(metadata),
      writable(game),
      readonly(v2),
      readonly(args.ctx.programId), // owner_program
      readonly(DELEGATION_PROGRAM),
      readonly(SystemProgram.programId),
    ],
    data,
  });
}

/**
 * L1, owner-gated: close an ER-era `GameSessionV2` orphaned by the VRF upgrade.
 *
 * The upgrade deletes the only instructions that could ever touch these, so
 * without this their bet, rent, and — most importantly — their share of
 * `total_outstanding_max_payout` would be locked forever, permanently shrinking
 * the bankroll's usable capacity. Returns the bet and closes the account.
 */
export function buildAdminCloseOrphanedGameV2(args: {
  ctx: VrfCtx;
  owner: PublicKey;
  player: PublicKey;
}): TransactionInstruction {
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("kaboom_vault")], args.ctx.programId);
  const [v2] = PublicKey.findProgramAddressSync([Buffer.from("kaboom_v2_state")], args.ctx.programId);
  const [game] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_v2"), args.player.toBuffer()],
    args.ctx.programId,
  );
  const data = Buffer.alloc(8);
  ixDiscriminator("admin_close_orphaned_game_v2").copy(data, 0);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      readonly(args.owner, true),
      writable(args.player),
      writable(game),
      writable(vault),
      writable(v2),
    ],
    data,
  });
}

/** ER: session-signed reveal request; triggers a scoped VRF draw. */
export function buildRevealRequestVrf(args: {
  ctx: VrfCtx;
  player: PublicKey; // keys the game PDA
  session: PublicKey;
  tileIndex: number;
  clientSeed: number;
  oracleQueue?: PublicKey;
}): TransactionInstruction {
  const [game] = deriveVrfGamePda(args.ctx.programId, args.player);
  const identity = deriveVrfProgramIdentity(args.ctx.programId);
  const queue = args.oracleQueue ?? DEFAULT_VRF_QUEUE;
  const data = Buffer.alloc(8 + 1 + 1);
  ixDiscriminator("reveal_request_vrf").copy(data, 0);
  data.writeUInt8(args.tileIndex, 8);
  data.writeUInt8(args.clientSeed & 0xff, 9);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      writable(args.session, true),
      writable(game),
      writable(queue),
      readonly(identity),
      readonly(VRF_PROGRAM),
      readonly(SYSVAR_SLOT_HASHES_PUBKEY),
      readonly(SystemProgram.programId),
    ],
    data,
  });
}

/** ER: exit with current multiplier (session key or player signs). */
export function buildCashOutVrf(args: { ctx: VrfCtx; player: PublicKey; signer: PublicKey }): TransactionInstruction {
  const [game] = deriveVrfGamePda(args.ctx.programId, args.player);
  const data = Buffer.alloc(8);
  ixDiscriminator("cash_out_vrf").copy(data, 0);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [writable(args.signer, true), writable(game)],
    data,
  });
}

/** ER -> L1: commit reveal state back to base and undelegate. */
export function buildSettleAndUndelegateVrf(args: {
  ctx: VrfCtx;
  player: PublicKey; // keys the game PDA
  payer: PublicKey;
}): TransactionInstruction {
  const [game] = deriveVrfGamePda(args.ctx.programId, args.player);
  const data = Buffer.alloc(8);
  ixDiscriminator("settle_and_undelegate_vrf").copy(data, 0);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      writable(args.payer, true),
      writable(game),
      readonly(MAGIC_PROGRAM),
      writable(MAGIC_CONTEXT),
    ],
    data,
  });
}

/** L1: replay-verify the recorded randomness, release reservation, pay winner. Permissionless. */
export function buildSettleVrf(args: {
  ctx: VrfCtx;
  player: PublicKey;
  payer: PublicKey;
  treasury: PublicKey;
  referralPda?: PublicKey; // optional remaining account when player has a referrer
}): TransactionInstruction {
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("kaboom_vault")], args.ctx.programId);
  const [v2] = PublicKey.findProgramAddressSync([Buffer.from("kaboom_v2_state")], args.ctx.programId);
  const [claim] = deriveVrfClaimPda(args.ctx.programId, args.player);
  const [game] = deriveVrfGamePda(args.ctx.programId, args.player);
  const [stats] = PublicKey.findProgramAddressSync(
    [Buffer.from("kaboom_stats"), args.player.toBuffer()],
    args.ctx.programId,
  );
  const data = Buffer.alloc(8);
  ixDiscriminator("settle_vrf").copy(data, 0);
  const keys: AccountMeta[] = [
    writable(args.payer, true),
    writable(args.player),
    writable(claim), // closed to player at settle
    writable(game), // closed to player at settle
    writable(vault),
    writable(v2),
    writable(args.treasury),
    writable(stats),
    readonly(SystemProgram.programId),
  ];
  if (args.referralPda) keys.push(writable(args.referralPda));
  return new TransactionInstruction({ programId: args.ctx.programId, keys, data });
}

/**
 * L1: reclaim the bet for a game that came back to L1 with no result.
 *
 * `caller` must sign and be either the player or the house authority — the
 * program rejects anyone else, so a third party cannot cancel a live game.
 * On-chain this only succeeds when the reveal PDA is UNDELEGATED (its L1 state
 * is final); a still-delegated game must be undelegated first.
 */
export function buildRefundStalledVrf(args: {
  ctx: VrfCtx;
  player: PublicKey;
  caller: PublicKey;
}): TransactionInstruction {
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("kaboom_vault")], args.ctx.programId);
  const [v2] = PublicKey.findProgramAddressSync([Buffer.from("kaboom_v2_state")], args.ctx.programId);
  const [claim] = deriveVrfClaimPda(args.ctx.programId, args.player);
  const [game] = deriveVrfGamePda(args.ctx.programId, args.player);
  const data = Buffer.alloc(8);
  ixDiscriminator("refund_stalled_vrf").copy(data, 0);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      readonly(args.caller, true),
      writable(args.player),
      writable(claim),
      writable(game),
      writable(vault),
      writable(v2),
    ],
    data,
  });
}

// ── account decoders ─────────────────────────────────────────────────────────

const VRF_CLAIM_DISC = accountDiscriminator("VrfClaim");
const VRF_GAME_DISC = accountDiscriminator("VrfGame");

export type VrfStatus = "Playing" | "Won" | "Lost";
const VRF_STATUS: VrfStatus[] = ["Playing", "Won", "Lost"];

export interface VrfClaimAccount {
  player: PublicKey;
  bet: bigint;
  /** Worst-case payout reserved at start; also the hard payout cap at settle. */
  reserved: bigint;
  mineCount: number;
  /** House edge snapshotted on L1 at start; settle requires the ER to match it. */
  houseEdgeBps: number;
  startSlot: bigint;
  settled: boolean;
  bump: number;
}

export interface VrfRevealRecord {
  tile: number;
  randomness: Buffer;
}

export interface VrfGameAccount {
  status: VrfStatus;
  player: PublicKey;
  sessionKey: PublicKey;
  bump: number;
  mineCount: number;
  houseEdgeBps: number;
  safeReveals: number;
  revealCount: number;
  pending: boolean;
  pendingTile: number;
  revealedMask: number;
  mineMask: number;
  multiplierBps: bigint;
  reveals: VrfRevealRecord[];
}

class Reader {
  private o = 0;
  constructor(private b: Buffer) {}
  u8() { return this.b.readUInt8(this.o++); }
  bool() { return this.b.readUInt8(this.o++) !== 0; }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  pk() { const v = new PublicKey(this.b.subarray(this.o, this.o + 32)); this.o += 32; return v; }
  bytes(n: number) { const v = Buffer.from(this.b.subarray(this.o, this.o + n)); this.o += n; return v; }
}

export function decodeVrfClaim(data: Buffer): VrfClaimAccount {
  if (!data.subarray(0, 8).equals(VRF_CLAIM_DISC)) throw new Error("not a VrfClaim account");
  const r = new Reader(data.subarray(8) as Buffer);
  return {
    player: r.pk(),
    bet: r.u64(),
    reserved: r.u64(),
    mineCount: r.u8(),
    houseEdgeBps: r.u16(),
    startSlot: r.u64(),
    settled: r.bool(),
    bump: r.u8(),
  };
}

export function decodeVrfGame(data: Buffer): VrfGameAccount {
  if (!data.subarray(0, 8).equals(VRF_GAME_DISC)) throw new Error("not a VrfGame account");
  const r = new Reader(data.subarray(8) as Buffer);
  const status = VRF_STATUS[r.u8()] ?? "Playing";
  const player = r.pk();
  const sessionKey = r.pk();
  const bump = r.u8();
  const mineCount = r.u8();
  const houseEdgeBps = r.u16();
  const safeReveals = r.u8();
  const revealCount = r.u8();
  const pending = r.bool();
  const pendingTile = r.u8();
  const revealedMask = r.u16();
  const mineMask = r.u16();
  const multiplierBps = r.u64();
  const reveals: VrfRevealRecord[] = [];
  for (let i = 0; i < 16; i++) reveals.push({ tile: r.u8(), randomness: r.bytes(32) });
  return {
    status, player, sessionKey, bump, mineCount, houseEdgeBps, safeReveals,
    revealCount, pending, pendingTile, revealedMask, mineMask, multiplierBps, reveals,
  };
}

/** Read `VrfGame.status` raw (byte 8) without full decode — matches refund_stalled_vrf's raw read. */
export function readVrfGameStatusByte(data: Buffer): number {
  return data.readUInt8(8);
}
