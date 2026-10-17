#!/usr/bin/env node
// @ts-check
/**
 * Behavioural parity between Next's `server.js` and the standalone tRPC server, end to end: the
 * same requests to both, and every response compared — status, every header, body bytes.
 *
 *   node scripts/trpc-server/parity-check.mjs --next http://127.0.0.1:3101 --fast http://127.0.0.1:3102 \
 *     --cookie "<a valid civ-token for a signed-in user>"
 *
 * Both servers must run the SAME build with the same environment, each preloaded with
 * `parity-probe.cjs` (the check refuses to report parity without it, since the request-side effects
 * of the proxy chain are only visible through it). Exit 0 = identical on every case and every
 * positive control held; 1 = a difference; 2 = the instrument could not observe something.
 *
 * Positive controls, so a "no difference" cannot come from a run that exercised nothing: the
 * signed-in case must not answer 401; devalue and superjson cases must produce different bodies; the
 * spoofed and the genuine crawler must reach the route differently; the cacheable case must carry a
 * public Cache-Control.
 */
import http from 'node:http';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    next: { type: 'string' },
    fast: { type: 'string' },
    cookie: { type: 'string' },
    host: { type: 'string', default: 'civitai.com' },
    verbose: { type: 'boolean', default: false },
  },
});
if (!args.next || !args.fast || !args.cookie) {
  console.error('usage: parity-check.mjs --next <url> --fast <url> --cookie <civ-token>');
  process.exit(2);
}

const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const base = {
  host: args.host,
  origin: `https://${args.host}`,
  'user-agent': BROWSER,
  'cf-ipcountry': 'US',
  'cf-connecting-ip': '203.0.113.9',
};
const capableWeb = { 'x-client': 'web', 'x-client-version': '5.0.2100' };
// The session cookie is `__Secure-civ-token` behind an https base URL and `civ-token` otherwise;
// send both so the case does not depend on how the build under test was configured.
const signedIn = { cookie: `__Secure-civ-token=${args.cookie}; civ-token=${args.cookie}; other=1` };
const q = (/** @type {unknown} */ input) => encodeURIComponent(JSON.stringify(input));
const batch = (/** @type {unknown[]} */ inputs) =>
  q(Object.fromEntries(inputs.map((input, i) => [i, { json: input }])));
const noInput = q({ json: null, meta: { values: ['undefined'] } });

/**
 * @typedef {{ name: string, method?: string, path: string, headers?: Record<string, string>, body?: string | Buffer }} Case
 * @type {Case[]}
 */
const cases = [
  {
    name: 'anon-single',
    path: `/api/trpc/model.getActiveSales?input=${q({ json: { ids: [1, 2, 3] } })}`,
  },
  {
    name: 'anon-batch',
    path: `/api/trpc/model.getActiveSales,tool.getAll?batch=1&input=${batch([
      { ids: [1, 2] },
      null,
    ])}`,
  },
  {
    name: 'signed-in',
    path: `/api/trpc/buzz.getBuzzAccount?input=${noInput}`,
    headers: signedIn,
  },
  {
    name: 'signed-out-protected',
    path: `/api/trpc/buzz.getBuzzAccount?input=${noInput}`,
  },
  { name: 'cacheable-anon', path: `/api/trpc/tool.getAll?input=${noInput}` },
  {
    name: 'cacheable-signed-in',
    path: `/api/trpc/tool.getAll?input=${noInput}`,
    headers: signedIn,
  },
  {
    name: 'superjson-client',
    path: `/api/trpc/model.getActiveSales,buzz.getBuzzAccount?batch=1&input=${batch([
      { ids: [1] },
      null,
    ])}`,
    headers: signedIn,
  },
  {
    name: 'devalue-client',
    path: `/api/trpc/model.getActiveSales,buzz.getBuzzAccount?batch=1&input=${batch([
      { ids: [1] },
      null,
    ])}`,
    headers: { ...signedIn, ...capableWeb },
  },
  { name: 'error-unknown-procedure', path: `/api/trpc/nope.nothing?input=${q({ json: null })}` },
  {
    name: 'error-bad-input',
    path: `/api/trpc/model.getActiveSales?input=${q({ json: { ids: 'x' } })}`,
  },
  {
    name: 'error-mutation-over-get',
    path: `/api/trpc/user.toggleFavorite?input=${q({ json: {} })}`,
    headers: signedIn,
  },
  {
    name: 'error-over-batch-cap',
    path: `/api/trpc/${Array(400).fill('tool.getAll').join(',')}?batch=1&input=${q({})}`,
  },
  {
    name: 'bot-header-spoofed',
    path: `/api/trpc/tool.getAll?input=${noInput}`,
    headers: { 'x-civitai-verified-bot': 'googlebot' },
  },
  {
    name: 'bot-genuine',
    path: `/api/trpc/tool.getAll?input=${noInput}`,
    headers: { 'user-agent': GOOGLEBOT, 'cf-connecting-ip': '192.178.4.1' },
  },
  {
    name: 'internal-headers-injected',
    path: `/api/trpc/tool.getAll?input=${noInput}`,
    headers: {
      'x-middleware-override-headers': 'x-civitai-verified-bot',
      'x-middleware-request-x-civitai-verified-bot': 'googlebot',
      'x-matched-path': '/api/admin',
      'x-middleware-next': '1',
    },
  },
  {
    name: 'api-region-blocked',
    path: `/api/trpc/tool.getAll?input=${noInput}`,
    headers: { 'cf-ipcountry': 'GB' },
  },
  {
    name: 'post-method-override',
    method: 'POST',
    path: `/api/trpc/model.getActiveSales?batch=1`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ 0: { json: { ids: [1, 2] } } }),
  },
  {
    name: 'post-over-body-limit',
    method: 'POST',
    path: `/api/trpc/model.getActiveSales?batch=1`,
    headers: { 'content-type': 'application/json' },
    body: Buffer.alloc(18 * 1024 * 1024, 0x20),
  },
  { name: 'head', method: 'HEAD', path: `/api/trpc/tool.getAll?input=${noInput}` },
  {
    name: 'accept-language',
    path: `/api/trpc/tool.getAll?input=${noInput}`,
    headers: { 'accept-language': 'fr-FR,fr;q=0.9' },
  },
  {
    name: 'forwarded-https',
    path: `/api/trpc/tool.getAll?input=${noInput}`,
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': args.host },
  },
  { name: 'trailing-slash (Next serves both)', path: `/api/trpc/tool.getAll/` },
  { name: 'encoded-path (Next serves both)', path: `/api/trpc/tool%2EgetAll?input=${noInput}` },
];

// Headers whose value is about the connection or the clock, not the response.
const VOLATILE = new Set(['date', 'connection', 'keep-alive', 'transfer-encoding']);

/** @param {string} target @param {Case} c */
function send(target, c) {
  return new Promise((resolve, reject) => {
    const url = new URL(c.path, target);
    const req = http.request(
      url,
      { method: c.method ?? 'GET', headers: { ...base, ...c.headers }, agent: false },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    // A server that never answers is a result, not a reason for the check to hang.
    req.setTimeout(10_000, () => {
      req.destroy();
      resolve({ status: 'timeout', headers: {}, body: Buffer.alloc(0) });
    });
    req.on('error', (err) =>
      /** @type {any} */ (err).code === 'ECONNRESET'
        ? resolve({ status: 'reset', headers: {}, body: Buffer.alloc(0) })
        : reject(err)
    );
    if (c.body !== undefined) req.end(c.body);
    else req.end();
  });
}

/** @param {any} r */
function comparable(r) {
  /** @type {Record<string, unknown>} */
  const headers = {};
  for (const [k, v] of Object.entries(r.headers).sort()) if (!VOLATILE.has(k)) headers[k] = v;
  return { status: r.status, headers, body: r.body.toString('utf8') };
}

/** @param {any} r */
function seen(r) {
  const raw = r.headers['x-parity-seen'];
  return raw ? JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8')) : null;
}

let differences = 0;
let instrumentFailures = 0;
/** @type {Record<string, any>} */
const results = {};
for (const c of cases) {
  const [a, b] = [await send(args.next, c), await send(args.fast, c)];
  const ca = comparable(a);
  const cb = comparable(b);
  const same = JSON.stringify(ca) === JSON.stringify(cb);
  results[c.name] = { a, b, same };
  if (!same) differences++;
  console.log(
    `${same ? 'SAME' : 'DIFF'}  ${c.name.padEnd(34)} next=${a.status} fast=${b.status}  ` +
      `cache-control=${a.headers['cache-control'] ?? '-'}  bytes=${a.body.length}`
  );
  if (!same || args.verbose) {
    for (const k of new Set([...Object.keys(ca.headers), ...Object.keys(cb.headers)])) {
      if (k === 'x-parity-seen') continue;
      if (JSON.stringify(ca.headers[k]) !== JSON.stringify(cb.headers[k]))
        console.log(
          `      header ${k}: next=${JSON.stringify(ca.headers[k])} fast=${JSON.stringify(
            cb.headers[k]
          )}`
        );
    }
    const [sa, sb] = [seen(a) ?? {}, seen(b) ?? {}];
    for (const k of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
      if (JSON.stringify(sa[k]) !== JSON.stringify(sb[k]))
        console.log(
          `      route saw ${k}: next=${JSON.stringify(sa[k])} fast=${JSON.stringify(sb[k])}`
        );
    }
    if (ca.body !== cb.body)
      console.log(
        `      body: next=${ca.body.slice(0, 300)}\n            fast=${cb.body.slice(0, 300)}`
      );
    if (ca.status !== cb.status) console.log(`      status: next=${ca.status} fast=${cb.status}`);
  }
}

/** @param {boolean} ok @param {string} what */
function control(ok, what) {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  control: ${what}`);
  if (!ok) instrumentFailures++;
}
const r = results;
control(
  seen(r['anon-single'].a) !== null && seen(r['anon-single'].b) !== null,
  'parity-probe is loaded in both servers'
);
control(
  r['signed-in'].a.status === 200 && r['signed-in'].b.status === 200,
  'signed-in cookie resolves a user (200, not 401)'
);
control(r['signed-out-protected'].a.status === 401, 'the same call signed out is refused (401)');
control(
  r['devalue-client'].a.body.toString() !== r['superjson-client'].a.body.toString(),
  'devalue and superjson clients get different encodings'
);
control(
  seen(r['bot-genuine'].a)?.['x-civitai-verified-bot'] === 'googlebot' &&
    seen(r['bot-header-spoofed'].a)?.['x-civitai-verified-bot'] === null,
  'Next strips a spoofed crawler header and sets a genuine one'
);
control(
  String(r['cacheable-anon'].a.headers['cache-control'] ?? '').includes('public'),
  'the cacheable procedure is publicly cacheable signed out'
);
control(r['api-region-blocked'].a.status === 451, 'an API-blocked region is refused (451)');

console.log(
  `\n${cases.length} cases: ${cases.length - differences} identical, ${differences} different; ` +
    `${instrumentFailures} positive-control failure(s)`
);
process.exit(instrumentFailures ? 2 : differences ? 1 : 0);
