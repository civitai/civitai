import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';

// What the Queue reads when every workflow on the pages loaded so far was an app run (filtered out
// on the server), and the cursor says there is more behind them.
const h = vi.hoisted(() => ({ hasNextPage: true, fetchNextPage: vi.fn(async () => undefined) }));
vi.mock('~/components/ImageGeneration/GeneratedRequestsProvider', () => ({
  useGeneratedRequestsContext: () => ({
    data: [],
    markerTags: [],
    isLoading: false,
    isFetching: false,
    isRefetching: false,
    isError: false,
    error: null,
    hasNextPage: h.hasNextPage,
    fetchNextPage: h.fetchNextPage,
  }),
}));
vi.mock('~/providers/FiltersProvider', () => ({
  useFiltersContext: <T,>(selector: (state: { generation: object }) => T) =>
    selector({ generation: {} }),
}));

import { Feed } from '~/components/ImageGeneration/Feed';
import { Queue } from '~/components/ImageGeneration/Queue';

describe('Queue with an empty page and more behind it', () => {
  test('keeps loading pages instead of saying the queue is empty', async () => {
    h.hasNextPage = true;
    h.fetchNextPage.mockClear();
    renderWithProviders(<Queue />);

    // The loader waits 1.5 s before its first load, then re-arms 0.5 s after each one.
    await expect
      .poll(() => h.fetchNextPage.mock.calls.length, { timeout: 5000 })
      .toBeGreaterThan(1);
    expect(page.getByText('The queue is empty').query()).toBeNull();
  });

  test('CONTROL: with nothing behind it, the empty state shows', async () => {
    h.hasNextPage = false;
    h.fetchNextPage.mockClear();
    renderWithProviders(<Queue />);

    await expect.element(page.getByText('The queue is empty')).toBeVisible();
    expect(h.fetchNextPage).not.toHaveBeenCalled();
  });
});

describe('Feed with an empty page and more behind it', () => {
  test('keeps loading pages', async () => {
    h.hasNextPage = true;
    h.fetchNextPage.mockClear();
    renderWithProviders(<Feed />);

    await expect
      .poll(() => h.fetchNextPage.mock.calls.length, { timeout: 5000 })
      .toBeGreaterThan(1);
  });
});
