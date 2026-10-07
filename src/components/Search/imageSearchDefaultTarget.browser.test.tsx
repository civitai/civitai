import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { page } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// Only the URL, the flags and the InstantSearch provider are stubbed; the provider is a recorder of
// the index and client it would have been given.

const state = vi.hoisted(() => ({
  pathname: '/images',
  imageSearch: false,
  provider: [] as Array<{ indexName: string; searchClient: unknown }>,
}));

vi.mock('next/navigation', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, usePathname: () => state.pathname };
});
// `NEXT_PUBLIC_SEARCH_HOST` is unset in the component environment, and the module builds a client
// from it at IMPORT time — which throws before any test runs.
vi.mock('@meilisearch/instant-meilisearch', () => ({
  instantMeiliSearch: () => ({ search: async () => ({ results: [] }) }),
}));
vi.mock('react-instantsearch', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // Records what it was handed and renders nothing: the selector under test sits ABOVE it.
    InstantSearch: (props: { indexName: string; searchClient: unknown }) => {
      state.provider.push({ indexName: props.indexName, searchClient: props.searchClient });
      return null;
    },
  };
});
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  // Every flag on except `imageSearch`, which each test sets. `imageSearchEntry` stays on, so
  // Images is still OFFERED by the selector — only the default is under test.
  return {
    ...actual,
    useFeatureFlags: () =>
      new Proxy({}, { get: (_, key) => (key === 'imageSearch' ? state.imageSearch : true) }),
  };
});
// The harness has no tRPC client or session, and the search scope reads both.
vi.mock('~/providers/BrowsingSettingsAddonsProvider', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    BrowsingSettingsAddonsProvider: (props: { children: ReactNode }) => props.children,
    useBrowsingSettingsAddons: () => ({ settings: {} }),
  };
});
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useCurrentUser: () => null };
});

const { AutocompleteSearch } = await import('~/components/AutocompleteSearch/AutocompleteSearch');
const { QuickSearchDropdown } = await import('~/components/Search/QuickSearchDropdown');
const { emptySearchClient } = await import('~/components/Search/emptySearchClient');

beforeEach(() => {
  state.pathname = '/images';
  state.imageSearch = false;
  state.provider = [];
});

const selectedCategory = () => page.getByRole('textbox', { name: 'Search category' });

describe('AutocompleteSearch — default target on /images', () => {
  test('defaults to Models with a real client while image search is off', async () => {
    renderWithProviders(<AutocompleteSearch />);

    await expect.element(selectedCategory()).toHaveValue('Models');
    await vi.waitFor(() => expect(state.provider.length).toBeGreaterThan(0));
    const last = state.provider.at(-1)!;
    expect(last.indexName).toBe('models_v9');
    expect(last.searchClient).not.toBe(emptySearchClient);
  });

  // INVARIANT GUARD (green at the base too): only the DEFAULT moved. An explicit pick of Images
  // still selects it, on the empty client. The notice itself is drawn inside the provider (stubbed
  // out here), gated on that same target, and this change does not touch it.
  test('an explicit pick of Images still selects it, on the empty client', async () => {
    renderWithProviders(<AutocompleteSearch />);
    // No assertion on the starting value: this guard is about the pick, not the default.
    await expect.element(selectedCategory()).toBeInTheDocument();

    await selectedCategory().click();
    await page.getByRole('option', { name: 'Images' }).click();

    await expect.element(selectedCategory()).toHaveValue('Images');
    await vi.waitFor(() => expect(state.provider.at(-1)?.searchClient).toBe(emptySearchClient));
  });

  // The control: same page, image search ON. If this one also read Models, the test above would
  // be measuring something other than the flag.
  test('defaults to Images while image search is on', async () => {
    state.imageSearch = true;
    renderWithProviders(<AutocompleteSearch />);

    await expect.element(selectedCategory()).toHaveValue('Images');
    await vi.waitFor(() => expect(state.provider.at(-1)?.indexName).toBe('images_v6'));
  });
});

describe('QuickSearchDropdown — a caller defaulting to Images', () => {
  const render = (supportedIndexes: Array<'images' | 'models'>) =>
    renderWithProviders(
      <QuickSearchDropdown
        supportedIndexes={supportedIndexes}
        startingIndex="images"
        onItemSelected={() => undefined}
      />
    );
  // The selector is the only textbox: the provider below it renders nothing here.
  const selector = () => page.getByRole('textbox');

  test('starts on Models with a real client while image search is off', async () => {
    render(['images', 'models']);

    await expect.element(selector()).toHaveValue('Models');
    await vi.waitFor(() => expect(state.provider.length).toBeGreaterThan(0));
    const last = state.provider.at(-1)!;
    expect(last.indexName).toBe('models_v9');
    expect(last.searchClient).not.toBe(emptySearchClient);
  });

  // The clamp: a caller that cannot search Models is not moved onto it.
  test('keeps Images when the caller does not support Models', async () => {
    render(['images']);

    await expect.element(selector()).toHaveValue('Images');
    await vi.waitFor(() => expect(state.provider.at(-1)?.searchClient).toBe(emptySearchClient));
  });

  test('keeps Images while image search is on', async () => {
    state.imageSearch = true;
    render(['images', 'models']);

    await expect.element(selector()).toHaveValue('Images');
    await vi.waitFor(() => expect(state.provider.at(-1)?.indexName).toBe('images_v6'));
  });
});
