// @ts-check
/**
 * The `/api/trpc/*` fast path of the standalone tRPC server (`scripts/trpc-server/server.mjs`).
 *
 * WHAT IT REPLACES. A tRPC call served by Next's `server.js` passes through Next's router server
 * (`next/dist/server/lib/router-server.js` → `router-utils/resolve-routes.js`), which matches the URL
 * against every route, invokes the proxy (`src/proxy.ts`) through the render server, applies the
 * proxy's result to the request and response, and only then loads the `/api/trpc/[trpc]` page and
 * calls its handler. This module does the parts of that which have an effect on an `/api/trpc/<path>`
 * request, and nothing else:
 *
 *   1. strip Next's internal request headers (`filterInternalHeaders`, as the router server does),
 *      and hand any request a next.config redirect or rewrite would apply to back to Next;
 *   2. add the `x-forwarded-*` request headers Next's base server adds;
 *   3. run the COMPILED proxy (`.next/server/middleware.js`) through the same adapter call
 *      `NextNodeServer.runMiddleware` makes, with the same body clone;
 *   4. apply next.config `headers` and the proxy's result exactly as `resolve-routes` + the router
 *      server do — request-header overrides (the verified-bot strip), passthrough response headers
 *      (the default `Cache-Control`), redirects and terminal responses (the API region block);
 *   5. call the COMPILED route's own `handler` — the same entry Next's base server calls — so query
 *      and dynamic-param parsing, `req.cookies`, body parsing and its 17mb limit, `res.status/json`,
 *      Next's request span, `withAxiom`, and the whole tRPC handler (context, batching, response meta,
 *      error handling) are Next's and the route's own code, not a copy.
 *
 * Every effect, and why each one the router server has but this does not is safe to drop, is in
 * `parity-ledger.mjs`. Anything this module is not sure it handles identically (an unusual path
 * shape, a proxy rewrite, a proxy that throws) is handed to Next's own request handler instead,
 * untouched, so the fallback for "not sure" is the current behaviour.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import url from 'node:url';

/** The page Next serves tRPC from. */
export const TRPC_PAGE = '/api/trpc/[trpc]';

/**
 * The request paths the fast path takes. A tRPC path is one or more `router.procedure` names joined
 * by commas, so a segment outside this alphabet — percent-encoding, a second slash, a trailing
 * slash, a backslash — is not a call our client makes and goes to Next, whose route matching and
 * decoding then decide it exactly as they do today.
 */
const FAST_PATH_PATHNAME = /^\/api\/trpc\/[A-Za-z0-9_.,-]+$/;

/**
 * @param {string | undefined} reqUrl the request target (`req.url`)
 * @returns {boolean}
 */
export function isFastPathUrl(reqUrl) {
  if (!reqUrl) return false;
  const q = reqUrl.indexOf('?');
  return FAST_PATH_PATHNAME.test(q === -1 ? reqUrl : reqUrl.slice(0, q));
}

/**
 * The Next internals the fast path calls, resolved from the app's own `next` install (in the image,
 * the traced copy under `.next/standalone/node_modules`), so they are always the version that built
 * the route and the proxy.
 *
 * @param {string} dir the app directory (`server.js`'s directory in the image)
 */
export function loadNextInternals(dir) {
  const req = createRequire(path.join(dir, 'package.json'));
  return {
    filterInternalHeaders: req('next/dist/server/lib/server-ipc/utils').filterInternalHeaders,
    filterReqHeaders: req('next/dist/server/lib/server-ipc/utils').filterReqHeaders,
    ipcForbiddenHeaders: req('next/dist/server/lib/server-ipc/utils').ipcForbiddenHeaders,
    toNodeOutgoingHttpHeaders: req('next/dist/server/web/utils').toNodeOutgoingHttpHeaders,
    splitCookiesString: req('next/dist/server/web/utils').splitCookiesString,
    getRelativeURL: req('next/dist/shared/lib/router/utils/relativize-url').getRelativeURL,
    urlQueryToSearchParams: req('next/dist/shared/lib/router/utils/querystring')
      .urlQueryToSearchParams,
    parseUrl: req('next/dist/shared/lib/router/utils/parse-url').parseUrl,
    formatHostname: req('next/dist/server/lib/format-hostname').formatHostname,
    addRequestMeta: req('next/dist/server/request-meta').addRequestMeta,
    allowedStatusCodes: req('next/dist/lib/redirect-status').allowedStatusCodes,
    RedirectStatusCode: req('next/dist/client/components/redirect-status-code').RedirectStatusCode,
    pipeToNodeResponse: req('next/dist/server/pipe-readable').pipeToNodeResponse,
    signalFromNodeResponse: req('next/dist/server/web/spec-extension/adapters/next-request')
      .signalFromNodeResponse,
    getTracer: req('next/dist/server/lib/trace/tracer').getTracer,
    buildCustomRoute: req('next/dist/server/lib/router-utils/filesystem').buildCustomRoute,
    matchHas: req('next/dist/shared/lib/router/utils/prepare-destination').matchHas,
    compileNonPath: req('next/dist/shared/lib/router/utils/prepare-destination').compileNonPath,
    normalizeLocalePath: req('next/dist/shared/lib/i18n/normalize-locale-path').normalizeLocalePath,
    addPathPrefix: req('next/dist/shared/lib/router/utils/add-path-prefix').addPathPrefix,
    getCloneableBody: req('next/dist/server/body-streams').getCloneableBody,
  };
}

/** A tRPC request path the startup checks below test the build's routing against. */
export const SAMPLE_TRPC_PATHNAME = '/api/trpc/model.getById,image.getInfinite';

/**
 * The properties of the build the fast path relies on to be allowed to skip Next's router, checked
 * against the build output itself. Throws, listing every violation, when one does not hold — the
 * server then refuses to start rather than serve tRPC differently from Next.
 *
 * @param {{ distDir: string, nextConfig: Record<string, any> }} opts
 */
export function assertFastPathAssumptions({ distDir, nextConfig }) {
  /** @type {string[]} */
  const problems = [];
  const readJson = (/** @type {string} */ p) =>
    JSON.parse(fs.readFileSync(path.join(distDir, p), 'utf8'));
  const sample = SAMPLE_TRPC_PATHNAME;

  // Router-server behaviours the fast path does not implement.
  if (nextConfig.compress !== false) problems.push('next.config compress is not false');
  if (nextConfig.basePath) problems.push('next.config has a basePath');
  if (nextConfig.experimental?.trustHostHeader) problems.push('experimental.trustHostHeader is on');

  if (nextConfig.i18n?.domains?.length) problems.push('i18n domain locales are configured');

  // next.config redirects / rewrites: none may apply to a tRPC path. (next.config `headers` DO
  // apply to every path — they are replicated, see `configHeadersFor`.) Under i18n, Next matches
  // custom routes against the default-locale-prefixed path, so both forms are tested.
  const routes = readJson('routes-manifest.json');
  const samples = nextConfig.i18n
    ? [sample, `/${nextConfig.i18n.defaultLocale}${sample}`]
    : [sample];
  if (routes.onMatchHeaders?.length) problems.push('the build has onMatchHeaders routes');
  const rewrites = Array.isArray(routes.rewrites)
    ? routes.rewrites
    : [
        ...(routes.rewrites?.beforeFiles ?? []),
        ...(routes.rewrites?.afterFiles ?? []),
        ...(routes.rewrites?.fallback ?? []),
      ];
  for (const [kind, list] of /** @type {const} */ ([
    ['redirect', routes.redirects ?? []],
    ['rewrite', rewrites],
  ])) {
    for (const route of list) {
      const hit = samples.find((p) => route.regex && new RegExp(route.regex).test(p));
      if (hit) problems.push(`a next.config ${kind} (${route.source}) matches ${hit}`);
    }
  }

  // The only page under /api/trpc is the [trpc] route.
  const pages = Object.keys(readJson(path.join('server', 'pages-manifest.json'))).filter((p) =>
    p.startsWith('/api/trpc')
  );
  if (pages.length !== 1 || pages[0] !== TRPC_PAGE) {
    problems.push(
      `expected ${TRPC_PAGE} to be the only page under /api/trpc, found ${pages.join(', ')}`
    );
  }
  let appPaths = {};
  try {
    appPaths = readJson(path.join('server', 'app-paths-manifest.json'));
  } catch {
    // no app router
  }
  const appTrpc = Object.keys(appPaths).filter((p) => p.startsWith('/api/trpc'));
  if (appTrpc.length) problems.push(`app routes under /api/trpc: ${appTrpc.join(', ')}`);

  // The proxy runs for every tRPC path (the fast path always runs it). resolve-routes matches the
  // proxy's matchers against the locale-prefixed path under i18n, so that is the form tested — the
  // bare path can match a page matcher by accident (its locale slot swallowing `/api`). A matcher
  // with `has`/`missing` conditions would make that per-request, which the fast path does not do.
  const functions = readJson(path.join('server', 'functions-config-manifest.json')).functions ?? {};
  const matchers = functions['/_middleware']?.matchers ?? [];
  const routed = samples[samples.length - 1];
  const proxyMatch = matchers.find((/** @type {any} */ m) => new RegExp(m.regexp).test(routed));
  if (!proxyMatch) problems.push(`the proxy's matchers do not match ${routed}`);
  else if (proxyMatch.has || proxyMatch.missing) {
    problems.push(`the proxy matcher for ${routed} (${proxyMatch.originalSource}) is conditional`);
  }

  for (const file of [
    path.join('server', 'pages', 'api', 'trpc', '[trpc].js'),
    path.join('server', 'middleware.js'),
  ]) {
    if (!fs.existsSync(path.join(distDir, file))) problems.push(`missing ${file}`);
  }

  if (problems.length) {
    throw new Error(
      `[trpc-server] the build does not satisfy the fast path's assumptions:\n  - ${problems.join(
        '\n  - '
      )}`
    );
  }
}

/**
 * The tRPC route and the proxy, as `next build` compiled them. Loaded with `require`, i.e. through
 * Node's module cache, so they are the same module instances Next itself loads when it serves those
 * entries — one prom registry, one redis client, one flag cache per process, whichever path served
 * the request. Awaited as Next awaits them: a Turbopack entry whose graph has top-level await
 * exports a thenable that settles to the module.
 *
 * @param {string} distDir absolute `.next` directory
 */
export async function loadCompiledEntries(distDir) {
  const req = createRequire(path.join(distDir, 'server', 'package.json'));
  const route = await req(path.join(distDir, 'server', 'pages', 'api', 'trpc', '[trpc].js'));
  if (typeof route?.handler !== 'function') {
    throw new Error(`[trpc-server] ${TRPC_PAGE} has no compiled route handler in ${distDir}`);
  }
  const proxy = await req(path.join(distDir, 'server', 'middleware.js'));
  if (typeof proxy?.default !== 'function') {
    throw new Error(`[trpc-server] no compiled proxy in ${distDir}`);
  }
  // As next-server.js passes it. The compiled entry's default export (Next's middleware template)
  // substitutes the user's `proxy` function for it, so its value only matters to that template.
  const proxyHandler = proxy.proxy || proxy.middleware || proxy;
  return { route, proxy, proxyHandler };
}

/**
 * Apply the proxy's response to the request and response, as Next's `resolve-routes.js` (the
 * `route.name === 'middleware'` branch) and the router server's response handling do, line for
 * line. Returns `true` when the proxy produced a terminal response, which has then been written.
 *
 * Mutates `req.headers` (the override and passthrough headers, as Next does) and sets the
 * passthrough response headers on `res` before the route runs, so the route's own `setHeader`
 * still wins, as it does under Next.
 *
 * @param {ReturnType<typeof loadNextInternals>} next
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {Response} middlewareRes the proxy's response
 * @param {string} initUrl the absolute URL Next's router computes for the request
 * @param {Record<string, any>} resHeaders the routing response headers so far (next.config
 *   `headers`, which resolve-routes evaluates before the proxy); the proxy's are added to it
 * @returns {Promise<boolean>}
 */
export async function applyProxyResponse(next, req, res, middlewareRes, initUrl, resHeaders) {
  const middlewareHeaders = next.toNodeOutgoingHttpHeaders(middlewareRes.headers);

  if (middlewareHeaders['x-middleware-override-headers']) {
    const overriddenHeaders = new Set();
    let overrideHeaders = middlewareHeaders['x-middleware-override-headers'];
    if (typeof overrideHeaders === 'string') overrideHeaders = overrideHeaders.split(',');
    for (const key of overrideHeaders) overriddenHeaders.add(key.trim());
    delete middlewareHeaders['x-middleware-override-headers'];
    // Delete headers.
    for (const key of Object.keys(req.headers)) {
      if (!overriddenHeaders.has(key)) delete req.headers[key];
    }
    // Update or add headers.
    for (const key of overriddenHeaders.keys()) {
      const valueKey = 'x-middleware-request-' + key;
      const newValue = middlewareHeaders[valueKey];
      const oldValue = req.headers[key];
      if (oldValue !== newValue) req.headers[key] = newValue === null ? undefined : newValue;
      delete middlewareHeaders[valueKey];
    }
  }

  if (
    !middlewareHeaders['x-middleware-rewrite'] &&
    !middlewareHeaders['x-middleware-next'] &&
    !middlewareHeaders['location']
  ) {
    middlewareHeaders['x-middleware-refresh'] = '1';
  }
  delete middlewareHeaders['x-middleware-next'];

  for (const [key, value] of Object.entries({
    ...next.filterReqHeaders(middlewareHeaders, next.ipcForbiddenHeaders),
  })) {
    if (
      [
        'content-length',
        'x-middleware-rewrite',
        'x-middleware-redirect',
        'x-middleware-refresh',
      ].includes(key)
    ) {
      continue;
    }
    // for set-cookie, the header shouldn't be added to the response
    // as it's only needed for the request to the middleware function.
    if (key === 'x-middleware-set-cookie') {
      req.headers[key] = value;
      continue;
    }
    if (value) {
      resHeaders[key] = value;
      req.headers[key] = value;
    }
  }

  // The router server applies the routing response headers before anything else.
  for (const key of Object.keys(resHeaders)) res.setHeader(key, resHeaders[key]);

  if (middlewareHeaders['location']) {
    const value = middlewareHeaders['location'];
    if (next.allowedStatusCodes.has(middlewareRes.status)) {
      // A redirect: resolve-routes relativises it, the router server writes it.
      const rel = next.getRelativeURL(value, initUrl);
      res.setHeader('location', rel);
      const destination = url.format(next.parseUrl(rel));
      res.statusCode = middlewareRes.status;
      res.setHeader('location', destination);
      if (middlewareRes.status === next.RedirectStatusCode.PermanentRedirect) {
        res.setHeader('Refresh', `0;url=${destination}`);
      }
      res.end(destination);
      return true;
    }
    res.setHeader('location', value);
    await writeProxyBody(next, res, middlewareRes);
    return true;
  }

  if (middlewareHeaders['x-middleware-refresh']) {
    await writeProxyBody(next, res, middlewareRes);
    return true;
  }

  return false;
}

/**
 * A terminal proxy response's body, as `resolve-routes` (an empty-string stream when the response
 * has a status but no body) and the router server (`pipeToNodeResponse`) write it.
 *
 * @param {ReturnType<typeof loadNextInternals>} next
 * @param {import('node:http').ServerResponse} res
 * @param {Response} middlewareRes
 */
async function writeProxyBody(next, res, middlewareRes) {
  res.statusCode = middlewareRes.status || 200;
  const bodyStream =
    middlewareRes.body ??
    new ReadableStream({
      start(/** @type {ReadableStreamDefaultController<any>} */ controller) {
        controller.enqueue('');
        controller.close();
      },
    });
  await next.pipeToNodeResponse(bodyStream, res);
}

/**
 * next.config `headers` as resolve-routes evaluates them, for one request: built from the routes
 * manifest with Next's own `buildCustomRoute`, matched against the default-locale-prefixed path,
 * `has`/`missing` conditions and `:param` interpolation included.
 *
 * @param {ReturnType<typeof loadNextInternals>} next
 * @param {Record<string, any>} routesManifest
 * @param {Record<string, any>} nextConfig
 */
export function createConfigHeaders(next, routesManifest, nextConfig) {
  const routes = (routesManifest.headers ?? []).map((/** @type {any} */ item) =>
    next.buildCustomRoute(
      'header',
      item,
      nextConfig.basePath,
      nextConfig.experimental?.caseSensitiveRoutes
    )
  );
  const i18n = nextConfig.i18n;
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {{ pathname: string, query: Record<string, any> }} parsed
   * @returns {Record<string, any>}
   */
  return function configHeadersFor(req, parsed) {
    /** @type {Record<string, any>} */
    const resHeaders = {};
    if (!routes.length) return resHeaders;
    let pathname = parsed.pathname || '/';
    if (i18n) {
      // resolve-routes: "ensure locale is present for resolving routes"
      const locale = next.normalizeLocalePath(pathname, i18n.locales);
      if (!locale.detectedLocale && !locale.pathname.startsWith('/_next/')) {
        pathname =
          locale.pathname === '/'
            ? `/${i18n.defaultLocale}`
            : next.addPathPrefix(locale.pathname || '', `/${i18n.defaultLocale}`);
      }
    }
    for (const route of routes) {
      let params = route.match(pathname);
      if ((route.has || route.missing) && params) {
        const hasParams = next.matchHas(req, parsed.query, route.has, route.missing);
        if (hasParams) Object.assign(params, hasParams);
        else params = false;
      }
      if (!params) continue;
      const hasParams = Object.keys(params).length > 0;
      for (const header of route.headers) {
        let { key, value } = header;
        if (hasParams) {
          key = next.compileNonPath(key, params);
          value = next.compileNonPath(value, params);
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
    return resHeaders;
  };
}

/**
 * Whether a next.config redirect or rewrite (routes-manifest `redirects` / `rewrites`) applies to a
 * request. resolve-routes would redirect or re-route it, which only Next's router can do, so such a
 * request goes to Next. Built with Next's own `buildCustomRoute`, matched (with `has`/`missing`)
 * against both the bare and the default-locale-prefixed path — a superset of what resolve-routes
 * tests, so the doubt resolves towards Next. None applies to a tRPC path today; startup also checks
 * that (`assertFastPathAssumptions`), so this is the per-request half of the same rule.
 *
 * @param {ReturnType<typeof loadNextInternals>} next
 * @param {Record<string, any>} routesManifest
 * @param {Record<string, any>} nextConfig
 */
export function createRouteDivert(next, routesManifest, nextConfig) {
  const build = (/** @type {string} */ type) => (/** @type {any} */ item) =>
    next.buildCustomRoute(
      type,
      item,
      nextConfig.basePath,
      nextConfig.experimental?.caseSensitiveRoutes
    );
  const rw = routesManifest.rewrites;
  const routes = [
    ...(routesManifest.redirects ?? []).map(build('redirect')),
    ...(Array.isArray(rw)
      ? rw.map(build('rewrite'))
      : [
          ...(rw?.beforeFiles ?? []).map(build('before_files_rewrite')),
          ...(rw?.afterFiles ?? []).map(build('rewrite')),
          ...(rw?.fallback ?? []).map(build('rewrite')),
        ]),
  ];
  const prefix = nextConfig.i18n ? `/${nextConfig.i18n.defaultLocale}` : '';
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {{ pathname: string, query: Record<string, any> }} parsed
   */
  return function divertsToNext(req, parsed) {
    const pathnames = prefix ? [parsed.pathname, `${prefix}${parsed.pathname}`] : [parsed.pathname];
    return routes.some((route) =>
      pathnames.some((pathname) => {
        const params = route.match(pathname);
        if (!params) return false;
        if (!route.has && !route.missing) return true;
        return !!next.matchHas(req, parsed.query, route.has, route.missing);
      })
    );
  };
}

/**
 * @typedef {object} FastPathOptions
 * @property {string} dir app directory (cwd of the server)
 * @property {string} distDir absolute `.next` directory
 * @property {string} hostname the hostname the server was started with (`HOSTNAME`, as `server.js`)
 * @property {number} port the port the server listens on
 * @property {Record<string, any>} nextConfig the build's resolved next config
 * @property {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} nextHandler
 *   Next's own request handler — the fallback for every request this module does not take
 * @property {ReturnType<typeof loadNextInternals>} [next]
 * @property {Awaited<ReturnType<typeof loadCompiledEntries>>} entries the compiled route and proxy
 * @property {Record<string, any>} [routesManifest] defaults to the build's `routes-manifest.json`
 */

/**
 * @param {FastPathOptions} opts
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 *   handles a request whose URL `isFastPathUrl` accepted
 */
export function createTrpcFastPath(opts) {
  const next = opts.next ?? loadNextInternals(opts.dir);
  const { entries } = opts;
  const routesManifest =
    opts.routesManifest ??
    JSON.parse(fs.readFileSync(path.join(opts.distDir, 'routes-manifest.json'), 'utf8'));
  const configHeadersFor = createConfigHeaders(next, routesManifest, opts.nextConfig);
  const divertsToNext = createRouteDivert(next, routesManifest, opts.nextConfig);
  const { nextConfig, nextHandler } = opts;
  const fetchHostname = next.formatHostname(opts.hostname || 'localhost');
  const relativeProjectDir = path.relative(process.cwd(), opts.dir);
  const proxyNextConfig = {
    basePath: nextConfig.basePath,
    i18n: nextConfig.i18n,
    trailingSlash: nextConfig.trailingSlash,
    experimental: nextConfig.experimental,
  };

  return async function handleTrpcRequest(req, res) {
    // internal headers should not be honored by the request handler (router-server.js)
    if (!process.env.NEXT_PRIVATE_TEST_HEADERS) next.filterInternalHeaders(req.headers);
    req.on('error', () => {});
    res.on('error', () => {});

    const reqUrl = req.url || '/';
    const parsed = next.parseUrl(reqUrl);
    if (divertsToNext(req, parsed)) return nextHandler(req, res);

    const protocol =
      /** @type {any} */ (req.socket)?.encrypted ||
      String(req.headers['x-forwarded-proto'] ?? '').includes('https')
        ? 'https'
        : 'http';
    // resolve-routes.js: the absolute URL redirects are relativised against.
    const initUrl = `${protocol}://${fetchHostname}:${opts.port}${reqUrl}`;

    // base-server.js handleRequestImpl, which runs before the proxy is invoked: "Update the
    // `x-forwarded-*` headers". The app reads them (client IP, host), and so does the proxy.
    const xForwardedProto = req.headers['x-forwarded-proto'];
    const isHttps = xForwardedProto
      ? xForwardedProto === 'https'
      : !!(/** @type {any} */ (req.socket)?.encrypted);
    req.headers['x-forwarded-host'] ??= req.headers['host'] ?? opts.hostname;
    req.headers['x-forwarded-port'] ??= opts.port ? opts.port.toString() : isHttps ? '443' : '80';
    req.headers['x-forwarded-proto'] ??= isHttps ? 'https' : 'http';
    req.headers['x-forwarded-for'] ??= req.socket?.remoteAddress;

    // NextNodeServer.runMiddleware: the URL and request the proxy is handed.
    const query = next.urlQueryToSearchParams(parsed.query).toString();
    const proxyUrl = `${protocol}://${fetchHostname}:${opts.port}${parsed.pathname}${
      query ? `?${query}` : ''
    }`;
    const method = (req.method || 'GET').toUpperCase();
    // NextNodeServer.attachRequestMeta + runMiddleware: the proxy gets a clone of the body, and
    // `finalize` then swaps the request's stream for the buffered copy — which holds at most
    // `proxyClientMaxBodySize` (10MB by default) of it. That truncation is Next's behaviour for a
    // larger body (the route then sees invalid JSON), so it is reproduced, not fixed, here.
    const clonableBody = next.getCloneableBody(
      req,
      nextConfig.experimental?.proxyClientMaxBodySize
    );
    const body = method !== 'GET' && method !== 'HEAD' ? clonableBody : undefined;
    const hasRequestBody =
      !['HEAD', 'GET'].includes(/** @type {string} */ (req.method)) && Boolean(body);

    let result;
    try {
      try {
        result = await next.getTracer().runWithDetachedContext(() =>
          entries.proxy.default({
            handler: entries.proxyHandler,
            request: {
              headers: req.headers,
              method,
              nextConfig: proxyNextConfig,
              url: proxyUrl,
              page: {},
              body: hasRequestBody ? body?.cloneBodyStream() : undefined,
              signal: next.signalFromNodeResponse(res),
              waitUntil: undefined,
            },
            page: 'middleware',
          })
        );
      } finally {
        if (hasRequestBody) await body?.finalize();
      }
    } catch (err) {
      // Next renders its error page for a proxy that throws; let it, by handing it the request
      // (which runs the proxy again, under Next).
      console.error('[trpc-server] proxy threw; handing the request to Next', err);
      return nextHandler(req, res);
    }
    result?.waitUntil?.catch((error) => {
      console.error(`Uncaught: middleware waitUntil errored`, error);
    });
    const middlewareRes = result?.response;
    if (!middlewareRes) return nextHandler(req, res);

    // A rewrite would re-route the request; only Next's router can do that. None of today's
    // proxy middlewares rewrites a tRPC call. The only changes made to the request so far are ones
    // Next repeats idempotently (the internal-header filter, x-forwarded-* `??=`, the buffered
    // body), so hand it over; the proxy then runs a second time, under Next.
    if (middlewareRes.headers.has('x-middleware-rewrite')) return nextHandler(req, res);

    // NextNodeServer.runMiddleware: split compound set-cookie headers, keep them for the route.
    if (middlewareRes.headers.has('set-cookie')) {
      const cookies = middlewareRes.headers
        .getSetCookie()
        .flatMap((c) => next.splitCookiesString(c));
      middlewareRes.headers.delete('set-cookie');
      for (const cookie of cookies) middlewareRes.headers.append('set-cookie', cookie);
      next.addRequestMeta(req, 'middlewareCookie', cookies);
    }

    const resHeaders = configHeadersFor(req, parsed);
    if (await applyProxyResponse(next, req, res, middlewareRes, initUrl, resHeaders)) return;
    if (res.closed || res.writableEnded) return;

    // NextNodeServer.handleApiRequest: the route handles its own parsing from here.
    next.addRequestMeta(req, 'relativeProjectDir', relativeProjectDir);
    next.addRequestMeta(req, 'distDir', opts.distDir);
    await entries.route.handler(req, res, { waitUntil: undefined });
  };
}
