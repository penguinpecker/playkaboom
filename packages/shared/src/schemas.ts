import { z } from "zod";

const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const PublicKeyString = z.string().regex(base58, "Invalid base58 pubkey");

export const CleanupInput = z.object({
  player: PublicKeyString,
  gameToken: z.string().min(1).optional(),
});

export type CleanupInputT = z.infer<typeof CleanupInput>;
