import "server-only";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { calcMultiplierBps } from "@playkaboom/shared";
import { decodeVault, deriveVaultPda } from "@playkaboom/sdk";
import { query } from "../db/pg";
import { getConnection } from "../connection";
import { programId } from "../env";
import { sendAlert } from "../alerts";

/**
 * Indexer invariants (tick pass, daily). Port of scripts/check-invariants.mjs,
 * which ran nightly from GitHub Actions against the Supabase REST API:
 *   1. won rows: multiplier_bps == calc_multiplier(safe_reveals, mine_count, edge)
 *   2. rows with mine_layout: popcount(mine_layout) == mine_count
 *   3. rows with salt + commitment: sha256(layout_le || mine_count || salt) == commitment
 * `edge` is the historic 200 bps or the live vault's house_edge_bps (the games
 * table does not store it). Signatures in scripts/known-corruption-allow.txt
 * (the 2026-05-11 GameSettled race, kept for the record) are ignored.
 * Rows with mine_count 0 and no layout/settle signature are settle-pending
 * sentinels and are skipped. Any violation sends one alert.
 */
const HISTORIC_EDGE_BPS = 200;

function allowlist(): Set<string> {
  // `next start` runs in apps/web; walk up to the repo root's scripts/.
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const p = join(dir, "scripts", "known-corruption-allow.txt");
    if (existsSync(p)) {
      return new Set(
        readFileSync(p, "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#")),
      );
    }
    dir = dirname(dir);
  }
  return new Set();
}

function popcount16(n: number): number {
  let c = 0;
  for (let i = 0; i < 16; i++) if (n & (1 << i)) c++;
  return c;
}

interface Row {
  signature: string;
  outcome: string;
  multiplier_bps: number;
  safe_reveals: number;
  mine_count: number;
  mine_layout: number | null;
  commitment: string | null;
  salt: string | null;
  settle_signature: string | null;
}

export async function runInvariants() {
  const edges = new Set([HISTORIC_EDGE_BPS]);
  const vi = await getConnection().getAccountInfo(deriveVaultPda(programId())[0], "confirmed");
  if (vi) edges.add(decodeVault(vi.data).houseEdgeBps);
  const allowed = allowlist();
  const rows = await query<Row>(
    "select signature, outcome, multiplier_bps, safe_reveals, mine_count, mine_layout, commitment, salt, settle_signature from public.games",
  );

  const failures: { kind: string; sig: string }[] = [];
  let pending = 0;
  for (const r of rows) {
    if (allowed.has(r.signature)) continue;
    if (r.mine_count === 0 && r.mine_layout == null && !r.settle_signature) {
      pending++;
      continue;
    }
    if (r.outcome === "won") {
      const ok = [...edges].some((e) => {
        try {
          return Number(calcMultiplierBps(r.safe_reveals, r.mine_count, e)) === r.multiplier_bps;
        } catch {
          return false;
        }
      });
      if (!ok) failures.push({ kind: "MULT", sig: r.signature });
    }
    if (r.mine_layout != null && popcount16(r.mine_layout) !== r.mine_count) {
      failures.push({ kind: "POP", sig: r.signature });
    }
    if (r.mine_layout != null && r.salt && r.commitment && r.commitment !== "0".repeat(64)) {
      const pre = Buffer.concat([
        Buffer.from([r.mine_layout & 0xff, (r.mine_layout >> 8) & 0xff, r.mine_count]),
        Buffer.from(r.salt, "hex"),
      ]);
      if (createHash("sha256").update(pre).digest("hex") !== r.commitment) {
        failures.push({ kind: "COMMIT", sig: r.signature });
      }
    }
  }

  if (failures.length > 0) {
    await sendAlert({
      severity: "warn",
      title: `Indexer invariants: ${failures.length} violation(s)`,
      description: failures
        .slice(0, 10)
        .map((f) => `${f.kind} ${f.sig}`)
        .join("\n"),
    });
  }
  return { rows: rows.length, settlePending: pending, allowlisted: allowed.size, violations: failures.length };
}
