import { sha256 } from "@noble/hashes/sha256";
import { PublicKey } from "@solana/web3.js";

/** Anchor event discriminator: SHA-256("event:" + name)[0..8]. */
function eventDiscriminator(name: string): Buffer {
  const digest = sha256(new TextEncoder().encode(`event:${name}`));
  return Buffer.from(digest.subarray(0, 8));
}

const PROGRAM_DATA_PREFIX = "Program data: ";

class EventReader {
  private offset = 8; // skip discriminator
  constructor(private data: Buffer) {}
  pk(): PublicKey {
    const pk = new PublicKey(this.data.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return pk;
  }
  u8(): number {
    return this.data.readUInt8(this.offset++);
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
  bool(): boolean {
    return this.u8() === 1;
  }
  bytes(n: number): Buffer {
    const slice = Buffer.from(this.data.subarray(this.offset, this.offset + n));
    this.offset += n;
    return slice;
  }
  u128(): bigint {
    const lo = this.data.readBigUInt64LE(this.offset);
    const hi = this.data.readBigUInt64LE(this.offset + 8);
    this.offset += 16;
    return (hi << 64n) | lo;
  }
}

// ── Event payloads ───────────────────────────────────────────────────────────

export interface StatsUpdatedEvent {
  kind: "StatsUpdated";
  player: PublicKey;
  gamesPlayed: bigint;
  gamesWon: bigint;
  totalWagered: bigint;
  totalPayouts: bigint;
  biggestWin: bigint;
  currentStreak: number;
  slot: bigint;
}

export interface GameSettledEvent {
  kind: "GameSettled";
  player: PublicKey;
  game: PublicKey;
  mineCount: number;
  mineLayout: number;
  salt: Buffer;
  commitment: Buffer;
  verified: boolean;
  slot: bigint;
}

export interface GameWonEvent {
  kind: "GameWon";
  player: PublicKey;
  game: PublicKey;
  bet: bigint;
  payout: bigint;
  multiplierBps: bigint;
  safeReveals: number;
  slot: bigint;
}

export interface GameLostEvent {
  kind: "GameLost";
  player: PublicKey;
  game: PublicKey;
  bet: bigint;
  tileIndex: number;
  safeReveals: number;
  slot: bigint;
}

export interface ReferrerSetEvent {
  kind: "ReferrerSet";
  player: PublicKey;
  referrer: PublicKey;
  slot: bigint;
}

export interface ReferralAccruedEvent {
  kind: "ReferralAccrued";
  referrer: PublicKey;
  player: PublicKey;
  amount: bigint;
  tier: number;
  slot: bigint;
}

export interface ReferralTierChangedEvent {
  kind: "ReferralTierChanged";
  referrer: PublicKey;
  newTier: number;
  slot: bigint;
}

export interface ReferralClaimedEvent {
  kind: "ReferralClaimed";
  referrer: PublicKey;
  amount: bigint;
  slot: bigint;
}

// Phase 2 event payloads ------------------------------------------------------

export interface V2InitializedEvent {
  kind: "V2Initialized";
  vault: PublicKey;
  seedUnits: bigint;
  houseUnits: bigint;
  totalUnits: bigint;
  slot: bigint;
}

export interface LpDepositedEvent {
  kind: "LpDeposited";
  user: PublicKey;
  amountLamports: bigint;
  unitsMinted: bigint;
  totalUnitsAfter: bigint;
  vaultAssetsAfter: bigint;
  slot: bigint;
}

export interface LpWithdrawRequestedEvent {
  kind: "LpWithdrawRequested";
  user: PublicKey;
  units: bigint;
  unlockSlot: bigint;
  slot: bigint;
}

export interface LpWithdrawCancelledEvent {
  kind: "LpWithdrawCancelled";
  user: PublicKey;
  unitsReturned: bigint;
  slot: bigint;
}

export interface LpWithdrawCompletedEvent {
  kind: "LpWithdrawCompleted";
  user: PublicKey;
  unitsBurned: bigint;
  amountLamports: bigint;
  totalUnitsAfter: bigint;
  vaultAssetsAfter: bigint;
  slot: bigint;
}

export interface LpPositionClosedEvent {
  kind: "LpPositionClosed";
  user: PublicKey;
  slot: bigint;
}

export interface HouseDepositedEvent {
  kind: "HouseDeposited";
  amountLamports: bigint;
  unitsMinted: bigint;
  totalUnitsAfter: bigint;
  slot: bigint;
}

export interface HouseWithdrawRequestedEvent {
  kind: "HouseWithdrawRequested";
  units: bigint;
  unlockSlot: bigint;
  slot: bigint;
}

export interface HouseWithdrawCancelledEvent {
  kind: "HouseWithdrawCancelled";
  unitsReturned: bigint;
  slot: bigint;
}

export interface HouseWithdrawCompletedEvent {
  kind: "HouseWithdrawCompleted";
  unitsBurned: bigint;
  amountLamports: bigint;
  slot: bigint;
}

export interface VaultUnitValueUpdatedEvent {
  kind: "VaultUnitValueUpdated";
  vault: PublicKey;
  vaultAssets: bigint;
  totalUnits: bigint;
  healthBps: number;
  slot: bigint;
}

export type KaboomEvent =
  | StatsUpdatedEvent
  | GameSettledEvent
  | GameWonEvent
  | GameLostEvent
  | ReferrerSetEvent
  | ReferralAccruedEvent
  | ReferralTierChangedEvent
  | ReferralClaimedEvent
  | V2InitializedEvent
  | LpDepositedEvent
  | LpWithdrawRequestedEvent
  | LpWithdrawCancelledEvent
  | LpWithdrawCompletedEvent
  | LpPositionClosedEvent
  | HouseDepositedEvent
  | HouseWithdrawRequestedEvent
  | HouseWithdrawCancelledEvent
  | HouseWithdrawCompletedEvent
  | VaultUnitValueUpdatedEvent;

// ── Decoders by name ─────────────────────────────────────────────────────────

const EVENTS: Record<
  string,
  { disc: Buffer; decode: (data: Buffer) => KaboomEvent }
> = {
  StatsUpdated: {
    disc: eventDiscriminator("StatsUpdated"),
    decode: (data) => {
      const r = new EventReader(data);
      return {
        kind: "StatsUpdated",
        player: r.pk(),
        gamesPlayed: r.u64(),
        gamesWon: r.u64(),
        totalWagered: r.u64(),
        totalPayouts: r.u64(),
        biggestWin: r.u64(),
        currentStreak: r.u32(),
        slot: r.u64(),
      };
    },
  },
  GameSettled: {
    disc: eventDiscriminator("GameSettled"),
    decode: (data) => {
      const r = new EventReader(data);
      return {
        kind: "GameSettled",
        player: r.pk(),
        game: r.pk(),
        mineCount: r.u8(),
        mineLayout: r.u16(),
        salt: r.bytes(32),
        commitment: r.bytes(32),
        verified: r.bool(),
        slot: r.u64(),
      };
    },
  },
  GameWon: {
    disc: eventDiscriminator("GameWon"),
    decode: (data) => {
      const r = new EventReader(data);
      return {
        kind: "GameWon",
        player: r.pk(),
        game: r.pk(),
        bet: r.u64(),
        payout: r.u64(),
        multiplierBps: r.u64(),
        safeReveals: r.u8(),
        slot: r.u64(),
      };
    },
  },
  GameLost: {
    disc: eventDiscriminator("GameLost"),
    decode: (data) => {
      const r = new EventReader(data);
      return {
        kind: "GameLost",
        player: r.pk(),
        game: r.pk(),
        bet: r.u64(),
        tileIndex: r.u8(),
        safeReveals: r.u8(),
        slot: r.u64(),
      };
    },
  },
  ReferrerSet: {
    disc: eventDiscriminator("ReferrerSet"),
    decode: (data) => {
      const r = new EventReader(data);
      return {
        kind: "ReferrerSet",
        player: r.pk(),
        referrer: r.pk(),
        slot: r.u64(),
      };
    },
  },
  ReferralAccrued: {
    disc: eventDiscriminator("ReferralAccrued"),
    decode: (data) => {
      const r = new EventReader(data);
      return {
        kind: "ReferralAccrued",
        referrer: r.pk(),
        player: r.pk(),
        amount: r.u64(),
        tier: r.u8(),
        slot: r.u64(),
      };
    },
  },
  ReferralTierChanged: {
    disc: eventDiscriminator("ReferralTierChanged"),
    decode: (data) => {
      const r = new EventReader(data);
      return {
        kind: "ReferralTierChanged",
        referrer: r.pk(),
        newTier: r.u8(),
        slot: r.u64(),
      };
    },
  },
  ReferralClaimed: {
    disc: eventDiscriminator("ReferralClaimed"),
    decode: (data) => {
      const r = new EventReader(data);
      return {
        kind: "ReferralClaimed",
        referrer: r.pk(),
        amount: r.u64(),
        slot: r.u64(),
      };
    },
  },
  V2Initialized: {
    disc: eventDiscriminator("V2Initialized"),
    decode: (data) => {
      const r = new EventReader(data);
      return {
        kind: "V2Initialized",
        vault: r.pk(),
        seedUnits: r.u128(),
        houseUnits: r.u128(),
        totalUnits: r.u128(),
        slot: r.u64(),
      };
    },
  },
  LpDeposited: {
    disc: eventDiscriminator("LpDeposited"),
    decode: (data) => {
      const r = new EventReader(data);
      return {
        kind: "LpDeposited",
        user: r.pk(),
        amountLamports: r.u64(),
        unitsMinted: r.u128(),
        totalUnitsAfter: r.u128(),
        vaultAssetsAfter: r.u64(),
        slot: r.u64(),
      };
    },
  },
  LpWithdrawRequested: {
    disc: eventDiscriminator("LpWithdrawRequested"),
    decode: (data) => {
      const r = new EventReader(data);
      return {
        kind: "LpWithdrawRequested",
        user: r.pk(),
        units: r.u128(),
        unlockSlot: r.u64(),
        slot: r.u64(),
      };
    },
  },
  LpWithdrawCancelled: {
    disc: eventDiscriminator("LpWithdrawCancelled"),
    decode: (data) => {
      const r = new EventReader(data);
      return {
        kind: "LpWithdrawCancelled",
        user: r.pk(),
        unitsReturned: r.u128(),
        slot: r.u64(),
      };
    },
  },
  LpWithdrawCompleted: {
    disc: eventDiscriminator("LpWithdrawCompleted"),
    decode: (data) => {
      const r = new EventReader(data);
      return {
        kind: "LpWithdrawCompleted",
        user: r.pk(),
        unitsBurned: r.u128(),
        amountLamports: r.u64(),
        totalUnitsAfter: r.u128(),
        vaultAssetsAfter: r.u64(),
        slot: r.u64(),
      };
    },
  },
  LpPositionClosed: {
    disc: eventDiscriminator("LpPositionClosed"),
    decode: (data) => {
      const r = new EventReader(data);
      return { kind: "LpPositionClosed", user: r.pk(), slot: r.u64() };
    },
  },
  HouseDeposited: {
    disc: eventDiscriminator("HouseDeposited"),
    decode: (data) => {
      const r = new EventReader(data);
      return {
        kind: "HouseDeposited",
        amountLamports: r.u64(),
        unitsMinted: r.u128(),
        totalUnitsAfter: r.u128(),
        slot: r.u64(),
      };
    },
  },
  HouseWithdrawRequested: {
    disc: eventDiscriminator("HouseWithdrawRequested"),
    decode: (data) => {
      const r = new EventReader(data);
      return {
        kind: "HouseWithdrawRequested",
        units: r.u128(),
        unlockSlot: r.u64(),
        slot: r.u64(),
      };
    },
  },
  HouseWithdrawCancelled: {
    disc: eventDiscriminator("HouseWithdrawCancelled"),
    decode: (data) => {
      const r = new EventReader(data);
      return {
        kind: "HouseWithdrawCancelled",
        unitsReturned: r.u128(),
        slot: r.u64(),
      };
    },
  },
  HouseWithdrawCompleted: {
    disc: eventDiscriminator("HouseWithdrawCompleted"),
    decode: (data) => {
      const r = new EventReader(data);
      return {
        kind: "HouseWithdrawCompleted",
        unitsBurned: r.u128(),
        amountLamports: r.u64(),
        slot: r.u64(),
      };
    },
  },
  VaultUnitValueUpdated: {
    disc: eventDiscriminator("VaultUnitValueUpdated"),
    decode: (data) => {
      const r = new EventReader(data);
      return {
        kind: "VaultUnitValueUpdated",
        vault: r.pk(),
        vaultAssets: r.u64(),
        totalUnits: r.u128(),
        healthBps: r.u16(),
        slot: r.u64(),
      };
    },
  },
};

/**
 * Walk Solana log lines, extract the base64 payload after each
 * `Program data: ` entry, match the leading 8 bytes against known events.
 */
export function extractEventsFromLogs(logs: string[]): KaboomEvent[] {
  const out: KaboomEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(line.slice(PROGRAM_DATA_PREFIX.length), "base64");
    } catch {
      continue;
    }
    if (buf.length < 8) continue;
    const disc = buf.subarray(0, 8);
    for (const def of Object.values(EVENTS)) {
      if (disc.equals(def.disc)) {
        try {
          out.push(def.decode(buf));
        } catch {
          /* ignore malformed */
        }
        break;
      }
    }
  }
  return out;
}

export { eventDiscriminator };
