import type { IncomingMessage } from 'http';
import { SHELL_BYPASS_PARAM, SHELL_BYPASS_VALUE } from '~/shared/constants/shell.constants';

/**
 * The canonical path of a static shell route: the ONE origin URL an edge cache may send every
 * shell-eligible request of the route to, so that one cached object answers all of them. The
 * browser keeps its own URL (the client reads the real id from `location`); the edge passes that
 * URL in `SHELL_ORIGINAL_URL_HEADER`.
 *
 * Nothing reaches the canonical path unless the edge rewrites to it. A request there is answered
 * with the route's shell when `shellRefusal` (judged on the ORIGINAL URL) gives it, and otherwise
 * with a bounce — a 307 back to the original URL with `?civ-shell=0`, which the edge does not
 * rewrite — never with a render of the canonical path itself.
 *
 * Pure (no server infrastructure), so the page's getServerSideProps and the tests share it.
 */

/** Request header carrying the path and query the browser asked for before the edge rewrote it. */
export const SHELL_ORIGINAL_URL_HEADER = 'x-civ-shell-orig';

export const SHELL_CANONICAL_ROUTES = {
  images: {
    /** Not an image id: `/images/[imageId]` serves only numeric ids. */
    canonicalPath: '/images/shell',
    /** The only original paths accepted: an image id. */
    originalPath: /^\/images\/[0-9]{1,16}$/,
    /** Where a request with no usable original URL is sent. */
    fallback: '/images',
  },
} as const;

export type ShellCanonicalRouteName = keyof typeof SHELL_CANONICAL_ROUTES;

const MAX_ORIGINAL_URL_LENGTH = 2048;
/** Printable ASCII but `#`: no whitespace, no CR/LF, no fragment, nothing outside the query. */
const QUERY_CHARS = /^[\x21\x22\x24-\x7E]*$/;

/** The path of a request URL (`req.url` is a path and query; never trusted to be anything else). */
export function requestPath(url: string | undefined) {
  return (url ?? '').split('?')[0] ?? '';
}

/** True when `url` (a request's path and query) is on `route`'s canonical path. */
export function isCanonicalShellPath(route: ShellCanonicalRouteName, url: string | undefined) {
  return requestPath(url) === SHELL_CANONICAL_ROUTES[route].canonicalPath;
}

/** The header split at its first `?`, when it is one string; `null` for a missing or repeated one. */
function splitOriginal(value: string | string[] | undefined) {
  if (typeof value !== 'string') return null;
  const queryAt = value.indexOf('?');
  return queryAt === -1
    ? { path: value, query: '' }
    : { path: value.slice(0, queryAt), query: value.slice(queryAt + 1) };
}

/** True when `path` is exactly a path of the route: digits-only id, nothing else. */
function isOriginalPath(route: ShellCanonicalRouteName, path: string) {
  return SHELL_CANONICAL_ROUTES[route].originalPath.test(path);
}

/**
 * The original URL from the header, or `null` unless it is exactly a path of the route plus an
 * optional, acceptable query. Anything else — an absolute or protocol-relative URL, another path,
 * a trailing slash, a backslash, encoded or dot segments, whitespace or control characters
 * anywhere, a fragment, an over-long value, a repeated header — is `null`, and the request is
 * refused the shell.
 */
export function shellOriginalUrl(
  route: ShellCanonicalRouteName,
  value: string | string[] | undefined
): string | null {
  const parts = splitOriginal(value);
  if (!parts || !isOriginalPath(route, parts.path)) return null;
  if (typeof value !== 'string' || value.length > MAX_ORIGINAL_URL_LENGTH) return null;
  if (!QUERY_CHARS.test(parts.query)) return null;
  return value;
}

/**
 * Where a canonical-path request that is not answered with the shell goes, always a path on this
 * host: its original URL with `civ-shell=0` (so the edge leaves it alone and the origin renders it
 * in full); the original PATH alone with `civ-shell=0` when only its query is unacceptable; or the
 * route's fallback when the path itself is missing or invalid.
 */
export function shellBounceLocation(route: ShellCanonicalRouteName, req: IncomingMessage) {
  const value = req.headers[SHELL_ORIGINAL_URL_HEADER];
  const parts = splitOriginal(value);
  if (!parts || !isOriginalPath(route, parts.path)) return SHELL_CANONICAL_ROUTES[route].fallback;
  if (!shellOriginalUrl(route, value)) return SHELL_CANONICAL_ROUTES[route].fallback;
  // Re-serialised, so the Location carries only percent-encoded query text.
  const params = new URLSearchParams(shellOriginalUrl(route, value) ? parts.query : '');
  params.set(SHELL_BYPASS_PARAM, SHELL_BYPASS_VALUE);
  return `${parts.path}?${params.toString()}`;
}
