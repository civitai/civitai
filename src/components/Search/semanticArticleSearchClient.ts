import type { InstantSearchProps } from 'react-instantsearch';
import {
  createOffsetPager,
  emptyResult,
  readBrowsingLevel,
  readFacetFilters,
  asList,
  type RequestParams,
} from '~/components/Search/semanticImageSearchClient';
import { ARTICLES_SEARCH_INDEX } from '~/server/common/constants';
import { parseBitwiseBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { routeToSemanticSearch } from '~/components/Search/semanticSearchRouting';
import { trpcVanilla } from '~/utils/trpc';
import { isSemanticArticleSearchEnabled } from '~/components/Search/semanticArticleSearchFlag';

/**
 * Article search answers from the semantic search while the `semanticArticleSearch` flag is on.
 * Requests for the articles index in relevance order go to `semanticArticleSearch.search`, shaped
 * as a Meilisearch response; a sorted index, facet searches and every other index stay on
 * Meilisearch. Off, nothing is routed: the flag is the rollback.
 */

type SearchClient = NonNullable<InstantSearchProps['searchClient']>;
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
  const fetchPage = createOffsetPager();

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

export function withSemanticArticleSearch(
  client: SearchClient,
  searchArticles = createSemanticArticleSearch(),
  isEnabled = isSemanticArticleSearchEnabled
): SearchClient {
  return routeToSemanticSearch(
    client,
    (indexName) => isEnabled() && isSemanticArticleIndex(indexName),
    searchArticles
  );
}
