import { describe, expect, it } from 'vitest';
import {
  isRelatedRailLoading,
  needsPopularTopUp,
  RELATED_LISTINGS_LIMIT,
  relatedRailHeading,
  selectRelatedListings,
} from '~/components/Apps/related-listings';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * "More in <category>" discovery-rail selection — node `unit` project: the
 * fast, deterministic suite CI runs on every PR (the browser `component` suites
 * are not run in CI at all). Pins exclude-self, category-then-popular top-up,
 * de-dup and the cap, plus the "do we even need the second query" predicate.
 */

function card(id: string): ListingCard {
  return {
    id,
    slug: `slug-${id}`,
    kind: 'onsite',
    name: `App ${id}`,
    tagline: null,
    category: 'utility',
    contentRating: null,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    kindData: {
      kind: 'onsite',
      appBlockId: `ab-${id}`,
      hasPage: true,
      liveUrl: `https://slug-${id}.civit.ai`,
    },
  };
}

const ids = (out: ListingCard[]) => out.map((c) => c.id);

describe('selectRelatedListings', () => {
  it('EXCLUDES SELF from the same-category list', () => {
    const out = selectRelatedListings({
      selfId: 'me',
      sameCategory: [card('a'), card('me'), card('b')],
    });
    expect(ids(out)).toEqual(['a', 'b']);
  });

  it('EXCLUDES SELF from the popular top-up too', () => {
    const out = selectRelatedListings({ selfId: 'me', popular: [card('me'), card('c')] });
    expect(ids(out)).toEqual(['c']);
  });

  it('keeps same-category order first, then tops up from popular', () => {
    const out = selectRelatedListings({
      selfId: 'me',
      sameCategory: [card('a'), card('b')],
      popular: [card('p1'), card('p2')],
      limit: 4,
    });
    expect(ids(out)).toEqual(['a', 'b', 'p1', 'p2']);
  });

  it('the top-up never duplicates an app already picked from the category', () => {
    const out = selectRelatedListings({
      selfId: 'me',
      sameCategory: [card('a')],
      popular: [card('a'), card('p1')],
      limit: 4,
    });
    expect(ids(out)).toEqual(['a', 'p1']);
  });

  it('caps at the limit even when both lists are long', () => {
    const many = Array.from({ length: 20 }, (_, i) => card(`c${i}`));
    expect(selectRelatedListings({ selfId: 'me', sameCategory: many, popular: many })).toHaveLength(
      RELATED_LISTINGS_LIMIT
    );
  });

  it('no category (sameCategory omitted) → a pure popular rail', () => {
    const out = selectRelatedListings({ selfId: 'me', popular: [card('p1'), card('p2')] });
    expect(ids(out)).toEqual(['p1', 'p2']);
  });

  it('nothing available → empty (the view then renders its empty note, not a broken rail)', () => {
    expect(selectRelatedListings({ selfId: 'me' })).toEqual([]);
  });

  it('a category holding ONLY self yields the popular top-up alone', () => {
    const out = selectRelatedListings({
      selfId: 'me',
      sameCategory: [card('me')],
      popular: [card('p1')],
    });
    expect(ids(out)).toEqual(['p1']);
  });

  it('limit 0 → empty (no accidental unbounded rail)', () => {
    expect(selectRelatedListings({ selfId: 'me', sameCategory: [card('a')], limit: 0 })).toEqual(
      []
    );
  });
});

describe('needsPopularTopUp', () => {
  it('true when the category is thin (self excluded from the count)', () => {
    expect(
      needsPopularTopUp({ selfId: 'me', sameCategory: [card('me'), card('a')], limit: 3 })
    ).toBe(true);
  });

  it('false when the category alone fills the rail', () => {
    expect(
      needsPopularTopUp({ selfId: 'me', sameCategory: [card('a'), card('b')], limit: 2 })
    ).toBe(false);
  });

  it('false while the category query is still loading (do not fire on an empty in-flight list)', () => {
    expect(needsPopularTopUp({ selfId: 'me', sameCategory: [], categoryLoading: true })).toBe(
      false
    );
  });

  it('true for an empty settled category list', () => {
    expect(needsPopularTopUp({ selfId: 'me', sameCategory: [] })).toBe(true);
  });
});

describe('isRelatedRailLoading — no "2 cards → loader → 6 cards" flash', () => {
  it('🔴 the frame where the top-up is newly enabled counts as LOADING', () => {
    // The react-query v5 trap: on the render where `wantTopUp` flips true the
    // top-up query is pending but has not started fetching, so `isLoading`
    // (= isPending && isFetching) is FALSE for one frame. Feeding `isPending`
    // keeps the loader continuous instead of flashing the thin category result.
    expect(
      isRelatedRailLoading({
        hasCategoryFilter: true,
        categoryPending: false, // category settled with a thin result
        wantTopUp: true, // …which is what just enabled the top-up
        popularPending: true,
      })
    ).toBe(true);
  });

  it('a DISABLED query never pins the rail in a loader (disabled === permanently pending)', () => {
    // Category query disabled (no category) — its pending state must be ignored.
    expect(
      isRelatedRailLoading({
        hasCategoryFilter: false,
        categoryPending: true,
        wantTopUp: true,
        popularPending: false,
      })
    ).toBe(false);
    // Top-up disabled (category filled the rail) — same.
    expect(
      isRelatedRailLoading({
        hasCategoryFilter: true,
        categoryPending: false,
        wantTopUp: false,
        popularPending: true,
      })
    ).toBe(false);
  });

  it('loading while the category query itself is in flight', () => {
    expect(
      isRelatedRailLoading({
        hasCategoryFilter: true,
        categoryPending: true,
        wantTopUp: false,
        popularPending: true,
      })
    ).toBe(true);
  });

  it('not loading once every enabled query has settled', () => {
    expect(
      isRelatedRailLoading({
        hasCategoryFilter: true,
        categoryPending: false,
        wantTopUp: true,
        popularPending: false,
      })
    ).toBe(false);
  });
});

/**
 * 🔴 CALL-SITE COVERAGE — the rail heading (and its `aria-label`, the same string).
 *
 * This is the one place the rail shows a reader a category, and until the string
 * moved into this pure module it was the only `marketplaceCategoryLabel` call
 * site with no reachable assertion anywhere in the repo.
 *
 * These assertions guard the WIRING, not the label map: they fail if this
 * function stops calling the shared helper (renders `utility`), if it calls the
 * wrong one, or if the surrounding sentence is reworded — none of which any test
 * of `marketplaceCategoryLabel` itself can see.
 */
describe('🔴 relatedRailHeading — the rail names the category by its LABEL', () => {
  it('a known category is named by its display label, inside the full sentence', () => {
    // Whole normalised string, not a substring: a check for "Utility" alone would
    // be satisfied by a heading that had lost the "More in" half.
    expect(relatedRailHeading('utility')).toBe('More in Utility');
    // A second rung, so a mutant hardcoding one label has to move an assertion.
    expect(relatedRailHeading('generation')).toBe('More in Generation');
  });

  it('🔴 never renders the raw stored key', () => {
    expect(relatedRailHeading('utility')).not.toContain('utility');
    expect(relatedRailHeading('analytics')).not.toContain('analytics');
  });

  it('an unknown category still names itself, via the shared raw fallback', () => {
    // The rail below really is filtered by this value, so naming it is honest —
    // and a blank/`More in ` heading would be the visible bug.
    expect(relatedRailHeading('workflow-tools')).toBe('More in workflow-tools');
  });

  it('no category at all falls back to the generic heading, not a hole', () => {
    expect(relatedRailHeading(null)).toBe('More apps');
    expect(relatedRailHeading(undefined)).toBe('More apps');
    expect(relatedRailHeading('')).toBe('More apps');
  });
});
