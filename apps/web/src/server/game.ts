import "server-only";
import type { SessionPayload } from "./session";

// Legacy commit-reveal helpers kept for wind-down only (settle_game of a stray
// legacy game needs its salt). New legacy games cannot start: the program
// rejects start_game with 6057 LegacyModeDisabled.

export function saltBuffer(session: SessionPayload): Buffer {
  return Buffer.from(session.salt, "hex");
}
