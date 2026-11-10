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
  meiliRequests: [] as Array<{ indexName: string; params?: { filters?: unknown } }>,
  semanticQuery: vi.fn(),
}));

vi.mock('@meilisearch/instant-meilisearch', () => ({
  instantMeiliSearch: () => ({
    search: async (requests: Array<{ indexName: string }>) => {
      state.meiliRequests.push(...requests);
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

beforeEach(() => {
  state.imageSearch = false;
  state.searchClients = [];
  state.meiliRequests = [];
  state.semanticQuery.mockReset();
  // What the flag-protected procedure does for a user without `imageSearch`.
  state.semanticQuery.mockRejectedValue(new Error('FORBIDDEN'));
});

async function searchImages(filters: string) {
  await vi.waitFor(() => expect(state.searchClients.length).toBeGreaterThan(0));
  const client = state.searchClients.at(-1)!;
  return (await client.search([
    { indexName: 'images_v6', params: { query: 'fox', hitsPerPage: 25, filters } },
  ])) as { results: Array<{ hits: Array<{ id: number }> }> };
}

const renderImagesPicker = () =>
  renderWithProviders(
    <ShowcaseItemsInput username="fox" supportedIndexes={['images']} value={[]} />
  );

describe('ShowcaseItemsInput — Images search', () => {
  test('without image search, the owner’s images come back from Meili, filtered to them', async () => {
    renderImagesPicker();

    const { results } = await searchImages('(user.username = "fox")');

    expect(results[0].hits.map((hit) => hit.id)).toEqual([41]);
    expect(state.meiliRequests[0].params?.filters).toContain('user.username = "fox"');
    expect(state.semanticQuery).not.toHaveBeenCalled();
  });

  test('without image search, an unscoped images search also answers from Meili', async () => {
    renderImagesPicker();

    const { results } = await searchImages('(nsfwLevel=1)');

    expect(results[0].hits.map((hit) => hit.id)).toEqual([41]);
    expect(state.semanticQuery).not.toHaveBeenCalled();
  });

  test('with image search on, the owner-scoped picker still answers from Meili', async () => {
    state.imageSearch = true;
    state.semanticQuery.mockResolvedValue({ items: [{ id: 99 }], latencyMs: 1 });
    renderImagesPicker();

    const { results } = await searchImages('(user.username = "fox")');

    expect(results[0].hits.map((hit) => hit.id)).toEqual([41]);
    expect(state.semanticQuery).not.toHaveBeenCalled();
  });

  // Control: an unscoped images search with the flag on does reach the semantic fake, so the
  // `not.toHaveBeenCalled` assertions above can see a call when one happens.
  test('control: with image search on, an unscoped images search goes to the semantic search', async () => {
    state.imageSearch = true;
    state.semanticQuery.mockResolvedValue({ items: [{ id: 99 }], latencyMs: 1 });
    renderImagesPicker();

    const { results } = await searchImages('(nsfwLevel=1)');

    expect(results[0].hits.map((hit) => hit.id)).toEqual([99]);
    expect(state.semanticQuery).toHaveBeenCalledTimes(1);
  });
});
