import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useRouter } from 'next/router';
import type * as BrowsingLevel from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as FeedSearch from '~/components/Image/Infinite/useImageFeedSearch';
import type * as ImageUtils from '~/components/Image/image.utils';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as Filters from '~/providers/FiltersProvider';
import type * as TrpcReactQuery from '@trpc/react-query';
import type * as Masonry from '~/components/MasonryColumns/MasonryColumnsVirtual';
import type * as Trpc from '~/utils/trpc';
import { ImagesInfiniteContent } from '~/components/Image/Infinite/ImagesInfinite';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

// The two sources the feed chooses between; what each hands back is the fixture, and which one
// the feed renders and enables is what is under test.
const state = vi.hoisted(() => ({
  searchFails: false,
  refusal: undefined as string | undefined,
  searchInputs: [] as unknown[],
  feedEnabled: [] as (boolean | undefined)[],
}));

const result = (ids: number[], extra: Record<string, unknown> = {}) => ({
  images: ids.map((id) => ({ id, width: 100, height: 100 })),
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
  hasNextPage: false,
  isRefetching: false,
  isFetching: false,
  isError: false,
  ...extra,
});

vi.mock('~/components/Image/Infinite/useImageFeedSearch', async (importOriginal) => ({
  ...(await importOriginal<typeof FeedSearch>()),
  useImageFeedSearchQuery: () => 'red dragon',
  useSemanticImageFeed: (input: unknown) => {
    state.searchInputs.push(input);
    return state.searchFails ? result([], { isError: true }) : result([101, 102]);
  },
}));
vi.mock('~/components/Image/image.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUtils>()),
  useImageFilters: () => ({ query: 'red dragon' }),
  useQueryImages: (_filters: unknown, options: { enabled?: boolean }) => {
    state.feedEnabled.push(options.enabled);
    return { ...result([1, 2, 3]), debugRetryActive: false, debugDelayMs: 0 };
  },
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy(),
}));
// The proxy has no procedure definitions to key on; the feed only uses the key to cancel.
vi.mock('@trpc/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcReactQuery>()),
  getQueryKey: () => ['stub'],
}));
vi.mock('~/components/Search/useSearchRefusal', () => ({
  useSearchRefusal: () => ({ refusal: state.refusal, profanityMatches: [] }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevel>()),
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/providers/FiltersProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof Filters>()),
  useFiltersContext: () => vi.fn(),
}));
vi.mock('~/components/MasonryColumns/MasonryColumnsVirtual', async (importOriginal) => ({
  ...(await importOriginal<typeof Masonry>()),
  MasonryColumnsVirtual: ({ data }: { data: { id: number }[] }) => (
    <ul>
      {data.map((item) => (
        <li key={item.id}>image {item.id}</li>
      ))}
    </ul>
  ),
}));

describe('ImagesInfinite with a search', () => {
  beforeEach(() => {
    state.searchFails = false;
    state.refusal = undefined;
    state.searchInputs = [];
    state.feedEnabled = [];
    useRouter().query = { query: 'red dragon' };
  });

  test('shows the matches and keeps the plain feed switched off', async () => {
    renderWithProviders(<ImagesInfiniteContent searchable />);

    await expect.element(page.getByText('image 101')).toBeVisible();
    expect(page.getByText('image 1', { exact: true }).query()).toBeNull();
    expect(state.feedEnabled.at(-1)).toBe(false);
  });

  test('falls back to the plain feed, with a retry, when the search fails', async () => {
    state.searchFails = true;
    renderWithProviders(<ImagesInfiniteContent searchable />);

    await expect.element(page.getByText('image 1', { exact: true })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Retry search' })).toBeVisible();
    expect(state.feedEnabled.at(-1)).toBe(true);
  });

  test('a refused query from the URL shows the warning and searches nothing', async () => {
    state.refusal = 'illegal';
    renderWithProviders(<ImagesInfiniteContent searchable />);

    await expect.element(page.getByText('Warning')).toBeVisible();
    expect(state.searchInputs.every((input) => input === undefined)).toBe(true);
    expect(state.feedEnabled.at(-1)).toBe(false);
  });
});
