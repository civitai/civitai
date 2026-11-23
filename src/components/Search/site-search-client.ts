import type { InstantMeiliSearchOptions } from '@meilisearch/instant-meilisearch';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { env } from '~/env/client';
import {
  searchFetch as directSearchFetch,
  getSearchApiKey,
} from '~/components/Search/search-api-key';
import { isSiteSearchProxyEnabled } from '~/components/Search/site-search-transport';
import { PROXY_ONLY_SEARCH_INDEXES } from '~/server/common/constants';
import { SEARCH_REFUSED_CODE } from '~/shared/constants/search-refusal.constants';

/**
 * Browser site search, two ways, chosen per request by the `siteSearchProxy` flag:
 * - on: `/api/search`, which speaks the Meilisearch protocol and applies the viewer's and the
 *   site's rules server-side. The browser holds no search key.
 * - off: straight to Meilisearch with a per-viewer token (`search-api-key`), or through
 *   `/api/search` when there is no token.
 */
export const SITE_SEARCH_PATH = '/api/search';

/** The Meilisearch path of `url` (`/multi-search`, `/indexes/…`), whichever way it was addressed. */
function meilisearchPath(url: string) {
  const { pathname, search } = new URL(url, 'http://localhost');
  const path = pathname.startsWith(SITE_SEARCH_PATH)
    ? pathname.slice(SITE_SEARCH_PATH.length)
    : pathname;
  return `${path}${search}`;
}

async function proxySearchFetch<T>(path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  headers.delete('Authorization');
  const res = await fetch(`${SITE_SEARCH_PATH}${path}`, {
    ...init,
    headers,
    credentials: 'same-origin',
  });

  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    // Named like meilisearch-js's own errors so `resilientSearchClient` classifies them the same
    // way: a 5xx is the backend being unreachable, a 4xx is Meilisearch rejecting the query.
    // A refusal's code goes in the message too: the Meilisearch adapter rethrows keeping only that.
    const error = new Error(
      body?.code === SEARCH_REFUSED_CODE
        ? SEARCH_REFUSED_CODE
        : body?.message ?? `Search responded ${res.status}`
    );
    error.name = res.status >= 500 ? 'MeiliSearchCommunicationError' : 'MeiliSearchApiError';
    Object.assign(error, { code: body?.code, type: body?.type, httpStatus: res.status });
    throw error;
  }
  return body as T;
}

const isProxyOnly = (indexUid: unknown) =>
  typeof indexUid === 'string' && PROXY_ONLY_SEARCH_INDEXES.includes(indexUid);

type MultiSearchBody = { queries?: { indexUid?: unknown }[]; federation?: unknown };

/**
 * How a token-path request reaches a proxy-only index: a single-index request by its path, a
 * multi-search by the indexes it names. A multi-search mixing both is split, so the other indexes
 * still go straight to Meilisearch exactly as before. A federated one (which the proxy does not
 * serve) goes straight to Meilisearch, whose token refuses the collections part.
 */
function proxyOnlyRoute(path: string, init: RequestInit) {
  const index = /^\/indexes\/([^/?]+)/.exec(path)?.[1];
  if (index !== undefined) return isProxyOnly(decodeURIComponent(index)) ? 'proxy' : 'direct';
  if (!path.startsWith('/multi-search') || typeof init.body !== 'string') return 'direct';
  let body: MultiSearchBody;
  try {
    body = JSON.parse(init.body);
  } catch {
    return 'direct';
  }
  const queries = Array.isArray(body?.queries) ? body.queries : [];
  const proxied = queries.map((query) => isProxyOnly(query?.indexUid));
  if (!proxied.some(Boolean)) return 'direct';
  if (body.federation !== undefined) return 'direct';
  if (proxied.every(Boolean)) return 'proxy';
  return { body, proxied };
}

async function splitMultiSearch<T>(
  path: string,
  init: RequestInit,
  { body, proxied }: { body: MultiSearchBody; proxied: boolean[] },
  direct: (path: string, init: RequestInit) => Promise<T>
): Promise<T> {
  const queries = body.queries ?? [];
  const part = (toProxy: boolean) => ({
    ...init,
    body: JSON.stringify({ ...body, queries: queries.filter((_, i) => proxied[i] === toProxy) }),
  });
  const [fromProxy, fromDirect] = await Promise.all([
    proxySearchFetch<{ results: unknown[] }>(path, part(true)),
    direct(path, part(false)) as Promise<{ results: unknown[] }>,
  ]);
  const proxyResults = [...fromProxy.results];
  const directResults = [...fromDirect.results];
  return {
    ...fromDirect,
    results: proxied.map((toProxy) => (toProxy ? proxyResults.shift() : directResults.shift())),
  } as T;
}

/**
 * `fetch` for site search, returning the parsed body. Shaped as the meilisearch-js `httpClient`
 * option, which must parse and throw on its own. Takes a URL on either the site-search path or the
 * Meilisearch host; only its path is used.
 */
export async function searchFetch<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const path = meilisearchPath(url);
  if (isSiteSearchProxyEnabled() || !(await getSearchApiKey()))
    return proxySearchFetch<T>(path, init);
  const host = (env.NEXT_PUBLIC_SEARCH_HOST ?? '').replace(/\/+$/, '');
  const direct = <R>(p: string, i: RequestInit) => directSearchFetch<R>(`${host}${p}`, i);
  const route = proxyOnlyRoute(path, init);
  if (route === 'proxy') return proxySearchFetch<T>(path, init);
  if (route === 'direct') return direct<T>(path, init);
  return splitMultiSearch<T>(path, init, route, direct);
}

/** The browser's instant-meilisearch client. `searchFetch` decides where each request goes. */
export function createInstantMeiliSearch(
  options: Omit<InstantMeiliSearchOptions, 'httpClient'> = {}
) {
  // meilisearch-js needs an absolute host; `searchFetch` keeps only the path.
  return instantMeiliSearch(`http://localhost${SITE_SEARCH_PATH}`, undefined, {
    ...options,
    httpClient: searchFetch,
  });
}
