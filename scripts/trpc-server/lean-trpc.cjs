'use strict';
/**
 * The lean runtime for `/api/trpc/[trpc]` (`TRPC_SERVER_MODE=lean`; see `./served-pages.cjs`).
 *
 * In the default `route` mode the server calls the compiled route module's exported
 * `handler(req, res, ctx)`, which is Next's pages-API template (`next/dist/build/templates/pages-api.js`):
 *
 *   1. `ensureInstrumentation`  awaits `instrumentation.ts` registration (a dynamic import per request)
 *   2. `traceRequest`           the request span (`BaseServer.handleRequest`, "<METHOD> <page>")
 *   3. `prepare`                the "prepare route module" span, then `prepareImpl`: loads ~12 route
 *                               manifests, builds the page's route regex and matcher
 *                               (`getServerUtils`), clones the parsed URL for rewrites, works out
 *                               the query and the route params, rewrites `req.url`
 *                               (`normalizeCdnUrl`), reads the preview cookies — on EVERY request
 *   4. `render`                 `wrapApiHandler(apiResolver)`: the "executing api route (pages)" span,
 *                               then `apiResolver`: `req.cookies` / `req.query` / preview props,
 *                               the body parse under the route's `config.api.bodyParser`, the
 *                               `res.status/json/send/...` helpers, and the error handling
 *   5. the span attributes the template sets when `render` settles, and the 500 fallback
 *
 * This file keeps 2, 4 and 5 exactly — they run through the SAME Next code: the route-module class
 * the compiled page itself loaded (`PagesAPIRouteModule` from Next's pages-API runtime, which owns
 * `traceRequest`, `render` and `apiResolver`) and Next's own tracer. What it changes is 1 and 3:
 *
 *   - 1 is not repeated per request: the server registers instrumentation at boot and holds
 *     requests until it has (`server.cjs`).
 *   - 3 runs with everything that does not depend on the request built ONCE at boot (the manifests,
 *     the preview props, `getServerUtils` for this page), and its per-request part
 *     (`prepareRequest` below) is `prepareImpl` for this one page, calling the same Next helpers in
 *     the same order. The parts of `prepareImpl` that cannot apply here are left out, and each
 *     omission is backed by a boot check (`assertPreconditions`) or by the server's page matcher;
 *     the comments in `prepareRequest` say which.
 *
 * The router, the context, `withAxiom`, the API policy, `responseMeta` and `onError` are untouched:
 * they are the compiled module's `default` export, which `apiResolver` calls exactly as before.
 *
 * Parity with `server.js` is checked by the parity job (`.github/workflows/trpc-server-parity.yml`,
 * the `lean` container), which also runs a copy of this file with the preview-cookie read removed
 * as its negative control.
 *
 * Plain CommonJS, no compile step. Every require is a literal at module scope so that
 * `scripts/ci/assert-standalone-boot-graph.mjs` loads them from the shipped tree in the image build.
 * `server.cjs` requires this file only in `lean` mode.
 */

// Plain CommonJS that runs without a compile step, so `require` is the only way to load here.
/* eslint-disable @typescript-eslint/no-var-requires */
const nodePath = require('node:path');
const { expectExport } = require('./next-compat.cjs');

const tracerMod = require('next/dist/server/lib/trace/tracer');
const traceConstants = require('next/dist/server/lib/trace/constants');
const requestMetaMod = require('next/dist/server/request-meta');
const apiUtils = require('next/dist/server/api-utils');
const previewDataMod = require('next/dist/server/api-utils/node/try-get-preview-data');
const patchSetHeaderMod = require('next/dist/server/lib/patch-set-header');
const serverUtilsMod = require('next/dist/server/server-utils');
const urlMod = require('next/dist/lib/url');
const loadManifestMod = require('next/dist/server/load-manifest.external');
const sharedConstants = require('next/dist/shared/lib/constants');
const localePath = require('next/dist/shared/lib/i18n/normalize-locale-path');
const trailingSlash = require('next/dist/shared/lib/router/utils/remove-trailing-slash');
const pathMatch = require('next/dist/shared/lib/router/utils/path-match');

const NEXT = 'next/dist';
const getTracer = expectExport(
  tracerMod,
  `${NEXT}/server/lib/trace/tracer`,
  'getTracer',
  'function'
);
const recordSpanError = expectExport(
  tracerMod,
  `${NEXT}/server/lib/trace/tracer`,
  'recordSpanError',
  'function'
);
const SpanStatusCode = expectExport(
  tracerMod,
  `${NEXT}/server/lib/trace/tracer`,
  'SpanStatusCode',
  'object'
);
const BaseServerSpan = expectExport(
  traceConstants,
  `${NEXT}/server/lib/trace/constants`,
  'BaseServerSpan',
  'object'
);
const RouteModuleSpan = expectExport(
  traceConstants,
  `${NEXT}/server/lib/trace/constants`,
  'RouteModuleSpan',
  'object'
);
const setRequestMeta = expectExport(
  requestMetaMod,
  `${NEXT}/server/request-meta`,
  'setRequestMeta',
  'function'
);
const getRequestMeta = expectExport(
  requestMetaMod,
  `${NEXT}/server/request-meta`,
  'getRequestMeta',
  'function'
);
const addRequestMeta = expectExport(
  requestMetaMod,
  `${NEXT}/server/request-meta`,
  'addRequestMeta',
  'function'
);
const sendError = expectExport(apiUtils, `${NEXT}/server/api-utils`, 'sendError', 'function');
const tryGetPreviewData = expectExport(
  previewDataMod,
  `${NEXT}/server/api-utils/node/try-get-preview-data`,
  'tryGetPreviewData',
  'function'
);
const patchSetHeaderWithCookieSupport = expectExport(
  patchSetHeaderMod,
  `${NEXT}/server/lib/patch-set-header`,
  'patchSetHeaderWithCookieSupport',
  'function'
);
const getServerUtils = expectExport(
  serverUtilsMod,
  `${NEXT}/server/server-utils`,
  'getServerUtils',
  'function'
);
const parseReqUrl = expectExport(urlMod, `${NEXT}/lib/url`, 'parseReqUrl', 'function');
const loadManifestFromRelativePath = expectExport(
  loadManifestMod,
  `${NEXT}/server/load-manifest.external`,
  'loadManifestFromRelativePath',
  'function'
);
const ROUTES_MANIFEST = expectExport(
  sharedConstants,
  `${NEXT}/shared/lib/constants`,
  'ROUTES_MANIFEST',
  'string'
);
const PREVIEW_PROPS_MANIFEST = expectExport(
  sharedConstants,
  `${NEXT}/shared/lib/constants`,
  'PREVIEW_PROPS_MANIFEST',
  'string'
);
const SERVER_FILES_MANIFEST = expectExport(
  sharedConstants,
  `${NEXT}/shared/lib/constants`,
  'SERVER_FILES_MANIFEST',
  'string'
);
const normalizeLocalePath = expectExport(
  localePath,
  `${NEXT}/shared/lib/i18n/normalize-locale-path`,
  'normalizeLocalePath',
  'function'
);
const removeTrailingSlash = expectExport(
  trailingSlash,
  `${NEXT}/shared/lib/router/utils/remove-trailing-slash`,
  'removeTrailingSlash',
  'function'
);

const getPathMatch = expectExport(
  pathMatch,
  `${NEXT}/shared/lib/router/utils/path-match`,
  'getPathMatch',
  'function'
);

/**
 * Next's pages-API runtimes (`next/dist/compiled/next-server/pages-api{,-turbo}.runtime.prod.js`).
 * The compiled route module loads exactly one of them (which one depends on the bundler that built
 * it) through Node's `require`; the lean runtime must use the SAME one, because it owns the
 * `PagesAPIRouteModule` class and its `apiResolver`. Matched on the loaded file's path, so it does
 * not matter where the bundle resolved it from.
 */
const PAGES_API_RUNTIME_FILE =
  /[\\/]next[\\/]dist[\\/]compiled[\\/]next-server[\\/]pages-api(-turbo)?\.runtime\.prod\.js$/;

/**
 * The `PagesAPIRouteModule` class of the pages-API runtime that is already loaded (by the route
 * module). Throws unless exactly one runtime file is in `cache`: loading another copy here would run
 * a different `apiResolver` than the page's own.
 */
function loadedPagesApiRouteModuleClass(cache = require.cache) {
  const loaded = Object.keys(cache).filter((file) => PAGES_API_RUNTIME_FILE.test(file));
  if (loaded.length !== 1) {
    throw new Error(
      `[trpc-server] lean: expected exactly one loaded pages-API runtime, found ${loaded.length} (${
        loaded.join(', ') || 'none'
      }); load the route module first`
    );
  }
  return expectExport(cache[loaded[0]].exports, loaded[0], 'PagesAPIRouteModule', 'function');
}

/**
 * The build features `prepareRequest` does not implement. Each one, when present, makes Next's
 * `prepareImpl` do something this file leaves out, so the lean runtime refuses to start instead.
 */
function assertPreconditions({ routesManifest, nextConfig, page }) {
  if (routesManifest.basePath) throw new Error('[trpc-server] lean: basePath is not supported');
  // Domain locales make the default locale depend on the Host header.
  const i18n = routesManifest.i18n;
  if (i18n && Array.isArray(i18n.domains) && i18n.domains.length > 0) {
    throw new Error('[trpc-server] lean: i18n domains are not supported');
  }
  if (nextConfig.experimental && nextConfig.experimental.runtimeServerDeploymentId) {
    // prepareImpl throws on every request in this case; refuse once, at boot.
    if (!process.env.NEXT_DEPLOYMENT_ID) {
      throw new Error(
        '[trpc-server] lean: runtimeServerDeploymentId is enabled but NEXT_DEPLOYMENT_ID is missing'
      );
    }
  }
  // One dynamic segment and nothing else dynamic: the case `prepareRequest` is written for.
  if (!/^(\/[^[\]/]+)+\/\[[A-Za-z_][A-Za-z0-9_]*\]$/.test(page)) {
    throw new Error(`[trpc-server] lean: ${page} is not a page with one trailing [param]`);
  }
}

/**
 * Builds the lean `handler(req, res, ctx)` for `page`, with the contract of the compiled module's
 * own `handler` (`ctx.requestMeta` is set on the request, `ctx.waitUntil` is unused here).
 *
 * `mod` is the page's loaded route module; `projectDir` the absolute project directory (the image
 * root); `distDir` the absolute dist directory; `relativeProjectDir` the request-meta value the
 * server passes; `nextConfig` the standalone config.
 */
function createLeanPageHandler({
  page,
  mod,
  projectDir,
  distDir,
  relativeProjectDir,
  nextConfig,
  PagesAPIRouteModule = loadedPagesApiRouteModuleClass(),
}) {
  if (!mod || typeof mod.default !== 'function') {
    throw new Error(`[trpc-server] lean: ${page} has no default export`);
  }
  const relativeDistDir = nodePath.relative(projectDir, distDir);
  const load = (manifest, extra) =>
    loadManifestFromRelativePath({
      projectDir,
      distDir: relativeDistDir,
      manifest,
      shouldCache: true,
      ...extra,
    });

  // What `loadManifests` reads per request, read once. Next caches these same files process-wide.
  const routesManifest = load(ROUTES_MANIFEST);
  const previewProps = load(`server/${PREVIEW_PROPS_MANIFEST}`);
  const serverFilesManifest = load(`${SERVER_FILES_MANIFEST}.json`);
  assertPreconditions({ routesManifest, nextConfig, page });

  const experimental = nextConfig.experimental || {};
  // Inlined into the compiled template at build time (`next/dist/build/define-env.js`), from the
  // same config.
  const multiZoneDraftMode = Boolean(experimental.multiZoneDraftMode ?? false);
  const trustHostHeader = experimental.trustHostHeader ?? false;
  const allowedRevalidateHeaderKeys = experimental.allowedRevalidateHeaderKeys ?? [];
  const i18n = routesManifest.i18n || undefined;

  // The route module the template builds at module scope, built from the page's own userland.
  const routeModule = new PagesAPIRouteModule({
    definition: { kind: 'PAGES_API', page, pathname: page, bundlePath: '', filename: '' },
    userland: mod,
    distDir: relativeDistDir,
    relativeProjectDir,
  });
  if (
    typeof routeModule.traceRequest !== 'function' ||
    typeof routeModule.render !== 'function' ||
    typeof routeModule.getRouterServerContext !== 'function' ||
    typeof routeModule.instrumentationOnRequestError !== 'function'
  ) {
    throw new Error('[trpc-server] lean: PagesAPIRouteModule no longer has the methods used here');
  }

  // What `prepareImpl` builds per request from the page alone (`getServerUtils`).
  const serverUtils = getServerUtils({
    page,
    i18n,
    basePath: routesManifest.basePath,
    rewrites: routesManifest.rewrites,
    pageIsDynamic: true,
    trailingSlash: nextConfig.trailingSlash,
    caseSensitive: Boolean(routesManifest.caseSensitive),
  });
  const defaultRouteMatchKeys = Object.keys(serverUtils.defaultRouteMatches || {});
  const defaultLocale = i18n && i18n.defaultLocale;

  // `handleRewrites` checks every rewrite the manifest lists (beforeFiles, afterFiles, fallback)
  // against the request path, compiling each one's matcher per request. Unless a rewrite's
  // source matches the path it is checked against, the path never changes and it returns no
  // params and a copy of the parsed URL. So the matchers are compiled once here, with the
  // options `handleRewrites` uses, and a request whose path one of them matches is served by
  // the route module's own `handler` instead (Next's whole runtime, as in `route` mode). For a
  // served page none can match (`createRouting` in `./next-compat.cjs` refuses to boot
  // otherwise), so that fallback is exactness, not a path requests are expected to take.
  const manifestRewrites = routesManifest.rewrites || {};
  const rewriteMatchers = [
    ...(manifestRewrites.beforeFiles || []),
    ...(manifestRewrites.afterFiles || []),
    ...(manifestRewrites.fallback || []),
  ].map((rewrite) =>
    getPathMatch(rewrite.source + (nextConfig.trailingSlash ? '(/)?' : ''), {
      removeUnnamedParams: true,
      strict: true,
      sensitive: Boolean(routesManifest.caseSensitive),
    })
  );

  /** Whether a rewrite could apply to this request in `prepareImpl` (see above). */
  function rewriteCanApply(parsedUrl) {
    if (rewriteMatchers.length === 0) return false;
    let pathname = parsedUrl.pathname || '/';
    // prepareImpl checks rewrites against the path with the default locale prefixed, unless the
    // path already starts with a locale.
    if (i18n && defaultLocale) {
      const { detectedLocale } = normalizeLocalePath(pathname, i18n.locales);
      if (!detectedLocale) pathname = `/${defaultLocale}${pathname === '/' ? '' : pathname}`;
    }
    return rewriteMatchers.some((match) => Boolean(match(pathname)));
  }

  /**
   * `RouteModule.prepareImpl` (next/dist/server/route-modules/route-module.js) for this page,
   * returning the fields the template reads (`query`, `params`, `previewProps`,
   * `routerServerContext`), or undefined for a URL it cannot parse (the template answers 400).
   */
  function prepareRequest(req, res) {
    patchSetHeaderWithCookieSupport(req, res);
    // `ensureInstrumentation`: registered at boot (server.cjs), memoised process-wide.
    // `loadManifests`: read once above.
    const routerServerContext = routeModule.getRouterServerContext(req);
    const xfp = req.headers['x-forwarded-proto'];
    const protocol = xfp && xfp.includes('https') ? 'https' : 'http';
    if (!getRequestMeta(req, 'initURL')) {
      const initUrl =
        serverFilesManifest && serverFilesManifest.config.experimental.trustHostHeader
          ? `${protocol}://${req.headers.host || 'localhost'}${req.url}`
          : `${protocol}://${(routerServerContext && routerServerContext.hostname) || 'localhost'}${
              req.url
            }`;
      addRequestMeta(req, 'initURL', initUrl);
      addRequestMeta(req, 'initProtocol', protocol);
    }
    // basePath: refused at boot.
    const parsedUrl = parseReqUrl(req.url || '/');
    addRequestMeta(req, 'initQuery', { ...(parsedUrl && parsedUrl.query) });
    if (!parsedUrl) return undefined;
    // `/_next/data` normalization: never applies, the page matcher only routes /api/trpc/<seg> here.
    const originalQuery = { ...parsedUrl.query };

    let detectedLocale;
    let matchPathname = parsedUrl.pathname || '/';
    if (i18n) {
      const localeResult = normalizeLocalePath(parsedUrl.pathname || '/', i18n.locales);
      if (localeResult.detectedLocale) {
        req.url = `${localeResult.pathname}${parsedUrl.search}`;
        detectedLocale = localeResult.detectedLocale;
      }
      // prepareImpl prefixes the default locale for the rewrite pass and strips it again after;
      // with no rewrite matching (checked in `leanHandler`) the pathname it matches the params
      // against is this one.
      matchPathname = localeResult.pathname;
    }
    // Domain locales: refused at boot; `defaultLocale` / `locale` request meta: never set here.
    const locale = detectedLocale || defaultLocale;
    // handleRewrites: no rewrite matches this path (checked in `leanHandler`), so no rewrite
    // params and an unchanged pathname.

    // `params` request meta is never set on this server.
    let params;
    const paramsMatch = serverUtils.dynamicRouteMatcher(matchPathname);
    const paramsResult = serverUtils.normalizeDynamicRouteParams(paramsMatch || {}, true);
    if (paramsResult.hasValidParams) params = paramsResult.params;

    // `query` request meta is never set on this server.
    const query = { ...parsedUrl.query };
    const routeParamKeys = new Set();
    const combinedParamKeys = [];
    for (const key of defaultRouteMatchKeys) {
      const originalValue = Array.isArray(originalQuery[key])
        ? originalQuery[key].join('')
        : originalQuery[key];
      const queryValue = Array.isArray(query[key]) ? query[key].join('') : query[key];
      if (!(key in originalQuery) || originalValue === queryValue) combinedParamKeys.push(key);
    }
    serverUtils.normalizeCdnUrl(req, combinedParamKeys);
    if (!(routerServerContext && routerServerContext.isWrappedByNextServer)) {
      serverUtils.normalizeQueryParams(query, routeParamKeys);
    } else {
      serverUtils.filterInternalQuery(query, []);
    }
    serverUtils.filterInternalQuery(originalQuery, combinedParamKeys);

    // pageIsDynamic
    const queryResult = serverUtils.normalizeDynamicRouteParams(query, true);
    const paramsResult2 = serverUtils.normalizeDynamicRouteParams(params || {}, true);
    let paramsToInterpolate;
    if (
      query &&
      params &&
      paramsResult2.hasValidParams &&
      queryResult.hasValidParams &&
      routeParamKeys.size > 0 &&
      Object.keys(paramsResult2.params).length <= Object.keys(queryResult.params).length
    ) {
      paramsToInterpolate = queryResult.params;
      params = Object.assign(queryResult.params);
    } else {
      paramsToInterpolate =
        paramsResult2.hasValidParams && params ? params : queryResult.hasValidParams ? query : {};
    }
    req.url = serverUtils.interpolateDynamicPath(req.url || '/', paramsToInterpolate);
    if (!params) {
      if (queryResult.hasValidParams) {
        params = Object.assign({}, queryResult.params);
        for (const key in serverUtils.defaultRouteMatches) delete query[key];
      } else {
        const match = serverUtils.dynamicRouteMatcher(matchPathname);
        if (match) params = Object.assign({}, match);
      }
    }
    if (
      params &&
      routeParamKeys.size > 0 &&
      !paramsResult2.hasValidParams &&
      !queryResult.hasValidParams
    ) {
      for (const key of routeParamKeys) {
        if (query[key] !== undefined) params[key] = query[key];
      }
      addRequestMeta(req, 'resolvedRouteParamKeys', routeParamKeys);
    }
    for (const key of routeParamKeys) {
      if (!(key in originalQuery)) {
        delete query[key];
      } else if (originalQuery[key] && query[key] && originalQuery[key] !== query[key]) {
        query[key] = originalQuery[key];
      }
    }

    // `checkIsOnDemandRevalidate`: its result is not used for a pages-API route.
    // The preview cookies are read eagerly, as prepareImpl does: an incomplete or stale pair is
    // cleared on the response (Set-Cookie) here.
    tryGetPreviewData(req, res, previewProps, multiZoneDraftMode);
    // `installProcessErrorHandlers`: installed at boot (server.cjs).

    if (
      res &&
      Boolean(req.headers['x-nextjs-data']) &&
      (!res.statusCode || res.statusCode === 200)
    ) {
      res.setHeader(
        'x-nextjs-matched-path',
        removeTrailingSlash(`${locale ? `/${locale}` : ''}${page}`)
      );
    }
    return { query, params, previewProps, routerServerContext };
  }

  /** The template's `handleRequest`, with `prepareRequest` in place of `routeModule.prepare`. */
  async function handleRequest(req, res, tracer, requestSpan, requestRootSpan) {
    const prepareResult = await tracer.trace(
      RouteModuleSpan.prepare,
      { spanName: 'prepare route module' },
      () => prepareRequest(req, res)
    );
    if (!prepareResult) {
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }
    const { query, params, routerServerContext } = prepareResult;
    try {
      const method = req.method || 'GET';
      const isWrappedByNextServer = Boolean(
        routerServerContext && routerServerContext.isWrappedByNextServer
      );
      const onRequestError = routeModule.instrumentationOnRequestError.bind(routeModule);
      const invokeRouteModule = async (span) =>
        routeModule
          .render(req, res, {
            query: { ...query, ...params },
            params,
            allowedRevalidateHeaderKeys,
            multiZoneDraftMode,
            trustHostHeader,
            previewProps: prepareResult.previewProps,
            propagateError: false,
            dev: routeModule.isDev,
            page,
            internalRevalidate: routerServerContext && routerServerContext.revalidate,
            onError: (...args) => onRequestError(req, ...args),
          })
          .finally(() => {
            if (!span) return;
            span.setAttributes({ 'http.status_code': res.statusCode, 'next.rsc': false });
            if (res.statusCode && res.statusCode >= 500) {
              span.setStatus({ code: SpanStatusCode.ERROR });
              span.setAttribute('error.type', res.statusCode.toString());
            }
            const rootSpanAttributes = tracer.getRootSpanAttributes();
            if (!rootSpanAttributes) return;
            if (rootSpanAttributes.get('next.span_type') !== BaseServerSpan.handleRequest) {
              console.warn(
                `Unexpected root span type '${rootSpanAttributes.get(
                  'next.span_type'
                )}'. Please report this Next.js issue https://github.com/vercel/next.js`
              );
              return;
            }
            const route = rootSpanAttributes.get('next.route') || page;
            const name = `${method} ${route}`;
            span.setAttributes({
              'next.route': route,
              'http.route': route,
              'next.span_name': name,
            });
            span.updateName(name);
            if (requestRootSpan && requestRootSpan !== span) {
              requestRootSpan.setAttribute('http.route', route);
              requestRootSpan.updateName(name);
            }
          });
      if (!isWrappedByNextServer && req.url !== undefined) {
        if (requestSpan) requestSpan.setAttribute('http.target', req.url);
      }
      try {
        await invokeRouteModule(requestSpan);
      } catch (err) {
        if (!isWrappedByNextServer && requestSpan && !routeModule.isDev) {
          recordSpanError(requestSpan, err);
        }
        throw err;
      }
    } catch (err) {
      if (routeModule.isDev) throw err;
      sendError(res, 500, 'Internal Server Error');
    }
  }

  /** The template's `handler`. */
  return async function leanHandler(req, res, ctx) {
    const parsedUrl = parseReqUrl(req.url || '/');
    if (parsedUrl && rewriteCanApply(parsedUrl)) return mod.handler(req, res, ctx);
    if (ctx && ctx.requestMeta) setRequestMeta(req, ctx.requestMeta);
    const tracer = getTracer();
    return routeModule.traceRequest(
      req,
      {
        tracer,
        spanName: `${req.method || 'GET'} ${page}`,
        httpTarget: req.url,
        // Registration finished at boot, so there are no deferred instrumentation spans to emit.
        instrumentation: undefined,
      },
      (requestSpan, requestRootSpan) =>
        handleRequest(req, res, tracer, requestSpan, requestRootSpan)
    );
  };
}

module.exports = {
  PAGES_API_RUNTIME_FILE,
  assertPreconditions,
  createLeanPageHandler,
  loadedPagesApiRouteModuleClass,
};
