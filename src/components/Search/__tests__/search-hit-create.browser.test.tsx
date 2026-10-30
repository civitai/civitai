import { describe, expect, test, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import type * as ModelCardContext from '~/components/Cards/ModelCardContext';

/**
 * The model search page read the index's model-level `canGenerate` (live rule only), so a
 * checkpoint the viewer may generate with showed Create in the feed and not in search.
 */
const h = vi.hoisted(() => ({
  audience: { current: undefined as { next: boolean; member: boolean } | undefined },
  hits: [
    {
      id: 7,
      type: 'Checkpoint',
      canGenerate: false,
      version: { id: 70 },
      versions: [{ id: 70, canGenerate: false, canGenerateNext: true, generatorLoaded: false }],
    },
  ],
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'generation.getCoverageAudience': { useQuery: () => ({ data: h.audience.current }) },
    }),
  };
});
vi.mock('~/components/Cards/ModelCard', () => ({
  ModelCard: ({ data }: { data: { id: number; canGenerate?: boolean } }) => (
    <span data-card={data.id} data-can-generate={String(data.canGenerate)} />
  ),
}));
vi.mock('~/components/MasonryColumns/MasonryGrid', () => ({
  MasonryGrid: ({
    data,
    render: Render,
  }: {
    data: { id: number }[];
    render: (p: { data: unknown }) => JSX.Element;
  }) => (
    <>
      {data.map((d) => (
        <Render key={d.id} data={d} />
      ))}
    </>
  ),
}));
vi.mock('~/components/Cards/ModelCardContext', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelCardContext>()),
  useModelSaleBadges: () => undefined,
}));
vi.mock('~/hooks/useEngagedModelMembership', () => ({ useEngagedModelsPrefetch: () => undefined }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/components/InView/InViewLoader', () => ({ InViewLoader: () => null }));
vi.mock('~/components/Search/search.utils2', () => ({
  useInfiniteHitsTransformed: () => ({ hits: h.hits, showMore: () => undefined, isLastPage: true }),
}));
vi.mock('react-instantsearch', () => ({
  useInstantSearch: () => ({ status: 'idle', uiState: {} }),
}));
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: ({ data }: { data: unknown[] }) => ({
    items: data,
    loadingPreferences: false,
    hiddenCount: 0,
  }),
}));
vi.mock('~/components/Decorations/useSearchEventDecorations', () => ({
  useSearchEventDecorations: (_hits: unknown, items: unknown) => items,
}));
vi.mock('~/components/Search/CustomSearchComponents', () => ({
  BrowsingLevelFilter: () => null,
  ChipRefinementList: () => null,
  ClearRefinements: () => null,
  DateRangeRefinement: () => null,
  SearchableMultiSelectRefinementList: () => null,
  SortBy: () => null,
}));
vi.mock('~/components/Search/SearchHeader', () => ({ SearchHeader: () => null }));
vi.mock('~/components/Search/SearchLayout', () => ({ SearchLayout: () => null }));
vi.mock('~/components/Search/TimeoutLoader', () => ({ TimeoutLoader: () => null }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => ({}) }));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', () => ({
  useBrowsingSettingsAddons: () => ({ settings: {} }),
}));

import { renderWithProviders } from '../../../../test/component-setup';
import { ModelsHitList } from '~/pages/search/models';

async function canGenerateShown() {
  renderWithProviders(<ModelsHitList />);
  let value: string | null | undefined;
  await vi.waitFor(() => {
    value = document.querySelector('[data-card="7"]')?.getAttribute('data-can-generate');
    expect(value).toBeDefined();
  });
  return value;
}

describe('model search card Create', () => {
  test('follows the viewer’s coverage rule, not the indexed model-level field', async () => {
    h.audience.current = { next: true, member: true };
    expect(await canGenerateShown()).toBe('true');
  });

  test('stays on the live rule until the audience has loaded', async () => {
    h.audience.current = undefined;
    expect(await canGenerateShown()).toBe('false');
  });
});
