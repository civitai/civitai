import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as BrowsingLevel from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as ModelUtils from '~/components/Model/model.utils';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as Masonry from '~/components/MasonryColumns/MasonryGridVirtual';
import type * as CardContext from '~/components/Cards/ModelCardContext';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

// The two sources the models feed chooses between; which one it renders and enables is under test.
const state = vi.hoisted(() => ({
  searchFails: false,
  refusal: undefined as string | undefined,
  searchQueries: [] as (string | undefined)[],
  feedEnabled: [] as (boolean | undefined)[],
  features: {} as Record<string, boolean>,
}));

const result = (ids: number[], extra: Record<string, unknown> = {}) => ({
  models: ids.map((id) => ({ id })),
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
  hasNextPage: false,
  isRefetching: false,
  isFetching: false,
  isError: false,
  ...extra,
});

vi.mock('~/components/Model/model.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelUtils>()),
  useModelFilters: () => ({}),
  useQueryModels: (_filters: unknown, options?: { enabled?: boolean }) => {
    state.feedEnabled.push(options?.enabled);
    return result([1, 2, 3]);
  },
  useSemanticModelFeed: (_filters: unknown, query: string | undefined) => {
    state.searchQueries.push(query);
    if (!query) return { ...result([]), searchKey: undefined };
    return state.searchFails
      ? { ...result([], { isError: true }), searchKey: query }
      : { ...result([101, 102]), searchKey: query, correctedQuery: undefined };
  },
}));
vi.mock('~/components/Search/useSearchRefusal', () => ({
  useSearchRefusal: () => ({ refusal: state.refusal, profanityMatches: [] }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/hooks/useEngagedModelMembership', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEngagedModelsPrefetch: () => undefined,
}));
vi.mock('~/components/Cards/ModelCardContext', async (importOriginal) => ({
  ...(await importOriginal<typeof CardContext>()),
  useModelSaleBadges: () => ({}),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => state.features,
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevel>()),
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/MasonryColumns/MasonryGridVirtual', async (importOriginal) => ({
  ...(await importOriginal<typeof Masonry>()),
  MasonryGridVirtual: ({ data }: { data: { id: number }[] }) => (
    <ul>
      {data.map((item) => (
        <li key={item.id}>model {item.id}</li>
      ))}
    </ul>
  ),
}));

const render = (props: { searchable?: boolean } = { searchable: true }) =>
  renderWithProviders(<ModelsInfinite filters={{ query: '  anime  girl ' }} {...props} />);

describe('ModelsInfinite with a search', () => {
  beforeEach(() => {
    state.searchFails = false;
    state.refusal = undefined;
    state.searchQueries = [];
    state.feedEnabled = [];
    state.features = { modelFeedSearch: true };
  });

  test("answers the page's query from the search, and leaves the feed query off", async () => {
    render();
    await expect.element(page.getByText('model 101')).toBeInTheDocument();
    await expect.element(page.getByText('Models matching “anime girl”')).toBeInTheDocument();
    expect(page.getByText('model 1', { exact: true }).query()).toBeNull();
    expect(state.searchQueries.at(-1)).toBe('anime girl');
    expect(state.feedEnabled.at(-1)).toBe(false);
  });

  test('falls back to the keyword feed with a banner when the search fails', async () => {
    state.searchFails = true;
    render();
    await expect.element(page.getByText('model 1', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('Retry search')).toBeInTheDocument();
    expect(state.feedEnabled.at(-1)).toBe(true);
  });

  test("keeps today's keyword feed without the flag, or off the models page", async () => {
    state.features = {};
    const { unmount } = await render();
    await expect.element(page.getByText('model 1', { exact: true })).toBeInTheDocument();
    expect(state.searchQueries.every((query) => query === undefined)).toBe(true);
    unmount();

    state.features = { modelFeedSearch: true };
    state.searchQueries = [];
    await render({ searchable: false });
    await expect.element(page.getByText('model 1', { exact: true })).toBeInTheDocument();
    expect(state.searchQueries.every((query) => query === undefined)).toBe(true);
  });

  test('a refused query reaches neither source', async () => {
    state.refusal = 'illegal';
    await render();
    await expect.poll(() => state.searchQueries.length).toBeGreaterThan(0);
    expect(page.getByText('model 1', { exact: true }).query()).toBeNull();
    expect(state.searchQueries.every((query) => query === undefined)).toBe(true);
    expect(state.feedEnabled.filter(Boolean)).toEqual([]);
  });
});
