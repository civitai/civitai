import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';
import type { AppListingReviewListItem } from '~/server/schema/blocks/app-listing-review.schema';

/**
 * App-listing detail — the BOUNDED INLINE RECENT-REVIEWS BLOCK, and the DOM ORDER
 * it was introduced into.
 *
 * A tester asked for reviews "right below description, show 3-4 recent + a 'See
 * more reviews' link", and separately for "More in category" to move to the very
 * bottom. The operator ruled: add a BOUNDED block; do NOT move the discovery rail
 * and do NOT move the full reviews section or change its anchor id. The bounded
 * shape is what makes those compatible — a fixed-height block cannot bury what
 * follows it, whereas hoisting the unbounded list would push the rail down by an
 * arbitrary amount.
 *
 * 🔴 READ BEFORE TREATING ANY RESULT HERE AS A GATE: IT IS NOT ONE. This file is
 * in the Vitest browser-mode `component` project, which CI runs only as the
 * preview pipeline's `preview / component-tests` — report-only and non-blocking.
 * The BOUND itself is pinned in the blocking node `unit` tier by
 * `__tests__/recentReviews.test.ts`. What only this tier can see is DOM ORDER and
 * the rendered `href`, and those are what it is here for.
 *
 * 🔴 ORDER IS ASSERTED ON DOCUMENT POSITION, NOT ON SOURCE TEXT AND NOT ON MERE
 * PRESENCE. "Both nodes exist" passes in either order, which is exactly the
 * regression this file is meant to catch: a future change that hoists the full
 * reviews list, or drops the rail to the bottom, would leave every presence
 * assertion green.
 *
 * 🔴 NO NEW-MODULE IMPORT AT THE TOP OF THIS FILE, DELIBERATELY. Everything it
 * imports exists on `main` too, so the whole file COLLECTS AND RUNS against the
 * pre-change tree and produces real red assertions there — rather than failing to
 * import and reporting `Tests no tests`, which is indistinguishable from a pass.
 * That is why the cap is asserted as a BAND (the operator's "3-4") against an
 * over-long fixture instead of against the constant; the constant-vs-render
 * agreement is the node tier's job, and it holds by construction because the
 * component reads one constant for both its query `limit` and its render.
 */

const WIDE: [number, number] = [1440, 900];

/** How many reviews the fake query returns — MUCH more than the cap. */
const FED = 9;

const mocks = vi.hoisted(() => ({
  /** Rows `appListings.listReviews` resolves with for the test at hand. */
  reviews: [] as unknown[],
  /** Whether that query is still loading. */
  loading: false,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// `importOriginal` SPREAD, not a wholesale replacement (local-rules/
// no-wholesale-module-mock): a hand-written factory silently breaks every importer
// the day the real module grows an export it omits, and here that surfaces as
// `Tests no tests` — nothing to see rather than a failure.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => {
  const flags = { appBlocks: true, appListings: true, appBlocksPages: false };
  return {
    ...(await importOriginal<typeof FeatureFlagsMod>()),
    useFeatureFlags: () => flags,
    useOptionalFeatureFlags: () => flags,
  };
});
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    appListings: {
      listAvailable: { useQuery: () => ({ data: { items: [] }, isLoading: false }) },
      // The INLINE block's bounded read. Non-infinite by design — this block has
      // no "load more".
      listReviews: {
        useQuery: () => ({
          data: mocks.loading ? undefined : { items: mocks.reviews, nextCursor: null },
          isLoading: mocks.loading,
        }),
      },
      getMyReview: { useQuery: () => ({ data: null, isLoading: false }) },
      upsertReview: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      reportListing: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    user: {
      getCreator: { useQuery: () => ({ data: null }) },
      getById: { useQuery: () => ({ data: undefined, isInitialLoading: false }) },
    },
    useUtils: () => ({
      appListings: {
        getMyReview: { invalidate: async () => undefined },
        listReviews: { invalidate: async () => undefined },
        getAppDetail: { invalidate: async () => undefined },
      },
    }),
  },
}));
// The FULL list is stubbed — it is the bottom-of-page infinite list, not the unit
// under test. Its wrapping `Stack` (and the anchor id on it) lives in
// AppListingDetailBody itself, so the jump target is still real here.
vi.mock('~/components/Apps/AppListingReviews', () => ({
  AppListingReviews: () => <div data-testid="mock-reviews" />,
}));
vi.mock('~/components/Apps/AppListingComments', () => ({
  AppListingComments: () => <div data-testid="mock-comments" />,
}));
// Two LEAF components inside a review row that reach for app-wide contexts this
// harness does not mount (`ContentSettingsProvider`, `IsClientContext`). Stubbed so
// the row itself stays REAL — the assertions here count rows and compare document
// positions, neither of which is about an avatar or a timestamp. Same stub shape the
// sibling `AppListingDetailBody.browser.test.tsx` already uses for UserAvatar.
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ userId }: { userId?: number }) => (
    <div data-testid="mock-user-avatar">{userId ?? ''}</div>
  ),
  UserProfileLink: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('~/components/Dates/DaysFromNow', () => ({
  DaysFromNow: () => <span data-testid="mock-days-from-now">some time ago</span>,
}));

// 🔴 Imported AFTER the mocks, like the component itself. A top-level VALUE import
// from the app graph pulls part of that graph in before `vi.mock` hoisting settles,
// which resolves a SECOND copy of React and produces 'Invalid hook call' on every
// test in the file. An `import type` is fine (erased); a value import is not.
const { AppListingDetailBody } = await import('./AppListingDetailBody');
const { LISTING_REVIEWS_ANCHOR_ID } = await import('~/components/Apps/listingKindLabels');

const BLOCK = '[data-testid="apps-listing-recent-reviews"]';
const ROW = '[data-testid="apps-listing-review-row"]';
const SEE_MORE = '[data-testid="apps-listing-see-more-reviews"]';
const RAIL = '[data-testid="apps-related-rail"]';

function reviewFixture(id: number): AppListingReviewListItem {
  return {
    id,
    recommended: id % 2 === 0,
    details: `Review body number ${id}`,
    createdAt: new Date('2026-03-04T05:06:07.000Z'),
    user: { id: id * 10, username: `user${id}`, image: null },
  };
}

function base(over: Partial<ListingDetail> = {}): ListingDetail {
  return {
    id: 'l1',
    serialId: 1,
    slug: 'my-app',
    kind: 'onsite',
    collaborators: [],
    name: 'My App',
    tagline: 'A handy app',
    description: 'What this app does.',
    category: 'utility',
    contentRating: null,
    isBeta: false,
    betaMessage: null,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: { recommendedCount: 7, notRecommendedCount: 1, recommendPct: 0.875 },
    reviewCount: 8,
    installCount: 4213,
    sourceRepoUrl: null,
    updatedAt: '2026-03-04T05:06:07.000Z',
    screenshots: [],
    scopes: [],
    kindData: {
      kind: 'onsite',
      appBlockId: 'blk-1',
      hasPage: true,
      liveUrl: 'https://my-app.civit.ai',
    },
    ...over,
  };
}

async function renderBody(detail: ListingDetail, preview = false) {
  const { container } = await renderWithProviders(
    <AppListingDetailBody detail={detail} preview={preview} />
  );
  const within = page.elementLocator(container);
  await expect.element(within.getByText('My App')).toBeInTheDocument();
  return { container };
}

/** True when `a` comes BEFORE `b` in document order. */
function precedes(a: Element | null, b: Element | null): boolean {
  expect(a, 'the earlier node must exist for an order claim to mean anything').not.toBeNull();
  expect(b, 'the later node must exist for an order claim to mean anything').not.toBeNull();
  return Boolean(
    a!.compareDocumentPosition(b!) & Node.DOCUMENT_POSITION_FOLLOWING // eslint-disable-line no-bitwise
  );
}

beforeEach(async () => {
  mocks.reviews = Array.from({ length: FED }, (_, i) => reviewFixture(i + 1));
  mocks.loading = false;
  await page.viewport(...WIDE);
});

describe('inline recent reviews — the bounded block', () => {
  test('🔴 renders below the description when the listing HAS reviews', async () => {
    // The POSITIVE CONTROL for every "it is absent" assertion further down. Without
    // it, a probe wired to nothing would satisfy all of them.
    const { container } = await renderBody(base());
    const block = container.querySelector(BLOCK);
    expect(block, 'the inline recent-reviews block must render').not.toBeNull();
    expect(container.querySelector('[data-testid="apps-listing-description"]')).not.toBeNull();
    expect(
      precedes(container.querySelector('[data-testid="apps-listing-description"]'), block)
    ).toBe(true);
  });

  test('🔴 renders AT MOST the cap even when far more reviews exist', async () => {
    // THE ASSERTION THAT PROTECTS THE BOUND. The query is fed 9 rows; a block that
    // renders all 9 is the unbounded shape the design rejected, and it would pass a
    // bare "the block rendered" check. The band is the operator's decision ("3-4"),
    // asserted here rather than the constant so this file still collects and runs
    // against the pre-change tree.
    const { container } = await renderBody(base());
    const rows = container.querySelectorAll(`${BLOCK} ${ROW}`);
    expect(rows.length).toBeLessThan(FED);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.length).toBeLessThanOrEqual(4);
  });

  test('🔴 renders NOTHING when the listing has no reviews', async () => {
    // No empty section, no placeholder heading, no "be the first to review" box —
    // the #4761 convention. The sibling above is the control that proves this
    // selector can see the block when it IS there.
    mocks.reviews = [];
    const { container } = await renderBody(base({ reviewCount: 0 }));
    expect(container.querySelector(BLOCK)).toBeNull();
    expect(container.querySelector(SEE_MORE)).toBeNull();
    expect(container.textContent).not.toContain('Recent reviews');
    // …and the page still gets its discovery rail and its full reviews section.
    expect(container.querySelector(RAIL)).not.toBeNull();
    expect(container.querySelector(`#${LISTING_REVIEWS_ANCHOR_ID}`)).not.toBeNull();
  });

  test('renders nothing while the bounded query is still loading', async () => {
    // A skeleton here would reserve height above the discovery rail for a block
    // that may never appear — the exact reflow the fixed-height shape avoids.
    mocks.loading = true;
    const { container } = await renderBody(base());
    expect(container.querySelector(BLOCK)).toBeNull();
  });

  test('🔴 the "See more reviews" href is DERIVED from the anchor constant', async () => {
    // Both ends must read one value. A second `'app-listing-reviews'` literal here
    // would re-open a seam that fails SILENTLY: a fragment link to a missing id
    // produces no error and no visual difference. Renaming the constant must move
    // this assertion and the link together.
    const { container } = await renderBody(base());
    const link = container.querySelector<HTMLAnchorElement>(SEE_MORE);
    expect(link, 'the block must offer a way to the full list').not.toBeNull();
    expect(link!.tagName).toBe('A');
    expect(link!.getAttribute('href')).toBe(`#${LISTING_REVIEWS_ANCHOR_ID}`);
    // 🔴 A same-page jump must not open a new tab.
    expect(link!.getAttribute('target')).toBeNull();
  });

  test('🔴 the target that link points at EXISTS in the rendered document', async () => {
    const { container } = await renderBody(base());
    expect(container.querySelector(`#${LISTING_REVIEWS_ANCHOR_ID}`)).not.toBeNull();
  });
});

describe('inline recent reviews — REGRESSION: what must NOT have moved', () => {
  test('🔴 the full reviews section and its id still render', async () => {
    // The Details rail's "Reviews" row links here. The inline block is additive;
    // it must not have replaced or relocated the jump target.
    const { container } = await renderBody(base());
    const section = container.querySelector(`#${LISTING_REVIEWS_ANCHOR_ID}`);
    expect(section).not.toBeNull();
    expect(container.querySelector('[data-testid="mock-reviews"]')).not.toBeNull();
    expect(section!.contains(container.querySelector('[data-testid="mock-reviews"]'))).toBe(true);
  });

  test('🔴 DOM ORDER: inline block → discovery rail → full reviews section', async () => {
    // THE OPERATOR'S DECISION, PINNED. Three separate claims, because a single
    // "first precedes last" test passes with the middle node anywhere:
    //   1. the bounded block is above the rail (the tester's request, honoured);
    //   2. the rail is still ABOVE the unbounded threads (the decision NOT to move
    //      it to the bottom — the rail exists for viewers who read the listing and
    //      didn't convert, and below the threads it is buried);
    //   3. the full list is still last (not hoisted).
    const { container } = await renderBody(base());
    const block = container.querySelector(BLOCK);
    const rail = container.querySelector(RAIL);
    const section = container.querySelector(`#${LISTING_REVIEWS_ANCHOR_ID}`);

    expect(precedes(block, rail), 'the inline block must sit ABOVE "More in category"').toBe(true);
    expect(precedes(rail, section), '"More in category" must stay ABOVE the full reviews').toBe(
      true
    );
    expect(precedes(block, section), 'the inline block must sit above the full list').toBe(true);
  });

  test('🔴 the discovery rail keeps its place even with NO inline block to displace it', async () => {
    // The rail's placement is not contingent on the new block existing. Without
    // this, deleting the block would be indistinguishable from moving the rail.
    mocks.reviews = [];
    const { container } = await renderBody(base({ reviewCount: 0 }));
    expect(
      precedes(
        container.querySelector(RAIL),
        container.querySelector(`#${LISTING_REVIEWS_ANCHOR_ID}`)
      )
    ).toBe(true);
  });
});

describe('inline recent reviews — preview posture', () => {
  test('🔴 in PREVIEW neither the inline block nor the full section renders', async () => {
    // A shadow listing has no review rows and must not be queried. The block is
    // gated `!preview` exactly like both of its neighbours; emitting it here would
    // also emit a "See more reviews" link pointing at an id that does not exist on
    // the page, which is a dead link that fails silently.
    const { container } = await renderBody(base(), true);
    expect(container.querySelector(BLOCK)).toBeNull();
    expect(container.querySelector(SEE_MORE)).toBeNull();
    expect(container.querySelector(`#${LISTING_REVIEWS_ANCHOR_ID}`)).toBeNull();
    expect(container.querySelector(RAIL)).toBeNull();
  });
});
