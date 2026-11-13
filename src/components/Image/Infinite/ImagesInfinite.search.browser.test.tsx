import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useRouter } from 'next/router';
import { useSyncExternalStore } from 'react';
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
  periodWrites: [] as unknown[],
}));

// The saved feed filters: a store the fake `useFiltersContext` reads and writes, so a write lands
// in the next render as it does in the app.
const savedFilters = vi.hoisted(() => {
  let snapshot: { period?: string } = {};
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    set(patch: { period?: string }) {
      snapshot = { ...snapshot, ...patch };
      listeners.forEach((listener) => listener());
    },
    reset(period?: string) {
      snapshot = { period };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
const useSavedFilters = () => useSyncExternalStore(savedFilters.subscribe, savedFilters.get);
const useUrlQuery = () => useRouter().query as { query?: string; period?: string };

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
  useImageFeedSearchQuery: () => useUrlQuery().query,
  useSemanticImageFeed: (input: unknown) => {
    state.searchInputs.push(input);
    return state.searchFails ? result([], { isError: true }) : result([101, 102]);
  },
}));
vi.mock('~/components/Image/image.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUtils>()),
  useImageFilters: () => ({ ...useSavedFilters(), ...useUrlQuery() }),
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
  useFiltersContext: (selector: (store: unknown) => unknown) =>
    selector({
      images: useSavedFilters(),
      setImageFilters: (patch: { period?: string }) => {
        state.periodWrites.push(patch);
        savedFilters.set(patch);
      },
    }),
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
    state.periodWrites = [];
    savedFilters.reset();
    localStorage.clear();
    useRouter().query = { query: 'red dragon' };
  });

  test('shows the matches and keeps the plain feed switched off', async () => {
    renderWithProviders(<ImagesInfiniteContent searchable />);

    await expect.element(page.getByText('image 101')).toBeVisible();
    expect(state.searchInputs.at(-1)).toMatchObject({ query: 'red dragon' });
    expect(page.getByText('image 1', { exact: true }).query()).toBeNull();
    expect(state.feedEnabled.at(-1)).toBe(false);
  });

  const postedAfters = () =>
    (state.searchInputs.filter(Boolean) as { postedAfter?: Date }[]).map(
      (input) => input.postedAfter
    );

  test("starts over all time, not the feed's saved week, and gives the week back on clear", async () => {
    savedFilters.reset('Week');
    const screen = await renderWithProviders(<ImagesInfiniteContent searchable />);

    await expect.element(page.getByText('image 101')).toBeVisible();
    expect(postedAfters().length).toBeGreaterThan(0);
    expect(postedAfters().every((postedAfter) => postedAfter === undefined)).toBe(true);
    expect(state.periodWrites).toEqual([{ period: 'AllTime' }]);

    useRouter().query = {};
    await screen.rerender(<ImagesInfiniteContent searchable />);
    await expect.element(page.getByText('image 1', { exact: true })).toBeVisible();
    expect(state.periodWrites).toEqual([{ period: 'AllTime' }, { period: 'Week' }]);
  });

  test('keeps a period picked during the search when it is cleared', async () => {
    savedFilters.reset('Week');
    const screen = await renderWithProviders(<ImagesInfiniteContent searchable />);
    await expect.element(page.getByText('image 101')).toBeVisible();

    savedFilters.set({ period: 'Month' });
    useRouter().query = {};
    await screen.rerender(<ImagesInfiniteContent searchable />);
    await expect.element(page.getByText('image 1', { exact: true })).toBeVisible();
    expect(state.periodWrites).toEqual([{ period: 'AllTime' }]);
  });

  test('a period on the URL outranks the reset', async () => {
    savedFilters.reset('Week');
    useRouter().query = { query: 'red dragon', period: 'Month' };
    renderWithProviders(<ImagesInfiniteContent searchable />);

    await expect.element(page.getByText('image 101')).toBeVisible();
    expect(postedAfters().length).toBeGreaterThan(0);
    expect(postedAfters().every((postedAfter) => postedAfter instanceof Date)).toBe(true);
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
    expect(state.searchInputs.length).toBeGreaterThan(0);
    expect(state.searchInputs.every((input) => input === undefined)).toBe(true);
    expect(state.feedEnabled.at(-1)).toBe(false);
  });
});
