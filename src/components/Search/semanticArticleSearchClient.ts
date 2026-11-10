import type { InstantSearchProps } from 'react-instantsearch';
import {
  emptyResult,
  readBrowsingLevel,
  readFacetFilters,
  asList,
  type RequestParams,
} from '~/components/Search/semanticImageSearchClient';
import { ARTICLES_SEARCH_INDEX } from '~/server/common/constants';
import { parseBitwiseBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { trpcVanilla } from '~/utils/trpc';
import { isSemanticArticleSearchEnabled } from '~/components/Search/semanticArticleSearchFlag';

/**
 * Article search answers from the semantic search while the `semanticArticleSearch` flag is on.
 * Requests for the articles index in relevance order go to `semanticArticleSearch.search`, shaped
 * as a Meilisearch response; a sorted index, facet searches and every other index stay on
 * Meilisearch. Off, nothing is routed: the flag is the rollback.
 */

type SearchClient = NonNullable<InstantSearchProps['searchClient']>;
type SearchRequests = Parameters<SearchClient['search']>[0];
type SearchInput = Parameters<typeof trpcVanilla.semanticArticleSearch.search.query>[0];
type SearchOutput = Awaited<ReturnType<typeof trpcVanilla.semanticArticleSearch.search.query>>;

/** Relevance order only: the semantic search cannot sort by stats or date. */
export const isSemanticArticleIndex = (indexName: string) => indexName === ARTICLES_SEARCH_INDEX;

/** An article in the fields the Meilisearch article record has (see `articlesTransform`). */
function toHit(item: SearchOutput['items'][number]) {
  return {
    ...item,
    objectID: String(item.id),
    nsfwLevel: parseBitwiseBrowsingLevel(item.nsfwLevel),
    coverImage: item.coverImage && {
      ...item.coverImage,
      tags: item.coverImage.tags.map((id) => ({ id })),
    },
  };
}

export function createSemanticArticleSearch({
  search = (input: SearchInput) => trpcVanilla.semanticArticleSearch.search.query(input),
}: { search?: (input: SearchInput) => Promise<SearchOutput> } = {}) {
  // InstantSearch pages by number, the search by an offset into its ranking: remembered per query.
  const pageCursors = new Map<string, number | undefined>();

  return async function searchArticles(indexName: string, params: RequestParams) {
    const query = params.query?.trim();
    const hitsPerPage = params.hitsPerPage ?? 0;
    const refined = readFacetFilters(params.facetFilters);
    const facets = Object.fromEntries(
      asList(params.facets)
        .filter((attribute) => attribute !== '*')
        .map((attribute) => [
          attribute,
          Object.fromEntries((refined.get(attribute) ?? []).map((value) => [value, 1])),
        ])
    );
    const empty = { ...emptyResult(indexName, params), facets };
    if (!query || hitsPerPage === 0) return empty;

    const filters = {
      browsingLevel: readBrowsingLevel(params.filters),
      tagNames: refined.get('tags.name'),
      usernames: refined.get('user.username'),
    };
    const key = JSON.stringify([query, filters, hitsPerPage]);
    const page = params.page ?? 0;
    const cursor = page === 0 ? undefined : pageCursors.get(`${key}:${page}`);
    const offset = page === 0 ? undefined : cursor ?? page * hitsPerPage;

    const result = await search({ query, ...filters, limit: hitsPerPage, cursor: offset });
    if (result.nextCursor !== undefined) pageCursors.set(`${key}:${page + 1}`, result.nextCursor);
    const shown = page * hitsPerPage + result.items.length;

    return {
      ...empty,
      hits: result.items.map(toHit),
      nbHits: result.nextCursor !== undefined ? shown + hitsPerPage : shown,
      nbPages: result.nextCursor !== undefined ? page + 2 : page + 1,
      processingTimeMS: result.latencyMs,
      exhaustiveNbHits: false,
      userData: result.correctedQuery ? [{ correctedQuery: result.correctedQuery }] : undefined,
    };
  };
}

export function withSemanticArticleSearch(
  client: SearchClient,
  searchArticles = createSemanticArticleSearch(),
  isEnabled = isSemanticArticleSearchEnabled
): SearchClient {
  return {
    ...client,
    async search(requests: SearchRequests) {
      const routed = requests.map((r) => isEnabled() && isSemanticArticleIndex(r.indexName));
      if (!routed.some(Boolean)) return client.search(requests);

      const others = requests.filter((_, i) => !routed[i]);
      const [otherResponse, articleResults] = await Promise.all([
        others.length ? client.search(others) : Promise.resolve({ results: [] }),
        Promise.all(
          requests.map((request, i) =>
            routed[i]
              ? searchArticles(request.indexName, (request.params ?? {}) as RequestParams)
              : undefined
          )
        ),
      ]);
      let next = 0;
      return {
        results: requests.map((_, i) =>
          routed[i] ? articleResults[i] : (otherResponse.results as unknown[])[next++]
        ),
      };
    },
  } as unknown as SearchClient;
}
