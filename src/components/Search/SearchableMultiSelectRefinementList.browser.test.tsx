import { act, useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as InstantSearch from 'react-instantsearch';

type Item = { label: string; value: string; isRefined: boolean; count: number };

const mocks = vi.hoisted(() => ({
  loaded: [] as Array<{ label: string; value: string; isRefined: boolean; count: number }>,
  remoteResult: [] as Array<{ label: string; value: string; isRefined: boolean; count: number }>,
  searchForItems: vi.fn(),
  refine: vi.fn(),
  swapItems: null as null | ((items: Array<Item>) => void),
}));

// Mirrors instantsearch: a non-empty searchForItems replaces items with the facet result.
vi.mock('react-instantsearch', async (importOriginal) => ({
  ...(await importOriginal<typeof InstantSearch>()),
  useRefinementList: () => {
    const [items, setItems] = useState(mocks.loaded);
    mocks.swapItems = setItems;
    return {
      items,
      refine: mocks.refine,
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
  mocks.refine.mockClear();
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
    // Outlast the 300ms debounce so a remote search would have fired by now.
    await new Promise((resolve) => setTimeout(resolve, 500));
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

  describe('remote search on', () => {
    const renderUsers = () =>
      renderWithProviders(
        <SearchableMultiSelectRefinementList title="Users" attribute="user.username" searchable />
      );
    const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

    test('a substring match survives a remote miss', async () => {
      mocks.loaded = toItems(['alexds9', 'RisingV']);
      renderUsers();
      await page.getByPlaceholder('Search Users').fill('ingV');
      await vi.waitFor(() => expect(mocks.searchForItems).toHaveBeenCalledWith('ingV'));
      await settle();
      await expect.element(page.getByRole('option', { name: 'RisingV' })).toBeInTheDocument();
      // The match came from the loaded list, so selecting it must still refine.
      await page.getByRole('option', { name: 'RisingV' }).click();
      expect(mocks.refine).toHaveBeenCalledWith('RisingV');
    });

    test('a remote-only hit is added to the loaded matches', async () => {
      mocks.loaded = toItems(['RisingV']);
      mocks.remoteResult = toItems(['risingneko205']);
      renderUsers();
      await page.getByPlaceholder('Search Users').fill('risin');
      await expect.element(page.getByRole('option', { name: 'risingneko205' })).toBeInTheDocument();
      await expect.element(page.getByRole('option', { name: 'RisingV' })).toBeInTheDocument();
    });

    test('options that left the facet list while idle are not offered', async () => {
      mocks.loaded = toItems(['alpha', 'beta']);
      renderUsers();
      await page.getByPlaceholder('Search Users').click();
      await expect.element(page.getByRole('option', { name: 'alpha' })).toBeInTheDocument();
      // Another refinement narrows the facet list while the box is empty.
      await act(async () => mocks.swapItems!(toItems(['gamma'])));
      await expect.element(page.getByRole('option', { name: 'gamma' })).toBeInTheDocument();
      await page.getByPlaceholder('Search Users').fill('alpha');
      await vi.waitFor(() => expect(mocks.searchForItems).toHaveBeenCalledWith('alpha'));
      await settle();
      await expect.element(page.getByRole('option', { name: 'alpha' })).not.toBeInTheDocument();
      // The dropdown is still working: the current list still matches.
      await page.getByPlaceholder('Search Users').fill('gam');
      await expect.element(page.getByRole('option', { name: 'gamma' })).toBeInTheDocument();
    });
  });
});
