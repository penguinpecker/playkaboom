import { PublicKey } from "@solana/web3.js";
import { accountDiscriminator } from "./discriminator.js";

const VAULT_DISC = accountDiscriminator("Vault");
const GAME_DISC = accountDiscriminator("GameSession");

export type GameStatus = "Playing" | "Won" | "Lost" | "Expired";

export interface VaultAccount {
  owner: PublicKey;
  houseAuthority: PublicKey;
  treasury: PublicKey;
  bump: number;
  houseEdgeBps: number;
  maxBetBps: number;
  maxPayoutBps: number;
  totalGames: bigint;
  totalWagered: bigint;
  totalPayouts: bigint;
  paused: boolean;
  version: number;
}

export interface GameSessionAccount {
  player: PublicKey;
  bump: number;
  status: GameStatus;
  bet: bigint;
  mineCount: number;
  commitment: Buffer;
  revealedMask: number;
  revealedSafeMask: number;
  safeReveals: number;
  multiplierBps: bigint;
  startSlot: bigint;
  createdAt: bigint;
  settled: boolean;
  mineLayout: number;
  salt: Buffer;
  version: number;
}

const GAME_STATUS: GameStatus[] = ["Playing", "Won", "Lost", "Expired"];

export function decodeVault(data: Buffer): VaultAccount {
  if (!data.subarray(0, 8).equals(VAULT_DISC)) {
    throw new Error("not a Vault account");
  }
  let offset = 8;
  const readPk = () => {
    const pk = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    return pk;
  };
  const readU64 = () => {
    const v = data.readBigUInt64LE(offset);
    offset += 8;
    return v;
  };
  const owner = readPk();
  const houseAuthority = readPk();
  const treasury = readPk();
  const bump = data.readUInt8(offset++);
  const houseEdgeBps = data.readUInt16LE(offset);
  offset += 2;
  const maxBetBps = data.readUInt16LE(offset);
  offset += 2;
  const maxPayoutBps = data.readUInt16LE(offset);
  offset += 2;
  const totalGames = readU64();
  const totalWagered = readU64();
  const totalPayouts = readU64();
  const paused = data.readUInt8(offset++) === 1;
  const version = data.readUInt8(offset++);

  return {
    owner,
    houseAuthority,
    treasury,
    bump,
    houseEdgeBps,
    maxBetBps,
    maxPayoutBps,
    totalGames,
    totalWagered,
    totalPayouts,
    paused,
    version,
  };
}

export function decodeGameSession(data: Buffer): GameSessionAccount {
  if (!data.subarray(0, 8).equals(GAME_DISC)) {
    throw new Error("not a GameSession account");
  }
  let offset = 8;
  const readPk = () => {
    const pk = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    return pk;
  };
  const readU64 = () => {
    const v = data.readBigUInt64LE(offset);
    offset += 8;
    return v;
  };
  const readI64 = () => {
    const v = data.readBigInt64LE(offset);
    offset += 8;
    return v;
  };
  const readU16 = () => {
    const v = data.readUInt16LE(offset);
    offset += 2;
    return v;
  };
  const player = readPk();
  const bump = data.readUInt8(offset++);
  const statusByte = data.readUInt8(offset++);
  const status: GameStatus = GAME_STATUS[statusByte] ?? "Playing";
  const bet = readU64();
  const mineCount = data.readUInt8(offset++);
  const commitment = Buffer.from(data.subarray(offset, offset + 32));
  offset += 32;
  const revealedMask = readU16();
  const revealedSafeMask = readU16();
  const safeReveals = data.readUInt8(offset++);
  const multiplierBps = readU64();
  const startSlot = readU64();
  const createdAt = readI64();
  const settled = data.readUInt8(offset++) === 1;
  const mineLayout = readU16();
  const salt = Buffer.from(data.subarray(offset, offset + 32));
  offset += 32;
  const version = data.readUInt8(offset++);

  return {
    player,
    bump,
    status,
    bet,
    mineCount,
    commitment,
    revealedMask,
    revealedSafeMask,
    safeReveals,
    multiplierBps,
    startSlot,
    createdAt,
    settled,
    mineLayout,
    salt,
    version,
  };
}
