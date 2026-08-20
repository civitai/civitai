import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { buildListingDetailRows } from '~/components/Apps/appListingDetailRows';
import { ModelVersionReview } from '~/components/Model/ModelVersions/ModelVersionReview';
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
 * IMPORTS this module. A surface that COPIES the thresholds instead would leave every
 * test above green while the two ladders drift. So two things are asserted:
 *   (a) the IMPORTER set, exactly — it fails when the set grows (a consumer wired up
 *       without anyone deciding to) and when it shrinks (a copy inlined back);
 *   (b) that no file in `src/` embeds a rating ladder WITHOUT importing this one.
 *
 * 🔴 (b) EXISTS BECAUSE (a) ALONE WAS WALKABLE, AND THAT WAS MEASURED, NOT FEARED. An
 * earlier version of this block detected consumers with `text.includes(
 * '~/utils/rating-label')` and asserted only the importer list. A drifted COPY of the
 * ladder planted at `components/Apps/copiedLadder.ts`, importing nothing, passed all 49
 * tests — the exact scenario the docstring claimed to prevent. Two independent faults,
 * both fixed here:
 *
 *   1. A copy is INVISIBLE to an importer list. Not importing is what a copy DOES; a
 *      ledger of importers is structurally blind to it. Hence the second scan, which
 *      looks for the ladder's own OUTPUT ALPHABET in the source text rather than for
 *      the module path.
 *   2. A bare `includes` counted a mere textual MENTION as a consumer. The first
 *      attempt at that mutant died only because its comment named the module path —
 *      i.e. the guard fired on prose, not on a dependency. Any doc reference registered
 *      as a caller, and a doc reference beside a copy would have masked it. The
 *      importer scan now matches an `import` / `require` FORM, not a substring.
 */
describe('🔴 the rating ladder has exactly the callers it is supposed to have', () => {
  const SRC = path.resolve(__dirname, '../..');

  /** This module's own path, relative to `src/` — never a "consumer" of itself. */
  const LADDER_MODULE = 'utils/rating-label.ts';

  /**
   * A real dependency on the module: `from '~/utils/rating-label'`, a dynamic
   * `import(...)`, a `require(...)`, or a side-effect `import '...'`. Deliberately NOT
   * a substring test — see fault 2 in the block docstring.
   */
  const IMPORT_FORM =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])~\/utils\/rating-label\1/;

  /**
   * The ladder's OUTPUT ALPHABET — every word label `getRatingLabel` can return.
   *
   * This is what a copy cannot avoid carrying: thresholds can be re-spelled (`0.2` →
   * `20`, a 0–100 scale), the function can be renamed, the branches can be reordered —
   * but a surface rendering this verdict has to spell these words. Matched only as a
   * WHOLE quoted string literal and case-insensitively, so a 0–100-scaled copy with
   * lowercased copy is still caught while prose ("relocate this very negative-cache
   * bug", measured in `apps-pipeline.service.ts`) is not.
   */
  const LADDER_LABELS = [
    'Mixed',
    'Negative',
    'Very Negative',
    'Overwhelmingly negative',
    'Mostly negative',
    'Mostly Positive',
    'Positive',
    'Very Positive',
    'Overwhelmingly Positive',
  ];

  /**
   * How many DISTINCT ladder labels a file must quote before it counts as embedding a
   * ladder. 3 was chosen from the measured distribution over all of `src/`, not picked:
   * the real ladders score 6–9 and the highest-scoring innocent file scores 2 (three
   * files quoting `'positive'` + `'negative'` as generation-prompt keys). So the
   * threshold sits in a gap, with margin on both sides — asserted below rather than
   * asserted about.
   */
  const LADDER_LABEL_THRESHOLD = 3;

  /**
   * 🔴 A DECIDED DIVERGENCE — the follow-up was worked, and the answer was "separate".
   *
   * `pages/3d-models/[id]/[[...slug]].tsx` defines `sentimentLabel`: a second ladder on
   * a 0–100 integer scale, with a sixth label ("Too few reviews") and NO count-widening
   * of the word itself. The entry used to read "not yet consolidated". It was
   * consolidated-or-not on the evidence below, and the answer is NOT.
   *
   * 🔴 THE MEASUREMENT. Both ladders were evaluated over the whole input grid
   * (`pct` 0…100 × `count` 1…1000, 101,000 cells), comparing the word case-insensitively:
   *
   *     agree 86.2% · disagree 13.8% (13.5% ignoring the `< 5` floor)
   *
   * and every disagreement is in one of two places, at every count below 500:
   *
   *     n ∈ [5, 9]   : 0–19%  Overwhelmingly negative → Mixed
   *                    80–94% Very positive          → Positive
   *                    95–100% Overwhelmingly positive → Positive
   *     n ∈ [10, 49] : 0–19%  Overwhelmingly negative → Negative      (+ the same top two)
   *     n ∈ [50, 499]: 0–19%  Overwhelmingly negative → Very Negative
   *                    95–100% Overwhelmingly positive → Very Positive
   *     n >= 600     : NO disagreement anywhere on the row.
   *
   * That shape is the whole argument. The disagreement is not drift and not sloppiness:
   * it is precisely THIS module's count-widening, which reserves "Overwhelmingly …" for
   * >= 500 reviews. The 3D page's own comment says its bands are "scaled down to fit the
   * typical Civitai review volume", and the two ladders become IDENTICAL once the count
   * clears ~500 — i.e. they differ only where a 3D model actually lives. Migrating that
   * caller would silently re-word live verdicts: a 6/6-recommend model drops from
   * "Overwhelmingly positive" to "Positive", a 0/60 one softens from "Overwhelmingly
   * negative" to "Very Negative".
   *
   * 🔴 AND IT CANNOT BE EXPRESSED BY WIDENING THIS LADDER. The scale (0–100 vs 0–1) and
   * the sixth label are both easy — an argument each. The irreducible difference is
   * STRUCTURAL: here the WORD depends on the review count, there it does not. One band
   * set cannot be both, so "extend the shared ladder" degrades into a ladder FACTORY
   * with two configs — two ladders in one file, which is the drift this module exists to
   * prevent, with an indirection added on top.
   *
   * The entry stays listed HERE, explicitly, rather than dodged by weakening the scan:
   * the scan DOES flag it (asserted below, so this entry can never rot into dead
   * weight), and if that page's ladder is ever removed or rewritten to import this one,
   * the assertion fails and this entry has to come out with it.
   */
  const KNOWN_UNSHARED_LADDERS = ['pages/3d-models/[id]/[[...slug]].tsx'];

  /** Every `.ts`/`.tsx` file under `src/`, repo-relative to `src/`, with its text. */
  function sources(): Array<{ rel: string; text: string }> {
    const out: Array<{ rel: string; text: string }> = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        out.push({
          rel: path.relative(SRC, full).split(path.sep).join('/'),
          text: fs.readFileSync(full, 'utf8'),
        });
      }
    };
    walk(SRC);
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  /** Distinct ladder labels quoted as whole string literals in `text`. */
  function quotedLadderLabels(text: string): string[] {
    return LADDER_LABELS.filter((label) =>
      new RegExp(`(["'\`])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'i').test(text)
    );
  }

  /** Every file under `src/` that really IMPORTS the shared ladder. */
  function importers(): string[] {
    return sources()
      .filter((f) => IMPORT_FORM.test(f.text))
      .map((f) => f.rel);
  }

  /** Files that embed a ladder of their own without importing the shared one. */
  function unsharedLadders(): string[] {
    return sources()
      .filter((f) => f.rel !== LADDER_MODULE)
      .filter((f) => !IMPORT_FORM.test(f.text))
      .filter((f) => quotedLadderLabels(f.text).length >= LADDER_LABEL_THRESHOLD)
      .map((f) => f.rel);
  }

  it('the scanner can actually find an importer (positive control)', () => {
    // A ledger built by a walker that reads nothing is an empty set that matches an
    // empty expectation. Prove the walk reaches real files and finds a real hit first.
    const found = importers();
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain('utils/__tests__/rating-label.test.ts');
  });

  it('🔴 a textual MENTION is not a consumer (the matcher fires on the import FORM)', () => {
    // Fault 2, pinned. Both strings below name the module; only one depends on it.
    expect("import { getRatingLabel } from '~/utils/rating-label';").toMatch(IMPORT_FORM);
    expect("const m = await import('~/utils/rating-label');").toMatch(IMPORT_FORM);
    expect('// see `~/utils/rating-label` for the shared ladder').not.toMatch(IMPORT_FORM);
    expect(' * The word label comes from ~/utils/rating-label, not a local copy.').not.toMatch(
      IMPORT_FORM
    );
  });

  it('EXACTLY these files consume the shared ladder', () => {
    expect(importers().sort()).toEqual(
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

  it('🔴 the copied-ladder scan can SEE a ladder (positive control)', () => {
    // The assertion two tests down is a zero, so on its own it is indistinguishable
    // from a scan wired to nothing. Drive it with the real module's own source — the
    // canonical positive — and with a MINIMAL drifted copy of the shape it exists to
    // catch: renamed function, re-scaled thresholds, no import.
    const ladderSource = fs.readFileSync(path.resolve(SRC, LADDER_MODULE), 'utf8');
    expect(quotedLadderLabels(ladderSource).length).toBeGreaterThanOrEqual(LADDER_LABEL_THRESHOLD);

    const drifted = [
      'function verdict(pct: number, n: number) {',
      "  if (pct < 25) return 'Mostly negative';",
      "  if (pct < 70) return 'Mixed';",
      "  if (n < 50) return 'Positive';",
      "  return 'Very Positive';",
      '}',
    ].join('\n');
    expect(quotedLadderLabels(drifted).length).toBeGreaterThanOrEqual(LADDER_LABEL_THRESHOLD);
    expect(drifted).not.toMatch(IMPORT_FORM);

    // …and the NEGATIVE control: the scan must not fire on prose that merely uses these
    // words, which is why the labels are matched as whole QUOTED literals. This exact
    // sentence lives in `server/services/blocks/apps-pipeline.service.ts`.
    expect(quotedLadderLabels(' * relocate this very negative-cache bug')).toEqual([]);
    // Two generic labels are not a ladder — this is the shape of the highest-scoring
    // innocent files in `src/` (generation-prompt keys), and it must stay under the bar.
    expect(
      quotedLadderLabels(`const k = { positive: 'positive', negative: 'negative' };`).length
    ).toBeLessThan(LADDER_LABEL_THRESHOLD);
  });

  /**
   * INVARIANT GUARD — not regression coverage, and labelled as such.
   *
   * It cannot have been red before this change, because it pins a property that was
   * already true. What it buys is that the *reason* recorded above stops being prose:
   * the divergence is justified by the sixth label and the 0–100 scale, so if the 3D
   * page's ladder ever loses them, the justification no longer describes the code and
   * this fails rather than quietly becoming stale.
   */
  it('INVARIANT: the shared ladder structurally cannot express the 3d page label set', () => {
    // The sixth label is not in this ladder's alphabet, and cannot be — this ladder has
    // no insufficient-data band at all (its contract puts the zero-review short-circuit
    // on the CALLER; see `getRatingLabel`'s param docs).
    expect(LADDER_LABELS).not.toContain('Too few reviews');
    expect(fs.readFileSync(path.resolve(SRC, LADDER_MODULE), 'utf8')).not.toMatch(
      /(["'`])Too few reviews\1/
    );

    // …and the divergent caller still carries it, as a whole quoted literal.
    const text = fs.readFileSync(path.resolve(SRC, KNOWN_UNSHARED_LADDERS[0]), 'utf8');
    expect(text).toMatch(/(["'`])Too few reviews\1/);
  });

  it('🔴 the tolerated 3d-models ladder is still THERE and still FLAGGED (allowlist is live)', () => {
    // An allowlist entry that no longer matches anything is dead weight that silently
    // widens the guard. Assert the file exists, still embeds its own ladder, and still
    // does not import the shared one — so when the consolidation follow-up lands, THIS
    // fails and the entry has to be removed with it.
    for (const rel of KNOWN_UNSHARED_LADDERS) {
      const text = fs.readFileSync(path.resolve(SRC, rel), 'utf8');
      expect(quotedLadderLabels(text).length, rel).toBeGreaterThanOrEqual(LADDER_LABEL_THRESHOLD);
      expect(text, rel).not.toMatch(IMPORT_FORM);
    }
  });

  it('🔴 NO file embeds a rating ladder without importing the shared one', () => {
    expect(
      unsharedLadders(),
      "A file spells the shared ladder's word labels but does not import " +
        '`~/utils/rating-label`. That is a SECOND ladder, and two ladders drift — which ' +
        'is the whole reason this module exists. Import it, or (if the surface genuinely ' +
        'needs different bands) add the file to KNOWN_UNSHARED_LADDERS with a comment ' +
        'naming the consolidation follow-up.'
    ).toEqual(KNOWN_UNSHARED_LADDERS);
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

  /**
   * 🔴 BEHAVIOURAL, and this time it means it.
   *
   * The test this replaces built `fromModelPage` and `fromListing` from BYTE-IDENTICAL
   * expressions and imported neither call site — `f(x) === f(x)`, which is true for
   * every possible implementation and could not fail. Its comment claimed it caught a
   * wrong ARGUMENT (a percentage passed as `87` instead of `0.87`); it could not see
   * one, because no call site's arithmetic was ever executed.
   *
   * Both call sites are imported and RUN here instead:
   *   - `ModelVersionReview` is invoked as a plain function. A React function component
   *     is just a function returning an element tree, so calling it executes the real
   *     `up / (up + down)` arithmetic and the real `getRatingLabel(...)` call with no
   *     DOM, no provider and no renderer. The verdict is then read back off the tree.
   *   - `buildListingDetailRows` is the listing's real call site, executing the real
   *     `recommendPct` / `reviewCount` hand-off.
   *
   * One population, two independent paths, one required answer.
   */
  describe('🔴 BEHAVIOURAL: both call sites reduce the same reviews to the same word', () => {
    // 431 up / 68 down → 0.86373 across 499 reviews. Distinct from every ladder
    // constant (10 / 50 / 500 / 0.2 / 0.4 / 0.7 / 0.8 / 0.95).
    const UP = 431;
    const DOWN = 68; // → 499 reviews at 0.86373

    /** Depth-first walk of a React element tree, yielding every node. */
    function nodes(el: unknown): unknown[] {
      if (el == null || typeof el !== 'object') return [];
      if (Array.isArray(el)) return el.flatMap(nodes);
      const props = (el as { props?: Record<string, unknown> }).props;
      return [el, ...(props ? nodes(props.children) : [])];
    }

    /** The model page renders the verdict as an `Anchor` with `c={color}`. */
    function modelPageVerdict(up: number, down: number): { label: string; color: unknown } {
      const tree = ModelVersionReview({
        modelId: 1,
        versionId: 2,
        thumbsUpCount: up,
        thumbsDownCount: down,
      });
      const hit = nodes(tree).find((n) => {
        const props = (n as { props?: Record<string, unknown> }).props;
        return (
          !!props &&
          typeof props.c === 'string' &&
          typeof props.children === 'string' &&
          props.tt === 'capitalize'
        );
      }) as { props: { c: string; children: string } };
      return { label: hit.props.children, color: hit.props.c };
    }

    /** The listing renders it as the `reviews` row's value + colour. */
    function listingVerdict(up: number, down: number): { label: string; color: unknown } {
      const total = up + down;
      const row = buildListingDetailRows(
        {
          kindData: { kind: 'onsite', appBlockId: 'ab_1', hasPage: true, liveUrl: 'https://a.b' },
          category: null,
          contentRating: null,
          recommend: { recommendedCount: up, notRecommendedCount: down, recommendPct: up / total },
          reviewCount: total,
          installCount: 0,
          updatedAt: '2026-03-04T05:06:07.000Z',
        } as Parameters<typeof buildListingDetailRows>[0],
        { formatDate: (iso) => iso }
      ).find((r) => r.key === 'reviews');
      // The listing row appends the count — strip it to compare the WORD.
      return { label: String(row?.value).replace(/\s*\(.*\)$/, ''), color: row?.color };
    }

    it('POSITIVE CONTROL: each extractor really reads a verdict off its own call site', () => {
      // Both helpers above search a structure. A search that finds nothing would make
      // the agreement assertion below `undefined === undefined` — green, meaningless.
      expect(modelPageVerdict(UP, DOWN).label).toBeTruthy();
      expect(listingVerdict(UP, DOWN).label).toBeTruthy();
      // …and they track the input rather than returning a constant: a different
      // population must yield a DIFFERENT word from each.
      expect(modelPageVerdict(4, 133).label).not.toBe(modelPageVerdict(UP, DOWN).label);
      expect(listingVerdict(4, 133).label).not.toBe(listingVerdict(UP, DOWN).label);
    });

    it('the same population yields the same verdict from both real call sites', () => {
      expect(modelPageVerdict(UP, DOWN)).toEqual(listingVerdict(UP, DOWN));
      // Pinned as a literal so "they agree" cannot be satisfied by both being wrong in
      // the same way. 431/499 = 0.8637 → the 0.8–0.95 band at 499 reviews.
      expect(modelPageVerdict(UP, DOWN)).toEqual({ label: 'Very Positive', color: 'green' });
    });

    it('they agree across every band, not just the one the literal pins', () => {
      // A single population can agree by luck. Sweep one that lands in each band.
      for (const [up, down] of [
        [0, 137],
        [40, 97],
        [70, 67],
        [110, 27],
        [131, 6],
        [2000, 11],
      ] as const) {
        const key = `${up}/${up + down}`;
        expect(modelPageVerdict(up, down), key).toEqual(listingVerdict(up, down));
      }
    });

    it('🔴 and a 0–100 percentage passed where a 0–1 proportion belongs is CAUGHT', () => {
      // The wrong-argument case the replaced test claimed to cover. Feeding the
      // listing's own arithmetic a percentage (86.37) instead of a proportion (0.8637)
      // sends it to the top of the ladder regardless of the real rating, and the two
      // call sites then DISAGREE — which is exactly the signal that mattered.
      const scaled = buildListingDetailRows(
        {
          kindData: { kind: 'onsite', appBlockId: 'ab_1', hasPage: true, liveUrl: 'https://a.b' },
          category: null,
          contentRating: null,
          recommend: {
            recommendedCount: 4,
            notRecommendedCount: 133,
            recommendPct: (4 / 137) * 100,
          },
          reviewCount: 137,
          installCount: 0,
          updatedAt: '2026-03-04T05:06:07.000Z',
        } as Parameters<typeof buildListingDetailRows>[0],
        { formatDate: (iso) => iso }
      ).find((r) => r.key === 'reviews');
      const mispassed = {
        label: String(scaled?.value).replace(/\s*\(.*\)$/, ''),
        color: scaled?.color,
      };
      expect(mispassed).not.toEqual(modelPageVerdict(4, 133));
      // Named explicitly so the failure reads as "a percentage reached the ladder".
      expect(mispassed.label).toBe('Very Positive');
      expect(modelPageVerdict(4, 133).label).toBe('Very Negative');
    });
  });
});
