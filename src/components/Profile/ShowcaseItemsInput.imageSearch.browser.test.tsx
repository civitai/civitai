import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

// The showcase editor's Images picker, as ShowcaseSectionModal renders it. The InstantSearch
// provider is a recorder: each test sends an images search through the client the picker handed
// it, with Meili and the semantic search both faked.

const state = vi.hoisted(() => ({
  imageSearch: false,
  searchClients: [] as Array<{ search: (requests: unknown[]) => Promise<unknown> }>,
  semanticQuery: vi.fn(),
}));

vi.mock('@meilisearch/instant-meilisearch', () => ({
  instantMeiliSearch: () => ({
    search: async (requests: Array<{ indexName: string }>) => {
      return { results: requests.map((r) => ({ index: r.indexName, hits: [{ id: 41 }] })) };
    },
  }),
}));
vi.mock('react-instantsearch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  InstantSearch: (props: { searchClient: (typeof state.searchClients)[number] }) => {
    state.searchClients.push(props.searchClient);
    return null;
  },
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useFeatureFlags: () =>
    new Proxy({}, { get: (_, key) => (key === 'imageSearch' ? state.imageSearch : true) }),
}));
vi.mock('~/providers/BrowsingSettingsAddonsProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  BrowsingSettingsAddonsProvider: (props: { children: ReactNode }) => props.children,
  useBrowsingSettingsAddons: () => ({ settings: {} }),
}));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useCurrentUser: () => ({ id: 7, username: 'fox' }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'image.getEntitiesCoverImage': {
      useQuery: () => ({ data: [], isLoading: false, isRefetching: false }),
    },
  }),
  trpcVanilla: { semanticImageSearch: { search: { query: state.semanticQuery } } },
}));

const { ShowcaseItemsInput } = await import('~/components/Profile/ShowcaseItemsInput');
const { QuickSearchDropdown } = await import('~/components/Search/QuickSearchDropdown');

beforeEach(() => {
  state.imageSearch = false;
  state.searchClients = [];
  state.semanticQuery.mockReset();
  // What the flag-protected procedure does for a user without `imageSearch`.
  state.semanticQuery.mockRejectedValue(new Error('FORBIDDEN'));
});

// Routing is decided by the client the picker hands InstantSearch, not by the request, so a neutral
// request is enough.
async function searchImages() {
  await vi.waitFor(() => expect(state.searchClients.length).toBeGreaterThan(0));
  const client = state.searchClients.at(-1)!;
  return (await client.search([
    { indexName: 'images_v6', params: { query: 'fox', hitsPerPage: 25, filters: '(nsfwLevel=1)' } },
  ])) as { results: Array<{ hits: Array<{ id: number }> }> };
}

const hitIds = (response: Awaited<ReturnType<typeof searchImages>>) =>
  response.results[0].hits.map((hit) => hit.id);

const renderShowcasePicker = () =>
  renderWithProviders(
    <ShowcaseItemsInput username="fox" supportedIndexes={['images']} value={[]} />
  );
const renderPlainImagesDropdown = () =>
  renderWithProviders(
    <QuickSearchDropdown supportedIndexes={['images']} onItemSelected={() => undefined} />
  );

describe('Images search in the showcase picker', () => {
  test('without image search, the owner’s images come back from Meili', async () => {
    renderShowcasePicker();

    expect(hitIds(await searchImages())).toEqual([41]);
    expect(state.semanticQuery).not.toHaveBeenCalled();
  });

  // The semantic search cannot scope to one owner, so the picker stays on Meili.
  test('with image search on, it still answers from Meili', async () => {
    state.imageSearch = true;
    state.semanticQuery.mockResolvedValue({ items: [{ id: 99 }], latencyMs: 1 });
    renderShowcasePicker();

    expect(hitIds(await searchImages())).toEqual([41]);
    expect(state.semanticQuery).not.toHaveBeenCalled();
  });
});

describe('Images search in a QuickSearchDropdown with no owner scope', () => {
  test('without image search, it answers from Meili', async () => {
    renderPlainImagesDropdown();

    expect(hitIds(await searchImages())).toEqual([41]);
    expect(state.semanticQuery).not.toHaveBeenCalled();
  });

  // Control: the semantic fake can see a call, so the `not.toHaveBeenCalled` assertions above
  // are not vacuous.
  test('control: with image search on, it answers from the semantic search', async () => {
    state.imageSearch = true;
    state.semanticQuery.mockResolvedValue({ items: [{ id: 99 }], latencyMs: 1 });
    renderPlainImagesDropdown();

    expect(hitIds(await searchImages())).toEqual([99]);
    expect(state.semanticQuery).toHaveBeenCalledTimes(1);
  });
});
