#!/usr/bin/env node
/**
 * Parity harness: sends every case in `cases.mjs` to two servers booted from the same image with
 * the same environment — `--a` (Next's `server.js`, the reference) and `--b` (the server under
 * test) — and diffs what comes back:
 *
 *   - status code and status message
 *   - headers, as a case-insensitive multiset, ignoring only Date, Connection and Keep-Alive
 *   - Set-Cookie: cookie names and attributes; Max-Age/Expires within a tolerance; never values
 *   - body: exact bytes
 *   - a case's `expectStatus` / `expectBody` / `expectHeaders`, required on BOTH sides
 *
 * Shared state is reset between the two sends of a case (Redis FLUSHALL), so a cache write or a
 * rate-limit counter left by the first server cannot change the second server's answer.
 *
 * Usage:
 *   node compare.mjs --a http://127.0.0.1:3000 --b http://127.0.0.1:3001 \
 *     --env-file parity.env --redis 127.0.0.1:6379 --report out.json
 *     [--cases trpc|image-delivery|beacons|api] [--route-counter]
 *     [--tracker <url> --tracker-a-ip <ip> --tracker-b-ip <ip>]
 *     [--expect-red <case-id> [--expect-red-diff '<diff line prefix>']]
 *
 * `--cases` picks the case list (`cases.mjs`): `trpc` (the default), `image-delivery`, `beacons` or
 * `api` (the standalone server's `api` profile: `/api/v1/**` and `/api/auth/**`). A case
 * with `warm: true` is sent once more to the same server, unmeasured, right before its measured
 * send (after the Redis reset), so the measured request finds what the first one cached.
 *
 * `--route-counter` (image-delivery): reads the route's own counter,
 * `civitai_app_image_delivery_request_total{status}`, from both servers' `/api/metrics` before
 * and after the run, and fails unless it moved on EACH server by exactly what the cases' `counted`
 * labels add up to. On the candidate that proves the route itself answered (not a look-alike
 * response); on the reference it is the positive control that the counter can be read at all.
 *
 * `--tracker` (beacons, where it is required): the tracker stub's URL (`tracker-stub.mjs`), and the
 * address each server's events arrive from. For every case it reads the events each server sent
 * for that request, and fails the case unless each sent exactly the tables in the case's `tracked`
 * list and both sent the same rows. For a declared divergence only the candidate is held to
 * `tracked`. A server's events are awaited (up to TRACKER_WAIT_MS) before the next send, since a
 * beacon sends its row after it has answered.
 *
 * Exit codes: 0 parity (every case equal to Next, every declared case equal to its pinned
 * answer); 1 a difference; 2 the harness could not
 * observe what it was asked to (a server unreachable, no cases ran, …). With `--expect-red`, the
 * run must instead DIFFER on that case and 0 means it did — the negative control that proves the
 * harness can see a broken server.
 */

import { createCipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { buildApiCases, buildBeaconCases, buildCases, buildImageDeliveryCases } from './cases.mjs';

const IGNORED_HEADERS = new Set(['date', 'connection', 'keep-alive']);
const COOKIE_TIME_TOLERANCE_S = 30;
// Both servers are addressed as this host, so a header derived from Host is equal on both.
const HOST_HEADER = 'localhost:3000';

const { values: args } = parseArgs({
  options: {
    a: { type: 'string' },
    b: { type: 'string' },
    'env-file': { type: 'string' },
    redis: { type: 'string' },
    report: { type: 'string' },
    'expect-red': { type: 'string' },
    'expect-red-diff': { type: 'string' },
    'settle-ms': { type: 'string', default: '300' },
    cases: { type: 'string', default: 'trpc' },
    'route-counter': { type: 'boolean', default: false },
    tracker: { type: 'string' },
    'tracker-a-ip': { type: 'string' },
    'tracker-b-ip': { type: 'string' },
  },
});

function fail2(message) {
  console.error(`FAIL (cannot observe): ${message}`);
  process.exit(2);
}

if (!args.a || !args.b || !args['env-file'] || !args.redis) {
  fail2('--a, --b, --env-file and --redis are required');
}

const env = Object.fromEntries(
  readFileSync(args['env-file'], 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
);
if (!env.NEXTAUTH_SECRET || !env.WEBHOOK_TOKEN)
  fail2('env file has no NEXTAUTH_SECRET/WEBHOOK_TOKEN');

// A legacy session cookie, minted the way tests/preview-auth.setup.ts mints it. Both targets must run with
// IS_PREVIEW=true and DATABASE_ENVIRONMENT=non-production: nothing else reads this cookie.

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** Compact JWE, alg "dir", enc "A256GCM", key = HKDF(NEXTAUTH_SECRET) as next-auth derives it. */
function mintLegacySessionCookie(secret, user) {
  const key = Buffer.from(
    hkdfSync('sha256', secret, '', 'NextAuth.js Generated Encryption Key', 32)
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    user,
    sub: String(user.id),
    id: randomUUID(),
    signedAt: Date.now(),
    iat: now,
    exp: now + 30 * 24 * 60 * 60,
  };
  const header = b64url(JSON.stringify({ alg: 'dir', enc: 'A256GCM' }));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(header, 'ascii'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return [header, '', b64url(iv), b64url(ciphertext), b64url(cipher.getAuthTag())].join('.');
}

// The preview smoke-test "tester" user (tests/preview-fixtures.ts). Not a real account.
const sessionToken = mintLegacySessionCookie(env.NEXTAUTH_SECRET, {
  id: 2000000002,
  username: 'ci-smoke-tester',
  email: 'ci-smoke-tester@civitai.test',
  isModerator: false,
  showNsfw: false,
  blurNsfw: true,
  browsingLevel: 1,
  onboarding: 15,
  muted: false,
});
const sessionCookie = `civitai-token=${sessionToken}; __Secure-civitai-token=${sessionToken}`;

async function flushRedis() {
  const [host, port] = args.redis.split(':');
  await new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), host);
    let buf = '';
    sock.setTimeout(5000, () => sock.destroy(new Error('redis FLUSHALL timed out')));
    sock.on('connect', () => sock.write('*1\r\n$8\r\nFLUSHALL\r\n'));
    sock.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\r\n')) {
        sock.end();
        if (buf.startsWith('+OK')) resolve();
        else reject(new Error(`redis FLUSHALL answered ${JSON.stringify(buf)}`));
      }
    });
    sock.on('error', reject);
  });
}

function send(base, c) {
  const url = new URL(base);
  const body = typeof c.body === 'function' ? c.body() : c.body;
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: c.method || 'GET',
        // Raw path: `new URL` would normalise `//` and `%` escapes, which are cases here.
        path: c.path.replaceAll('{WEBHOOK_TOKEN}', env.WEBHOOK_TOKEN),
        headers: {
          host: HOST_HEADER,
          ...c.headers,
          ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}),
        },
        agent: false,
        timeout: 60_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            statusMessage: res.statusMessage,
            rawHeaders: res.rawHeaders,
            body: Buffer.concat(chunks),
          })
        );
        res.on('error', (err) => resolve({ error: String(err) }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ error: String(err && err.code ? err.code : err) }));
    // A server may answer (413) and close before the whole body is written; the write error
    // then surfaces on `req`, after the response was already read.
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function headerMultiset(rawHeaders) {
  const out = [];
  const cookies = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (IGNORED_HEADERS.has(name)) continue;
    if (name === 'set-cookie') cookies.push(rawHeaders[i + 1]);
    else out.push(`${name}: ${rawHeaders[i + 1]}`);
  }
  return { headers: out.sort(), cookies };
}

function parseCookie(raw) {
  const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
  const name = pair.slice(0, pair.indexOf('='));
  const attributes = {};
  for (const a of attrs) {
    const eq = a.indexOf('=');
    const k = (eq === -1 ? a : a.slice(0, eq)).toLowerCase();
    attributes[k] = eq === -1 ? true : a.slice(eq + 1);
  }
  return { name, attributes };
}

function compareCookies(a, b) {
  const diffs = [];
  const pa = a.map(parseCookie).sort((x, y) => x.name.localeCompare(y.name));
  const pb = b.map(parseCookie).sort((x, y) => x.name.localeCompare(y.name));
  const names = (l) => l.map((c) => c.name).join(',');
  if (names(pa) !== names(pb)) return [`set-cookie names: ${names(pa)} vs ${names(pb)}`];
  pa.forEach((ca, i) => {
    const cb = pb[i];
    const keys = new Set([...Object.keys(ca.attributes), ...Object.keys(cb.attributes)]);
    for (const k of keys) {
      const va = ca.attributes[k];
      const vb = cb.attributes[k];
      if (k === 'max-age' && va !== undefined && vb !== undefined) {
        if (Math.abs(Number(va) - Number(vb)) > COOKIE_TIME_TOLERANCE_S)
          diffs.push(`set-cookie ${ca.name} max-age ${va} vs ${vb}`);
      } else if (k === 'expires' && va !== undefined && vb !== undefined) {
        if (Math.abs(Date.parse(va) - Date.parse(vb)) / 1000 > COOKIE_TIME_TOLERANCE_S)
          diffs.push(`set-cookie ${ca.name} expires ${va} vs ${vb}`);
      } else if (va !== vb) {
        diffs.push(`set-cookie ${ca.name} ${k}: ${va} vs ${vb}`);
      }
    }
  });
  return diffs;
}

function multisetDiff(a, b) {
  const count = (l) => l.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
  const ca = count(a);
  const cb = count(b);
  const out = [];
  for (const [k, n] of ca) if ((cb.get(k) || 0) < n) out.push(`- ${k}`);
  for (const [k, n] of cb) if ((ca.get(k) || 0) < n) out.push(`+ ${k}`);
  return out;
}

function snippet(buf) {
  const s = buf.toString('utf8');
  return s.length > 300 ? `${s.slice(0, 300)}…(${buf.length} bytes)` : s;
}

function compare(c, ra, rb) {
  const parts = { status: [], headers: [], body: [] };
  if (ra.error || rb.error) {
    // Two transport failures are not parity: neither server answered, so nothing was compared.
    parts.status.push(`transport: ${ra.error || 'ok'} vs ${rb.error || 'ok'}`);
    return parts;
  }
  if (ra.status !== rb.status || ra.statusMessage !== rb.statusMessage) {
    parts.status.push(`${ra.status} ${ra.statusMessage} vs ${rb.status} ${rb.statusMessage}`);
  }
  const ha = headerMultiset(ra.rawHeaders);
  const hb = headerMultiset(rb.rawHeaders);
  parts.headers.push(
    ...multisetDiff(ha.headers, hb.headers),
    ...compareCookies(ha.cookies, hb.cookies)
  );
  if (!ra.body.equals(rb.body)) {
    parts.body.push(`A: ${snippet(ra.body)}`, `B: ${snippet(rb.body)}`);
  }
  // A case may also require a header on BOTH sides (e.g. a streamed response must be chunked):
  // equal-but-wrong on both would otherwise pass.
  for (const [name, value] of Object.entries(c.expectHeaders || {})) {
    for (const [side, h] of [
      ['A', ha],
      ['B', hb],
    ]) {
      if (!h.headers.includes(`${name}: ${value}`))
        parts.headers.push(`${side} lacks required ${name}: ${value}`);
    }
  }
  // Likewise a case may pin the status and exact body on BOTH sides, for an answer where both
  // servers agreeing on the wrong value (e.g. both 503) must not pass.
  for (const [side, r] of [
    ['A', ra],
    ['B', rb],
  ]) {
    if (c.expectStatus !== undefined && r.status !== c.expectStatus)
      parts.status.push(`${side} answered ${r.status}, required ${c.expectStatus}`);
    if (c.expectBody !== undefined && !r.body.equals(Buffer.from(c.expectBody)))
      parts.body.push(`${side} body ${snippet(r.body)}, required ${c.expectBody}`);
  }
  return parts;
}

/** The candidate's response against a declared case's exact expected answer. */
function compareToPin(pin, rb) {
  const parts = { status: [], headers: [], body: [] };
  if (rb.error) {
    parts.status.push(`transport: ${rb.error}`);
    return parts;
  }
  if (rb.status !== pin.status || rb.statusMessage !== pin.statusMessage) {
    parts.status.push(
      `pinned ${pin.status} ${pin.statusMessage} vs ${rb.status} ${rb.statusMessage}`
    );
  }
  const hb = headerMultiset(rb.rawHeaders);
  parts.headers.push(
    ...multisetDiff([...pin.headers].sort(), hb.headers),
    ...hb.cookies.map((cookie) => `+ set-cookie: ${cookie}`)
  );
  if (!rb.body.equals(Buffer.from(pin.body))) {
    parts.body.push(`pinned: ${pin.body}`, `B: ${snippet(rb.body)}`);
  }
  return parts;
}

const ROUTE_COUNTER = 'civitai_app_image_delivery_request_total';

/** { status: value } for ROUTE_COUNTER on `base` (an absent label set reads as 0). */
async function readRouteCounter(base) {
  const r = await send(base, { path: '/api/metrics?token={WEBHOOK_TOKEN}', headers: {} });
  if (r.error || r.status !== 200) {
    fail2(`GET ${base}/api/metrics answered ${r.error || r.status}; cannot read ${ROUTE_COUNTER}`);
  }
  const text = r.body.toString('utf8');
  // Positive control on the scrape itself: a metric every app process exports.
  if (!/^civitai_app_/m.test(text)) fail2(`${base}/api/metrics has no civitai_app_ series at all`);
  const counts = {};
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${ROUTE_COUNTER}{`)) continue;
    const status = /status="([^"]*)"/.exec(line)?.[1];
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (status) counts[status] = value;
  }
  return counts;
}

const TRACKER_WAIT_MS = 10_000;

async function readTracker(since) {
  const res = await fetch(`${args.tracker}/__events?since=${since}`).catch((err) => ({ err }));
  if (res.err || !res.ok) fail2(`tracker stub ${args.tracker} answered ${res.err || res.status}`);
  return res.json();
}

/**
 * The events `ip` sent after the stub's first `since` events. Waits until at least `expected` have
 * arrived (or TRACKER_WAIT_MS), then one settle period more, so an extra event is seen too.
 */
async function trackerEventsSince(since, ip, expected) {
  const deadline = Date.now() + TRACKER_WAIT_MS;
  const from = (r) => r.events.filter((e) => e.from === ip);
  let r = await readTracker(since);
  while (from(r).length < expected && Date.now() < deadline) {
    await sleep(100);
    r = await readTracker(since);
  }
  await sleep(settleMs);
  return from(await readTracker(since));
}

const table = (e) => e.path.replace(/^\/track\//, '');
const row = (e) => `${e.method} ${e.path} ${JSON.stringify(e.body)}`;

/** Each server sent exactly the case's tables (only the candidate for a declared case), and the same rows. */
function compareTracked(c, ea, eb) {
  const diffs = [];
  const want = [...c.tracked].sort();
  const sides = c.divergence
    ? [['B', eb]]
    : [
        ['A', ea],
        ['B', eb],
      ];
  for (const [side, events] of sides) {
    const got = events.map(table).sort();
    if (JSON.stringify(got) !== JSON.stringify(want))
      diffs.push(`${side} sent [${got.join(', ')}], expected [${want.join(', ')}]`);
  }
  if (!c.divergence) diffs.push(...multisetDiff(ea.map(row), eb.map(row)));
  return diffs;
}

const suites = {
  trpc: () => buildCases({ sessionCookie }),
  'image-delivery': () => buildImageDeliveryCases({ webhookToken: env.WEBHOOK_TOKEN }),
  beacons: () => buildBeaconCases({ sessionCookie }),
  api: () => buildApiCases({ sessionCookie }),
};
if (!suites[args.cases]) fail2(`--cases ${args.cases}: expected one of ${Object.keys(suites)}`);
const cases = suites[args.cases]();
const tracking = Boolean(args.tracker);
if (args.cases === 'beacons' && !tracking) fail2('--cases beacons needs --tracker');
if (tracking && (!args['tracker-a-ip'] || !args['tracker-b-ip']))
  fail2('--tracker needs --tracker-a-ip and --tracker-b-ip');
if (tracking && !cases.every((c) => Array.isArray(c.tracked)))
  fail2('--tracker: every case needs a `tracked` list');
const settleMs = Number(args['settle-ms']);
const results = [];

const counterBefore = args['route-counter']
  ? { a: await readRouteCounter(args.a), b: await readRouteCounter(args.b) }
  : null;

for (const c of cases) {
  const want = tracking ? c.tracked.length : 0;
  await flushRedis();
  if (c.warm) await send(args.a, c);
  const markA = tracking ? (await readTracker(0)).total : 0;
  const ra = await send(args.a, c);
  const ea = tracking ? await trackerEventsSince(markA, args['tracker-a-ip'], want) : [];
  if (!tracking) await sleep(settleMs);
  await flushRedis();
  if (c.warm) await send(args.b, c);
  const markB = tracking ? (await readTracker(0)).total : 0;
  const rb = await send(args.b, c);
  const eb = tracking ? await trackerEventsSince(markB, args['tracker-b-ip'], want) : [];
  if (!tracking) await sleep(settleMs);

  // A declared case lets only the reference differ: the candidate is held to its pinned answer.
  const parts = c.divergence ? compareToPin(c.divergence.candidate, rb) : compare(c, ra, rb);
  if (tracking) parts.tracker = compareTracked(c, ea, eb);
  const failing = Object.entries(parts)
    .filter(([, diffs]) => diffs.length > 0)
    .map(([part]) => part);

  results.push({
    id: c.id,
    method: c.method || 'GET',
    path: c.path.length > 160 ? `${c.path.slice(0, 160)}…` : c.path,
    // What Next itself answered: the measured reference behaviour for this case.
    reference: ra.error
      ? { error: ra.error }
      : { status: ra.status, statusMessage: ra.statusMessage },
    candidate: rb.error
      ? { error: rb.error }
      : { status: rb.status, statusMessage: rb.statusMessage },
    // What the case actually exercised, so a run where every case short-circuits is visible.
    referenceBody: ra.error ? undefined : snippet(ra.body),
    ...(tracking ? { tracked: { reference: ea.map(row), candidate: eb.map(row) } } : {}),
    verdict: failing.length > 0 ? 'DIFF' : c.divergence ? 'DECLARED' : 'SAME',
    failing,
    declared: c.divergence,
    diffs: parts,
  });
}

if (results.length === 0) fail2('no cases ran');
if (results.every((r) => r.reference.error)) fail2(`reference server ${args.a} answered nothing`);
if (results.every((r) => r.candidate.error)) fail2(`candidate server ${args.b} answered nothing`);
if (tracking) {
  // Positive control: the reference's rows reached the stub. Without any, every `tracked: []`
  // case would pass against a stub wired to nothing.
  const sent = results.reduce((k, r) => k + r.tracked.reference.length, 0);
  const expected = cases.filter((c) => !c.divergence).reduce((k, c) => k + c.tracked.length, 0);
  console.log(`tracker rows: reference sent ${sent}, cases expect ${expected} from each server`);
  if (expected === 0) fail2('no case expects a tracker row');
  if (sent === 0)
    fail2(`no tracker row from the reference (${args['tracker-a-ip']}) reached the stub`);
}

for (const r of results) {
  const ref = r.reference.error || `${r.reference.status}`;
  const cand = r.candidate.error || `${r.candidate.status}`;
  console.log(`${r.verdict.padEnd(8)} ${r.id.padEnd(36)} next=${ref} candidate=${cand}`);
  if (r.referenceBody)
    console.log(`           next body: ${r.referenceBody.slice(0, 120).replace(/\s+/g, ' ')}`);
  for (const [part, diffs] of Object.entries(r.diffs)) {
    for (const d of diffs) console.log(`           ${part}: ${d}`);
  }
}

let counterCheck = null;
if (args['route-counter']) {
  const sends = (c) => (c.warm ? 2 : 1);
  const expected = {};
  for (const c of cases) if (c.counted) expected[c.counted] = (expected[c.counted] || 0) + sends(c);
  if (Object.keys(expected).length === 0) fail2('no case has a counted label');
  const after = { a: await readRouteCounter(args.a), b: await readRouteCounter(args.b) };
  const labels = [
    ...new Set([...Object.keys(expected), ...Object.keys(after.a), ...Object.keys(after.b)]),
  ];
  const measured = { a: {}, b: {} };
  let ok = true;
  for (const side of ['a', 'b']) {
    for (const l of labels) {
      measured[side][l] = (after[side][l] || 0) - (counterBefore[side][l] || 0);
      if (measured[side][l] !== (expected[l] || 0)) ok = false;
    }
  }
  counterCheck = { expected, measured, ok };
  console.log(`\n${ROUTE_COUNTER} moved by (expected ${JSON.stringify(expected)}):`);
  console.log(`  --a (reference): ${JSON.stringify(measured.a)}`);
  console.log(`  --b (candidate): ${JSON.stringify(measured.b)}`);
}

const diffCount = results.filter((r) => r.verdict === 'DIFF').length;
const summary = {
  a: args.a,
  b: args.b,
  cases: results.length,
  same: results.filter((r) => r.verdict === 'SAME').length,
  declared: results.filter((r) => r.verdict === 'DECLARED').length,
  diff: diffCount,
  counterCheck,
  results,
};
if (args.report) writeFileSync(args.report, JSON.stringify(summary, null, 2));
console.log(
  `\n${summary.cases} cases: ${summary.same} same, ${summary.declared} declared divergence, ${summary.diff} different`
);

if (args['expect-red']) {
  const target = results.find((r) => r.id === args['expect-red']);
  if (!target) fail2(`--expect-red ${args['expect-red']}: no such case`);
  // Red for the RIGHT reason: the named diff line must be among the case's differences, so a
  // different break (or noise) on the same case cannot pass as the control.
  const want = args['expect-red-diff'];
  const lines = Object.values(target.diffs).flat();
  const hit = want ? lines.some((l) => l.startsWith(want)) : true;
  if (target.verdict === 'DIFF' && hit) {
    console.log(
      `\nNEGATIVE CONTROL OK: ${target.id} is red against the broken server` +
        (want ? `, with "${want}…".` : '.')
    );
    process.exit(0);
  }
  if (target.verdict === 'DIFF') {
    console.error(
      `\nNEGATIVE CONTROL FAILED: ${target.id} is red, but not with "${want}…":\n  ${lines.join(
        '\n  '
      )}`
    );
    process.exit(1);
  }
  console.error(
    `\nNEGATIVE CONTROL FAILED: ${target.id} is ${target.verdict} against a server that was broken on purpose; the harness cannot see that break.`
  );
  process.exit(1);
}

if (counterCheck && !counterCheck.ok) {
  console.error(
    `\nFAIL: ${ROUTE_COUNTER} did not move by exactly the cases' counted labels on both servers.`
  );
  process.exit(1);
}

process.exit(diffCount > 0 ? 1 : 0);
