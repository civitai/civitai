import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * App-listing detail — the Details rail's LINK AFFORDANCES.
 *
 * Two tester reports, 2026-09-10, both about the same rail:
 *   - *"I see that 'Source' is clickable, but there is no indication."*
 *   - *"'Reviews' are not clickable."*
 *
 * 🔴 READ BEFORE TREATING ANY RESULT HERE AS A GATE: IT IS NOT ONE. This file is in
 * the Vitest browser-mode `component` project, which CI runs only as the preview
 * pipeline's `preview / component-tests` — report-only and non-blocking. The GATING
 * claims for this change live in the node project:
 * `__tests__/appListingReviewsAnchor.test.ts` (the link/target seam, which fails
 * SILENTLY in production and so is the one that matters) and
 * `__tests__/kindFacetLabelCallSites.test.ts`. This file exists for the half those
 * structurally cannot make: that the rendered element is actually an anchor, with the
 * href and the visible affordance a viewer needs.
 *
 * 🔴 NO CSS IS LOADED, so nothing here can assert "it looks like a link" — there is
 * no computed colour and no rendered underline to read. What IS assertable is the
 * contract that produces the affordance: the element is an `<a>`, it carries the
 * right `href`, and Mantine's `underline="always"` reaches the DOM as
 * `data-underline="always"`. A test claiming to verify the VISUAL would be claiming
 * more than this tier can see, which is the failure mode these files are prone to.
 */

const WIDE: [number, number] = [1440, 900];

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
vi.mock('~/components/Apps/AppListingReviews', () => ({
  AppListingReviews: () => <div data-testid="mock-reviews" />,
}));
vi.mock('~/components/Apps/AppListingComments', () => ({
  AppListingComments: () => <div data-testid="mock-comments" />,
}));

// 🔴 Imported AFTER the mocks, like the component itself. A top-level VALUE import
// from the app graph pulls part of that graph in before `vi.mock` hoisting settles,
// which resolved a SECOND copy of React here and produced 'Invalid hook call' on
// every test in the file. A `import type` is fine (erased); a value import is not.
const { AppListingDetailBody } = await import('./AppListingDetailBody');
const { LISTING_REVIEWS_ANCHOR_ID } = await import('~/components/Apps/listingKindLabels');

beforeEach(async () => {
  await page.viewport(...WIDE);
});

const SOURCE_URL = 'https://github.com/acme/cool-app';

function base(over: Partial<ListingDetail> = {}): ListingDetail {
  return {
    id: 'l1',
    serialId: 1,
    slug: 'my-app',
    kind: 'onsite',
    collaborators: [],
    name: 'My App',
    tagline: 'A handy app',
    description: null,
    category: 'utility',
    contentRating: null,
    isBeta: false,
    betaMessage: null,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    // Non-zero so the reviews row renders its LINK form, not "No reviews yet".
    recommend: { recommendedCount: 7, notRecommendedCount: 1, recommendPct: 0.875 },
    reviewCount: 8,
    installCount: 4213,
    sourceRepoUrl: SOURCE_URL,
    updatedAt: '2026-03-04T05:06:07.000Z',
    screenshots: [],
    scopes: [],
    // Same contract as `scopes`: `projectListingDetail` guarantees an array, and
    // the body reads `.length` — a fixture omitting it would not match any real
    // payload. `[]` keeps these ON-SITE fixtures rendering no connect-permissions
    // section, which is what an on-site listing produces.
    connectScopes: [],
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
  return { container, within };
}

describe('Details rail — link affordances', () => {
  test('🔴 the Source value is an anchor WITH a visible underline affordance', async () => {
    const { container } = await renderBody(base());

    const link = container.querySelector<HTMLAnchorElement>('[data-listing-detail-link="source"]');
    expect(link, 'the source row must render a link').not.toBeNull();
    expect(link!.tagName).toBe('A');
    expect(link!.getAttribute('href')).toBe(SOURCE_URL);
    // The affordance itself. Colour alone is not accessible; the underline is the
    // part that survives a viewer who cannot separate the two hues.
    expect(link!.getAttribute('data-underline')).toBe('always');
  });

  test('the Source link keeps its outbound security attributes', async () => {
    // Not new behaviour — but this change swapped the element that carries them, and
    // `noopener` on a `target="_blank"` third-party link is the one attribute whose
    // loss is a security regression rather than a cosmetic one.
    const { container } = await renderBody(base());
    const link = container.querySelector<HTMLAnchorElement>('[data-listing-detail-link="source"]');
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toContain('noopener');
    expect(link!.getAttribute('rel')).toContain('noreferrer');
  });

  test('🔴 the Reviews value is a fragment link pointing at the reviews section', async () => {
    const { container } = await renderBody(base());

    const anchor = container.querySelector<HTMLAnchorElement>(
      '[data-listing-detail-anchor="reviews"]'
    );
    expect(anchor, 'the reviews row must render a link').not.toBeNull();
    expect(anchor!.tagName).toBe('A');
    expect(anchor!.getAttribute('href')).toBe(`#${LISTING_REVIEWS_ANCHOR_ID}`);
    // 🔴 NOT an outbound link: a same-page jump must not open a new tab.
    expect(anchor!.getAttribute('target')).toBeNull();
  });

  test('🔴 the target it points at EXISTS in the rendered document', async () => {
    // The seam, asserted where it can actually be observed. The node-tier sibling
    // pins that both sides read one constant; this pins that the element is really
    // in the DOM, which is what makes the link work.
    const { container } = await renderBody(base());
    expect(container.querySelector(`#${LISTING_REVIEWS_ANCHOR_ID}`)).not.toBeNull();
  });

  test('with NO reviews the row is plain text, not a link to an empty section', async () => {
    const { container } = await renderBody(
      base({
        recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
        reviewCount: 0,
      })
    );
    expect(container.querySelector('[data-listing-detail-anchor="reviews"]')).toBeNull();
    expect(container.textContent).toContain('No reviews yet');
  });

  test('🔴 in PREVIEW there is no reviews link — the section is not rendered', async () => {
    // The dangerous pairing: a link emitted in a posture that omits its target is a
    // dead link, and a dead fragment link fails silently.
    const { container } = await renderBody(base(), true);
    expect(container.querySelector('[data-listing-detail-anchor="reviews"]')).toBeNull();
    expect(container.querySelector(`#${LISTING_REVIEWS_ANCHOR_ID}`)).toBeNull();
  });
});
