import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * The reviews list shows the first 4 reviews, then a "Show all reviews" button that reveals the
 * rest in place (and only then lets the existing infinite query load further pages). Every review
 * body is distinct, so a list that showed the wrong slice — the last 4, or 4 out of order — fails.
 */

const DETAILS = [
  'Alpha: the export button saved me hours',
  'Bravo: crashes when I upload a large file',
  'Charlie: wish it had a dark mode',
  'Delta: the onboarding was confusing',
  'Echo: best tagging helper I have used',
  'Foxtrot: slow on my older laptop',
  'Golf: support answered within a day',
];

const mocks = vi.hoisted(() => ({
  items: [] as unknown[],
  hasNextPage: false,
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
        data: { pages: [{ items: mocks.items, nextCursor: mocks.hasNextPage ? 99 : undefined }] },
        isLoading: false,
        hasNextPage: mocks.hasNextPage,
        isFetchingNextPage: false,
        fetchNextPage: mocks.fetchNextPage,
      }),
    },
  }),
}));

const { AppListingReviews } = await import('./AppListingReviews');

function seed(n: number) {
  mocks.items = DETAILS.slice(0, n).map((details, i) => ({
    id: 100 + i,
    user: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    recommended: i % 2 === 0,
    details,
  }));
}

/** The review bodies present in `container`, in DOM order. */
function shown(container: HTMLElement): string[] {
  const text = container.textContent ?? '';
  return DETAILS.filter((d) => text.includes(d)).sort((a, b) => text.indexOf(a) - text.indexOf(b));
}

const showAllButtons = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('button')).filter(
    (b) => b.textContent?.trim() === 'Show all reviews'
  );

/** Bring the last element (the scroll-to-load sentinel, when one renders) into view. */
function scrollToEnd(container: HTMLElement) {
  const divs = container.querySelectorAll('div');
  divs[divs.length - 1]?.scrollIntoView();
}

beforeEach(() => {
  mocks.items = [];
  mocks.hasNextPage = false;
  mocks.fetchNextPage.mockReset();
});

describe('AppListingReviews — first 4, then "Show all reviews"', () => {
  test('🔴 with 7 reviews only the first 4 render, and the button reveals the other 3', async () => {
    seed(7);
    const { container } = await renderWithProviders(<AppListingReviews appListingId="l1" />);
    const within = page.elementLocator(container);
    await expect.element(within.getByText(DETAILS[0])).toBeInTheDocument();

    expect(shown(container)).toEqual(DETAILS.slice(0, 4));
    expect(showAllButtons(container)).toHaveLength(1);

    await userEvent.click(within.getByRole('button', { name: 'Show all reviews' }));
    await expect.element(within.getByText(DETAILS[6])).toBeInTheDocument();

    expect(shown(container)).toEqual(DETAILS);
    expect(showAllButtons(container)).toHaveLength(0);
  });

  test.each([3, 4])('with %i reviews all render and there is no button', async (n) => {
    seed(n);
    const { container } = await renderWithProviders(<AppListingReviews appListingId="l1" />);
    await expect.element(page.elementLocator(container).getByText(DETAILS[0])).toBeInTheDocument();

    expect(shown(container)).toEqual(DETAILS.slice(0, n));
    expect(showAllButtons(container)).toHaveLength(0);
  });

  test('🔴 4 loaded with a further page offers the button and does not page further', async () => {
    seed(4);
    mocks.hasNextPage = true;
    const { container } = await renderWithProviders(<AppListingReviews appListingId="l1" />);
    await expect.element(page.elementLocator(container).getByText(DETAILS[0])).toBeInTheDocument();

    expect(showAllButtons(container)).toHaveLength(1);

    // Exactly a full first screen: collapsed, it must stop here. `InViewLoader` waits 1500ms
    // before its first load; wait past it.
    scrollToEnd(container);
    await new Promise((r) => setTimeout(r, 2500));
    expect(mocks.fetchNextPage).not.toHaveBeenCalled();
  });

  test('🔴 collapsed, it does not page further; after "Show all" the infinite query takes over', async () => {
    seed(7);
    mocks.hasNextPage = true;
    const { container } = await renderWithProviders(<AppListingReviews appListingId="l1" />);
    const within = page.elementLocator(container);
    await expect.element(within.getByText(DETAILS[0])).toBeInTheDocument();

    // Scroll to the end so a scroll-to-load sentinel, if one were rendered, would be in view.
    // `InViewLoader` waits 1500ms before its first load; wait past it.
    scrollToEnd(container);
    await new Promise((r) => setTimeout(r, 2500));
    expect(mocks.fetchNextPage).not.toHaveBeenCalled();

    await userEvent.click(within.getByRole('button', { name: 'Show all reviews' }));
    await expect.element(within.getByText(DETAILS[6])).toBeInTheDocument();
    scrollToEnd(container);
    await vi.waitFor(() => expect(mocks.fetchNextPage).toHaveBeenCalledTimes(1), {
      timeout: 5000,
    });
  });

  test('🔴 navigating to another listing starts collapsed again', async () => {
    seed(7);
    const screen = await renderWithProviders(<AppListingReviews appListingId="l1" />);
    const within = page.elementLocator(screen.container);
    await userEvent.click(within.getByRole('button', { name: 'Show all reviews' }));
    await expect.element(within.getByText(DETAILS[6])).toBeInTheDocument();
    expect(shown(screen.container)).toEqual(DETAILS);

    await screen.rerender(<AppListingReviews appListingId="l2" />);
    await vi.waitFor(() => expect(shown(screen.container)).toEqual(DETAILS.slice(0, 4)));
    expect(showAllButtons(screen.container)).toHaveLength(1);
  });

  test('🔴 collapsed with fewer than 4 loaded and a further page, it keeps paging', async () => {
    seed(3);
    mocks.hasNextPage = true;
    const { container } = await renderWithProviders(<AppListingReviews appListingId="l1" />);
    await expect.element(page.elementLocator(container).getByText(DETAILS[0])).toBeInTheDocument();
    expect(showAllButtons(container)).toHaveLength(0);

    scrollToEnd(container);
    await vi.waitFor(() => expect(mocks.fetchNextPage).toHaveBeenCalledTimes(1), {
      timeout: 5000,
    });
  });
});
