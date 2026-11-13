import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSemanticComicSearch,
  withSemanticComicSearch,
} from '~/components/Search/semanticComicSearchClient';
import { setSemanticComicSearchEnabled } from '~/components/Search/semanticComicSearchFlag';
import { ARTICLES_SEARCH_INDEX, COMICS_SEARCH_INDEX } from '~/server/common/constants';

type SearchClient = Parameters<typeof withSemanticComicSearch>[0];

const meili = () => ({
  search: vi.fn(async (requests: { indexName: string }[]) => ({
    results: requests.map((r) => ({ index: r.indexName, hits: [{ objectID: 'meili' }] })),
  })),
});
const request = (indexName: string) => ({
  indexName,
  params: { query: 'pirates', hitsPerPage: 20 },
});

const run = async (requests: ReturnType<typeof request>[]) => {
  const client = meili();
  const searchComics = vi.fn(async (indexName: string) => ({
    index: indexName,
    hits: [{ objectID: 'semantic' }],
  }));
  const wrapped = withSemanticComicSearch(
    client as unknown as SearchClient,
    searchComics as unknown as ReturnType<typeof createSemanticComicSearch>
  );
  const response = (await wrapped.search(requests as never)) as {
    results: { hits: { objectID: string }[] }[];
  };
  return { client, searchComics, sources: response.results.map((r) => r.hits[0].objectID) };
};

describe('comic search routing', () => {
  beforeEach(() => setSemanticComicSearchEnabled(false));

  it('sends comic searches to Meilisearch while the flag is off', async () => {
    const { searchComics, sources } = await run([request(COMICS_SEARCH_INDEX)]);
    expect(sources).toEqual(['meili']);
    expect(searchComics).not.toHaveBeenCalled();
  });

  it('keeps sorted comic searches and other indexes on Meilisearch, in request order', async () => {
    setSemanticComicSearchEnabled(true);
    const { client, sources } = await run([
      request(ARTICLES_SEARCH_INDEX),
      request(COMICS_SEARCH_INDEX),
      request(`${COMICS_SEARCH_INDEX}:createdAt:desc`),
    ]);
    expect(sources).toEqual(['meili', 'semantic', 'meili']);
    expect(client.search.mock.calls[0][0].map((r) => r.indexName)).toEqual([
      ARTICLES_SEARCH_INDEX,
      `${COMICS_SEARCH_INDEX}:createdAt:desc`,
    ]);
  });
});

describe('comic search request and hits', () => {
  it('reads the browsing level and the genre refinement, and keys hits by objectID', async () => {
    const search = vi.fn(async () => ({
      items: [{ id: 5, name: 'Space Pirates', nsfwLevel: [1] }],
      nextCursor: undefined,
      correctedQuery: undefined,
      latencyMs: 9,
    }));
    const searchComics = createSemanticComicSearch({ search: search as never });
    const result = (await searchComics(COMICS_SEARCH_INDEX, {
      query: ' pirates ',
      hitsPerPage: 20,
      filters: 'nsfwLevel=1 OR nsfwLevel=2',
      facetFilters: [['genre:Action', 'genre:Comedy']],
    })) as { hits: Record<string, unknown>[] };

    expect(search).toHaveBeenCalledWith({
      query: 'pirates',
      browsingLevel: 3,
      genres: ['Action', 'Comedy'],
      limit: 20,
      cursor: undefined,
    });
    expect(result.hits).toEqual([{ id: 5, objectID: '5', name: 'Space Pirates', nsfwLevel: [1] }]);
  });
});
