import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSemanticArticleSearch,
  withSemanticArticleSearch,
} from '~/components/Search/semanticArticleSearchClient';
import { setSemanticArticleSearchEnabled } from '~/components/Search/semanticArticleSearchFlag';
import { ARTICLES_SEARCH_INDEX, MODELS_SEARCH_INDEX } from '~/server/common/constants';

type SearchClient = Parameters<typeof withSemanticArticleSearch>[0];

const meili = () => ({
  search: vi.fn(async (requests: { indexName: string }[]) => ({
    results: requests.map((r) => ({ index: r.indexName, hits: [{ objectID: 'meili' }] })),
  })),
});

const request = (indexName: string, params: Record<string, unknown> = {}) => ({
  indexName,
  params: { query: 'guide', hitsPerPage: 20, ...params },
});

/** The article search, recording what it was asked; its hits say they came from it. */
const semantic = () =>
  vi.fn(async (indexName: string) => ({ index: indexName, hits: [{ objectID: 'semantic' }] }));

const run = async (requests: ReturnType<typeof request>[]) => {
  const client = meili();
  const searchArticles = semantic();
  const wrapped = withSemanticArticleSearch(
    client as unknown as SearchClient,
    searchArticles as unknown as ReturnType<typeof createSemanticArticleSearch>
  );
  const response = (await wrapped.search(requests as never)) as {
    results: { index: string; hits: { objectID: string }[] }[];
  };
  return { client, searchArticles, sources: response.results.map((r) => r.hits[0].objectID) };
};

describe('article search routing', () => {
  beforeEach(() => setSemanticArticleSearchEnabled(false));

  it('sends article searches to Meilisearch while the flag is off', async () => {
    const { client, searchArticles, sources } = await run([request(ARTICLES_SEARCH_INDEX)]);
    expect(sources).toEqual(['meili']);
    expect(client.search).toHaveBeenCalledTimes(1);
    expect(searchArticles).not.toHaveBeenCalled();
  });

  // The control for the test above: the same request does reach the semantic search when on.
  it('sends them to the semantic search while the flag is on', async () => {
    setSemanticArticleSearchEnabled(true);
    const { client, sources } = await run([request(ARTICLES_SEARCH_INDEX)]);
    expect(sources).toEqual(['semantic']);
    expect(client.search).not.toHaveBeenCalled();
  });

  it('keeps sorted article searches and other indexes on Meilisearch, in request order', async () => {
    setSemanticArticleSearchEnabled(true);
    const { client, sources } = await run([
      request(MODELS_SEARCH_INDEX),
      request(ARTICLES_SEARCH_INDEX),
      request(`${ARTICLES_SEARCH_INDEX}:stats.viewCount:desc`),
    ]);
    expect(sources).toEqual(['meili', 'semantic', 'meili']);
    expect(client.search.mock.calls[0][0].map((r) => r.indexName)).toEqual([
      MODELS_SEARCH_INDEX,
      `${ARTICLES_SEARCH_INDEX}:stats.viewCount:desc`,
    ]);
  });
});

describe('article search request and hits', () => {
  it('reads the browsing level and refinements, and returns hits in the index record shape', async () => {
    const search = vi.fn(async () => ({
      items: [{ id: 5, nsfwLevel: 1 | 4, coverImage: { id: 50, tags: [3, 4] } }],
      nextCursor: 40,
      correctedQuery: undefined,
      latencyMs: 9,
    }));
    const searchArticles = createSemanticArticleSearch({ search: search as never });
    const result = (await searchArticles(ARTICLES_SEARCH_INDEX, {
      query: ' guide ',
      hitsPerPage: 20,
      filters: 'nsfwLevel=1 OR nsfwLevel=4',
      facetFilters: [['tags.name:anime'], ['user.username:someone']],
    })) as { hits: Record<string, unknown>[]; nbPages: number };

    expect(search).toHaveBeenCalledWith({
      query: 'guide',
      browsingLevel: 5,
      tagNames: ['anime'],
      usernames: ['someone'],
      limit: 20,
      cursor: undefined,
    });
    expect(result.hits).toEqual([
      {
        id: 5,
        objectID: '5',
        nsfwLevel: [1, 4],
        coverImage: { id: 50, tags: [{ id: 3 }, { id: 4 }] },
      },
    ]);
    expect(result.nbPages).toBe(2);
  });
});

describe('article search paging', () => {
  it('starts page 1 at the offset page 0 returned, not page × hitsPerPage', async () => {
    const search = vi.fn(async (input: { cursor?: number }) => ({
      items: [],
      nextCursor: input.cursor === undefined ? 37 : undefined,
      correctedQuery: undefined,
      latencyMs: 1,
    }));
    const searchArticles = createSemanticArticleSearch({ search: search as never });
    const params = { query: 'guide', hitsPerPage: 20 };
    await searchArticles(ARTICLES_SEARCH_INDEX, { ...params, page: 0 });
    await searchArticles(ARTICLES_SEARCH_INDEX, { ...params, page: 1 });
    expect(search.mock.calls.map(([input]) => input.cursor)).toEqual([undefined, 37]);
  });
});
