// @ts-check
/**
 * What serving `/api/trpc/<path>` through Next does, and what the standalone fast path
 * (`fast-path.mjs`) does instead — one entry per effect.
 *
 * `how` is one of:
 *   - `same-code`  the fast path runs the very code Next runs (the compiled proxy, the compiled
 *                  route, or a Next internal it calls by name), so the effect cannot drift;
 *   - `replicated` the fast path reimplements it, copied from the Next source named in `next`;
 *   - `checked`    a property the fast path depends on, verified at startup (it refuses to start
 *                  rather than serve differently), see `assertFastPathAssumptions`;
 *   - `not-applicable` it has no effect on an `/api/trpc/<path>` request; `why` says why.
 *
 * `scripts/__tests__/trpc-server-parity-ledger.test.ts` fails when a middleware is added to or
 * removed from the proxy chain (`src/server/middleware/index.ts`) without its entry here.
 */

/**
 * @typedef {'same-code' | 'replicated' | 'checked' | 'not-applicable'} How
 * @typedef {{ effect: string, how: How, why: string }} MiddlewareEntry
 * @typedef {{ id: string, next: string, effect: string, how: How, why: string }} NextEntry
 */

/**
 * The proxy chain, in order. Keys are the export names in `src/server/middleware/`. The whole chain
 * runs on the fast path exactly as under Next — the compiled `.next/server/middleware.js`, called
 * through the same adapter — so every entry is `same-code`; `effect` records what each one does to
 * a tRPC call, which is what the behavioural parity checks exercise.
 *
 * @type {Record<string, MiddlewareEntry>}
 */
export const proxyMiddlewareLedger = {
  regionBlockMiddleware: {
    effect:
      'none for /api/trpc (shouldRunRegionMiddleware excludes /api); pages: 307 to /region-blocked',
    how: 'same-code',
    why: 'compiled proxy; were it to redirect, the redirect is relativised and written as resolve-routes + router-server do',
  },
  regionRestrictionMiddleware: {
    effect:
      'none for /api/trpc (shouldRunRegionMiddleware excludes /api); pages: redirect to the green primary',
    how: 'same-code',
    why: 'compiled proxy; still runs its shouldRun',
  },
  apiRegionBlockMiddleware: {
    effect: 'API-blocked country → terminal 451 JSON',
    how: 'same-code',
    why: 'compiled proxy; terminal body piped as the router server pipes it',
  },
  routeGuardsMiddleware: {
    effect: 'none for /api/trpc (its only guard matches /api/testing)',
    how: 'same-code',
    why: 'compiled proxy; still runs, still a no-op on this path',
  },
  apiCacheMiddleware: {
    effect:
      'default Cache-Control: max-age=0, private, no-cache (+ X-Handled-By when PODNAME is set)',
    how: 'same-code',
    why: 'compiled proxy; passthrough headers are set on the response before the route (so its responseMeta still wins) and copied onto the request, as resolve-routes does',
  },
  syncAccountNoindexMiddleware: {
    effect: 'none for /api/trpc (shouldRun excludes /api/)',
    how: 'same-code',
    why: 'compiled proxy; still runs its shouldRun',
  },
  botDetectionMiddleware: {
    effect: 'sets x-civitai-verified-bot for a verified crawler, STRIPS a client-supplied one',
    how: 'same-code',
    why: 'compiled proxy; its request-header override is applied by the copied resolve-routes override block, which deletes every request header not in the override list',
  },
};

/**
 * Next's own handling of an `/api/trpc/<path>` request, outside the proxy chain.
 *
 * @type {NextEntry[]}
 */
export const nextBehaviourLedger = [
  {
    id: 'internal-header-filter',
    next: 'router-server.js requestHandlerImpl → filterInternalHeaders',
    effect: 'drops client-sent x-middleware-* / x-matched-path / x-nextjs-data etc.',
    how: 'same-code',
    why: 'calls the same filterInternalHeaders',
  },
  {
    id: 'socket-error-listeners',
    next: "router-server.js: req.on('error') / res.on('error') no-ops",
    effect: 'a socket error does not become an unhandled error event',
    how: 'replicated',
    why: 'same two listeners',
  },
  {
    id: 'request-listener-500',
    next: 'start-server.js requestListener catch → 500 Internal Server Error',
    effect: 'an exception escaping the handler is answered, logged',
    how: 'replicated',
    why: 'same catch around the fast path in server.mjs',
  },
  {
    id: 'compression',
    next: 'router-server.js: compression() when config.compress !== false',
    effect: 'none: next.config sets compress: false',
    how: 'checked',
    why: 'startup refuses to run if compress is not false',
  },
  {
    id: 'locale-redirect',
    next: 'router-server.js getLocaleRedirect',
    effect: 'none: only redirects the root path /',
    how: 'not-applicable',
    why: 'getLocaleRedirect returns nothing unless the pathname is /',
  },
  {
    id: 'repeated-slash-redirect',
    next: 'resolve-routes.js: // or \\ in the path → 308',
    effect: 'normalising redirect',
    how: 'not-applicable',
    why: 'such a path does not match the fast-path pattern, so Next serves it',
  },
  {
    id: 'config-headers',
    next: 'resolve-routes.js: next.config headers() (routes-manifest `headers`), matched on the default-locale-prefixed path',
    effect: 'X-Frame-Options on every path today, including API responses and proxy-terminal ones',
    how: 'replicated',
    why: 'built with Next’s own buildCustomRoute and matched/compiled with its matchHas/compileNonPath, per request (createConfigHeaders)',
  },
  {
    id: 'config-redirects-rewrites',
    next: 'resolve-routes.js: next.config redirects / rewrites (incl. next-axiom rewrites, the trailing-slash redirect)',
    effect: 'none match /api/trpc/<path> today',
    how: 'checked',
    why: 'per request, any redirect/rewrite that matches (Next’s buildCustomRoute + matchHas, bare and locale-prefixed path) hands the request to Next; startup also refuses a build where one matches a sample tRPC path, so the fast path is not silently bypassed; onMatchHeaders must be empty',
  },
  {
    id: 'route-matching',
    next: 'resolve-routes.js fsChecker: static/public files, _next/data, page matching',
    effect: 'resolves /api/trpc/<path> to the /api/trpc/[trpc] page',
    how: 'checked',
    why: 'startup requires /api/trpc/[trpc] to be the only page under /api/trpc; the fast-path pattern is a subset of what it matches',
  },
  {
    id: 'proxy-matcher',
    next: 'resolve-routes.js: getMiddlewareMatchers() gates the proxy',
    effect: 'the proxy runs for /api/trpc/:path*',
    how: 'checked',
    why: 'startup requires the built matchers to match a tRPC path; the fast path then always runs the proxy',
  },
  {
    id: 'x-forwarded-headers',
    next: 'base-server.js handleRequestImpl: x-forwarded-host/-port/-proto/-for ??= host, server port, scheme, socket address',
    effect:
      'the proxy and the route see x-forwarded-* even when the client sent none (x-forwarded-for drives client-IP attribution)',
    how: 'replicated',
    why: 'same four ??= assignments, before the proxy runs, as in Next',
  },
  {
    id: 'incremental-cache-and-fetch-patch',
    next: 'base-server.js: per-request incrementalCache request meta; next-server.js patches global fetch',
    effect: 'app-router / ISR fetch caching',
    how: 'not-applicable',
    why: 'pages API routes do not use the incremental cache; the fetch patch is process-wide, so the fast path runs under the same one',
  },
  {
    id: 'proxy-invocation',
    next: 'next-server.js runMiddleware → adapter({ handler, request, page })',
    effect:
      'builds the proxy URL from the server hostname:port + re-serialised query; NextRequest, NextURL (i18n), flight-header stripping, the "middleware GET" span, detached from the request span',
    how: 'same-code',
    why: 'same adapter export of the compiled proxy, same request object, same runWithDetachedContext; the URL is built by the copied expression',
  },
  {
    id: 'proxy-on-demand-revalidate-skip',
    next: 'next-server.js runMiddleware: skips the proxy for a valid x-prerender-revalidate',
    effect: 'proxy skipped for a request carrying the preview-mode secret',
    how: 'not-applicable',
    why: 'tRPC is not ISR; the fast path always runs the proxy, which is the stricter behaviour',
  },
  {
    id: 'proxy-body-clone',
    next: 'next-server.js attachRequestMeta → getCloneableBody; runMiddleware hands the proxy a clone, then finalize()',
    effect:
      'the proxy can read a POST body; the route then reads a buffered copy truncated at proxyClientMaxBodySize (10MB default), so a body over that reaches the route cut short (a JSON body → 400 Invalid JSON) before the route’s 17mb limit can apply',
    how: 'same-code',
    why: 'calls the same getCloneableBody / cloneBodyStream / finalize, so the truncation is reproduced, not fixed',
  },
  {
    id: 'proxy-set-cookie-split',
    next: 'next-server.js runMiddleware: split compound set-cookie, addRequestMeta middlewareCookie',
    effect: 'proxy cookies reach the route response',
    how: 'replicated',
    why: 'same code; no proxy middleware sets a cookie today',
  },
  {
    id: 'proxy-result-application',
    next: "resolve-routes.js route.name === 'middleware' + router-server.js response handling",
    effect:
      'request-header overrides (+ deletion of headers not listed), passthrough headers on response AND request, redirect (relativised, Refresh on 308), terminal body',
    how: 'replicated',
    why: 'copied line for line into applyProxyResponse',
  },
  {
    id: 'proxy-rewrite',
    next: 'resolve-routes.js: x-middleware-rewrite re-routes the request',
    effect: 'none today',
    how: 'checked',
    why: 'a rewrite response is handed to Next untouched (nothing mutated yet)',
  },
  {
    id: 'proxy-throws',
    next: 'next-server.js handleCatchallMiddlewareRequest catch → error page',
    effect: '500 (or 400 for a DecodeError) error page',
    how: 'checked',
    why: 'the request is handed to Next, which renders the same',
  },
  {
    id: 'route-handler',
    next: 'next-server.js handleApiRequest → module.handler(req, res, { waitUntil, requestMeta })',
    effect:
      'query + [trpc] param parsing, i18n normalisation, req.cookies, req.query, preview props, body parsing (17mb limit, 413), res.status/send/json, >4MB response warning, the root request span name and http.route, onRequestError',
    how: 'same-code',
    why: 'calls the compiled route entry`s own handler; it re-derives query/params itself (prepare), exactly as an adapter-hosted Next does',
  },
  {
    id: 'trpc-handler',
    next: 'src/pages/api/trpc/[trpc].ts default export',
    effect:
      'withAxiom, batch-width + block-token metrics, devalue/superjson negotiation (x-client / x-client-version), createContext (session from req.cookies, origin check, flags, tracker, abort signal), batching + maxBatchSize, method override, per-procedure rate limits and prom metrics, responseMeta Cache-Control + Set-Cookie strip on edge-cached responses, onError logging + 5xx metric, streamed responses',
    how: 'same-code',
    why: 'the same compiled module instance Next loads, reached through the same route handler',
  },
  {
    id: 'otel-spans',
    next: 'base-server.js / route template: the per-request SERVER span `GET /api/trpc/[trpc]` (http.route set, parent span renamed); router-internal spans under NEXT_OTEL_VERBOSE',
    effect: 'trace shape',
    how: 'same-code',
    why: 'the route template creates the same handleRequest span when no Next server span wraps it (an adapter-hosted route); the proxy span comes from the same adapter. Only Next router-internal spans (verbose mode, off here) are absent. Read from the Next source; not yet observed with OTel enabled',
  },
  {
    id: 'cors',
    next: 'Next sets no CORS headers of its own',
    effect: 'none',
    how: 'not-applicable',
    why: 'any CORS/origin handling is the app’s (createContext’s origin check, next.config headers), both covered above',
  },
  {
    id: 'other-paths',
    next: 'everything that is not /api/trpc/<path>',
    effect: 'health, readiness, metrics, pages, other API routes, static files',
    how: 'same-code',
    why: 'served by Next’s own request listener in the same process',
  },
  {
    id: 'boot',
    next: 'server.js: env, chdir, config, startServer (signals, keep-alive, instrumentation register)',
    effect: 'process lifecycle',
    how: 'same-code',
    why: 'server.mjs repeats server.js and calls the same startServer; register() is Next’s memoised one',
  },
];
