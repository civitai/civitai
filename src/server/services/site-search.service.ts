import type { Filter } from 'meilisearch';
import { buildBrowsingLevelClause } from '~/components/Search/search-filters';
import { BROWSING_LEVEL_ATTRIBUTE } from '~/components/Search/search-index-filters';
import type { ReverseSearchIndexKey } from '~/components/Search/search.types';
import { reverseSearchIndexMap } from '~/components/Search/search.types';
import { env } from '~/env/server';
import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';
import { logToAxiom } from '~/server/logging/client';
import type { FallbackReason, SearchEngine } from '~/server/prom/site-search.metrics';
import { recordSiteSearch, siteSearchFallbacksCounter } from '~/server/prom/site-search.metrics';
import type {
  SiteFacetSearchInput,
  SiteMultiSearchInput,
  SiteSearchParams,
} from '~/server/schema/site-search.schema';
import { RETIRED_SEARCH_INDEXES } from '~/server/search-index/retired-indexes';
import { UnsupportedSearchRequest } from '~/server/search/meili-filter';
import { getOpenSearchClient } from '~/server/search/opensearch/client';
import { MODELS_INDEX_ALIAS } from '~/server/search/opensearch/indexes';
import { searchModelsOnOpenSearch } from '~/server/search/opensearch/models-search';
import { Flags } from '~/shared/utils/flags';
import { Availability } from '~/shared/utils/prisma/enums';

const SITE_SEARCH_TIMEOUT_MS = 5_000;
// The value the breaker-protected search routes send (e.g. /api/v1/models).
const SITE_SEARCH_RETRY_AFTER_SECONDS = 2;

const searchableIndexes = (retired: readonly string[]) =>
  [
    MODELS_SEARCH_INDEX,
    IMAGES_SEARCH_INDEX,
    ARTICLES_SEARCH_INDEX,
    USERS_SEARCH_INDEX,
    COLLECTIONS_SEARCH_INDEX,
    BOUNTIES_SEARCH_INDEX,
    TOOLS_SEARCH_INDEX,
    COMICS_SEARCH_INDEX,
  ].filter((index) => !retired.includes(index));

// The indexes the site's search UI may query, less the retired ones. Anything else is refused.
export const SITE_SEARCH_INDEXES: readonly string[] = searchableIndexes(RETIRED_SEARCH_INDEXES);

export type SiteSearchViewer = {
  userId?: number | null;
  isModerator?: boolean | null;
  /** The most this request may be served; `undefined` where the site caps nothing. */
  browsingLevelCap?: number;
  /** Model hits carry their civitai.com face instead of the civitai.red title. */
  showSfwFace: boolean;
  /** The engine comparison arm this viewer is in. Absent = Meilisearch. */
  engine?: SearchEngine;
};

/** A refusal the site-search endpoint sends as-is, so its message must be safe to show. */
export class SiteSearchError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'SiteSearchError';
  }

  /** Meilisearch's error shape, which the browser's search client already understands. */
  toResponseBody() {
    return {
      message: this.message,
      code: this.code,
      type: this.status >= 500 ? 'system' : 'invalid_request',
    };
  }
}

export type SiteSearchResponse = {
  status: number;
  body: unknown;
  /** Which engine answered, for the response header the comparison reads. */
  servedBy?: SearchEngine | 'mixed';
};

/**
 * The clauses every query on `indexUid` is held to, on top of whatever the client sends.
 * Moderators skip the POI and privacy rules but not the site's browsing-level cap.
 */
export function viewerSearchClauses(indexUid: string, viewer: SiteSearchViewer): string[] {
  const clauses: string[] = [];

  if (!viewer.isModerator) {
    const userId = Number(viewer.userId);
    const own = Number.isInteger(userId) && userId > 0 ? ` OR user.id = ${userId}` : '';
    if (indexUid === MODELS_SEARCH_INDEX)
      clauses.push(`poi != true${own}`, `availability != ${Availability.Private}${own}`);
    if (indexUid === IMAGES_SEARCH_INDEX) clauses.push('poi != true');
  }

  if (viewer.browsingLevelCap !== undefined) {
    const indexKey = reverseSearchIndexMap[indexUid as ReverseSearchIndexKey];
    const clause = buildBrowsingLevelClause(
      indexKey ? BROWSING_LEVEL_ATTRIBUTE[indexKey] : undefined,
      viewer.browsingLevelCap
    );
    if (clause) clauses.push(clause);
  }

  return clauses;
}

/**
 * ANDs the viewer's clauses onto the client's filter. The array form matters: Meilisearch parses
 * each element on its own, so no client string can close a parenthesis and OR its way past them.
 */
export function withViewerClauses(filter: Filter | undefined, clauses: string[]) {
  if (!clauses.length) return filter;
  const clientFilter = filter === undefined ? [] : typeof filter === 'string' ? [filter] : filter;
  return [...clientFilter.filter((part) => part !== ''), ...clauses];
}

type ModelHit = Record<string, unknown> & {
  name?: unknown;
  sfwName?: unknown;
  images?: unknown;
  _formatted?: Record<string, unknown>;
};

/** Drops the images the site may not serve; the model-level cap does not reach them. */
function capImages(images: unknown, browsingLevelCap: number | undefined) {
  if (browsingLevelCap === undefined || !Array.isArray(images)) return images;
  return images.filter((image: { nsfwLevel?: unknown }) =>
    Flags.intersects(Number(image?.nsfwLevel) || 0, browsingLevelCap)
  );
}

/**
 * One payload per site: a viewer who gets the civitai.com face receives it as the hit's `name`,
 * nobody receives the other site's title alongside the one they are shown, and a capped site
 * receives no image above its cap.
 */
export function shapeModelHit(
  hit: ModelHit,
  viewer: Pick<SiteSearchViewer, 'showSfwFace' | 'browsingLevelCap'>
) {
  const { sfwName, ...rest } = hit;
  const useFace = viewer.showSfwFace && typeof sfwName === 'string' && sfwName.length > 0;
  if (useFace) rest.name = sfwName;
  if ('images' in rest) rest.images = capImages(rest.images, viewer.browsingLevelCap);

  if (rest._formatted) {
    const { sfwName: formattedSfwName, ...formatted } = rest._formatted;
    if (useFace) formatted.name = formattedSfwName ?? sfwName;
    if ('images' in formatted)
      formatted.images = capImages(formatted.images, viewer.browsingLevelCap);
    rest._formatted = formatted;
  }
  return rest;
}

function shapeHits(indexUid: string | undefined, hits: unknown, viewer: SiteSearchViewer) {
  if (indexUid !== MODELS_SEARCH_INDEX || !Array.isArray(hits)) return hits;
  return hits.map((hit: ModelHit) => shapeModelHit(hit, viewer));
}

function assertSiteSearchIndex(indexUid: string) {
  if (!SITE_SEARCH_INDEXES.includes(indexUid))
    throw new SiteSearchError(
      403,
      'index_not_accessible',
      `Index \`${indexUid}\` is not searchable`
    );
}

function withViewer<T extends { filter?: Filter }>(
  indexUid: string,
  params: T,
  viewer: SiteSearchViewer
): T {
  return {
    ...params,
    filter: withViewerClauses(params.filter, viewerSearchClauses(indexUid, viewer)),
  };
}

const searchUnavailable = () =>
  new SiteSearchError(
    503,
    'search_unavailable',
    'Search is temporarily unavailable',
    SITE_SEARCH_RETRY_AFTER_SECONDS
  );

/**
 * POSTs to Meilisearch with the server's search key. A 4xx that rejects the query is returned
 * as-is so the client can tell a bad filter from an outage. An unreachable, timed-out or 5xx
 * backend is a retryable 503. A refused key (401/403) is a 502 with no Retry-After: retrying
 * cannot fix our own credentials.
 */
async function postToSearch(path: string, body: unknown): Promise<SiteSearchResponse> {
  const host = env.NEXT_PUBLIC_SEARCH_HOST;
  const apiKey = env.SEARCH_TOKEN_API_KEY ?? env.SEARCH_API_KEY;
  if (!host) throw new SiteSearchError(503, 'search_unavailable', 'Search is not configured');

  let res: Response;
  try {
    res = await fetch(`${host}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SITE_SEARCH_TIMEOUT_MS),
    });
  } catch (error) {
    // The cause can name the search host, so it is logged, never sent.
    logToAxiom({
      type: 'error',
      name: 'site-search',
      message: 'Search backend unreachable',
      cause: (error as Error).message,
      path,
    }).catch(() => undefined);
    throw searchUnavailable();
  }

  const responseBody = await res.json().catch(() => undefined);
  if (
    (res.ok && responseBody !== undefined) ||
    (res.status >= 400 && res.status < 500 && ![401, 403].includes(res.status))
  )
    return { status: res.status, body: responseBody };

  logToAxiom({
    type: 'error',
    name: 'site-search',
    message: 'Search backend refused or failed a site search',
    status: res.status,
    code: (responseBody as { code?: string } | undefined)?.code,
    path,
  }).catch(() => undefined);
  if (res.status >= 500) throw searchUnavailable();
  throw new SiteSearchError(502, 'search_unavailable', 'Search is temporarily unavailable');
}

const cohortOf = (viewer: SiteSearchViewer): SearchEngine => viewer.engine ?? 'meilisearch';

const hitCountOf = (result: { estimatedTotalHits?: number; totalHits?: number; hits?: unknown }) =>
  result.estimatedTotalHits ??
  result.totalHits ??
  (Array.isArray(result.hits) ? result.hits.length : 0);

/**
 * The OpenSearch answer to one query, in Meilisearch's shape, or `null` when Meilisearch should
 * answer it: the viewer is not in the OpenSearch arm, the index is not on OpenSearch yet, OpenSearch
 * is not configured, the request uses something the translation does not cover, or OpenSearch
 * failed. Falling back is always safe: Meilisearch serves the same request today.
 */
async function answerFromOpenSearch(
  indexUid: string,
  params: SiteSearchParams,
  viewer: SiteSearchViewer
) {
  if (viewer.engine !== 'opensearch' || indexUid !== MODELS_SEARCH_INDEX) return null;
  const fallback = (reason: FallbackReason) => {
    siteSearchFallbacksCounter.inc({ index: indexUid, reason });
    return null;
  };
  const client = getOpenSearchClient();
  if (!client) return fallback('unconfigured');

  const filter = withViewerClauses(params.filter, viewerSearchClauses(indexUid, viewer)) ?? [];
  const started = performance.now();
  try {
    const result = await searchModelsOnOpenSearch(
      client,
      MODELS_INDEX_ALIAS,
      params,
      typeof filter === 'string' ? [filter] : filter
    );
    recordSiteSearch({
      cohort: 'opensearch',
      servedBy: 'opensearch',
      index: indexUid,
      hitCount: hitCountOf(result),
      seconds: (performance.now() - started) / 1000,
    });
    return { indexUid, ...result, hits: shapeHits(indexUid, result.hits, viewer) };
  } catch (error) {
    if (error instanceof UnsupportedSearchRequest) return fallback('unsupported');
    logToAxiom({
      type: 'error',
      name: 'site-search',
      message: 'OpenSearch failed a site search; answered from Meilisearch',
      cause: (error as Error).message,
    }).catch(() => undefined);
    return fallback('error');
  }
}

export async function siteMultiSearch(
  input: SiteMultiSearchInput,
  viewer: SiteSearchViewer
): Promise<SiteSearchResponse> {
  for (const query of input.queries) assertSiteSearchIndex(query.indexUid);

  const fromOpenSearch = await Promise.all(
    input.queries.map((query) => answerFromOpenSearch(query.indexUid, query, viewer))
  );
  const forMeili = input.queries.filter((_, i) => !fromOpenSearch[i]);
  let meiliResults: { indexUid?: string; hits?: unknown }[] = [];
  if (forMeili.length) {
    const started = performance.now();
    const response = await postToSearch('/multi-search', {
      queries: forMeili.map((query) => withViewer(query.indexUid, query, viewer)),
    });
    if (response.status !== 200) return response;
    const seconds = (performance.now() - started) / 1000;
    meiliResults = (response.body as { results?: typeof meiliResults }).results ?? [];
    for (const result of meiliResults)
      recordSiteSearch({
        cohort: cohortOf(viewer),
        servedBy: 'meilisearch',
        index: result.indexUid ?? 'unknown',
        hitCount: hitCountOf(result),
        seconds,
      });
  }

  const pending = [...meiliResults];
  const results = fromOpenSearch.map((answer) => {
    if (answer) return answer;
    const result = pending.shift() ?? {};
    return { ...result, hits: shapeHits(result.indexUid, result.hits, viewer) };
  });
  const served = new Set(fromOpenSearch.map((a) => (a ? 'opensearch' : 'meilisearch')));
  return {
    status: 200,
    body: { results },
    servedBy: served.size > 1 ? 'mixed' : (([...served][0] ?? 'meilisearch') as SearchEngine),
  };
}

export async function siteIndexSearch(
  indexUid: string,
  params: SiteSearchParams,
  viewer: SiteSearchViewer
): Promise<SiteSearchResponse> {
  assertSiteSearchIndex(indexUid);

  const answer = await answerFromOpenSearch(indexUid, params, viewer);
  if (answer) return { status: 200, body: answer, servedBy: 'opensearch' };

  const started = performance.now();
  const response = await postToSearch(
    `/indexes/${indexUid}/search`,
    withViewer(indexUid, params, viewer)
  );
  if (response.status !== 200) return response;

  const body = response.body as { hits?: unknown; estimatedTotalHits?: number; totalHits?: number };
  recordSiteSearch({
    cohort: cohortOf(viewer),
    servedBy: 'meilisearch',
    index: indexUid,
    hitCount: hitCountOf(body),
    seconds: (performance.now() - started) / 1000,
  });
  return {
    status: 200,
    body: { ...body, hits: shapeHits(indexUid, body.hits, viewer) },
    servedBy: 'meilisearch',
  };
}

export async function siteFacetSearch(
  indexUid: string,
  params: SiteFacetSearchInput,
  viewer: SiteSearchViewer
) {
  assertSiteSearchIndex(indexUid);
  // Searching within a facet's values stays on Meilisearch for every arm.
  const response = await postToSearch(
    `/indexes/${indexUid}/facet-search`,
    withViewer(indexUid, params, viewer)
  );
  return { ...response, servedBy: 'meilisearch' as const };
}
