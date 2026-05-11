import type { ParsedUrlQuery } from 'querystring';
import { isDefined } from '~/utils/type-guards';

/**
 * Serialize a Next.js `ctx.query` object into a `?...`-prefixed query string,
 * skipping the named path params. Use for catch-all canonical-slug redirects
 * (e.g. `[id]/[[...slug]]`) to preserve inbound deep-link params like
 * `?highlight=`, `?commentParentType=`, etc. Returns an empty string when no
 * params remain after exclusion, so it can be concatenated unconditionally.
 */
export function buildPassthroughQuery(
  query: ParsedUrlQuery,
  exclude: readonly string[] = ['id', 'slug']
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (exclude.includes(key)) continue;
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, v);
    } else if (value != null) {
      params.append(key, value);
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function parseNumericString(value: unknown) {
  return typeof value === 'string'
    ? parseInt(value, 10)
    : typeof value === 'number'
    ? value
    : undefined;
}

export function parseNumericStringArray(value: unknown) {
  const parsed = Array.isArray(value)
    ? value.map(parseNumericString)
    : typeof value === 'string' || typeof value === 'number'
    ? [parseNumericString(value)]
    : undefined;
  return parsed ? parsed.filter(isDefined) : undefined;
}

export function parseStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  if (typeof value === 'string') {
    return value.split(',').filter(Boolean);
  }
  return undefined;
}
