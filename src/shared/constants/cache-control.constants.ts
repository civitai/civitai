/**
 * The platform's safe default `Cache-Control` for API responses: usable by the
 * caller's own browser only, and revalidated every time.
 *
 * Single-sourced so the proxy-level default (`apiCacheMiddleware`) and the
 * endpoint wrappers that fall back to it cannot drift apart. Deliberately a bare
 * string constant with no imports — the proxy graph loads it too.
 */
export const PRIVATE_CACHE_CONTROL = 'max-age=0, private, no-cache';
