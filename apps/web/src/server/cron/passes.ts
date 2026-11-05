import "server-only";
import type { CronPass } from "./tick";
import { indexProgramEvents } from "./indexer-pass";
import { runVrfPasses } from "./vrf-passes";
import { runLegacyPasses } from "./legacy-passes";
import { runLpAutoComplete } from "./lp-pass";
import { runVaultHealth } from "./vault-health-pass";
import { runInvariants } from "./invariants-pass";
import { snapshotVaultUnitValue } from "../vault-history";

const MIN = 60_000;

/**
 * Every house cron pass, in run order, with its cadence. The relay ticks every
 * 60 s; FIXES.md 9.3 wants the VRF and LP passes at that rate (F4's window is
 * ~1 h, so it must stay well under that).
 */
export const PASSES: CronPass[] = [
  { name: "indexer", everyMs: 0, run: () => indexProgramEvents() },
  { name: "vrf", everyMs: 0, run: runVrfPasses }, // 9.3 a, b, c, c'
  { name: "legacy", everyMs: 5 * MIN, run: runLegacyPasses }, // 9.3 d, e
  { name: "lp-complete", everyMs: 0, run: runLpAutoComplete }, // 9.3 f
  { name: "vault-health", everyMs: 15 * MIN, run: runVaultHealth },
  { name: "vault-snapshot", everyMs: 15 * MIN, run: () => snapshotVaultUnitValue() }, // LP return history
  { name: "invariants", everyMs: 24 * 60 * MIN, run: runInvariants },
];
