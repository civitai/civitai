'use strict';
/**
 * Child-process probe for next-request-requires.test.ts. Runs in plain Node, outside Vitest,
 * because loading `next/dist/server/next-server` installs Next's process-wide require hook and
 * node-environment extensions, which must not leak into a test worker.
 *
 * Loads the installed Next.js server modules, then wraps `Module.prototype.require` (the same
 * seam Next's require hook and OpenTelemetry's require-in-the-middle sit on) and drives each
 * patched call site CALLS times against a throwaway build directory. Prints one line:
 * `PROBE_RESULT <json>` with, per scenario, how many times the wrapped require saw each
 * target id.
 */
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CALLS = 3;
const fromRepo = Module.createRequire(path.join(process.cwd(), 'package.json'));

const { getCookieParser } = fromRepo('next/dist/server/api-utils/get-cookie-parser');
const NextNodeServer = fromRepo('next/dist/server/next-server').default;
const { requirePage } = fromRepo('next/dist/server/require');

// --- throwaway build output -------------------------------------------------------------
const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-req-probe-'));
const serverDir = path.join(distDir, 'server');
fs.mkdirSync(path.join(serverDir, 'pages', 'api'), { recursive: true });
const write = (rel, body) => {
  const file = path.join(distDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};
const middlewareManifestPath = write(
  'server/middleware-manifest.json',
  JSON.stringify({ version: 3, middleware: {}, functions: {}, sortedMiddleware: [] })
);
const functionsConfigPath = write(
  'server/functions-config-manifest.json',
  JSON.stringify({ version: 1, functions: { '/_middleware': {} } })
);
const middlewarePath = write('server/middleware.js', 'module.exports = { marker: "middleware" };');
const noMiddlewareDistDir = path.join(distDir, 'no-middleware');
const noMiddlewareFunctionsConfigPath = write(
  'no-middleware/server/functions-config-manifest.json',
  JSON.stringify({ version: 1, functions: {} })
);
const apiRoutePath = write(
  'server/pages/api/probe.js',
  'let calls = 0; module.exports = { handler: async () => { calls += 1; }, calls: () => calls };'
);
const pagePath = write('server/pages/probe-page.js', 'module.exports = { marker: "page" };');
write('server/pages-manifest.json', JSON.stringify({ '/probe-page': 'pages/probe-page.js' }));

// --- require counter ----------------------------------------------------------------------
const counts = new Map();
const originalRequire = Module.prototype.require;
Module.prototype.require = function countingRequire(id) {
  counts.set(id, (counts.get(id) ?? 0) + 1);
  return originalRequire.apply(this, arguments);
};
const take = (...ids) => {
  const out = {};
  for (const id of ids) out[id] = counts.get(id) ?? 0;
  counts.clear();
  return out;
};

function server(fields) {
  // Object.create skips the constructor (which needs a real build); the methods under test only
  // read the fields assigned here.
  return Object.assign(Object.create(NextNodeServer.prototype), fields);
}

async function main() {
  const result = {};

  // 1. Cookie parsing (every request whose original request object is read).
  counts.clear();
  const parsed = [];
  for (let i = 0; i < CALLS; i++) parsed.push(getCookieParser({ cookie: 'a=1; b=2' })());
  result.cookie = {
    requires: take('next/dist/compiled/cookie')['next/dist/compiled/cookie'],
    parsed,
  };

  // 2. Middleware manifest, production and dev.
  for (const dev of [false, true]) {
    const s = server({ minimalMode: false, dev, middlewareManifestPath });
    const seen = new Set();
    for (let i = 0; i < CALLS; i++) seen.add(s.getMiddlewareManifest());
    result[dev ? 'manifestDev' : 'manifest'] = {
      requires: take(middlewareManifestPath)[middlewareManifestPath],
      distinctObjects: seen.size,
      hasMiddlewareKey: [...seen][0] != null && 'middleware' in [...seen][0],
    };
  }

  // 3. Node middleware module, with and without a middleware, production and dev.
  {
    const s = server({ dev: false, distDir });
    const seen = new Set();
    for (let i = 0; i < CALLS; i++) seen.add(await s.loadNodeMiddleware());
    const c = take(functionsConfigPath, middlewarePath);
    result.nodeMiddleware = {
      functionsConfigRequires: c[functionsConfigPath],
      middlewareRequires: c[middlewarePath],
      distinctObjects: seen.size,
      marker: [...seen][0] && [...seen][0].marker,
    };
  }
  {
    const s = server({ dev: false, distDir: noMiddlewareDistDir });
    const seen = [];
    for (let i = 0; i < CALLS; i++) seen.push(await s.loadNodeMiddleware());
    result.noNodeMiddleware = {
      functionsConfigRequires: take(noMiddlewareFunctionsConfigPath)[
        noMiddlewareFunctionsConfigPath
      ],
      allUndefined: seen.every((v) => v === undefined),
    };
  }
  {
    const s = server({ dev: true, distDir });
    for (let i = 0; i < CALLS; i++) await s.loadNodeMiddleware();
    result.nodeMiddlewareDev = { middlewareRequires: take(middlewarePath)[middlewarePath] };
  }

  // 4. Pages API route module (every API request).
  {
    const s = server({
      dev: false,
      dir: process.cwd(),
      distDir,
      getEdgeFunctionsPages: () => [],
      getWaitUntil: () => undefined,
    });
    const match = { definition: { filename: apiRoutePath, pathname: '/api/probe' }, params: {} };
    for (let i = 0; i < CALLS; i++) {
      await s.runApi(
        { url: '/api/probe', originalRequest: { headers: {} } },
        { originalResponse: {} },
        {},
        match
      );
    }
    result.apiRoute = {
      requires: take(apiRoutePath)[apiRoutePath],
      handlerCalls: originalRequire.call(module, apiRoutePath).calls(),
    };
  }

  // 5. Page module (every page render).
  {
    const seen = new Set();
    for (let i = 0; i < CALLS; i++) seen.add(await requirePage('/probe-page', distDir, false));
    result.page = {
      requires: take(pagePath)[pagePath],
      distinctObjects: seen.size,
      marker: [...seen][0] && [...seen][0].marker,
    };
  }

  Module.prototype.require = originalRequire;
  fs.rmSync(distDir, { recursive: true, force: true });
  process.stdout.write(`PROBE_RESULT ${JSON.stringify({ calls: CALLS, ...result })}\n`);
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  }
);
