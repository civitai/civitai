// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import { ChallengeStatus } from '~/shared/utils/prisma/enums';

/**
 * The /challenges feed asks semantic search only for a query with the flag on and a status filter
 * search can answer (Cancelled challenges are not indexed), and falls back to the feed's own query
 * when the search errors.
 */
type Call = { input: Record<string, unknown>; opts: { enabled: boolean } };
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
  useApplyHiddenPreferences: ({ data }: { data: unknown[] }) => ({
    items: data,
    loadingPreferences: false,
  }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const query =
    (key: 'semantic' | 'feed') => (input: Record<string, unknown>, opts: { enabled: boolean }) => {
      state[key] = { input, opts };
      return { isLoading: false, isRefetching: false, ...state[`${key}Result`] };
    };
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    // eslint-disable-next-line local-rules/no-hand-enumerated-trpc-mock -- the hook's two calls are the routing under test; the stubs record what each was asked and whether it was enabled
    trpc: {
      semanticChallengeSearch: { search: { useInfiniteQuery: query('semantic') } },
      challenge: { getInfinite: { useInfiniteQuery: query('feed') } },
    },
  };
});

const { useQueryChallenges } = await import('~/components/Challenge/challenge.utils');

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

describe('useQueryChallenges routing', () => {
  beforeEach(() => {
    state.features = { semanticChallengeSearch: true };
    state.semanticResult = { data: page(SEARCH_HIT) };
    state.feedResult = { data: page(FEED_ROW) };
  });

  it('answers a query from semantic search when the flag is on', () => {
    const result = renderHook(() => useQueryChallenges({ query: 'dragons' }));
    expect(state.semantic.opts.enabled).toBe(true);
    expect(state.feed.opts.enabled).toBe(false);
    expect(result.current.challenges).toEqual([{ id: SEARCH_HIT }]);
  });

  it('never calls semantic search with the flag off', () => {
    state.features = {};
    const result = renderHook(() => useQueryChallenges({ query: 'dragons' }));
    expect(state.semantic.opts.enabled).toBe(false);
    expect(state.feed.opts.enabled).toBe(true);
    expect(result.current.challenges).toEqual([{ id: FEED_ROW }]);
  });

  it('leaves a Cancelled-only filter to the feed', () => {
    const result = renderHook(() =>
      useQueryChallenges({ query: 'dragons', status: [ChallengeStatus.Cancelled] })
    );
    expect(state.semantic.opts.enabled).toBe(false);
    expect(state.feed.opts.enabled).toBe(true);
    expect(result.current.challenges).toEqual([{ id: FEED_ROW }]);
  });

  it('never sends Cancelled to semantic search', () => {
    renderHook(() =>
      useQueryChallenges({
        query: 'dragons',
        status: [ChallengeStatus.Active, ChallengeStatus.Cancelled],
      })
    );
    expect(state.semantic.opts.enabled).toBe(true);
    expect(state.semantic.input.status).toEqual([ChallengeStatus.Active]);
  });

  it('falls back to the feed when semantic search errors', () => {
    state.semanticResult = { isError: true };
    const result = renderHook(() => useQueryChallenges({ query: 'dragons' }));
    expect(state.feed.opts.enabled).toBe(true);
    expect(result.current.challenges).toEqual([{ id: FEED_ROW }]);
  });
});
