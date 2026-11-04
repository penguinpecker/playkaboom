import { Connection } from "@solana/web3.js";
import { erRpc, solanaRpc } from "./env";

let cached: Connection | null = null;
export function getConnection(): Connection {
  if (!cached) {
    cached = new Connection(solanaRpc(), {
      commitment: "confirmed",
      disableRetryOnRateLimit: false,
    });
  }
  return cached;
}

let cachedEr: Connection | null = null;
/** MagicBlock ephemeral rollup (pinned validator's node), for house ER txs and reads. */
export function getErConnection(): Connection {
  if (!cachedEr) cachedEr = new Connection(erRpc(), { commitment: "confirmed" });
  return cachedEr;
}
