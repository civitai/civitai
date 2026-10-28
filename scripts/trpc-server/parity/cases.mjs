/**
 * The requests the parity harness sends to BOTH servers. Each case is sent to `server.js` and to
 * `trpc-server/server.cjs` booted from the same image with the same environment, and the two
 * responses are diffed (see `compare.mjs`).
 *
 * `divergence` declares a difference this server is KNOWN not to reproduce, with the reason. A
 * declared case still has its status compared; only the parts it names are reported instead of
 * failed. Nothing else may differ.
 *
 * Cases only use procedures that need no seeded data: CI runs both servers against an empty
 * database, so DB-backed procedures fail — identically on both sides, which is still compared.
 */

const enc = (value) => encodeURIComponent(JSON.stringify(value));

/** A tRPC batch URL in the web client's shape: `/api/trpc/a,b?batch=1&input={"0":{json},…}`. */
function batchUrl(calls) {
  const input = {};
  calls.forEach(([, json], i) => {
    input[String(i)] = { json };
  });
  return `/api/trpc/${calls.map(([p]) => p).join(',')}?batch=1&input=${enc(input)}`;
}

const TOS = { slug: ['tos'] };
// A documentation address (RFC 5737), never a crawler's.
const NORMAL_IP = '198.51.100.23';
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

/** Headers a request through the CDN carries; the "no XFF" case sends none of them. */
const edge = {
  'user-agent': DESKTOP_UA,
  'cf-connecting-ip': NORMAL_IP,
  'x-forwarded-for': NORMAL_IP,
  'x-forwarded-proto': 'https',
};

/**
 * @param {{ sessionCookie: string }} ctx
 */
export function buildCases(ctx) {
  const signedIn = { ...edge, cookie: ctx.sessionCookie };
  return [
    // --- 1. anonymous public queries ------------------------------------------------------------
    {
      id: 'anon-public-query',
      path: `/api/trpc/content.get?input=${enc({ json: TOS })}`,
      headers: edge,
    },
    {
      id: 'anon-edge-cached-query',
      path: '/api/trpc/system.getLiveNow',
      headers: edge,
    },
    {
      id: 'anon-edge-cached-devalue-client',
      path: '/api/trpc/system.getLiveNow',
      headers: { ...edge, 'x-client': 'web', 'x-client-version': '99.0.0' },
    },

    // --- 2. signed in (a minted legacy session cookie for a preview smoke-test user) -------------
    {
      id: 'signed-in-protected-query',
      path: '/api/trpc/user.getSelfStatus',
      headers: signedIn,
    },
    {
      id: 'signed-in-public-query',
      path: `/api/trpc/content.get?input=${enc({ json: TOS })}`,
      headers: signedIn,
    },

    // --- 4. bots and internal headers -----------------------------------------------------------
    {
      id: 'spoofed-verified-bot-header',
      path: `/api/trpc/content.get?input=${enc({ json: TOS })}`,
      headers: { ...edge, 'x-civitai-verified-bot': 'googlebot' },
    },
    {
      id: 'crawler-ua-from-normal-ip',
      path: `/api/trpc/content.get?input=${enc({ json: TOS })}`,
      headers: { ...edge, 'user-agent': GOOGLEBOT_UA },
    },
    {
      // Next strips these before routing. Not stripping `x-nextjs-data` makes the route module
      // add `x-nextjs-matched-path` to the response, which is what this case would catch.
      id: 'client-sent-internal-headers',
      path: `/api/trpc/content.get?input=${enc({ json: TOS })}`,
      headers: {
        ...edge,
        'x-middleware-override-headers': 'x-civitai-verified-bot',
        'x-middleware-request-x-civitai-verified-bot': 'googlebot',
        'x-matched-path': '/api/trpc/[trpc]',
        'x-nextjs-data': '1',
        'x-now-route-matches': 'nxtPtrpc=system.getLiveNow',
      },
    },
    {
      // Under next-server `nxtP…` query keys are dropped; a route module invoked directly would
      // take them as the route params instead of the path.
      id: 'internal-query-param-override',
      path: `/api/trpc/content.get?input=${enc({ json: TOS })}&nxtPtrpc=system.getLiveNow`,
      headers: edge,
    },

    // --- 5. batches -------------------------------------------------------------------------------
    {
      id: 'batch-of-3-one-error',
      path: batchUrl([
        ['content.get', TOS],
        ['content.get', { slug: ['not a valid slug!'] }],
        ['system.getLiveNow', null],
      ]),
      headers: edge,
    },
    {
      // TRPC_MAX_BATCH_SIZE is 3 in the harness environment.
      id: 'batch-over-max-size',
      path: batchUrl([
        ['content.get', TOS],
        ['content.get', TOS],
        ['content.get', TOS],
        ['content.get', TOS],
      ]),
      headers: edge,
    },

    // --- 6. POST bodies ---------------------------------------------------------------------------
    {
      id: 'method-override-post-query',
      method: 'POST',
      path: '/api/trpc/content.get?batch=1',
      headers: { ...edge, 'content-type': 'application/json' },
      body: JSON.stringify({ 0: { json: TOS } }),
    },
    {
      id: 'malformed-json-post',
      method: 'POST',
      path: '/api/trpc/content.get',
      headers: { ...edge, 'content-type': 'application/json' },
      body: '{"0":{"json":',
    },
    {
      id: 'urlencoded-post',
      method: 'POST',
      path: '/api/trpc/content.get',
      headers: { ...edge, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1&b=2',
    },
    {
      id: 'body-over-17mib',
      method: 'POST',
      path: '/api/trpc/content.get',
      headers: { ...edge, 'content-type': 'application/json' },
      body: () => Buffer.alloc(18 * 1024 * 1024, 0x20),
    },

    // --- 7. errors --------------------------------------------------------------------------------
    {
      id: 'unauthenticated-protected-query',
      path: '/api/trpc/user.getSelfStatus',
      headers: edge,
    },
    {
      id: 'unknown-procedure',
      path: '/api/trpc/doesNot.exist',
      headers: edge,
    },
    {
      id: 'trailing-slash',
      path: `/api/trpc/content.get/?input=${enc({ json: TOS })}`,
      headers: edge,
    },
    {
      id: 'repeated-slash',
      path: '/api/trpc//content.get',
      headers: edge,
    },
    {
      id: 'multi-segment-fetch',
      path: '/api/trpc/a/b',
      headers: { ...edge, 'sec-fetch-dest': 'empty' },
    },
    {
      id: 'multi-segment-document',
      path: '/api/trpc/a/b',
      headers: edge,
      divergence: {
        parts: ['headers', 'body'],
        reason:
          'Next renders its 404 page here; this server never loads the page renderer and answers a plain-text 404. Only reachable if the router sends multi-segment paths to this server.',
      },
    },
    {
      id: 'bad-percent-escape',
      path: '/api/trpc/%E0%A4%A',
      headers: edge,
      divergence: {
        parts: ['headers', 'body'],
        reason:
          'Next renders its /_error page with 400 here; this server answers a plain-text 400 for the same status.',
      },
    },

    // --- 8. region --------------------------------------------------------------------------------
    {
      id: 'blocked-region',
      path: `/api/trpc/content.get?input=${enc({ json: TOS })}`,
      headers: { ...edge, 'cf-ipcountry': 'GB' },
    },

    // --- 9. client headers ------------------------------------------------------------------------
    {
      id: 'outdated-web-client',
      path: `/api/trpc/content.get?input=${enc({ json: TOS })}`,
      headers: { ...edge, 'x-client': 'web', 'x-client-version': '0.0.1' },
    },
    {
      id: 'no-forwarded-headers',
      path: `/api/trpc/content.get?input=${enc({ json: TOS })}`,
      headers: { 'user-agent': GOOGLEBOT_UA },
    },

    // --- probes -----------------------------------------------------------------------------------
    {
      id: 'probe-live',
      path: '/api/live?token={WEBHOOK_TOKEN}',
      headers: {},
    },
    {
      id: 'probe-live-trailing-slash',
      path: '/api/live/?token={WEBHOOK_TOKEN}',
      headers: {},
    },
  ];
}
