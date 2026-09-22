// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as HiddenPreferences from '~/components/HiddenPreferences/useApplyHiddenPreferences';

const state = vi.hoisted(() => ({
  browsingLevel: 1,
  items: [] as unknown[],
  gridItems: [] as unknown[],
  featured: [] as unknown[],
  canViewNsfw: true,
  disablePoi: false,
  systemHiddenTags: new Map<number, boolean>(),
  hiddenUsers: new Map<number, boolean>(),
  blockedUsers: new Map<number, boolean>(),
  hiddenTags: new Map<number, boolean>(),
  hiddenModels: new Map<number, boolean>(),
  hiddenImages: new Map<number, boolean>(),
}));

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => state.browsingLevel,
}));
// The grid's own filter is stubbed; the podium must reach the REAL `filterPreferences`.
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', async (importOriginal) => ({
  ...(await importOriginal<typeof HiddenPreferences>()),
  useApplyHiddenPreferences: () => ({
    items: state.gridItems,
    loadingPreferences: false,
    hiddenCount: 0,
  }),
}));
vi.mock('~/components/HiddenPreferences/HiddenPreferencesProvider', () => ({
  useHiddenPreferencesContext: () => ({
    hiddenUsers: state.hiddenUsers,
    blockedUsers: state.blockedUsers,
    hiddenTags: state.hiddenTags,
    hiddenModels: state.hiddenModels,
    hiddenModel3Ds: new Map(),
    hiddenImages: state.hiddenImages,
    hiddenLoading: false,
    moderatedTags: [],
    systemHiddenTags: state.systemHiddenTags,
  }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ canViewNsfw: state.canViewNsfw }),
}));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', () => ({
  useBrowsingSettingsAddons: () => ({
    settings: { disablePoi: state.disablePoi, disableMinor: false },
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
type Img = { id: number; nsfwLevel: number; tags?: number[]; poi?: boolean };
const model = (id: number, images: Img[], over: Record<string, unknown> = {}) => ({
  id,
  type: 'Checkpoint',
  name: 'Model',
  nsfw: false,
  nsfwLevel: images.reduce((acc, i) => acc | i.nsfwLevel, 0),
  user: { id: 900 + id },
  tags: [],
  images,
  ...over,
  versions: [{ id: id * 10, baseModel: 'SDXL 1.0', canGenerate: true }],
});
const WINNER = 1;
const GRID_MODEL = model(2, [{ id: 20, nsfwLevel: PG }]);

function renderPodium(winnerImages: Img[], over: Record<string, unknown> = {}) {
  state.items = [model(WINNER, winnerImages, over), GRID_MODEL];
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
  state.canViewNsfw = true;
  state.disablePoi = false;
  state.systemHiddenTags = new Map();
  state.hiddenUsers = new Map();
  state.blockedUsers = new Map();
  state.hiddenTags = new Map();
  state.hiddenModels = new Map();
  state.hiddenImages = new Map();
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

  it('skips a winner image carrying a system-hidden tag', () => {
    state.systemHiddenTags = new Map([[77, true]]);
    const card = renderPodium([
      { id: 11, nsfwLevel: PG, tags: [77] },
      { id: 12, nsfwLevel: PG },
    ]);
    expect(card?.getAttribute('data-image')).toBe('12');
  });

  it('skips a winner POI image when the viewer disabled POI', () => {
    state.disablePoi = true;
    const card = renderPodium([
      { id: 11, nsfwLevel: PG, poi: true },
      { id: 12, nsfwLevel: PG },
    ]);
    expect(card?.getAttribute('data-image')).toBe('12');
  });

  it('drops a winner flagged nsfw where the domain cannot view nsfw', () => {
    state.canViewNsfw = false;
    expect(renderPodium([{ id: 12, nsfwLevel: PG }], { nsfw: true })).toBeNull();
  });

  it('still shows a winner whose creator the viewer has hidden', () => {
    state.hiddenUsers = new Map([[900 + WINNER, true]]);
    expect(renderPodium([{ id: 12, nsfwLevel: PG }])?.getAttribute('data-image')).toBe('12');
  });

  it('still shows a winner whose tag, model or image the viewer has hidden', () => {
    state.hiddenTags = new Map([[55, true]]);
    state.hiddenModels = new Map([[WINNER, true]]);
    state.hiddenImages = new Map([[12, true]]);
    const card = renderPodium([{ id: 12, nsfwLevel: PG, tags: [55] }], { tags: [55] });
    expect(card?.getAttribute('data-image')).toBe('12');
  });

  it('drops a winner whose creator has a block with the viewer', () => {
    state.hiddenUsers = new Map([[900 + WINNER, true]]);
    state.blockedUsers = new Map([[900 + WINNER, true]]);
    expect(renderPodium([{ id: 12, nsfwLevel: PG }])).toBeNull();
  });
});
