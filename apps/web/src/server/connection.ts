import { Connection } from "@solana/web3.js";
import { solanaRpc } from "./env.js";

let cached: Connection | null = null;
export function getConnection(): Connection {
  if (!cached) {
    cached = new Connection(solanaRpc(), {
      commitment: "confirmed",
      // Disable WS so serverless cold starts don't waste time opening sockets.
      disableRetryOnRateLimit: false,
    });
  }
  return cached;
}
