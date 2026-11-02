'use strict';
/**
 * The image's entrypoint: Next's own `server.js`, with `./direct-routes.cjs` in front of the
 * request listener Next creates.
 *
 * Next's generated `server.js` calls `startServer()`, which creates its HTTP server synchronously
 * (`http.createServer(requestListener)`) before its first `await`. So this file replaces
 * `http.createServer` for exactly the duration of `require('../server.js')`: the one server
 * created in that window gets its listener wrapped, and `http.createServer` is restored before
 * anything else runs. Nothing else about how Next boots, listens or shuts down changes.
 *
 * While the server switch is off (the default; see `./direct-routes.cjs`) every request reaches
 * Next's listener unchanged, after one path-prefix check.
 *
 * If the window does not see exactly one server (a Next upgrade that creates its server later,
 * or more than one), the listener is left unwrapped, a line says so, and Next serves everything
 * as before. The parity job fails in that case: it requires the direct path to have served.
 *
 * Start: `node -- trpc-server/next-entry.cjs -- --expose-gc` from the image root (`/app`), the
 * Dockerfile CMD. `node -- server.js` still starts plain Next.
 */

// Plain CommonJS that runs without a compile step, so `require` is the only way to load here.
/* eslint-disable @typescript-eslint/no-var-requires */
const http = require('node:http');
const directRoutes = require('./direct-routes.cjs');

/**
 * Runs `boot` with `httpModule.createServer` replaced so that the request listener of each server
 * created during it is wrapped by `wrap`. Returns how many servers were created in the window.
 * Exactly one is the only case in which the wrapped listener is kept.
 */
function bootWithWrappedListener(httpModule, boot, wrap) {
  const original = httpModule.createServer;
  const created = [];
  httpModule.createServer = function createServer(...args) {
    const i = args.findIndex((a) => typeof a === 'function');
    const listener = i === -1 ? undefined : args[i];
    if (listener) args[i] = wrap(listener);
    const server = original.apply(this, args);
    created.push({ server, listener, wrapped: listener ? args[i] : undefined });
    return server;
  };
  try {
    boot();
  } finally {
    httpModule.createServer = original;
  }
  if (created.length !== 1 || !created[0].listener) {
    // Put every listener back: a wrapper on a server we did not mean to touch is not kept.
    for (const c of created) {
      if (!c.listener) continue;
      c.server.removeListener('request', c.wrapped);
      c.server.on('request', c.listener);
    }
  }
  return created.length;
}

function main() {
  const direct = directRoutes.createDirectRoutes();
  const servers = bootWithWrappedListener(
    http,
    () => require('../server.js'),
    (listener) => directRoutes.wrapListener(listener, direct)
  );
  if (servers === 1) {
    console.log(
      `[direct-routes] installed for ${directRoutes.DIRECT_PAGES.join(', ')} ` +
        `(switch: ${directRoutes.readEnvOverride(process.env) || directRoutes.SWITCH_FLAG})`
    );
  } else {
    console.error(
      `[direct-routes] NOT installed: server.js created ${servers} HTTP servers while booting, ` +
        'expected 1. Next serves every request.'
    );
  }
}

if (require.main === module) main();

module.exports = { bootWithWrappedListener };
