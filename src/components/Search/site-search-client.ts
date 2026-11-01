import type { InstantMeiliSearchOptions } from '@meilisearch/instant-meilisearch';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { env } from '~/env/client';
import { searchFetch as directSearchFetch } from '~/components/Search/search-api-key';
import { isSiteSearchProxyEnabled } from '~/components/Search/site-search-transport';

/**
 * Browser site search, two ways, chosen per request by the `siteSearchProxy` flag:
 * - on: `/api/search`, which speaks the Meilisearch protocol and applies the viewer's and the
 *   site's rules server-side. The browser holds no search key.
 * - off: straight to Meilisearch with a per-viewer token (`search-api-key`).
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
  const res = await fetch(`${SITE_SEARCH_PATH}${path}`, { ...init, credentials: 'same-origin' });

  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    // Named like meilisearch-js's own errors so `resilientSearchClient` classifies them the same
    // way: a 5xx is the backend being unreachable, a 4xx is Meilisearch rejecting the query.
    const error = new Error(body?.message ?? `Search responded ${res.status}`);
    error.name = res.status >= 500 ? 'MeiliSearchCommunicationError' : 'MeiliSearchApiError';
    Object.assign(error, { code: body?.code, type: body?.type, httpStatus: res.status });
    throw error;
  }
  return body as T;
}

/**
 * `fetch` for site search, returning the parsed body. Shaped as the meilisearch-js `httpClient`
 * option, which must parse and throw on its own. Takes a URL on either the site-search path or the
 * Meilisearch host; only its path is used.
 */
export function searchFetch<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const path = meilisearchPath(url);
  if (isSiteSearchProxyEnabled()) return proxySearchFetch<T>(path, init);
  const host = (env.NEXT_PUBLIC_SEARCH_HOST ?? '').replace(/\/+$/, '');
  return directSearchFetch<T>(`${host}${path}`, init);
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
