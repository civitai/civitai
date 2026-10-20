import type { InstantMeiliSearchOptions } from '@meilisearch/instant-meilisearch';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { env } from '~/env/client';

/**
 * The key the browser sends to Meilisearch: a short-lived per-viewer token from
 * `/api/search/token`, or the shared public key when the server has no signing key configured.
 *
 * Held in memory only. Every change of signed-in identity (sign-in, sign-out, account switch,
 * impersonation) is a full page load, which starts this module empty.
 */

const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 1000;

type CachedKey = { key: string | undefined; refreshAt: number };

let cached: CachedKey | undefined;
let pending: Promise<string | undefined> | undefined;

async function requestKey(): Promise<CachedKey> {
  const fallback = env.NEXT_PUBLIC_SEARCH_CLIENT_KEY;
  try {
    const res = await fetch('/api/search/token', { credentials: 'same-origin', cache: 'no-store' });
    if (res.ok) {
      const body = (await res.json()) as { token: string | null; expiresAt?: number };
      if (body.token && body.expiresAt)
        return { key: body.token, refreshAt: body.expiresAt - REFRESH_BEFORE_EXPIRY_MS };
      return { key: fallback, refreshAt: Infinity };
    }
  } catch {
    // Network failure: fall through and try again shortly.
  }
  return { key: fallback, refreshAt: Date.now() + RETRY_AFTER_FAILURE_MS };
}

export function getSearchApiKey(): Promise<string | undefined> {
  if (cached && Date.now() < cached.refreshAt) return Promise.resolve(cached.key);
  pending ??= requestKey()
    .then((next) => {
      cached = next;
      return next.key;
    })
    .finally(() => {
      pending = undefined;
    });
  return pending;
}

function sendWithKey(url: string, init: RequestInit, key: string | undefined) {
  const headers = new Headers(init.headers);
  if (key) headers.set('Authorization', `Bearer ${key}`);
  else headers.delete('Authorization');
  return fetch(url, { ...init, headers });
}

/**
 * `fetch` for Meilisearch that authenticates with the current key and returns the parsed body.
 * Shaped as the meilisearch-js `httpClient` option, which must parse and throw on its own.
 */
export async function searchFetch<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const key = await getSearchApiKey();
  let res = await sendWithKey(url, init, key);

  // An expired or revoked key: drop it and retry once with a fresh one.
  if ((res.status === 401 || res.status === 403) && cached?.key === key) {
    cached = undefined;
    const fresh = await getSearchApiKey();
    if (fresh !== key) res = await sendWithKey(url, init, fresh);
  }

  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    // Named like meilisearch-js's own error so `resilientSearchClient` classifies it the same way.
    const error = new Error(body?.message ?? `Meilisearch responded ${res.status}`);
    error.name = 'MeiliSearchApiError';
    Object.assign(error, { code: body?.code, type: body?.type, httpStatus: res.status });
    throw error;
  }
  return body as T;
}

/** The browser's instant-meilisearch client. Requests carry the current key, not a fixed one. */
export function createInstantMeiliSearch(
  options: Omit<InstantMeiliSearchOptions, 'httpClient'> = {}
) {
  return instantMeiliSearch(
    env.NEXT_PUBLIC_SEARCH_HOST as string,
    env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
    {
      ...options,
      httpClient: searchFetch,
    }
  );
}

/** Test seam: forget the cached key. */
export function resetSearchApiKey() {
  cached = undefined;
  pending = undefined;
}
