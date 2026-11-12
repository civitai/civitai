import { describe, expect, it, vi } from 'vitest';
import {
  createSemanticImageSearch,
  withSemanticImageSearch,
} from '~/components/Search/semanticImageSearchClient';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';

type Search = NonNullable<Parameters<typeof createSemanticImageSearch>[0]>['search'];

function fakeSearch(pages: { ids: number[]; nextCursor?: number; correctedQuery?: string }[]) {
  const search = vi.fn(async (_input: Parameters<NonNullable<Search>>[0]) => {
    const page = pages[search.mock.calls.length - 1] ?? { ids: [] };
    return {
      items: page.ids.map((id) => ({ id })),
      nextCursor: page.nextCursor,
      correctedQuery: page.correctedQuery,
      latencyMs: 5,
    };
  });
  return search as unknown as Search & typeof search;
}

const meili = () => ({
  search: vi.fn(async (requests: { indexName: string }[]) => ({
    results: requests.map((r) => ({ index: r.indexName, hits: [{ objectID: 'meili' }] })),
  })),
  searchForFacetValues: vi.fn(),
});

const imageRequest = (params: Record<string, unknown>) => ({
  indexName: IMAGES_SEARCH_INDEX,
  params: { query: 'fox', hitsPerPage: 50, page: 0, ...params },
});

describe('withSemanticImageSearch', () => {
  it('sends the widgets’ filters as the search input', async () => {
    const search = fakeSearch([{ ids: [1] }]);
    const client = withSemanticImageSearch(meili() as never, createSemanticImageSearch({ search }));

    await client.search([
      imageRequest({
        filters: '(poi != true) AND (nsfwLevel=1 OR nsfwLevel=2)',
        facetFilters: [
          ['baseModel:SDXL 1.0', 'baseModel:Pony'],
          ['tagNames:fox'],
          ['tagNames:snow'],
        ],
        numericFilters: ['createdAtUnix>=1735689600000'],
      }),
    ] as never);

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'fox',
        browsingLevel: 3,
        baseModels: ['SDXL 1.0', 'Pony'],
        tagNames: ['fox', 'snow'],
        postedAfter: '2025-01-01T00:00:00.000Z',
        limit: 50,
        cursor: undefined,
      })
    );
  });

  it('asks for the next page from where the previous one stopped', async () => {
    const search = fakeSearch([{ ids: [1, 2], nextCursor: 87 }, { ids: [3] }]);
    const client = withSemanticImageSearch(meili() as never, createSemanticImageSearch({ search }));

    const first = (await client.search([imageRequest({ hitsPerPage: 2 })] as never)) as {
      results: { nbPages: number; hits: { reactionCountAllTime?: number; stats: object }[] }[];
    };
    await client.search([imageRequest({ hitsPerPage: 2, page: 1 })] as never);

    expect(first.results[0].nbPages).toBe(2);
    expect(search.mock.calls[1][0]).toMatchObject({ cursor: 87 });
  });

  it('drops an image any earlier page already showed', async () => {
    const search = fakeSearch([
      { ids: [1, 2], nextCursor: 2 },
      { ids: [2, 3], nextCursor: 4 },
      { ids: [1, 4] },
    ]);
    const client = withSemanticImageSearch(meili() as never, createSemanticImageSearch({ search }));
    type Response = { results: { hits: { id: number }[] }[] };

    await client.search([imageRequest({ hitsPerPage: 2 })] as never);
    const second = (await client.search([
      imageRequest({ hitsPerPage: 2, page: 1 }),
    ] as never)) as Response;
    const third = (await client.search([
      imageRequest({ hitsPerPage: 2, page: 2 }),
    ] as never)) as Response;

    expect(second.results[0].hits.map((hit) => hit.id)).toEqual([3]);
    expect(third.results[0].hits.map((hit) => hit.id)).toEqual([4]);
  });

  it('passes other indexes through, keeping the order of the results', async () => {
    const search = fakeSearch([{ ids: [7] }]);
    const base = meili();
    const client = withSemanticImageSearch(base as never, createSemanticImageSearch({ search }));

    const { results } = (await client.search([
      { indexName: 'models_v9', params: { query: 'fox' } },
      imageRequest({}),
      { indexName: 'users_v3', params: { query: 'fox' } },
    ] as never)) as { results: { index: string; hits: { objectID: string }[] }[] };

    expect(results.map((r) => r.index)).toEqual(['models_v9', IMAGES_SEARCH_INDEX, 'users_v3']);
    expect(results[1].hits[0].objectID).toBe('7');
    expect(base.search).toHaveBeenCalledWith([
      { indexName: 'models_v9', params: { query: 'fox' } },
      { indexName: 'users_v3', params: { query: 'fox' } },
    ]);
  });

  it.each([
    ['no query', { query: '' }],
    ['a facet-only request', { hitsPerPage: 0 }],
    ['a filter the index cannot apply', { facetFilters: [['aspectRatio:Portrait']] }],
  ])('answers %s without searching', async (_case, params) => {
    const search = fakeSearch([{ ids: [1] }]);
    const client = withSemanticImageSearch(meili() as never, createSemanticImageSearch({ search }));

    const { results } = (await client.search([imageRequest(params)] as never)) as {
      results: { hits: unknown[] }[];
    };

    expect(results[0].hits).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it('hands the spelling correction to the page', async () => {
    const search = fakeSearch([{ ids: [1], correctedQuery: 'batman' }]);
    const client = withSemanticImageSearch(meili() as never, createSemanticImageSearch({ search }));

    const { results } = (await client.search([imageRequest({ query: 'batmen' })] as never)) as {
      results: { userData?: { correctedQuery: string }[] }[];
    };

    expect(results[0].userData).toEqual([{ correctedQuery: 'batman' }]);
  });
});
