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

/**
 * Rejoin a query string a client built by appending a SECOND `?…` to a URL that
 * already carried one — `…/models/1?fileId=2?type=Model&token=abc`.
 *
 * That is a legal URI whose query holds one param, `fileId=2?type=Model`, so
 * nothing upstream repairs it: the id fails to parse and every param the client
 * meant to send before the stray `?` is swallowed into it — including `token`,
 * which the endpoint reads for API-key auth.
 *
 * Appending `?type=…&format=…` or `?token=…` to a `downloadUrl` we handed out is
 * a long-standing client habit that was harmless while those URLs had no query
 * of their own. `createModelFileDownloadUrl` now pins `?fileId=<id>` into them,
 * so the same habit produces the broken shape above.
 *
 * `%3F` is left alone — only a raw `?`, which cannot be part of a value the
 * client meant to send, is treated as a separator.
 *
 * Keys that reached `req.query` from the ROUTE PATH are never overwritten, so a
 * repaired param cannot rewrite the resource being addressed.
 */
export function repairSplitQueryString(req: NextApiRequest): boolean {
  const url = req.url;
  if (!url || !req.query) return false;

  const start = url.indexOf('?');
  if (start === -1) return false;

  const raw = url.slice(start + 1);
  if (!raw.includes('?')) return false;

  const repaired = raw.split('?').join('&');
  const pathOwned = new Set(Object.keys(req.query));
  for (const key of new URLSearchParams(raw).keys()) pathOwned.delete(key);

  const params = new URLSearchParams(repaired);
  for (const key of new Set(params.keys())) {
    if (pathOwned.has(key)) continue;
    const values = params.getAll(key);
    req.query[key] = values.length > 1 ? values : values[0];
  }

  req.url = `${url.slice(0, start)}?${repaired}`;
  return true;
}
