import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * 🔴 THE HALF OF THE SCREENING SEAM THAT NOTHING ELSE WATCHES.
 *
 * `AppCollaboratorsPanel` screens the ids this dropdown is offering against the server before
 * offering them. The panel's own test proves it PASSES `onHits`; every other test that touches
 * this component replaces it with a stand-in. So deleting the effect that CALLS `onHits` left
 * the entire suite green while making the panel-side feature completely inert: the id set never
 * populates, the screening query never enables, the picker is never filtered and the selection
 * guard never blocks. No signal anywhere.
 *
 * This mounts the real component with only the search transport stubbed, so the effect itself
 * is exercised.
 */

const HITS = vi.hoisted(() => [
  { id: 8801, username: 'first-candidate', image: null, deletedAt: null, cosmetics: [] },
  { id: 8802, username: 'second-candidate', image: null, deletedAt: null, cosmetics: [] },
]);

// The transport. Nothing here talks to Meilisearch; `useHitsTransformed` is where results would
// have arrived from, so it is the one seam that has to be faked.
// `NEXT_PUBLIC_SEARCH_HOST` is unset in the component environment, and both this module and
// `search.client` build a client from it at IMPORT time — which throws before any test runs.
vi.mock('@meilisearch/instant-meilisearch', () => ({
  instantMeiliSearch: () => ({ search: async () => ({ results: [] }) }),
}));
vi.mock('react-instantsearch', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // The provider is the only piece that would reach a real search transport.
    InstantSearch: (props: any) => props.children,
    useSearchBox: () => ({ query: '', refine: () => undefined, isSearchStalled: false }),
  };
});
vi.mock('~/components/Search/CustomSearchComponents', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, BrowsingLevelFilter: () => null };
});
vi.mock('~/components/Search/search.utils2', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // The REAL index name: the component maps `results.index` back to a render item, and an
    // unrecognised one silently falls back to the MODEL renderer, which then chokes on a
    // user-shaped hit. That fallback is a real code path, so feeding it the wrong name here
    // would be testing the wrong component.
    useHitsTransformed: () => ({ hits: HITS, results: { index: 'users_v3' } }),
  };
});
// The OPTION RENDERER is out of frame — it drags in the session context, avatars and cosmetics,
// none of which this seam is about, and it has its own coverage. Replaced with a marker so the
// dropdown can render its list at all.
vi.mock('~/components/AutocompleteSearch/renderItems/users', async () => {
  const React = await import('react');
  const UserSearchItem = React.forwardRef((props: any, ref: any) =>
    React.createElement('div', { ref, 'data-testid': `option-${props.value}` })
  );
  UserSearchItem.displayName = 'UserSearchItemStub';
  return { UserSearchItem };
});
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  // Every flag on. The index selector is hidden here, so nothing branches on a specific one.
  return { ...actual, useFeatureFlags: () => new Proxy({}, { get: () => true }) };
});
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: ({ data }: { data: unknown[] }) => ({ items: data }),
}));

const { QuickSearchDropdown } = await import('~/components/Search/QuickSearchDropdown');

let reported: number[][];

beforeEach(() => {
  reported = [];
});

const render = (onHits?: (ids: number[]) => void) =>
  renderWithProviders(
    <QuickSearchDropdown
      disableInitialSearch
      supportedIndexes={['users']}
      startingIndex="users"
      showIndexSelect={false}
      dropdownItemLimit={25}
      placeholder="Search"
      onItemSelected={() => undefined}
      onHits={onHits}
    />
  );

describe('QuickSearchDropdown — onHits', () => {
  test('reports the ids currently on offer', async () => {
    render((ids) => reported.push(ids));

    await vi.waitFor(() => expect(reported.length).toBeGreaterThan(0));
    expect(reported.at(-1)).toEqual([8801, 8802]);
  });

  /**
   * The presence/absence pair for the prop being OPTIONAL: a component that only works when the
   * callback is supplied would be caught by the test above, but one that CRASHES without it
   * would not — and nine of the ten call sites do not pass it.
   */
  test('renders fine when no callback is supplied', async () => {
    render(undefined);
    await expect.element(page.getByPlaceholder('Search')).toBeInTheDocument();
    expect(reported).toEqual([]);
  });
});
