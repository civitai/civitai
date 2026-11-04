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
// Compares Next (`server.js`, the reference) with the standalone server serving
// `/api/internal/image-delivery/[id]`. Every answer must be Next's, byte for byte, except the
// paths that are not an exact one-segment match (declared below, as for the tRPC route): the
// route's caller never sends them.
//
// `counted` is the status label the route's own counter (`civitai_app_image_delivery_request_total`)
// must move by for the case: 'found', 'not_found', or null when the route answers before counting
// (auth) or the path is not the route. With `--route-counter` the harness checks the counter on
// BOTH servers moved by exactly these amounts, so a candidate that never ran the route cannot pass,
// and the reference is the positive control that the counter can be read at all.
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
    { id: 'image-db', path: at(image), headers: auth, counted: 'found' },
    { id: 'image-cached', path: at(image), headers: auth, warm: true, counted: 'found' },
    { id: 'video-blank-mime', path: at(video), headers: auth, counted: 'found' },
    { id: 'video-blank-mime-cached', path: at(video), headers: auth, warm: true, counted: 'found' },
    { id: 'shared-url-most-restrictive', path: at(shared), headers: auth, counted: 'found' },
    { id: 'gone-but-hidden', path: at(goneHidden), headers: auth, counted: 'found' },

    // --- not found ---------------------------------------------------------------------------------
    { id: 'unknown-id', path: at(unknown), headers: auth, counted: 'not_found' },
    // Negative results are not cached: the second request reads the database again.
    { id: 'unknown-id-again', path: at(unknown), headers: auth, warm: true, counted: 'not_found' },
    { id: 'gone-source', path: at(gone), headers: auth, counted: 'not_found' },

    // --- odd ids: decoded the same way by both, still one segment ---------------------------------
    {
      id: 'id-encoded-slash-and-space',
      path: at('a%20b%2Fc'),
      headers: auth,
      counted: 'not_found',
    },
    { id: 'id-utf8', path: at('%C3%A9t%C3%A9.png'), headers: auth, counted: 'not_found' },
    { id: 'id-very-long', path: at('x'.repeat(2048)), headers: auth, counted: 'not_found' },
    {
      // The path's id wins over a query `id`, under Next and here.
      id: 'id-also-in-query',
      path: `${at(image)}?id=${unknown}&id=${gone}`,
      headers: auth,
      counted: 'found',
    },

    // --- auth -------------------------------------------------------------------------------------
    { id: 'auth-missing', path: at(image), headers: {}, counted: null },
    {
      id: 'auth-wrong-bearer',
      path: at(image),
      headers: { authorization: 'Bearer not-the-token' },
      counted: null,
    },
    {
      id: 'auth-query-token',
      path: `${at(image)}?token={WEBHOOK_TOKEN}`,
      headers: {},
      counted: 'found',
    },
    {
      // The caller's exact request shape (`?token=`, no Bearer) on a hideMeta row: the value
      // that decides whether metadata is stripped.
      id: 'hidemeta-query-token',
      path: `${at(video)}?token={WEBHOOK_TOKEN}`,
      headers: {},
      counted: 'found',
    },
    {
      id: 'hidemeta-shared-url-query-token',
      path: `${at(shared)}?token={WEBHOOK_TOKEN}`,
      headers: {},
      counted: 'found',
    },
    {
      // A repeated ?token= arrives as an array and is refused.
      id: 'auth-repeated-query-token',
      path: `${at(image)}?token={WEBHOOK_TOKEN}&token={WEBHOOK_TOKEN}`,
      headers: {},
      counted: null,
    },
    {
      // An unrelated Bearer next to a valid ?token= still passes.
      id: 'auth-other-bearer-plus-query-token',
      path: `${at(image)}?token={WEBHOOK_TOKEN}`,
      headers: { authorization: 'Bearer something-else' },
      counted: 'found',
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
      counted: 'found',
    },
    {
      // Next drops `nxtP…` query keys; a route module invoked directly would take `nxtPid` as the
      // route param and answer for that image instead.
      id: 'internal-query-param-override',
      path: `${at(unknown)}?nxtPid=${image}`,
      headers: auth,
      counted: 'not_found',
    },
    {
      // Pins that edge-sent x-forwarded-* headers do not change the answer. It does NOT cover the
      // server's own x-forwarded-* fill: this handler reads no forwarded header, so removing the
      // fill changes nothing here (a mutation check confirmed it survives).
      id: 'edge-forwarded-headers-do-not-change-the-answer',
      path: at(image),
      headers: {
        ...auth,
        'x-forwarded-for': '198.51.100.23',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'example.test',
      },
      counted: 'found',
    },
    {
      id: 'post-with-json-body',
      method: 'POST',
      path: at(image),
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{"a":1}',
      counted: 'found',
    },
    { id: 'head', method: 'HEAD', path: at(image), headers: auth, counted: 'found' },

    // --- not an exact match: this server's plain answers; the caller never sends these ---------
    {
      id: 'trailing-slash',
      path: `${at(image)}/`,
      headers: auth,
      counted: null,
      divergence: { reason: REDIRECTED_BY_NEXT, candidate: NOT_FOUND },
    },
    {
      id: 'more-segments',
      path: `${at(image)}/extra`,
      headers: auth,
      counted: null,
      divergence: { reason: PAGE_RENDERED, candidate: NOT_FOUND },
    },
    {
      id: 'no-id',
      path: '/api/internal/image-delivery/',
      headers: auth,
      counted: null,
      divergence: { reason: REDIRECTED_BY_NEXT, candidate: NOT_FOUND },
    },
    {
      id: 'bad-percent-escape',
      path: at('%E0%A4%A'),
      headers: auth,
      counted: null,
      divergence: { reason: PAGE_RENDERED, candidate: BAD_REQUEST },
    },

    // --- the server's other routes, next to this one ---------------------------------------------
    {
      id: 'other-internal-route',
      path: '/api/live?token={WEBHOOK_TOKEN}',
      headers: {},
      counted: null,
    },
    {
      id: 'trpc-call',
      path: `/api/trpc/content.get?input=${enc({ json: TOS })}`,
      headers: edge,
      counted: null,
    },
  ];
}

// --- browser beacons (`--cases beacons`) ----------------------------------------------------------
//
// Compares Next (`server.js`, the reference) with the standalone server serving the three tracking
// beacons: `/api/internal/ping` (page views, `TrackPageView.tsx`), `/api/internal/pulse` (entity
// views, `TrackView.tsx`) and `/api/track/batch` (the coalesced search/action/impression flush,
// `trackEventBuffer.ts`). Each is a POST with a JSON body, sent in the shapes those callers use:
//   - ping: `fetch` with a string body and no Content-Type, so the browser sends `text/plain`;
//   - pulse: `fetch` with `Content-Type: application/json`;
//   - batch: `sendBeacon` with an `application/json` Blob, or `fetch` with the same header.
// The route module parses the body itself (Next's default `bodyParser`: JSON, urlencoded and text
// up to 1mb; none of the three sets `config.api`), so these cases also cover the parser: each
// content type, malformed JSON, and bodies on both sides of the limit.
//
// A beacon's response is an empty 200 or a short 400, which a server that never ran the route
// could imitate. So every case also names the tracker rows the route must send (`tracked`, table
// names): with `--tracker`, the harness reads what each server sent to the job's tracker stub for
// that request and requires both to have sent exactly those tables, with the same rows. The
// reference sending them is the positive control that the stub sees anything. Rows carry the
// session's user id, so the signed-in cases also check that the session is read the same way.
//
// Impressions are not in `tracked`: they go to ClickHouse directly, not through the tracker URL.

const BEACON_UA = DESKTOP_UA;
/** What a same-origin browser request carries through the CDN. */
const beaconFrom = {
  'user-agent': BEACON_UA,
  'cf-connecting-ip': NORMAL_IP,
  'cf-ipcountry': 'US',
  'x-forwarded-for': NORMAL_IP,
  'x-forwarded-proto': 'https',
  origin: SITE,
  referer: `${SITE}/models/123/some-model`,
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
};
const TEXT = { 'content-type': 'text/plain;charset=UTF-8' };
const JSON_CT = { 'content-type': 'application/json' };

const PING = '/api/internal/ping';
const PULSE = '/api/internal/pulse';
const BATCH = '/api/track/batch';

const PAGE_VIEW = {
  duration: 5234,
  path: '/models/123/some-model',
  windowWidth: 1920,
  windowHeight: 1080,
};
const VIEW = { type: 'ImageView', entityType: 'Image', entityId: 4321 };
const SEARCH = {
  kind: 'search',
  data: { query: 'a cat', index: 'models_v9', filters: { tags: ['x'] } },
};
const ACTION = { kind: 'action', data: { type: 'AddToBounty_Click' } };
const IMPRESSION = {
  kind: 'impression',
  data: { sessionKey: 'k1', surface: 'other', entities: [{ entityType: 'Image', entityId: 7 }] },
};

/** A JSON body padded to exactly `bytes` bytes with a field the schemas strip. */
function paddedJson(value, bytes) {
  const base = JSON.stringify({ ...value, pad: '' });
  if (base.length > bytes) throw new Error('paddedJson: value is larger than the target size');
  return JSON.stringify({ ...value, pad: 'a'.repeat(bytes - base.length) });
}
// Next's default limit is '1mb', which `bytes` reads as 1048576.
const UNDER_LIMIT = 1024 * 1024 - 64;
const OVER_LIMIT = 1024 * 1024 + 64;

/** The rows a request must send: one table name per row, in any order. */
const n = (table, count) => Array.from({ length: count }, () => table);

/** `headers` without the named ones (a case that must NOT send a header). */
const omit = (headers, ...names) =>
  Object.fromEntries(Object.entries(headers).filter(([k]) => !names.includes(k)));

/**
 * @param {{ sessionCookie: string }} ctx
 */
export function buildBeaconCases(ctx) {
  const signedIn = { ...beaconFrom, cookie: ctx.sessionCookie };
  const post = (id, path, headers, body, tracked, extra = {}) => ({
    id,
    method: 'POST',
    path,
    headers,
    body,
    tracked,
    ...extra,
  });
  return [
    // --- ping: page views -------------------------------------------------------------------------
    post('ping-text-plain', PING, { ...beaconFrom, ...TEXT }, JSON.stringify(PAGE_VIEW), [
      'pageViews',
    ]),
    // The caller's exact shape: no Content-Type header at all.
    post('ping-no-content-type', PING, beaconFrom, JSON.stringify(PAGE_VIEW), ['pageViews']),
    post(
      'ping-ads-and-numeric-strings',
      PING,
      { ...beaconFrom, ...TEXT },
      JSON.stringify({ ...PAGE_VIEW, ads: true, windowWidth: '1280', windowHeight: '720' }),
      ['pageViews']
    ),
    post('ping-signed-in', PING, { ...signedIn, ...TEXT }, JSON.stringify(PAGE_VIEW), [
      'pageViews',
    ]),
    post(
      'ping-no-country',
      PING,
      omit({ ...beaconFrom, ...TEXT }, 'cf-ipcountry'),
      JSON.stringify(PAGE_VIEW),
      ['pageViews']
    ),
    // An empty path still soft-matches a page in `getMatchingPathname`, so it writes a row (measured
    // on both servers).
    post(
      'ping-empty-path',
      PING,
      { ...beaconFrom, ...TEXT },
      JSON.stringify({ ...PAGE_VIEW, path: '' }),
      ['pageViews']
    ),
    // application/json is parsed to an object by the body parser, and this route only JSON.parses.
    post(
      'ping-json-content-type',
      PING,
      { ...beaconFrom, ...JSON_CT },
      JSON.stringify(PAGE_VIEW),
      []
    ),
    post(
      'ping-no-referer',
      PING,
      omit({ ...beaconFrom, ...TEXT }, 'referer'),
      JSON.stringify(PAGE_VIEW),
      []
    ),
    post(
      'ping-cross-site-referer',
      PING,
      { ...beaconFrom, ...TEXT, referer: 'https://elsewhere.example/x' },
      JSON.stringify(PAGE_VIEW),
      []
    ),
    post(
      'ping-malformed-referer',
      PING,
      { ...beaconFrom, ...TEXT, referer: 'not a url' },
      JSON.stringify(PAGE_VIEW),
      []
    ),
    post('ping-malformed-body', PING, { ...beaconFrom, ...TEXT }, '{"path":', []),
    post('ping-empty-body', PING, { ...beaconFrom, ...TEXT }, '', []),
    post(
      'ping-missing-path',
      PING,
      { ...beaconFrom, ...TEXT },
      JSON.stringify({ duration: 5000 }),
      []
    ),
    post(
      'ping-just-under-1mb',
      PING,
      { ...beaconFrom, ...TEXT },
      paddedJson(PAGE_VIEW, UNDER_LIMIT),
      ['pageViews']
    ),
    post(
      'ping-just-over-1mb',
      PING,
      { ...beaconFrom, ...TEXT },
      paddedJson(PAGE_VIEW, OVER_LIMIT),
      []
    ),

    // --- pulse: entity views ----------------------------------------------------------------------
    post('pulse-json', PULSE, { ...beaconFrom, ...JSON_CT }, JSON.stringify(VIEW), ['views']),
    post(
      'pulse-json-charset',
      PULSE,
      { ...beaconFrom, 'content-type': 'application/json; charset=utf-8' },
      JSON.stringify({
        ...VIEW,
        ads: 'Served',
        nsfw: false,
        nsfwLevel: 1,
        browsingLevel: 1,
        details: { a: 1 },
      }),
      ['views']
    ),
    // A client that sends no JSON Content-Type: the route parses the string itself.
    post('pulse-text-plain', PULSE, { ...beaconFrom, ...TEXT }, JSON.stringify(VIEW), ['views']),
    post('pulse-signed-in', PULSE, { ...signedIn, ...JSON_CT }, JSON.stringify(VIEW), ['views']),
    post(
      'pulse-referer-only',
      PULSE,
      omit({ ...beaconFrom, ...JSON_CT }, 'origin'),
      JSON.stringify(VIEW),
      ['views']
    ),
    post(
      'pulse-no-origin-no-referer',
      PULSE,
      omit({ ...beaconFrom, ...JSON_CT }, 'origin', 'referer'),
      JSON.stringify(VIEW),
      []
    ),
    post(
      'pulse-cross-origin',
      PULSE,
      { ...beaconFrom, ...JSON_CT, origin: 'https://elsewhere.example' },
      JSON.stringify(VIEW),
      []
    ),
    // Rejected by the body parser itself (its "Invalid JSON" 400), before the handler runs.
    post('pulse-malformed-json', PULSE, { ...beaconFrom, ...JSON_CT }, '{"type":', []),
    // Rejected by the handler's own parse.
    post('pulse-malformed-text', PULSE, { ...beaconFrom, ...TEXT }, '{"type":', []),
    post(
      'pulse-schema-invalid',
      PULSE,
      { ...beaconFrom, ...JSON_CT },
      JSON.stringify({ ...VIEW, entityId: 'x' }),
      []
    ),
    post(
      'pulse-urlencoded',
      PULSE,
      { ...beaconFrom, 'content-type': 'application/x-www-form-urlencoded' },
      'type=ImageView&entityType=Image&entityId=1',
      []
    ),
    post(
      'pulse-just-over-1mb',
      PULSE,
      { ...beaconFrom, ...JSON_CT },
      paddedJson(VIEW, OVER_LIMIT),
      []
    ),

    // --- batch: coalesced search / action / impression events ---------------------------------------
    post('batch-json', BATCH, { ...beaconFrom, ...JSON_CT }, JSON.stringify([SEARCH, ACTION]), [
      'search',
      'actions',
    ]),
    post('batch-text-plain', BATCH, { ...beaconFrom, ...TEXT }, JSON.stringify([SEARCH, ACTION]), [
      'search',
      'actions',
    ]),
    post('batch-signed-in', BATCH, { ...signedIn, ...JSON_CT }, JSON.stringify([ACTION, SEARCH]), [
      'actions',
      'search',
    ]),
    post(
      'batch-with-impression',
      BATCH,
      { ...beaconFrom, ...JSON_CT },
      JSON.stringify([IMPRESSION, SEARCH]),
      ['search']
    ),
    post(
      'batch-impression-only',
      BATCH,
      { ...beaconFrom, ...JSON_CT },
      JSON.stringify([IMPRESSION]),
      []
    ),
    post(
      'batch-100-events',
      BATCH,
      { ...beaconFrom, ...JSON_CT },
      JSON.stringify(n(ACTION, 100)),
      n('actions', 100)
    ),
    post(
      'batch-101-events',
      BATCH,
      { ...beaconFrom, ...JSON_CT },
      JSON.stringify(n(ACTION, 101)),
      []
    ),
    post('batch-empty-array', BATCH, { ...beaconFrom, ...JSON_CT }, '[]', []),
    post('batch-not-an-array', BATCH, { ...beaconFrom, ...JSON_CT }, JSON.stringify(SEARCH), []),
    post(
      'batch-one-bad-event',
      BATCH,
      { ...beaconFrom, ...JSON_CT },
      JSON.stringify([SEARCH, { kind: 'action', data: { type: 'NotAnAction' } }]),
      []
    ),
    post(
      'batch-cross-origin',
      BATCH,
      { ...beaconFrom, ...JSON_CT, origin: 'https://elsewhere.example' },
      JSON.stringify([SEARCH]),
      []
    ),
    post(
      'batch-just-over-1mb',
      BATCH,
      { ...beaconFrom, ...JSON_CT },
      paddedJson({ x: [SEARCH] }, OVER_LIMIT),
      []
    ),

    // --- methods ------------------------------------------------------------------------------------
    // `PublicEndpoint` does not refuse a method outside its list (it only answers an OPTIONS
    // preflight), so these reach the handler, under Next as here: a bodiless GET or HEAD fails its
    // body parse, and a PUT with a valid body is tracked like a POST.
    { id: 'ping-get', path: PING, headers: beaconFrom, tracked: [] },
    { id: 'pulse-get', path: PULSE, headers: beaconFrom, tracked: [] },
    { id: 'batch-head', method: 'HEAD', path: BATCH, headers: beaconFrom, tracked: [] },
    post('batch-put', BATCH, { ...beaconFrom, ...JSON_CT }, JSON.stringify([SEARCH]), ['search'], {
      method: 'PUT',
    }),
    {
      // A CORS preflight, answered by the endpoint wrapper before the handler.
      id: 'pulse-options-preflight',
      method: 'OPTIONS',
      path: PULSE,
      headers: {
        ...beaconFrom,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
      tracked: [],
    },

    // --- what the router does before a route runs ---------------------------------------------------
    post(
      // Next strips these; not stripping `x-nextjs-data` makes the route module add
      // `x-nextjs-matched-path` to the response (the negative control's diff).
      'client-sent-internal-headers',
      PULSE,
      {
        ...beaconFrom,
        ...JSON_CT,
        'x-nextjs-data': '1',
        'x-matched-path': '/api/trpc/[trpc]',
        'x-middleware-override-headers': 'origin',
        'x-middleware-request-origin': 'https://elsewhere.example',
        'x-now-route-matches': 'nxtPtrpc=a',
      },
      JSON.stringify(VIEW),
      ['views']
    ),
    post(
      // Next drops `nxtP…` query keys before the route runs; so must this server.
      'internal-query-keys',
      BATCH,
      { ...beaconFrom, ...JSON_CT },
      JSON.stringify([SEARCH]),
      ['search'],
      { path: `${BATCH}?nxtPfoo=1&nextInternalLocale=en&x=1` }
    ),
    post(
      // No CDN headers at all: each server fills x-forwarded-* from the socket, which the row's
      // `ip` column is derived from.
      'no-forwarded-headers',
      PULSE,
      { 'user-agent': BEACON_UA, origin: SITE, referer: `${SITE}/`, ...JSON_CT },
      JSON.stringify(VIEW),
      ['views']
    ),

    // --- not an exact match: this server's plain answers; the callers never send these ------------
    post(
      'ping-trailing-slash',
      `${PING}/`,
      { ...beaconFrom, ...TEXT },
      JSON.stringify(PAGE_VIEW),
      [],
      {
        divergence: { reason: REDIRECTED_BY_NEXT, candidate: NOT_FOUND },
      }
    ),
    post(
      'batch-extra-segment',
      `${BATCH}/x`,
      { ...beaconFrom, ...JSON_CT },
      JSON.stringify([SEARCH]),
      [],
      {
        divergence: { reason: PAGE_RENDERED, candidate: NOT_FOUND },
      }
    ),
    post(
      // A sibling beacon that stays on Next: this server does not serve it.
      'neighbouring-beacon-not-served',
      '/api/track/block-render',
      { ...beaconFrom, ...JSON_CT },
      JSON.stringify({ appBlockId: 'a', blockInstanceId: 'b', slotId: 'c' }),
      [],
      {
        divergence: {
          reason:
            'Next serves this route; this server serves only the pages in served-pages.cjs, and routing sends it only those.',
          candidate: NOT_FOUND,
        },
      }
    ),

    // --- the server's other routes, next to these ---------------------------------------------------
    {
      id: 'other-internal-route',
      path: '/api/live?token={WEBHOOK_TOKEN}',
      headers: {},
      tracked: [],
    },
    {
      id: 'trpc-call',
      path: `/api/trpc/content.get?input=${enc({ json: TOS })}`,
      headers: edge,
      tracked: [],
    },
  ];
}
