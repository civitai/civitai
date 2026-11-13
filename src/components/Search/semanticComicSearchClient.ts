import type { InstantSearchProps } from 'react-instantsearch';
import {
  createOffsetPager,
  emptyResult,
  readBrowsingLevel,
  readFacetFilters,
  asList,
  type RequestParams,
} from '~/components/Search/semanticImageSearchClient';
import { isSemanticComicSearchEnabled } from '~/components/Search/semanticComicSearchFlag';
import { COMICS_SEARCH_INDEX } from '~/server/common/constants';
import { routeToSemanticSearch } from '~/components/Search/semanticSearchRouting';
import { trpcVanilla } from '~/utils/trpc';

/**
 * Comic search answers from the semantic search while the `semanticComicSearch` flag is on.
 * Requests for the comics index in relevance order go to `semanticComicSearch.search`, shaped as a
 * Meilisearch response; a sorted index, facet searches and every other index stay on Meilisearch.
 * Off, nothing is routed: the flag is the rollback.
 */

type SearchClient = NonNullable<InstantSearchProps['searchClient']>;
type SearchInput = Parameters<typeof trpcVanilla.semanticComicSearch.search.query>[0];
type SearchOutput = Awaited<ReturnType<typeof trpcVanilla.semanticComicSearch.search.query>>;

/** Relevance order only: the semantic search cannot sort by stats or date. */
export const isSemanticComicIndex = (indexName: string) => indexName === COMICS_SEARCH_INDEX;

/** The server returns the Meilisearch comic record itself; InstantSearch keys hits by objectID. */
const toHit = (item: SearchOutput['items'][number]) => ({ ...item, objectID: String(item.id) });

export function createSemanticComicSearch({
  search = (input: SearchInput) => trpcVanilla.semanticComicSearch.search.query(input),
}: { search?: (input: SearchInput) => Promise<SearchOutput> } = {}) {
  const fetchPage = createOffsetPager();

  return async function searchComics(indexName: string, params: RequestParams) {
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
      genres: refined.get('genre'),
    };
    const page = await fetchPage({
      query,
      filters,
      hitsPerPage,
      page: params.page,
      search,
      toHit,
    });
    return { ...empty, ...page };
  };
}

export function withSemanticComicSearch(
  client: SearchClient,
  searchComics = createSemanticComicSearch(),
  isEnabled = isSemanticComicSearchEnabled
): SearchClient {
  return routeToSemanticSearch(
    client,
    (indexName) => isEnabled() && isSemanticComicIndex(indexName),
    searchComics
  );
}
