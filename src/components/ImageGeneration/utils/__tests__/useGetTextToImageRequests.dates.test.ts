// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GenerationRequestHooks from '~/components/ImageGeneration/utils/generationRequestHooks';
import type * as Trpc from '~/utils/trpc';
import { queryClient } from '~/utils/trpc';

/**
 * The date bounds `useGetTextToImageRequests` hands the tRPC query. The App Blocks image picker
 * passes `ignoreFilters` and its own `toDate` ("jump to date"); that `toDate` must reach the query.
 */

const mocks = vi.hoisted(() => ({
  useInfiniteQuery: vi.fn(),
  generateMutation: vi.fn(),
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
        // The cache helpers find this procedure's lists by its path.
        _def: () => ({ path: ['orchestrator', 'queryGeneratedImages'] }),
      },
      'orchestrator.generateFromGraph': {
        useMutation: (options: unknown) => mocks.generateMutation(options),
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
  watchUnratedOutputs: vi.fn(),
}));

const { useGenerateFromGraph, useGetTextToImageRequests } = (await import(
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
  it("prefers the queue's toDate over a caller's when the queue's filters are not ignored", () => {
    const input = queriedInput({ toDate: PICKED }, { enabled: true });
    expect(input.toDate).toBe(QUEUE_TO);
  });

  // Invariant guard.
  it("uses the queue's own date filter when it is not ignored", () => {
    const input = queriedInput({}, { enabled: true });
    expect(input.toDate).toBe(QUEUE_TO);
    expect(input.fromDate).toBe(QUEUE_FROM);
  });
});

describe('useGenerateFromGraph — a submitted workflow and the cached lists', () => {
  const LISTS = ['orchestrator', 'queryGeneratedImages'];
  const keyFor = (input: Record<string, unknown>) => [LISTS, { input, type: 'infinite' }];
  const list = (...ids: string[]) => ({
    pages: [{ items: ids.map((id) => ({ id })), nextCursor: undefined }],
    pageParams: [undefined],
  });
  const ids = (input: Record<string, unknown>) =>
    (
      queryClient.getQueryData(keyFor(input)) as { pages: Array<{ items: Array<{ id: string }> }> }
    ).pages[0].items.map((item) => item.id);

  function submit(workflow: { id: string; createdAt?: Date }) {
    mocks.generateMutation.mockImplementation((options) => options);
    let options: { onSuccess: (data: unknown) => void } | undefined;
    function Probe() {
      options = useGenerateFromGraph() as unknown as typeof options;
      return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Probe)));
    act(() => root.unmount());
    options?.onSuccess(workflow);
  }

  beforeEach(() => queryClient.clear());

  // Regression: red before the fix, which put the new workflow at the top of EVERY newest-first
  // list, including one that ends on or before a past date.
  it('leaves a list bounded by toDate alone, and still adds to the unbounded ones', () => {
    const bounded = { tags: ['img'], ascending: false, toDate: new Date(2024, 5, 30, 23, 59) };
    const unbounded = { tags: ['img'], ascending: false };
    const oldestFirstBounded = { tags: ['img'], ascending: true, toDate: new Date(2024, 5, 30) };
    const oldestFirst = { tags: ['img'], ascending: true };
    queryClient.setQueryData(keyFor(bounded), list('old-1'));
    queryClient.setQueryData(keyFor(unbounded), list('old-2'));
    queryClient.setQueryData(keyFor(oldestFirstBounded), list('old-3'));
    queryClient.setQueryData(keyFor(oldestFirst), list('old-4'));

    submit({ id: 'new' });

    expect(ids(bounded)).toEqual(['old-1']);
    expect(ids(unbounded)).toEqual(['new', 'old-2']);
    expect(ids(oldestFirstBounded)).toEqual(['old-3']);
    expect(ids(oldestFirst)).toEqual(['old-4', 'new']);
  });

  // Regression: red at 9987a920, which skipped every list with a toDate. The queue's own "To"
  // filter can be today or later, and such a list includes a workflow created now.
  it('adds to a list whose toDate is not before the workflow was created, in both orders', () => {
    const createdAt = new Date();
    const later = new Date(createdAt.getTime() + 24 * 3600_000);
    const sameInstant = new Date(createdAt.getTime());
    const newestFirst = { tags: ['img'], ascending: false, toDate: later };
    const atCreation = {
      tags: ['img'],
      ascending: false,
      toDate: sameInstant,
      excludeFailed: true,
    };
    const oldestFirst = { tags: ['img'], ascending: true, toDate: later };
    queryClient.setQueryData(keyFor(newestFirst), list('old-6'));
    queryClient.setQueryData(keyFor(atCreation), list('old-7'));
    queryClient.setQueryData(keyFor(oldestFirst), list('old-8'));

    submit({ id: 'new', createdAt });

    expect(ids(newestFirst)).toEqual(['new', 'old-6']);
    expect(ids(atCreation)).toEqual(['new', 'old-7']);
    expect(ids(oldestFirst)).toEqual(['old-8', 'new']);
  });

  // Invariant guard: a list with only a start date still takes a workflow submitted now.
  it('still adds to a newest-first list bounded only by fromDate', () => {
    const fromOnly = { tags: ['img'], ascending: false, fromDate: new Date(2024, 0, 1) };
    queryClient.setQueryData(keyFor(fromOnly), list('old-5'));

    submit({ id: 'new' });

    expect(ids(fromOnly)).toEqual(['new', 'old-5']);
  });
});
