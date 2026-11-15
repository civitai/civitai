/**
 * The pure half of the beacon-go shadow sampler (`./beacon-go-shadow`): what is forwarded for a
 * sampled /api/internal/ping or /api/internal/pulse request. Import-free, so beacon-go's golden
 * fixture generator (apps/beacon-go/testdata/golden/gen.ts) builds its samples with this exact code.
 */

/**
 * Every spelling of the session cookies (SESSION_COOKIE_NAMES in endpoint-helpers.ts): beacon-go
 * needs the civ-token ones to resolve the viewer, and all five to decide `Vary` / `Cache-Control`
 * the way `requestCarriesCallerCredentials` does.
 */
const SESSION_COOKIE_NAMES = new Set([
  '__Host-civ-token',
  '__Secure-civ-token',
  'civ-token',
  '__Secure-civitai-token',
  'civitai-token',
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
  'cache-control',
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

/** The POST body: the request as Node saw it, and what Node answered and wrote. */
export function buildBeaconGoShadowPayload(parts: {
  method: string;
  target: string;
  headers: Record<string, string>;
  body: string;
  bodyIsString: boolean;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  writes: { table: string; body: string }[];
}): string {
  return JSON.stringify({
    method: parts.method,
    target: parts.target,
    headers: parts.headers,
    body: parts.body,
    bodyIsString: parts.bodyIsString,
    node: {
      status: parts.status,
      headers: parts.responseHeaders,
      body: parts.responseBody,
      writes: parts.writes,
    },
  });
}
