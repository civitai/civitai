import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { page, userEvent } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

const state = vi.hoisted(() => ({
  semanticSearches: [] as unknown[],
  meiliQueries: [] as string[],
  pathname: '/images',
}));

vi.mock('next/navigation', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, usePathname: () => state.pathname };
});
// The module builds a Meili client at IMPORT time; faked so it can never send.
vi.mock('@meilisearch/instant-meilisearch', () => ({
  instantMeiliSearch: () => ({
    search: async (requests: readonly { params?: { query?: string } }[]) => {
      for (const request of requests)
        if (request.params?.query) state.meiliQueries.push(request.params.query);
      return {
        results: requests.map((request) => ({
          hits: [],
          nbHits: 0,
          page: 0,
          nbPages: 0,
          hitsPerPage: 20,
          processingTimeMS: 0,
          query: request.params?.query ?? '',
          params: '',
          exhaustiveNbHits: true,
        })),
      };
    },
  }),
}));
// The semantic image search is the paid call this file guards.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...actual,
    trpc: makeTrpcProxy({}),
    trpcVanilla: new Proxy(actual.trpcVanilla as object, {
      get: (target, key) =>
        key === 'semanticImageSearch'
          ? {
              search: {
                query: async (input: unknown) => {
                  state.semanticSearches.push(input);
                  return { items: [], latencyMs: 0 };
                },
              },
            }
          : Reflect.get(target, key),
    }),
  };
});
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useFeatureFlags: () => new Proxy({}, { get: () => true }) };
});
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
vi.mock('~/components/TrackView/track.utils', () => ({
  useTrackEvent: () => ({ trackSearch: async () => null, trackAction: async () => null }),
}));
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: ({ data }: { data?: unknown[] }) => ({ items: data ?? [] }),
}));
vi.mock('~/hooks/useCheckProfanity', () => ({
  useCheckProfanity: () => ({ hasProfanity: false, matches: [] }),
}));

const { default: Router } = await import('next/router');
const { ContainerProvider } = await import('~/components/ContainerProvider/ContainerProvider');
const { AutocompleteSearch } = await import('~/components/AutocompleteSearch/AutocompleteSearch');
const { Configure, InstantSearch } = await import('react-instantsearch');
const { CustomSearchBox } = await import('~/components/Search/CustomSearchComponents');
const { withSemanticImageSearch } = await import('~/components/Search/semanticImageSearchClient');

const push = vi.mocked(Router.push);
const SEARCH_PAGE_URL = /^\/search\/images\?query=rainy(\+|%20)neon(\+|%20)street$/;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  state.semanticSearches = [];
  state.meiliQueries = [];
  state.pathname = '/images';
  push.mockClear();
});

async function typeInHeader() {
  renderWithProviders(
    <ContainerProvider containerName="main">
      <div style={{ width: 640, padding: 16 }}>
        <AutocompleteSearch />
      </div>
    </ContainerProvider>
  );
  await expect
    .element(page.getByRole('textbox', { name: 'Search category' }))
    .toHaveValue('Images');

  const input = page.getByPlaceholder('Search Civitai');
  await userEvent.click(input);
  await userEvent.type(input, 'rainy neon street');
  // Past the 300 ms debounce: a per-keystroke search would have gone out by now.
  await pause(700);
  expect(state.semanticSearches).toEqual([]);
  await expect.element(page.getByText('Search images for “rainy neon street”')).toBeVisible();
}

describe('AutocompleteSearch on the Images target', () => {
  test('runs no semantic search while typing; Enter opens the search page', async () => {
    await typeInHeader();

    await userEvent.keyboard('{Enter}');
    await expect.poll(() => push.mock.calls.length).toBe(1);
    expect(push.mock.calls[0][0]).toMatch(SEARCH_PAGE_URL);
    await pause(700);
    expect(state.semanticSearches).toEqual([]);
  });

  test('clicking the search row opens the search page', async () => {
    await typeInHeader();

    await userEvent.click(page.getByText('Search images for “rainy neon street”'));
    await expect.poll(() => push.mock.calls.length).toBe(1);
    expect(push.mock.calls[0][0]).toMatch(SEARCH_PAGE_URL);
  });

  // The control: a box that does query images reaches the recorder above, so its empty list means
  // no search went out rather than that the fake never sees one.
  test('the recorder sees a semantic image search', async () => {
    const meiliStub = { search: async () => ({ results: [] }) };
    renderWithProviders(
      <InstantSearch
        searchClient={withSemanticImageSearch(meiliStub as never)}
        indexName="images_v6"
      >
        <Configure hitsPerPage={20} />
        <CustomSearchBox isMobile />
      </InstantSearch>
    );
    await userEvent.click(page.getByPlaceholder('Search...'));
    await userEvent.type(page.getByPlaceholder('Search...'), 'rainy neon street');
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => state.semanticSearches.length).toBeGreaterThan(0);
  });
});

// The control for the header: off the Images target the dropdown still queries as the user types,
// so `submitOnly` is scoped to images rather than switched on for every target.
test('AutocompleteSearch on the Models target queries as the user types', async () => {
  state.pathname = '/models';
  renderWithProviders(
    <ContainerProvider containerName="main">
      <div style={{ width: 640, padding: 16 }}>
        <AutocompleteSearch />
      </div>
    </ContainerProvider>
  );
  await expect
    .element(page.getByRole('textbox', { name: 'Search category' }))
    .toHaveValue('Models');

  const input = page.getByPlaceholder('Search Civitai');
  await userEvent.click(input);
  await userEvent.type(input, 'rainy neon street');
  await expect.poll(() => state.meiliQueries).toContain('rainy neon street');
});
