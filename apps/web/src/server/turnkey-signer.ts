import "server-only";
import { PublicKey, Transaction, type VersionedTransaction } from "@solana/web3.js";
import { Turnkey } from "@turnkey/sdk-server";
import { TurnkeySigner } from "@turnkey/solana";
import { houseAuthority, turnkeyConfig, useTurnkey } from "./env";

export interface HouseSigner {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
}

const TURNKEY_API_BASE_URL = "https://api.turnkey.com";

let cachedTurnkeySigner: HouseSigner | null = null;
function turnkeyHouseSigner(): HouseSigner {
  if (cachedTurnkeySigner) return cachedTurnkeySigner;
  const cfg = turnkeyConfig();
  const tk = new Turnkey({
    apiBaseUrl: TURNKEY_API_BASE_URL,
    apiPublicKey: cfg.apiPublicKey,
    apiPrivateKey: cfg.apiPrivateKey,
    defaultOrganizationId: cfg.organizationId,
  });
  const signer = new TurnkeySigner({ organizationId: cfg.organizationId, client: tk.apiClient() });
  const pubkey = new PublicKey(cfg.housePubkey);
  cachedTurnkeySigner = {
    publicKey: pubkey,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      const signed = await signer.signTransaction(tx, cfg.housePubkey);
      return signed as T;
    },
  };
  return cachedTurnkeySigner;
}

let cachedLocalSigner: HouseSigner | null = null;
function localHouseSigner(): HouseSigner {
  if (cachedLocalSigner) return cachedLocalSigner;
  const kp = houseAuthority();
  cachedLocalSigner = {
    publicKey: kp.publicKey,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      if (tx instanceof Transaction) {
        tx.sign(kp);
      } else {
        tx.sign([kp]);
      }
      return tx;
    },
  };
  return cachedLocalSigner;
}

export function getHouseSigner(): HouseSigner {
  return useTurnkey() ? turnkeyHouseSigner() : localHouseSigner();
}
