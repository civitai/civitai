import type { NextApiRequest } from 'next';

// List of common browser user agents
const browserUserAgents = ['mozilla', 'chrome', 'safari', 'firefox', 'opera', 'edge'];
export function isRequestFromBrowser(req: NextApiRequest): boolean {
  const userAgent = req.headers['user-agent']?.toLowerCase();
  if (!userAgent) return false;

  return browserUserAgents.some((browser) => userAgent.includes(browser));
}

type Protocol = 'https' | 'http';
type ProtocolRequest = { headers: { 'x-forwarded-proto'?: string; origin?: string } };
export function getProtocol(req: ProtocolRequest): Protocol {
  const hasHttps = req.headers['origin']?.startsWith('https');
  const proto = hasHttps ? 'https' : req.headers['x-forwarded-proto'] ?? 'http';
  return proto as Protocol;
}

/** A `?` is only a separator when what follows it opens a new param. */
const RESUMES_QUERY = /^&*[^&=?]+=/;

/**
 * Next re-serialises `req.url` through `URLSearchParams` before an API route runs
 * (`normalizeCdnUrl`, next/dist/server/route-modules/route-module.js), which
 * percent-encodes the client's stray `?` and the `=` behind it. `req.query` still
 * holds both raw, so the encoding here is Next's own and never the caller's.
 */
const ENCODED_SEPARATORS = /%3F|%3D/gi;
const decodeSeparators = (query: string) =>
  query.replace(ENCODED_SEPARATORS, (match) => (match.toLowerCase() === '%3f' ? '?' : '='));

/**
 * Rejoin a query a client split by appending a second `?…` to a URL that already
 * carried one, e.g. `…/models/1?fileId=2?type=Model&token=abc`. RFC 3986 makes
 * that one param — `fileId=2?type=Model` — so the id fails to parse and every
 * later param is swallowed, `token` (API-key auth) included.
 *
 * A `?` is legal INSIDE a value, so only a `?` followed by `key=` is treated as a
 * separator; `?token=ab?cd` is left alone.
 *
 * Rewrites `req.url` as well as `req.query`, because auth re-parses the url.
 * Only a param that is missing or itself split is written, so a repair can never
 * replace a value that arrived intact — including the path params Next spreads
 * over the query string.
 */
export function repairSplitQueryString(req: NextApiRequest): boolean {
  const url = req.url;
  if (!url || !req.query) return false;

  const start = url.indexOf('?');
  if (start === -1) return false;

  const raw = decodeSeparators(url.slice(start + 1));
  const [head, ...rest] = raw.split('?');
  if (!rest.length) return false;

  let repaired = head;
  let split = false;
  for (const segment of rest) {
    if (!RESUMES_QUERY.test(segment)) {
      repaired += `?${segment}`;
      continue;
    }
    repaired += `&${segment.replace(/^&+/, '')}`;
    split = true;
  }
  if (!split) return false;

  const params = new URLSearchParams(repaired);
  for (const key of new Set(params.keys())) {
    const current = req.query[key];
    if (current !== undefined && !(typeof current === 'string' && current.includes('?'))) continue;
    const values = params.getAll(key);
    req.query[key] = values.length > 1 ? values : values[0];
  }

  // Drop the split entries themselves, so `req.query` never carries both a
  // `fileId=2?type` key and the repaired pair it was split into.
  for (const key of new URLSearchParams(raw).keys()) {
    if (key.includes('?')) delete req.query[key];
  }

  req.url = `${url.slice(0, start)}?${repaired}`;
  return true;
}
