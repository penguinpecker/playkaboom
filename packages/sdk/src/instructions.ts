import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { ixDiscriminator } from "./discriminator";
import {
  deriveGamePda,
  deriveLpPositionPda,
  derivePlayerStatsPda,
  deriveReferralPda,
  deriveV2StatePda,
  deriveVaultPda,
} from "./pdas";

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
  const [v2StatePda] = deriveV2StatePda(args.ctx.programId);
  const [gamePda] = deriveGamePda(args.ctx.programId, args.player);
  const [statsPda] = derivePlayerStatsPda(args.ctx.programId, args.player);
  const data = Buffer.alloc(8 + 1 + 8 + 32);
  ixDiscriminator("start_game").copy(data, 0);
  data.writeUInt8(args.mineCount, 8);
  data.writeBigUInt64LE(args.betLamports, 9);
  args.commitment.copy(data, 17);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      writable(vaultPda),
      writable(v2StatePda),
      writable(gamePda),
      writable(statsPda),
      writable(args.player, true),
      readonly(SystemProgram.programId),
    ],
    data,
  });
}

// ── set_referrer ──────────────────────────────────────────────────────────────
export interface SetReferrerArgs {
  ctx: BuildContext;
  player: PublicKey;
  referrer: PublicKey;
}

export function buildSetReferrer(args: SetReferrerArgs): TransactionInstruction {
  if (args.player.equals(args.referrer)) throw new Error("cannot self-refer");
  const [statsPda] = derivePlayerStatsPda(args.ctx.programId, args.player);
  const [referralPda] = deriveReferralPda(args.ctx.programId, args.referrer);
  const data = Buffer.alloc(8);
  ixDiscriminator("set_referrer").copy(data, 0);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      writable(statsPda),
      readonly(args.referrer),
      writable(referralPda),
      writable(args.player, true),
      readonly(SystemProgram.programId),
    ],
    data,
  });
}

// ── claim_referral ────────────────────────────────────────────────────────────
export interface ClaimReferralArgs {
  ctx: BuildContext;
  referrer: PublicKey;
}

export function buildClaimReferral(args: ClaimReferralArgs): TransactionInstruction {
  const [referralPda] = deriveReferralPda(args.ctx.programId, args.referrer);
  const data = Buffer.alloc(8);
  ixDiscriminator("claim_referral").copy(data, 0);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [writable(referralPda), writable(args.referrer, true)],
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
  const [v2StatePda] = deriveV2StatePda(args.ctx.programId);
  const [gamePda] = deriveGamePda(args.ctx.programId, args.player);
  const data = Buffer.alloc(8);
  ixDiscriminator("cash_out").copy(data, 0);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      writable(vaultPda),
      writable(v2StatePda),
      writable(gamePda),
      writable(args.player, true),
    ],
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
  /** If the player has a referrer, pass it to credit the rakeback in the same tx. */
  referrer?: PublicKey;
}

export function buildSettleGame(args: SettleGameArgs): TransactionInstruction {
  if (args.salt.length !== 32) throw new Error("salt must be 32 bytes");
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const [v2StatePda] = deriveV2StatePda(args.ctx.programId);
  const [gamePda] = deriveGamePda(args.ctx.programId, args.player);
  const [statsPda] = derivePlayerStatsPda(args.ctx.programId, args.player);
  const data = Buffer.alloc(8 + 2 + 32);
  ixDiscriminator("settle_game").copy(data, 0);
  data.writeUInt16LE(args.mineLayout, 8);
  args.salt.copy(data, 10);
  const keys: AccountMeta[] = [
    writable(vaultPda),
    writable(v2StatePda),
    writable(gamePda),
    writable(statsPda),
    readonly(args.houseAuthority, true),
  ];
  if (args.referrer) {
    const [referralPda] = deriveReferralPda(args.ctx.programId, args.referrer);
    keys.push(writable(referralPda));
  }
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys,
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
  const [v2StatePda] = deriveV2StatePda(args.ctx.programId);
  const [gamePda] = deriveGamePda(args.ctx.programId, args.player);
  const data = Buffer.alloc(8);
  ixDiscriminator("refund_expired").copy(data, 0);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      writable(vaultPda),
      writable(v2StatePda),
      writable(gamePda),
      writable(args.player, true),
    ],
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
  destination: PublicKey;
  amount: bigint;
}

export function buildWithdrawToTreasury(args: WithdrawArgs): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const data = Buffer.alloc(8 + 8);
  ixDiscriminator("withdraw_to_treasury").copy(data, 0);
  data.writeBigUInt64LE(args.amount, 8);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [writable(vaultPda), readonly(args.treasury, true), writable(args.destination)],
    data,
  });
}

// ── allowlist_add / allowlist_remove ──────────────────────────────────────────
export interface AllowlistChangeArgs {
  ctx: BuildContext;
  owner: PublicKey;
  address: PublicKey;
}

export function buildAllowlistAdd(args: AllowlistChangeArgs): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const data = Buffer.alloc(8 + 32);
  ixDiscriminator("allowlist_add").copy(data, 0);
  args.address.toBuffer().copy(data, 8);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [writable(vaultPda), readonly(args.owner, true)],
    data,
  });
}

export function buildAllowlistRemove(args: AllowlistChangeArgs): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const data = Buffer.alloc(8 + 32);
  ixDiscriminator("allowlist_remove").copy(data, 0);
  args.address.toBuffer().copy(data, 8);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [writable(vaultPda), readonly(args.owner, true)],
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
  treasurySplitBps?: number;
  paused?: boolean;
  newHouseAuthority?: PublicKey;
  newTreasury?: PublicKey;
}

export function buildUpdateVault(args: UpdateVaultArgs): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const parts: Buffer[] = [ixDiscriminator("update_vault")];
  parts.push(encodeOption(args.houseEdgeBps, (v) => writeU16(v)));
  parts.push(encodeOption(args.maxBetBps, (v) => writeU16(v)));
  parts.push(encodeOption(args.maxPayoutBps, (v) => writeU16(v)));
  parts.push(encodeOption(args.treasurySplitBps, (v) => writeU16(v)));
  parts.push(encodeOption(args.paused, (v) => Buffer.from([v ? 1 : 0])));
  parts.push(encodeOption(args.newHouseAuthority, (v) => Buffer.from(v.toBytes())));
  parts.push(encodeOption(args.newTreasury, (v) => Buffer.from(v.toBytes())));
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [writable(vaultPda), readonly(args.owner, true)],
    data: Buffer.concat(parts),
  });
}

// ── Phase 2: LP / V2 builders ────────────────────────────────────────────────

export interface InitializeV2Args {
  ctx: BuildContext;
  owner: PublicKey;
}

export function buildInitializeV2(args: InitializeV2Args): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const [v2StatePda] = deriveV2StatePda(args.ctx.programId);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      readonly(vaultPda),
      writable(v2StatePda),
      writable(args.owner, true),
      readonly(SystemProgram.programId),
    ],
    data: ixDiscriminator("initialize_v2"),
  });
}

export interface UpdateV2ConfigArgs {
  ctx: BuildContext;
  owner: PublicKey;
  minHouseShareBps?: number;
  maxUserPositionBps?: number;
  minHealthBps?: number;
  withdrawCooldownSlots?: bigint;
  minLpDeposit?: bigint;
}

export function buildUpdateV2Config(args: UpdateV2ConfigArgs): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const [v2StatePda] = deriveV2StatePda(args.ctx.programId);
  const parts: Buffer[] = [ixDiscriminator("update_v2_config")];
  parts.push(encodeOption(args.minHouseShareBps, (v) => writeU16(v)));
  parts.push(encodeOption(args.maxUserPositionBps, (v) => writeU16(v)));
  parts.push(encodeOption(args.minHealthBps, (v) => writeU16(v)));
  parts.push(encodeOption(args.withdrawCooldownSlots, (v) => writeU64(v)));
  parts.push(encodeOption(args.minLpDeposit, (v) => writeU64(v)));
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [readonly(vaultPda), writable(v2StatePda), readonly(args.owner, true)],
    data: Buffer.concat(parts),
  });
}

export interface LpDepositArgs {
  ctx: BuildContext;
  user: PublicKey;
  amountLamports: bigint;
}

export function buildLpDeposit(args: LpDepositArgs): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const [v2StatePda] = deriveV2StatePda(args.ctx.programId);
  const [positionPda] = deriveLpPositionPda(args.ctx.programId, args.user);
  const data = Buffer.concat([ixDiscriminator("lp_deposit"), writeU64(args.amountLamports)]);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      writable(vaultPda),
      writable(v2StatePda),
      writable(positionPda),
      writable(args.user, true),
      readonly(SystemProgram.programId),
    ],
    data,
  });
}

interface UserLpActionArgs {
  ctx: BuildContext;
  user: PublicKey;
}

function buildUserLpAction(name: string, args: UserLpActionArgs, extra?: Buffer): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const [v2StatePda] = deriveV2StatePda(args.ctx.programId);
  const [positionPda] = deriveLpPositionPda(args.ctx.programId, args.user);
  const data = extra ? Buffer.concat([ixDiscriminator(name), extra]) : ixDiscriminator(name);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      writable(vaultPda),
      writable(v2StatePda),
      writable(positionPda),
      writable(args.user, true),
    ],
    data,
  });
}

export interface RequestWithdrawArgs extends UserLpActionArgs {
  units: bigint;
}

export function buildRequestWithdraw(args: RequestWithdrawArgs): TransactionInstruction {
  return buildUserLpAction("request_withdraw", args, writeU128(args.units));
}

export function buildCancelWithdraw(args: UserLpActionArgs): TransactionInstruction {
  return buildUserLpAction("cancel_withdraw", args);
}

export function buildCompleteWithdraw(args: UserLpActionArgs): TransactionInstruction {
  return buildUserLpAction("complete_withdraw", args);
}

export interface CloseLpPositionArgs {
  ctx: BuildContext;
  user: PublicKey;
}

export function buildCloseLpPosition(args: CloseLpPositionArgs): TransactionInstruction {
  const [positionPda] = deriveLpPositionPda(args.ctx.programId, args.user);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [writable(positionPda), writable(args.user, true)],
    data: ixDiscriminator("close_lp_position"),
  });
}

export interface HouseDepositArgs {
  ctx: BuildContext;
  owner: PublicKey;
  amountLamports: bigint;
}

export function buildHouseDeposit(args: HouseDepositArgs): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const [v2StatePda] = deriveV2StatePda(args.ctx.programId);
  const data = Buffer.concat([ixDiscriminator("house_deposit"), writeU64(args.amountLamports)]);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      readonly(vaultPda),
      writable(v2StatePda),
      writable(args.owner, true),
      readonly(SystemProgram.programId),
    ],
    data,
  });
}

interface HouseLpActionArgs {
  ctx: BuildContext;
  owner: PublicKey;
}

function buildHouseLpAction(name: string, args: HouseLpActionArgs, extra?: Buffer): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const [v2StatePda] = deriveV2StatePda(args.ctx.programId);
  const data = extra ? Buffer.concat([ixDiscriminator(name), extra]) : ixDiscriminator(name);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [writable(vaultPda), writable(v2StatePda), writable(args.owner, true)],
    data,
  });
}

export interface HouseRequestWithdrawArgs extends HouseLpActionArgs {
  units: bigint;
}

export function buildHouseRequestWithdraw(args: HouseRequestWithdrawArgs): TransactionInstruction {
  return buildHouseLpAction("house_request_withdraw", args, writeU128(args.units));
}

export function buildHouseCancelWithdraw(args: HouseLpActionArgs): TransactionInstruction {
  return buildHouseLpAction("house_cancel_withdraw", args);
}

export function buildHouseCompleteWithdraw(args: HouseLpActionArgs): TransactionInstruction {
  return buildHouseLpAction("house_complete_withdraw", args);
}

// ── propose_owner / cancel_proposed_owner / accept_ownership ─────────────────
export interface ProposeOwnerArgs {
  ctx: BuildContext;
  owner: PublicKey;
  newOwner: PublicKey;
}

export function buildProposeOwner(args: ProposeOwnerArgs): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const data = Buffer.concat([
    ixDiscriminator("propose_owner"),
    Buffer.from(args.newOwner.toBytes()),
  ]);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [writable(vaultPda), readonly(args.owner, true)],
    data,
  });
}

export interface CancelProposedOwnerArgs {
  ctx: BuildContext;
  owner: PublicKey;
}

export function buildCancelProposedOwner(
  args: CancelProposedOwnerArgs,
): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [writable(vaultPda), readonly(args.owner, true)],
    data: ixDiscriminator("cancel_proposed_owner"),
  });
}

export interface AcceptOwnershipArgs {
  ctx: BuildContext;
  newOwner: PublicKey;
}

export function buildAcceptOwnership(args: AcceptOwnershipArgs): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [writable(vaultPda), readonly(args.newOwner, true)],
    data: ixDiscriminator("accept_ownership"),
  });
}

// ── helpers ───────────────────────────────────────────────────────────────────
function writeU16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}

function writeU64(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return b;
}

function writeU128(v: bigint): Buffer {
  const b = Buffer.alloc(16);
  // little-endian: low 64 bits first, then high 64 bits.
  const lo = v & 0xffffffffffffffffn;
  const hi = (v >> 64n) & 0xffffffffffffffffn;
  b.writeBigUInt64LE(lo, 0);
  b.writeBigUInt64LE(hi, 8);
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
