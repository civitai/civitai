import {
  allCookieNames,
  LEGACY_SESSION_COOKIE_BASE,
  SESSION_COOKIE_BASE,
} from '@civitai/auth/client';

/**
 * The pure half of the beacon-go shadow sampler (`./beacon-go-shadow`): what is forwarded for a
 * sampled /api/internal/ping or /api/internal/pulse request. Its only import is the browser-safe
 * `@civitai/auth/client`, so beacon-go's golden fixture generator
 * (apps/beacon-go/testdata/golden/gen.ts) builds its samples with this exact code.
 */

/**
 * Every spelling of the session cookies, derived as feed-go-shadow derives its set: the hub cookie
 * (beacon-go resolves the viewer from it) and the legacy one, under each prefix. It covers the five
 * names `requestCarriesCallerCredentials` checks for `Vary` / `Cache-Control` (plus
 * `__Host-civitai-token`, which nothing reads; forwarding it changes no outcome).
 */
const SESSION_COOKIE_NAMES = new Set([
  ...allCookieNames(SESSION_COOKIE_BASE),
  ...allCookieNames(LEGACY_SESSION_COOKIE_BASE),
]);

/** Headers forwarded verbatim when present. */
export const BEACON_GO_COPIED_HEADERS = [
  'host',
  'origin',
  'referer',
  'user-agent',
  'content-type',
  'cf-ipcountry',
  'cf-connecting-ip',
  'x-client-ip',
  'x-forwarded-for',
  'fastly-client-ip',
  'true-client-ip',
  'x-real-ip',
  'x-cluster-client-ip',
  'x-forwarded',
  'forwarded-for',
  'forwarded',
  'x-appengine-user-ip',
  'x-civitai-verified-bot',
  'if-none-match',
  'if-modified-since',
] as const;

/** The response headers the endpoint decides (beacon-go's `ComparedHeaders`). */
export const BEACON_GO_COMPARED_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-allow-credentials',
  'access-control-max-age',
  'vary',
  'cache-control',
  'etag',
  'content-type',
  'set-cookie',
] as const;

function headerValue(v: string | string[] | number | undefined): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.join(', ');
  return undefined;
}

/**
 * Keep only the session cookies of a raw `Cookie` header, split the way
 * `requestCarriesCallerCredentials` splits it (a pair without `=` is a name), bytes unchanged.
 */
export function pickBeaconSessionCookies(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const kept: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    const name = (eq === -1 ? part : part.slice(0, eq)).trim();
    if (name && SESSION_COOKIE_NAMES.has(name)) kept.push(part.trim());
  }
  return kept.length ? kept.join('; ') : undefined;
}

export type ShadowRequestLike = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};

/** The request headers beacon-go needs, and nothing else (see the module doc). */
export function pickBeaconShadowHeaders(req: ShadowRequestLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of BEACON_GO_COPIED_HEADERS) {
    const v = headerValue(req.headers[name]);
    if (v !== undefined) out[name] = v;
  }
  const cookie = pickBeaconSessionCookies(headerValue(req.headers.cookie));
  if (cookie) out.cookie = cookie;
  if (headerValue(req.headers.authorization)) out.authorization = 'present';
  return out;
}

/**
 * `req.body` as a string: itself when Next left it a string, else its JSON (a parsed JSON body; a
 * urlencoded body's object, whose outcome does not depend on its content). `bodyIsString` tells
 * beacon-go which, so it can check its own content-type parse against Next's.
 */
export function shadowBody(body: unknown): { body: string; bodyIsString: boolean } {
  if (typeof body === 'string') return { body, bodyIsString: true };
  return { body: JSON.stringify(body) ?? '', bodyIsString: false };
}

export type ResponseHeadersLike = {
  getHeader(name: string): string | string[] | number | undefined;
};

/** The endpoint-decided response headers, a Set-Cookie redacted (beacon-go only needs to see one). */
export function pickBeaconResponseHeaders(res: ResponseHeadersLike) {
  const out: Record<string, string> = {};
  for (const name of BEACON_GO_COMPARED_HEADERS) {
    const v = headerValue(res.getHeader(name));
    if (v === undefined) continue;
    out[name] = name === 'set-cookie' ? '<redacted>' : v;
  }
  return out;
}

/**
 * `req.url` without its query string, plus a marker for the query: `''` (none), `'present'`, or
 * `'token'` when it holds a non-empty `token` parameter (an API key). beacon-go only needs to know
 * that a query, or a token, was there: the query itself, and above all the key, is never forwarded.
 */
export function shadowTarget(url: string | undefined): {
  target: string;
  query: '' | 'present' | 'token';
} {
  const raw = url ?? '';
  const q = raw.indexOf('?');
  if (q < 0) return { target: raw, query: '' };
  let token = false;
  try {
    token = !!new URLSearchParams(raw.slice(q + 1)).get('token');
  } catch {
    token = false;
  }
  return { target: raw.slice(0, q), query: token ? 'token' : 'present' };
}

/** The POST body: the request as Node saw it, and what Node answered and wrote. */
export function buildBeaconGoShadowPayload(parts: {
  method: string;
  /** `req.url` as Node saw it; only its path and the shadowTarget marker are sent. */
  target: string;
  headers: Record<string, string>;
  body: string;
  bodyIsString: boolean;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  writes: { table: string; body: string }[];
  /**
   * /api/track/batch: how many hatted entities the handler passed to awardViewPoints. Sent only when
   * above 0 (beacon-go reads absent as 0), so the other beacons' payloads are unchanged.
   */
  hattedViews?: number;
}): string {
  const { target, query } = shadowTarget(parts.target);
  return JSON.stringify({
    method: parts.method,
    target,
    query,
    headers: parts.headers,
    body: parts.body,
    bodyIsString: parts.bodyIsString,
    node: {
      status: parts.status,
      headers: parts.responseHeaders,
      body: parts.responseBody,
      writes: parts.writes,
      ...(parts.hattedViews ? { hattedViews: parts.hattedViews } : {}),
    },
  });
}
