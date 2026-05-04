import { PublicKey } from "@solana/web3.js";
import { GAME_SEED, VAULT_SEED } from "@playkaboom/shared";

const VAULT_SEED_BYTES = Buffer.from(VAULT_SEED, "utf8");
const GAME_SEED_BYTES = Buffer.from(GAME_SEED, "utf8");

export function deriveVaultPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED_BYTES], programId);
}

export function deriveGamePda(programId: PublicKey, player: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([GAME_SEED_BYTES, player.toBuffer()], programId);
}
