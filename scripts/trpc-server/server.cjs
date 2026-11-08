'use strict';
/**
 * Standalone tRPC server for the API pool.
 *
 * It serves `/api/trpc/[trpc]`, the internal image-delivery lookup
 * (`/api/internal/image-delivery/[id]`, a high-volume route whose handler is tiny, so most of its
 * cost under Next is the router), the three browser beacons (`/api/internal/ping`,
 * `/api/internal/pulse`, `/api/track/batch`: high-volume POSTs with tiny handlers, the same
 * reason), plus the probe and metrics routes (the list is `./served-pages.cjs`) from the SAME
 * compiled pages-API route modules that `server.js` serves, by calling each module's exported
 * `handler(req, res, ctx)` — Next's own direct-invocation contract
 * (`next/dist/build/templates/pages-api.js`). That keeps everything the route module does per
 * request (instrumentation, the request span, `prepare`, `apiResolver`: cookies, query, and the
 * body parse under the module's own `config.api.bodyParser`, 17mb for tRPC and Next's 1mb default
 * for the beacons) and skips the router-server, the proxy and base-server. What it still has to
 * do in their place is in `./next-compat.cjs`.
 *
 * Mode: `TRPC_SERVER_MODE=route` (the default) is the only one implemented. Anything else exits
 * non-zero at boot.
 *
 * Profile: `STANDALONE_SERVER_PROFILE` picks WHICH pages it serves (`./served-pages.cjs`). `trpc`
 * (the default, unset) is the fixed list above. `api` adds every pages-API route under `/api/v1/`,
 * which the proxy covers under Next, so before those routes run it does what Next does around the
 * proxy: the proxy's request-body cap (non-GET bodies cut at `proxyClientMaxBodySize`), then the
 * proxy middlewares' effect (451 region block, default response headers, verified-crawler request
 * header) through the one implementation the proxy and the tRPC route share. An unknown profile
 * exits non-zero at boot, and so does `api` when instrumentation did not register that policy.
 * A redirect or rewrite that could apply to a served page also stops the boot (neither is
 * ported). A route module that fails to load is logged and answers 500 instead, unless it is on
 * the fixed tRPC list, which still stops the boot.
 *
 * Boot order mirrors `server.js` + `next/dist/server/lib/start-server.js`:
 *   1. process env, chdir and the standalone config, exactly as the generated `server.js` sets them
 *   2. `require('next')`, which installs Next's require hooks
 *   3. listen (requests wait until 5 has finished, as they do under start-server)
 *   4. `instrumentation.ts` `register()` — OTel, the liveness heartbeat, the enum-array pg
 *      parsers, the log sink, the warmer. Awaited, and run HERE rather than left to the first
 *      request, because the liveness heartbeat must start at boot.
 *   5. load the route modules (Next preloads entries after instrumentation too)
 *
 * Start: `node -- trpc-server/server.cjs` from the image root (`/app`).
 */

// Plain CommonJS that runs without a compile step, so `require` is the only way to load here.
/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const dir = path.join(__dirname, '..');

const MODE = process.env.TRPC_SERVER_MODE || 'route';
if (MODE !== 'route') {
  console.error(
    `[trpc-server] TRPC_SERVER_MODE=${JSON.stringify(MODE)} is not implemented; only "route" is.`
  );
  process.exit(1);
}

/** Which pages to serve (see that file). Unset is the `trpc` profile, the list this server always served. */
const served = require('./served-pages.cjs');
const PROFILE = served.resolveProfile(process.env.STANDALONE_SERVER_PROFILE);
if (!PROFILE) {
  console.error(
    `[trpc-server] STANDALONE_SERVER_PROFILE=${JSON.stringify(
      process.env.STANDALONE_SERVER_PROFILE
    )} is not a profile; expected one of ${served.PROFILES.join(', ')}.`
  );
  process.exit(1);
}

// --- 1. what the generated server.js does before starting Next ---------------------------------

process.env.NODE_ENV = 'production';
process.chdir(dir);

const currentPort = parseInt(process.env.PORT, 10) || 3000;
const hostname = process.env.HOSTNAME || '0.0.0.0';

let keepAliveTimeout = parseInt(process.env.KEEP_ALIVE_TIMEOUT, 10);
if (Number.isNaN(keepAliveTimeout) || !Number.isFinite(keepAliveTimeout) || keepAliveTimeout < 0) {
  keepAliveTimeout = undefined;
}

/**
 * The config object the generated `server.js` inlines. Read from that file rather than from
 * `required-server-files.json` because the two differ (`distDir` is rewritten for standalone),
 * and `server.js` is what Next itself boots with.
 */
function readStandaloneNextConfig(serverJsPath) {
  const source = fs.readFileSync(serverJsPath, 'utf8');
  const line = source.split('\n').find((l) => l.startsWith('const nextConfig = '));
  if (!line) {
    throw new Error(`[trpc-server] no "const nextConfig = " line in ${serverJsPath}`);
  }
  return JSON.parse(line.slice('const nextConfig = '.length));
}

const nextConfig = readStandaloneNextConfig(path.join(dir, 'server.js'));
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);

// --- 2. Next's require hooks --------------------------------------------------------------------

// The same side-effect modules `server.js` -> start-server -> router-server -> next-server load
// before any application code: require hooks, the crypto polyfill, and node-environment (console,
// setImmediate, unhandled-rejection and crypto/date/random extensions).
require('next');
require('next/dist/server/lib/cpu-profile');
require('next/dist/server/require-hook');
require('next/dist/server/node-polyfill-crypto');
require('next/dist/server/node-environment');
// The Next helpers this file uses come through next-compat, which checks every one of them as it
// loads (see `expectExport` there), so a Next upgrade that drops one fails the image build.
const compat = require('./next-compat.cjs');

// What the NextNodeServer constructor installs from the config, before instrumentation runs.
compat.installGlobalBehaviors(nextConfig);
compat.setHttpClientAndAgentOptions(nextConfig);
compat.installProcessErrorHandlers(
  Boolean(
    nextConfig.experimental && nextConfig.experimental.removeUncaughtErrorAndRejectionListeners
  )
);

const distDir = path.join(dir, nextConfig.distDir || '.next');
const routesManifest = JSON.parse(
  fs.readFileSync(path.join(distDir, 'routes-manifest.json'), 'utf8')
);
const pagesManifest = JSON.parse(
  fs.readFileSync(path.join(distDir, 'server', 'pages-manifest.json'), 'utf8')
);

/** The only pages this server answers (see `./served-pages.cjs`). Anything else is a 404. */
const SERVED_PAGES = served.servedPages(PROFILE, pagesManifest);
for (const page of SERVED_PAGES) {
  if (!pagesManifest[page]) throw new Error(`[trpc-server] ${page} is not in pages-manifest.json`);
}

// Refuses to start if a redirect or rewrite (neither is ported) could apply to a served page.
const routing = compat.createRouting({ routesManifest, nextConfig, pages: SERVED_PAGES });
const matchPage = compat.createPageMatcher(SERVED_PAGES);
const routeModules = compat.createRouteModuleLoader(
  // Awaited, as Next's NodeModuleLoader does: a route whose graph has top-level await is
  // compiled as an async module, and `require` then returns a promise of its exports.
  (page) => require(path.join(distDir, 'server', pagesManifest[page])),
  (message, err) => console.error(message, err)
);
/**
 * `applyApiRequestPolicy(req, res)` from instrumentation (set at boot when a served page needs it):
 * true when it has answered the request itself (the 451).
 */
let applyApiPolicy = null;
const relativeProjectDir = path.relative(process.cwd(), dir);

// --- request handling -----------------------------------------------------------------------------

let listenPort = currentPort;

async function handle(req, res) {
  // Socket errors must not become unhandled 'error' events (router-server registers the same).
  req.on('error', () => {});
  res.on('error', () => {});

  // router-server: client-sent internal headers are never honoured.
  if (!process.env.NEXT_PRIVATE_TEST_HEADERS) {
    compat.filterInternalHeaders(req.headers);
  }

  const routed = compat.resolveRouting(routing, req);

  // Under Next the undecodable-path DecodeError is thrown while routes are still being resolved,
  // before the routing headers are applied, so the 400 carries none of them. A plain 404 is
  // answered after they are applied.
  const pathname = (req.url || '/').split('?', 1)[0];
  const matched = matchPage(pathname);
  if (matched.decodeError) return compat.sendBadRequest(res);
  compat.applyRoutingHeaders(res, routed.headers);
  if (matched.notFound) return compat.sendNotFound(res);

  compat.fillForwardedHeaders(req, { hostname, port: listenPort });
  compat.stripInternalQuery(req);

  // What Next does around the proxy, for the pages it covers there. Next invokes the proxy through
  // base-server's request handler, which has already filled the `x-forwarded-*` headers above on
  // this same request, so the proxy (and so the policy here) sees them. First the proxy's
  // request-body cap (a clone-and-truncate of non-GET bodies), then the proxy middlewares' effect.
  if (applyApiPolicy && served.needsApiPolicy(matched.page)) {
    await compat.applyProxyBodyLimit(req, nextConfig);
    if (applyApiPolicy(req, res)) return;
  }

  // Rejects while the page's module fails to load; requestListener answers that with a 500.
  const mod = await routeModules.get(matched.page);
  await mod.handler(req, res, {
    waitUntil: undefined,
    requestMeta: { relativeProjectDir, distDir },
  });
}

// --- 3. listen; hold requests until boot has finished (start-server's handlersPromise) ---------

let ready = null;
let markReady;
let markFailed;
const readyPromise = new Promise((resolve, reject) => {
  markReady = resolve;
  markFailed = reject;
});
readyPromise.then(
  () => {
    ready = true;
  },
  () => {}
);

async function requestListener(req, res) {
  try {
    if (!ready) await readyPromise;
    await handle(req, res);
  } catch (err) {
    // start-server's requestListener.
    res.statusCode = 500;
    res.end('Internal Server Error');
    console.error(`[trpc-server] Failed to handle request for ${req.url}`);
    console.error(err);
  }
}

process.title = 'trpc-server';
const server = http.createServer(requestListener);
if (keepAliveTimeout) server.keepAliveTimeout = keepAliveTimeout;

server.on('error', (err) => {
  console.error('[trpc-server] Failed to start server');
  console.error(err);
  process.exit(1);
});

// SIGTERM / SIGINT: start-server's cleanup. Stop accepting, let in-flight requests finish, then
// exit with the signal's code. The preStop sleep in front of this is what drains a pod.
let cleanupStarted = false;
function cleanup(signal) {
  if (cleanupStarted) return;
  cleanupStarted = true;
  server.close((err) => {
    if (err) console.error(err);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}
if (!process.env.NEXT_MANUAL_SIG_HANDLE) {
  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));
}

server.on('listening', async () => {
  const addr = server.address();
  listenPort = typeof addr === 'object' && addr ? addr.port : listenPort;
  // start-server exports the bound port; the warmer self-requests on it.
  process.env.PORT = String(listenPort);
  console.log(
    `[trpc-server] listening on ${hostname}:${listenPort} (mode ${MODE}, profile ${PROFILE})`
  );

  try {
    // --- 4. instrumentation.ts register() --------------------------------------------------------
    // The route modules would also trigger this on their first request (ensureInstrumentation);
    // it is memoised process-wide in this same module, so that later call is a no-op.
    await compat.ensureInstrumentationRegistered(dir, nextConfig.distDir || '.next');
    console.log('[trpc-server] instrumentation registered');

    // The proxy's API policy, for a profile that serves pages the proxy covers under Next.
    // Registered by instrumentation (`registerStandaloneApiPolicy`); its absence is a boot failure,
    // never a silent pass-through.
    if (SERVED_PAGES.some(served.needsApiPolicy)) {
      applyApiPolicy = globalThis[Symbol.for(served.API_POLICY_GLOBAL_KEY)];
      if (typeof applyApiPolicy !== 'function') {
        throw new Error(
          `[trpc-server] profile ${PROFILE} serves proxy-covered pages, but instrumentation registered no API policy`
        );
      }
    }

    // --- 5. route modules -----------------------------------------------------------------------
    // A page whose module fails to load is logged and skipped (requests to it retry the load and
    // answer 500 while it fails), so one broken /api/v1/ route cannot take down the rest. The
    // exception is the fixed tRPC list, every profile's core: a failure there still stops the boot,
    // exactly as before profiles existed, so an image that cannot serve tRPC crash-loops and stalls
    // its rollout instead of going Ready and answering 500.
    const failed = await routeModules.preload(SERVED_PAGES);
    const failedCore = failed.filter((page) => served.TRPC_PAGES.includes(page));
    if (failedCore.length > 0) {
      throw new Error(`[trpc-server] core page(s) failed to load: ${failedCore.join(', ')}`);
    }
    console.log(
      `[trpc-server] ready (profile ${PROFILE}, ${SERVED_PAGES.length} pages${
        failed.length ? `, ${failed.length} failed to load: ${failed.join(', ')}` : ''
      }): ${SERVED_PAGES.join(', ')}`
    );
    markReady();
  } catch (err) {
    markFailed(err);
    console.error('[trpc-server] boot failed');
    console.error(err);
    process.exit(1);
  }
});

server.listen(currentPort, hostname);
