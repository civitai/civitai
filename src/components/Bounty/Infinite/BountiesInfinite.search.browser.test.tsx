import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as BountyUtils from '~/components/Bounty/bounty.utils';
import type * as Masonry from '~/components/MasonryColumns/MasonryGridVirtual';
import { BountiesInfinite } from '~/components/Bounty/Infinite/BountiesInfinite';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

// The two sources the bounties feed chooses between; which one it renders and enables is under test.
const state = vi.hoisted(() => ({
  searchFails: false,
  refusal: undefined as string | undefined,
  searchQueries: [] as (string | undefined)[],
  feedCalls: [] as { query?: string; enabled?: boolean }[],
  features: {} as Record<string, boolean>,
  pageQuery: undefined as string | undefined,
}));

const result = (ids: number[], extra: Record<string, unknown> = {}) => ({
  bounties: ids.map((id) => ({ id })),
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
  hasNextPage: false,
  isRefetching: false,
  isFetching: false,
  isError: false,
  ...extra,
});

vi.mock('~/components/Bounty/bounty.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof BountyUtils>()),
  useBountyFilters: () => ({}),
  useQueryBounties: (filters: { query?: string }, options?: { enabled?: boolean }) => {
    state.feedCalls.push({ query: filters.query, enabled: options?.enabled });
    // An earlier page with more to load, as a disabled query keeps it.
    return result([1, 2, 3], { hasNextPage: true });
  },
  useSemanticBountyFeed: (_filters: unknown, query: string | undefined) => {
    state.searchQueries.push(query);
    if (!query) return { ...result([]), searchKey: undefined };
    return state.searchFails
      ? { ...result([], { isError: true }), searchKey: query }
      : { ...result([101, 102]), searchKey: query, correctedQuery: undefined };
  },
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useFeatureFlags: () => state.features,
}));
vi.mock('~/components/Filters/FeedSearchInput', () => ({
  useFeedSearchQuery: () => state.pageQuery,
}));
vi.mock('~/components/Search/useSearchRefusal', () => ({
  useSearchRefusal: () => ({ refusal: state.refusal, profanityMatches: [] }),
}));
vi.mock('~/components/MasonryColumns/MasonryGridVirtual', async (importOriginal) => ({
  ...(await importOriginal<typeof Masonry>()),
  MasonryGridVirtual: ({ data }: { data: { id: number }[] }) => (
    <ul>
      {data.map((item) => (
        <li key={item.id}>bounty {item.id}</li>
      ))}
    </ul>
  ),
}));

describe('BountiesInfinite with a search', () => {
  beforeEach(() => {
    state.searchFails = false;
    state.refusal = undefined;
    state.searchQueries = [];
    state.feedCalls = [];
    state.features = { semanticBountySearch: true };
    state.pageQuery = 'lora guide';
  });

  test("answers the page's query from the search, and leaves the feed query off", async () => {
    await renderWithProviders(<BountiesInfinite searchable />);
    await expect.element(page.getByText('bounty 101')).toBeInTheDocument();
    await expect.element(page.getByText('Bounties matching “lora guide”')).toBeInTheDocument();
    expect(page.getByText('bounty 1', { exact: true }).query()).toBeNull();
    expect(state.searchQueries.at(-1)).toBe('lora guide');
    expect(state.feedCalls.at(-1)?.enabled).toBe(false);
  });

  // The keyword feed has no server profanity check, so it must not show or page the query.
  test('shows the banner over no results when the search fails, never the feed', async () => {
    state.searchFails = true;
    await renderWithProviders(<BountiesInfinite searchable />);
    await expect.element(page.getByText('Retry search')).toBeInTheDocument();
    expect(page.getByText('bounty 1', { exact: true }).query()).toBeNull();
    expect(state.feedCalls.at(-1)?.enabled).toBe(false);
  });

  test('a feed that is not searchable, or without the flag, never sends the page query', async () => {
    const { unmount } = await renderWithProviders(<BountiesInfinite filters={{ userId: 7 }} />);
    await expect.element(page.getByText('bounty 1', { exact: true })).toBeInTheDocument();
    unmount();
    state.features = {};
    await renderWithProviders(<BountiesInfinite searchable />);
    await expect.element(page.getByText('bounty 1', { exact: true })).toBeInTheDocument();
    expect(state.searchQueries).toEqual([]);
    expect(state.feedCalls.every((call) => call.query === undefined)).toBe(true);
  });

  test('a refused query reaches neither source', async () => {
    state.refusal = 'illegal';
    await renderWithProviders(<BountiesInfinite searchable />);
    await expect.poll(() => state.searchQueries.length).toBeGreaterThan(0);
    expect(page.getByText('bounty 1', { exact: true }).query()).toBeNull();
    expect(state.searchQueries.every((query) => query === undefined)).toBe(true);
    expect(state.feedCalls).toEqual([]);
  });
});
