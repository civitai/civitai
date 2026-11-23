import type { InstantSearchProps } from 'react-instantsearch';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { baseModels } from '~/shared/constants/basemodel.constants';
import { Flags } from '~/shared/utils/flags';
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
  /** Set by `useSimilarImage`: "more like this" for that image, while no query is typed. */
  similarTo?: number;
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
 *
 * Tied scores can reorder between requests, so a later page can repeat an id an earlier page showed;
 * InstantSearch appends pages, so those repeats are dropped here.
 */
export function createOffsetPager() {
  const pageCursors = new Map<string, number | undefined>();
  const pageIds = new Map<string, number[]>();

  return async function fetchPage<F extends object, I extends { id: number }, H>({
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
    const earlier = new Set(
      Array.from({ length: page }, (_, i) => pageIds.get(`${key}:${i}`) ?? []).flat()
    );
    const items = result.items.filter((item) => !earlier.has(item.id));
    pageIds.set(
      `${key}:${page}`,
      items.map((item) => item.id)
    );
    const shown = page * hitsPerPage + items.length;

    return {
      hits: items.map(toHit),
      nbHits: result.nextCursor !== undefined ? shown + hitsPerPage : shown,
      nbPages: result.nextCursor !== undefined ? page + 2 : page + 1,
      processingTimeMS: result.latencyMs,
      exhaustiveNbHits: false,
      userData: result.correctedQuery ? [{ correctedQuery: result.correctedQuery }] : undefined,
    };
  };
}

/**
 * The image search page's "Search instead for": the query the viewer chose to search as typed, without
 * the service's spelling correction. In memory, as the page's URL is InstantSearch's to write.
 */
let imageSearchAsTyped: string | undefined;
export const setImageSearchAsTyped = (query: string | undefined) => {
  imageSearchAsTyped = query;
};

export function createSemanticImageSearch({
  search = (input: SearchInput) => trpcVanilla.semanticImageSearch.search.query(input),
  asTyped = () => imageSearchAsTyped,
}: {
  search?: (input: SearchInput) => Promise<SearchOutput>;
  asTyped?: () => string | undefined;
} = {}) {
  const fetchPage = createOffsetPager();
  // A search for any other query ends the choice, so retyping the query later is corrected again.
  const searchedAsTyped = (query: string) => {
    const chosen = asTyped();
    if (chosen !== undefined && chosen !== query) setImageSearchAsTyped(undefined);
    return chosen === query;
  };

  return async function searchImages(indexName: string, params: RequestParams) {
    const query = params.query?.trim();
    // A typed query replaces "more like this".
    const imageId = query ? undefined : params.similarTo || undefined;
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
    if ((!query && !imageId) || hitsPerPage === 0) return empty;
    if ([...refined.keys()].some((attribute) => UNSUPPORTED_FACETS.has(attribute))) return empty;

    const filters = {
      imageId,
      browsingLevel: readBrowsingLevel(params.filters),
      tagNames: refined.get('tagNames'),
      usernames: refined.get('user.username'),
      baseModels: refined.get('baseModel'),
      types: refined.get('type') as MediaType[] | undefined,
      ...readPostedRange(params.numericFilters),
      // Only for the query it was chosen for: a new search is corrected again.
      ...(query && searchedAsTyped(query) ? { spellcheck: false as const } : {}),
    };
    const page = await fetchPage({
      query: query ?? '',
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

type MyImagesInput = Parameters<typeof trpcVanilla.image.getMyImages.query>[0];
type MyImagesOutput = Awaited<ReturnType<typeof trpcVanilla.image.getMyImages.query>>;

export type OwnerImageUser = {
  id: number;
  username?: string | null;
  image?: string | null;
  profilePicture?: unknown;
};

/** Cap on the owner's newest images and videos the empty picker lists. */
export const OWNER_LIST_LIMIT = 100;

/**
 * The showcase picker's Images, offered with or without image search. A typed query goes to the
 * semantic search, scoped by the `user.username` facet (without the flag the server serves only the
 * caller's own name). An empty one lists the caller's recent published images and videos, which the
 * semantic search cannot, at the viewer's browsing level.
 */
export function createOwnerImageSearch({
  searchImages = createSemanticImageSearch(),
  getMyImages = (input: MyImagesInput) => trpcVanilla.image.getMyImages.query(input),
  getUser = () => undefined,
}: {
  searchImages?: ReturnType<typeof createSemanticImageSearch>;
  getMyImages?: (input: MyImagesInput) => Promise<MyImagesOutput>;
  /** The caller, whose images the empty list is: that query's rows carry no `user`. */
  getUser?: () => OwnerImageUser | undefined;
} = {}) {
  return async function searchOwnerImages(indexName: string, params: RequestParams) {
    if (params.query?.trim()) return searchImages(indexName, params);

    const empty = emptyResult(indexName, params);
    const hitsPerPage = params.hitsPerPage ?? 0;
    // shortcut: the first page only; the picker shows one page.
    if (!hitsPerPage || params.page) return empty;
    const browsingLevel = readBrowsingLevel(params.filters);
    const { items } = await getMyImages({
      limit: Math.max(hitsPerPage, OWNER_LIST_LIMIT),
      // The owner's own list, not the semantic search, so videos can be offered here.
      mediaTypes: [MediaType.image, MediaType.video],
      publishedOnly: true,
    });
    const user = getUser();
    const hits = items
      .filter((item) => !browsingLevel || Flags.intersects(browsingLevel, item.nsfwLevel))
      .map((item) => {
        // The row's blurred placeholder needs these, which this query keeps in `metadata`.
        const { hash, width, height } = (item.metadata ?? {}) as {
          hash?: string;
          width?: number;
          height?: number;
        };
        return { ...item, hash, width, height, objectID: String(item.id), ...(user && { user }) };
      });
    return { ...empty, hits, nbHits: hits.length, nbPages: 1 };
  };
}

/** Routes the images index to the semantic search; every other index goes to `client`. */
export function withSemanticImageSearch(
  client: SearchClient,
  searchImages: (
    indexName: string,
    params: RequestParams
  ) => Promise<unknown> = createSemanticImageSearch()
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
