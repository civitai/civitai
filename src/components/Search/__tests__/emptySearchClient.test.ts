import { describe, it, expect, vi } from 'vitest';

// `NEXT_PUBLIC_SEARCH_HOST` is unset in the test environment and the module builds a client from
// it at import time, so the transport is faked. The spy also lets us prove the empty client never
// delegates to it — the whole point is that no request reaches the retired index.
const underlyingSearch = vi.hoisted(() => vi.fn(async () => ({ results: [] })));
vi.mock('@meilisearch/instant-meilisearch', () => ({
  instantMeiliSearch: () => ({ search: underlyingSearch }),
}));

const { emptySearchClient } = await import('~/components/Search/emptySearchClient');

describe('emptySearchClient', () => {
  it('resolves any request to an empty result set without hitting the transport', async () => {
    const response = await emptySearchClient!.search([
      { indexName: 'images_v6', params: { query: 'anything' } },
    ]);

    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({ hits: [], nbHits: 0, nbPages: 0 });
    expect(underlyingSearch).not.toHaveBeenCalled();
  });
});
