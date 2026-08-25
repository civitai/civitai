import type { NextApiRequest } from 'next';
import { env } from '~/env/server';

// List of common browser user agents
const browserUserAgents = ['mozilla', 'chrome', 'safari', 'firefox', 'opera', 'edge'];
export function isRequestFromBrowser(req: NextApiRequest): boolean {
  const userAgent = req.headers['user-agent']?.toLowerCase();
  if (!userAgent) return false;

  return browserUserAgents.some((browser) => userAgent.includes(browser));
}

/**
 * Should this caller's model download resolve to an origin-direct URL rather than
 * the CDN-fronted one?
 *
 * Some internal clients download the same file with many parallel connections,
 * which the CDN does not speed up and the storage origin does. Serving them
 * directly is measurably faster for those clients and measurably more expensive
 * for us, so it is an allowlist keyed on user agent, empty by default.
 *
 * 🔴 This is NOT an access control and must never be used as one. A user agent is
 * caller-supplied and trivially spoofed. It is safe here only because of what it
 * gates: the caller receives the SAME file it was already entitled to, resolved
 * moments earlier by the route's own auth, ownership, paid-access and blocklist
 * checks — spoofing it changes which host serves those bytes, not whether the
 * caller may have them. There is no exposure in a wrong `true`.
 *
 * 🔴 There IS a cost in one. A wrong `true` does not merely use more bandwidth: it
 * moves that download from zero-rated CDN egress to billed origin egress. And the
 * incentive runs the wrong way — direct is SLOWER single-stream, so it rewards
 * precisely the high-volume parallel downloader who would benefit from copying an
 * allowlisted agent string. This allowlist names a string, not a population; it is
 * a routing hint for clients we operate, and it contains no one who does not
 * choose to be contained. Treat the entries as a cost decision, keep them narrow,
 * and if containment ever needs to be real, replace this with an authenticated
 * signal rather than hardening the string match.
 */

/**
 * Shortest allowlist entry that is meaningful. A one- or two-character entry
 * matches essentially every real user agent — `"c"` is inside
 * `Mozilla/5.0 (Macintosh…)` — so a truncated paste would silently roll direct
 * resolution out to everyone.
 *
 * Three is not a magic number, and it is not a guarantee either: a 3-character
 * fragment like `"moz"` or `"mac"` still matches essentially every browser. What
 * this closes is the accident — a 1-2 character truncation — not a deliberately
 * broad entry, which no length check can catch. Keep the entries specific.
 */
const MIN_ALLOWLIST_ENTRY_LENGTH = 3;

export function shouldResolveDirect(req: NextApiRequest): boolean {
  const allowlist = env.STORAGE_RESOLVER_DIRECT_USER_AGENTS;
  // Redundant with the length check below, and kept for readability: it states
  // that an absent allowlist is the off switch.
  //
  // 🔴 It does NOT catch the off switch an operator is most likely to reach for.
  // `STORAGE_RESOLVER_DIRECT_USER_AGENTS=""` parses to `['']`, not `[]` — the
  // schema's `.default([])` applies only when the key is ABSENT, and the
  // comma-splitter does not drop empty segments. So an empty-string value lands
  // one entry long and survives this line; what actually disables it is the
  // per-entry length floor. A trailing comma produces the same shape.
  if (!allowlist?.length) return false;

  const userAgent = req.headers['user-agent']?.toLowerCase();
  if (!userAgent) return false;

  return allowlist.some((entry) => {
    const needle = entry.trim().toLowerCase();
    return needle.length >= MIN_ALLOWLIST_ENTRY_LENGTH && userAgent.includes(needle);
  });
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
