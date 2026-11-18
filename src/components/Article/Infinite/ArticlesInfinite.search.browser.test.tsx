import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as ArticleUtils from '~/components/Article/article.utils';
import type * as Masonry from '~/components/MasonryColumns/MasonryGridVirtual';
import { ArticlesInfinite } from '~/components/Article/Infinite/ArticlesInfinite';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

// The two sources the articles feed chooses between; which one it renders and enables is under test.
const state = vi.hoisted(() => ({
  searchFails: false,
  refusal: undefined as string | undefined,
  searchQueries: [] as (string | undefined)[],
  feedCalls: [] as { query?: string; enabled?: boolean }[],
  features: {} as Record<string, boolean>,
  pageQuery: undefined as string | undefined,
}));

const result = (ids: number[], extra: Record<string, unknown> = {}) => ({
  articles: ids.map((id) => ({ id })),
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
  hasNextPage: false,
  isRefetching: false,
  isFetching: false,
  isError: false,
  ...extra,
});

vi.mock('~/components/Article/article.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ArticleUtils>()),
  useArticleFilters: () => ({}),
  useQueryArticles: (filters: { query?: string }, options?: { enabled?: boolean }) => {
    state.feedCalls.push({ query: filters.query, enabled: options?.enabled });
    return result([1, 2, 3]);
  },
  useSemanticArticleFeed: (_filters: unknown, query: string | undefined) => {
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
        <li key={item.id}>article {item.id}</li>
      ))}
    </ul>
  ),
}));

describe('ArticlesInfinite with a search', () => {
  beforeEach(() => {
    state.searchFails = false;
    state.refusal = undefined;
    state.searchQueries = [];
    state.feedCalls = [];
    state.features = { articleFeedSearch: true };
    state.pageQuery = 'lora guide';
  });

  test("answers the page's query from the search, and leaves the feed query off", async () => {
    await renderWithProviders(<ArticlesInfinite searchable />);
    await expect.element(page.getByText('article 101')).toBeInTheDocument();
    await expect.element(page.getByText('Articles matching “lora guide”')).toBeInTheDocument();
    expect(page.getByText('article 1', { exact: true }).query()).toBeNull();
    expect(state.searchQueries.at(-1)).toBe('lora guide');
    expect(state.feedCalls.at(-1)?.enabled).toBe(false);
  });

  test("falls back to the feed's title match with a banner when the search fails", async () => {
    state.searchFails = true;
    await renderWithProviders(<ArticlesInfinite searchable />);
    await expect.element(page.getByText('article 1', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('Retry search')).toBeInTheDocument();
    expect(state.feedCalls.at(-1)).toEqual({ query: 'lora guide', enabled: true });
  });

  test('a feed that is not searchable, or without the flag, never sends the page query', async () => {
    const { unmount } = await renderWithProviders(
      <ArticlesInfinite filters={{ username: 'someone' }} />
    );
    await expect.element(page.getByText('article 1', { exact: true })).toBeInTheDocument();
    unmount();
    state.features = {};
    await renderWithProviders(<ArticlesInfinite searchable />);
    await expect.element(page.getByText('article 1', { exact: true })).toBeInTheDocument();
    expect(state.searchQueries).toEqual([]);
    expect(state.feedCalls.every((call) => call.query === undefined)).toBe(true);
  });

  test('a refused query reaches neither source', async () => {
    state.refusal = 'illegal';
    await renderWithProviders(<ArticlesInfinite searchable />);
    await expect.poll(() => state.searchQueries.length).toBeGreaterThan(0);
    expect(page.getByText('article 1', { exact: true }).query()).toBeNull();
    expect(state.searchQueries.every((query) => query === undefined)).toBe(true);
    expect(state.feedCalls).toEqual([]);
  });
});
