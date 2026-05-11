import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calcMultiplierBps } from "@playkaboom/shared";

/**
 * Property test pinning the off-chain `calcMultiplierBps` to a fixture
 * shared with the on-chain Rust `calc_multiplier`. The fixture is the
 * trusted oracle; if either implementation drifts, that side's test
 * breaks.
 *
 * Fixture covers:
 *   - mine_count ∈ 1..=15 (MAX_MINES)
 *   - safe_reveals ∈ 0..=(16 - mine_count)
 *   - house_edge_bps ∈ {0, 100, 200, 500, 1000=MAX_HOUSE_EDGE_BPS}
 *
 * Today this audits 675 cells. Anytime the on-chain formula changes (e.g.,
 * a grid-size bump, an edge-handling tweak), regenerate the fixture and
 * audit the diff before committing — both TS and Rust will then re-pin to
 * the new values together.
 */
interface FixtureRow {
  safe_reveals: number;
  mine_count: number;
  edge_bps: number;
  expected_bps: number;
}
interface Fixture {
  generated: string;
  rows: FixtureRow[];
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "multiplier.json"), "utf8"),
) as Fixture;

describe("calcMultiplierBps fixture parity", () => {
  it("fixture covers the full valid input space", () => {
    // mine_count 1..15 × safe_reveals 0..(16-mc) × 5 edges =
    //   sum_{m=1..15}((17-m) * 5) = 5 * sum_{m=1..15}(17-m)
    //   = 5 * (16+15+...+2) = 5 * 135 = 675
    expect(fixture.rows.length).toBe(675);
  });

  for (const row of fixture.rows) {
    const tag = `(safe=${row.safe_reveals}, mines=${row.mine_count}, edge=${row.edge_bps})`;
    it(`${tag} → ${row.expected_bps} bps`, () => {
      // calcMultiplierBps returns bigint; fixture stores number. Compare
      // as numbers — every value fits in JS number range comfortably.
      const got = Number(
        calcMultiplierBps(row.safe_reveals, row.mine_count, row.edge_bps),
      );
      expect(got).toBe(row.expected_bps);
    });
  }
});
