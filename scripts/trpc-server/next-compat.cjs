'use strict';
/**
 * The parts of Next's router-server and base-server that the standalone tRPC server still has
 * to do itself, because it calls the compiled pages-API route modules directly instead of going
 * through `next/dist/server/lib/start-server`.
 *
 * Everything here is built from Next's OWN helpers (the same modules router-server,
 * resolve-routes and base-server call) and from the build's own `routes-manifest.json`, so the
 * rules are the ones Next applies, not a re-statement of them. Each function names the Next
 * source it ports. When a Next bump changes one of those, the parity harness
 * (`scripts/trpc-server/parity/`) is what notices: it sends the same requests to `server.js` and
 * to this server and diffs the responses.
 *
 * Plain CommonJS with no compile step, so it ships as-is in the runner image. Every require below
 * is a literal at module scope on purpose: `scripts/ci/assert-standalone-boot-graph.mjs` reads
 * them from this file and loads them from the shipped tree, so a Next internal that the
 * standalone trace dropped fails the image build instead of the first request.
 */

// Plain CommonJS that runs without a compile step, so `require` is the only way to load here.
/* eslint-disable @typescript-eslint/no-var-requires */
const nodeUrl = require('node:url');
const { filterInternalHeaders } = require('next/dist/server/lib/server-ipc/utils');
const { normalizeRepeatedSlashes, DecodeError } = require('next/dist/shared/lib/utils');
const { parseUrl } = require('next/dist/shared/lib/router/utils/parse-url');
const { getPathMatch } = require('next/dist/shared/lib/router/utils/path-match');
const {
  prepareDestination,
  matchHas,
  compileNonPath,
} = require('next/dist/shared/lib/router/utils/prepare-destination');
const { modifyRouteRegex, getRedirectStatus } = require('next/dist/lib/redirect-status');
const { stringifyQuery } = require('next/dist/server/server-route-utils');
const { addRequestMeta } = require('next/dist/server/request-meta');
const { normalizeLocalePath } = require('next/dist/shared/lib/i18n/normalize-locale-path');
const { addPathPrefix } = require('next/dist/shared/lib/router/utils/add-path-prefix');
const { getRouteRegex } = require('next/dist/shared/lib/router/utils/route-regex');
const { getRouteMatcher } = require('next/dist/shared/lib/router/utils/route-matcher');
const {
  NEXT_QUERY_PARAM_PREFIX,
  NEXT_INTERCEPTION_MARKER_PREFIX,
} = require('next/dist/lib/constants');
const { RedirectStatusCode } = require('next/dist/client/components/redirect-status-code');

/**
 * `buildCustomRoute` from `next/dist/server/lib/router-utils/filesystem.js` (module-local there,
 * so it cannot be imported): the matcher router-server builds for each `headers()` and
 * `redirects()` entry of the routes manifest.
 */
function buildCustomRoute(type, item, basePath, caseSensitive) {
  const restrictedRedirectPaths = ['/_next'].map((p) => (basePath ? `${basePath}${p}` : p));
  const match = getPathMatch(item.source, {
    strict: true,
    removeUnnamedParams: true,
    regexModifier: (regex) =>
      item.internal
        ? regex
        : modifyRouteRegex(regex, type === 'redirect' ? restrictedRedirectPaths : undefined),
    sensitive: caseSensitive,
  });
  return { ...item, match };
}

/**
 * Builds the routing rules this server applies before a route module runs. Throws when the
 * manifest uses a feature this server does not implement, so the process refuses to start
 * rather than serving requests Next would have routed differently.
 */
function createRouting({ routesManifest, nextConfig }) {
  const basePath = nextConfig.basePath || '';
  if (basePath) throw new Error('trpc-server: basePath is not supported');
  if (nextConfig.trailingSlash)
    throw new Error('trpc-server: trailingSlash: true is not supported');

  const rewrites = routesManifest.rewrites || {};
  const beforeFiles = Array.isArray(rewrites) ? [] : rewrites.beforeFiles || [];
  if (beforeFiles.length > 0) {
    // A beforeFiles rewrite runs before the filesystem match, so it could send a request for an
    // existing route somewhere else. This server does not implement rewrites.
    throw new Error('trpc-server: beforeFiles rewrites are not supported');
  }
  if ((routesManifest.onMatchHeaders || []).length > 0) {
    throw new Error('trpc-server: onMatchHeaders are not supported');
  }

  const caseSensitive = Boolean(
    nextConfig.experimental && nextConfig.experimental.caseSensitiveRoutes
  );
  const headers = (routesManifest.headers || []).map((item) =>
    buildCustomRoute('header', item, basePath, caseSensitive)
  );
  const redirects = (routesManifest.redirects || []).map((item) =>
    buildCustomRoute('redirect', item, basePath, caseSensitive)
  );
  const i18n = nextConfig.i18n || null;

  return { headers, redirects, i18n };
}

/**
 * The pathname a custom route is matched against: resolve-routes `handleRoute`. Under i18n the
 * request path carries the default locale (`/en/api/...`) for user routes, and has it stripped
 * again for internal ones such as the trailing-slash redirect.
 */
function routeMatchPathname(routing, parsedPathname, route) {
  if (!routing.i18n || !route.internal) return parsedPathname;
  const localeResult = normalizeLocalePath(parsedPathname, routing.i18n.locales);
  if (localeResult.detectedLocale === routing.i18n.defaultLocale) return localeResult.pathname;
  return parsedPathname;
}

/**
 * What router-server decides for a request before it invokes any route, ported from
 * `resolve-routes.js` (`resolveRoutes`, the headers and redirects branches) and the redirect
 * handling in `router-server.js`. Returns one of:
 *   { redirect: { statusCode, destination } }  — answer with a redirect, apply no headers
 *   { headers }                                 — the config headers to set, then route
 */
function resolveRouting(routing, req) {
  const urlNoQuery = (req.url || '').split('?', 1)[0];

  // Repeated slashes and backslashes: a 308 to the normalised URL, before anything else.
  if (urlNoQuery && /(\\|\/\/)/.test(urlNoQuery)) {
    return {
      redirect: {
        statusCode: RedirectStatusCode.PermanentRedirect,
        destination: nodeUrl.format(parseUrl(normalizeRepeatedSlashes(req.url))),
      },
    };
  }

  const parsedUrl = parseUrl(req.url || '');
  addRequestMeta(req, 'initQuery', { ...parsedUrl.query });

  // i18n: the default locale is added to the path for matching (resolve-routes ~L141).
  let pathname = parsedUrl.pathname || '/';
  if (routing.i18n) {
    const initial = normalizeLocalePath(pathname, routing.i18n.locales);
    if (!initial.detectedLocale && !initial.pathname.startsWith('/_next/')) {
      pathname =
        initial.pathname === '/'
          ? `/${routing.i18n.defaultLocale}`
          : addPathPrefix(initial.pathname || '', `/${routing.i18n.defaultLocale}`);
    }
  }

  // headers() entries come first in the route list and accumulate.
  const resHeaders = {};
  for (const route of routing.headers) {
    let params = route.match(routeMatchPathname(routing, pathname, route));
    if ((route.has || route.missing) && params) {
      const hasParams = matchHas(req, parsedUrl.query, route.has, route.missing);
      if (hasParams) Object.assign(params, hasParams);
      else params = false;
    }
    if (!params) continue;
    const hasParams = Object.keys(params).length > 0;
    for (const header of route.headers) {
      let { key, value } = header;
      if (hasParams) {
        key = compileNonPath(key, params);
        value = compileNonPath(value, params);
      }
      if (key.toLowerCase() === 'set-cookie') {
        if (!Array.isArray(resHeaders[key])) {
          const val = resHeaders[key];
          resHeaders[key] = typeof val === 'string' ? [val] : [];
        }
        resHeaders[key].push(value);
      } else {
        resHeaders[key] = value;
      }
    }
  }

  // redirects() next: the first match answers, and router-server then applies NO headers
  // (resolveRoutes returns `resHeaders: null` for a redirect).
  for (const route of routing.redirects) {
    let params = route.match(routeMatchPathname(routing, pathname, route));
    if ((route.has || route.missing) && params) {
      const hasParams = matchHas(req, parsedUrl.query, route.has, route.missing);
      if (hasParams) Object.assign(params, hasParams);
      else params = false;
    }
    if (!params || !route.destination) continue;
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: route.destination,
      params,
      query: parsedUrl.query,
    });
    const { query } = parsedDestination;
    delete parsedDestination.query;
    parsedDestination.search = stringifyQuery(req, query);
    parsedDestination.pathname = normalizeRepeatedSlashes(parsedDestination.pathname);
    return {
      redirect: {
        statusCode: getRedirectStatus(route),
        destination: nodeUrl.format(parsedDestination),
      },
    };
  }

  return { headers: resHeaders };
}

/** router-server's redirect response (`router-server.js`, "handle redirect"). */
function sendRedirect(res, { statusCode, destination }) {
  res.statusCode = statusCode;
  res.setHeader('location', destination);
  if (statusCode === RedirectStatusCode.PermanentRedirect) {
    res.setHeader('Refresh', `0;url=${destination}`);
  }
  res.end(destination);
}

/** router-server applies the routing headers with `setHeader`, before the route runs. */
function applyRoutingHeaders(res, headers) {
  for (const key of Object.keys(headers)) res.setHeader(key, headers[key]);
}

/**
 * base-server `handleRequestImpl`: fill the `x-forwarded-*` request headers a direct client did
 * not send. `hostname` and `port` are the values the server listens with, as Next's are.
 */
function fillForwardedHeaders(req, { hostname, port }) {
  const xForwardedProto = req.headers['x-forwarded-proto'];
  const isHttps = xForwardedProto
    ? xForwardedProto === 'https'
    : Boolean(req.socket && req.socket.encrypted);
  req.headers['x-forwarded-host'] ??= req.headers['host'] ?? hostname;
  req.headers['x-forwarded-port'] ??= port ? port.toString() : isHttps ? '443' : '80';
  req.headers['x-forwarded-proto'] ??= isHttps ? 'https' : 'http';
  req.headers['x-forwarded-for'] ??= req.socket ? req.socket.remoteAddress : undefined;
}

/** `filterInternalQuery` in `next/dist/server/server-utils.js`. */
function isInternalQueryKey(key) {
  return (
    key === 'nextInternalLocale' ||
    (key !== NEXT_QUERY_PARAM_PREFIX && key.startsWith(NEXT_QUERY_PARAM_PREFIX)) ||
    (key !== NEXT_INTERCEPTION_MARKER_PREFIX && key.startsWith(NEXT_INTERCEPTION_MARKER_PREFIX))
  );
}

/**
 * Removes Next's internal query keys (`nxtP…`, `nxtI…`, `nextInternalLocale`) from `req.url`.
 *
 * Why this exists: a route module that is NOT wrapped by next-server treats `nxtP<param>` query
 * keys as the route params an upstream proxy resolved (`normalizeQueryParams` in
 * `server-utils.js`), and prefers them over the path. Under next-server the same keys are
 * deleted (`filterInternalQuery`). Without this, `/api/trpc/a?nxtPtrpc=b` would run procedure
 * `b` here and `a` under Next. The URL is only rebuilt when such a key is present.
 */
function stripInternalQuery(req) {
  const url = req.url || '';
  const q = url.indexOf('?');
  if (q === -1) return;
  const params = new URLSearchParams(url.slice(q + 1));
  let found = false;
  for (const key of params.keys()) {
    if (isInternalQueryKey(key)) {
      found = true;
      break;
    }
  }
  if (!found) return;
  const kept = new URLSearchParams();
  for (const [key, value] of params) if (!isInternalQueryKey(key)) kept.append(key, value);
  const search = kept.toString();
  req.url = url.slice(0, q) + (search ? `?${search}` : '');
}

/**
 * Maps a request path to one of the served pages. `pages` maps a page (`/api/trpc/[trpc]`) to
 * anything; only the keys are used. Static pages match exactly; dynamic ones through Next's own
 * route matcher, which throws `DecodeError` on a malformed `%` escape exactly as it does inside
 * router-server.
 *
 * Returns { page } | { notFound: true } | { decodeError: true }.
 */
function createPageMatcher(pages) {
  const statics = new Set();
  const dynamics = [];
  for (const page of pages) {
    if (/\[[^\]]+\]/.test(page))
      dynamics.push({ page, match: getRouteMatcher(getRouteRegex(page)) });
    else statics.add(page);
  }
  return function matchPage(pathname) {
    if (statics.has(pathname)) return { page: pathname };
    for (const { page, match } of dynamics) {
      try {
        if (match(pathname)) return { page };
      } catch (err) {
        if (err instanceof DecodeError) return { decodeError: true };
        throw err;
      }
    }
    return { notFound: true };
  };
}

/**
 * The answer for a path this server does not serve. Next renders its 404 PAGE here, which this
 * server cannot do (it never loads the page renderer); the one case it reproduces exactly is
 * router-server's plain-text 404 for a non-document fetch (`sec-fetch-dest` present and not
 * `document`), which is what browsers send for `fetch()`. The parity harness records the rest as
 * a declared divergence.
 */
function sendNotFound(res) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not Found');
}

/** Next renders its `/_error` page with 400 for an undecodable path. Same limitation as above. */
function sendBadRequest(res) {
  res.statusCode = 400;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Bad Request');
}

module.exports = {
  applyRoutingHeaders,
  createPageMatcher,
  createRouting,
  fillForwardedHeaders,
  filterInternalHeaders,
  resolveRouting,
  sendBadRequest,
  sendNotFound,
  sendRedirect,
  stripInternalQuery,
};
