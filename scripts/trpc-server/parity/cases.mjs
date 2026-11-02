/**
 * The requests the parity harness sends to BOTH servers. Each case is sent to `server.js` and to
 * `trpc-server/server.cjs` booted from the same image with the same environment, and the two
 * responses are diffed (see `compare.mjs`).
 *
 * `divergence` declares a case where Next's answer is KNOWN to differ, with the reason. Only the
 * Next side is let go: the candidate's answer is pinned EXACTLY instead (status, status message,
 * every header but Date/Connection/Keep-Alive, body bytes), so a change to this server still goes
 * red. Every other case must match Next.
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
// `origin` matters: in production a tRPC call from an origin outside the allow-list (or none) is
// refused with 401 before any procedure runs. `NEXTAUTH_URL` is on the list in the parity env.
const SITE = 'http://localhost:3000';
const edge = {
  'user-agent': DESKTOP_UA,
  'cf-connecting-ip': NORMAL_IP,
  'x-forwarded-for': NORMAL_IP,
  'x-forwarded-proto': 'https',
  origin: SITE,
  referer: `${SITE}/`,
};

const PAGE_RENDERED =
  "Next answers via page rendering (here the preview-auth guard's 302 because IS_PREVIEW=true; in production its HTML 404/400 page). Mode R renders no pages; routing must send only single-segment /api/trpc/<seg> to it.";

const REDIRECTED_BY_NEXT =
  'Next answers this path with a 308 redirect before any route runs. Mode R does not port redirects: routing never sends it a trailing-slash or repeated-slash path, and kubelet probes use exact paths, so it is not a page here and gets the plain 404.';

/** This server's exact answers for those paths (router headers, then a plain-text body). */
const NOT_FOUND = {
  status: 404,
  statusMessage: 'Not Found',
  headers: [
    'content-length: 9',
    'content-type: text/plain; charset=utf-8',
    'x-frame-options: DENY',
  ],
  body: 'Not Found',
};
// No routing headers: under Next the decode error is thrown before they are applied.
const BAD_REQUEST = {
  status: 400,
  statusMessage: 'Bad Request',
  headers: ['content-length: 11', 'content-type: text/plain; charset=utf-8'],
  body: 'Bad Request',
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
      // The streaming link (`httpBatchStreamLink`): the response is JSON lines written as each
      // call settles, so it must come back chunked from both servers, with the same bytes once
      // the chunks are concatenated. One call fails input validation and one succeeds; that
      // settle order does not depend on timing, so the bytes are stable.
      id: 'streamed-batch-one-error',
      path: batchUrl([
        ['content.get', TOS],
        ['content.get', { slug: ['not a valid slug!'] }],
      ]),
      headers: { ...edge, 'trpc-accept': 'application/jsonl' },
      expectHeaders: { 'transfer-encoding': 'chunked' },
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
      divergence: { reason: REDIRECTED_BY_NEXT, candidate: NOT_FOUND },
    },
    {
      id: 'repeated-slash',
      path: '/api/trpc//content.get',
      headers: edge,
      divergence: { reason: REDIRECTED_BY_NEXT, candidate: NOT_FOUND },
    },
    // These three never reach a route, and Next answers them by rendering a page.
    {
      id: 'multi-segment-fetch',
      path: '/api/trpc/a/b',
      headers: { ...edge, 'sec-fetch-dest': 'empty' },
      divergence: { reason: PAGE_RENDERED, candidate: NOT_FOUND },
    },
    {
      id: 'multi-segment-document',
      path: '/api/trpc/a/b',
      headers: edge,
      divergence: { reason: PAGE_RENDERED, candidate: NOT_FOUND },
    },
    {
      id: 'bad-percent-escape',
      path: '/api/trpc/%E0%A4%A',
      headers: edge,
      divergence: { reason: PAGE_RENDERED, candidate: BAD_REQUEST },
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
      headers: { 'user-agent': GOOGLEBOT_UA, origin: SITE, referer: `${SITE}/` },
    },
    {
      // No origin at all: the "use the public API" refusal.
      id: 'no-origin-refused',
      path: `/api/trpc/content.get?input=${enc({ json: TOS })}`,
      headers: { 'user-agent': DESKTOP_UA, 'cf-connecting-ip': NORMAL_IP },
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
      divergence: { reason: REDIRECTED_BY_NEXT, candidate: NOT_FOUND },
    },
  ];
}

// --- image delivery (`--cases image-delivery`) ---------------------------------------------------
//
// Compares plain `server.js` (the reference) with the image's entrypoint serving
// `/api/internal/image-delivery/[id]` WITHOUT the Next router (`direct-routes.cjs`, switch forced
// on). Nothing here is declared divergent: every answer must be Next's, byte for byte.
//
// `direct` says what the direct path must do with the request: 'served' (it answers) or 'next'
// (it hands the request to Next untouched). The harness checks the direct server's own count of
// served requests against these (`--direct-metrics`), so a run in which the direct path never
// served anything — and Next was compared with itself — cannot pass.
//
// The rows below are written to the job's empty database by `seed-image-delivery.mjs` before
// these cases run. Ids are the image url keys the caller sends; none is a real image.

const UUID = (n) => `0d1e2f3a-4b5c-4d6e-8f70-${String(n).padStart(12, '0')}`;
export const IMAGE_DELIVERY_IDS = {
  image: UUID(1),
  video: UUID(2),
  gone: UUID(3),
  shared: UUID(4),
  goneHidden: UUID(5),
  unknown: UUID(99),
};

/** [id, url, hideMeta, type, mimeType, ingestion] */
export const IMAGE_DELIVERY_ROWS = [
  [910001, IMAGE_DELIVERY_IDS.image, false, 'image', 'image/jpeg', 'Scanned'],
  // `mimeType` blank: the endpoint answers null.
  [910002, IMAGE_DELIVERY_IDS.video, true, 'video', '  ', 'Scanned'],
  // Source known gone and metadata visible: not deliverable, so 404.
  [910003, IMAGE_DELIVERY_IDS.gone, false, 'image', 'image/png', 'NotFound'],
  // Two rows share a url: the most restrictive (hideMeta) wins.
  [910004, IMAGE_DELIVERY_IDS.shared, false, 'image', 'image/webp', 'Scanned'],
  [910005, IMAGE_DELIVERY_IDS.shared, true, 'image', 'image/webp', 'Scanned'],
  // Source gone but metadata hidden: still delivered.
  [910006, IMAGE_DELIVERY_IDS.goneHidden, true, 'image', null, 'NotFound'],
];

/**
 * @param {{ webhookToken: string }} ctx
 */
export function buildImageDeliveryCases(ctx) {
  const auth = { authorization: `Bearer ${ctx.webhookToken}` };
  const at = (id) => `/api/internal/image-delivery/${id}`;
  const { image, video, gone, shared, goneHidden, unknown } = IMAGE_DELIVERY_IDS;
  return [
    // --- found: from the database, then from the cache the first request filled ----------------
    { id: 'image-db', path: at(image), headers: auth, direct: 'served' },
    { id: 'image-cached', path: at(image), headers: auth, warm: true, direct: 'served' },
    { id: 'video-blank-mime', path: at(video), headers: auth, direct: 'served' },
    { id: 'video-blank-mime-cached', path: at(video), headers: auth, warm: true, direct: 'served' },
    { id: 'shared-url-most-restrictive', path: at(shared), headers: auth, direct: 'served' },
    { id: 'gone-but-hidden', path: at(goneHidden), headers: auth, direct: 'served' },

    // --- not found ---------------------------------------------------------------------------------
    { id: 'unknown-id', path: at(unknown), headers: auth, direct: 'served' },
    // Negative results are not cached: the second request reads the database again.
    { id: 'unknown-id-again', path: at(unknown), headers: auth, warm: true, direct: 'served' },
    { id: 'gone-source', path: at(gone), headers: auth, direct: 'served' },

    // --- odd ids: decoded the same way by both, still one segment ---------------------------------
    { id: 'id-encoded-slash-and-space', path: at('a%20b%2Fc'), headers: auth, direct: 'served' },
    { id: 'id-utf8', path: at('%C3%A9t%C3%A9.png'), headers: auth, direct: 'served' },
    { id: 'id-very-long', path: at('x'.repeat(2048)), headers: auth, direct: 'served' },
    {
      // The path's id wins over a query `id`, under Next and here.
      id: 'id-also-in-query',
      path: `${at(image)}?id=${unknown}&id=${gone}`,
      headers: auth,
      direct: 'served',
    },

    // --- auth -------------------------------------------------------------------------------------
    { id: 'auth-missing', path: at(image), headers: {}, direct: 'served' },
    {
      id: 'auth-wrong-bearer',
      path: at(image),
      headers: { authorization: 'Bearer not-the-token' },
      direct: 'served',
    },
    {
      id: 'auth-query-token',
      path: `${at(image)}?token={WEBHOOK_TOKEN}`,
      headers: {},
      direct: 'served',
    },
    {
      // A repeated ?token= arrives as an array and is refused.
      id: 'auth-repeated-query-token',
      path: `${at(image)}?token={WEBHOOK_TOKEN}&token={WEBHOOK_TOKEN}`,
      headers: {},
      direct: 'served',
    },
    {
      // An unrelated Bearer next to a valid ?token= still passes.
      id: 'auth-other-bearer-plus-query-token',
      path: `${at(image)}?token={WEBHOOK_TOKEN}`,
      headers: { authorization: 'Bearer something-else' },
      direct: 'served',
    },

    // --- what the router does before a route runs -------------------------------------------------
    {
      // Next strips these; not stripping `x-nextjs-data` makes the route module add
      // `x-nextjs-matched-path` to the response.
      id: 'client-sent-internal-headers',
      path: at(image),
      headers: {
        ...auth,
        'x-nextjs-data': '1',
        'x-matched-path': '/api/trpc/[trpc]',
        'x-middleware-override-headers': 'authorization',
        'x-middleware-request-authorization': 'Bearer not-the-token',
        'x-now-route-matches': `nxtPid=${unknown}`,
      },
      direct: 'served',
    },
    {
      // Next drops `nxtP…` query keys; a route module invoked directly would take `nxtPid` as the
      // route param and answer for that image instead.
      id: 'internal-query-param-override',
      path: `${at(unknown)}?nxtPid=${image}`,
      headers: auth,
      direct: 'served',
    },
    {
      id: 'forwarded-headers-from-the-edge',
      path: at(image),
      headers: {
        ...auth,
        'x-forwarded-for': '198.51.100.23',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'example.test',
      },
      direct: 'served',
    },
    {
      id: 'post-with-json-body',
      method: 'POST',
      path: at(image),
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{"a":1}',
      direct: 'served',
    },
    { id: 'head', method: 'HEAD', path: at(image), headers: auth, direct: 'served' },

    // --- not served directly: Next answers, and the direct server must hand them over untouched ---
    { id: 'trailing-slash', path: `${at(image)}/`, headers: auth, direct: 'next' },
    { id: 'more-segments', path: `${at(image)}/extra`, headers: auth, direct: 'next' },
    { id: 'no-id', path: '/api/internal/image-delivery/', headers: auth, direct: 'next' },
    { id: 'bad-percent-escape', path: at('%E0%A4%A'), headers: auth, direct: 'next' },
    {
      id: 'other-internal-route',
      path: '/api/live?token={WEBHOOK_TOKEN}',
      headers: {},
      direct: 'next',
    },
    {
      id: 'trpc-call',
      path: `/api/trpc/content.get?input=${enc({ json: TOS })}`,
      headers: edge,
      direct: 'next',
    },
  ];
}
