import { PublicKey } from "@solana/web3.js";
import {
  GAME_SEED,
  GAME_V2_SEED,
  LP_SEED,
  REFERRAL_SEED,
  STATS_SEED,
  VAULT_SEED,
  VAULT_V2_SEED,
} from "@playkaboom/shared";

const VAULT_SEED_BYTES = Buffer.from(VAULT_SEED, "utf8");
const VAULT_V2_SEED_BYTES = Buffer.from(VAULT_V2_SEED, "utf8");
const LP_SEED_BYTES = Buffer.from(LP_SEED, "utf8");
const GAME_SEED_BYTES = Buffer.from(GAME_SEED, "utf8");
const GAME_V2_SEED_BYTES = Buffer.from(GAME_V2_SEED, "utf8");
const STATS_SEED_BYTES = Buffer.from(STATS_SEED, "utf8");
const REFERRAL_SEED_BYTES = Buffer.from(REFERRAL_SEED, "utf8");

export function deriveVaultPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED_BYTES], programId);
}

export function deriveV2StatePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_V2_SEED_BYTES], programId);
}

export function deriveLpPositionPda(
  programId: PublicKey,
  user: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([LP_SEED_BYTES, user.toBuffer()], programId);
}

export function deriveGamePda(programId: PublicKey, player: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([GAME_SEED_BYTES, player.toBuffer()], programId);
}

/** Magicblock ER GameSessionV2 PDA. Distinct seed from deriveGamePda so a
 *  player can have both an L1 (legacy) and an ER (V2) game in flight if
 *  ever needed — though current production only initializes one at a time
 *  depending on MAGICBLOCK_ENABLED. */
export function deriveGameV2Pda(programId: PublicKey, player: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([GAME_V2_SEED_BYTES, player.toBuffer()], programId);
}

export function derivePlayerStatsPda(
  programId: PublicKey,
  player: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([STATS_SEED_BYTES, player.toBuffer()], programId);
}

export function deriveReferralPda(
  programId: PublicKey,
  referrer: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [REFERRAL_SEED_BYTES, referrer.toBuffer()],
    programId,
  );
}
