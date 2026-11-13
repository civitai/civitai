import type { Filter } from 'meilisearch';
import { indexBrowsingLevelClause } from '~/components/Search/search-filters';
import { env } from '~/env/server';
import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';
import { logToAxiom } from '~/server/logging/client';
import type {
  SiteFacetSearchInput,
  SiteMultiSearchInput,
  SiteSearchParams,
} from '~/server/schema/site-search.schema';
import { RETIRED_SEARCH_INDEXES } from '~/server/search-index/retired-indexes';
import { isRatingWithinCap } from '~/shared/utils/rating-cap';
import { Availability } from '~/shared/utils/prisma/enums';

const SITE_SEARCH_TIMEOUT_MS = 5_000;
// The value the breaker-protected search routes send (e.g. /api/v1/models).
const SITE_SEARCH_RETRY_AFTER_SECONDS = 2;

const searchableIndexes = (retired: readonly string[]) =>
  [
    MODELS_SEARCH_INDEX,
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

/**
 * `raw` is set only on a passthrough: Meilisearch's 200 body, unparsed, to be sent as-is with a
 * JSON content type. `body` is then undefined.
 */
export type SiteSearchResponse = { status: number; body: unknown; raw?: Buffer };

/**
 * Passthrough is asked for by the caller (the `site-search-passthrough` switch) and granted only
 * where `hitsNeedShaping` says no hit of the response would be changed for this viewer.
 */
export type SiteSearchOptions = { passthrough?: boolean };

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
  }

  if (viewer.browsingLevelCap !== undefined) {
    const clause = indexBrowsingLevelClause(indexUid, viewer.browsingLevelCap);
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

type RatedImage = { id?: unknown; nsfwLevel?: unknown };

/** Drops the images the site may not serve; the hit-level cap does not reach them. */
function capImages(images: unknown, browsingLevelCap: number | undefined) {
  if (browsingLevelCap === undefined || !Array.isArray(images)) return images;
  return images.filter((image: RatedImage) =>
    isRatingWithinCap(image?.nsfwLevel, browsingLevelCap)
  );
}

/**
 * The highlight copy's images that the hit itself kept. The copy's values are shaped by the
 * request's highlight and crop options, so its own ratings are not read; Meilisearch also sends
 * its numbers as strings.
 */
function keepCopiesOf(copies: unknown, kept: unknown) {
  if (!Array.isArray(copies)) return copies;
  const keptIds = new Set(
    (Array.isArray(kept) ? (kept as RatedImage[]) : [])
      .filter((image) => image?.id != null)
      .map((image) => String(image.id))
  );
  return (copies as RatedImage[]).filter(
    (image) => image?.id != null && keptIds.has(String(image.id))
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
    if ('images' in formatted && viewer.browsingLevelCap !== undefined)
      formatted.images = keepCopiesOf(formatted.images, rest.images);
    rest._formatted = formatted;
  }
  return rest;
}

export type ComicHit = Record<string, unknown> & {
  coverImageNsfwLevel?: unknown;
  _formatted?: Record<string, unknown>;
};

/**
 * A capped site gets a cover only when every level it carries is inside the cap, stricter than
 * model images (any overlap). An unrated cover counts as outside.
 */
export function shapeComicHit(hit: ComicHit, browsingLevelCap: number | undefined) {
  if (browsingLevelCap === undefined) return hit;
  const level = Number(hit.coverImageNsfwLevel) || 0;
  if (level > 0 && (level & ~browsingLevelCap) === 0) return hit;

  const { coverImageUrl: _url, ...rest } = hit;
  if (rest._formatted) {
    const { coverImageUrl: _formattedUrl, ...formatted } = rest._formatted;
    rest._formatted = formatted;
  }
  return rest;
}

type BountyHit = Record<string, unknown> & { _formatted?: Record<string, unknown> };

/**
 * A bounty's own level is its images' combined level, which passes the cap when any one image
 * does, so each image is capped here.
 */
function shapeBountyHit(hit: BountyHit, browsingLevelCap: number | undefined): BountyHit {
  if (browsingLevelCap === undefined) return hit;
  const shaped: BountyHit = { ...hit };
  if ('images' in shaped) shaped.images = capImages(shaped.images, browsingLevelCap);
  if (shaped._formatted && 'images' in shaped._formatted)
    shaped._formatted = {
      ...shaped._formatted,
      images: keepCopiesOf(shaped._formatted.images, shaped.images),
    };
  return shaped;
}

type CollectionHit = Record<string, unknown> & { _formatted?: Record<string, unknown> };

/**
 * A collection's own level is its items' combined level, which passes the cap when any one item
 * does, so its cover and item images are capped here. `srcs` carry no rating, so a capped site
 * gets none.
 */
function shapeCollectionHit(
  hit: CollectionHit,
  browsingLevelCap: number | undefined
): CollectionHit {
  if (browsingLevelCap === undefined) return hit;
  const { srcs: _srcs, ...shaped }: CollectionHit = { ...hit };
  if ('images' in shaped) shaped.images = capImages(shaped.images, browsingLevelCap);
  const cover = shaped.image as RatedImage | null | undefined;
  const coverKept = !!cover && isRatingWithinCap(cover.nsfwLevel, browsingLevelCap);
  if ('image' in shaped && cover) shaped.image = coverKept ? cover : null;
  if (shaped._formatted) {
    const { srcs: _formattedSrcs, ...formatted } = shaped._formatted;
    if ('images' in formatted) formatted.images = keepCopiesOf(formatted.images, shaped.images);
    if ('image' in formatted && formatted.image && !coverKept) formatted.image = null;
    shaped._formatted = formatted;
  }
  return shaped;
}

/**
 * Whether `shapeHits` can change a hit of `indexUid` for this viewer. Model hits always can (their
 * `sfwName` is never sent); comic, bounty and collection hits only under a browsing-level cap;
 * every other index never. `shapeHits` itself returns early on `false`, so this is the one rule
 * both it and the passthrough decision read: a response is passed through unparsed only where
 * shaping it would have been a no-op.
 */
export function hitsNeedShaping(
  indexUid: string | undefined,
  viewer: Pick<SiteSearchViewer, 'browsingLevelCap'>
) {
  if (indexUid === MODELS_SEARCH_INDEX) return true;
  if (
    indexUid === COMICS_SEARCH_INDEX ||
    indexUid === BOUNTIES_SEARCH_INDEX ||
    indexUid === COLLECTIONS_SEARCH_INDEX
  )
    return viewer.browsingLevelCap !== undefined;
  return false;
}

function shapeHits(indexUid: string | undefined, hits: unknown, viewer: SiteSearchViewer) {
  if (!Array.isArray(hits) || !hitsNeedShaping(indexUid, viewer)) return hits;
  if (indexUid === MODELS_SEARCH_INDEX)
    return hits.map((hit: ModelHit) => shapeModelHit(hit, viewer));
  if (indexUid === COMICS_SEARCH_INDEX)
    return hits.map((hit: ComicHit) => shapeComicHit(hit, viewer.browsingLevelCap));
  if (indexUid === BOUNTIES_SEARCH_INDEX)
    return hits.map((hit: BountyHit) => shapeBountyHit(hit, viewer.browsingLevelCap));
  if (indexUid === COLLECTIONS_SEARCH_INDEX)
    return hits.map((hit: CollectionHit) => shapeCollectionHit(hit, viewer.browsingLevelCap));
  return hits;
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

const isJsonWhitespace = (byte: number) =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

/**
 * The body as bytes, or undefined if unreadable or not `{...}`. The bracket check only catches an
 * empty or cut-off body; a cut after an inner `}` relies on arrayBuffer() rejecting.
 */
async function readJsonObjectBytes(res: Response): Promise<Buffer | undefined> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch {
    return undefined;
  }
  let start = 0;
  let end = bytes.length - 1;
  while (start <= end && isJsonWhitespace(bytes[start])) start++;
  while (end >= start && isJsonWhitespace(bytes[end])) end--;
  if (start >= end || bytes[start] !== 0x7b || bytes[end] !== 0x7d) return undefined;
  return bytes;
}

/**
 * POSTs to Meilisearch with the server's search key. A 4xx that rejects the query is returned
 * as-is so the client can tell a bad filter from an outage. An unreachable, timed-out or 5xx
 * backend is a retryable 503. A refused key (401/403) is a 502 with no Retry-After: retrying
 * cannot fix our own credentials. With `passthrough`, a 200 comes back as `raw` bytes, unparsed
 * (`readJsonObjectBytes`); every other status is parsed exactly as without it.
 */
async function postToSearch(
  path: string,
  body: unknown,
  { passthrough = false }: SiteSearchOptions = {}
): Promise<SiteSearchResponse> {
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

  let responseBody: unknown;
  if (passthrough && res.status === 200) {
    const raw = await readJsonObjectBytes(res);
    if (raw) return { status: 200, body: undefined, raw };
    // not a JSON object: falls through to the failure handling below
  } else {
    responseBody = await res.json().catch(() => undefined);
  }
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

export async function siteMultiSearch(
  input: SiteMultiSearchInput,
  viewer: SiteSearchViewer,
  options: SiteSearchOptions = {}
): Promise<SiteSearchResponse> {
  for (const query of input.queries) assertSiteSearchIndex(query.indexUid);

  // Each result answers the query at its position, so the queries say which hits get shaped.
  const passthrough =
    !!options.passthrough &&
    !input.queries.some((query) => hitsNeedShaping(query.indexUid, viewer));
  const response = await postToSearch(
    '/multi-search',
    { queries: input.queries.map((query) => withViewer(query.indexUid, query, viewer)) },
    { passthrough }
  );
  if (response.status !== 200 || response.raw) return response;

  const body = response.body as { results?: { indexUid?: string; hits?: unknown }[] };
  return {
    status: 200,
    body: {
      ...body,
      results: body.results?.map((result, i) => ({
        ...result,
        hits: shapeHits(result.indexUid ?? input.queries[i]?.indexUid, result.hits, viewer),
      })),
    },
  };
}

export async function siteIndexSearch(
  indexUid: string,
  params: SiteSearchParams,
  viewer: SiteSearchViewer,
  options: SiteSearchOptions = {}
): Promise<SiteSearchResponse> {
  assertSiteSearchIndex(indexUid);

  const response = await postToSearch(
    `/indexes/${indexUid}/search`,
    withViewer(indexUid, params, viewer),
    { passthrough: !!options.passthrough && !hitsNeedShaping(indexUid, viewer) }
  );
  if (response.status !== 200 || response.raw) return response;

  const body = response.body as { hits?: unknown };
  return { status: 200, body: { ...body, hits: shapeHits(indexUid, body.hits, viewer) } };
}

export async function siteFacetSearch(
  indexUid: string,
  params: SiteFacetSearchInput,
  viewer: SiteSearchViewer,
  options: SiteSearchOptions = {}
): Promise<SiteSearchResponse> {
  assertSiteSearchIndex(indexUid);
  // Facet values carry no hits, so nothing in this response is ever shaped.
  return postToSearch(`/indexes/${indexUid}/facet-search`, withViewer(indexUid, params, viewer), {
    passthrough: !!options.passthrough,
  });
}
