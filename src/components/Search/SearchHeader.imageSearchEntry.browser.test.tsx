import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// The /search tabs: the Images tab must disappear when `imageSearchEntry` is off. Only the
// InstantSearch hooks, the search store/layout, the router and the flags are stubbed.

const state = vi.hoisted(() => ({ imageSearchEntry: true }));

vi.mock('react-instantsearch', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useInstantSearch: () => ({ uiState: { models_v9: {} }, status: 'idle' }),
    useSearchBox: () => ({ query: '' }),
    usePagination: () => ({ nbHits: 0 }),
  };
});
vi.mock('~/components/Search/useSearchState', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useSearchStore: (selector: (s: unknown) => unknown) =>
      selector({ setSearchParamsByUiState: () => undefined }),
  };
});
vi.mock('~/components/Search/SearchLayout', () => ({
  useSearchLayout: () => ({ sidebarOpen: false, setSidebarOpen: () => undefined }),
}));
vi.mock('next/router', () => ({ useRouter: () => ({ replace: () => undefined, query: {} }) }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  // Every flag on except `imageSearchEntry`, which each test sets.
  return {
    ...actual,
    useFeatureFlags: () =>
      new Proxy(
        {},
        { get: (_, key) => (key === 'imageSearchEntry' ? state.imageSearchEntry : true) }
      ),
  };
});

const { SearchHeader } = await import('~/components/Search/SearchHeader');

beforeEach(() => {
  state.imageSearchEntry = true;
});

describe('SearchHeader — Images tab', () => {
  test('is hidden while imageSearchEntry is off', async () => {
    state.imageSearchEntry = false;
    renderWithProviders(<SearchHeader />);

    await expect.element(page.getByText('Models', { exact: true })).toBeInTheDocument();
    expect(page.getByText('Images', { exact: true }).elements()).toHaveLength(0);
  });

  // The control: if Images were missing here too, the query above would be wired to nothing.
  test('is shown while imageSearchEntry is on', async () => {
    renderWithProviders(<SearchHeader />);

    await expect.element(page.getByText('Models', { exact: true })).toBeInTheDocument();
    expect(page.getByText('Images', { exact: true }).elements()).toHaveLength(1);
  });
});
