'use strict';
/**
 * The image feed benchmark's standalone Node arm: `image.getImagesAsPostsInfinite` served by a bare
 * `node:http` server, with no Next.js request handling and no tRPC (README.md here).
 *
 * It boots like `trpc-server/server.cjs` (the same env, chdir, standalone config, Next require
 * hooks and `instrumentation.ts` register — so OTel, the pg enum parsers, the log sink and the
 * liveness heartbeat are the ones the Next arm runs), then loads ONE compiled page module,
 * `/api/internal/feed-bench` (src/pages/api/internal/feed-bench.ts), and calls the
 * `serveImagesAsPostsStandalone` function its default export carries for every request.
 *
 * Routes: GET /api/trpc/image.getImagesAsPostsInfinite (the procedure's own URL, so one replay
 * target list fits every arm) and /healthz (200 once booted). Until boot finishes every request,
 * /healthz included, answers 503; after that other paths answer 404 and a non-GET on the
 * procedure's path 405.
 *
 * Start (from the image root, /app): `node -- feed-bench/server.cjs`. Port: $PORT (default 3000).
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const dir = path.join(__dirname, '..');
const PAGE = '/api/internal/feed-bench';

// What the generated server.js does before starting Next, as trpc-server/server.cjs does.
process.env.NODE_ENV = 'production';
process.chdir(dir);

const port = parseInt(process.env.PORT, 10) || 3000;
const hostname = process.env.HOSTNAME || '0.0.0.0';
let keepAliveTimeout = parseInt(process.env.KEEP_ALIVE_TIMEOUT, 10);
if (Number.isNaN(keepAliveTimeout) || keepAliveTimeout < 0) keepAliveTimeout = undefined;

const serverJs = fs.readFileSync(path.join(dir, 'server.js'), 'utf8');
const configLine = serverJs.split('\n').find((l) => l.startsWith('const nextConfig = '));
if (!configLine) throw new Error('[feed-bench] no "const nextConfig = " line in server.js');
const nextConfig = JSON.parse(configLine.slice('const nextConfig = '.length));
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);

require('next');
require('next/dist/server/lib/cpu-profile');
require('next/dist/server/require-hook');
require('next/dist/server/node-polyfill-crypto');
require('next/dist/server/node-environment');
const compat = require('../trpc-server/next-compat.cjs');
compat.installGlobalBehaviors(nextConfig);
compat.setHttpClientAndAgentOptions(nextConfig);
compat.installProcessErrorHandlers(
  Boolean(
    nextConfig.experimental && nextConfig.experimental.removeUncaughtErrorAndRejectionListeners
  )
);

const distDir = path.join(dir, nextConfig.distDir || '.next');
const pagesManifest = JSON.parse(
  fs.readFileSync(path.join(distDir, 'server', 'pages-manifest.json'), 'utf8')
);
if (!pagesManifest[PAGE]) throw new Error(`[feed-bench] ${PAGE} is not in pages-manifest.json`);

/** `serveImagesAsPostsStandalone(req, res)`, once boot has loaded it. */
let serve = null;

function plain(res, status, text) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain');
  res.end(text);
}

async function requestListener(req, res) {
  req.on('error', () => {});
  res.on('error', () => {});
  const pathname = (req.url || '/').split('?', 1)[0];
  if (pathname === '/healthz') return plain(res, serve ? 200 : 503, serve ? 'ok' : 'booting');
  if (!serve) return plain(res, 503, 'booting');
  try {
    await serve(req, res);
  } catch (err) {
    console.error(`[feed-bench] failed to handle ${req.url}`, err);
    if (!res.headersSent) plain(res, 500, 'Internal Server Error');
    else res.destroy();
  }
}

process.title = 'feed-bench';
const server = http.createServer(requestListener);
if (keepAliveTimeout) server.keepAliveTimeout = keepAliveTimeout;
server.on('error', (err) => {
  console.error('[feed-bench] failed to start server', err);
  process.exit(1);
});

let closing = false;
function cleanup(signal) {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(signal === 'SIGINT' ? 130 : 143));
}
process.on('SIGINT', () => cleanup('SIGINT'));
process.on('SIGTERM', () => cleanup('SIGTERM'));

server.on('listening', async () => {
  const addr = server.address();
  // The warmer self-requests on this port (it gets 404s here: there are no warm routes).
  process.env.PORT = String(typeof addr === 'object' && addr ? addr.port : port);
  try {
    await compat.ensureInstrumentationRegistered(dir, nextConfig.distDir || '.next');
    // A page whose graph has top-level await compiles to an async module: `require` then returns
    // a promise of its exports.
    const mod = await require(path.join(distDir, 'server', pagesManifest[PAGE]));
    const fn = mod && mod.default && mod.default.serveImagesAsPostsStandalone;
    if (typeof fn !== 'function')
      throw new Error(`[feed-bench] ${PAGE} carries no serveImagesAsPostsStandalone function`);
    serve = fn;
    console.log(`[feed-bench] ready on ${hostname}:${process.env.PORT}`);
  } catch (err) {
    console.error('[feed-bench] boot failed', err);
    process.exit(1);
  }
});

server.listen(port, hostname);
