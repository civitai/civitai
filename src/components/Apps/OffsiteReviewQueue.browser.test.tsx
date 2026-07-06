import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W13 P3a — /apps/review off-site (external-link) queue. Browser-mode render test
 * (report-only in Tekton): a pending off-site row renders in the kind-aware queue,
 * and opening it shows the CONTENT-ONLY checklist (https / asset presence, NO code
 * items) + the external URL + Approve/Reject.
 */

const OFFSITE_ROW = {
  id: 'req-1',
  appListingId: 'listing-1',
  slug: 'ci-ext-app',
  status: 'pending',
  submittedAt: new Date('2026-01-01T00:00:00Z'),
  changelog: 'a note for the reviewer',
  appListing: {
    name: 'CI External App',
    externalUrl: 'https://example.com/app',
    category: 'utility',
    contentRating: 'g',
  },
  submittedBy: { id: 42, username: 'author-dev', image: null },
};

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true }),
}));

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

vi.mock('~/utils/trpc', () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    trpc: {
      useUtils: () => ({
        appListings: {
          listPendingRequests: { invalidate: mocks.invalidate },
          listApprovedRequests: { invalidate: mocks.invalidate },
          listRejectedRequests: { invalidate: mocks.invalidate },
        },
      }),
      appListings: {
        listPendingRequests: {
          useQuery: () => ({
            data: { items: [OFFSITE_ROW], nextCursor: null },
            isLoading: false,
            error: null,
          }),
        },
        getAssets: {
          useQuery: () => ({
            data: { listingId: 'listing-1', iconId: 10, coverId: 11, screenshots: [{ imageId: 12 }] },
            isLoading: false,
            error: null,
          }),
        },
        approveExternalRequest: { useMutation: mutation },
        rejectExternalRequest: { useMutation: mutation },
      },
    },
  };
});

const { OffsiteReviewQueue } = await import('./OffsiteReviewQueue');

beforeEach(() => {
  mocks.invalidate.mockClear();
});

describe('OffsiteReviewQueue — kind-aware review row', () => {
  test('renders a pending off-site row', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await expect.element(page.getByText('ci-ext-app')).toBeInTheDocument();
    await expect.element(page.getByText('External-link submissions')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Review' })).toBeInTheDocument();
  });

  test('opening a row shows the content-only checklist + external URL + Approve/Reject', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    // Content checklist items — the off-site (content-only) set.
    await expect
      .element(page.getByText('URL is https and opens externally'))
      .toBeInTheDocument();
    await expect.element(page.getByText('Icon present')).toBeInTheDocument();
    // NO on-site code items.
    expect(page.getByText('Code diff reviewed').elements()).toHaveLength(0);
    // Approve + Reject actions present.
    await expect.element(page.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Reject…' })).toBeInTheDocument();
  });
});
