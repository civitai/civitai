import { describe, expect, it } from 'vitest';
import {
  adjacentViableIndex,
  NO_BROKEN_SCREENSHOTS,
  viewerPosition,
  withBrokenIndex,
} from '~/components/Apps/appListingScreenshotNav';

/**
 * The app-listing screenshot viewer's INDEX ARITHMETIC.
 *
 * 🔴 WHY THIS FILE IS IN THE BLOCKING `unit` PROJECT AND ITS SIBLING IS NOT. The
 * viewer's whole failure mode is arithmetic — open on the wrong shot, advance by the
 * wrong amount, prev and next swapped — and every one of those renders a completely
 * healthy modal showing the wrong picture. The browser suite
 * (`AppListingDetailBody.viewer.browser.test.tsx`) can see it, but it runs only as
 * the preview pipeline's report-only `preview / component-tests`, so a guard that
 * lives ONLY there cannot block the regression coming back. The arithmetic is pure,
 * so it is pinned here, where CI's `Unit tests` job runs it.
 *
 * 🔴 WHAT THIS FILE CANNOT SEE, stated so nobody reads it as more than it is: it
 * proves the FUNCTIONS are right, never that the component CALLS them, never that a
 * tile hands them the index it actually represents, and never that a rendered arrow
 * is wired to the direction its label claims. Those are DOM facts and only the
 * browser tier has them.
 *
 * 🔴 EVERY FIXTURE BELOW IS SIZED SO THAT THE OFF-BY-ONE MUTANTS CANNOT SURVIVE. A
 * 2-element list is the classic vacuous fixture here: `index + 1` and `index - 1` and
 * `count - index - 1` all collide on it, and `position` and `total` are frequently
 * equal, so a swapped prev/next or a mis-derived total passes. Lists are 5-7 long,
 * the interrogated index is never the midpoint and never `count / 2`, and `position`
 * is never equal to `total` or to `index` in the cases that matter.
 */

const noneBroken = NO_BROKEN_SCREENSHOTS;
const brokenAt = (...indexes: number[]) => new Set(indexes);

describe('adjacentViableIndex', () => {
  /**
   * The plain step, in BOTH directions, from an index that is neither an end nor the
   * midpoint of a 7-element list. `3 - 1 = 2` and `3 + 1 = 4` are distinct from each
   * other, from `3`, and from `7 - 3 - 1 = 3`, so a mutant that swaps the directions,
   * that returns the current index, or that mirrors around the centre all fail here.
   */
  it('steps exactly one place, in the direction it is given', () => {
    expect(adjacentViableIndex(3, 1, 7, noneBroken)).toBe(4);
    expect(adjacentViableIndex(3, -1, 7, noneBroken)).toBe(2);
    // …and from an index whose neighbours are NOT symmetric about it, so "off by one
    // in the same direction" is visible rather than absorbed.
    expect(adjacentViableIndex(1, 1, 7, noneBroken)).toBe(2);
    expect(adjacentViableIndex(5, -1, 7, noneBroken)).toBe(4);
  });

  /**
   * 🔴 THE BOUNDARY RULE IS **STOP**, NOT WRAP — the decision recorded in the
   * module header. `undefined` is what disables the arrow button, so a mutant that
   * wraps would not merely navigate differently, it would render a control that
   * claims there is something further on when there is not.
   */
  it('returns undefined at each end rather than wrapping', () => {
    expect(adjacentViableIndex(0, -1, 7, noneBroken)).toBeUndefined();
    expect(adjacentViableIndex(6, 1, 7, noneBroken)).toBeUndefined();
    // The neighbouring index in each case IS reachable, so the two assertions above
    // are about the boundary and not about a function that returns undefined a lot.
    expect(adjacentViableIndex(0, 1, 7, noneBroken)).toBe(1);
    expect(adjacentViableIndex(6, -1, 7, noneBroken)).toBe(5);
  });

  /**
   * A single element is the degenerate case the viewer renders with NO navigation at
   * all. Both directions must be dead, or the viewer offers a control that goes
   * nowhere.
   */
  it('offers no move at all in a one-screenshot listing', () => {
    expect(adjacentViableIndex(0, 1, 1, noneBroken)).toBeUndefined();
    expect(adjacentViableIndex(0, -1, 1, noneBroken)).toBeUndefined();
  });

  /**
   * 🔴 BROKEN SHOTS ARE SKIPPED, NOT STEPPED ONTO. A run of consecutive broken shots
   * is deliberately longer than one, because "skip one" and "skip until viable" are
   * different functions that agree on a single gap — the exact shape that makes a
   * `if (broken.has(i)) i += direction` mutant survive.
   */
  it('skips a RUN of broken screenshots in either direction', () => {
    const broken = brokenAt(2, 3, 4);
    expect(adjacentViableIndex(1, 1, 7, broken)).toBe(5);
    expect(adjacentViableIndex(5, -1, 7, broken)).toBe(1);
    // The same call with nothing broken lands on the adjacent index instead — the
    // control that says the skip above was caused by `broken` and not by the fixture.
    expect(adjacentViableIndex(1, 1, 7, noneBroken)).toBe(2);
    expect(adjacentViableIndex(5, -1, 7, noneBroken)).toBe(4);
  });

  it('reports no move when every shot beyond the current one is broken', () => {
    expect(adjacentViableIndex(1, 1, 5, brokenAt(2, 3, 4))).toBeUndefined();
    expect(adjacentViableIndex(3, -1, 5, brokenAt(0, 1, 2))).toBeUndefined();
  });

  /**
   * The CURRENT index being broken must not stop the search: the viewer rescues off a
   * shot that 404s while open by calling this from that very index.
   */
  it('searches from a broken current index without getting stuck on it', () => {
    const broken = brokenAt(2);
    expect(adjacentViableIndex(2, 1, 7, broken)).toBe(3);
    expect(adjacentViableIndex(2, -1, 7, broken)).toBe(1);
  });

  /**
   * 🔴 THE OUT-OF-RANGE CONTRACT, MEASURED RATHER THAN ASSUMED. The search begins at
   * `index + direction` and stops the moment that probe is outside `[0, count)` — it
   * does NOT clamp back toward the list. So an index left over from a longer list
   * resolves only when the first step happens to land in range (`-1` stepping
   * forward does; `9` stepping back from a 4-shot list does not).
   *
   * That is the deliberate behaviour, not a gap: the only caller that can pass an
   * out-of-range index is the viewer's rescue effect, reached when the listing's
   * screenshot array shrinks under an open viewer — and there `undefined` from both
   * directions closes the viewer, which is the right answer, because the shot it was
   * displaying no longer exists. An earlier draft of this test asserted clamping and
   * was wrong about the code; the assertion is written from the loop, and the reason
   * it is acceptable is written from the caller.
   */
  it('does not clamp an out-of-range index back into the list', () => {
    expect(adjacentViableIndex(-1, 1, 4, noneBroken)).toBe(0);
    expect(adjacentViableIndex(9, -1, 4, noneBroken)).toBeUndefined();
    expect(adjacentViableIndex(9, 1, 4, noneBroken)).toBeUndefined();
    expect(adjacentViableIndex(-1, -1, 4, noneBroken)).toBeUndefined();
  });
});

describe('viewerPosition', () => {
  /**
   * 🔴 THE INDICATOR IS 1-BASED AND THE FIXTURE PROVES IT. `index = 2` in a 5-shot
   * listing gives `3 / 5`: three values that are pairwise distinct AND distinct from
   * the index, so a mutant that renders the raw index, that drops the `+ 1`, or that
   * reports `count` where it means `total` fails here rather than coinciding.
   */
  it('is 1-based over the whole list when nothing is broken', () => {
    expect(viewerPosition(2, 5, noneBroken)).toEqual({ position: 3, total: 5 });
    expect(viewerPosition(0, 5, noneBroken)).toEqual({ position: 1, total: 5 });
    expect(viewerPosition(4, 5, noneBroken)).toEqual({ position: 5, total: 5 });
  });

  /**
   * 🔴 BOTH NUMBERS COUNT ONLY VIABLE SHOTS. With 2 of 7 broken BEFORE the current
   * index, the position drops by exactly 2 and the total by exactly 2 — and neither
   * new value equals the other, equals the index, or equals the raw count, so a
   * mutant that subtracts from only one of them is visible.
   */
  it('counts only the shots navigation can reach — position AND total', () => {
    // shots 0..6, broken at 1 and 3. Viable: 0,2,4,5,6 → five of them.
    const broken = brokenAt(1, 3);
    expect(viewerPosition(4, 7, broken)).toEqual({ position: 3, total: 5 });
    expect(viewerPosition(0, 7, broken)).toEqual({ position: 1, total: 5 });
    expect(viewerPosition(6, 7, broken)).toEqual({ position: 5, total: 5 });
    // …and a shot AFTER the current index reduces the total without touching the
    // position, which is the half a single combined counter would get wrong.
    expect(viewerPosition(2, 7, brokenAt(5))).toEqual({ position: 3, total: 6 });
  });

  /**
   * `position: 0` marks an index the viewer must not display. It never renders that
   * value — it rescues off such an index — so this pins the marker, not a label.
   */
  it('reports position 0 for a broken or out-of-range index', () => {
    expect(viewerPosition(3, 7, brokenAt(3))).toEqual({ position: 0, total: 6 });
    expect(viewerPosition(-1, 7, noneBroken)).toEqual({ position: 0, total: 7 });
    expect(viewerPosition(7, 7, noneBroken)).toEqual({ position: 0, total: 7 });
  });

  it('reports 1 / 1 for a single screenshot and 0 total when all are broken', () => {
    expect(viewerPosition(0, 1, noneBroken)).toEqual({ position: 1, total: 1 });
    expect(viewerPosition(0, 3, brokenAt(0, 1, 2))).toEqual({ position: 0, total: 0 });
  });
});

describe('withBrokenIndex', () => {
  it('adds an index without mutating the set it was given', () => {
    const before = brokenAt(1);
    const after = withBrokenIndex(before, 4);
    expect([...after].sort()).toEqual([1, 4]);
    // The original is untouched — this state lives in React and a mutation in place
    // would not re-render, so the copy is behaviour rather than hygiene.
    expect([...before]).toEqual([1]);
    expect(after).not.toBe(before);
  });

  /**
   * 🔴 THE IDENTITY RETURN IS LOAD-BEARING. This runs inside a `setState` updater
   * from an `<img>` `onError`, and a browser can fire `error` more than once for the
   * same element. Returning a fresh Set every time would schedule a state change
   * every time — a render loop. Same-set-on-repeat is what stops it.
   */
  it('returns the SAME set object when the index is already there', () => {
    const before = brokenAt(2, 5);
    expect(withBrokenIndex(before, 5)).toBe(before);
    // Control: a genuinely new index does produce a new object, so the assertion
    // above is about the repeat and not about a function that never copies.
    expect(withBrokenIndex(before, 6)).not.toBe(before);
  });

  it('never mutates the shared empty constant', () => {
    const next = withBrokenIndex(NO_BROKEN_SCREENSHOTS, 0);
    expect([...next]).toEqual([0]);
    expect(NO_BROKEN_SCREENSHOTS.size).toBe(0);
  });
});
