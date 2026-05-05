import { PublicKey } from "@solana/web3.js";
import { accountDiscriminator } from "./discriminator";

const VAULT_DISC = accountDiscriminator("Vault");
const GAME_DISC = accountDiscriminator("GameSession");
const STATS_DISC = accountDiscriminator("PlayerStats");
const REFERRAL_DISC = accountDiscriminator("ReferralAccount");

const MAX_ALLOWLIST = 8;

export type GameStatus = "Playing" | "Won" | "Lost" | "Expired";

export interface VaultAccount {
  owner: PublicKey;
  houseAuthority: PublicKey;
  treasury: PublicKey;
  bump: number;
  houseEdgeBps: number;
  maxBetBps: number;
  maxPayoutBps: number;
  treasurySplitBps: number;
  totalGames: bigint;
  totalWagered: bigint;
  totalPayouts: bigint;
  paused: boolean;
  version: number;
  allowlistCount: number;
  withdrawAllowlist: PublicKey[];
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

export interface PlayerStatsAccount {
  player: PublicKey;
  bump: number;
  version: number;
  gamesPlayed: bigint;
  gamesWon: bigint;
  totalWagered: bigint;
  totalPayouts: bigint;
  biggestWin: bigint;
  biggestMultiplierBps: bigint;
  currentStreak: number;
  bestStreak: number;
  lastPlayed: bigint;
  referrer: PublicKey | null;
}

export interface ReferralAccountData {
  referrer: PublicKey;
  bump: number;
  version: number;
  tier: number;
  accruedLamports: bigint;
  totalEarned: bigint;
  referredCount: number;
  referredVolume: bigint;
}

const GAME_STATUS: GameStatus[] = ["Playing", "Won", "Lost", "Expired"];

class Reader {
  private offset = 0;
  constructor(private data: Buffer) {}
  pk(): PublicKey {
    const pk = new PublicKey(this.data.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return pk;
  }
  u8(): number {
    const v = this.data.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }
  u16(): number {
    const v = this.data.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }
  u32(): number {
    const v = this.data.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
  u64(): bigint {
    const v = this.data.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  i64(): bigint {
    const v = this.data.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  bytes(n: number): Buffer {
    const slice = Buffer.from(this.data.subarray(this.offset, this.offset + n));
    this.offset += n;
    return slice;
  }
  bool(): boolean {
    return this.u8() === 1;
  }
  /** Anchor's `Option<Pubkey>`: 1-byte tag, then 32 bytes if Some — but layout is fixed-size in the program (1 + 32 always allocated). */
  optionPk(): PublicKey | null {
    const tag = this.u8();
    if (tag === 0) {
      this.offset += 32;
      return null;
    }
    return this.pk();
  }
}

export function decodeVault(data: Buffer): VaultAccount {
  if (!data.subarray(0, 8).equals(VAULT_DISC)) throw new Error("not a Vault account");
  const r = new Reader(data.subarray(8) as Buffer);
  const owner = r.pk();
  const houseAuthority = r.pk();
  const treasury = r.pk();
  const bump = r.u8();
  const houseEdgeBps = r.u16();
  const maxBetBps = r.u16();
  const maxPayoutBps = r.u16();
  const treasurySplitBps = r.u16();
  const totalGames = r.u64();
  const totalWagered = r.u64();
  const totalPayouts = r.u64();
  const paused = r.bool();
  const version = r.u8();
  const allowlistCount = r.u8();
  const allowlist: PublicKey[] = [];
  for (let i = 0; i < MAX_ALLOWLIST; i++) {
    allowlist.push(r.pk());
  }
  return {
    owner,
    houseAuthority,
    treasury,
    bump,
    houseEdgeBps,
    maxBetBps,
    maxPayoutBps,
    treasurySplitBps,
    totalGames,
    totalWagered,
    totalPayouts,
    paused,
    version,
    allowlistCount,
    withdrawAllowlist: allowlist.slice(0, allowlistCount),
  };
}

export function decodeGameSession(data: Buffer): GameSessionAccount {
  if (!data.subarray(0, 8).equals(GAME_DISC)) throw new Error("not a GameSession account");
  const r = new Reader(data.subarray(8) as Buffer);
  const player = r.pk();
  const bump = r.u8();
  const status: GameStatus = GAME_STATUS[r.u8()] ?? "Playing";
  const bet = r.u64();
  const mineCount = r.u8();
  const commitment = r.bytes(32);
  const revealedMask = r.u16();
  const revealedSafeMask = r.u16();
  const safeReveals = r.u8();
  const multiplierBps = r.u64();
  const startSlot = r.u64();
  const createdAt = r.i64();
  const settled = r.bool();
  const mineLayout = r.u16();
  const salt = r.bytes(32);
  const version = r.u8();
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

export function decodePlayerStats(data: Buffer): PlayerStatsAccount {
  if (!data.subarray(0, 8).equals(STATS_DISC))
    throw new Error("not a PlayerStats account");
  const r = new Reader(data.subarray(8) as Buffer);
  const player = r.pk();
  const bump = r.u8();
  const version = r.u8();
  const gamesPlayed = r.u64();
  const gamesWon = r.u64();
  const totalWagered = r.u64();
  const totalPayouts = r.u64();
  const biggestWin = r.u64();
  const biggestMultiplierBps = r.u64();
  const currentStreak = r.u32();
  const bestStreak = r.u32();
  const lastPlayed = r.i64();
  const referrer = r.optionPk();
  return {
    player,
    bump,
    version,
    gamesPlayed,
    gamesWon,
    totalWagered,
    totalPayouts,
    biggestWin,
    biggestMultiplierBps,
    currentStreak,
    bestStreak,
    lastPlayed,
    referrer,
  };
}

export function decodeReferralAccount(data: Buffer): ReferralAccountData {
  if (!data.subarray(0, 8).equals(REFERRAL_DISC))
    throw new Error("not a ReferralAccount account");
  const r = new Reader(data.subarray(8) as Buffer);
  const referrer = r.pk();
  const bump = r.u8();
  const version = r.u8();
  const tier = r.u8();
  const accruedLamports = r.u64();
  const totalEarned = r.u64();
  const referredCount = r.u32();
  const referredVolume = r.u64();
  return {
    referrer,
    bump,
    version,
    tier,
    accruedLamports,
    totalEarned,
    referredCount,
    referredVolume,
  };
}
