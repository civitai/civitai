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
 *
 * Shared state is reset between the two sends of a case (Redis FLUSHALL), so a cache write or a
 * rate-limit counter left by the first server cannot change the second server's answer.
 *
 * Usage:
 *   node compare.mjs --a http://127.0.0.1:3000 --b http://127.0.0.1:3001 \
 *     --env-file parity.env --redis 127.0.0.1:6379 --report out.json
 *     [--expect-red <case-id> [--expect-red-diff '<diff line prefix>']]
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
import { buildCases } from './cases.mjs';

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

// --- a legacy session cookie, minted the way tests/preview-auth.setup.ts mints it --------------

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

// --- redis reset ----------------------------------------------------------------------------------

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

// --- sending ----------------------------------------------------------------------------------------

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

// --- comparing -------------------------------------------------------------------------------------

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

// --- run ----------------------------------------------------------------------------------------------

const cases = buildCases({ sessionCookie });
const settleMs = Number(args['settle-ms']);
const results = [];

for (const c of cases) {
  await flushRedis();
  const ra = await send(args.a, c);
  await sleep(settleMs);
  await flushRedis();
  const rb = await send(args.b, c);
  await sleep(settleMs);

  // A declared case lets only the reference differ: the candidate is held to its pinned answer.
  const parts = c.divergence ? compareToPin(c.divergence.candidate, rb) : compare(c, ra, rb);
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
    verdict: failing.length > 0 ? 'DIFF' : c.divergence ? 'DECLARED' : 'SAME',
    failing,
    declared: c.divergence,
    diffs: parts,
  });
}

if (results.length === 0) fail2('no cases ran');
if (results.every((r) => r.reference.error)) fail2(`reference server ${args.a} answered nothing`);
if (results.every((r) => r.candidate.error)) fail2(`candidate server ${args.b} answered nothing`);

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

const diffCount = results.filter((r) => r.verdict === 'DIFF').length;
const summary = {
  a: args.a,
  b: args.b,
  cases: results.length,
  same: results.filter((r) => r.verdict === 'SAME').length,
  declared: results.filter((r) => r.verdict === 'DECLARED').length,
  diff: diffCount,
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

process.exit(diffCount > 0 ? 1 : 0);
