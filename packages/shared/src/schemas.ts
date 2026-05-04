import { z } from "zod";
import { GRID_SIZE, MAX_MINES, MIN_BET_LAMPORTS, MIN_MINES } from "./constants.js";

const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const PublicKeyString = z.string().regex(base58, "Invalid base58 pubkey");

export const StartGameInput = z.object({
  player: PublicKeyString,
  mineCount: z.number().int().min(MIN_MINES).max(MAX_MINES),
  betLamports: z
    .union([z.bigint(), z.string(), z.number()])
    .transform((v) => (typeof v === "bigint" ? v : BigInt(v)))
    .refine((v) => v >= MIN_BET_LAMPORTS, "Bet below minimum"),
});

export const RevealTileInput = z.object({
  player: PublicKeyString,
  tileIndex: z.number().int().min(0).max(GRID_SIZE - 1),
  gameToken: z.string().min(1),
});

export const SettleInput = z.object({
  player: PublicKeyString,
  gameToken: z.string().min(1),
  phase: z.enum(["cashout", "settle"]).optional(),
});

export const CleanupInput = z.object({
  player: PublicKeyString,
  gameToken: z.string().min(1).optional(),
});

export type StartGameInputT = z.infer<typeof StartGameInput>;
export type RevealTileInputT = z.infer<typeof RevealTileInput>;
export type SettleInputT = z.infer<typeof SettleInput>;
export type CleanupInputT = z.infer<typeof CleanupInput>;
