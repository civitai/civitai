// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The regression guard for the actual fix: `ComicsInfinite` must FETCH at the same
// resolved, domain-capped browsing level that `useApplyHiddenPreferences` re-filters
// at (`useBrowsingLevelDebounced`), NOT the raw saved preference
// (`useBrowsingSettings((s) => s.browsingLevel)`). Reverting to the raw level makes
// the query receive `RAW_SAVED_LEVEL` instead of `DEBOUNCED_LEVEL` → this test fails.
const DEBOUNCED_LEVEL = 3; // domain-capped PG|PG-13 (what the filter uses)
const RAW_SAVED_LEVEL = 31; // uncapped saved preference (all levels) — the old fetch value

const { useInfiniteQuery } = vi.hoisted(() => ({
  useInfiniteQuery: vi.fn(() => ({
    data: undefined,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isRefetching: false,
    isFetching: false,
  })),
}));

// The only importer of '~/utils/trpc' in this test's (heavily-stubbed) module graph is
// ComicsInfinite, which uses solely `trpc.comics.getPublicProjects.useInfiniteQuery`;
// spreading the real tRPC proxy client is neither needed nor safely spreadable here.
// eslint-disable-next-line local-rules/no-wholesale-module-mock -- intentional, see above
vi.mock('~/utils/trpc', () => ({
  trpc: { comics: { getPublicProjects: { useInfiniteQuery } } },
}));

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => DEBOUNCED_LEVEL,
}));

// Inert while the fix stands (comics no longer imports this). It arms the negative
// control: a revert to the raw level would read this DIFFERENT value.
vi.mock('~/providers/BrowserSettingsProvider', () => ({
  useBrowsingSettings: (selector: (s: { browsingLevel: number }) => unknown) =>
    selector({ browsingLevel: RAW_SAVED_LEVEL }),
}));

vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: () => ({ items: [] }),
}));

// Avoid the 500ms debounce timer scheduling under act — return the value immediately.
vi.mock('@mantine/hooks', () => ({
  useDebouncedValue: (v: unknown) => [v, () => undefined],
}));

// Keep the module graph light in node/happy-dom — none of these render with items=[].
vi.mock('~/components/Cards/ComicCard', () => ({ ComicCard: () => null }));
vi.mock('~/components/EndOfFeed/EndOfFeed', () => ({ EndOfFeed: () => null }));
vi.mock('~/components/InView/InViewLoader', () => ({ InViewLoader: () => null }));
vi.mock('~/components/MasonryColumns/MasonryGridVirtual', () => ({
  MasonryGridVirtual: () => null,
}));
vi.mock('~/components/NoContent/NoContent', () => ({ NoContent: () => null }));

import { ComicsInfinite } from '~/components/Comics/ComicsInfinite';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(element: ReturnType<typeof createElement>) {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(element));
  return () => act(() => root.unmount());
}

beforeEach(() => {
  useInfiniteQuery.mockClear();
});

describe('ComicsInfinite — fetches at the domain-capped browsing level, not the raw saved one', () => {
  it('passes useBrowsingLevelDebounced() as browsingLevel to getPublicProjects', () => {
    const unmount = render(createElement(ComicsInfinite, { filters: {} }));

    expect(useInfiniteQuery).toHaveBeenCalled();
    const input = useInfiniteQuery.mock.calls[0][0] as { browsingLevel: number };
    expect(input.browsingLevel).toBe(DEBOUNCED_LEVEL);
    // Explicitly assert it is NOT the uncapped saved level the bug fetched with.
    expect(input.browsingLevel).not.toBe(RAW_SAVED_LEVEL);

    unmount();
  });
});
