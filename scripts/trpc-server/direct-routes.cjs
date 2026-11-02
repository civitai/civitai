'use strict';
/**
 * Serves a few hot pages-API routes in the Next process WITHOUT Next's router.
 *
 * `./next-entry.cjs` (the image CMD) installs this in front of the request listener Next's
 * `start-server` creates. For a request to one of `DIRECT_PAGES`, while the server switch is on,
 * it calls the compiled route module's `handler(req, res, ctx)` directly, the way the standalone
 * tRPC server (`./server.cjs`) serves its routes, and skips router-server, the proxy and
 * base-server. Every other request, and every request while the switch is off, goes to Next's
 * listener untouched.
 *
 * What a direct call has to do in place of the router comes from `./next-compat.cjs`, the same
 * helpers the standalone server uses: drop client-sent internal headers, apply the
 * `headers()` config, fill `x-forwarded-*`, and drop Next's internal query keys. The parity job
 * (`.github/workflows/trpc-server-parity.yml`) sends the same requests to plain `server.js` and to
 * this path and diffs status, headers and body.
 *
 * Only an exact match is served here. A path Next would redirect (trailing slash), answer with
 * its 404 page (more segments) or its 400 page (an undecodable `%` escape) goes to Next, so those
 * answers stay Next's own.
 *
 * Plain CommonJS with no compile step. The Next helpers are loaded on first use, after
 * `server.js` has run `require('next')`, so this file does not change the order Next loads its
 * own modules in.
 */

// Plain CommonJS that runs without a compile step, so `require` is the only way to load here.
/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('node:fs');
const path = require('node:path');

/** The pages served directly. Each must be a pages-API route in `pages-manifest.json`. */
const DIRECT_PAGES = ['/api/internal/image-delivery/[id]'];

/**
 * The Flipt server switch. Read with no user id, so `enabled` IS the switch. Mirrored by
 * `FLIPT_FEATURE_FLAGS.IMAGE_DELIVERY_DIRECT_ROUTE` in `src/server/flipt/client.ts`; a unit test
 * pins the two equal.
 */
const SWITCH_FLAG = 'image-delivery-direct-route';

/** How long one switch reading is reused, per process. */
const SWITCH_TTL_MS = 1000;

/**
 * `NEXT_DIRECT_ROUTES`: `on` or `off` overrides the Flipt switch for this process (the parity job
 * uses `on`; `off` is a kill switch that needs no Flipt). Anything else, or unset, reads Flipt.
 */
function readEnvOverride(env) {
  const value = (env.NEXT_DIRECT_ROUTES || '').trim().toLowerCase();
  return value === 'on' || value === 'off' ? value : null;
}

/**
 * The switch, from the app's own Flipt client. The app pins that client on
 * `globalThis.__civitaiFliptClient` (`src/server/flipt/client.ts`), so this file can read it
 * without importing app code. Off whenever there is no answer: the client is not built yet, not
 * initialised yet (`isEnabledSync` returns null), the key is missing, or the read throws.
 *
 * The reading is reused for `SWITCH_TTL_MS`, so a missing key costs one failed evaluation per
 * second, not one per request.
 */
function createSwitch({ env = process.env, now = Date.now, global = globalThis } = {}) {
  const override = readEnvOverride(env);
  let value = false;
  let readAt = -Infinity;
  return function isOn() {
    if (override) return override === 'on';
    const t = now();
    if (t - readAt < SWITCH_TTL_MS) return value;
    readAt = t;
    let answer = null;
    try {
      const client = global.__civitaiFliptClient;
      answer =
        client && typeof client.isEnabledSync === 'function'
          ? client.isEnabledSync(SWITCH_FLAG)
          : null;
    } catch {
      answer = null;
    }
    value = answer === true;
    return value;
  };
}

/**
 * Per-process counts of requests under a direct page's prefix, by outcome. On globalThis so the
 * app's metrics route can export them (`civitai_app_next_direct_route_requests`, in
 * `src/server/prom/client.ts`); the parity job reads them to prove the direct path served.
 */
function createStats(global = globalThis) {
  global.__civitaiNextDirectRoutes ??= {
    served: 0,
    switch_off: 0,
    unmatched: 0,
    load_failed: 0,
  };
  return global.__civitaiNextDirectRoutes;
}

/** The fixed path prefix of a dynamic page: `/api/internal/image-delivery/[id]` -> `.../`. */
function staticPrefix(page) {
  const i = page.indexOf('[');
  return i === -1 ? page : page.slice(0, i);
}

/**
 * Builds the direct handler: `{ route(req), serve(req, res, page) }`.
 *
 *   - `route(req)` decides SYNCHRONOUSLY, from the path and the switch, and returns the page to
 *     serve or null. Null means "hand this to Next", and nothing about `req` has changed.
 *   - `serve(req, res, page)` answers the request and resolves true, or resolves false WITHOUT
 *     touching `req` or `res` when the route module cannot be loaded, so the caller can still
 *     hand the request to Next.
 *
 * `load` is for tests; in the server it reads the config `server.js` exported and the build's
 * manifests, and requires the compiled route modules.
 */
function createDirectRoutes({
  pages = DIRECT_PAGES,
  isOn = createSwitch(),
  stats = createStats(),
  load = loadFromBuild,
  log = console,
} = {}) {
  const prefixes = [...new Set(pages.map(staticPrefix))];
  let state = null; // { compat, routing, matchPage, modules, distDir, hostname, port }
  let broken = false;

  function setup() {
    if (state || broken) return state;
    try {
      state = load(pages);
    } catch (err) {
      broken = true;
      log.error('[direct-routes] disabled: setup failed; every request goes to Next');
      log.error(err);
    }
    return state;
  }

  function routeModule(page) {
    const entry = state.modules.get(page);
    if (!entry.promise) {
      // Awaited, as Next's NodeModuleLoader does: a route with top-level await compiles to an
      // async module, and `require` then returns a promise of its exports.
      entry.promise = Promise.resolve()
        .then(() => entry.require())
        .then((mod) => {
          if (!mod || typeof mod.handler !== 'function') {
            throw new Error(`[direct-routes] ${page} has no exported handler(req, res, ctx)`);
          }
          return mod;
        });
      entry.promise.catch(() => {
        // A failed load is not kept: the next request tries again (and goes to Next until then).
        entry.promise = null;
      });
    }
    return entry.promise;
  }

  function route(req) {
    const url = req.url || '/';
    if (!prefixes.some((p) => url.startsWith(p))) return null;
    if (!isOn()) {
      stats.switch_off++;
      return null;
    }
    if (!setup()) {
      stats.load_failed++;
      return null;
    }
    const matched = state.matchPage(url.split('?', 1)[0]);
    // Not an exact match (trailing slash, more segments, a bad `%` escape): Next answers it.
    if (!matched.page) {
      stats.unmatched++;
      return null;
    }
    return matched.page;
  }

  async function serve(req, res, page) {
    let mod;
    try {
      mod = await routeModule(page);
    } catch (err) {
      stats.load_failed++;
      log.error(`[direct-routes] could not load ${page}; serving it through Next`);
      log.error(err);
      return false;
    }

    const { compat } = state;
    // Socket errors must not become unhandled 'error' events (router-server registers the same).
    req.on('error', () => {});
    res.on('error', () => {});
    // What router-server and base-server do before a route runs (see ./server.cjs `handle`).
    if (!process.env.NEXT_PRIVATE_TEST_HEADERS) compat.filterInternalHeaders(req.headers);
    compat.applyRoutingHeaders(res, compat.resolveRouting(state.routing, req).headers);
    compat.fillForwardedHeaders(req, { hostname: state.hostname, port: state.port() });
    compat.stripInternalQuery(req);

    stats.served++;
    // `relativeProjectDir: '.'`, not '': it resolves to the same directory, but it is not the
    // key next-server registered its router context under, so the route module runs as a DIRECT
    // invocation exactly as it does in ./server.cjs. Under '' it would take itself to be wrapped
    // by next-server, reuse whatever span is active instead of opening its own request span, and
    // the request would lose its `GET /api/internal/image-delivery/[id]` server span.
    await mod.handler(req, res, {
      waitUntil: undefined,
      requestMeta: { relativeProjectDir: '.', distDir: state.distDir },
    });
    return true;
  }

  return { route, serve };
}

/** Loads everything a direct call needs from the running server's own build. */
function loadFromBuild(pages) {
  // `server.js` exports its inlined config here before it starts Next.
  const raw = process.env.__NEXT_PRIVATE_STANDALONE_CONFIG;
  if (!raw) throw new Error('__NEXT_PRIVATE_STANDALONE_CONFIG is not set; server.js has not run');
  const nextConfig = JSON.parse(raw);
  // `server.js` chdirs to its own directory, so the build is relative to the cwd.
  const dir = process.cwd();
  const distDir = path.join(dir, nextConfig.distDir || '.next');
  const routesManifest = JSON.parse(
    fs.readFileSync(path.join(distDir, 'routes-manifest.json'), 'utf8')
  );
  const pagesManifest = JSON.parse(
    fs.readFileSync(path.join(distDir, 'server', 'pages-manifest.json'), 'utf8')
  );
  const modules = new Map();
  for (const page of pages) {
    if (!pagesManifest[page]) throw new Error(`${page} is not in pages-manifest.json`);
    const file = path.join(distDir, 'server', pagesManifest[page]);
    modules.set(page, { require: () => require(file), promise: null });
  }
  const compat = require('./next-compat.cjs');
  const hostname = process.env.HOSTNAME || '0.0.0.0';
  return {
    compat,
    // Throws if the manifest uses a routing feature the helpers do not implement.
    routing: compat.createRouting({ routesManifest, nextConfig }),
    matchPage: compat.createPageMatcher(pages),
    modules,
    distDir,
    hostname,
    // start-server exports the port it bound to; read per request, as it is set after listen.
    port: () => parseInt(process.env.PORT, 10) || 3000,
  };
}

/**
 * Wraps a request listener: a direct page is served here, everything else goes to `listener`
 * synchronously and unchanged, so the switch-off path adds one prefix check per request.
 */
function wrapListener(listener, direct) {
  return function directRoutesListener(req, res) {
    const page = direct.route(req);
    if (!page) return listener.call(this, req, res);
    return direct.serve(req, res, page).then(
      (served) => (served ? undefined : listener.call(this, req, res)),
      (err) => {
        // start-server's own answer to a handler that throws.
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('Internal Server Error');
        } else {
          res.destroy(err);
        }
        console.error(`[direct-routes] Failed to handle request for ${req.url}`);
        console.error(err);
      }
    );
  };
}

module.exports = {
  DIRECT_PAGES,
  SWITCH_FLAG,
  SWITCH_TTL_MS,
  createDirectRoutes,
  createStats,
  createSwitch,
  loadFromBuild,
  readEnvOverride,
  staticPrefix,
  wrapListener,
};
