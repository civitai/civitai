// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';

const state = vi.hoisted(() => ({
  browsingLevel: 1,
  items: [] as unknown[],
  gridItems: [] as unknown[],
  featured: [] as unknown[],
}));

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => state.browsingLevel,
}));
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: () => ({
    items: state.gridItems,
    loadingPreferences: false,
    hiddenCount: 0,
  }),
}));
vi.mock(
  '~/components/ImageGeneration/GenerationForm/ResourceSelectModal/useResourceSelectInfinite',
  () => ({
    useResourceSelectInfinite: () => ({
      items: state.items,
      isLoading: false,
      isFetching: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isError: false,
      refetch: vi.fn(),
    }),
  })
);
vi.mock('~/components/ImageGeneration/GenerationForm/ResourceSelectProvider', () => ({
  useResourceSelectContext: () => ({
    canGenerate: undefined,
    resources: [{ type: 'Checkpoint', baseModels: [] }],
    selectSource: 'generation',
    excludedIds: [],
    tab: 'featured',
  }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: { model: { getFeaturedModels: { useQuery: () => ({ data: state.featured }) } } },
}));
vi.mock(
  '~/components/ImageGeneration/GenerationForm/ResourceSelectModal/ResourceSelectCard',
  () => ({
    ResourceSelectCard: ({ data }: { data: { id: number; images: { id: number }[] } }) =>
      createElement('div', { 'data-card': data.id, 'data-image': data.images[0]?.id }),
  })
);
vi.mock('~/components/MasonryColumns/MasonryColumnsVirtual', () => ({
  MasonryColumnsVirtual: () => null,
}));
vi.mock('~/components/MasonryColumns/MasonryProvider', () => ({
  MasonryProvider: ({ children }: { children: unknown }) => children,
}));

import { ResourceHitList } from '~/components/ImageGeneration/GenerationForm/ResourceSelectModal/ResourceHitList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const X = 8;
const PG = 1;
const model = (id: number, images: { id: number; nsfwLevel: number }[]) => ({
  id,
  type: 'Checkpoint',
  images,
  versions: [{ id: id * 10, baseModel: 'SDXL 1.0', canGenerate: true }],
});
const WINNER = 1;
const GRID_MODEL = model(2, [{ id: 20, nsfwLevel: PG }]);

function renderPodium(winnerImages: { id: number; nsfwLevel: number }[]) {
  state.items = [model(WINNER, winnerImages), GRID_MODEL];
  state.gridItems = [GRID_MODEL];
  state.featured = [{ modelId: WINNER, type: 'Checkpoint', baseModel: 'SDXL 1.0', position: 1 }];
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(createElement(ResourceHitList, { query: '' })));
  const card = container.querySelector(`[data-card="${WINNER}"]`);
  act(() => root.unmount());
  return card;
}

beforeEach(() => {
  state.browsingLevel = PG;
});

describe('ResourceHitList featured podium', () => {
  it('skips a winner image above the viewer browsing level', () => {
    const card = renderPodium([
      { id: 11, nsfwLevel: X },
      { id: 12, nsfwLevel: PG },
    ]);
    expect(card?.getAttribute('data-image')).toBe('12');
  });

  it('drops a winner with no image within the viewer browsing level', () => {
    expect(renderPodium([{ id: 11, nsfwLevel: X }])).toBeNull();
  });

  it('keeps showcase order for a viewer whose level admits the first image', () => {
    state.browsingLevel = PG | X;
    const card = renderPodium([
      { id: 11, nsfwLevel: X },
      { id: 12, nsfwLevel: PG },
    ]);
    expect(card?.getAttribute('data-image')).toBe('11');
  });
});
