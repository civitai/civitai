import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';

/**
 * W13 — AppListing REVIEW button (thumbs/recommend) component tests.
 *
 * Load-bearing behaviours, network-free (tRPC mocked via the scaffold's documented
 * `vi.mock('~/utils/trpc')` pattern):
 *   1. ELIGIBILITY GATING — hidden for a signed-out viewer AND for the listing
 *      owner (the self-review CTA never renders); shown for any other signed-in
 *      user (no install gate).
 *   2. WRITE WIRING — picking a thumbs value + typing details + submit calls
 *      `appListings.upsertReview` with exactly `{appListingId, recommended, details}`.
 */

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  invalidate: vi.fn().mockResolvedValue(undefined),
  myReview: null as null | { id: number; recommended: boolean; details: string | null; createdAt: Date },
  currentUser: { id: 42, username: 'viewer' } as null | { id: number; username: string },
}));

// 🔴 Spread the REAL module and override only `trpc` (local-rules/no-wholesale-module-mock).
// This file previously hand-wrote the whole module, and that broke the day
// `ReviewListingButton` started importing `~/providers/FeatureFlagsProvider` — which
// imports `setTrpcBatchingEnabled` from here. The failure surfaced as
// `Failed to import test file`, i.e. as an ERRORED SUITE with `Tests 0`, not as a
// failing assertion: exactly the "no tests" shape that reads as nothing to see.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    appListings: {
      getMyReview: {
        useQuery: () => ({ data: mocks.myReview, isLoading: false }),
      },
      upsertReview: {
        useMutation: ({ onSuccess }: { onSuccess?: (r: unknown) => void } = {}) => ({
          mutate: (input: unknown) => {
            mocks.upsert(input);
            onSuccess?.({ isNewReview: true });
          },
          isPending: false,
        }),
      },
      listReviews: { invalidate: mocks.invalidate },
    },
    useUtils: () => ({
      appListings: {
        getMyReview: { invalidate: mocks.invalidate },
        listReviews: { invalidate: mocks.invalidate },
        getAppDetail: { invalidate: mocks.invalidate },
      },
    }),
  },
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.currentUser,
}));

// `useCanReviewListing` reads `useOptionalFeatureFlags` for the store-scope KIND term.
// These cases pass no `listingKind`, so the term is skipped and the flags are not
// consulted — but the hook still runs, and outside a provider the REAL one returns
// `null`. Pinned to a full-scope set so this suite keeps asserting ONLY the
// signed-in / owner / write-wiring behaviours it was written for. The kind term has
// its own suite: `ReviewListingButton.storeScope.browser.test.tsx`.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => {
  const flags = { appBlocks: true, appListings: true, appListingsPublicExternal: false };
  return {
    ...(await importOriginal<typeof FeatureFlagsMod>()),
    useFeatureFlags: () => flags,
    useOptionalFeatureFlags: () => flags,
  };
});

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

// Import AFTER the mocks are declared (vi.mock is hoisted, imports are not).
const { ReviewListingButton } = await import('./ReviewListingButton');

beforeEach(() => {
  mocks.upsert.mockClear();
  mocks.invalidate.mockClear();
  mocks.myReview = null;
  mocks.currentUser = { id: 42, username: 'viewer' };
});

describe('ReviewListingButton', () => {
  test('signed-in non-owner sees the review CTA', async () => {
    renderWithProviders(<ReviewListingButton appListingId="apl_1" ownerUserId={99} />);
    await expect.element(page.getByRole('button', { name: /leave a review/i })).toBeInTheDocument();
  });

  // 🔴 THESE TWO WERE VACUOUS AND ARE NOW COUNTS. `expect.element(...).not.toBeInTheDocument()`
  // does not observe this harness: measured against a build where the button
  // demonstrably renders, the `.not` form PASSED while `.toBeInTheDocument()` on the
  // SAME locator in the SAME test ALSO passed. Both directions green on one element
  // means the assertion was proving nothing, so neither gate below was actually
  // pinned. `.elements()` returns an array, so this is a countable claim — and the
  // sentinel is the positive control that separates "hidden" from "never mounted".
  const SENTINEL = <span data-testid="review-cta-sentinel" />;

  async function expectNoCta() {
    await expect.element(page.getByTestId('review-cta-sentinel')).toBeInTheDocument();
    expect(page.getByRole('button', { name: /leave a review/i }).elements()).toHaveLength(0);
  }

  test('the listing owner does NOT see the CTA (no self-review)', async () => {
    mocks.currentUser = { id: 99, username: 'owner' };
    renderWithProviders(
      <>
        {SENTINEL}
        <ReviewListingButton appListingId="apl_1" ownerUserId={99} />
      </>
    );
    await expectNoCta();
  });

  test('a signed-out viewer does NOT see the CTA', async () => {
    mocks.currentUser = null;
    renderWithProviders(
      <>
        {SENTINEL}
        <ReviewListingButton appListingId="apl_1" ownerUserId={99} />
      </>
    );
    await expectNoCta();
  });

  test('picking Recommend + typing details submits upsertReview with the entered values', async () => {
    renderWithProviders(<ReviewListingButton appListingId="apl_1" ownerUserId={99} />);

    await page.getByRole('button', { name: /leave a review/i }).click();

    // Modal is open — choose the thumbs value, type a blurb, submit.
    await page.getByRole('button', { name: /^recommend$/i }).click();
    await page.getByRole('textbox').fill('Great app, very useful');
    await page.getByRole('button', { name: /post review/i }).click();

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).toHaveBeenCalledWith({
      appListingId: 'apl_1',
      recommended: true,
      details: 'Great app, very useful',
    });
  });
});
