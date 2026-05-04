import {
  Connection,
  PublicKey,
  type Commitment,
  type ConfirmOptions,
  type SendOptions,
  Transaction,
  ComputeBudgetProgram,
  type TransactionInstruction,
  type Signer,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { decodeGameSession, decodeVault, type GameSessionAccount, type VaultAccount } from "./accounts.js";
import { deriveGamePda, deriveVaultPda } from "./pdas.js";

export interface KaboomClientOptions {
  connection: Connection;
  programId: PublicKey;
  /** Commitment used for reads. */
  commitment?: Commitment;
}

/**
 * Read-only / convenience client. Transaction sending lives in the caller
 * (browser wallet, server hot wallet) — the SDK doesn't hide the signer.
 */
export class KaboomClient {
  readonly connection: Connection;
  readonly programId: PublicKey;
  readonly commitment: Commitment;

  constructor(opts: KaboomClientOptions) {
    this.connection = opts.connection;
    this.programId = opts.programId;
    this.commitment = opts.commitment ?? "confirmed";
  }

  vaultPda(): PublicKey {
    return deriveVaultPda(this.programId)[0];
  }

  gamePda(player: PublicKey): PublicKey {
    return deriveGamePda(this.programId, player)[0];
  }

  async fetchVault(): Promise<VaultAccount | null> {
    const info = await this.connection.getAccountInfo(this.vaultPda(), this.commitment);
    return info ? decodeVault(info.data) : null;
  }

  async fetchGame(player: PublicKey): Promise<GameSessionAccount | null> {
    const info = await this.connection.getAccountInfo(this.gamePda(player), this.commitment);
    return info ? decodeGameSession(info.data) : null;
  }

  async getVaultBalance(): Promise<bigint> {
    const lamports = await this.connection.getBalance(this.vaultPda(), this.commitment);
    return BigInt(lamports);
  }

  /**
   * Build a v0 transaction. Caller signs and sends — keeps signing out of the SDK.
   */
  async buildV0Tx(
    payer: PublicKey,
    instructions: TransactionInstruction[],
    opts?: { computeUnitLimit?: number; computeUnitPriceMicroLamports?: number },
  ): Promise<VersionedTransaction> {
    const { blockhash } = await this.connection.getLatestBlockhash(this.commitment);
    const ixs: TransactionInstruction[] = [];
    if (opts?.computeUnitPriceMicroLamports !== undefined) {
      ixs.push(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: opts.computeUnitPriceMicroLamports,
        }),
      );
    }
    if (opts?.computeUnitLimit !== undefined) {
      ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnitLimit }));
    }
    ixs.push(...instructions);
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message();
    return new VersionedTransaction(message);
  }
}
