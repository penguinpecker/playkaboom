import "server-only";
import { PublicKey } from "@solana/web3.js";
import { deriveGamePda } from "@playkaboom/sdk";
import { decryptSession, encryptSession, type SessionPayload } from "./session";
import { supabaseAdmin } from "./db/supabase";
import { programId } from "./env";
import { logger } from "./logger";

/**
 * Persists encrypted gameToken to Supabase keyed by GameSession PDA. The
 * server is the only thing that can decrypt (SESSION_ENC_KEY) — Supabase
 * holds ciphertext only. This lets a player recover an in-flight game from
 * any device, not just the one with the localStorage token.
 *
 * `betLamports`/`mineCount`/`startSlot` are stored in plaintext for ops
 * visibility — same data that's on-chain anyway, just easier to query.
 */
export interface SaveSessionMeta {
  betLamports?: bigint;
  mineCount?: number;
  startSlot?: number;
}

export async function saveSession(
  player: string,
  payload: SessionPayload,
  createdSlot: number,
  meta?: SaveSessionMeta,
): Promise<string> {
  const ciphertext = encryptSession(payload);
  const [gamePda] = deriveGamePda(programId(), new PublicKey(player));
  const row: Record<string, unknown> = {
    game: gamePda.toBase58(),
    player,
    ciphertext,
    created_slot: createdSlot,
  };
  if (meta?.betLamports !== undefined) row.bet_lamports = meta.betLamports.toString();
  if (meta?.mineCount !== undefined) row.mine_count = meta.mineCount;
  if (meta?.startSlot !== undefined) row.start_slot = meta.startSlot;
  const { error } = await supabaseAdmin().from("game_sessions").upsert(row, {
    onConflict: "game",
  });
  if (error) {
    // Mirror is best-effort: if Supabase is down, we still return the
    // ciphertext to the client. The client-side localStorage path stays
    // working; only cross-device recovery is degraded.
    logger.warn(
      { err: error.message, player },
      "saveSession upsert failed — degraded to client-only token",
    );
  }
  return ciphertext;
}

/**
 * Resolve a session for a (player) request. Tries the client-supplied
 * `gameToken` first (fast, no DB hit). Falls back to Supabase if absent or
 * malformed. Returns null only if neither path yields a valid session for
 * the active GameSession.
 */
export async function loadSession(
  player: string,
  clientGameToken?: string,
): Promise<SessionPayload | null> {
  if (clientGameToken) {
    try {
      const decoded = decryptSession(clientGameToken);
      if (decoded.player === player) return decoded;
    } catch {
      /* fall through to server lookup */
    }
  }
  const [gamePda] = deriveGamePda(programId(), new PublicKey(player));
  const { data, error } = await supabaseAdmin()
    .from("game_sessions")
    .select("ciphertext, player")
    .eq("game", gamePda.toBase58())
    .maybeSingle();
  if (error) {
    logger.warn({ err: error.message, player }, "loadSession select failed");
    return null;
  }
  if (!data || data.player !== player) return null;
  try {
    return decryptSession(data.ciphertext);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, player },
      "loadSession decrypt failed",
    );
    return null;
  }
}

/** Remove the row when a game is closed/refunded/settled. Idempotent. */
export async function deleteSession(player: string): Promise<void> {
  const [gamePda] = deriveGamePda(programId(), new PublicKey(player));
  await supabaseAdmin().from("game_sessions").delete().eq("game", gamePda.toBase58());
}
