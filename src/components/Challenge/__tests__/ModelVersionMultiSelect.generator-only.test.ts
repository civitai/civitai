// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as HiddenPreferences from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import type { ResourceSelectModalProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';

// Challenge entries are made in the generator, so the picker lists generator-eligible models only.
// It opens with selectSource 'generation', which already refuses an ineligible pick on click, so
// showing those models offered choices that could not be taken.

const state = vi.hoisted(() => ({
  opened: [] as unknown[],
  queryInputs: [] as Record<string, unknown>[],
  items: [] as unknown[],
}));

vi.mock('~/components/Dialog/triggers/resource-select', () => ({
  openResourceSelectModal: (props: unknown) => state.opened.push(props),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: {
    modelVersion: { getVersionsByIds: { useQuery: () => ({ data: undefined, isLoading: false }) } },
    model: {
      getFeaturedModels: { useQuery: () => ({ data: [] }) },
      getResourceSelect: {
        useInfiniteQuery: (input: Record<string, unknown>) => {
          state.queryInputs.push(input);
          return {
            data: { pages: [{ items: state.items, nextCursor: undefined }] },
            isLoading: false,
            isFetching: false,
            isFetchingNextPage: false,
            fetchNextPage: vi.fn(),
            hasNextPage: false,
            isError: false,
            refetch: vi.fn(),
          };
        },
      },
    },
  },
}));
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ onClose: vi.fn() }),
}));
vi.mock('~/components/UserSettings/hooks', () => ({
  useCurrentUserSettings: () => ({ generation: { advancedMode: false } }),
}));
vi.mock('~/components/Filters/useSortAvailability', () => ({
  useSortAvailability: () => ({ isModerator: false, canViewNsfw: true, showNsfw: true }),
}));
vi.mock('~/components/ImageGeneration/utils/generationRequestHooks', () => ({
  useGetTextToImageRequests: () => ({ data: undefined }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', async (importOriginal) => ({
  ...(await importOriginal<typeof HiddenPreferences>()),
  useApplyHiddenPreferences: ({ data }: { data: unknown[] }) => ({
    items: data,
    loadingPreferences: false,
    hiddenCount: 0,
  }),
}));
vi.mock('~/components/HiddenPreferences/HiddenPreferencesProvider', () => ({
  useHiddenPreferencesContext: () => ({}),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ canViewNsfw: true }),
}));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', () => ({
  useBrowsingSettingsAddons: () => ({ settings: { disablePoi: false, disableMinor: false } }),
}));
vi.mock(
  '~/components/ImageGeneration/GenerationForm/ResourceSelectModal/ResourceSelectCard',
  () => ({
    ResourceSelectCard: ({ data }: { data: { id: number; versions: { id: number }[] } }) =>
      createElement('div', {
        'data-card': data.id,
        'data-versions': data.versions.map((v) => v.id).join(','),
      }),
  })
);
vi.mock('~/components/MasonryColumns/MasonryColumnsVirtual', () => ({
  MasonryColumnsVirtual: ({
    data,
    render,
  }: {
    data: { id: number }[];
    render: (args: { data: unknown; height: number }) => unknown;
  }) =>
    createElement(
      'div',
      null,
      data.map((d) => createElement('div', { key: d.id }, render({ data: d, height: 100 })))
    ),
}));
vi.mock('~/components/MasonryColumns/MasonryProvider', () => ({
  MasonryProvider: ({ children }: { children: unknown }) => children,
}));

import { ModelVersionMultiSelect } from '~/components/Challenge/ModelVersionMultiSelect';
import { ResourceHitList } from '~/components/ImageGeneration/GenerationForm/ResourceSelectModal/ResourceHitList';
import { ResourceSelectProvider } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ELIGIBLE_MODEL = 1;
const MIXED_MODEL = 2;
const INELIGIBLE_MODEL = 3;
const model = (id: number, versions: { id: number; canGenerate: boolean }[]) => ({
  id,
  type: 'Checkpoint',
  name: `Model ${id}`,
  nsfw: false,
  nsfwLevel: 1,
  user: { id: 900 + id },
  tags: [],
  images: [],
  versions: versions.map((v) => ({ ...v, baseModel: 'SDXL 1.0' })),
});

function openChallengePicker() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(MantineProvider, null, createElement(ModelVersionMultiSelect, { value: [] }))
    )
  );
  const button = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Add Resource')
  );
  if (!button) throw new Error('Add Resource button not rendered');
  act(() => button.click());
  act(() => root.unmount());
  container.remove();
  expect(state.opened).toHaveLength(1);
  return state.opened[0] as ResourceSelectModalProps;
}

function renderPickerGrid(props: ResourceSelectModalProps) {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(
        MantineProvider,
        null,
        createElement(ResourceSelectProvider, props, createElement(ResourceHitList, { query: '' }))
      )
    )
  );
  const cards = [...container.querySelectorAll('[data-card]')].map((el) => ({
    id: Number(el.getAttribute('data-card')),
    versions: el.getAttribute('data-versions'),
  }));
  act(() => root.unmount());
  return cards;
}

beforeEach(() => {
  localStorage.clear();
  state.opened = [];
  state.queryInputs = [];
  state.items = [
    model(ELIGIBLE_MODEL, [{ id: 10, canGenerate: true }]),
    model(MIXED_MODEL, [
      { id: 20, canGenerate: true },
      { id: 21, canGenerate: false },
    ]),
    model(INELIGIBLE_MODEL, [{ id: 30, canGenerate: false }]),
  ];
});

describe('challenge model picker shows generator-eligible models only', () => {
  it('asks the resource search for canGenerate models', () => {
    renderPickerGrid(openChallengePicker());

    expect(state.queryInputs.length).toBeGreaterThan(0);
    expect(state.queryInputs.map((input) => input.canGenerate)).toEqual(
      state.queryInputs.map(() => true)
    );
  });

  it('drops a model with no eligible version, and the ineligible versions of a mixed one', () => {
    const cards = renderPickerGrid(openChallengePicker());

    expect(cards).toEqual([
      { id: ELIGIBLE_MODEL, versions: '10' },
      { id: MIXED_MODEL, versions: '20' },
    ]);
  });
});
