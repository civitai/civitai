// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';

/**
 * The /crucibles feed has no text search of its own: with the flag on, a query is answered by
 * semantic search alone, and nothing else ever shows the feed's unfiltered rows as its results.
 */
type Call = { input: Record<string, unknown>; opts: { enabled: boolean; retry?: boolean } };
type Result = { data?: { pages: { items: { id: number }[] }[] }; isError?: boolean };
const state = vi.hoisted(() => ({
  features: {} as Record<string, boolean>,
  semantic: undefined as unknown as Call,
  feed: undefined as unknown as Call,
  semanticResult: {} as Result,
  feedResult: {} as Result,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => state.features }));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: ({ data }: { data?: unknown[] }) => ({
    items: data ?? [],
    loadingPreferences: false,
  }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const query =
    (key: 'semantic' | 'feed') => (input: Record<string, unknown>, opts: { enabled: boolean }) => {
      state[key] = { input, opts };
      return {
        isLoading: false,
        isRefetching: false,
        ...(opts.enabled ? state[`${key}Result`] : {}),
      };
    };
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    // eslint-disable-next-line local-rules/no-hand-enumerated-trpc-mock -- the hook's two calls are the routing under test; the stubs record what each was asked and whether it was enabled
    trpc: {
      semanticCrucibleSearch: { search: { useInfiniteQuery: query('semantic') } },
      crucible: { getInfinite: { useInfiniteQuery: query('feed') } },
    },
  };
});

const { useQueryCrucibles } = await import('~/components/Crucible/crucible.utils');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderHook<T>(useHook: () => T) {
  const result = { current: undefined as T };
  const root = createRoot(document.createElement('div'));
  const Probe = () => {
    result.current = useHook();
    return null;
  };
  act(() => root.render(createElement(Probe)));
  return result;
}

const page = (id: number) => ({ pages: [{ items: [{ id }] }] });
const SEARCH_HIT = 1;
const FEED_ROW = 2;

describe('useQueryCrucibles routing', () => {
  beforeEach(() => {
    state.features = { semanticCrucibleSearch: true };
    state.semanticResult = { data: page(SEARCH_HIT) };
    state.feedResult = { data: page(FEED_ROW) };
  });

  it('answers a query from semantic search when the flag is on', () => {
    const result = renderHook(() => useQueryCrucibles({ query: 'dragons' }));
    expect(state.semantic.opts.enabled).toBe(true);
    expect(state.feed.opts.enabled).toBe(false);
    expect(result.current.crucibles).toEqual([{ id: SEARCH_HIT }]);
  });

  it('ignores a stray query with the flag off, and never calls semantic search', () => {
    state.features = {};
    const result = renderHook(() => useQueryCrucibles({ query: 'dragons' }));
    expect(state.semantic.opts.enabled).toBe(false);
    expect(state.feed.opts.enabled).toBe(true);
    expect(result.current.crucibles).toEqual([{ id: FEED_ROW }]);
  });

  it('shows nothing for a Cancelled-only filter, which the index cannot answer', () => {
    const result = renderHook(() =>
      useQueryCrucibles({ query: 'dragons', status: [CrucibleStatus.Cancelled] })
    );
    expect(state.semantic.opts.enabled).toBe(false);
    expect(state.feed.opts.enabled).toBe(false);
    expect(result.current.crucibles).toEqual([]);
  });

  it('never sends Cancelled to semantic search', () => {
    renderHook(() =>
      useQueryCrucibles({
        query: 'dragons',
        status: [CrucibleStatus.Active, CrucibleStatus.Cancelled],
      })
    );
    expect(state.semantic.opts.enabled).toBe(true);
    expect(state.semantic.input.status).toEqual([CrucibleStatus.Active]);
  });

  // The feed has no text search to fall back to: a failed search is shown as failed, at once.
  it('reports a failed search as an error, never as unfiltered feed rows', () => {
    state.semanticResult = { isError: true };
    const result = renderHook(() => useQueryCrucibles({ query: 'dragons' }));
    expect(state.semantic.opts.retry).toBe(false);
    expect(state.feed.opts.enabled).toBe(false);
    expect(result.current.isError).toBe(true);
    expect(result.current.crucibles).toEqual([]);
  });
});
