import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as InstantSearch from 'react-instantsearch';

type Item = { label: string; value: string; isRefined: boolean; count: number };

const mocks = vi.hoisted(() => ({
  loaded: [] as Array<{ label: string; value: string; isRefined: boolean; count: number }>,
  // What the remote facet search answers with, whatever was typed.
  remoteResult: [] as Array<{ label: string; value: string; isRefined: boolean; count: number }>,
  searchForItems: vi.fn(),
}));

// Behaves like instantsearch: `searchForItems` swaps `items` for the facet search result.
vi.mock('react-instantsearch', async (importOriginal) => ({
  ...(await importOriginal<typeof InstantSearch>()),
  useRefinementList: () => {
    const [items, setItems] = useState(mocks.loaded);
    return {
      items,
      refine: vi.fn(),
      searchForItems: (query: string) => {
        mocks.searchForItems(query);
        if (query) setItems(mocks.remoteResult);
      },
    };
  },
}));

const { SearchableMultiSelectRefinementList } = await import('./CustomSearchComponents');

const toItems = (values: string[]): Item[] =>
  values.map((value) => ({ label: value, value, isRefined: false, count: 1 }));

beforeEach(() => {
  mocks.loaded = toItems(['Flux.1 D', 'MiniMax H3', 'SDXL 1.0']);
  mocks.remoteResult = [];
  mocks.searchForItems.mockClear();
});

describe('SearchableMultiSelectRefinementList', () => {
  test('with remoteSearch off, a match survives an empty facet search', async () => {
    renderWithProviders(
      <SearchableMultiSelectRefinementList
        title="Filter by Base Model"
        attribute="versions.baseModel"
        remoteSearch={false}
        searchable
      />
    );
    const input = page.getByPlaceholder('Search Filter by Base Model');
    await input.fill('h3');
    // Past the 300ms debounce, where the remote result used to replace the options.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect.element(page.getByRole('option', { name: 'MiniMax H3' })).toBeInTheDocument();
    expect(mocks.searchForItems).not.toHaveBeenCalledWith('h3');
  });

  test('by default the facet search still runs after the debounce', async () => {
    mocks.remoteResult = toItems(['alice_art']);
    renderWithProviders(
      <SearchableMultiSelectRefinementList
        title="Filter by User"
        attribute="user.username"
        searchable
      />
    );
    await page.getByPlaceholder('Search Filter by User').fill('ali');
    await vi.waitFor(() => expect(mocks.searchForItems).toHaveBeenCalledWith('ali'));
    await expect.element(page.getByRole('option', { name: 'alice_art' })).toBeInTheDocument();
  });
});
