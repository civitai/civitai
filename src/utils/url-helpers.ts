import { safeReturnPath } from '@civitai/auth/client';

/**
 * Collapses anything that isn't a same-origin path to `fallback`, so a caller-supplied
 * `returnUrl` can't be turned into an off-site redirect. The rule is `safeReturnPath` from
 * `@civitai/auth/client` (browser-safe), so it cannot drift from the auth package's.
 */
export function safeInternalPath(raw: unknown, fallback: string): string {
  return safeReturnPath(raw) ?? fallback;
}

/**
 * Like `safeInternalPath`, but also accepts an absolute URL on `origin`, reduced to its path. The
 * reduced path goes through the same rule, so an absolute URL can't smuggle in a path that a
 * browser would resolve off-origin.
 */
export function safeSameOriginPath(raw: unknown, origin: string, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  if (raw.startsWith('/')) return safeReturnPath(raw) ?? fallback;
  try {
    const url = new URL(raw);
    if (url.origin !== new URL(origin).origin) return fallback;
    return safeReturnPath(url.pathname + url.search + url.hash) ?? fallback;
  } catch {
    return fallback;
  }
}
