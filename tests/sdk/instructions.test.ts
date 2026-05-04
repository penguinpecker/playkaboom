import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  buildStartGame,
  buildRevealTile,
  buildSettleGame,
  buildCashOut,
  buildCloseGame,
  ixDiscriminator,
  serializeIx,
  deserializeIx,
} from "@playkaboom/sdk";

const programId = new PublicKey("Kab1TestProgam11111111111111111111111111111");

describe("instruction builders", () => {
  it("start_game encodes mine_count + bet + commitment", () => {
    const player = Keypair.generate().publicKey;
    const commitment = Buffer.alloc(32, 1);
    const ix = buildStartGame({
      ctx: { programId },
      player,
      mineCount: 3,
      betLamports: 5_000_000n,
      commitment,
    });
    expect(ix.data.subarray(0, 8)).toEqual(ixDiscriminator("start_game"));
    expect(ix.data.readUInt8(8)).toBe(3);
    expect(ix.data.readBigUInt64LE(9)).toBe(5_000_000n);
    expect(ix.data.subarray(17, 49)).toEqual(commitment);
  });

  it("reveal_tile encodes index + is_mine", () => {
    const player = Keypair.generate().publicKey;
    const house = Keypair.generate().publicKey;
    const ix = buildRevealTile({ ctx: { programId }, player, houseAuthority: house, tileIndex: 7, isMine: true });
    expect(ix.data.readUInt8(8)).toBe(7);
    expect(ix.data.readUInt8(9)).toBe(1);
  });

  it("settle_game requires 32-byte salt", () => {
    const player = Keypair.generate().publicKey;
    const house = Keypair.generate().publicKey;
    expect(() =>
      buildSettleGame({
        ctx: { programId },
        player,
        houseAuthority: house,
        mineLayout: 0xff,
        salt: Buffer.alloc(31),
      }),
    ).toThrow();
  });

  it("cash_out and close_game are 8-byte discriminator only", () => {
    const player = Keypair.generate().publicKey;
    expect(buildCashOut({ ctx: { programId }, player }).data.length).toBe(8);
    expect(buildCloseGame({ ctx: { programId }, player }).data.length).toBe(8);
  });

  it("serializeIx ↔ deserializeIx round-trips", () => {
    const player = Keypair.generate().publicKey;
    const ix = buildCashOut({ ctx: { programId }, player });
    const ix2 = deserializeIx(serializeIx(ix));
    expect(ix2.programId.equals(ix.programId)).toBe(true);
    expect(ix2.data.equals(ix.data)).toBe(true);
    expect(ix2.keys.length).toBe(ix.keys.length);
  });
});
