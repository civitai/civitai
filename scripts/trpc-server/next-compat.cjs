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
/**
 * Every Next export this server uses, checked HERE, at module scope, as the module loads.
 *
 * These are unpublished internals (`next/dist/...`), so a Next bump can rename or drop one
 * without any type error. Destructuring a missing name gives `undefined`, which would surface as
 * a TypeError on some later request, or never. Instead, loading this file throws, naming the
 * export. `scripts/ci/assert-standalone-boot-graph.mjs` loads this file in the image build, so
 * that throw fails the BUILD.
 *
 * Each `require` stays a short literal on its own unindented line: that is the form the boot-graph
 * gate reads.
 */
function expectExport(mod, specifier, name, type) {
  const value = mod == null ? undefined : mod[name];
  const ok =
    type === 'string' ? typeof value === 'string' && value.length > 0 : typeof value === type;
  if (!ok) {
    throw new Error(
      `trpc-server: ${specifier} no longer exports ${name} as a ${
        type === 'string' ? 'non-empty string' : type
      } ` + `(got ${typeof value}). A Next upgrade changed an internal this server depends on.`
    );
  }
  return value;
}

const ipcUtils = require('next/dist/server/lib/server-ipc/utils');
const sharedUtils = require('next/dist/shared/lib/utils');
const parseUrlMod = require('next/dist/shared/lib/router/utils/parse-url');
const pathMatch = require('next/dist/shared/lib/router/utils/path-match');
const prepareDest = require('next/dist/shared/lib/router/utils/prepare-destination');
const redirectStatus = require('next/dist/lib/redirect-status');
const localePath = require('next/dist/shared/lib/i18n/normalize-locale-path');
const pathPrefix = require('next/dist/shared/lib/router/utils/add-path-prefix');
const routeRegex = require('next/dist/shared/lib/router/utils/route-regex');
const routeMatcher = require('next/dist/shared/lib/router/utils/route-matcher');
const sortedRoutes = require('next/dist/shared/lib/router/utils/sorted-routes');
const bodyStreams = require('next/dist/server/body-streams');
const nextConstants = require('next/dist/lib/constants');
const instrumentationGlobals = require('next/dist/server/lib/router-utils/instrumentation-globals.external');
const httpAgentEnv = require('next/dist/server/setup-http-agent-env');
const globalBehaviors = require('next/dist/server/node-environment-extensions/global-behaviors');
const processErrorHandlers = require('next/dist/server/node-environment-extensions/process-error-handlers');

const NEXT = 'next/dist';
const filterInternalHeaders = expectExport(
  ipcUtils,
  `${NEXT}/server/lib/server-ipc/utils`,
  'filterInternalHeaders',
  'function'
);
const DecodeError = expectExport(
  sharedUtils,
  `${NEXT}/shared/lib/utils`,
  'DecodeError',
  'function'
);
const parseUrl = expectExport(
  parseUrlMod,
  `${NEXT}/shared/lib/router/utils/parse-url`,
  'parseUrl',
  'function'
);
const getPathMatch = expectExport(
  pathMatch,
  `${NEXT}/shared/lib/router/utils/path-match`,
  'getPathMatch',
  'function'
);
const matchHas = expectExport(
  prepareDest,
  `${NEXT}/shared/lib/router/utils/prepare-destination`,
  'matchHas',
  'function'
);
const compileNonPath = expectExport(
  prepareDest,
  `${NEXT}/shared/lib/router/utils/prepare-destination`,
  'compileNonPath',
  'function'
);
const modifyRouteRegex = expectExport(
  redirectStatus,
  `${NEXT}/lib/redirect-status`,
  'modifyRouteRegex',
  'function'
);
const normalizeLocalePath = expectExport(
  localePath,
  `${NEXT}/shared/lib/i18n/normalize-locale-path`,
  'normalizeLocalePath',
  'function'
);
const addPathPrefix = expectExport(
  pathPrefix,
  `${NEXT}/shared/lib/router/utils/add-path-prefix`,
  'addPathPrefix',
  'function'
);
const getRouteRegex = expectExport(
  routeRegex,
  `${NEXT}/shared/lib/router/utils/route-regex`,
  'getRouteRegex',
  'function'
);
const getRouteMatcher = expectExport(
  routeMatcher,
  `${NEXT}/shared/lib/router/utils/route-matcher`,
  'getRouteMatcher',
  'function'
);
const getSortedRoutes = expectExport(
  sortedRoutes,
  `${NEXT}/shared/lib/router/utils/sorted-routes`,
  'getSortedRoutes',
  'function'
);
const getCloneableBody = expectExport(
  bodyStreams,
  `${NEXT}/server/body-streams`,
  'getCloneableBody',
  'function'
);
const NEXT_QUERY_PARAM_PREFIX = expectExport(
  nextConstants,
  `${NEXT}/lib/constants`,
  'NEXT_QUERY_PARAM_PREFIX',
  'string'
);
const NEXT_INTERCEPTION_MARKER_PREFIX = expectExport(
  nextConstants,
  `${NEXT}/lib/constants`,
  'NEXT_INTERCEPTION_MARKER_PREFIX',
  'string'
);
// Used by server.cjs; checked here so that the build's load of this file covers them too.
const ensureInstrumentationRegistered = expectExport(
  instrumentationGlobals,
  `${NEXT}/server/lib/router-utils/instrumentation-globals.external`,
  'ensureInstrumentationRegistered',
  'function'
);
const setHttpClientAndAgentOptions = expectExport(
  httpAgentEnv,
  `${NEXT}/server/setup-http-agent-env`,
  'setHttpClientAndAgentOptions',
  'function'
);
const installGlobalBehaviors = expectExport(
  globalBehaviors,
  `${NEXT}/server/node-environment-extensions/global-behaviors`,
  'installGlobalBehaviors',
  'function'
);
const installProcessErrorHandlers = expectExport(
  processErrorHandlers,
  `${NEXT}/server/node-environment-extensions/process-error-handlers`,
  'installProcessErrorHandlers',
  'function'
);

/**
 * `buildCustomRoute` from `next/dist/server/lib/router-utils/filesystem.js` (module-local there,
 * so it cannot be imported): the matcher router-server builds for each `headers()` entry of the
 * routes manifest.
 */
function buildHeaderRoute(item, caseSensitive) {
  const match = getPathMatch(item.source, {
    strict: true,
    removeUnnamedParams: true,
    regexModifier: (regex) => (item.internal ? regex : modifyRouteRegex(regex, undefined)),
    sensitive: caseSensitive,
  });
  return { ...item, match };
}

/**
 * Concrete request paths a page answers, one per shape: a sample segment for `[x]`, one and two
 * segments for `[...x]`, none and one for `[[...x]]`.
 */
function examplePaths(page) {
  const fill = (optional, rest) =>
    page
      .replace(/\/\[\[\.\.\.[^\]]+\]\]/g, optional)
      .replace(/\[\.\.\.[^\]]+\]/g, rest)
      .replace(/\[[^\]]+\]/g, 'x');
  return [...new Set([fill('', 'a/b'), fill('/a', 'a')])];
}

/**
 * A literal path in the shape of a custom-route `source`: the locale prefix Next adds dropped,
 * each named parameter replaced by a sample segment. Used to ask whether a source written for one
 * concrete value (`/api/v1/models/123`) lands on a served dynamic page. Best effort: a source with
 * regex groups may produce a path that matches nothing, which only weakens this direction; the
 * other direction (`pageConflict` below) does not depend on it.
 */
function sourceExample(source) {
  return source
    .replace(/^\/:nextInternalLocale\([^)]*\)/, '')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*(\([^)]*\))?[*+?]?/g, 'x');
}

/**
 * The first served page that `route` (a compiled redirect or rewrite) can apply to, or null. It is
 * matched as resolve-routes matches it (the default locale added under i18n, and stripped again for
 * internal routes), and also against the bare path, so a source written without the locale prefix
 * is caught too. `has` / `missing` conditions are ignored: a route that applies to SOME requests
 * for a served page is already one this server would answer differently.
 */
function pageConflict(routing, route, pages, matchPage) {
  for (const page of pages) {
    for (const path of examplePaths(page)) {
      const localized = localizedPathname(routing.i18n, path);
      if (route.match(routeMatchPathname(routing, localized, route)) || route.match(path)) {
        return page;
      }
    }
  }
  const found = matchPage(sourceExample(route.source));
  return found.page || null;
}

/**
 * Builds the routing rules this server applies before a route module runs. Throws when the
 * manifest uses a feature this server does not implement, so the process refuses to start
 * rather than serving requests Next would have routed differently.
 *
 * `pages` is the list this server will serve. `redirects()` and rewrites are NOT ported, so this
 * also refuses to start when any redirect (user or internal) or any afterFiles/fallback rewrite
 * could apply to one of those pages (beforeFiles rewrites are refused outright, as before).
 */
function createRouting({ routesManifest, nextConfig, pages = [] }) {
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
    buildHeaderRoute(item, caseSensitive)
  );
  const i18n = nextConfig.i18n || null;
  const routing = { headers, i18n };

  // `redirects()` and rewrites are NOT ported, and that is only correct while none of them can
  // apply to a served page. The repeated-slash 308 and the internal trailing-slash 308 never can:
  // the page matcher serves no path with an empty segment or a trailing slash (those get the plain
  // 404). Every other redirect and every afterFiles/fallback rewrite is checked here against the
  // served pages, and one that can reach a page stops the boot, so a config change that would
  // make this server answer differently from Next cannot ship silently.
  if (pages.length > 0) {
    const matchPage = createPageMatcher(pages);
    const custom = [
      ...(routesManifest.redirects || []).map((item) => ['redirect', item]),
      ...(Array.isArray(rewrites)
        ? rewrites.map((item) => ['rewrite', item])
        : [...(rewrites.afterFiles || []), ...(rewrites.fallback || [])].map((item) => [
            'rewrite',
            item,
          ])),
    ];
    for (const [kind, item] of custom) {
      const page = pageConflict(routing, buildHeaderRoute(item, caseSensitive), pages, matchPage);
      if (page) {
        throw new Error(
          `trpc-server: ${kind} ${item.source} can apply to served page ${page}; this server does not port ${kind}s`
        );
      }
    }
  }
  return routing;
}

/** The pathname resolve-routes matches custom routes against: the default locale prefixed under i18n. */
function localizedPathname(i18n, pathname) {
  if (!i18n) return pathname;
  const initial = normalizeLocalePath(pathname, i18n.locales);
  if (initial.detectedLocale || initial.pathname.startsWith('/_next/')) return pathname;
  return initial.pathname === '/'
    ? `/${i18n.defaultLocale}`
    : addPathPrefix(initial.pathname || '', `/${i18n.defaultLocale}`);
}

/**
 * The pathname a custom route is matched against: resolve-routes `handleRoute`. Under i18n the
 * request path carries the default locale (`/en/api/...`) for user routes, and has it stripped
 * again for internal ones.
 */
function routeMatchPathname(routing, parsedPathname, route) {
  if (!routing.i18n || !route.internal) return parsedPathname;
  const localeResult = normalizeLocalePath(parsedPathname, routing.i18n.locales);
  if (localeResult.detectedLocale === routing.i18n.defaultLocale) return localeResult.pathname;
  return parsedPathname;
}

/**
 * The config headers router-server would set for this request before invoking any route, ported
 * from `resolve-routes.js` (`resolveRoutes`, the headers branch). Returns { headers }.
 */
function resolveRouting(routing, req) {
  const parsedUrl = parseUrl(req.url || '');

  // i18n: the default locale is added to the path for matching (resolve-routes ~L141).
  const pathname = localizedPathname(routing.i18n, parsedUrl.pathname || '/');

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

  return { headers: resHeaders };
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
 * router-server. Dynamic pages are tried in the order Next's filesystem router tries them
 * (`getSortedRoutes`, as `sortDynamicRoutes` in `router-utils/filesystem.js`): `[id]` before
 * `[...rest]` before `[[...rest]]`, and a deeper static segment before a dynamic one, so when two
 * served dynamic pages can both match a path the one Next would pick wins.
 *
 * Returns { page } | { notFound: true } | { decodeError: true }.
 */
function createPageMatcher(pages) {
  const statics = new Set();
  const dynamicPages = [];
  for (const page of pages) {
    if (/\[[^\]]+\]/.test(page)) dynamicPages.push(page);
    else statics.add(page);
  }
  const dynamics = getSortedRoutes(dynamicPages).map((page) => ({
    page,
    match: getRouteMatcher(getRouteRegex(page)),
  }));
  return function matchPage(pathname) {
    // Next never invokes a route for a trailing-slash path (it 308s first, and this server does
    // not port redirects), so this server does not serve one either.
    if (pathname.length > 1 && pathname.endsWith('/')) return { notFound: true };
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
 * Next's request-body cap for a request the proxy runs on: router-server wraps every request body
 * in `getCloneableBody(req, experimental.proxyClientMaxBodySize)` (resolve-routes), and for a
 * non-GET/HEAD request next-server hands the proxy a clone of it (`cloneBodyStream`) and then,
 * whatever the proxy answered, `finalize()`s it: it waits for the whole body to arrive and swaps
 * the request's stream for the copy. The copy stops at the cap (10 MiB by default), dropping the
 * chunk that crossed it and logging a warning, so the route sees a TRUNCATED body. Called with
 * Next's own function, in the same order, for the pages this server applies the proxy policy to.
 */
async function applyProxyBodyLimit(req, nextConfig) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const limit = nextConfig.experimental && nextConfig.experimental.proxyClientMaxBodySize;
  const body = getCloneableBody(req, limit);
  body.cloneBodyStream();
  await body.finalize();
}

/**
 * Loads route modules by page. `load(page)` returns (or resolves to) the compiled module.
 *
 * `preload(pages)` loads each one at boot and returns the pages that failed. A failure (a throw
 * while loading, or a module with no `handler` export) is logged and that page is left unloaded
 * rather than ending the process, as Next's own preload ignores a failing entry. `get(page)` then
 * retries the load on each request until it succeeds, and rejects while it fails, which the
 * server answers with its 500. A page that loaded is kept.
 */
function createRouteModuleLoader(load, log) {
  const modules = new Map();
  async function tryLoad(page) {
    const mod = await load(page);
    if (!mod || typeof mod.handler !== 'function') {
      throw new Error(`[trpc-server] ${page} has no exported handler(req, res, ctx)`);
    }
    modules.set(page, mod);
    return mod;
  }
  return {
    async preload(pages) {
      const failed = [];
      for (const page of pages) {
        try {
          await tryLoad(page);
        } catch (err) {
          failed.push(page);
          log(
            `[trpc-server] failed to load ${page}; requests to it retry the load and answer 500 while it fails`,
            err
          );
        }
      }
      return failed;
    },
    get(page) {
      const mod = modules.get(page);
      return mod ? Promise.resolve(mod) : tryLoad(page);
    },
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
  applyProxyBodyLimit,
  applyRoutingHeaders,
  createRouteModuleLoader,
  ensureInstrumentationRegistered,
  expectExport,
  installGlobalBehaviors,
  installProcessErrorHandlers,
  setHttpClientAndAgentOptions,
  createPageMatcher,
  createRouting,
  fillForwardedHeaders,
  filterInternalHeaders,
  resolveRouting,
  sendBadRequest,
  sendNotFound,
  stripInternalQuery,
};
