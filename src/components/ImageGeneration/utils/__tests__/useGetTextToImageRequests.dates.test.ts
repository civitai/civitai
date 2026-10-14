// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GenerationRequestHooks from '~/components/ImageGeneration/utils/generationRequestHooks';
import type * as Trpc from '~/utils/trpc';

/**
 * The date bounds `useGetTextToImageRequests` hands the tRPC query. The App Blocks image picker
 * passes `ignoreFilters` and its own `toDate` ("jump to date"); that `toDate` must reach the query.
 */

const mocks = vi.hoisted(() => ({
  useInfiniteQuery: vi.fn(),
  filters: {} as { fromDate?: Date; toDate?: Date; sort?: string },
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  // `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
  const { makeTrpcProxy } = await import('../../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'orchestrator.queryGeneratedImages': {
        useInfiniteQuery: (...args: unknown[]) => mocks.useInfiniteQuery(...args),
      },
    }),
  };
});

vi.mock('~/providers/FiltersProvider', () => ({
  useFiltersContext: (selector: (state: { generation: unknown }) => unknown) =>
    selector({ generation: mocks.filters }),
}));
vi.mock('~/providers/AppProvider', () => ({ useAppContext: () => ({ domain: {} }) }));
vi.mock('~/providers/BrowserSettingsProvider', () => ({ useBrowsingSettings: () => true }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/components/Signals/signals-registry.store', () => ({ registerSignalGroup: vi.fn() }));
vi.mock('~/components/ImageGeneration/utils/unratedOutputRefetch', () => ({
  scheduleUnratedRefetch: vi.fn(),
}));

const { useGetTextToImageRequests } = (await import(
  '~/components/ImageGeneration/utils/generationRequestHooks'
)) as typeof GenerationRequestHooks;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function queriedInput(...args: Parameters<typeof useGetTextToImageRequests>) {
  mocks.useInfiniteQuery.mockReturnValue({ data: undefined });
  function Probe() {
    useGetTextToImageRequests(...args);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe)));
  act(() => root.unmount());
  expect(mocks.useInfiniteQuery).toHaveBeenCalled();
  return mocks.useInfiniteQuery.mock.calls[0][0] as Record<string, unknown>;
}

const PICKED = new Date(2025, 2, 15, 23, 59, 59, 999);
const QUEUE_TO = new Date(2024, 0, 1);
const QUEUE_FROM = new Date(2023, 0, 1);

describe('useGetTextToImageRequests — date bounds reaching the query', () => {
  beforeEach(() => {
    mocks.useInfiniteQuery.mockReset();
    mocks.filters = { fromDate: QUEUE_FROM, toDate: QUEUE_TO };
  });

  // Regression: red at origin/main, where the queue filter's (here ignored, so undefined) dates
  // were written over the caller's.
  it("keeps a caller's own toDate when the queue's filters are ignored", () => {
    const input = queriedInput({ toDate: PICKED }, { enabled: true, ignoreFilters: true });
    expect(input.toDate).toBe(PICKED);
    expect(input.fromDate).toBeUndefined();
  });

  // Invariant guard.
  it('sends no bound when neither the caller nor the queue has one', () => {
    mocks.filters = {};
    const input = queriedInput({}, { enabled: true });
    expect(input.toDate).toBeUndefined();
    expect(input.fromDate).toBeUndefined();
  });

  // Invariant guard.
  it("uses the queue's own date filter when it is not ignored", () => {
    const input = queriedInput({}, { enabled: true });
    expect(input.toDate).toBe(QUEUE_TO);
    expect(input.fromDate).toBe(QUEUE_FROM);
  });

  it("prefers the queue's date filter over a caller's when both are set", () => {
    const input = queriedInput(
      { toDate: PICKED, fromDate: new Date(2020, 0, 1) },
      { enabled: true }
    );
    expect(input.toDate).toBe(QUEUE_TO);
    expect(input.fromDate).toBe(QUEUE_FROM);
  });
});
