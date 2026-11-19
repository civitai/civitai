import { describe, expect, it } from 'vitest';
import {
  creatorRailHeading,
  CREATOR_RAIL_LIMIT,
  isRelatedRailLoading,
  needsPopularTopUp,
  RELATED_LISTINGS_LIMIT,
  relatedRailFirstHeading,
  relatedRailHeading,
  relatedRailSections,
  type RelatedRailSection,
} from '~/components/Apps/related-listings';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * "More in <category>" discovery-rail selection — node `unit` project: the
 * fast, deterministic suite CI runs on every PR. Pins exclude-self, category-then-popular top-up
 * under SEPARATE headings, de-dup and the cap, plus the "do we even need the second query"
 * predicate.
 */

function card(id: string, category = 'utility'): ListingCard {
  return {
    id,
    slug: `slug-${id}`,
    kind: 'onsite',
    name: `App ${id}`,
    tagline: null,
    category,
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
/** Every rendered id, in render order, across both groups. */
const allIds = (sections: RelatedRailSection[]) => sections.flatMap((s) => ids(s.items));
/** `[key, heading, ids]` per group — the whole rendered structure in one value. */
const shape = (sections: RelatedRailSection[]) =>
  sections.map((s) => [s.key, s.heading, ids(s.items)]);

// Same-category apps are `utility`; top-up apps are `games`, so a top-up landing in the
// category group is visible in the asserted ids AND in the cards' own category.
const same = (id: string) => card(id, 'utility');
const pop = (id: string) => card(id, 'games');

describe('🔴 relatedRailSections — the top-up never renders under "More in <category>"', () => {
  it('🔴 a thin category renders its own apps under "More in", the top-up under "Popular apps"', () => {
    const sections = relatedRailSections({
      selfId: 'me',
      category: 'utility',
      sameCategory: [same('a'), same('b')],
      popular: [pop('p1'), pop('p2')],
      limit: 4,
    });
    expect(shape(sections)).toEqual([
      ['category', 'More in Utility', ['a', 'b']],
      ['popular', 'Popular apps', ['p1', 'p2']],
    ]);
    // The relationship the heading claims: everything under "More in Utility" IS utility.
    const categoryGroup = sections.find((s) => s.key === 'category')!;
    expect(categoryGroup.items.every((c) => c.category === 'utility')).toBe(true);
  });

  it('a category that fills the rail renders ONE group and no popular heading', () => {
    const many = Array.from({ length: 8 }, (_, i) => same(`c${i}`));
    const sections = relatedRailSections({
      selfId: 'me',
      category: 'utility',
      sameCategory: many,
      popular: [pop('p1')],
    });
    expect(sections.map((s) => s.key)).toEqual(['category']);
    expect(sections[0].items).toHaveLength(RELATED_LISTINGS_LIMIT);
  });

  it('a category holding ONLY self yields the popular group alone — no empty "More in" heading', () => {
    const sections = relatedRailSections({
      selfId: 'me',
      category: 'utility',
      sameCategory: [same('me')],
      popular: [pop('p1')],
    });
    expect(shape(sections)).toEqual([['popular', 'Popular apps', ['p1']]]);
  });

  it('no category → a single popular group, headed "Popular apps"', () => {
    const sections = relatedRailSections({
      selfId: 'me',
      category: null,
      popular: [pop('p1'), pop('p2')],
    });
    expect(shape(sections)).toEqual([['popular', 'Popular apps', ['p1', 'p2']]]);
  });

  it('EXCLUDES SELF from both groups', () => {
    const sections = relatedRailSections({
      selfId: 'me',
      category: 'utility',
      sameCategory: [same('a'), same('me'), same('b')],
      popular: [pop('me'), pop('c')],
    });
    expect(allIds(sections)).toEqual(['a', 'b', 'c']);
  });

  it('the top-up never duplicates an app already picked from the category', () => {
    const sections = relatedRailSections({
      selfId: 'me',
      category: 'utility',
      sameCategory: [same('a')],
      popular: [same('a'), pop('p1')],
      limit: 4,
    });
    expect(shape(sections)).toEqual([
      ['category', 'More in Utility', ['a']],
      ['popular', 'Popular apps', ['p1']],
    ]);
  });

  it('the cap applies across BOTH groups, category first', () => {
    const sections = relatedRailSections({
      selfId: 'me',
      category: 'utility',
      sameCategory: [same('a'), same('b'), same('c')],
      popular: Array.from({ length: 20 }, (_, i) => pop(`p${i}`)),
      limit: 5,
    });
    expect(shape(sections)).toEqual([
      ['category', 'More in Utility', ['a', 'b', 'c']],
      ['popular', 'Popular apps', ['p0', 'p1']],
    ]);
  });

  it('nothing available → no groups (the view then renders its empty note)', () => {
    expect(relatedRailSections({ selfId: 'me', category: 'utility' })).toEqual([]);
  });

  it('limit 0 → no groups (no accidental unbounded rail)', () => {
    expect(
      relatedRailSections({
        selfId: 'me',
        category: 'utility',
        sameCategory: [same('a')],
        popular: [pop('p1')],
        limit: 0,
      })
    ).toEqual([]);
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

describe('🔴 relatedRailFirstHeading — what a link to the rail may call it', () => {
  const sections = (o: Parameters<typeof relatedRailSections>[0]) => relatedRailSections(o);

  it('a category with other apps leads with "More in <category>"', () => {
    const s = sections({
      selfId: 'me',
      category: 'utility',
      sameCategory: [same('a')],
      popular: [pop('p')],
    });
    expect(relatedRailFirstHeading({ category: 'utility', sections: s, loading: false })).toBe(
      'More in Utility'
    );
  });

  it('🔴 an app alone in its category leads with "Popular apps", not its category', () => {
    const s = sections({
      selfId: 'me',
      category: 'utility',
      sameCategory: [same('me')],
      popular: [pop('p')],
    });
    expect(relatedRailFirstHeading({ category: 'utility', sections: s, loading: false })).toBe(
      'Popular apps'
    );
  });

  it('no category with popular apps leads with "Popular apps"', () => {
    const s = sections({ selfId: 'me', category: null, popular: [pop('p')] });
    expect(relatedRailFirstHeading({ category: null, sections: s, loading: false })).toBe(
      'Popular apps'
    );
  });

  it('an empty rail is named by the heading over its empty note', () => {
    expect(relatedRailFirstHeading({ category: 'utility', sections: [], loading: false })).toBe(
      'More in Utility'
    );
    expect(relatedRailFirstHeading({ category: null, sections: [], loading: false })).toBe(
      'More apps'
    );
  });

  it('while loading there is no answer yet (null), whatever the partial sections say', () => {
    const s = sections({ selfId: 'me', category: 'utility', sameCategory: [same('a')] });
    expect(relatedRailFirstHeading({ category: 'utility', sections: s, loading: true })).toBeNull();
  });
});

/**
 * "More by this developer" — the creator group, rendered FIRST.
 *
 * Its own cap (one row), so a prolific developer cannot push the category and popular groups
 * off the rail; and it goes through the same self-exclusion and de-dup as the other groups, so
 * the page you are on never appears and no app appears twice.
 */
describe('🔴 relatedRailSections — the creator group', () => {
  const dev = (id: string) => card(id, 'games');

  it('🔴 leads the rail, headed "More by <developer>", and EXCLUDES SELF', () => {
    const sections = relatedRailSections({
      selfId: 'me',
      category: 'utility',
      creator: [dev('me'), dev('d1'), dev('d2')],
      creatorName: 'pixelsmith',
      sameCategory: [same('a')],
      popular: [pop('p1')],
    });
    expect(shape(sections)).toEqual([
      ['creator', 'More by pixelsmith', ['d1', 'd2']],
      ['category', 'More in Utility', ['a']],
      ['popular', 'Popular apps', ['p1']],
    ]);
  });

  it('🔴 an app already in the creator group is not repeated in the category or popular group', () => {
    const sections = relatedRailSections({
      selfId: 'me',
      category: 'utility',
      creator: [same('a'), dev('d1')],
      creatorName: 'pixelsmith',
      sameCategory: [same('a'), same('b')],
      popular: [dev('d1'), pop('p1')],
    });
    expect(shape(sections)).toEqual([
      ['creator', 'More by pixelsmith', ['a', 'd1']],
      ['category', 'More in Utility', ['b']],
      ['popular', 'Popular apps', ['p1']],
    ]);
  });

  it('is capped at one row of its own, and does not shrink the rest of the rail', () => {
    const sections = relatedRailSections({
      selfId: 'me',
      category: 'utility',
      creator: Array.from({ length: 10 }, (_, i) => dev(`d${i}`)),
      creatorName: 'pixelsmith',
      sameCategory: [same('a'), same('b'), same('c')],
      popular: Array.from({ length: 10 }, (_, i) => pop(`p${i}`)),
      limit: 5,
    });
    expect(CREATOR_RAIL_LIMIT).toBe(3);
    expect(shape(sections)).toEqual([
      ['creator', 'More by pixelsmith', ['d0', 'd1', 'd2']],
      ['category', 'More in Utility', ['a', 'b', 'c']],
      ['popular', 'Popular apps', ['p0', 'p1']],
    ]);
  });

  it('a developer whose only app is this one gets no creator group', () => {
    const sections = relatedRailSections({
      selfId: 'me',
      category: 'utility',
      creator: [dev('me')],
      creatorName: 'pixelsmith',
      sameCategory: [same('a')],
    });
    expect(shape(sections)).toEqual([['category', 'More in Utility', ['a']]]);
  });

  it('a link to the rail names the creator group when it leads', () => {
    const s = relatedRailSections({
      selfId: 'me',
      category: 'utility',
      creator: [dev('d1')],
      creatorName: 'pixelsmith',
    });
    expect(relatedRailFirstHeading({ category: 'utility', sections: s, loading: false })).toBe(
      'More by pixelsmith'
    );
  });
});

describe('creatorRailHeading', () => {
  it('names the developer, or says "this developer" when the name is unknown', () => {
    expect(creatorRailHeading('pixelsmith')).toBe('More by pixelsmith');
    expect(creatorRailHeading(null)).toBe('More by this developer');
    expect(creatorRailHeading('')).toBe('More by this developer');
  });
});

describe('needsPopularTopUp — with a creator group', () => {
  it('🔴 category apps the creator group takes do not count toward filling the rail', () => {
    // Two category apps, both by this developer: the category group will render neither.
    expect(
      needsPopularTopUp({
        selfId: 'me',
        sameCategory: [card('a'), card('b')],
        creator: [card('a'), card('b')],
        limit: 2,
      })
    ).toBe(true);
    // Control: the same category list with no creator overlap fills the rail.
    expect(
      needsPopularTopUp({
        selfId: 'me',
        sameCategory: [card('a'), card('b')],
        creator: [card('x')],
        limit: 2,
      })
    ).toBe(false);
  });
});

describe('isRelatedRailLoading — the creator query', () => {
  it('loading while the enabled creator query is pending; ignored when it is disabled', () => {
    const settled = {
      hasCategoryFilter: true,
      categoryPending: false,
      wantTopUp: false,
      popularPending: false,
    };
    expect(isRelatedRailLoading({ ...settled, wantCreator: true, creatorPending: true })).toBe(
      true
    );
    expect(isRelatedRailLoading({ ...settled, wantCreator: false, creatorPending: true })).toBe(
      false
    );
    expect(isRelatedRailLoading({ ...settled, wantCreator: true, creatorPending: false })).toBe(
      false
    );
  });
});
