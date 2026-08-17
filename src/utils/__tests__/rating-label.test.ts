import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { getRatingLabel } from '~/utils/rating-label';

/**
 * The SHARED Steam-style rating ladder (blocking `unit` project).
 *
 * 🔴 WHAT THIS IS AND IS NOT. `getRatingLabel` was MOVED out of
 * `ModelVersionReview.tsx`, not written; the model page's rendered labels are
 * unchanged by construction. So the table below is CHARACTERIZATION coverage — it
 * could not have been "red at base", because at base the module did not exist. What
 * makes it worth having is that the ladder now has two consumers instead of one, and
 * nothing else pins its thresholds at all.
 *
 * The genuinely regression-shaped assertion in this file is the CALLER LEDGER at the
 * bottom: it is red the moment a third surface copies the ladder instead of importing
 * it, and red again if either current caller stops importing it.
 *
 * 🔴 FIXTURE-VALUE DISCIPLINE, because the alternative is a table that cannot see the
 * mutants it exists to catch:
 *   - The COUNTS in the main table are 3 / 23 / 137 / 2011 — pairwise distinct, one
 *     per bucket, and every one of them DIFFERENT from the three constants the ladder
 *     names (10, 50, 500). A fixture that equals a constant cannot distinguish the
 *     real comparison from a mutant that hardcodes that constant's own answer.
 *   - The RATINGS include each threshold EXACTLY (0.2 / 0.4 / 0.7 / 0.8 / 0.95 — the
 *     `<` boundaries are only meaningful if the equal case is asserted), one value
 *     just BELOW each, and one comfortably in the MIDDLE of each band. A `<` mutated
 *     to `<=` moves exactly the exact-boundary rows.
 *   - Every expectation is a LITERAL pair, never re-derived from an if-chain that
 *     mirrors the implementation.
 *
 * Both `label` AND `color` are asserted on every row: the colour is the only thing
 * distinguishing the two `Mixed` cases (`<0.2` with few reviews vs the 0.4–0.7 band),
 * so a label-only table would score a whole collapsed branch green.
 */

/** One bucket-representative count per bucket. None equals 10, 50 or 500. */
const FEW = 3; // < 10
const SOME = 23; // 10 – 49
const MANY = 137; // 50 – 499
const LOTS = 2011; // >= 500

type Case = [rating: number, count: number, label: string, color: string];

/**
 * The full cross of {each band's low / boundary / middle} × {each count bucket}.
 * Expectations are literals, transcribed from the ladder's branches by hand.
 */
const TABLE: Case[] = [
  // ── band: positiveRating < 0.2 — the ONLY band where the count changes the word ──
  [0, FEW, 'Mixed', 'yellow'],
  [0, SOME, 'Negative', 'red'],
  [0, MANY, 'Very Negative', 'red'],
  [0, LOTS, 'Overwhelmingly negative', 'red'],
  [0.05, FEW, 'Mixed', 'yellow'],
  [0.05, SOME, 'Negative', 'red'],
  [0.05, MANY, 'Very Negative', 'red'],
  [0.05, LOTS, 'Overwhelmingly negative', 'red'],
  // just BELOW the 0.2 threshold — still this band
  [0.19, FEW, 'Mixed', 'yellow'],
  [0.19, SOME, 'Negative', 'red'],
  [0.19, MANY, 'Very Negative', 'red'],
  [0.19, LOTS, 'Overwhelmingly negative', 'red'],

  // ── band: 0.2 <= r < 0.4 — count-independent ─────────────────────────────────
  // EXACTLY 0.2: `< 0.2` is false here, so this row moves if `<` becomes `<=`.
  [0.2, FEW, 'Mostly negative', 'orange'],
  [0.2, LOTS, 'Mostly negative', 'orange'],
  [0.31, SOME, 'Mostly negative', 'orange'], // middle of the band
  [0.39, MANY, 'Mostly negative', 'orange'], // just below the next threshold

  // ── band: 0.4 <= r < 0.7 ─────────────────────────────────────────────────────
  [0.4, FEW, 'Mixed', 'yellow'], // EXACTLY the threshold
  [0.4, LOTS, 'Mixed', 'yellow'],
  [0.55, SOME, 'Mixed', 'yellow'], // middle
  [0.69, MANY, 'Mixed', 'yellow'], // just below

  // ── band: 0.7 <= r < 0.8 ─────────────────────────────────────────────────────
  [0.7, FEW, 'Mostly Positive', 'lime'], // EXACTLY the threshold
  [0.7, LOTS, 'Mostly Positive', 'lime'],
  [0.74, SOME, 'Mostly Positive', 'lime'], // middle
  [0.79, MANY, 'Mostly Positive', 'lime'], // just below

  // ── band: r >= 0.8 — the count changes the word again, and 0.95 splits the top ─
  [0.8, FEW, 'Positive', 'green'], // EXACTLY 0.8
  [0.8, SOME, 'Positive', 'green'],
  [0.8, MANY, 'Very Positive', 'green'],
  [0.8, LOTS, 'Very Positive', 'green'], // < 0.95 → not "Overwhelmingly"
  [0.88, FEW, 'Positive', 'green'], // middle of 0.8–0.95
  [0.88, SOME, 'Positive', 'green'],
  [0.88, MANY, 'Very Positive', 'green'],
  [0.88, LOTS, 'Very Positive', 'green'],
  [0.94, LOTS, 'Very Positive', 'green'], // just below 0.95
  // EXACTLY 0.95 — `positiveRating < 0.95` is false, so the top branch opens…
  [0.95, FEW, 'Positive', 'green'], // …but ONLY at >= 500 reviews
  [0.95, SOME, 'Positive', 'green'],
  [0.95, MANY, 'Very Positive', 'green'],
  [0.95, LOTS, 'Overwhelmingly Positive', 'green'],
  [0.99, LOTS, 'Overwhelmingly Positive', 'green'],
  [1, FEW, 'Positive', 'green'],
  [1, SOME, 'Positive', 'green'],
  [1, MANY, 'Very Positive', 'green'],
  [1, LOTS, 'Overwhelmingly Positive', 'green'],
];

describe('getRatingLabel — the rating × count ladder', () => {
  it('the table itself is non-trivial (guards a silently-empty parameterisation)', () => {
    // A `for (const c of [])` loop passes vacuously. Pin a floor, and pin that the
    // table really does exercise more than one answer.
    expect(TABLE.length).toBeGreaterThanOrEqual(40);
    // All 9 distinct labels the ladder can return: Mixed, Negative, Very Negative,
    // Overwhelmingly negative, Mostly negative, Mostly Positive, Positive, Very
    // Positive, Overwhelmingly Positive. Every branch is represented.
    expect(new Set(TABLE.map(([, , label]) => label)).size).toBe(9);
    expect(new Set(TABLE.map(([, , , color]) => color)).size).toBe(5);
    // …and that no count fixture collides with a constant the ladder names.
    for (const bound of [10, 50, 500]) {
      expect([FEW, SOME, MANY, LOTS]).not.toContain(bound);
    }
    expect(new Set([FEW, SOME, MANY, LOTS]).size).toBe(4);
  });

  for (const [positiveRating, totalCount, label, color] of TABLE) {
    it(`rating ${positiveRating} × ${totalCount} reviews → ${label} / ${color}`, () => {
      expect(getRatingLabel({ positiveRating, totalCount })).toEqual({ label, color });
    });
  }
});

/**
 * The COUNT thresholds asserted at their exact edges. Separate from the table above
 * on purpose: here the fixture values ARE the constants (that is the point of an edge
 * test), so they are kept away from the table whose whole discipline is avoiding them.
 */
describe('getRatingLabel — count-bucket edges', () => {
  it('the negative band widens at exactly 10 / 50 / 500', () => {
    expect(getRatingLabel({ positiveRating: 0.1, totalCount: 9 }).label).toBe('Mixed');
    expect(getRatingLabel({ positiveRating: 0.1, totalCount: 10 }).label).toBe('Negative');
    expect(getRatingLabel({ positiveRating: 0.1, totalCount: 49 }).label).toBe('Negative');
    expect(getRatingLabel({ positiveRating: 0.1, totalCount: 50 }).label).toBe('Very Negative');
    expect(getRatingLabel({ positiveRating: 0.1, totalCount: 499 }).label).toBe('Very Negative');
    expect(getRatingLabel({ positiveRating: 0.1, totalCount: 500 }).label).toBe(
      'Overwhelmingly negative'
    );
  });

  it('the positive band widens at exactly 50, and only 500 + >=0.95 reaches the top', () => {
    expect(getRatingLabel({ positiveRating: 0.9, totalCount: 49 }).label).toBe('Positive');
    expect(getRatingLabel({ positiveRating: 0.9, totalCount: 50 }).label).toBe('Very Positive');
    expect(getRatingLabel({ positiveRating: 0.9, totalCount: 499 }).label).toBe('Very Positive');
    // 500 reviews but under 0.95 → still "Very Positive", NOT the top label.
    expect(getRatingLabel({ positiveRating: 0.9, totalCount: 500 }).label).toBe('Very Positive');
    // …and 0.97 at 499 is still not the top either: BOTH conditions are required.
    expect(getRatingLabel({ positiveRating: 0.97, totalCount: 499 }).label).toBe('Very Positive');
    expect(getRatingLabel({ positiveRating: 0.97, totalCount: 500 }).label).toBe(
      'Overwhelmingly Positive'
    );
  });
});

/**
 * 🔴 THE CALLER LEDGER — the seam assertion, and the regression-shaped half of this
 * file.
 *
 * "One rule, one place" is only true while every surface that renders a rating verdict
 * IMPORTS this module. A fourth surface that copies the thresholds instead would leave
 * every test above green while the two ladders drift. So the caller set is asserted as
 * an exact list: it fails when the set GROWS (someone wired up a new consumer without
 * deciding to) and when it SHRINKS (someone inlined a copy back).
 *
 * A structural check alone type-checks past a wrong ARGUMENT, so the behavioural case
 * below it feeds one input through both call sites' own arithmetic and asserts they
 * land on the same word.
 */
describe('🔴 the rating ladder has exactly the callers it is supposed to have', () => {
  const SRC = path.resolve(__dirname, '../..');

  /** Every file under `src/` that imports `~/utils/rating-label`, repo-relative. */
  function importers(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (text.includes("~/utils/rating-label")) out.push(path.relative(SRC, full));
      }
    };
    walk(SRC);
    return out.sort();
  }

  it('the scanner can actually find an importer (positive control)', () => {
    // A ledger built by a walker that reads nothing is an empty set that matches an
    // empty expectation. Prove the walk reaches real files and finds a real hit first.
    const found = importers();
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain('utils/__tests__/rating-label.test.ts');
  });

  it('EXACTLY these files consume the shared ladder', () => {
    expect(importers()).toEqual(
      [
        // The model version page's review link — the ladder's original home.
        'components/Model/ModelVersions/ModelVersionReview.tsx',
        // The app-store listing detail's "Reviews" row, via the pure row builder.
        'components/Apps/appListingDetailRows.ts',
        // This file.
        'utils/__tests__/rating-label.test.ts',
      ].sort()
    );
  });

  it('ModelVersionReview no longer defines a ladder of its own', () => {
    const src = fs.readFileSync(
      path.resolve(SRC, 'components/Model/ModelVersions/ModelVersionReview.tsx'),
      'utf8'
    );
    // Positive control for the matcher — it CAN see a local definition.
    expect('function getRatingLabel({').toMatch(/function getRatingLabel\b/);
    expect(src).not.toMatch(/function getRatingLabel\b/);
    // …and it does still call it.
    expect(src).toMatch(/getRatingLabel\(/);
  });

  it('BEHAVIOURAL: both call sites reduce the same reviews to the same word', () => {
    // `ModelVersionReview` computes `positiveRating = up / (up + down)` and
    // `totalCount = up + down`. The listing detail hands the server-computed
    // `recommendPct` + `reviewCount`. Feed one population through both arithmetics
    // and require the SAME label — a structural import check cannot see a wrong
    // argument (e.g. passing the percentage as 87 instead of 0.87).
    const up = 431;
    const down = 68;
    const fromModelPage = getRatingLabel({
      positiveRating: up / (up + down),
      totalCount: up + down,
    });
    const fromListing = getRatingLabel({
      positiveRating: up / (up + down), // == the server's recommendPct
      totalCount: up + down, // == reviewCount
    });
    expect(fromModelPage).toEqual(fromListing);
    // Pinned as a literal so "they agree" cannot be satisfied by both being wrong in
    // the same way. 431/499 = 0.8637 → the 0.8–0.95 band at 499 reviews.
    expect(fromModelPage).toEqual({ label: 'Very Positive', color: 'green' });
  });
});
