// Generates the golden fixtures (testdata/golden/{ping,pulse}/*.json) and the reference vectors
// (testdata/golden/vectors.json) beacon-go's tests read. Run from the repo root:
//
//   pnpm exec tsx --tsconfig tsconfig.json apps/beacon-go/testdata/golden/gen.ts
//
// Everything here is SYNTHETIC: hosts under example.test, documentation addresses (RFC 5737 /
// RFC 3849), invented user ids (1001..). No production data.
//
// Where an expected value comes from: the REAL Node code wherever it imports cleanly —
// pageViewBeaconSchema / addViewSchema (src/server/schema/track.schema.ts), getMatchingPathname
// (src/shared/constants/pathname.constants.ts), resolveClientIp (src/server/utils/client-ip.ts),
// Next 16's own parseBody, generateETag and `fresh`, the JS engine's URL / JSON / Number / String,
// and the shadow sampler's own payload builder (src/server/beacon/beacon-go-shadow-payload.ts).
// What does not import outside the app (PublicEndpoint's header logic, the Tracker's row assembly,
// clampToColumn) is transcribed below, each mirror naming the code it follows. Never from beacon-go.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { getMatchingPathname } from '~/shared/constants/pathname.constants';
import { addViewSchema, pageViewBeaconSchema } from '~/server/schema/track.schema';
import { resolveClientIp } from '~/server/utils/client-ip';
import {
  buildBeaconGoShadowPayload,
  pickBeaconResponseHeaders,
  pickBeaconShadowHeaders,
  shadowBody,
} from '~/server/beacon/beacon-go-shadow-payload';

const HERE = join(process.cwd(), 'apps/beacon-go/testdata/golden');

type Headers = Record<string, string>;
type Session = { id: number; tier?: string | null; cookie: string; iat: number } | null;
type Fixture = {
  name: string;
  endpoint: 'ping' | 'pulse';
  method?: string;
  target?: string;
  headers: Headers;
  body?: string;
  /** Raw body bytes as hex, for bodies that are not valid UTF-8. */
  bodyHex?: string;
  /** A long body, spelled compactly: prefix + repeat × count + suffix (no shadow sample kept). */
  bodyTemplate?: { prefix: string; repeat: string; count: number; suffix: string };
  session?: Session;
  trackerEnabled?: boolean;
  /** beacon-go must fall back with this reason (Node's answer is then not reproduced). */
  fallback?: string;
};

// ---- Next 16 (the real modules) ------------------------------------------------------------
async function nextModules() {
  const pb = await import('next/dist/server/api-utils/node/parse-body.js');
  const et = await import('next/dist/server/lib/etag.js');
  const fr = await import('next/dist/compiled/fresh/index.js');
  const parseBody = (pb as any).parseBody ?? (pb as any).default.parseBody;
  const generateETag = (et as any).generateETag ?? (et as any).default.generateETag;
  const fresh = (fr as any).default ?? fr;
  return { parseBody, generateETag, fresh };
}

// ---- Transcriptions --------------------------------------------------------------------------
// endpoint-helpers.ts SESSION_COOKIE_NAMES / requestCarriesCallerCredentials (the fixtures carry no
// query string, so its query-token arm never applies).
const SESSION_COOKIE_NAMES = [
  '__Host-civ-token',
  '__Secure-civ-token',
  'civ-token',
  '__Secure-civitai-token',
  'civitai-token',
];
function carriesCallerCredentials(req: { headers: Headers }) {
  if (req.headers.authorization) return true;
  const raw = req.headers.cookie;
  if (raw) {
    for (const pair of raw.split(';')) {
      const eq = pair.indexOf('=');
      const name = (eq === -1 ? pair : pair.slice(0, eq)).trim();
      if (name && SESSION_COOKIE_NAMES.includes(name)) return true;
    }
  }
  return false;
}
// bot-detection/header.ts parseVerifiedBotHeader
const verifiedBot = (req: { headers: Headers }) => {
  const v = req.headers['x-civitai-verified-bot'];
  return v === 'googlebot' || v === 'bingbot';
};
// tracker.ts clampToColumn and its two bounds.
function clampToColumn(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  const truncated = Math.trunc(value);
  if (truncated < 0) return 0;
  return truncated > max ? max : truncated;
}
const UINT32_MAX = 4_294_967_295;
const INT16_MAX = 32_767;

class MiniRes {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';
  constructor(
    private req: { headers: Headers },
    private next: Awaited<ReturnType<typeof nextModules>>
  ) {}
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  getHeader(name: string) {
    return this.headers[name.toLowerCase()];
  }
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  end(chunk?: string) {
    if (typeof chunk === 'string') this.body = chunk;
    return this;
  }
  // Next's sendData for a string body: ETag, then 304 when fresh, else the body (no Content-Type).
  send(body: string) {
    const etag = this.next.generateETag(body);
    this.setHeader('ETag', etag);
    if (this.next.fresh(this.req.headers, { etag })) {
      this.statusCode = 304;
      return this.end();
    }
    return this.end(body);
  }
}

// The Tracker as the two beacons use it: the actor from the constructor (resolveClientIp, the user
// agent), the session resolved on send, and pageView's / track's row assembly (tracker.ts).
class MirrorTracker {
  writes: { table: string; body: string }[] = [];
  actor: { userId: number; ip: string; userAgent: string };
  constructor(req: any, private session: Session, private enabled: boolean) {
    this.actor = {
      userId: 0,
      ip: resolveClientIp(req),
      userAgent: req.headers['user-agent'] ?? 'unknown',
    };
  }
  private resolve() {
    this.actor.userId = this.session?.id ?? this.actor.userId;
  }
  async pageView(values: {
    pageId: string;
    path: string;
    host: string;
    ads: boolean;
    country: string;
    duration: number;
    windowWidth: number;
    windowHeight: number;
  }) {
    if (!this.enabled) return false;
    this.resolve();
    const { duration, windowWidth, windowHeight, ...rest } = values;
    const row = {
      userId: this.actor.userId,
      memberType: this.session?.tier ?? 'undefined',
      ip: this.actor.ip,
      ...rest,
      duration: clampToColumn(duration, UINT32_MAX),
      windowWidth: clampToColumn(windowWidth, INT16_MAX),
      windowHeight: clampToColumn(windowHeight, INT16_MAX),
    };
    this.writes.push({ table: 'pageViews', body: JSON.stringify(row) });
    return true;
  }
  async view(values: object) {
    if (!this.enabled) return false;
    this.resolve();
    this.writes.push({ table: 'views', body: JSON.stringify({ ...this.actor, ...values }) });
    return true;
  }
}

// src/pages/api/internal/ping.ts (isDev false).
async function ping(req: any, res: MiniRes, tracker: MirrorTracker) {
  let url: URL | undefined;
  try {
    url = req.headers.referer ? new URL(req.headers.referer) : undefined;
  } catch {
    return res.status(400).send('invalid request');
  }
  const host = req.headers.host;
  if (!url || url.host !== host) return res.status(400).send('invalid request');
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body);
  } catch {
    return res.status(400).send('invalid request');
  }
  const result = pageViewBeaconSchema.safeParse(parsed);
  if (!result.success) return res.status(400).send('invalid request');
  const { ads, duration, path, windowWidth, windowHeight } = result.data;
  const country = (req.headers['cf-ipcountry'] as string) ?? 'undefined';
  const match = getMatchingPathname(path);
  if (!match) return res.status(200).end();
  await tracker.pageView({
    pageId: match,
    path,
    host,
    country,
    ads,
    duration: Math.floor(duration),
    windowWidth,
    windowHeight,
  });
  return res.status(200).end();
}

// src/pages/api/internal/pulse.ts (isDev false). The view is awaited here only so the mirror has
// its row; the handler does not await it, which changes nothing in the row or the response.
async function pulse(req: any, res: MiniRes, tracker: MirrorTracker) {
  const source = req.headers.origin ?? req.headers.referer;
  const sourceHost = source
    ? (() => {
        try {
          return new URL(source).host;
        } catch {
          return undefined;
        }
      })()
    : undefined;
  if (!sourceHost || sourceHost !== req.headers.host)
    return res.status(400).send('invalid request');
  let parsed: unknown;
  try {
    parsed = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).send('invalid body');
  }
  const result = addViewSchema.safeParse(parsed);
  if (!result.success) return res.status(400).send('invalid input');
  await tracker.view(result.data);
  return res.status(200).end();
}

function bodyBytes(fx: Fixture): Buffer {
  if (fx.bodyHex !== undefined) return Buffer.from(fx.bodyHex, 'hex');
  if (fx.bodyTemplate) {
    const t = fx.bodyTemplate;
    return Buffer.from(t.prefix + t.repeat.repeat(t.count) + t.suffix, 'utf8');
  }
  return Buffer.from(fx.body ?? '', 'utf8');
}

async function outcome(fx: Fixture, next: Awaited<ReturnType<typeof nextModules>>) {
  const bytes = bodyBytes(fx);
  const req: any = Readable.from(bytes.length ? [bytes] : []);
  req.headers = { ...fx.headers };
  req.method = fx.method ?? 'POST';
  req.url = fx.target ?? `/api/internal/${fx.endpoint}`;
  req.socket = { remoteAddress: undefined };
  try {
    req.body = await next.parseBody(req, '1mb');
  } catch (e: any) {
    // Next's sendError: the handler never runs, so no PublicEndpoint header and no shadow sample.
    return {
      expect: { status: e.statusCode, headers: {}, body: e.message, writes: [] },
      shadow: undefined,
    };
  }
  const res = new MiniRes(req, next);
  // PublicEndpoint (endpoint-helpers.ts): Vary, then addCorsHeaders(req, res, ['POST']), which ends
  // a preflight, then the cache directive.
  const credentialed = carriesCallerCredentials(req);
  res.setHeader('Vary', credentialed ? 'Authorization, Cookie' : 'Authorization');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, *');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '7200');
    res.status(200).end();
    return {
      expect: { status: 200, headers: res.headers, body: '', writes: [] },
      shadow: undefined,
    };
  }
  if (credentialed || verifiedBot(req))
    res.setHeader('Cache-Control', 'max-age=0, private, no-cache');
  else res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=150');
  const tracker = new MirrorTracker(req, fx.session ?? null, fx.trackerEnabled ?? true);
  await (fx.endpoint === 'ping' ? ping : pulse)(req, res, tracker);
  const expect = {
    status: res.statusCode,
    headers: res.headers,
    body: res.body,
    writes: tracker.writes,
  };
  const { body, bodyIsString } = shadowBody(req.body);
  const shadow = buildBeaconGoShadowPayload({
    method: req.method,
    target: req.url,
    headers: pickBeaconShadowHeaders(req),
    body,
    bodyIsString,
    status: res.statusCode,
    responseHeaders: pickBeaconResponseHeaders(res),
    responseBody: res.body,
    writes: tracker.writes,
  });
  return { expect, shadow };
}

// ---- The fixtures ----------------------------------------------------------------------------
const HOST = 'www.example.test';
const REF = `https://${HOST}/models/123/some-slug`;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) ExampleBrowser/1.0';
const IP4 = '203.0.113.7';
const SIGNED_IN: Session = {
  id: 1001,
  tier: 'gold',
  cookie: '__Secure-civ-token',
  iat: 1_780_000_000,
};
const pageBody = (o: object) => JSON.stringify(o);
const basePing = {
  host: HOST,
  referer: REF,
  'user-agent': UA,
  'cf-connecting-ip': IP4,
  'cf-ipcountry': 'US',
};
const viewBody = {
  type: 'ImageView',
  entityType: 'Image',
  entityId: 123,
  ads: 'Served',
  nsfw: false,
  nsfwLevel: 1,
  browsingLevel: 31,
};
const basePulse = {
  host: HOST,
  origin: `https://${HOST}`,
  'content-type': 'application/json',
  'user-agent': UA,
  'cf-connecting-ip': IP4,
};
const page = {
  ads: true,
  duration: 12345.9,
  path: '/models/123/some-slug',
  windowWidth: 1920,
  windowHeight: 1080,
};

const fixtures: Fixture[] = [
  // ---- ping ----
  { name: 'anon-basic', endpoint: 'ping', headers: basePing, body: pageBody(page) },
  {
    name: 'signed-in-tier',
    endpoint: 'ping',
    headers: { ...basePing, cookie: '_ga=GA1.1; __Secure-civ-token=hdr.payload.sig' },
    body: pageBody(page),
    session: SIGNED_IN,
  },
  {
    name: 'signed-in-no-tier',
    endpoint: 'ping',
    headers: { ...basePing, cookie: '__Secure-civ-token=hdr.payload.sig' },
    body: pageBody(page),
    session: { ...SIGNED_IN!, tier: null },
  },
  {
    name: 'numeric-strings',
    endpoint: 'ping',
    headers: basePing,
    body: pageBody({
      ads: 'true',
      duration: '  42.7 ',
      windowWidth: '0x10',
      windowHeight: 'abc',
      path: '/images',
    }),
  },
  {
    name: 'clamps',
    endpoint: 'ping',
    headers: basePing,
    body: pageBody({
      ads: false,
      duration: 1e20,
      windowWidth: 183800,
      windowHeight: -5,
      path: '/videos',
    }),
  },
  {
    name: 'negative-duration-floors',
    endpoint: 'ping',
    headers: basePing,
    body: '{"duration":-0.5,"windowWidth":1e400,"windowHeight":"1e3","path":"/"}',
  },
  { name: 'absent-dimensions', endpoint: 'ping', headers: basePing, body: '{"path":"/generate"}' },
  {
    name: 'no-country',
    endpoint: 'ping',
    headers: { host: HOST, referer: REF, 'cf-connecting-ip': IP4 },
    body: pageBody(page),
  },
  {
    name: 'empty-country',
    endpoint: 'ping',
    headers: { ...basePing, 'cf-ipcountry': '' },
    body: pageBody(page),
  },
  {
    name: 'unknown-path-verbatim',
    endpoint: 'ping',
    headers: basePing,
    body: pageBody({ path: '/comics/9/chapter/2' }),
  },
  {
    name: 'models-prefix-quirk',
    endpoint: 'ping',
    headers: basePing,
    body: pageBody({ path: '/models' }),
  },
  {
    name: 'soft-match-user',
    endpoint: 'ping',
    headers: basePing,
    body: pageBody({ path: '/user/someone/images' }),
  },
  {
    name: 'unicode-path',
    endpoint: 'ping',
    headers: basePing,
    body: '{"path":"/tag/caf\\u00e9\\ud800 \\u2028<&>\\"\\\\\\u0007\\ud83d\\ude00"}',
  },
  { name: 'missing-referer', endpoint: 'ping', headers: { host: HOST }, body: pageBody(page) },
  {
    name: 'empty-referer',
    endpoint: 'ping',
    headers: { host: HOST, referer: '' },
    body: pageBody(page),
  },
  {
    name: 'referer-host-mismatch',
    endpoint: 'ping',
    headers: { ...basePing, referer: 'https://other.example.test/x' },
    body: pageBody(page),
  },
  {
    name: 'referer-no-scheme',
    endpoint: 'ping',
    headers: { ...basePing, referer: 'example' },
    body: pageBody(page),
  },
  {
    name: 'referer-bad-port',
    endpoint: 'ping',
    headers: { ...basePing, referer: `https://${HOST}:99999/x` },
    body: pageBody(page),
  },
  {
    name: 'referer-default-port',
    endpoint: 'ping',
    headers: { ...basePing, referer: `https://${HOST}:0443/x` },
    body: pageBody(page),
  },
  {
    name: 'referer-other-port',
    endpoint: 'ping',
    headers: { ...basePing, host: `${HOST}:8443`, referer: `https://${HOST}:8443/x?y#z` },
    body: pageBody(page),
  },
  {
    name: 'referer-uppercase',
    endpoint: 'ping',
    headers: { ...basePing, referer: 'HTTPS://WWW.Example.TEST/Models' },
    body: pageBody(page),
  },
  {
    name: 'host-header-case-mismatch',
    endpoint: 'ping',
    headers: { ...basePing, host: 'WWW.example.test' },
    body: pageBody(page),
  },
  { name: 'missing-host', endpoint: 'ping', headers: { referer: REF }, body: pageBody(page) },
  { name: 'invalid-json', endpoint: 'ping', headers: basePing, body: '{"path":' },
  { name: 'empty-body', endpoint: 'ping', headers: basePing, body: '' },
  { name: 'path-missing', endpoint: 'ping', headers: basePing, body: '{"ads":true}' },
  { name: 'path-not-string', endpoint: 'ping', headers: basePing, body: '{"path":5}' },
  { name: 'array-text-body', endpoint: 'ping', headers: basePing, body: '[{"path":"/"}]' },
  {
    name: 'json-content-type',
    endpoint: 'ping',
    headers: { ...basePing, 'content-type': 'application/json' },
    body: pageBody(page),
  },
  {
    name: 'json-string-body',
    endpoint: 'ping',
    headers: { ...basePing, 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(pageBody({ path: '/images' })),
  },
  {
    name: 'json-number-body',
    endpoint: 'ping',
    headers: { ...basePing, 'content-type': 'application/json' },
    body: '42',
  },
  {
    name: 'json-empty-body',
    endpoint: 'ping',
    headers: { ...basePing, 'content-type': 'application/json' },
    body: '',
  },
  {
    name: 'json-invalid',
    endpoint: 'ping',
    headers: { ...basePing, 'content-type': 'application/json' },
    body: '{"path"',
  },
  {
    name: 'form-body',
    endpoint: 'ping',
    headers: { ...basePing, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'path=%2F',
    fallback: 'form-body',
  },
  {
    name: 'bad-content-type-is-text',
    endpoint: 'ping',
    headers: { ...basePing, 'content-type': 'application/json; charset' },
    body: pageBody({ path: '/images' }),
  },
  {
    name: 'bom-body',
    endpoint: 'ping',
    headers: basePing,
    bodyHex: 'efbbbf' + Buffer.from(pageBody({ path: '/videos' })).toString('hex'),
  },
  {
    name: 'invalid-utf8-path',
    endpoint: 'ping',
    headers: basePing,
    bodyHex:
      Buffer.from('{"path":"/tag/a').toString('hex') +
      'c328e282f09f98' +
      Buffer.from('"}').toString('hex'),
  },
  {
    name: 'options-preflight',
    endpoint: 'ping',
    method: 'OPTIONS',
    headers: basePing,
    body: '',
    fallback: 'preflight',
  },
  {
    name: 'if-none-match-star-on-400',
    endpoint: 'ping',
    headers: { host: HOST, 'if-none-match': '*' },
    body: '',
    fallback: 'conditional-request',
  },
  {
    name: 'if-none-match-etag-on-400',
    endpoint: 'ping',
    headers: { host: HOST, 'if-none-match': 'W/"x", "weftv9g98bf"' },
    body: '',
    fallback: 'conditional-request',
  },
  {
    name: 'if-none-match-no-cache',
    endpoint: 'ping',
    headers: { host: HOST, 'if-none-match': '*', 'cache-control': 'max-age=0, no-cache' },
    body: '',
    fallback: 'conditional-request',
  },
  {
    name: 'if-modified-since-on-400',
    endpoint: 'ping',
    headers: {
      host: HOST,
      'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT',
      'if-none-match': '*',
    },
    body: '',
    fallback: 'conditional-request',
  },
  { name: 'get-method', endpoint: 'ping', method: 'GET', headers: basePing, body: '' },
  {
    name: 'verified-crawler',
    endpoint: 'ping',
    headers: { ...basePing, 'x-civitai-verified-bot': 'googlebot' },
    body: pageBody(page),
  },
  {
    name: 'legacy-cookie-is-credential',
    endpoint: 'ping',
    headers: { ...basePing, cookie: '__Secure-civitai-token=old' },
    body: pageBody(page),
  },
  {
    name: 'cookie-name-without-value',
    endpoint: 'ping',
    headers: { ...basePing, cookie: 'a=1; civ-token' },
    body: pageBody(page),
  },
  {
    name: 'xff-ip',
    endpoint: 'ping',
    headers: { host: HOST, referer: REF, 'x-forwarded-for': '198.51.100.4:5555, 192.0.2.1' },
    body: pageBody(page),
  },
  {
    name: 'xff-skips-garbage',
    endpoint: 'ping',
    headers: { host: HOST, referer: REF, 'x-forwarded-for': 'unknown, 198.51.100.9' },
    body: pageBody(page),
  },
  {
    name: 'cf-ip-trimmed',
    endpoint: 'ping',
    headers: { host: HOST, referer: REF, 'cf-connecting-ip': ' 203.0.113.8 ' },
    body: pageBody(page),
  },
  {
    name: 'cf-ip-invalid-then-real-ip',
    endpoint: 'ping',
    headers: {
      host: HOST,
      referer: REF,
      'cf-connecting-ip': '203.0.113.300',
      'x-real-ip': '192.0.2.44',
    },
    body: pageBody(page),
  },
  {
    name: 'cf-ipv6',
    endpoint: 'ping',
    headers: { host: HOST, referer: REF, 'cf-connecting-ip': '2001:db8::2' },
    body: pageBody(page),
  },
  {
    name: 'tracker-disabled',
    endpoint: 'ping',
    headers: basePing,
    body: pageBody(page),
    trackerEnabled: false,
  },
  // ping: what beacon-go hands back to Node.
  {
    name: 'fallback-bearer',
    endpoint: 'ping',
    headers: { ...basePing, authorization: 'Bearer some-api-key' },
    body: pageBody(page),
    fallback: 'bearer-token',
  },
  {
    name: 'fallback-roll-due',
    endpoint: 'ping',
    headers: { ...basePing, cookie: '__Secure-civ-token=hdr.payload.sig' },
    body: pageBody(page),
    session: { ...SIGNED_IN!, iat: 1_700_000_000 },
    fallback: 'session-roll-due',
  },
  {
    name: 'fallback-xff-ipv6',
    endpoint: 'ping',
    headers: { host: HOST, referer: REF, 'x-forwarded-for': '2001:db8::1, 198.51.100.4' },
    body: pageBody(page),
    fallback: 'client-ip',
  },
  {
    name: 'fallback-no-ip',
    endpoint: 'ping',
    headers: { host: HOST, referer: REF },
    body: pageBody(page),
    fallback: 'client-ip-socket',
  },
  {
    name: 'fallback-query',
    endpoint: 'ping',
    target: '/api/internal/ping?x=1',
    headers: basePing,
    body: pageBody(page),
    fallback: 'query-string',
  },
  {
    name: 'fallback-referer-userinfo',
    endpoint: 'ping',
    headers: { ...basePing, referer: `https://user@${HOST}/x` },
    body: pageBody(page),
    fallback: 'url',
  },
  {
    name: 'fallback-referer-app-scheme',
    endpoint: 'ping',
    headers: { ...basePing, referer: 'android-app://com.example.app/' },
    body: pageBody(page),
    fallback: 'url',
  },
  {
    name: 'fallback-charset',
    endpoint: 'ping',
    headers: { ...basePing, 'content-type': 'text/plain; charset=latin1' },
    body: pageBody(page),
    fallback: 'charset',
  },
  {
    name: 'fallback-json-array-body',
    endpoint: 'ping',
    headers: { ...basePing, 'content-type': 'application/json' },
    body: '["{\\"path\\":\\"/\\"}"]',
    fallback: 'array-body',
  },

  // ---- pulse ----
  {
    name: 'anon-basic',
    endpoint: 'pulse',
    headers: basePulse,
    body: JSON.stringify({
      ...viewBody,
      details: { b: 1, '2': 'x', '1': true, nested: { z: 1, a: [1, 2.5, 1e21, -0] } },
    }),
  },
  {
    name: 'signed-in',
    endpoint: 'pulse',
    headers: { ...basePulse, cookie: '__Host-civ-token=hdr.payload.sig' },
    body: JSON.stringify(viewBody),
    session: { ...SIGNED_IN!, cookie: '__Host-civ-token' },
  },
  {
    name: 'old-token-does-not-roll-here',
    endpoint: 'pulse',
    headers: { ...basePulse, cookie: '__Secure-civ-token=hdr.payload.sig' },
    body: JSON.stringify(viewBody),
    session: { ...SIGNED_IN!, iat: 1_700_000_000 },
  },
  {
    name: 'referer-when-no-origin',
    endpoint: 'pulse',
    headers: {
      host: HOST,
      referer: REF,
      'content-type': 'application/json',
      'cf-connecting-ip': IP4,
    },
    body: JSON.stringify(viewBody),
  },
  {
    name: 'empty-origin',
    endpoint: 'pulse',
    headers: { ...basePulse, origin: '', referer: REF },
    body: JSON.stringify(viewBody),
  },
  {
    name: 'null-origin',
    endpoint: 'pulse',
    headers: { ...basePulse, origin: 'null' },
    body: JSON.stringify(viewBody),
  },
  {
    name: 'origin-mismatch',
    endpoint: 'pulse',
    headers: { ...basePulse, origin: 'https://evil.example.test' },
    body: JSON.stringify(viewBody),
  },
  {
    name: 'text-body',
    endpoint: 'pulse',
    headers: { host: HOST, origin: `https://${HOST}`, 'cf-connecting-ip': IP4 },
    body: JSON.stringify({ type: 'ModelView', entityType: 'Model', entityId: 7 }),
  },
  {
    name: 'text-invalid-json',
    endpoint: 'pulse',
    headers: { host: HOST, origin: `https://${HOST}`, 'cf-connecting-ip': IP4 },
    body: '{"type":',
  },
  { name: 'json-invalid', endpoint: 'pulse', headers: basePulse, body: '{"type":' },
  { name: 'json-empty', endpoint: 'pulse', headers: basePulse, body: '' },
  { name: 'json-null', endpoint: 'pulse', headers: basePulse, body: 'null' },
  {
    name: 'json-string-body',
    endpoint: 'pulse',
    headers: basePulse,
    body: JSON.stringify(JSON.stringify({ type: 'PostView', entityType: 'Post', entityId: 3 })),
  },
  {
    name: 'json-string-invalid',
    endpoint: 'pulse',
    headers: basePulse,
    body: JSON.stringify('{"type":'),
  },
  {
    name: 'invalid-type',
    endpoint: 'pulse',
    headers: basePulse,
    body: JSON.stringify({ ...viewBody, type: 'CommentView' }),
  },
  {
    name: 'entity-id-string',
    endpoint: 'pulse',
    headers: basePulse,
    body: JSON.stringify({ ...viewBody, entityId: '123' }),
  },
  {
    name: 'ads-invalid',
    endpoint: 'pulse',
    headers: basePulse,
    body: JSON.stringify({ ...viewBody, ads: 'Maybe' }),
  },
  {
    name: 'nsfw-null',
    endpoint: 'pulse',
    headers: basePulse,
    body: JSON.stringify({ ...viewBody, nsfw: null }),
  },
  {
    name: 'details-array',
    endpoint: 'pulse',
    headers: basePulse,
    body: JSON.stringify({ ...viewBody, details: [1] }),
  },
  {
    // Raw text, so the integer keys arrive AFTER the named ones: a JS object literal (as in
    // anon-basic) would already have reordered them, hiding a key-order bug.
    name: 'details-integer-keys-reordered',
    endpoint: 'pulse',
    headers: basePulse,
    body: '{"type":"ImageView","entityType":"Image","entityId":1,"details":{"b":1,"2":"x","1":true,"10":0,"01":2,"4294967295":3,"a":{"z":0,"0":1}}}',
  },
  {
    name: 'details-proto',
    endpoint: 'pulse',
    headers: basePulse,
    body: '{"type":"ImageView","entityType":"Image","entityId":1,"details":{"a":1,"__proto__":{"x":1},"n":{"__proto__":2}}}',
  },
  {
    name: 'only-required',
    endpoint: 'pulse',
    headers: basePulse,
    body: '{"browsingLevel":4,"entityId":9,"extra":"stripped","entityType":"User","type":"ProfileView"}',
  },
  {
    name: 'duplicate-keys-last-wins',
    endpoint: 'pulse',
    headers: basePulse,
    body: '{"type":"ImageView","entityType":"Image","entityId":1,"type":"PostView","entityType":"Post"}',
  },
  {
    name: 'big-numbers',
    endpoint: 'pulse',
    headers: basePulse,
    body: '{"type":"ImageView","entityType":"Image","entityId":9007199254740993,"nsfwLevel":1e-7,"browsingLevel":-0,"details":{"f":0.000001,"g":123456789012345680000,"h":1.5e300,"i":5e-324}}',
  },
  {
    name: 'entity-id-overflow',
    endpoint: 'pulse',
    headers: basePulse,
    body: '{"type":"ImageView","entityType":"Image","entityId":1e400}',
  },
  {
    name: 'details-too-long',
    endpoint: 'pulse',
    headers: basePulse,
    // {"s":"…"} is 8 characters plus the string: one past the limit.
    bodyTemplate: {
      prefix: '{"type":"ImageView","entityType":"Image","entityId":1,"details":{"s":"',
      repeat: 'x',
      count: 256 * 1024 - 7,
      suffix: '"}}',
    },
  },
  {
    name: 'details-at-limit',
    endpoint: 'pulse',
    headers: basePulse,
    bodyTemplate: {
      prefix: '{"type":"ImageView","entityType":"Image","entityId":1,"details":{"s":"',
      repeat: 'x',
      count: 256 * 1024 - 8,
      suffix: '"}}',
    },
  },
  {
    name: 'details-too-many-values',
    endpoint: 'pulse',
    headers: basePulse,
    // 131072 one-digit elements write 262145 characters ([0,0,…]) — already over on length, so
    // this pins the length arm with the most values a body this size can hold.
    bodyTemplate: {
      prefix: '{"type":"ImageView","entityType":"Image","entityId":1,"details":{"a":[0',
      repeat: ',0',
      count: 131071,
      suffix: ']}}',
    },
  },
  {
    name: 'no-user-agent',
    endpoint: 'pulse',
    headers: {
      host: HOST,
      origin: `https://${HOST}`,
      'content-type': 'application/json',
      'cf-connecting-ip': IP4,
    },
    body: JSON.stringify(viewBody),
  },
  {
    name: 'latin1-user-agent',
    endpoint: 'pulse',
    headers: { ...basePulse, 'user-agent': 'Caf\u00e9Browser/\u00ff "q" \\' },
    body: JSON.stringify(viewBody),
  },
  {
    name: 'form-body',
    endpoint: 'pulse',
    headers: { ...basePulse, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'type=ImageView&entityType=Image&entityId=1',
    fallback: 'form-body',
  },
  { name: 'array-body', endpoint: 'pulse', headers: basePulse, body: '[1,2]' },
  {
    name: 'fallback-bearer',
    endpoint: 'pulse',
    headers: { ...basePulse, authorization: 'Bearer some-api-key' },
    body: JSON.stringify(viewBody),
    fallback: 'bearer-token',
  },
  {
    name: 'bearer-on-a-400-is-answered',
    endpoint: 'pulse',
    headers: {
      ...basePulse,
      authorization: 'Bearer some-api-key',
      origin: 'https://evil.example.test',
    },
    body: JSON.stringify(viewBody),
  },
];

// ---- Reference vectors -------------------------------------------------------------------------
function vectors() {
  const numberStrings = [
    '',
    ' ',
    '0',
    '-0',
    '42',
    ' 42 ',
    '\u00a042\u3000',
    '\ufeff7',
    '1.',
    '.5',
    '-.5',
    '+1',
    '1e3',
    '1E-3',
    '1e',
    'e1',
    '0x1F',
    '0X1f',
    '0x',
    '-0x10',
    '0o17',
    '0b101',
    '0b2',
    '0x1_0',
    '1_000',
    'Infinity',
    '-Infinity',
    '+Infinity',
    'infinity',
    'NaN',
    '1e400',
    '-1e400',
    '1e-400',
    '9007199254740993',
    '0x20000000000001',
    '12abc',
    '1 2',
    '\u2028 3 \u2029',
  ];
  const numbers = [
    0,
    -0,
    1,
    -1,
    0.1,
    0.5,
    1.5,
    100,
    1e20,
    1e21,
    1.5e21,
    123456789012345680000,
    1e-6,
    1e-7,
    1.2345e-7,
    5e-324,
    1.7976931348623157e308,
    9007199254740992,
    0.000001234,
    4294967295,
    1 / 3,
    2 / 3,
    123.456,
    1e100,
    -1e-10,
  ];
  const urls = [
    'https://www.example.test/x',
    'http://www.example.test',
    'https://www.example.test:443/',
    'http://www.example.test:80',
    'http://www.example.test:443',
    'https://www.example.test:0443/',
    'https://www.example.test:/x',
    'https://www.example.test:8443',
    'https://www.example.test:65535',
    'https://www.example.test:65536',
    'https://www.example.test:8a',
    'HTTPS://WWW.EXAMPLE.TEST/A',
    'https://www.example.test.',
    'https://a_b.example.test',
    'https://-a-.example.test',
    'example',
    '1http://x',
    'h t://x',
    'https://',
    'https://:80/',
    'https://www.example.test?q',
    'https://www.example.test#f',
    'mailto:x@example.test',
    'https://user@www.example.test',
    'https://[2001:db8::1]/',
    'https://192.0.2.1/',
    'https://0x7f.1/',
    'https://1.2.3/',
    'https://xn--caf-dma.example.test',
    'https://café.example.test',
    'https://www.example.test\\x',
    'https:/www.example.test',
    'https:///www.example.test',
    'https:www.example.test',
    'https://a..b.example.test',
    'https://.example.test',
    'https://www.ex%41mple.test',
    'android-app://com.example.app/',
    'null',
    'https://www.example.test:00000000000080/',
  ];
  const ips = [
    '1.2.3.4',
    '01.2.3.4',
    '1.2.3',
    '256.1.1.1',
    '0.0.0.0',
    '::',
    '::1',
    '2001:db8::1',
    '2001:DB8::1',
    '::ffff:1.2.3.4',
    '1:2:3:4:5:6:7:8',
    '1:2:3:4:5:6:7:8:9',
    '1::2::3',
    'fe80::1%eth0',
    ' 1.2.3.4',
    'x',
    '',
    '1:2:3:4:5:6:1.2.3.4',
    '::1.2.3.4',
    '1::',
    'gggg::1',
    '0000:0000:0000:0000:0000:ffff:255.255.255.255',
  ];
  const requestIpCases: Headers[] = [
    { 'x-client-ip': '192.0.2.1' },
    { 'x-client-ip': 'junk', 'x-forwarded-for': '198.51.100.1, 192.0.2.2' },
    { 'x-forwarded-for': '198.51.100.1:443' },
    { 'x-forwarded-for': ' unknown ,198.51.100.3' },
    { 'x-forwarded-for': '', 'x-real-ip': '192.0.2.9' },
    { 'cf-connecting-ip': ' 192.0.2.5' },
    { 'fastly-client-ip': '192.0.2.6' },
    { 'true-client-ip': '192.0.2.7' },
    { 'x-cluster-client-ip': '192.0.2.8' },
    { 'x-forwarded': '192.0.2.10' },
    { 'forwarded-for': '192.0.2.11' },
    { forwarded: '192.0.2.12' },
    { 'x-appengine-user-ip': '192.0.2.13' },
    { 'x-real-ip': '192.0.2.300', 'x-appengine-user-ip': '192.0.2.14' },
    { 'cf-connecting-ip': '2001:db8::5', 'x-forwarded-for': '198.51.100.1' },
    { 'cf-connecting-ip': 'fe80::1%eth0', 'x-real-ip': '192.0.2.15' },
    { 'x-forwarded-for': 'junk' },
    {},
  ];
  const paths = [
    '/',
    '',
    '/models',
    '/models/1',
    '/models/1/slug',
    '/models/1/slug/extra',
    '/user/a',
    '/user/a/images',
    '/user/a/b',
    '/images',
    '/images/5',
    '/posts/1',
    '/posts/1/x',
    '/posts/1/edit',
    '/articles/1',
    '/content/x/y',
    '/unknown',
    '//double',
    '/models/',
    'models',
    '/bounties/1/entries/2',
    '/bounties/1/entries/2/edit',
    '/user/account/x/y',
    '/comics/1',
    '/search/models',
    '/tag/x',
    '/collections/1/review',
  ];
  const utf8 = [
    '',
    '61',
    'c328',
    'e282',
    'e282ac',
    'f09f98',
    'f09f9880',
    'ed9fbf',
    'eda080',
    'c0af',
    'f4908080',
    'ff',
    '80',
    'e0a080',
    'e080',
    'f0808080',
    'efbbbf61',
  ];
  const json = [
    '{"b":1,"a":2,"1":3,"0":4,"01":5,"4294967294":6,"4294967295":7,"-1":8}',
    '{"a":1,"a":2,"b":3}',
    '[1.0,1e2,-0,0.1,1E21,1e-7,123456789012345678901234567890]',
    '"\\ud83d\\ude00\\ud800x\\udc00\\u0000\\u001f\\u007f\\u2028\\/"',
    '{"__proto__":1,"x":{"__proto__":[]}}',
    ' \t\n\r{"a" : [ true , false , null ] } ',
    '"<script>&amp;</script>"',
  ];
  const jsonInvalid = [
    '',
    '{',
    '[1,]',
    '{"a":1,}',
    '01',
    '1.',
    '.5',
    '+1',
    '"\t"',
    "'a'",
    'tru',
    'nul',
    '\ufeff{}',
    '{"a"}',
    '[1] x',
    'NaN',
    '"\\x"',
    '"\\u12"',
  ];
  const trims = [
    '  a  ',
    '\u00a0a\u00a0',
    '\ufeffa',
    '\u2028a\u2029',
    '\u200ba',
    '\u0085a',
    '\u180ea',
    '\u3000a',
    '\t\v\f\r\na',
  ];
  const toHexUnits = (s: string) =>
    Array.from({ length: s.length }, (_, i) => s.charCodeAt(i).toString(16).padStart(4, '0')).join(
      ' '
    );
  return {
    numberStrings: numberStrings.map((s) => ({ in: s, out: String(Number(s)) })),
    numbers: numbers.map((n) => ({ in: n, out: String(n), json: JSON.stringify(n) })),
    urls: urls.map((u) => {
      try {
        return { in: u, host: new URL(u).host, throws: false };
      } catch {
        return { in: u, host: '', throws: true };
      }
    }),
    isIP: ips.map((s) => ({ in: s, out: isIP(s) })),
    clientIp: requestIpCases.map((h) => ({
      headers: h,
      out: resolveClientIp({ headers: h, socket: {} } as any),
    })),
    pathnames: paths.map((p) => ({ in: p, out: getMatchingPathname(p) })),
    utf8: utf8.map((h) => ({ in: h, units: toHexUnits(Buffer.from(h, 'hex').toString('utf8')) })),
    jsonRoundTrip: json.map((s) => ({ in: s, out: JSON.stringify(JSON.parse(s)) })),
    jsonInvalid: jsonInvalid.map((s) => {
      try {
        JSON.parse(s);
        return { in: s, throws: false };
      } catch {
        return { in: s, throws: true };
      }
    }),
    trims: trims.map((s) => ({ in: s, units: toHexUnits(s.trim()) })),
  };
}

async function main() {
  const next = await nextModules();
  for (const dir of ['ping', 'pulse']) {
    rmSync(join(HERE, dir), { recursive: true, force: true });
    mkdirSync(join(HERE, dir), { recursive: true });
  }
  const seen = new Set<string>();
  for (const fx of fixtures) {
    const key = `${fx.endpoint}/${fx.name}`;
    if (seen.has(key)) throw new Error(`duplicate fixture ${key}`);
    seen.add(key);
    const { expect, shadow } = await outcome(fx, next);
    const file = {
      name: fx.name,
      endpoint: fx.endpoint,
      request: {
        method: fx.method ?? 'POST',
        target: fx.target ?? `/api/internal/${fx.endpoint}`,
        headers: fx.headers,
        ...(fx.bodyTemplate
          ? { bodyTemplate: fx.bodyTemplate }
          : fx.bodyHex !== undefined
          ? { bodyHex: fx.bodyHex }
          : { body: fx.body ?? '' }),
      },
      session: fx.session ?? null,
      trackerEnabled: fx.trackerEnabled ?? true,
      fallback: fx.fallback ?? '',
      // A templated (long) body's rows are pinned by digest rather than spelled out.
      expect: fx.bodyTemplate
        ? {
            ...expect,
            writes: expect.writes.map((w) => ({
              table: w.table,
              sha256: createHash('sha256').update(w.body).digest('hex'),
              length: Buffer.byteLength(w.body),
            })),
          }
        : expect,
      shadow: fx.bodyTemplate ? '' : shadow ?? '',
    };
    writeFileSync(join(HERE, fx.endpoint, `${fx.name}.json`), JSON.stringify(file, null, 2) + '\n');
  }
  writeFileSync(join(HERE, 'vectors.json'), JSON.stringify(vectors(), null, 2) + '\n');
  const counts = ['ping', 'pulse'].map((d) => `${d}: ${readdirSync(join(HERE, d)).length}`);
  console.log(`wrote ${counts.join(', ')} fixtures and vectors.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
