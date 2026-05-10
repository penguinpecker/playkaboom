import "server-only";
import { Connection, PublicKey } from "@solana/web3.js";
import { magicblockErUrl, magicblockErWsUrl } from "./env";
import { getConnection } from "./connection";

/**
 * Magicblock Ephemeral Rollup integration helpers.
 *
 * Feature-flagged behind MAGICBLOCK_ENABLED — see env.ts:useMagicblock().
 * When enabled, per-tile reveals are routed through a regional ER endpoint
 * and signed by an ephemeral per-game session key (see session-keys.ts),
 * dropping our Turnkey HSM call count from ~17/game to 2/game (delegate +
 * settle).
 *
 * Endpoint defaults to Asia (https://as.magicblock.app/) — closest to our
 * user base. Override via MAGICBLOCK_ER_URL / MAGICBLOCK_ER_WS_URL.
 */

let cachedErConnection: Connection | null = null;

/**
 * Singleton Connection pointed at the configured Magicblock ER endpoint.
 * Commitment is "confirmed" so callers see writes from the ER validator
 * before they're committed back to L1.
 */
export function getErConnection(): Connection {
  if (cachedErConnection) return cachedErConnection;
  cachedErConnection = new Connection(magicblockErUrl(), {
    commitment: "confirmed",
    wsEndpoint: magicblockErWsUrl(),
    disableRetryOnRateLimit: false,
  });
  return cachedErConnection;
}

/**
 * Thin re-export of the existing L1 (mainnet/devnet) connection. Lets ER-aware
 * code import both connection accessors from one module without reaching
 * across server/ for the L1 one.
 */
export function getL1Connection(): Connection {
  return getConnection();
}

/**
 * Known Magicblock validator pubkeys per region. These are the validator
 * identity keys that own delegated PDAs while a game is running. They're
 * needed by the program's `delegate_game` / `undelegate` CPI calls.
 *
 * NOTE: These are placeholders. The parallel Anchor agent (or Magicblock
 * support) will confirm the exact mainnet validator identity per region.
 * For now the helper returns a derivable region tag; callers can pass the
 * resolved Pubkey from env if it's set, otherwise we throw at use time.
 */
export type ErRegion = "as" | "us" | "eu";

export function regionFromUrl(url: string): ErRegion {
  if (url.includes("us.magicblock")) return "us";
  if (url.includes("eu.magicblock")) return "eu";
  return "as";
}

/**
 * Returns the validator pubkey for the configured region. Reads from
 * MAGICBLOCK_VALIDATOR_<REGION> env (e.g. MAGICBLOCK_VALIDATOR_AS). Throws
 * if unset — caller should only invoke this when actually building a
 * delegation ix.
 */
export function getValidatorPubkey(): PublicKey {
  const region = regionFromUrl(magicblockErUrl());
  const envName = `MAGICBLOCK_VALIDATOR_${region.toUpperCase()}`;
  const raw = process.env[envName];
  if (!raw) {
    throw new Error(
      `${envName} is not set — required to build delegate_game ix for region "${region}"`,
    );
  }
  return new PublicKey(raw);
}
