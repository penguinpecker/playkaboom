import { describe, expect, it } from "vitest";
import {
  extractAnchorFrameworkError,
  extractKaboomError,
  isAccountNotInitializedError,
} from "@playkaboom/sdk";

// Real log shapes pulled from Solana RPC `SendTransactionError.logs` on
// Anchor 0.30 (the version the kaboom program is built against).
const ACCOUNT_NOT_INIT_LOGS = [
  "Program 9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh invoke [1]",
  "Program log: Instruction: RevealTile",
  "Program log: AnchorError caused by account: game. Error Code: AccountNotInitialized. Error Number: 3012. Error Message: The program expected this account to be already initialized.",
  "Program 9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh consumed 4218 of 200000 compute units",
  "Program 9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh failed: custom program error: 0xbc4",
];

const KABOOM_CUSTOM_LOGS = [
  "Program 9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh invoke [1]",
  "Program log: Instruction: RevealTile",
  "Program log: AnchorError occurred. Error Code: TileAlreadyRevealed. Error Number: 6003. Error Message: Tile already revealed.",
  "Program 9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh failed: custom program error: 0x1773",
];

// Pre-Anchor-0.27 / non-Anchor RPC servers sometimes drop only the hex code.
const HEX_ONLY_LOGS = [
  "Program 9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh failed: custom program error: 0xbc4",
];

describe("extractAnchorFrameworkError", () => {
  it("decodes AccountNotInitialized from the structured Anchor log line", () => {
    const fw = extractAnchorFrameworkError({ logs: ACCOUNT_NOT_INIT_LOGS });
    expect(fw).toEqual({ code: 3012, name: "AccountNotInitialized", account: "game" });
  });

  it("decodes AccountNotInitialized from a hex-only 'custom program error: 0xbc4' fallback", () => {
    const fw = extractAnchorFrameworkError({ logs: HEX_ONLY_LOGS });
    expect(fw).toEqual({ code: 3012, name: "AccountNotInitialized" });
  });

  it("returns undefined for non-Anchor errors", () => {
    expect(extractAnchorFrameworkError({ logs: ["random network blip"] })).toBeUndefined();
    expect(extractAnchorFrameworkError(null)).toBeUndefined();
    expect(extractAnchorFrameworkError(undefined)).toBeUndefined();
    expect(extractAnchorFrameworkError("string error")).toBeUndefined();
  });

  it("does NOT classify user (6000+) errors as framework errors", () => {
    // 6003 is TileAlreadyRevealed — a Kaboom custom error, not Anchor framework.
    expect(extractAnchorFrameworkError({ logs: KABOOM_CUSTOM_LOGS })).toBeUndefined();
  });

  it("reads logs off an Error instance with a .logs property", () => {
    class FakeSendTransactionError extends Error {
      logs: string[];
      constructor(logs: string[]) {
        super("Simulation failed");
        this.logs = logs;
      }
    }
    const err = new FakeSendTransactionError(ACCOUNT_NOT_INIT_LOGS);
    const fw = extractAnchorFrameworkError(err);
    expect(fw?.code).toBe(3012);
  });

  it("reads logs off the .message string when .logs is absent", () => {
    // Some RPC paths put the whole log dump into the error message.
    const msg =
      "Transaction simulation failed: AnchorError caused by account: game. Error Code: AccountNotInitialized. Error Number: 3012. Error Message: …";
    expect(extractAnchorFrameworkError({ message: msg })?.code).toBe(3012);
  });
});

describe("isAccountNotInitializedError", () => {
  it("true for AccountNotInitialized in either log form", () => {
    expect(isAccountNotInitializedError({ logs: ACCOUNT_NOT_INIT_LOGS })).toBe(true);
    expect(isAccountNotInitializedError({ logs: HEX_ONLY_LOGS })).toBe(true);
  });

  it("false for Kaboom custom errors", () => {
    expect(isAccountNotInitializedError({ logs: KABOOM_CUSTOM_LOGS })).toBe(false);
  });

  it("false for non-on-chain errors", () => {
    expect(isAccountNotInitializedError(new Error("ECONNRESET"))).toBe(false);
    expect(isAccountNotInitializedError(null)).toBe(false);
  });
});

describe("extractKaboomError + extractAnchorFrameworkError separation", () => {
  it("Kaboom custom error is found by extractKaboomError, not the framework decoder", () => {
    expect(extractKaboomError({ logs: KABOOM_CUSTOM_LOGS })).toBe("TileAlreadyRevealed");
    expect(extractAnchorFrameworkError({ logs: KABOOM_CUSTOM_LOGS })).toBeUndefined();
  });

  it("framework error is found by extractAnchorFrameworkError, not extractKaboomError", () => {
    expect(extractAnchorFrameworkError({ logs: ACCOUNT_NOT_INIT_LOGS })?.code).toBe(3012);
    expect(extractKaboomError({ logs: ACCOUNT_NOT_INIT_LOGS })).toBeUndefined();
  });
});
