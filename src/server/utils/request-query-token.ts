import type { NextApiRequest } from 'next';

/**
 * Reads both `req.query` (Next's parse) and the raw `req.url`, because
 * `getServerAuthSession` reads `req.url` directly; dropping either lets a
 * `?token=` credential go unseen.
 */
export function requestCarriesQueryToken(req: NextApiRequest): boolean {
  if (hasNonEmpty((req.query as Record<string, unknown> | undefined)?.token)) return true;

  const queryString = req.url?.split('?')[1];
  if (queryString && hasNonEmpty(new URLSearchParams(queryString).get('token'))) return true;

  return false;
}

/** Truthy for a non-empty string, or an array containing one. */
function hasNonEmpty(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.some((v) => typeof v === 'string' && v.length > 0);
  return false;
}
