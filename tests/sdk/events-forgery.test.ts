import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  assertProgramInvoked,
  extractEventsFromLogs,
  eventDiscriminator,
} from "@playkaboom/sdk";

// These tests are written as the ATTACK, not as the happy path. Each one
// forges the exact payload an attacker would emit and asserts we refuse it.
//
// The bug they pin: extractEventsFromLogs used to decode every `Program data:`
// line in a transaction regardless of which program emitted it, so anyone
// could publish our discriminator from their own program and have the indexer
// write fake games, fake leaderboard entries and fake points — and have the
// public /verify endpoint attest to a game that never happened.

const KABOOM = new PublicKey("9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh");
const ATTACKER = new PublicKey("11111111111111111111111111111112");

/**
 * A GameSettled payload, matching the on-chain event layout exactly:
 * disc | player(32) | game(32) | mineCount(u8) | mineLayout(u16) |
 * salt(32) | commitment(32) | verified(bool) | slot(u64).
 */
function forgeGameSettled(player: PublicKey, mineLayout: number): string {
  const disc = eventDiscriminator("GameSettled");
  const body = Buffer.alloc(32 + 32 + 1 + 2 + 32 + 32 + 1 + 8);
  player.toBuffer().copy(body, 0);
  player.toBuffer().copy(body, 32);
  body.writeUInt8(3, 64);
  body.writeUInt16LE(mineLayout & 0xffff, 65);
  body.fill(0xaa, 67, 99);
  body.fill(0xbb, 99, 131);
  body.writeUInt8(1, 131);
  body.writeBigUInt64LE(1n, 132);
  return `Program data: ${Buffer.concat([disc, body]).toString("base64")}`;
}

describe("event log forgery", () => {
  const victim = new PublicKey("9qDnHBWKvo5CjFk3mZmSFS3pq8bLfGSmTtXP6gHeeWAK");

  it("ignores our discriminator emitted by a FOREIGN program", () => {
    const logs = [
      `Program ${ATTACKER.toBase58()} invoke [1]`,
      forgeGameSettled(victim, 0xbeef),
      `Program ${ATTACKER.toBase58()} success`,
    ];
    expect(extractEventsFromLogs(logs, KABOOM)).toHaveLength(0);
  });

  it("still decodes events our own program emits", () => {
    const logs = [
      `Program ${KABOOM.toBase58()} invoke [1]`,
      forgeGameSettled(victim, 0x000b),
      `Program ${KABOOM.toBase58()} success`,
    ];
    const events = extractEventsFromLogs(logs, KABOOM);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("GameSettled");
  });

  it("ignores a foreign CPI nested inside our own invocation", () => {
    // Attacker's program is called BY us (or alongside us) and emits the
    // payload at depth 2. The top of the invoke stack is theirs, not ours.
    const logs = [
      `Program ${KABOOM.toBase58()} invoke [1]`,
      `Program ${ATTACKER.toBase58()} invoke [2]`,
      forgeGameSettled(victim, 0xbeef),
      `Program ${ATTACKER.toBase58()} success`,
      `Program ${KABOOM.toBase58()} success`,
    ];
    expect(extractEventsFromLogs(logs, KABOOM)).toHaveLength(0);
  });

  it("resumes decoding after a foreign CPI returns", () => {
    const logs = [
      `Program ${KABOOM.toBase58()} invoke [1]`,
      `Program ${ATTACKER.toBase58()} invoke [2]`,
      forgeGameSettled(victim, 0xbeef),
      `Program ${ATTACKER.toBase58()} success`,
      forgeGameSettled(victim, 0x1234),
      `Program ${KABOOM.toBase58()} success`,
    ];
    const events = extractEventsFromLogs(logs, KABOOM);
    expect(events).toHaveLength(1);
    expect(
      events[0]?.kind === "GameSettled" ? events[0].mineLayout : null,
    ).toBe(0x1234);
  });

  it("attributes correctly when a failed invocation pops the stack", () => {
    const logs = [
      `Program ${ATTACKER.toBase58()} invoke [1]`,
      `Program ${ATTACKER.toBase58()} failed: custom program error: 0x1`,
      forgeGameSettled(victim, 0xbeef),
    ];
    expect(extractEventsFromLogs(logs, KABOOM)).toHaveLength(0);
  });

  it("decodes nothing when there is no invocation context at all", () => {
    expect(
      extractEventsFromLogs([forgeGameSettled(victim, 0x0007)], KABOOM),
    ).toHaveLength(0);
  });
});

describe("assertProgramInvoked", () => {
  it("rejects a transaction that never touches our program", () => {
    const tx = {
      transaction: { message: { accountKeys: [ATTACKER.toBase58()] } },
      meta: { innerInstructions: [] },
    };
    expect(assertProgramInvoked(tx, KABOOM)).toBe(false);
  });

  it("accepts a transaction whose account keys include our program", () => {
    const tx = {
      transaction: {
        message: { accountKeys: [ATTACKER.toBase58(), KABOOM.toBase58()] },
      },
      meta: { innerInstructions: [] },
    };
    expect(assertProgramInvoked(tx, KABOOM)).toBe(true);
  });

  it("accepts PublicKey-shaped and parsed account key entries", () => {
    expect(
      assertProgramInvoked(
        { transaction: { message: { accountKeys: [KABOOM] } } },
        KABOOM,
      ),
    ).toBe(true);
    expect(
      assertProgramInvoked(
        { transaction: { message: { accountKeys: [{ pubkey: KABOOM }] } } },
        KABOOM,
      ),
    ).toBe(true);
  });

  it("handles a malformed transaction without throwing", () => {
    expect(assertProgramInvoked({}, KABOOM)).toBe(false);
  });
});
