// @ts-check
/**
 * Standalone tRPC server: Next's standalone `server.js`, except that `/api/trpc/<path>` is served
 * by `fast-path.mjs` instead of going through Next's router server.
 *
 * OPT-IN AND INERT BY DEFAULT. The image's default command is still `node server.js`; this file is
 * only shipped next to it (as `trpc-server/server.mjs`) and runs only when a deployment's command
 * names it:
 *
 *   node trpc-server/server.mjs
 *
 * Rolling back is switching that command back to `server.js`.
 *
 * EVERYTHING ELSE IS NEXT'S. The boot is `server.js`'s boot, line for line (same env handling, same
 * resolved config, same `startServer` call, so the same signal handling, keep-alive and request
 * pipeline), with one difference: the HTTP server's request listener first offers the request to the
 * fast path, which takes only `/api/trpc/<path>` and hands everything else — health, readiness and
 * metrics endpoints, pages, every other API route — to Next's own listener, unchanged. The fast path
 * reuses the route and proxy Next compiled, loaded through the same module cache, so both paths
 * share every process-wide singleton.
 */
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFastPathAssumptions,
  createTrpcFastPath,
  isFastPathUrl,
  loadCompiledEntries,
  loadNextInternals,
} from './fast-path.mjs';

// This file lives in `<app>/trpc-server/`, next to `<app>/server.js`.
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @type {Record<string, string | undefined>} */ (process.env).NODE_ENV = 'production';
process.chdir(dir);

const currentPort = parseInt(process.env.PORT ?? '', 10) || 3000;
const hostname = process.env.HOSTNAME || '0.0.0.0';

let keepAliveTimeout = /** @type {number | undefined} */ (
  parseInt(process.env.KEEP_ALIVE_TIMEOUT ?? '', 10)
);
// `server.js` inlines this object at build time; `required-server-files.json` is where the build
// writes the same resolved config for servers that are not `server.js`.
const nextConfig = JSON.parse(
  fs.readFileSync(path.join(dir, '.next', 'required-server-files.json'), 'utf8')
).config;

process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);
const distDir = path.join(dir, nextConfig.distDir || '.next');

// Refuse to start, rather than serve tRPC differently from Next, if the build breaks an assumption
// the fast path makes, or if a Next internal it calls is missing from the traced output.
// `--check` stops here: the image build runs it, so a broken install fails the build, not a pod.
loadNextInternals(dir);
assertFastPathAssumptions({ distDir, nextConfig });
if (process.argv.includes('--check')) {
  console.log('[trpc-server] install check passed');
  process.exit(0);
}

const require = createRequire(path.join(dir, 'server.js'));
require('next');
const { startServer } = require('next/dist/server/lib/start-server');
const {
  ensureInstrumentationRegistered,
} = require('next/dist/server/lib/router-utils/instrumentation-globals.external');

if (
  Number.isNaN(keepAliveTimeout) ||
  !Number.isFinite(keepAliveTimeout) ||
  /** @type {number} */ (keepAliveTimeout) < 0
) {
  keepAliveTimeout = undefined;
}

/**
 * Built on first use, never at boot: the compiled route's module graph must load AFTER the
 * instrumentation hook has run (it starts OTel, whose HTTP instrumentation must patch before the
 * app's modules load), which is the order Next itself uses. `ensureInstrumentationRegistered` is
 * Next's process-wide memo, so this and Next's own boot share one registration.
 *
 * @type {Promise<ReturnType<typeof createTrpcFastPath>> | undefined}
 */
let fastPath;
/** @param {(req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>} nextHandler */
function getFastPath(nextHandler) {
  fastPath ??= ensureInstrumentationRegistered(dir, nextConfig.distDir || '.next').then(async () =>
    createTrpcFastPath({
      dir,
      distDir,
      hostname,
      port: currentPort,
      nextConfig,
      nextHandler,
      entries: await loadCompiledEntries(distDir),
    })
  );
  return fastPath;
}

// `startServer` creates the HTTP server with Next's request listener. Wrap that one listener, once;
// nothing else about the server changes.
const createServer = http.createServer;
http.createServer = function (/** @type {any} */ nextListener) {
  http.createServer = createServer;
  if (typeof nextListener !== 'function') {
    throw new Error('[trpc-server] expected Next to create its server with a request listener');
  }
  return createServer(async (req, res) => {
    if (!isFastPathUrl(req.url)) return nextListener(req, res);
    let handle;
    try {
      handle = await getFastPath(nextListener);
    } catch (err) {
      // The fast path could not load (it loads on first use, see getFastPath). Serve this request
      // the way server.js would, and try loading again on the next one.
      fastPath = undefined;
      console.error('[trpc-server] fast path failed to load; handing the request to Next', err);
      return nextListener(req, res);
    }
    // Same failure handling as start-server.js's requestListener.
    try {
      await handle(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Internal Server Error');
      } else if (!res.writableEnded) {
        res.end();
      }
      console.error(`[trpc-server] Failed to handle request for ${req.url}`);
      console.error(err);
    }
  });
};

console.log('[trpc-server] /api/trpc/* is served by the standalone fast path');

// The same options object server.js passes (its `config` is not in Next's declared type).
startServer(
  /** @type {any} */ ({
    dir,
    isDev: false,
    config: nextConfig,
    hostname,
    port: currentPort,
    allowRetry: false,
    keepAliveTimeout,
  })
).catch((/** @type {unknown} */ err) => {
  console.error(err);
  process.exit(1);
});
