import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * Reviews load the next page by scrolling, not by a "Load more" button: the sentinel at the end of
 * the list calls `fetchNextPage` once it is in view, and not while a page is already in flight.
 */

const mocks = vi.hoisted(() => ({
  hasNextPage: true,
  isFetchingNextPage: false,
  fetchNextPage: vi.fn(),
}));

// `DaysFromNow` throws 'missing IsClientContext' outside the app shell.
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'appListings.listReviews': {
      useInfiniteQuery: () => ({
        data: {
          pages: [
            {
              items: [
                {
                  id: 'r1',
                  user: null,
                  createdAt: new Date('2026-10-01T00:00:00Z'),
                  recommended: true,
                  details: 'Works well',
                },
              ],
              nextCursor: 'c1',
            },
          ],
        },
        isLoading: false,
        hasNextPage: mocks.hasNextPage,
        isFetchingNextPage: mocks.isFetchingNextPage,
        fetchNextPage: mocks.fetchNextPage,
      }),
    },
  }),
}));

const { AppListingReviews } = await import('./AppListingReviews');

beforeEach(() => {
  mocks.hasNextPage = true;
  mocks.isFetchingNextPage = false;
  mocks.fetchNextPage.mockReset();
});

describe('AppListingReviews infinite scroll', () => {
  test('has no Load more button, and fetches the next page when the end is in view', async () => {
    renderWithProviders(<AppListingReviews appListingId="l1" />);
    await expect.element(page.getByText('Works well')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Load more');
    await vi.waitFor(() => expect(mocks.fetchNextPage).toHaveBeenCalledTimes(1), {
      timeout: 4000,
    });
  });

  test('positive control: with no further page it never fetches', async () => {
    mocks.hasNextPage = false;
    renderWithProviders(<AppListingReviews appListingId="l1" />);
    await expect.element(page.getByText('Works well')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 2500));
    expect(mocks.fetchNextPage).not.toHaveBeenCalled();
  });

  test('does not fetch while a page is already in flight', async () => {
    mocks.isFetchingNextPage = true;
    renderWithProviders(<AppListingReviews appListingId="l1" />);
    await expect.element(page.getByText('Works well')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 2500));
    expect(mocks.fetchNextPage).not.toHaveBeenCalled();
  });
});
