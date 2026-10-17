// @ts-check
/**
 * TEST INSTRUMENT for `parity-check.mjs` — never loaded in a deployment. Preload it into BOTH
 * servers under comparison (`NODE_OPTIONS="--require <path>/parity-probe.cjs"`).
 *
 * It wraps the compiled `/api/trpc/[trpc]` route's `handler` — the entry both Next's base server and
 * the fast path call — and puts the request headers that handler was handed on the response, as
 * `x-parity-seen` (base64 JSON). That is the seam the proxy chain's request-side effects (the
 * verified-bot strip, the internal-header filter, passthrough headers copied onto the request) are
 * visible at, and no response body shows them, so without this a parity run could not see them.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires -- a CommonJS preload
const Module = require('node:module');

const ROUTE_ENTRY = /[\\/]server[\\/]pages[\\/]api[\\/]trpc[\\/]\[trpc\]\.js$/;
const REPORTED = [
  'x-civitai-verified-bot',
  'cache-control',
  'x-handled-by',
  'x-middleware-override-headers',
  'x-middleware-next',
  'x-middleware-set-cookie',
  'x-matched-path',
  'x-nextjs-data',
];

/** @type {WeakMap<object, object>} */
const wrapped = new WeakMap();
// @ts-expect-error -- private but stable Node API, the standard preload hook point
const load = Module._load;
// @ts-expect-error -- see above
Module._load = function (request, parent, isMain) {
  const exports = load.apply(this, arguments);
  if (!exports || (typeof exports !== 'object' && typeof exports !== 'function')) return exports;
  let filename;
  try {
    // @ts-expect-error -- see above
    filename = Module._resolveFilename(request, parent, isMain);
  } catch {
    return exports;
  }
  if (!ROUTE_ENTRY.test(filename)) return exports;
  const existing = wrapped.get(exports);
  if (existing) return existing;
  // A Turbopack entry whose graph has top-level await exports a thenable; Next (and the fast
  // path) await it. Hand back a promise of the wrapped module in that case.
  const result =
    typeof exports.then === 'function' ? Promise.resolve(exports).then(wrap) : wrap(exports);
  wrapped.set(exports, result);
  return result;
};

/** @param {any} mod */
function wrap(mod) {
  if (typeof mod?.handler !== 'function') return mod;
  const handler = mod.handler;
  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {unknown} ctx */
  function probedHandler(req, res, ctx) {
    /** @type {Record<string, unknown>} */
    const seen = { names: Object.keys(req.headers).sort() };
    for (const name of REPORTED) seen[name] = req.headers[name] ?? null;
    res.setHeader('x-parity-seen', Buffer.from(JSON.stringify(seen)).toString('base64'));
    return handler.call(this, req, res, ctx);
  }
  // The module's `handler` is a non-configurable data property, so neither a Proxy nor a
  // redefinition can replace it: hand back a copy of the module with that one property swapped.
  const descriptors = Object.getOwnPropertyDescriptors(mod);
  descriptors.handler = {
    value: probedHandler,
    enumerable: true,
    writable: false,
    configurable: false,
  };
  return Object.defineProperties({}, descriptors);
}
console.log('[parity-probe] loaded: tRPC route requests will report x-parity-seen');
