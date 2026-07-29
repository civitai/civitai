import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

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

vi.mock('~/utils/trpc', () => ({
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

  test('the listing owner does NOT see the CTA (no self-review)', async () => {
    mocks.currentUser = { id: 99, username: 'owner' };
    renderWithProviders(<ReviewListingButton appListingId="apl_1" ownerUserId={99} />);
    await expect
      .element(page.getByRole('button', { name: /leave a review/i }))
      .not.toBeInTheDocument();
  });

  test('a signed-out viewer does NOT see the CTA', async () => {
    mocks.currentUser = null;
    renderWithProviders(<ReviewListingButton appListingId="apl_1" ownerUserId={99} />);
    await expect
      .element(page.getByRole('button', { name: /leave a review/i }))
      .not.toBeInTheDocument();
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
