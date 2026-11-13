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
// The module builds a client at IMPORT time; faked so it can never send.
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
  // Every flag on except image search, which tests set. `feedSearch` offers images on its own, so
  // "image search off" is both flags off.
  const imageSearchFlags = new Set<string | symbol>(['imageSearch', 'feedSearch']);
  return {
    ...actual,
    useFeatureFlags: () =>
      new Proxy({}, { get: (_, key) => (imageSearchFlags.has(key) ? state.imageSearch : true) }),
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

beforeEach(() => {
  state.pathname = '/images';
  state.imageSearch = false;
  state.provider = [];
});

const selectedCategory = () => page.getByRole('textbox', { name: 'Search category' });

describe('AutocompleteSearch — default target on /images', () => {
  test('defaults to Models while image search is off', async () => {
    renderWithProviders(<AutocompleteSearch />);

    await expect.element(selectedCategory()).toHaveValue('Models');
    await vi.waitFor(() => expect(state.provider.at(-1)?.indexName).toBe('models_v9'));
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

  test('starts on Models while image search is off', async () => {
    render(['images', 'models']);

    await expect.element(selector()).toHaveValue('Models');
    await vi.waitFor(() => expect(state.provider.at(-1)?.indexName).toBe('models_v9'));
  });

  test('keeps Images while image search is on', async () => {
    state.imageSearch = true;
    render(['images', 'models']);

    await expect.element(selector()).toHaveValue('Images');
    await vi.waitFor(() => expect(state.provider.at(-1)?.indexName).toBe('images_v6'));
  });
});

// With image search off, the selector must not OFFER Images at all. The control is the same render
// with it on: if Images were missing there too, the option query would be wired to nothing.
describe('Images option while image search is off', () => {
  test('AutocompleteSearch offers no Images option', async () => {
    renderWithProviders(<AutocompleteSearch />);

    await expect.element(selectedCategory()).toHaveValue('Models');
    await selectedCategory().click();
    await expect.element(page.getByRole('option', { name: 'Models' })).toBeInTheDocument();
    expect(page.getByRole('option', { name: 'Images' }).elements()).toHaveLength(0);
  });

  test('QuickSearchDropdown offers no Images option', async () => {
    renderWithProviders(
      <QuickSearchDropdown
        supportedIndexes={['models', 'images']}
        startingIndex="models"
        onItemSelected={() => undefined}
      />
    );

    await page.getByRole('textbox').click();
    await expect.element(page.getByRole('option', { name: 'Models' })).toBeInTheDocument();
    expect(page.getByRole('option', { name: 'Images' }).elements()).toHaveLength(0);
  });

  test('control: with image search on, AutocompleteSearch offers Images', async () => {
    state.imageSearch = true;
    renderWithProviders(<AutocompleteSearch />);
    await selectedCategory().click();
    await expect.element(page.getByRole('option', { name: 'Images' })).toBeInTheDocument();
    expect(page.getByRole('option', { name: 'Images' }).elements()).toHaveLength(1);
  });

  test('control: with image search on, QuickSearchDropdown offers Images', async () => {
    state.imageSearch = true;
    renderWithProviders(
      <QuickSearchDropdown
        supportedIndexes={['models', 'images']}
        startingIndex="models"
        onItemSelected={() => undefined}
      />
    );
    await page.getByRole('textbox').click();
    await expect.element(page.getByRole('option', { name: 'Images' })).toBeInTheDocument();
    expect(page.getByRole('option', { name: 'Images' }).elements()).toHaveLength(1);
  });
});
