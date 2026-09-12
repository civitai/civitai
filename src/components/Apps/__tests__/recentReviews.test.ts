import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { LISTING_REVIEWS_ANCHOR_ID } from '~/components/Apps/listingKindLabels';
import {
  INLINE_RECENT_REVIEWS_LIMIT,
  selectRecentReviews,
} from '~/components/Apps/recent-reviews';
import type { AppListingReviewListItem } from '~/server/schema/blocks/app-listing-review.schema';

/**
 * Inline recent-reviews block — THE BOUND.
 *
 * 🔴 Node `unit` tier, deliberately. The browser sibling
 * (`AppListingDetailBody.recentReviews.browser.test.tsx`) can see the rendered
 * DOM, which is the only place DOM ORDER and the anchor's href can be observed —
 * but that tier is report-only in CI, so a regression there blocks nothing. The
 * bound itself is pure, so it is pinned HERE, in the tier that gates a merge.
 *
 * 🔴 EVERY CAP ASSERTION FEEDS MORE ITEMS THAN THE CAP. A fixture with three
 * reviews cannot distinguish "capped at 3" from "renders everything it is
 * given" — the assertion would be green against code with no cap at all, which
 * is precisely the regression this file exists to catch. So the inputs here
 * overshoot the limit rather than landing on it.
 */

function review(
  id: number,
  over: Partial<AppListingReviewListItem> = {}
): AppListingReviewListItem {
  return {
    id,
    recommended: true,
    details: `review ${id}`,
    createdAt: new Date(`2026-0${(id % 9) + 1}-01T00:00:00.000Z`),
    user: { id: id * 10, username: `user${id}`, image: null },
    ...over,
  };
}

/** `n` reviews, newest-first, exactly as `listReviews` returns them. */
const page = (n: number) => Array.from({ length: n }, (_, i) => review(i + 1));

describe('inline recent-reviews — the cap', () => {
  it('🔴 the limit is a NAMED CONSTANT in the requested 3-4 band', () => {
    // The operator's decision was "at most 3-4". Pinning the band (rather than
    // the exact number) lets the value be tuned inside the decision without a
    // test edit, while a change that walks OUT of the decision fails here.
    expect(Number.isInteger(INLINE_RECENT_REVIEWS_LIMIT)).toBe(true);
    expect(INLINE_RECENT_REVIEWS_LIMIT).toBeGreaterThanOrEqual(3);
    expect(INLINE_RECENT_REVIEWS_LIMIT).toBeLessThanOrEqual(4);
  });

  it('🔴 caps at the limit when MORE reviews exist than the bound', () => {
    // The load-bearing assertion. Overshoot by a wide margin: a block fed 20 and
    // rendering 20 is exactly the unbounded shape the design rejected.
    const picked = selectRecentReviews(page(20));
    expect(picked).toHaveLength(INLINE_RECENT_REVIEWS_LIMIT);
  });

  it('🔴 keeps the FIRST (newest) reviews, not an arbitrary slice', () => {
    // `listReviews` is keyset-paginated NEWEST-first, so "recent" is the head of
    // the page. A cap that took the tail would still be a cap and would still
    // pass a bare length assertion.
    const picked = selectRecentReviews(page(20));
    expect(picked.map((r) => r.id)).toEqual(
      Array.from({ length: INLINE_RECENT_REVIEWS_LIMIT }, (_, i) => i + 1)
    );
  });

  it('does not re-order what the server returned', () => {
    // The server owns recency. A second opinion here would drift from the query.
    const shuffled = [review(9), review(2), review(7), review(4), review(1)];
    const picked = selectRecentReviews(shuffled);
    expect(picked.map((r) => r.id)).toEqual(
      shuffled.slice(0, INLINE_RECENT_REVIEWS_LIMIT).map((r) => r.id)
    );
  });

  it('returns everything when FEWER reviews exist than the bound', () => {
    // The complement of the cap case — without it, `() => []` would pass the
    // cap assertion above for entirely the wrong reason.
    const picked = selectRecentReviews(page(2));
    expect(picked.map((r) => r.id)).toEqual([1, 2]);
  });

  it('an explicit limit overrides the default, in both directions', () => {
    // The parameter is what makes the constant testable at a value it does not
    // hold, so a mutant that hardcodes the default inside the function dies.
    expect(selectRecentReviews(page(20), 1)).toHaveLength(1);
    expect(selectRecentReviews(page(20), 7)).toHaveLength(7);
    expect(selectRecentReviews(page(20), 0)).toHaveLength(0);
    expect(selectRecentReviews(page(20), -3)).toHaveLength(0);
  });

  it('tolerates the query’s pre-data states and holes without throwing', () => {
    expect(selectRecentReviews(undefined)).toEqual([]);
    expect(selectRecentReviews(null)).toEqual([]);
    expect(selectRecentReviews([null, review(1), undefined, review(2)]).map((r) => r.id)).toEqual([
      1, 2,
    ]);
  });
});

// 🔴 TWO TESTS WERE DELETED HERE, AND THE DELETION IS THE POINT — they were named
// "🔴 does NOT render at zero reviews" and "DOES render … the positive control",
// and they asserted on `shouldRenderRecentReviews`, a function NOTHING in production
// called. In this tier they read as coverage of the render-or-not policy while
// touching none of it: the page's actual decision is two clauses (empty AND loading)
// in `AppListingRecentReviews.tsx`, and a node-tier test cannot observe a render.
//
// Do not re-add an equivalent here. A test whose name describes a rendering outcome,
// in a tier that cannot render, is worse than no test — it stops the next reader
// looking. That policy is covered by the COMPONENT tier; `recent-reviews.ts` records
// why the predicate itself is gone.

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const blockSource = () =>
  fs.readFileSync(path.join(REPO_ROOT, 'src/components/Apps/AppListingRecentReviews.tsx'), 'utf8');

/** Source with comments stripped — a constant NAMED in prose is not a call site. */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('inline recent-reviews — one constant, two ends', () => {
  it('🔴 the "See more reviews" href is built from LISTING_REVIEWS_ANCHOR_ID, not a 2nd literal', () => {
    // The browser sibling asserts the RENDERED href equals `#${constant}` — but it
    // is in the report-only tier, and it would stay green against a hardcoded
    // literal that happens to match today. This is the half that survives a rename:
    // a literal here silently outlives a change to the constant, and a fragment
    // link to a missing id is inert with NO error.
    //
    // 🔴 THE ASSERTION IS ON THE ID's TEXT ANYWHERE IN CODE, NOT ON A QUOTED
    // SPELLING OF IT. An earlier version of this guard enumerated the quoting
    // forms it imagined (`'app-listing-reviews'`, `"..."`, `` `#...` ``) and a
    // mutation sweep walked straight through it: the mutant wrote
    // `href={'#app-listing-reviews'}` — the `#` inside the quotes — and the guard
    // reported GREEN over a hardcoded literal, which is exactly the drift it
    // claims to close. The id can only reach this file through the constant, so
    // its characters must not appear in code at all, however they are punctuated.
    const src = codeOnly(blockSource());
    expect(src).toContain('LISTING_REVIEWS_ANCHOR_ID');
    expect(src).not.toContain(LISTING_REVIEWS_ANCHOR_ID);
  });

  it('🔴 the query limit and the render bound read the SAME named constant', () => {
    // The bound is only a bound if the render enforces it. Asking the server for
    // `INLINE_RECENT_REVIEWS_LIMIT` while rendering `data.items` unsliced would
    // leave a server that returns more free to widen the block, and would leave
    // every assertion in this file green (they test the pure selector, which the
    // component would no longer be calling).
    const src = codeOnly(blockSource());
    expect(src).toContain('INLINE_RECENT_REVIEWS_LIMIT');
    expect(src).toContain('selectRecentReviews(');
    // No bare numeric `limit:` — that is the shape that decouples the two ends.
    expect(src).not.toMatch(/limit:\s*\d/);
  });
});
