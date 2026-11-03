import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { MODELS_SEARCH_INDEX, USERS_SEARCH_INDEX } from '~/server/common/constants';
import type { OpenSearchSearchResponse } from '~/server/search/opensearch/opensearch-client';
import type { SiteSearchViewer } from '~/server/services/site-search.service';
import { siteIndexSearch, siteMultiSearch } from '~/server/services/site-search.service';

// Which engine answers a site search, and that every route away from OpenSearch lands on
// Meilisearch rather than on an error.

const openSearch = vi.hoisted(() => ({
  configured: true,
  search: vi.fn(),
}));
vi.mock('~/server/search/opensearch/client', () => ({
  getOpenSearchClient: () => (openSearch.configured ? { search: openSearch.search } : null),
}));

const osResponse = (ids: number[]): OpenSearchSearchResponse => ({
  took: 3,
  hits: {
    total: { value: ids.length, relation: 'eq' },
    hits: ids.map((id) => ({ _id: String(id), _source: { id, name: `os-${id}` } })),
  },
});

const meiliFetch = vi.fn(async (url: string, init: { body: string }) => {
  const body = JSON.parse(init.body);
  const answer = (query: { indexUid?: string }) => ({
    indexUid: query.indexUid,
    hits: [{ id: 99, name: 'meili-99' }],
    estimatedTotalHits: 1,
    processingTimeMs: 1,
  });
  const result = url.endsWith('/multi-search')
    ? { results: body.queries.map(answer) }
    : answer({ indexUid: MODELS_SEARCH_INDEX });
  return new Response(JSON.stringify(result), { status: 200 });
});

const viewer = (engine: SiteSearchViewer['engine']): SiteSearchViewer => ({
  userId: 7,
  showSfwFace: false,
  engine,
});

beforeEach(() => {
  setEnv({ NEXT_PUBLIC_SEARCH_HOST: 'http://meili.test' });
  vi.stubGlobal('fetch', meiliFetch);
  openSearch.configured = true;
  openSearch.search.mockReset().mockResolvedValue(osResponse([1, 2]));
  meiliFetch.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('site search engine routing', () => {
  it('answers an OpenSearch-arm models search from OpenSearch, in the shape the UI reads', async () => {
    const response = await siteIndexSearch(
      MODELS_SEARCH_INDEX,
      { q: 'pony' },
      viewer('opensearch')
    );
    expect(response.servedBy).toBe('opensearch');
    expect(response.body).toMatchObject({
      hits: [{ id: 1 }, { id: 2 }],
      estimatedTotalHits: 2,
      query: 'pony',
    });
    expect(meiliFetch).not.toHaveBeenCalled();
  });

  it("sends OpenSearch the viewer's own scope, not just the client's filter", async () => {
    await siteIndexSearch(
      MODELS_SEARCH_INDEX,
      { q: 'pony' },
      { ...viewer('opensearch'), userId: undefined }
    );
    const body = JSON.stringify(openSearch.search.mock.calls[0][1]);
    expect(body).toContain('"poi":true'); // must_not poi
    expect(body).toContain('"availability":"Private"');
  });

  it('never touches OpenSearch for the Meilisearch arm', async () => {
    const response = await siteIndexSearch(
      MODELS_SEARCH_INDEX,
      { q: 'pony' },
      viewer('meilisearch')
    );
    expect(response.servedBy).toBe('meilisearch');
    expect(openSearch.search).not.toHaveBeenCalled();
  });

  it('answers from Meilisearch when OpenSearch cannot translate the request, fails, or is not set up', async () => {
    const unsupported = await siteIndexSearch(
      MODELS_SEARCH_INDEX,
      { q: 'pony', sort: ['name:asc'] },
      viewer('opensearch')
    );
    expect(unsupported).toMatchObject({ servedBy: 'meilisearch', body: { hits: [{ id: 99 }] } });

    openSearch.search.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const failed = await siteIndexSearch(MODELS_SEARCH_INDEX, { q: 'pony' }, viewer('opensearch'));
    expect(failed).toMatchObject({ servedBy: 'meilisearch', body: { hits: [{ id: 99 }] } });

    openSearch.configured = false;
    const unconfigured = await siteIndexSearch(
      MODELS_SEARCH_INDEX,
      { q: 'pony' },
      viewer('opensearch')
    );
    expect(unconfigured.servedBy).toBe('meilisearch');
  });

  it('keeps multi-search results in request order when the engines split the queries', async () => {
    const response = await siteMultiSearch(
      {
        queries: [
          { indexUid: USERS_SEARCH_INDEX, q: 'a' },
          { indexUid: MODELS_SEARCH_INDEX, q: 'b' },
          { indexUid: USERS_SEARCH_INDEX, q: 'c' },
        ],
      },
      viewer('opensearch')
    );
    const results = (response.body as { results: { indexUid: string; hits: { id: number }[] }[] })
      .results;
    expect(results.map((r) => [r.indexUid, r.hits[0].id])).toEqual([
      [USERS_SEARCH_INDEX, 99],
      [MODELS_SEARCH_INDEX, 1],
      [USERS_SEARCH_INDEX, 99],
    ]);
    expect(response.servedBy).toBe('mixed');
    // Meilisearch was asked only for the two queries OpenSearch did not answer.
    expect(JSON.parse(meiliFetch.mock.calls[0][1].body).queries).toHaveLength(2);
  });
});
