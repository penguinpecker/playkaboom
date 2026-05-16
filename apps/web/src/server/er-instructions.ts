import "server-only";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import {
  deriveGameV2Pda,
  derivePlayerStatsPda,
  deriveV2StatePda,
  deriveVaultPda,
  ixDiscriminator,
} from "@playkaboom/sdk";

// Re-export so reveal/route.ts + commit/route.ts callers don't have to
// switch their import. The canonical implementation lives in the SDK
// (packages/sdk/src/pdas.ts) using the GAME_V2_SEED shared constant.
export { deriveGameV2Pda };

/**
 * Instruction builders for the new Magicblock-ER variants:
 *   - start_game_er
 *   - delegate_game
 *   - reveal_tile_er
 *   - settle_game_er
 *
 * These live in the web app (not in @playkaboom/sdk) so the SDK package
 * stays stable while the Anchor program changes are in flight. Once the
 * program lands and the IDL regenerates, these can be hoisted into the SDK.
 *
 * Account layouts mirror the existing (non-ER) builders in
 * packages/sdk/src/instructions.ts. The parallel Anchor agent has the
 * authoritative source of truth — discrepancies will surface at the first
 * integration-test landing and these stubs will be updated.
 */

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

export interface ErBuildContext {
  programId: PublicKey;
}

// ── start_game_er ────────────────────────────────────────────────────────────
// Same as start_game but additionally records the player-chosen session_key
// pubkey in the GameSession PDA. The program will accept signatures from
// this key on subsequent reveal_tile_er calls.
export interface StartGameErArgs {
  ctx: ErBuildContext;
  player: PublicKey;
  mineCount: number;
  betLamports: bigint;
  commitment: Buffer;
  sessionKey: PublicKey;
}

export function buildStartGameEr(args: StartGameErArgs): TransactionInstruction {
  if (args.commitment.length !== 32) throw new Error("commitment must be 32 bytes");
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const [v2StatePda] = deriveV2StatePda(args.ctx.programId);
  const [gamePda] = deriveGameV2Pda(args.ctx.programId, args.player);
  const [statsPda] = derivePlayerStatsPda(args.ctx.programId, args.player);
  // discriminator(8) + mineCount(1) + betLamports(8) + commitment(32) + sessionKey(32)
  const data = Buffer.alloc(8 + 1 + 8 + 32 + 32);
  ixDiscriminator("start_game_er").copy(data, 0);
  data.writeUInt8(args.mineCount, 8);
  data.writeBigUInt64LE(args.betLamports, 9);
  args.commitment.copy(data, 17);
  Buffer.from(args.sessionKey.toBytes()).copy(data, 49);
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

// ── delegate_game ────────────────────────────────────────────────────────────
// House (Turnkey) signs; flips the GameSession PDA into ER-delegated state.
// Magicblock's delegation program is referenced by the on-chain handler via
// CPI; the validator pubkey is supplied as a readonly account so the
// program can record which ER claims ownership.
export interface DelegateGameArgs {
  ctx: ErBuildContext;
  player: PublicKey;
  houseAuthority: PublicKey;
  validator: PublicKey;
}

export function buildDelegateGame(args: DelegateGameArgs): TransactionInstruction {
  const [gamePda] = deriveGameV2Pda(args.ctx.programId, args.player);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      writable(gamePda),
      readonly(args.houseAuthority, true),
      readonly(args.validator),
      readonly(SystemProgram.programId),
    ],
    data: ixDiscriminator("delegate_game"),
  });
}

// ── reveal_tile_er ───────────────────────────────────────────────────────────
// Session-key signed. Runs inside the ER; no house authority involved on
// this path.
export interface RevealTileErArgs {
  ctx: ErBuildContext;
  player: PublicKey;
  sessionKey: PublicKey;
  tileIndex: number;
  isMine: boolean;
}

export function buildRevealTileEr(args: RevealTileErArgs): TransactionInstruction {
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const [gamePda] = deriveGameV2Pda(args.ctx.programId, args.player);
  const data = Buffer.alloc(8 + 1 + 1);
  ixDiscriminator("reveal_tile_er").copy(data, 0);
  data.writeUInt8(args.tileIndex, 8);
  data.writeUInt8(args.isMine ? 1 : 0, 9);
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys: [
      readonly(vaultPda),
      writable(gamePda),
      readonly(args.sessionKey, true),
    ],
    data,
  });
}

// ── settle_game_er ───────────────────────────────────────────────────────────
// House (Turnkey) signs. Runs commit + undelegate atomically so the
// GameSession returns to L1 ownership in the same tx that pays out.
//
// NOTE: prompt specifies `grid_preimage: [u8;16]` and `salt: [u8;16]`, but
// the existing (L1) settle_game encodes mineLayout as u16 and salt as
// [u8;32]. We assume the ER variant keeps the same wire shape for
// compatibility (mineLayout: u16, salt: [u8;32]). The Anchor agent will
// confirm; if they instead packed mineLayout into a 16-byte preimage,
// adjust the buffer layout here.
export interface SettleGameErArgs {
  ctx: ErBuildContext;
  player: PublicKey;
  houseAuthority: PublicKey;
  /** Treasury account (must match vault.treasury) — receives the
   *  50/50 split per settle (see settle_game_er in lib.rs). */
  treasury: PublicKey;
  mineLayout: number;
  salt: Buffer;
  referrer?: PublicKey;
}

export function buildSettleGameEr(args: SettleGameErArgs): TransactionInstruction {
  if (args.salt.length !== 32) throw new Error("salt must be 32 bytes");
  const [vaultPda] = deriveVaultPda(args.ctx.programId);
  const [v2StatePda] = deriveV2StatePda(args.ctx.programId);
  const [gamePda] = deriveGameV2Pda(args.ctx.programId, args.player);
  const [statsPda] = derivePlayerStatsPda(args.ctx.programId, args.player);
  const data = Buffer.alloc(8 + 2 + 32);
  ixDiscriminator("settle_game_er").copy(data, 0);
  data.writeUInt16LE(args.mineLayout, 8);
  args.salt.copy(data, 10);
  const keys: AccountMeta[] = [
    writable(vaultPda),
    writable(v2StatePda),
    writable(gamePda),
    writable(statsPda),
    readonly(args.houseAuthority, true),
    writable(args.treasury),
  ];
  if (args.referrer) {
    // Referral PDA derivation lives in @playkaboom/sdk but is imported
    // lazily here to keep this file self-contained for non-referral paths.
    // (See instructions.ts:258-261 for the L1 equivalent.)
    const { deriveReferralPda } = require("@playkaboom/sdk") as {
      deriveReferralPda: (pid: PublicKey, r: PublicKey) => [PublicKey, number];
    };
    const [referralPda] = deriveReferralPda(args.ctx.programId, args.referrer);
    keys.push(writable(referralPda));
  }
  return new TransactionInstruction({
    programId: args.ctx.programId,
    keys,
    data,
  });
}
