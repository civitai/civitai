'use strict';
/**
 * Standalone tRPC server for the API pool.
 *
 * It serves `/api/trpc/[trpc]` plus the probe and metrics routes from the SAME compiled
 * pages-API route modules that `server.js` serves, by calling each module's exported
 * `handler(req, res, ctx)` — Next's own direct-invocation contract
 * (`next/dist/build/templates/pages-api.js`). That keeps everything the route module does per
 * request (instrumentation, the request span, `prepare`, `apiResolver`: cookies, query, the
 * 17mb body parse) and skips the router-server, the proxy and base-server. What it still has to
 * do in their place is in `./next-compat.cjs`.
 *
 * Mode: `TRPC_SERVER_MODE=route` (the default) is the only one implemented. Anything else exits
 * non-zero at boot.
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

/** The only pages this server answers. Anything else is a 404. */
const SERVED_PAGES = ['/api/trpc/[trpc]', '/api/live', '/api/health', '/api/ready', '/api/metrics'];
for (const page of SERVED_PAGES) {
  if (!pagesManifest[page]) throw new Error(`[trpc-server] ${page} is not in pages-manifest.json`);
}

const routing = compat.createRouting({ routesManifest, nextConfig });
const matchPage = compat.createPageMatcher(SERVED_PAGES);
const routeModules = new Map();
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

  const mod = routeModules.get(matched.page);
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
  console.log(`[trpc-server] listening on ${hostname}:${listenPort} (mode ${MODE})`);

  try {
    // --- 4. instrumentation.ts register() --------------------------------------------------------
    // The route modules would also trigger this on their first request (ensureInstrumentation);
    // it is memoised process-wide in this same module, so that later call is a no-op.
    await compat.ensureInstrumentationRegistered(dir, nextConfig.distDir || '.next');
    console.log('[trpc-server] instrumentation registered');

    // --- 5. route modules -----------------------------------------------------------------------
    for (const page of SERVED_PAGES) {
      // Awaited, as Next's NodeModuleLoader does: a route whose graph has top-level await is
      // compiled as an async module, and `require` then returns a promise of its exports.
      const mod = await require(path.join(distDir, 'server', pagesManifest[page]));
      if (typeof mod.handler !== 'function') {
        throw new Error(`[trpc-server] ${page} has no exported handler(req, res, ctx)`);
      }
      routeModules.set(page, mod);
    }
    console.log(`[trpc-server] ready: ${SERVED_PAGES.join(', ')}`);
    markReady();
  } catch (err) {
    markFailed(err);
    console.error('[trpc-server] boot failed');
    console.error(err);
    process.exit(1);
  }
});

server.listen(currentPort, hostname);
