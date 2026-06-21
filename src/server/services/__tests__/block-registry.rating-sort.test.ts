import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// F-E marketplace REVIEWS — the Bayesian `rating` sort (the LOAD-BEARING piece).
//
// This file pins the two PURE properties (the SQL-shape DRIFT GUARD lives in
// block-registry.list-available.test.ts, which already imports the service with
// the right mock surface):
//   1. BAYESIAN ORDERING (formula) — a few-review 5★ app does NOT outrank a
//      many-review 4.x app; a 0-review app sits mid-pack at the global mean `m`.
//      Verified against a pure-JS mirror of the EXACT SQL formula
//      (C*m + SUM)/(C+n), encoded the same way (round(score*SCALE) zero-padded
//      || install_count zero-padded), so the test tracks the SQL encoding.
//   2. KEYSET COMPLETENESS — paging the keyset over a dataset with MANY ties
//      (all 0-review apps share score=m) returns every app EXACTLY once: no
//      skips, no duplicates. Simulated in JS with the SAME (sort_key, id) tuple
//      ordering + strict-less-than resume Postgres uses.
// ---------------------------------------------------------------------------

// --- Pure-JS mirror of the EXACT SQL formula + encoding (tracks the SQL). -----
const C = 10; // BAYES_MIN_REVIEWS
const SCALE = 1_000_000; // BAYES_SCORE_SCALE
const SCORE_PAD = 9;
const INSTALL_PAD = 20;

function bayesScore(sumRating: number, n: number, m: number): number {
  return (C * m + sumRating) / (C + n);
}
function sortKey(sumRating: number, n: number, installCount: number, m: number): string {
  const score = bayesScore(sumRating, n, m);
  const scoreInt = Math.round(score * SCALE);
  return String(scoreInt).padStart(SCORE_PAD, '0') + String(installCount).padStart(INSTALL_PAD, '0');
}

describe('rating sort — Bayesian ordering (formula correctness)', () => {
  const m = 4.0;

  it('a few-review 5★ app does NOT outrank a many-review 4.x app', async () => {
    // App F: 2 reviews, both 5★ → sum=10, n=2.
    const fewFiveStar = bayesScore(10, 2, m); // (40+10)/12 = 4.166...
    // App M: 50 reviews averaging 4.6 → sum=230, n=50.
    const manyHigh = bayesScore(230, 50, m); // (40+230)/60 = 4.5
    expect(manyHigh).toBeGreaterThan(fewFiveStar);
  });

  it('a 0-review app sits at the global mean m (mid-pack, not buried)', () => {
    const zeroReview = bayesScore(0, 0, m); // (40+0)/10 = 4.0 = m
    expect(zeroReview).toBeCloseTo(m, 6);
    // It outranks a genuinely-bad app...
    const bad = bayesScore(10, 5, m); // (40+10)/15 = 3.33
    expect(zeroReview).toBeGreaterThan(bad);
    // ...but is outranked by a solidly-good, well-reviewed app.
    const good = bayesScore(220, 50, m); // (40+220)/60 = 4.33
    expect(good).toBeGreaterThan(zeroReview);
  });

  it('the text encoding preserves the numeric DESC ordering', () => {
    const good = sortKey(220, 50, 5, m);
    const zero = sortKey(0, 0, 5, m);
    const bad = sortKey(10, 5, 5, m);
    // DESC text sort: good > zero > bad.
    expect(good > zero).toBe(true);
    expect(zero > bad).toBe(true);
  });

  it('equal scores fall back to install_count (then id) via the concatenated key', () => {
    // Two 0-review apps (same score=m) with different install counts.
    const hiInstall = sortKey(0, 0, 100, m);
    const loInstall = sortKey(0, 0, 3, m);
    expect(hiInstall > loInstall).toBe(true); // more installs ranks first on a tie
  });
});

describe('rating sort — KEYSET COMPLETENESS over ties (no skips / no dupes)', () => {
  // Build a dataset with MANY ties at score=m (0-review apps) plus a few rated
  // apps, then page it exactly as Postgres does:
  //   ORDER BY sort_key DESC, id DESC
  //   WHERE (sort_key, id) < (cursorSortKey, cursorId)  -- strict, row-value
  // and assert every app is returned exactly once.
  const m = 4.0;
  type App = { id: string; sum: number; n: number; installs: number };

  function buildKey(a: App): string {
    return sortKey(a.sum, a.n, a.installs, m);
  }

  // 12 zero-review apps (all tie at score=m, varied installs incl. exact-tie
  // installs to force the id tiebreaker) + 3 rated apps.
  const apps: App[] = [
    ...Array.from({ length: 12 }, (_, i) => ({
      id: `ab_zero_${String(i).padStart(2, '0')}`,
      sum: 0,
      n: 0,
      // Several share installs=0 → the id tiebreaker MUST disambiguate them.
      installs: i % 3 === 0 ? 0 : i,
    })),
    { id: 'ab_great', sum: 240, n: 50, installs: 7 },
    { id: 'ab_ok', sum: 150, n: 40, installs: 2 },
    { id: 'ab_bad', sum: 12, n: 6, installs: 1 },
  ];

  // Postgres row-value comparison: (sort_key, id) DESC. A row sorts before
  // another if its sort_key is greater, or (equal sort_key) its id is greater.
  function cmpDesc(a: App, b: App): number {
    const ka = buildKey(a);
    const kb = buildKey(b);
    if (ka !== kb) return ka < kb ? 1 : -1; // greater key first (DESC)
    if (a.id !== b.id) return a.id < b.id ? 1 : -1; // greater id first (DESC)
    return 0;
  }

  function pageKeyset(pageSize: number): string[] {
    const ordered = [...apps].sort(cmpDesc);
    const seen: string[] = [];
    let cursor: { key: string; id: string } | null = null;
    // Loop pages until exhausted.
    // The WHERE resumes strictly after the cursor tuple in DESC order.
    for (let guard = 0; guard < 100; guard++) {
      const remaining = ordered.filter((a) => {
        if (!cursor) return true;
        const k = buildKey(a);
        // (k, id) < (cursor.key, cursor.id) under DESC means: k is strictly
        // smaller, OR equal-k and id strictly smaller.
        if (k !== cursor.key) return k < cursor.key;
        return a.id < cursor.id;
      });
      const page = remaining.slice(0, pageSize);
      if (page.length === 0) break;
      for (const a of page) seen.push(a.id);
      const last = page[page.length - 1];
      cursor = { key: buildKey(last), id: last.id };
      if (page.length < pageSize) break;
    }
    return seen;
  }

  it('pages of 5 cover every app exactly once (no skips, no dupes)', () => {
    const seen = pageKeyset(5);
    expect(seen).toHaveLength(apps.length);
    expect(new Set(seen).size).toBe(apps.length); // no dupes
    expect(new Set(seen)).toEqual(new Set(apps.map((a) => a.id))); // no skips
  });

  it('pages of 1 (degenerate) also cover every app exactly once', () => {
    const seen = pageKeyset(1);
    expect(seen).toHaveLength(apps.length);
    expect(new Set(seen).size).toBe(apps.length);
  });

  it('the well-reviewed app ranks first and the bad app last in the full keyset scan', () => {
    const seen = pageKeyset(5);
    expect(seen[0]).toBe('ab_great');
    expect(seen[seen.length - 1]).toBe('ab_bad');
  });
});
