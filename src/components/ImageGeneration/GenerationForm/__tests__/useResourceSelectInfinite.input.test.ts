// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

/**
 * 🔴 The single wire between the chip and the query.
 *
 * `toResourceSelectFilterInput` is unit-tested key by key, but nothing asserted the HOOK calls it —
 * so inlining the fields back (a plausible tidy-up, or a merge resolving the spread away) dropped
 * `hidePaid` with all 53 tests green. The regression is invisible in production: the chip renders,
 * the filter count increments, "Clear all" appears, and the server is never told. And because the
 * filter is fail-open, "does nothing" looks exactly like "the backfill missed these models".
 *
 * So this asserts the input the tRPC query actually receives, not the helper's shape.
 */

const useInfiniteQuery = vi.fn();
const filters = {
  types: ['LORA'],
  baseModels: ['SDXL 1.0'],
  hidePaid: true,
};

vi.mock('~/utils/trpc', () => ({
  trpc: {
    model: { getResourceSelect: { useInfiniteQuery: (...a: unknown[]) => useInfiniteQuery(...a) } },
  },
  queryRetry: () => false,
}));

vi.mock('~/components/ImageGeneration/GenerationForm/ResourceSelectProvider', () => ({
  useResourceSelectContext: () => ({
    tab: 'all',
    sort: 'relevance',
    selectSource: 'generation',
    resources: [{ type: 'LORA', baseModels: ['SDXL 1.0'] }],
    filters,
    canGenerate: undefined,
    excludedIds: [],
    categoryTag: undefined,
  }),
}));

vi.mock('~/components/ImageGeneration/utils/generationRequestHooks', () => ({
  useGetTextToImageRequests: () => ({ data: undefined }),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

const { useResourceSelectInfinite } = await import(
  '~/components/ImageGeneration/GenerationForm/ResourceSelectModal/useResourceSelectInfinite'
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderHook() {
  useInfiniteQuery.mockReturnValue({ data: undefined });
  function Probe() {
    useResourceSelectInfinite({ query: '' });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe)));
  act(() => root.unmount());
  expect(useInfiniteQuery).toHaveBeenCalled();
  return useInfiniteQuery.mock.calls[0][0] as Record<string, unknown>;
}

describe('useResourceSelectInfinite — the tRPC input', () => {
  it('forwards hidePaid from the picker filters', () => {
    expect(renderHook()).toMatchObject({ hidePaid: true });
  });

  it('forwards the other filter axes too, so the mapping is not partially wired', () => {
    expect(renderHook()).toMatchObject({
      filterTypes: ['LORA'],
      filterBaseModels: ['SDXL 1.0'],
    });
  });
});
