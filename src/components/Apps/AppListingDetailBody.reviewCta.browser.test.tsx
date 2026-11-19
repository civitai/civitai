import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import type * as TrpcMod from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * App-listing detail — the visible "Leave a review" entry points in the REVIEWS SECTION.
 *
 * Tester feedback: the `⋮` menu on the cover was the only way to leave a review, and
 * nobody found it. The section now carries a heading button and, when empty, a
 * "Be the first to review this app." button — both behind the SAME `useCanReviewListing`
 * gate as the menu item, and both opening the body's ONE review modal.
 *
 * The REAL `AppListingReviews` is rendered (only its tRPC is stubbed), because the empty
 * state's action is wired through it and a stubbed list could not show the seam.
 *
 * Gate-hidden cases are COUNTS with a positive control (the section heading rendered),
 * not `.not.toBeInTheDocument()` — see `ReviewListingButton.browser.test.tsx` for why the
 * `.not` form proved nothing in this harness.
 */

const WIDE: [number, number] = [1440, 900];
const OWNER_ID = 5;

const mocks = vi.hoisted(() => ({
  currentUser: null as null | { id: number; username: string },
  features: {} as Record<string, boolean>,
  myReview: null as null | { id: number; recommended: boolean; details: string | null },
  reviews: [] as unknown[],
  // Every `getMyReview.useQuery` hook call. Only review UI instantiates it, so a count of
  // zero means nothing review-related mounted.
  myReviewHookCalls: 0,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.currentUser }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => mocks.features,
  useOptionalFeatureFlags: () => mocks.features,
}));
// `DaysFromNow` (in a review row) throws 'missing IsClientContext' outside the app shell.
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'appListings.getMyReview': {
      useQuery: () => {
        mocks.myReviewHookCalls += 1;
        return { data: mocks.myReview, isLoading: false };
      },
    },
    'appListings.listReviews': {
      useInfiniteQuery: () => ({
        data: { pages: [{ items: mocks.reviews, nextCursor: null }] },
        isLoading: false,
        hasNextPage: false,
        isFetchingNextPage: false,
        fetchNextPage: vi.fn(),
      }),
    },
    'appListings.listAvailable': {
      useQuery: () => ({ data: { items: [] }, isLoading: false, isPending: false }),
    },
  }),
}));
vi.mock('~/components/Apps/AppListingComments', () => ({
  AppListingComments: () => <div data-testid="mock-comments" />,
}));
// `UserAvatar` needs a `ContentSettingsProvider` the shared setup does not mount.
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: () => <div data-testid="mock-user-avatar" />,
  UserProfileLink: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('~/components/Chat/ChatUserButton', () => ({ ChatUserButton: () => null }));
vi.mock('~/components/FollowUserButton/FollowUserButton', () => ({
  FollowUserButton: () => null,
}));
vi.mock('~/components/Buzz/TipBuzzButton', () => ({ TipBuzzButton: () => null }));

// Imported AFTER the mocks (vi.mock is hoisted, imports are not).
const { AppListingDetailBody } = await import('./AppListingDetailBody');
const { LISTING_REVIEWS_ANCHOR_ID } = await import('~/components/Apps/listingKindLabels');

const FULL_SCOPE = { appBlocks: true, appListings: true, appBlocksPages: false };

beforeEach(async () => {
  mocks.currentUser = { id: 999, username: 'bob' };
  mocks.features = { ...FULL_SCOPE };
  mocks.myReview = null;
  mocks.reviews = [];
  mocks.myReviewHookCalls = 0;
  await page.viewport(...WIDE);
});

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
    forkable: false,
    forkOf: null,
    restrictedAudience: null,
    iconUrl: null,
    coverUrl: null,
    creator: { id: OWNER_ID, username: 'alice', image: null },
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    installCount: 4213,
    openCount: 2718,
    sourceRepoUrl: null,
    issueTrackerUrl: null,
    updatedAt: '2026-03-04T05:06:07.000Z',
    screenshots: [],
    scopes: [],
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

const OFFSITE: Partial<ListingDetail> = {
  kind: 'offsite',
  kindData: { kind: 'offsite', externalUrl: 'https://ext.app', connectClientId: null },
};

const REVIEW_ROW = {
  id: 'r1',
  user: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  recommended: true,
  details: 'Works well',
};

/** Render, wait for the Reviews section, and return it. */
async function renderSection(detail: ListingDetail) {
  const { container } = await renderWithProviders(<AppListingDetailBody detail={detail} />);
  await expect
    .element(page.elementLocator(container).getByRole('heading', { name: 'Reviews', level: 2 }))
    .toBeInTheDocument();
  const section = container.querySelector<HTMLElement>(`#${LISTING_REVIEWS_ANCHOR_ID}`);
  expect(section, 'the reviews section must render').not.toBeNull();
  return section!;
}

const headingCta = (section: HTMLElement) =>
  section.querySelectorAll('[data-testid="apps-listing-reviews-cta"]');
const emptyCta = (section: HTMLElement) =>
  section.querySelectorAll('[data-testid="apps-listing-reviews-empty-cta"]');

describe('Reviews section — visible review entry point', () => {
  test('🔴 an eligible viewer gets a "Leave a review" button IN the Reviews section', async () => {
    mocks.reviews = [REVIEW_ROW];
    const section = await renderSection(base());
    const ctas = headingCta(section);
    expect(ctas).toHaveLength(1);
    expect(ctas[0].tagName).toBe('BUTTON');
    expect(ctas[0].textContent).toBe('Leave a review');
  });

  test('🔴 the label is "Edit review" when the viewer already has a review', async () => {
    mocks.reviews = [REVIEW_ROW];
    mocks.myReview = { id: 7, recommended: true, details: null };
    const section = await renderSection(base());
    const ctas = headingCta(section);
    expect(ctas).toHaveLength(1);
    expect(ctas[0].textContent).toBe('Edit review');
  });

  test('🔴 clicking the section button opens the review modal', async () => {
    mocks.reviews = [REVIEW_ROW];
    const section = await renderSection(base());
    await userEvent.click(headingCta(section)[0] as HTMLElement);
    await expect
      .element(page.getByText('Would you recommend this app to others?'))
      .toBeInTheDocument();
  });

  test('🔴 the cover ⋮ menu item opens the review modal (the body-owned one)', async () => {
    const { container } = await renderWithProviders(<AppListingDetailBody detail={base()} />);
    const trigger = page.elementLocator(container).getByTestId('apps-listing-actions-menu');
    await expect.element(trigger).toBeInTheDocument();
    await userEvent.click(trigger);
    const item = await vi.waitUntil(
      () => document.querySelector<HTMLElement>('[data-testid="apps-listing-review-action"]'),
      { timeout: 10000 }
    );
    await userEvent.click(item);
    await expect
      .element(page.getByText('Would you recommend this app to others?'))
      .toBeInTheDocument();
  });

  describe('preview (moderator read-only) mounts no review UI', () => {
    const REVIEW_CTA_SELECTOR = [
      '[data-testid="apps-listing-reviews-cta"]',
      '[data-testid="apps-listing-reviews-empty-cta"]',
      '[data-testid="apps-listing-actions-menu"]',
    ].join(',');

    async function renderBody(preview: boolean) {
      const { container } = await renderWithProviders(
        <AppListingDetailBody detail={base()} preview={preview} />
      );
      // Render barrier, so a zero below is about the CTAs and not a failed render.
      await expect.element(page.elementLocator(container).getByText('My App')).toBeInTheDocument();
      return container;
    }

    test('positive control: the same eligible viewer, NOT in preview, gets the CTAs', async () => {
      const container = await renderBody(false);
      expect(container.querySelectorAll('[data-testid="apps-listing-reviews-cta"]')).toHaveLength(
        1
      );
      expect(mocks.myReviewHookCalls).toBeGreaterThan(0);
    });

    test('🔴 an eligible viewer in preview gets no review CTA and no review modal', async () => {
      const container = await renderBody(true);
      expect(container.querySelectorAll(REVIEW_CTA_SELECTOR)).toHaveLength(0);
      // The Reviews section has its own `!preview` guard, so the CTA count alone cannot see
      // a modal mounted in preview. A closed modal renders nothing, but it does instantiate
      // `getMyReview` — that is what this counts.
      expect(mocks.myReviewHookCalls).toBe(0);
    });
  });

  describe('hidden by the existing gate', () => {
    test('🔴 the listing OWNER (no self-review)', async () => {
      mocks.currentUser = { id: OWNER_ID, username: 'alice' };
      const section = await renderSection(base());
      expect(headingCta(section)).toHaveLength(0);
      expect(emptyCta(section)).toHaveLength(0);
    });

    test('🔴 a SIGNED-OUT viewer', async () => {
      mocks.currentUser = null;
      const section = await renderSection(base());
      expect(headingCta(section)).toHaveLength(0);
      expect(emptyCta(section)).toHaveLength(0);
    });

    test('🔴 a viewer whose store scope does not admit the listing kind', async () => {
      // External-only cohort on an ONSITE listing — the server would NOT_FOUND the write.
      mocks.features = { appListings: false, appBlocks: false, appListingsPublicExternal: true };
      const section = await renderSection(base());
      expect(headingCta(section)).toHaveLength(0);
      expect(emptyCta(section)).toHaveLength(0);
    });

    test('positive control: the SAME external-only viewer on an OFFSITE listing gets it', async () => {
      // Pairs with the case above: same flags, same viewer, only the kind differs — so the
      // zero there is the kind term, not a section that never renders the button.
      mocks.features = { appListings: false, appBlocks: false, appListingsPublicExternal: true };
      const section = await renderSection(base(OFFSITE));
      expect(headingCta(section)).toHaveLength(1);
    });
  });

  describe('empty state', () => {
    test('🔴 an eligible viewer: "Be the first to review this app." is a button that opens the modal', async () => {
      const section = await renderSection(base());
      const ctas = emptyCta(section);
      expect(ctas).toHaveLength(1);
      expect(ctas[0].tagName).toBe('BUTTON');
      expect(ctas[0].textContent).toBe('Be the first to review this app.');
      await userEvent.click(ctas[0] as HTMLElement);
      await expect
        .element(page.getByText('Would you recommend this app to others?'))
        .toBeInTheDocument();
    });

    test('🔴 an ineligible viewer keeps the plain text, with no button', async () => {
      mocks.currentUser = null;
      const section = await renderSection(base());
      // Positive control: the empty state rendered at all.
      expect(section.textContent).toContain('Be the first to review this app.');
      expect(emptyCta(section)).toHaveLength(0);
      expect(section.querySelectorAll('button')).toHaveLength(0);
    });

    test('a non-empty list shows no empty-state button (the heading button remains)', async () => {
      mocks.reviews = [REVIEW_ROW];
      const section = await renderSection(base());
      await expect.element(page.getByText('Works well')).toBeInTheDocument();
      expect(emptyCta(section)).toHaveLength(0);
      expect(headingCta(section)).toHaveLength(1);
    });
  });
});
