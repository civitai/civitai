// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';

/**
 * Which callers of `orchestrator.queryGeneratedImages` ask for App Block runs to be left out: the
 * generator Queue/Feed and the queue counter do, the image pickers do not.
 */

const mocks = vi.hoisted(() => ({ useInfiniteQuery: vi.fn() }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  // `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
  const { makeTrpcProxy } = await import('../../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'orchestrator.queryGeneratedImages': {
        useInfiniteQuery: (...args: unknown[]) => mocks.useInfiniteQuery(...args),
        _def: () => ({ path: ['orchestrator', 'queryGeneratedImages'] }),
      },
    }),
  };
});
vi.mock('~/providers/FiltersProvider', () => ({
  useFiltersContext: (selector: (state: { generation: unknown }) => unknown) =>
    selector({ generation: {} }),
}));
vi.mock('~/providers/AppProvider', () => ({ useAppContext: () => ({ domain: {} }) }));
vi.mock('~/providers/BrowserSettingsProvider', () => ({ useBrowsingSettings: () => true }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/components/Signals/signals-registry.store', () => ({ registerSignalGroup: vi.fn() }));
vi.mock('~/components/ImageGeneration/utils/unratedOutputRefetch', () => ({
  watchUnratedOutputs: vi.fn(),
}));
vi.mock('~/components/ImageGeneration/GenerationForm/generation.utils', () => ({
  useGenerationStatus: () => ({ available: true, limits: { queue: 4 } }),
}));

const { GeneratedRequestsProvider } = await import(
  '~/components/ImageGeneration/GeneratedRequestsProvider'
);
const { GenerationProvider } = await import('~/components/ImageGeneration/GenerationProvider');
const { useGetTextToImageRequests } = await import(
  '~/components/ImageGeneration/utils/generationRequestHooks'
);
const { useGenerationPanelStore } = await import('~/store/generation-panel.store');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function queriedInput(element: ReturnType<typeof createElement>) {
  mocks.useInfiniteQuery.mockReturnValue({ data: undefined });
  const root = createRoot(document.createElement('div'));
  act(() => root.render(element));
  act(() => root.unmount());
  expect(mocks.useInfiniteQuery).toHaveBeenCalled();
  return mocks.useInfiniteQuery.mock.calls[0][0] as Record<string, unknown>;
}

describe('which generated-image queries leave App Block runs out', () => {
  beforeEach(() => mocks.useInfiniteQuery.mockReset());

  it('the Queue and Feed query does', () => {
    expect(queriedInput(createElement(GeneratedRequestsProvider, null, null))).toMatchObject({
      excludeAppWorkflows: true,
    });
  });

  it('the queue counter does', () => {
    useGenerationPanelStore.setState({ opened: true });
    expect(queriedInput(createElement(GenerationProvider, null, null))).toMatchObject({
      excludeAppWorkflows: true,
    });
  });

  it('CONTROL: an image picker query does not', () => {
    function Picker() {
      useGetTextToImageRequests({ tags: ['img'] }, { enabled: true, ignoreFilters: true });
      return null;
    }
    expect(queriedInput(createElement(Picker))).not.toHaveProperty('excludeAppWorkflows');
  });
});
