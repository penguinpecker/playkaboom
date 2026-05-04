import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { ixDiscriminator } from "./discriminator.js";
import { deriveGamePda, deriveVaultPda } from "./pdas.js";

const writable = (pubkey: PublicKey, isSigner = false): AccountMeta => ({
  pubkey,
  isSigner,
  isWritable: true,
});
const readonly = (pubkey: PublicKey, isSigner = false): AccountMeta => ({
  pubkey,
  isSigner,
  isWritable: false,
});

export interface BuildContext {
  programId: PublicKey;
}

// ── initialize_vault ──────────────────────────────────────────────────────────
export interface InitializeVaultArgs {
  ctx: BuildContext;
  owner: PublicKey;
  houseAuthority: PublicKey;
  treasury: PublicKey;
  houseEdgeBps: number;
  maxBetBps: number;
  maxPayoutBps: number;
}

export function buildInitializeVault(args: InitializeVaultArgs): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const data = Buffer.alloc(8 + 2 + 2 + 2);
  ixDiscriminator("initialize_vault").copy(data, 0);
  data.writeUInt16LE(args.houseEdgeBps, 8);
  data.writeUInt16LE(args.maxBetBps, 10);
  data.writeUInt16LE(args.maxPayoutBps, 12);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      writable(vaultPda),
      readonly(args.houseAuthority),
      readonly(args.treasury),
      writable(args.owner, true),
      readonly(SystemProgram.programId),
    ],
    data,
  });
}

// ── fund_vault ────────────────────────────────────────────────────────────────
export interface FundVaultArgs {
  ctx: BuildContext;
  funder: PublicKey;
  amount: bigint;
}

export function buildFundVault(args: FundVaultArgs): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const data = Buffer.alloc(8 + 8);
  ixDiscriminator("fund_vault").copy(data, 0);
  data.writeBigUInt64LE(args.amount, 8);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [writable(vaultPda), writable(args.funder, true), readonly(SystemProgram.programId)],
    data,
  });
}

// ── start_game ────────────────────────────────────────────────────────────────
export interface StartGameArgs {
  ctx: BuildContext;
  player: PublicKey;
  mineCount: number;
  betLamports: bigint;
  commitment: Buffer;
}

export function buildStartGame(args: StartGameArgs): TransactionInstruction {
  if (args.commitment.length !== 32) throw new Error("commitment must be 32 bytes");
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const [gamePda] = deriveGamePda(args.ctx.programId, args.player);
  const data = Buffer.alloc(8 + 1 + 8 + 32);
  ixDiscriminator("start_game").copy(data, 0);
  data.writeUInt8(args.mineCount, 8);
  data.writeBigUInt64LE(args.betLamports, 9);
  args.commitment.copy(data, 17);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      writable(vaultPda),
      writable(gamePda),
      writable(args.player, true),
      readonly(SystemProgram.programId),
    ],
    data,
  });
}

// ── reveal_tile ───────────────────────────────────────────────────────────────
export interface RevealTileArgs {
  ctx: BuildContext;
  player: PublicKey;
  houseAuthority: PublicKey;
  tileIndex: number;
  isMine: boolean;
}

export function buildRevealTile(args: RevealTileArgs): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const [gamePda] = deriveGamePda(args.ctx.programId, args.player);
  const data = Buffer.alloc(8 + 1 + 1);
  ixDiscriminator("reveal_tile").copy(data, 0);
  data.writeUInt8(args.tileIndex, 8);
  data.writeUInt8(args.isMine ? 1 : 0, 9);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [readonly(vaultPda), writable(gamePda), readonly(args.houseAuthority, true)],
    data,
  });
}

// ── cash_out ──────────────────────────────────────────────────────────────────
export interface CashOutArgs {
  ctx: BuildContext;
  player: PublicKey;
}

export function buildCashOut(args: CashOutArgs): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const [gamePda] = deriveGamePda(args.ctx.programId, args.player);
  const data = Buffer.alloc(8);
  ixDiscriminator("cash_out").copy(data, 0);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [writable(vaultPda), writable(gamePda), writable(args.player, true)],
    data,
  });
}

// ── settle_game ───────────────────────────────────────────────────────────────
export interface SettleGameArgs {
  ctx: BuildContext;
  player: PublicKey;
  houseAuthority: PublicKey;
  mineLayout: number;
  salt: Buffer;
}

export function buildSettleGame(args: SettleGameArgs): TransactionInstruction {
  if (args.salt.length !== 32) throw new Error("salt must be 32 bytes");
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const [gamePda] = deriveGamePda(args.ctx.programId, args.player);
  const data = Buffer.alloc(8 + 2 + 32);
  ixDiscriminator("settle_game").copy(data, 0);
  data.writeUInt16LE(args.mineLayout, 8);
  args.salt.copy(data, 10);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [readonly(vaultPda), writable(gamePda), readonly(args.houseAuthority, true)],
    data,
  });
}

// ── refund_expired ────────────────────────────────────────────────────────────
export interface RefundExpiredArgs {
  ctx: BuildContext;
  player: PublicKey;
}

export function buildRefundExpired(args: RefundExpiredArgs): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const [gamePda] = deriveGamePda(args.ctx.programId, args.player);
  const data = Buffer.alloc(8);
  ixDiscriminator("refund_expired").copy(data, 0);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [writable(vaultPda), writable(gamePda), writable(args.player, true)],
    data,
  });
}

// ── close_game ────────────────────────────────────────────────────────────────
export interface CloseGameArgs {
  ctx: BuildContext;
  player: PublicKey;
}

export function buildCloseGame(args: CloseGameArgs): TransactionInstruction {
  const [gamePda] = deriveGamePda(args.ctx.programId, args.player);
  const data = Buffer.alloc(8);
  ixDiscriminator("close_game").copy(data, 0);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [writable(gamePda), writable(args.player, true)],
    data,
  });
}

// ── withdraw_to_treasury ──────────────────────────────────────────────────────
export interface WithdrawArgs {
  ctx: BuildContext;
  treasury: PublicKey;
  amount: bigint;
}

export function buildWithdrawToTreasury(args: WithdrawArgs): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const data = Buffer.alloc(8 + 8);
  ixDiscriminator("withdraw_to_treasury").copy(data, 0);
  data.writeBigUInt64LE(args.amount, 8);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [writable(vaultPda), writable(args.treasury, true)],
    data,
  });
}

// ── update_vault ──────────────────────────────────────────────────────────────
export interface UpdateVaultArgs {
  ctx: BuildContext;
  owner: PublicKey;
  houseEdgeBps?: number;
  maxBetBps?: number;
  maxPayoutBps?: number;
  paused?: boolean;
  newHouseAuthority?: PublicKey;
  newTreasury?: PublicKey;
}

export function buildUpdateVault(args: UpdateVaultArgs): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  // Anchor encodes Option<T> as (1-byte presence flag, optionally T).
  const parts: Buffer[] = [ixDiscriminator("update_vault")];
  parts.push(encodeOption(args.houseEdgeBps, (v) => writeU16(v)));
  parts.push(encodeOption(args.maxBetBps, (v) => writeU16(v)));
  parts.push(encodeOption(args.maxPayoutBps, (v) => writeU16(v)));
  parts.push(encodeOption(args.paused, (v) => Buffer.from([v ? 1 : 0])));
  parts.push(encodeOption(args.newHouseAuthority, (v) => Buffer.from(v.toBytes())));
  parts.push(encodeOption(args.newTreasury, (v) => Buffer.from(v.toBytes())));
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [writable(vaultPda), readonly(args.owner, true)],
    data: Buffer.concat(parts),
  });
}

// ── helpers ───────────────────────────────────────────────────────────────────
function writeU16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}

function encodeOption<T>(value: T | undefined, encode: (v: T) => Buffer): Buffer {
  if (value === undefined) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), encode(value)]);
}

/** Serialize an instruction for transport (server → browser). */
export interface SerializedIx {
  programId: string;
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string; // base64
}

export function serializeIx(ix: TransactionInstruction): SerializedIx {
  return {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(ix.data).toString("base64"),
  };
}

export function deserializeIx(s: SerializedIx): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(s.programId),
    keys: s.keys.map((k) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(s.data, "base64"),
  });
}
