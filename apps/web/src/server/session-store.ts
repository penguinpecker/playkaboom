import "server-only";
import { PublicKey } from "@solana/web3.js";
import { deriveGamePda } from "@playkaboom/sdk";
import { decryptSession, encryptSession, type SessionPayload } from "./session";
import { query, upsert } from "./db/pg";
import { programId } from "./env";
import { logger } from "./logger";

/**
 * Persists encrypted gameToken to Postgres keyed by GameSession PDA. The
 * server is the only thing that can decrypt (SESSION_ENC_KEY) — the database
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
  try {
    await upsert("game_sessions", row, ["game"]);
  } catch (error) {
    // Mirror is best-effort: if the database is down, we still return the
    // ciphertext to the client. The client-side localStorage path stays
    // working; only cross-device recovery is degraded.
    logger.warn(
      { err: error instanceof Error ? error.message : String(error), player },
      "saveSession upsert failed — degraded to client-only token",
    );
  }
  return ciphertext;
}

/**
 * Resolve a session for a (player) request. Tries the client-supplied
 * `gameToken` first (fast, no DB hit). Falls back to the database if absent or
 * malformed. Returns null only if neither path yields a valid session for
 * the active GameSession.
 */
export async function loadSession(
  player: string,
  clientGameToken?: string,
  /**
   * Hex commitment of the game this session MUST belong to, read from chain.
   *
   * A caller-supplied token is attacker-controlled input. Checking only that
   * `decoded.player === player` proves the token was once issued to this
   * wallet — NOT that it belongs to the round being played. Any token kept
   * from an earlier round therefore passed, letting the mine layout of game A
   * answer reveals for game B. The house then signs those reveals, and
   * `is_mine` is an instruction parameter the program cannot validate.
   *
   * Callers on a money path MUST pass this. It is optional only so read-only
   * callers (session probes) can omit it.
   */
  expectedCommitment?: string,
): Promise<SessionPayload | null> {
  if (clientGameToken) {
    try {
      const decoded = decryptSession(clientGameToken);
      if (
        decoded.player === player &&
        (expectedCommitment === undefined || decoded.commitment === expectedCommitment)
      ) {
        return decoded;
      }
      // Token is valid but belongs to a different round — fall through to the
      // server-side row, which is keyed by the CURRENT game PDA and therefore
      // cannot be swapped by the caller.
    } catch {
      /* fall through to server lookup */
    }
  }
  const [gamePda] = deriveGamePda(programId(), new PublicKey(player));
  let data: { ciphertext: string; player: string } | undefined;
  try {
    [data] = await query<{ ciphertext: string; player: string }>(
      "select ciphertext, player from public.game_sessions where game = $1",
      [gamePda.toBase58()],
    );
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error), player },
      "loadSession select failed",
    );
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
  // Errors were never checked here (supabase-js returned them); keep it non-fatal.
  await query("delete from public.game_sessions where game = $1", [gamePda.toBase58()]).catch(
    () => undefined,
  );
}
