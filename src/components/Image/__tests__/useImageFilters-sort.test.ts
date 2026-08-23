// @vitest-environment happy-dom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SortAvailability from '~/components/Filters/sort-availability';

/**
 * Filtering the sort MENU is not the fix — the withheld sort stays selected and
 * stays in the query. This suite covers the query half: what a feed asks the
 * server for, from the store, from a `?sort=` link, and from the schema default.
 *
 * `resolveFeedSort` is left real: mocking it would leave the rule under test
 * unexercised, which is the failure this file exists to prevent.
 */
const state = vi.hoisted(() => ({
  storeFilters: {} as Record<string, unknown>,
  queryParams: {} as Record<string, unknown>,
  availability: { isModerator: false, canViewNsfw: false, showNsfw: false },
}));

vi.mock('~/providers/FiltersProvider', () => ({
  useFiltersContext: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ modelImages: state.storeFilters, images: state.storeFilters }),
}));

vi.mock('~/components/Filters/useSortAvailability', () => ({
  useSortAvailability: () => state.availability,
}));

vi.mock('~/hooks/useZodRouteParams', () => ({
  useZodRouteParams: () => ({ query: state.queryParams }),
}));

import { useImageFilters } from '~/components/Image/image.utils';
import { ImageSort } from '~/server/common/enums';

function renderHook<T>(useCb: () => T) {
  const root = createRoot(document.createElement('div'));
  const ref: { current: T | undefined } = { current: undefined };
  function Probe() {
    ref.current = useCb();
    return null;
  }
  act(() => root.render(React.createElement(Probe)));
  act(() => root.unmount());
  return ref.current as T;
}

beforeEach(() => {
  state.storeFilters = {};
  state.queryParams = {};
  state.availability = { isModerator: false, canViewNsfw: false, showNsfw: false };
});

describe('useImageFilters — the sort the query actually runs on', () => {
  it('replaces a stored sort this viewer is not offered', () => {
    state.storeFilters = { sort: ImageSort.Newest, period: 'AllTime' };

    const filters = renderHook(() => useImageFilters('modelImages'));

    expect(filters.sort).toBe(ImageSort.MostReactions);
    // Nothing else about the filters moved.
    expect(filters.period).toBe('AllTime');
  });

  it('replaces one arriving in the url, which the store never sees', () => {
    state.storeFilters = { sort: ImageSort.MostReactions };
    state.queryParams = { sort: ImageSort.Newest };

    expect(renderHook(() => useImageFilters('images')).sort).toBe(ImageSort.MostReactions);
  });

  it('leaves the viewer their own choice when the menu offers it', () => {
    // The control: without this, a resolver that returned MostReactions for
    // everything would pass both assertions above.
    state.storeFilters = { sort: ImageSort.MostCollected };

    expect(renderHook(() => useImageFilters('modelImages')).sort).toBe(ImageSort.MostCollected);

    state.availability = { isModerator: false, canViewNsfw: true, showNsfw: true };
    state.storeFilters = { sort: ImageSort.Newest };

    expect(renderHook(() => useImageFilters('modelImages')).sort).toBe(ImageSort.Newest);
  });
});

describe('resolveFeedSort is what does it', () => {
  it('is the same rule the sort menu filters its options with', async () => {
    const sortAvailability = await vi.importActual<typeof SortAvailability>(
      '~/components/Filters/sort-availability'
    );

    state.storeFilters = { sort: ImageSort.Newest };
    const filters = renderHook(() => useImageFilters('modelImages'));

    expect(
      sortAvailability.isSortAvailable(
        { type: 'modelImages', value: filters.sort },
        state.availability
      )
    ).toBe(true);
  });
});
