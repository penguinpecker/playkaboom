// SDK surface for the relaunch program (pinocchio/spec/FIXES.md section 9.2):
// the two appended instructions, the unsigned complete_withdraw, VrfStatus
// Void, and the appended error codes. Byte-exact against the spec; the
// program-side acceptance of the same instructions is
// pinocchio/difftest/tests/sdk_flows.rs.
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  accountDiscriminator,
  buildCompleteWithdraw,
  buildExpireGame,
  buildForceUndelegateVrf,
  decodeVrfGame,
  deriveGamePda,
  deriveV2StatePda,
  deriveVaultPda,
  deriveVrfGamePda,
  deriveVrfProgramIdentity,
  extractKaboomError,
  ixDiscriminator,
  kaboomErrorByCode,
  KABOOM_ERROR_NAMES,
  MAGIC_CONTEXT,
  MAGIC_PROGRAM,
} from "@playkaboom/sdk";
import { KABOOM_PROGRAM_ID, WITHDRAW_CLAIM_WINDOW_SLOTS } from "@playkaboom/shared";

const programId = new PublicKey(KABOOM_PROGRAM_ID);
const ctx = { programId };
const hex = (b: Buffer | Uint8Array) => Buffer.from(b).toString("hex");
const metas = (ix: { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }) =>
  ix.keys.map((k) => [k.pubkey.toBase58(), k.isWritable ? "W" : "r", k.isSigner ? "S" : "-"]);

describe("relaunch program ids (pinocchio/difftest ids::*)", () => {
  it("fixed PDAs under Ednka8...", () => {
    expect(deriveVaultPda(programId)[0].toBase58()).toBe("7dPQVB4GPQMGLWiuvALUFrnrWip83Csj2Qjgb2kYTeg7");
    expect(deriveV2StatePda(programId)[0].toBase58()).toBe("Gtkn8TeTHgMF6bhEYmXy3cDcmmQyjbbY3WHXtY3td8Ue");
    expect(deriveVrfProgramIdentity(programId).toBase58()).toBe("7LmGUyc5oTRr4RJpYmHf4g6gE5SeA2t5nW3DD2DepMuK");
    expect(deriveVaultPda(programId)[1]).toBe(254);
    expect(deriveV2StatePda(programId)[1]).toBe(255);
  });
});

describe("expire_game (F2)", () => {
  it("disc d0155783f22bfc90, no args, [vault W, v2 W, game W, player W unsigned]", () => {
    const player = Keypair.generate().publicKey;
    const ix = buildExpireGame({ ctx, player });
    expect(hex(ix.data)).toBe("d0155783f22bfc90");
    expect(hex(ixDiscriminator("expire_game"))).toBe("d0155783f22bfc90");
    expect(ix.programId.equals(programId)).toBe(true);
    expect(metas(ix)).toEqual([
      [deriveVaultPda(programId)[0].toBase58(), "W", "-"],
      [deriveV2StatePda(programId)[0].toBase58(), "W", "-"],
      [deriveGamePda(programId, player)[0].toBase58(), "W", "-"],
      [player.toBase58(), "W", "-"],
    ]);
  });
});

describe("force_undelegate_vrf (F3)", () => {
  it("disc da30a3da54f8e465, no args, [house WS, game W, magic r, magic_context W, vault r]", () => {
    const player = Keypair.generate().publicKey;
    const house = Keypair.generate().publicKey;
    const ix = buildForceUndelegateVrf({ ctx, player, house });
    expect(hex(ix.data)).toBe("da30a3da54f8e465");
    expect(hex(ixDiscriminator("force_undelegate_vrf"))).toBe("da30a3da54f8e465");
    expect(metas(ix)).toEqual([
      [house.toBase58(), "W", "S"],
      [deriveVrfGamePda(programId, player)[0].toBase58(), "W", "-"],
      [MAGIC_PROGRAM.toBase58(), "r", "-"],
      [MAGIC_CONTEXT.toBase58(), "W", "-"],
      [deriveVaultPda(programId)[0].toBase58(), "r", "-"],
    ]);
  });
});

describe("complete_withdraw (F4)", () => {
  it("user signs by default; userSigns:false leaves the user a writable non-signer", () => {
    const user = Keypair.generate().publicKey;
    const signed = buildCompleteWithdraw({ ctx, user });
    const keeper = buildCompleteWithdraw({ ctx, user, userSigns: false });
    expect(hex(keeper.data)).toBe(hex(ixDiscriminator("complete_withdraw")));
    expect(keeper.data).toEqual(signed.data);
    expect(metas(signed)[3]).toEqual([user.toBase58(), "W", "S"]);
    expect(metas(keeper)[3]).toEqual([user.toBase58(), "W", "-"]);
    // Every other meta is unchanged.
    expect(metas(keeper).slice(0, 3)).toEqual(metas(signed).slice(0, 3));
    expect(WITHDRAW_CLAIM_WINDOW_SLOTS).toBe(9_000);
  });
});

describe("VrfStatus", () => {
  const game = (status: number) => {
    const b = Buffer.alloc(621);
    accountDiscriminator("VrfGame").copy(b, 0);
    b[8] = status;
    return b;
  };
  it("decodes 0..3 as Playing, Won, Lost, Void", () => {
    expect([0, 1, 2, 3].map((s) => decodeVrfGame(game(s)).status)).toEqual(["Playing", "Won", "Lost", "Void"]);
  });
  it("throws on an unknown status instead of reading it as Playing", () => {
    expect(() => decodeVrfGame(game(4))).toThrow(/unknown VrfGame status 4/);
  });
});

describe("error codes 6055-6057", () => {
  it("are appended after WrongVrfValidator (6054)", () => {
    expect(KABOOM_ERROR_NAMES.length).toBe(58);
    expect(kaboomErrorByCode(6054)).toBe("WrongVrfValidator");
    expect(kaboomErrorByCode(6055)).toBe("NotDeployer");
    expect(kaboomErrorByCode(6056)).toBe("WithdrawWindowExpired");
    expect(kaboomErrorByCode(6057)).toBe("LegacyModeDisabled");
    expect(kaboomErrorByCode(6058)).toBeUndefined();
  });
  it("decode from the runtime's hex form (the port logs no AnchorError lines)", () => {
    const err = (code: number) => ({ logs: [`Program ${KABOOM_PROGRAM_ID} failed: custom program error: 0x${code.toString(16)}`] });
    expect(extractKaboomError(err(6057))).toBe("LegacyModeDisabled");
    expect(extractKaboomError(err(6056))).toBe("WithdrawWindowExpired");
    expect(extractKaboomError(err(6022))).toBe("ReferralMismatch");
  });
});
