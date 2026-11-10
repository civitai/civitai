import type { InstantSearchProps } from 'react-instantsearch';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { baseModels } from '~/shared/constants/basemodel.constants';
import { MediaType } from '~/shared/utils/prisma/enums';
import { trpcVanilla } from '~/utils/trpc';

/**
 * Image search answers from the semantic search (the cluster search service over Qdrant), not
 * Meilisearch. This wraps a search client so every request for the images index goes to
 * `semanticImageSearch.search`, shaped as a Meilisearch response, and everything else passes through.
 * The page, the header and the quick-search dropdown keep their InstantSearch widgets unchanged.
 */

type SearchClient = NonNullable<InstantSearchProps['searchClient']>;
type SearchRequests = Parameters<SearchClient['search']>[0];
type FacetRequests = Parameters<NonNullable<SearchClient['searchForFacetValues']>>[0];
type SearchInput = Parameters<typeof trpcVanilla.semanticImageSearch.search.query>[0];
type SearchOutput = Awaited<ReturnType<typeof trpcVanilla.semanticImageSearch.search.query>>;

export type RequestParams = {
  query?: string;
  page?: number;
  hitsPerPage?: number;
  facets?: string | string[];
  facetFilters?: string | (string | string[])[];
  numericFilters?: string | (string | string[])[];
  filters?: string;
};

const BROWSING_LEVEL_CLAUSE = /\bnsfwLevel=(\d+)/g;
// The index has no payload for these yet, so a request refined by them cannot be answered.
const UNSUPPORTED_FACETS = new Set(['aspectRatio', 'toolNames', 'techniqueNames']);
// Images only until videos are embedded.
const MEDIA_TYPES = [MediaType.image];
const OLDEST_POST = Date.UTC(2022, 0, 1);

export function isImageSearchIndex(indexName: string) {
  return indexName === IMAGES_SEARCH_INDEX || indexName.startsWith(`${IMAGES_SEARCH_INDEX}:`);
}

export function asList<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** `facetFilters` → `{ attribute: values }`; an inner array is OR, each outer entry AND. */
export function readFacetFilters(facetFilters: RequestParams['facetFilters']) {
  const byAttribute = new Map<string, string[]>();
  for (const group of asList(facetFilters)) {
    for (const filter of asList(group)) {
      if (typeof filter !== 'string' || filter.startsWith('-')) continue;
      const separator = filter.indexOf(':');
      if (separator < 0) continue;
      const attribute = filter.slice(0, separator);
      const value = filter.slice(separator + 1).replace(/^"(.*)"$/, '$1');
      byAttribute.set(attribute, [...(byAttribute.get(attribute) ?? []), value]);
    }
  }
  return byAttribute;
}

/** `createdAtUnix>=…` / `<=…` → posted-date bounds (ISO). */
function readPostedRange(numericFilters: RequestParams['numericFilters']) {
  let postedAfter: string | undefined;
  let postedBefore: string | undefined;
  for (const filter of asList(numericFilters).flat()) {
    const match = /^createdAtUnix\s*(>=|<=|>|<)\s*(\d+)/.exec(filter);
    if (!match) continue;
    const date = new Date(Number(match[2])).toISOString();
    if (match[1].startsWith('>')) postedAfter = date;
    else postedBefore = date;
  }
  return { postedAfter, postedBefore };
}

/** The browsing level `BrowsingLevelFilter` wrote into `filters` as `nsfwLevel=N OR …`. */
export function readBrowsingLevel(filters: string | undefined) {
  let flags = 0;
  for (const match of (filters ?? '').matchAll(BROWSING_LEVEL_CLAUSE)) flags |= Number(match[1]);
  return flags || undefined;
}

export function emptyResult(indexName: string, params: RequestParams) {
  return {
    index: indexName,
    hits: [],
    nbHits: 0,
    nbPages: 0,
    page: params.page ?? 0,
    hitsPerPage: params.hitsPerPage ?? 0,
    processingTimeMS: 0,
    exhaustiveNbHits: true,
    query: params.query ?? '',
    params: '',
    facets: {},
  };
}

/** Facet values for the sidebar widgets: no counts exist for a vector search, only choices. */
function facetValues(attribute: string, refined: Map<string, string[]>) {
  const chosen = refined.get(attribute) ?? [];
  const values =
    attribute === 'baseModel'
      ? [...new Set([...baseModels, ...chosen])]
      : attribute === 'type'
      ? [...new Set([...MEDIA_TYPES, ...chosen])]
      : chosen;
  return Object.fromEntries(values.map((value) => [value, 1]));
}

/** Image hits in the fields the dropdown's image row reads. */
function toHit(item: SearchOutput['items'][number]) {
  const { stats } = item;
  return {
    ...item,
    objectID: String(item.id),
    stats: stats && {
      ...stats,
      reactionCountAllTime:
        stats.likeCountAllTime +
        stats.heartCountAllTime +
        stats.laughCountAllTime +
        stats.cryCountAllTime,
    },
  };
}

type PagedResult<I> = {
  items: I[];
  nextCursor?: number;
  correctedQuery?: string;
  latencyMs: number;
};

/**
 * InstantSearch pages by number; the semantic search pages by an offset into its ranking, because
 * hydration drops candidates. The offset each page starts at is remembered per query, and the
 * result is shaped as a Meilisearch page.
 */
export function createOffsetPager() {
  const pageCursors = new Map<string, number | undefined>();

  return async function fetchPage<F extends object, I, H>({
    query,
    filters,
    hitsPerPage,
    page = 0,
    search,
    toHit,
  }: {
    query: string;
    filters: F;
    hitsPerPage: number;
    page?: number;
    search: (
      input: F & { query: string; limit: number; cursor?: number }
    ) => Promise<PagedResult<I>>;
    toHit: (item: I) => H;
  }) {
    const key = JSON.stringify([query, filters, hitsPerPage]);
    const cursor = page === 0 ? undefined : pageCursors.get(`${key}:${page}`);
    // A deep link to page N whose earlier pages were never fetched: approximate the offset.
    const offset = page === 0 ? undefined : cursor ?? page * hitsPerPage;

    const result = await search({ ...filters, query, limit: hitsPerPage, cursor: offset });
    if (result.nextCursor !== undefined) pageCursors.set(`${key}:${page + 1}`, result.nextCursor);
    const shown = page * hitsPerPage + result.items.length;

    return {
      hits: result.items.map(toHit),
      nbHits: result.nextCursor !== undefined ? shown + hitsPerPage : shown,
      nbPages: result.nextCursor !== undefined ? page + 2 : page + 1,
      processingTimeMS: result.latencyMs,
      exhaustiveNbHits: false,
      userData: result.correctedQuery ? [{ correctedQuery: result.correctedQuery }] : undefined,
    };
  };
}

export function createSemanticImageSearch({
  search = (input: SearchInput) => trpcVanilla.semanticImageSearch.search.query(input),
}: { search?: (input: SearchInput) => Promise<SearchOutput> } = {}) {
  const fetchPage = createOffsetPager();

  return async function searchImages(indexName: string, params: RequestParams) {
    const query = params.query?.trim();
    const hitsPerPage = params.hitsPerPage ?? 0;
    // Disjunctive-facet requests ask for facets only.
    const refined = readFacetFilters(params.facetFilters);
    const facets = Object.fromEntries(
      asList(params.facets)
        .filter((attribute) => attribute !== '*')
        .map((attribute) => [attribute, facetValues(attribute, refined)])
    );
    const dates = { createdAtUnix: { min: OLDEST_POST, max: Date.now() } };
    const empty = { ...emptyResult(indexName, params), facets, facets_stats: dates };
    if (!query || hitsPerPage === 0) return empty;
    if ([...refined.keys()].some((attribute) => UNSUPPORTED_FACETS.has(attribute))) return empty;

    const filters = {
      browsingLevel: readBrowsingLevel(params.filters),
      tagNames: refined.get('tagNames'),
      usernames: refined.get('user.username'),
      baseModels: refined.get('baseModel'),
      types: refined.get('type') as MediaType[] | undefined,
      ...readPostedRange(params.numericFilters),
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

async function searchFacetValues(facetName: string, facetQuery: string) {
  const text = facetQuery.trim();
  if (text.length < 2) return [];
  if (facetName === 'tagNames') {
    const { items } = await trpcVanilla.tag.getAll.query({ query: text.toLowerCase(), limit: 20 });
    return items.map((tag) => tag.name);
  }
  if (facetName === 'user.username') {
    const users = await trpcVanilla.user.getAll.query({ query: text, limit: 10 });
    return users.map((user) => user.username).filter((name): name is string => !!name);
  }
  if (facetName === 'baseModel')
    return baseModels.filter((name) => name.toLowerCase().includes(text.toLowerCase()));
  return [];
}

/** Routes the images index to the semantic search; every other index goes to `client`. */
export function withSemanticImageSearch(
  client: SearchClient,
  searchImages = createSemanticImageSearch()
): SearchClient {
  return {
    ...client,
    async search(requests: SearchRequests) {
      const images = requests.map((request) => isImageSearchIndex(request.indexName));
      if (!images.some(Boolean)) return client.search(requests);

      const others = requests.filter((_, i) => !images[i]);
      const [otherResponse, imageResults] = await Promise.all([
        others.length ? client.search(others) : Promise.resolve({ results: [] }),
        Promise.all(
          requests.map((request, i) =>
            images[i]
              ? searchImages(request.indexName, (request.params ?? {}) as RequestParams)
              : undefined
          )
        ),
      ]);
      let next = 0;
      return {
        results: requests.map((_, i) =>
          images[i] ? imageResults[i] : (otherResponse.results as unknown[])[next++]
        ),
      };
    },
    async searchForFacetValues(requests: FacetRequests) {
      const images = requests.map((request) => isImageSearchIndex(request.indexName));
      if (!images.some(Boolean)) return client.searchForFacetValues!(requests);
      return Promise.all(
        requests.map(async (request, i) => {
          if (!images[i]) return (await client.searchForFacetValues!([request]))[0];
          const { facetName, facetQuery } = request.params as {
            facetName: string;
            facetQuery: string;
          };
          const values = await searchFacetValues(facetName, facetQuery ?? '').catch(() => []);
          return {
            facetHits: values.map((value) => ({ value, highlighted: value, count: 1 })),
            exhaustiveFacetsCount: true,
            processingTimeMS: 0,
          };
        })
      );
    },
  } as unknown as SearchClient;
}
