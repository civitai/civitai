import { safeDecodeURIComponent } from '~/utils/string-helpers';

export type RouteQuery = Partial<Record<string, string | string[]>>;

export type RouteSegment = {
  value: string;
  /** The route param Next matched this segment to. */
  param?: { name: string; catchAll: boolean };
  /** The segment's value also appears as a query-string value. */
  inQueryString: boolean;
};

/**
 * The non-empty path segments of `url`, each with the route param it was matched to, by exact
 * whole-segment equality (raw, then decoded) against a value in `query`. Next merges the route
 * params and the query string into one `query`; only keys absent from the URL's query string are
 * route params, so a caller's query string can never name or rename a segment. Null when `url`
 * does not parse.
 */
export function routeSegments(
  url: string | undefined,
  query: RouteQuery | undefined
): { pathname: string; segments: RouteSegment[] } | null {
  let parsed: URL;
  try {
    parsed = new URL(url ?? '/', 'http://x');
  } catch {
    return null;
  }
  const queryStringKeys = new Set(parsed.searchParams.keys());
  const queryStringValues = new Set(parsed.searchParams.values());
  const valueToParam = new Map<string, RouteSegment['param']>();
  for (const [name, value] of Object.entries(query ?? {})) {
    if (queryStringKeys.has(name)) continue;
    const catchAll = Array.isArray(value);
    for (const v of catchAll ? value : [value])
      if (typeof v === 'string' && v.length >= 1) valueToParam.set(v, { name, catchAll });
  }
  const segments = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((value) => {
      const decoded = safeDecodeURIComponent(value);
      return {
        value,
        param: valueToParam.get(value) ?? valueToParam.get(decoded),
        inQueryString: queryStringValues.has(value) || queryStringValues.has(decoded),
      };
    });
  return { pathname: parsed.pathname, segments };
}
