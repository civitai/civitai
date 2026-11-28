// Generates the golden fixtures (testdata/golden/{ping,pulse,track-batch}/*.json) and the reference vectors
// (testdata/golden/vectors.json) beacon-go's tests read. Run from the repo root:
//
//   pnpm exec tsx --tsconfig tsconfig.json apps/beacon-go/testdata/golden/gen.ts
//
// Everything here is SYNTHETIC: hosts under example.test, documentation addresses (RFC 5737 /
// RFC 3849), invented user ids (1001..). No production data.
//
// Where an expected value comes from: the REAL Node code wherever it imports cleanly —
// pageViewBeaconSchema / addViewSchema / parseTrackBatch (src/server/schema/track.schema.ts), the
// constants the track-batch action arms import, getMatchingPathname
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
import * as z from 'zod';
import { getMatchingPathname } from '~/shared/constants/pathname.constants';
import {
  addViewSchema,
  IMPRESSION_ENTITIES_MAX,
  IMPRESSION_ENTITY_TYPES,
  IMPRESSION_SURFACES,
  pageViewBeaconSchema,
  parseTrackBatch,
  PUSH_PROMPT_ACTIONS,
  PUSH_PROMPT_SURFACES,
  PUSH_PROMPT_VARIANTS,
  TRACK_BATCH_MAX,
  TRACK_FREEFORM_MAX_CHARS,
  trackActionSchema,
  trackFeedSchema,
  trackImpressionSchema,
  trackSearchSchema,
} from '~/server/schema/track.schema';
import {
  FEED_EVENT_FEEDS,
  FEED_EVENT_INDEX_MAX,
  FEED_EVENT_TYPES,
} from '~/shared/constants/feed-events.constants';
import { hashToUnit } from '~/server/clickhouse/sampled-row-buffer';
import { trackedReasons } from '~/utils/login-helpers';
import { USER_MENU_ITEM_IDS } from '~/shared/constants/user-menu.constants';
import {
  USER_MENU_GROUP_IDS,
  USER_MENU_HEADER_GROUP,
} from '~/shared/constants/user-menu-groups.constants';
import {
  EXPERIMENT_SURFACES,
  HAT_TURF_CLIENT_ACTIONS,
  HAT_TURF_EVENTS,
} from '~/shared/constants/experiments.constants';
import {
  APP_STORE_ACTIONS,
  APP_STORE_LISTING_ID_RE,
  APP_STORE_POSITION_MAX,
  APP_STORE_QUERY_LENGTH_BUCKETS,
  APP_SURFACES,
} from '~/shared/utils/app-store-telemetry';
import { listingSortSchema } from '~/server/schema/blocks/app-listing-read.schema';
import { MARKETPLACE_CATEGORIES } from '~/server/services/blocks/marketplace-categories.constants';
import {
  APP_ERROR_STAGES,
  APP_SESSION_HOSTS,
  APP_SESSION_MAX_COUNT,
  APP_SESSION_MAX_DURATION_MS,
  APP_SUBMIT_FAILURE_REASONS,
  APP_TELEMETRY_APP_BLOCK_ID_RE,
} from '~/shared/constants/app-telemetry.constants';
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
type Endpoint = 'ping' | 'pulse' | 'track-batch';
const ENDPOINTS: Endpoint[] = ['ping', 'pulse', 'track-batch'];
// Each endpoint's route (beacon-go internal/server Routes).
const ROUTES: Record<Endpoint, string> = {
  ping: '/api/internal/ping',
  pulse: '/api/internal/pulse',
  'track-batch': '/api/track/batch',
};
type Fixture = {
  name: string;
  endpoint: Endpoint;
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
  /** track-batch: the optional sinks beacon-go answers (default both on). */
  sinks?: { impressions: boolean; feed: boolean };
  /** track-batch: the feed events sample rate (default 0); null is no reading on the beacon-go side. */
  feedSampleRate?: number | null;
  /** The clock, epoch ms (default GOLDEN_NOW_MS). */
  now?: number;
  /** track-batch: the entities wearing a hat (`Type:id`), for the event-points window fixtures. */
  hats?: string[];
};

// beacon-go's golden clock (internal/golden GoldenNow): an hour after SIGNED_IN.iat.
const GOLDEN_NOW_MS = (1_780_000_000 + 3600) * 1000;
const SINKS_OFF = { impressions: false, feed: false };

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
  // track(): `{...actorMeta, ...custom}`, actorMeta `{ userId }` alone under skipActorMeta.
  private track(table: string, custom: object, skipActorMeta = false) {
    if (!this.enabled) return false;
    this.resolve();
    const actorMeta = skipActorMeta ? { userId: this.actor.userId } : { ...this.actor };
    this.writes.push({ table, body: JSON.stringify({ ...actorMeta, ...custom }) });
    return true;
  }
  // Tracker.search.
  async search(values: { query: string; index: string; filters?: any }) {
    const { filters, ...rest } = values;
    return this.track('search', {
      ...rest,
      filters:
        filters != null ? (typeof filters === 'string' ? filters : JSON.stringify(filters)) : '',
    });
  }
  // Tracker.action.
  async action(values: { type: string; details?: any }) {
    const { details, ...rest } = values;
    return this.track(
      'actions',
      {
        ...rest,
        details:
          details != null ? (typeof details === 'string' ? details : JSON.stringify(details)) : '',
      },
      ACTOR_META_FREE_ACTION_TYPES.has(values.type)
    );
  }
  // Tracker.impressions: trackMany with skipActorMeta, one row per entity (`{userId, ...custom}`),
  // inserted into ClickHouse directly (sendMany, which the sampler sees through onSend too). Not gated
  // on the tracker: sendMany only needs the ClickHouse client, which every fixture has.
  async impressions(values: {
    sessionKey: string;
    surface: string;
    entities: { entityType: string; entityId: number }[];
  }) {
    this.resolve();
    const { sessionKey, surface, entities } = values;
    for (const { entityType, entityId } of entities)
      this.writes.push({
        table: 'impressions',
        body: JSON.stringify({
          userId: this.actor.userId,
          ...{ entityType, entityId, sessionKey, surface },
        }),
      });
  }
}

// The scored events (src/server/events with `scoring`) and their eventPointsWindow, in epoch ms:
// `previewFrom ?? startDate` to `endDate + scoring.finalizeAfterMs`. Transcribed (the registry does
// not import outside the app); beacon-go-track-batch-vectors.test.ts pins it against the live events.
const SCORED_EVENTS = [
  {
    name: 'birthday2026',
    from: Date.parse('2026-10-09T00:00:00.000Z'),
    to: Date.parse('2026-12-01T00:00:00.000Z') + 24 * 60 * 60 * 1000,
  },
];
// hooks.ts POINT_ENTITY_TYPES (pinned in src/server/events/points/__tests__/hooks.test.ts).
const POINT_ENTITY_TYPES = ['Image', 'Model', 'Article'];
// feed-events.service.ts FEED_EVENTS_SAMPLE_RATE_FLAG and parseSampleRate (pinned in
// beacon-go-track-batch-vectors.test.ts against the live module, which does not import here).
const FEED_EVENTS_SAMPLE_RATE_FLAG = 'feed-events-sample-rate';
function parseSampleRate(variantKey: string | undefined): number {
  const rate = Number(variantKey);
  return Number.isFinite(rate) && rate > 0 ? Math.min(rate, 1) : 0;
}
// The engine holds an event while its window is open (the engine's loaded events): only then can
// hattedImpressionEntities return anything. The kill switch reads on here.
const scoredWindowOpen = (now: number) => SCORED_EVENTS.some((e) => now >= e.from && now <= e.to);

// tracker.ts ACTOR_META_FREE_ACTION_TYPES (pinned against the exported set by
// src/server/beacon/__tests__/beacon-go-track-batch-vectors.test.ts through vectors.json).
const ACTOR_META_FREE_ACTION_TYPES: ReadonlySet<string> = new Set([
  'Experiment_Exposure',
  'HatTurf_Action',
  'AppStore_Action',
  'App_Error',
  'App_Session',
]);

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

// src/pages/api/track/batch.ts (isDev false) for the parts the fixtures reach: feed events go to the
// feed events recorder and hatted impressions to the event points, neither of which is a tracker row
// (beacon-go falls back on both kinds, so their fixtures pin only the fallback reason).
// What the feed events recorder and the event-points hook did for a track-batch fixture.
type BatchSide = { feedRecorded: number; hattedViews: number };

async function trackBatch(
  req: any,
  res: MiniRes,
  tracker: MirrorTracker,
  fx: Fixture,
  side: BatchSide
) {
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
  const events = parseTrackBatch(parsed);
  if (!events) return res.status(400).send('invalid input');
  const rate = fx.feedSampleRate ?? 0;
  for (const event of events) {
    if (event.kind === 'search') await tracker.search(event.data);
    else if (event.kind === 'action') await tracker.action(event.data);
    else if (event.kind === 'impression') await tracker.impressions(event.data);
    // The recorder's keeps(sessionKey) (createSampledRowBuffer, the real hashToUnit): a kept session
    // records a row, which beacon-go never writes, so such a fixture must declare its fallback. The
    // row itself (viewer, page label, buffer time) is not reproduced here.
    else if (rate > 0 && hashToUnit(event.data.sessionKey) < rate) side.feedRecorded++;
  }
  // hattedImpressionEntities: the distinct hatted Image / Model / Article entities, while an event is
  // loaded (at most MAX_HATTED_VIEWS_PER_BATCH, which no fixture reaches).
  if (scoredWindowOpen(fx.now ?? GOLDEN_NOW_MS)) {
    const hats = new Set(fx.hats ?? []);
    const seen = new Set<string>();
    for (const event of events) {
      if (event.kind !== 'impression') continue;
      for (const { entityType, entityId } of event.data.entities) {
        const key = `${entityType}:${entityId}`;
        if (!POINT_ENTITY_TYPES.includes(entityType) || !hats.has(key) || seen.has(key)) continue;
        seen.add(key);
      }
    }
    side.hattedViews = seen.size;
  }
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
  req.url = fx.target ?? ROUTES[fx.endpoint];
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
  const side: BatchSide = { feedRecorded: 0, hattedViews: 0 };
  if (fx.endpoint === 'track-batch') await trackBatch(req, res, tracker, fx, side);
  else await { ping, pulse }[fx.endpoint](req, res, tracker);
  if ((side.feedRecorded > 0 || side.hattedViews > 0) && !fx.fallback)
    throw new Error(
      `${fx.name}: Node records a feed row or awards view points; declare the fallback`
    );
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
    hattedViews: side.hattedViews,
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
  // ---- track-batch ----
  ...trackBatchFixtures(),
];

// ---- track-batch fixtures ------------------------------------------------------------------------
// The browser's trackEventBuffer flushes `[{kind, data}, ...]` with Content-Type application/json
// (sendBeacon's Blob and the keepalive fetch both set it).
function trackBatchFixtures(): Fixture[] {
  const baseBatch = {
    host: HOST,
    origin: `https://${HOST}`,
    'content-type': 'application/json',
    'user-agent': UA,
    'cf-connecting-ip': IP4,
  };
  const batch = (events: unknown[]) => JSON.stringify(events);
  const search = (data: object) => ({ kind: 'search', data });
  const action = (data: object) => ({ kind: 'action', data });
  const impression = {
    kind: 'impression',
    data: { sessionKey: 'k1', surface: 'images', entities: [{ entityType: 'Image', entityId: 5 }] },
  };
  const feed = {
    kind: 'feed',
    data: { event: 'load', sessionKey: 'k1', feed: 'images', page: '/images' },
  };
  const fx = (name: string, body: string, extra: Partial<Fixture> = {}): Fixture => ({
    name,
    endpoint: 'track-batch',
    headers: baseBatch,
    body,
    ...extra,
  });
  const one = (name: string, data: object, extra: Partial<Fixture> = {}) =>
    fx(name, batch([action(data)]), extra);
  return [
    // -- search
    fx(
      'search-filters',
      batch([
        search({
          query: '  cat  ',
          index: 'models_v9',
          filters: { '2': 'b', sort: 'Newest', nested: { z: [1, 2.5, 1e21] }, '1': true },
          extra: 'stripped',
        }),
      ])
    ),
    fx('search-no-filters', batch([search({ query: 'dog', index: 'images_v6' })])),
    fx(
      'search-proto-key',
      '[{"kind":"search","data":{"query":"q","index":"i","filters":{"__proto__":{"x":1},"k":2}}}]'
    ),
    fx('search-unicode', batch([search({ query: ' café 😀　', index: 'i' })])),
    fx('search-signed-in', batch([search({ query: 'x', index: 'i' })]), {
      headers: { ...baseBatch, cookie: '_ga=GA1.1; __Secure-civ-token=hdr.payload.sig' },
      session: SIGNED_IN,
    }),
    // -- action, every arm
    one('action-bare-strips-details', { type: 'AddToBounty_Click', details: { a: 1 } }),
    one('action-add-to-bounty-confirm', { type: 'AddToBounty_Confirm' }),
    one('action-award-bounty-click', { type: 'AwardBounty_Click' }),
    one('action-award-bounty-confirm', { type: 'AwardBounty_Confirm' }),
    one('action-tip-click-nullish', {
      type: 'Tip_Click',
      details: { entityType: null, toUserId: 3, extra: 1 },
    }),
    one('action-tip-click-no-details', { type: 'Tip_Click' }),
    one('action-tip-confirm', {
      type: 'Tip_Confirm',
      details: { amount: 50, toUserId: 3, entityId: 7, entityType: 'Image' },
    }),
    one('action-tip-interactive-click', {
      type: 'TipInteractive_Click',
      details: { toUserId: 3, entityId: 7, entityType: 'Image', amount: 5 },
    }),
    one('action-tip-interactive-cancel', {
      type: 'TipInteractive_Cancel',
      details: { toUserId: 3, entityId: 7, entityType: 'Model', amount: 0 },
    }),
    one('action-not-enough-funds', { type: 'NotEnoughFunds', details: { amount: 1.5 } }),
    one('action-purchase-cancel', { type: 'PurchaseFunds_Cancel', details: { step: 2 } }),
    one('action-purchase-confirm', {
      type: 'PurchaseFunds_Confirm',
      details: { method: 'card', unitAmount: 999, buzzAmount: 10000 },
    }),
    one('action-login-redirect-reason', {
      type: 'LoginRedirect',
      reason: 'image-gen',
      details: { a: 1 },
    }),
    one('action-membership-cancel-passthrough', {
      type: 'Membership_Cancel',
      details: { z: 1, from: 'gold', '5': 2, reason: 'price', extra: { deep: [true] } },
    }),
    fx(
      'action-membership-cancel-proto',
      '[{"kind":"action","data":{"type":"Membership_Cancel","details":{"__proto__":{"a":1},"reason":"r","from":"f"}}}]'
    ),
    one('action-membership-downgrade', {
      type: 'Membership_Downgrade',
      details: { reason: 'r', to: 'bronze', note: 'kept' },
    }),
    one('action-csam-help', { type: 'CSAM_Help_Triggered', details: { query: 'q', surface: 's' } }),
    one('action-profanity-loose', {
      type: 'ProfanitySearch',
      details: { matches: ['a', 'b'], q: 1, query: 'x' },
    }),
    one('action-model-create-click', {
      type: 'Model_Create_Click',
      details: { source: 'create:navbar', modelId: 1 },
    }),
    one('action-image-remix', {
      type: 'Image_Remix_Click',
      details: {
        remixKind: 'video',
        imageId: 9,
        sourceModelVersionId: null,
        imageType: 'video',
        source: 'remix:image',
      },
    }),
    one('action-generator-submit', {
      type: 'Generator_Submit',
      details: {
        externalId: 'abc_DEF-123',
        fromAction: 'remix',
        modelVersionId: 77,
        formVersion: 'form-graph',
        isValid: true,
        isRateLimited: false,
        hasRemixOfId: true,
        prompt: 'stripped',
      },
    }),
    one('action-feed-tagbar-trim', {
      type: 'Feed_TagBar_Click',
      details: { feed: 'images', tag: '  Anime  ', tagId: null, action: 'select' },
    }),
    one('action-feed-tagbar-all', {
      type: 'Feed_TagBar_Click',
      details: { feed: 'videos', tag: null, tagId: null, action: 'clear' },
    }),
    one('action-announcement-click', {
      type: 'Announcement_Click',
      details: { creatorId: 2, announcementId: 9007199254740991 },
    }),
    one('action-apps-build', {
      type: 'AppsBuild_Action',
      details: { state: 'pitch', action: 'agent_prompt_copy' },
    }),
    one('action-user-menu-null-group', {
      type: 'UserMenu_Click',
      details: { item: 'vault', group: null, pinned: false, surface: 'desktop' },
    }),
    one('action-user-menu-header', {
      type: 'UserMenu_Click',
      details: { item: 'profile', group: 'header', pinned: true, surface: 'mobile' },
    }),
    one('action-push-prompt', {
      type: 'Push_Prompt',
      details: { action: 'granted', surface: 'deal-flow', variant: 'finish', platform: 'mobile' },
    }),
    one('action-hat-turf-no-actor-meta', {
      type: 'HatTurf_Action',
      details: { action: 'invite_view', event: 'birthday2026', surface: 'feed-card' },
    }),
    one('action-app-store-no-actor-meta', {
      type: 'AppStore_Action',
      details: {
        queryLength: '4-10',
        hasQuery: true,
        category: 'games',
        sort: 'newest',
        position: 10000,
        surface: 'store_card',
        listingId: 'lst_01-ABC',
        action: 'impression',
      },
    }),
    one('action-app-error', {
      type: 'App_Error',
      details: { stage: 'submit', reason: 'rate_limited', appBlockId: 'apb_01HXYZ' },
    }),
    one('action-app-session', {
      type: 'App_Session',
      details: {
        appBlockId: 'apb_1',
        host: 'iframe',
        durationMs: 86400000,
        submits: 0,
        messagesToHost: 1000000,
      },
    }),
    one(
      'action-signed-in',
      { type: 'Tip_Click' },
      {
        headers: { ...baseBatch, cookie: '__Secure-civ-token=hdr.payload.sig' },
        session: SIGNED_IN,
      }
    ),
    one(
      'action-signed-in-no-actor-meta',
      {
        type: 'App_Error',
        details: { appBlockId: 'a', reason: 'other', stage: 'training_submit' },
      },
      {
        headers: { ...baseBatch, cookie: '__Secure-civ-token=hdr.payload.sig' },
        session: SIGNED_IN,
      }
    ),
    // -- batches
    fx(
      'mixed-order',
      batch([
        search({ query: 'a', index: 'i' }),
        action({ type: 'AwardBounty_Click' }),
        search({ query: 'b', index: 'j', filters: {} }),
      ])
    ),
    fx(
      'max-events',
      batch(
        Array.from({ length: 100 }, (_, i) =>
          action({ type: 'NotEnoughFunds', details: { amount: i } })
        )
      )
    ),
    fx('text-body', batch([search({ query: 'q', index: 'i' })]), {
      headers: { host: HOST, origin: `https://${HOST}`, 'user-agent': UA, 'cf-connecting-ip': IP4 },
    }),
    fx('json-string-body', JSON.stringify(batch([search({ query: 'q', index: 'i' })]))),
    fx('referer-only', batch([search({ query: 'q', index: 'i' })]), {
      headers: {
        host: HOST,
        referer: REF,
        'content-type': 'application/json',
        'cf-connecting-ip': IP4,
      },
    }),
    fx('tracker-disabled', batch([search({ query: 'q', index: 'i' })]), { trackerEnabled: false }),
    fx('no-user-agent', batch([search({ query: 'q', index: 'i' })]), {
      headers: {
        host: HOST,
        origin: `https://${HOST}`,
        'content-type': 'application/json',
        'x-forwarded-for': IP4,
      },
    }),
    // -- 400s
    fx('no-origin', batch([search({ query: 'q', index: 'i' })]), {
      headers: { host: HOST, 'content-type': 'application/json', 'cf-connecting-ip': IP4 },
    }),
    fx('cross-origin', batch([search({ query: 'q', index: 'i' })]), {
      headers: { ...baseBatch, origin: 'https://evil.example.test' },
    }),
    fx('empty-origin-wins', batch([search({ query: 'q', index: 'i' })]), {
      headers: { ...baseBatch, origin: '', referer: REF },
    }),
    fx('invalid-text-body', '[{"kind":', {
      headers: { host: HOST, origin: `https://${HOST}`, 'cf-connecting-ip': IP4 },
    }),
    fx('invalid-json-body', '[{"kind":'),
    fx('not-an-array', JSON.stringify(search({ query: 'q', index: 'i' }))),
    fx('empty-array', '[]'),
    fx('null-body', 'null'),
    fx('empty-json-body', ''),
    fx(
      'over-max-events',
      batch(Array.from({ length: 101 }, () => action({ type: 'AwardBounty_Click' })))
    ),
    // -- fallbacks (Node's answer is recorded; beacon-go hands the whole request back)
    // The sinks switched off (step 1's answer, and serve mode's default).
    fx('impression-only', batch([impression]), { fallback: 'track-impression', sinks: SINKS_OFF }),
    fx('impression-with-search', batch([search({ query: 'q', index: 'i' }), impression]), {
      fallback: 'track-impression',
      sinks: SINKS_OFF,
    }),
    fx('feed-event', batch([feed, action({ type: 'AwardBounty_Click' })]), {
      fallback: 'track-feed',
      sinks: SINKS_OFF,
    }),
    fx('impression-beats-feed', batch([feed, impression]), {
      fallback: 'track-impression',
      sinks: SINKS_OFF,
    }),
    fx('feed-sink-off-impressions-on', batch([impression, feed]), {
      fallback: 'track-feed',
      sinks: { impressions: true, feed: false },
    }),
    fx('impression-sink-off-feed-on', batch([feed, impression]), {
      fallback: 'track-impression',
      sinks: { impressions: false, feed: true },
    }),
    ...impressionAndFeedFixtures(fx, { search, action, impression, feed, baseBatch }),
    fx(
      'experiment-exposure',
      batch([
        action({
          type: 'Experiment_Exposure',
          details: { exp: 'x', variant: 'a', assignment: 'rule', surface: 'feed-card' },
        }),
      ]),
      { fallback: 'track-action-unported' }
    ),
    // Node drops the malformed event and writes the rest; beacon-go leaves the batch to Node.
    fx(
      'malformed-event-dropped',
      batch([
        search({ query: 'kept', index: 'i' }),
        action({ type: 'Tip_Click', details: { toUserId: 'three' } }),
        action({ type: 'AwardBounty_Click' }),
      ]),
      { fallback: 'track-event-invalid' }
    ),
    fx('unknown-kind', batch([{ kind: 'future', data: {} }, search({ query: 'q', index: 'i' })]), {
      fallback: 'track-event-invalid',
    }),
    fx('unknown-action-type', batch([action({ type: 'App_Open' })]), {
      fallback: 'track-event-invalid',
    }),
    fx('all-invalid', batch([1, 'x', null]), { fallback: 'track-event-invalid' }),
    fx(
      'unsafe-integer',
      batch([
        action({
          type: 'Announcement_Click',
          details: { announcementId: 9007199254740992, creatorId: 1 },
        }),
      ]),
      { fallback: 'track-event-invalid' }
    ),
    fx('filters-null', batch([search({ query: 'q', index: 'i', filters: null })]), {
      fallback: 'track-event-invalid',
    }),
    fx('bearer-token', batch([search({ query: 'q', index: 'i' })]), {
      headers: { ...baseBatch, authorization: 'Bearer some-api-key' },
      fallback: 'bearer-token',
    }),
    fx('query-string', batch([search({ query: 'q', index: 'i' })]), {
      target: '/api/track/batch?x=1',
      fallback: 'query-string',
    }),
  ];
}

// ---- impression and feed fixtures (both sinks on unless named) -------------------------------------
// The session keys' hashToUnit values, for the sampling cases: `k1` 0.5947, `tab-0` 0.1103.
function impressionAndFeedFixtures(
  fx: (name: string, body: string, extra?: Partial<Fixture>) => Fixture,
  k: {
    search: (d: object) => object;
    action: (d: object) => object;
    impression: object;
    feed: object;
    baseBatch: Headers;
  }
): Fixture[] {
  const batch = (events: unknown[]) => JSON.stringify(events);
  const imp = (data: object) => ({ kind: 'impression', data });
  const feedEv = (data: object) => ({
    kind: 'feed',
    data: { event: 'seen', sessionKey: 'k1', feed: 'images', page: '/images', ...data },
  });
  const ents = (...e: [string, number][]) =>
    e.map(([entityType, entityId]) => ({ entityType, entityId }));
  const signedIn = {
    headers: { ...k.baseBatch, cookie: '__Secure-civ-token=hdr.payload.sig' },
    session: SIGNED_IN,
  };
  // During birthday2026's points window, and just past it (its end plus a margin beacon-go keeps).
  const IN_WINDOW = Date.parse('2026-11-28T12:00:00.000Z');
  const WINDOW_END = Date.parse('2026-12-02T00:00:00.000Z');
  return [
    // -- impressions
    fx('impression-served', batch([k.impression])),
    fx(
      'impression-entities-in-order',
      batch([
        imp({
          surface: 'home',
          sessionKey: 'abc',
          entities: ents(['Post', 3], ['Image', 1], ['User', 9], ['Image', 1]),
        }),
      ])
    ),
    fx('impression-signed-in', batch([k.impression]), signedIn),
    fx(
      'impression-surface-caught',
      batch([
        imp({ sessionKey: 'k', surface: 'nope', entities: ents(['Model', 2]) }),
        imp({ sessionKey: 'k', entities: ents(['Model', 3]) }),
        imp({ sessionKey: 'k', surface: null, entities: ents(['Model', 4]) }),
      ])
    ),
    fx(
      'impression-strips-keys',
      batch([
        imp({
          extra: 1,
          sessionKey: 'k',
          surface: 'tag',
          entities: [{ entityId: 7, entityType: 'Collection', score: 0.5 }],
        }),
      ])
    ),
    fx(
      'impression-mixed-batch',
      batch([
        k.search({ query: 'a', index: 'i' }),
        imp({ sessionKey: 'k', surface: 'search', entities: ents(['Article', 4]) }),
        k.action({ type: 'AwardBounty_Click' }),
        imp({ sessionKey: 'k', surface: 'models', entities: ents(['Model', 5], ['Bounty', 6]) }),
      ])
    ),
    fx('impression-tracker-disabled', batch([k.search({ query: 'q', index: 'i' }), k.impression]), {
      trackerEnabled: false,
    }),
    fx(
      'impression-max-entities',
      batch([
        imp({
          sessionKey: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          surface: 'images',
          entities: Array.from({ length: 250 }, (_, i) => ({
            entityType: 'Image',
            entityId: i + 1,
          })),
        }),
      ])
    ),
    fx(
      'impression-unsafe-entity-id',
      batch([
        imp({ sessionKey: 'k', surface: 'images', entities: ents(['Image', 9007199254740991]) }),
      ])
    ),
    fx(
      'impression-over-max-entities',
      batch([
        imp({
          sessionKey: 'k',
          surface: 'images',
          entities: Array.from({ length: 251 }, (_, i) => ({
            entityType: 'Image',
            entityId: i + 1,
          })),
        }),
      ]),
      { fallback: 'track-event-invalid' }
    ),
    fx(
      'impression-entity-id-zero',
      batch([imp({ sessionKey: 'k', entities: ents(['Image', 0]) })]),
      {
        fallback: 'track-event-invalid',
      }
    ),
    fx(
      'impression-entity-type-unknown',
      batch([imp({ sessionKey: 'k', entities: ents(['Comic', 1]) })]),
      {
        fallback: 'track-event-invalid',
      }
    ),
    fx(
      'impression-session-key-empty',
      batch([imp({ sessionKey: '', entities: ents(['Image', 1]) })]),
      {
        fallback: 'track-event-invalid',
      }
    ),
    fx(
      'impression-session-key-too-long',
      batch([imp({ sessionKey: 'x'.repeat(33), entities: ents(['Image', 1]) })]),
      { fallback: 'track-event-invalid' }
    ),
    fx('impression-no-entities', batch([imp({ sessionKey: 'k', entities: [] })]), {
      fallback: 'track-event-invalid',
    }),
    // -- event points: an open window keeps any batch naming an Image, Model or Article on Node
    fx('event-points-window-hatted', batch([k.impression]), {
      now: IN_WINDOW,
      hats: ['Image:5'],
      fallback: 'track-impression-event-points',
    }),
    fx('event-points-window-unhatted', batch([k.impression]), {
      now: IN_WINDOW,
      fallback: 'track-impression-event-points',
    }),
    fx(
      'event-points-window-no-point-types',
      batch([imp({ sessionKey: 'k', surface: 'user', entities: ents(['Post', 1], ['User', 2]) })]),
      { now: IN_WINDOW, hats: ['Post:1'] }
    ),
    fx('event-points-within-margin', batch([k.impression]), {
      now: WINDOW_END + 30 * 60 * 1000,
      fallback: 'track-impression-event-points',
    }),
    fx('event-points-past-margin', batch([k.impression]), { now: WINDOW_END + 2 * 60 * 60 * 1000 }),
    fx('event-points-before-preview', batch([k.impression]), {
      now: Date.parse('2026-10-08T22:00:00.000Z'),
    }),
    // -- feed: answered only for sessions the recorder does not keep (they record nothing)
    fx('feed-rate-zero', batch([k.feed, k.action({ type: 'AwardBounty_Click' })])),
    fx(
      'feed-unsampled',
      batch([feedEv({ seenIds: [1, 2] }), k.search({ query: 'q', index: 'i' })]),
      {
        feedSampleRate: 0.25,
      }
    ),
    fx('feed-only-unsampled', batch([feedEv({}), feedEv({ event: 'load' })]), {
      feedSampleRate: 0.25,
      ...signedIn,
    }),
    fx(
      'feed-with-impression',
      batch([
        k.impression,
        feedEv({ event: 'click', entityType: 'Image', entityId: 5, position: 0 }),
      ]),
      {
        feedSampleRate: 0.25,
      }
    ),
    fx(
      'feed-sampled',
      batch([feedEv({ sessionKey: 'tab-0' }), k.search({ query: 'q', index: 'i' })]),
      {
        feedSampleRate: 0.25,
        fallback: 'track-feed-sampled',
      }
    ),
    fx('feed-rate-one', batch([feedEv({})]), { feedSampleRate: 1, fallback: 'track-feed-sampled' }),
    fx('feed-no-rate-reading', batch([feedEv({})]), {
      feedSampleRate: null,
      fallback: 'track-feed-sample-rate',
    }),
    fx(
      'feed-filters-proto',
      '[{"kind":"feed","data":{"event":"load","sessionKey":"k1","feed":"models","page":"/models","filters":{"__proto__":5,"period":"Week"}}}]'
    ),
    fx(
      'feed-every-field',
      batch([
        feedEv({
          event: 'click',
          feed: 'search',
          page: '/search/models',
          sort: 'Newest',
          pageIndex: 10000,
          filters: { index: 'models', junk: 'x' },
          entityType: 'Model',
          entityId: 2147483647,
          position: 0,
          seenIds: [],
          extra: true,
        }),
      ])
    ),
    fx('feed-invalid-event', batch([feedEv({ event: 'scroll' })]), {
      fallback: 'track-event-invalid',
    }),
    fx('feed-invalid-entity-id', batch([feedEv({ entityId: 2147483648 })]), {
      fallback: 'track-event-invalid',
    }),
    fx('feed-invalid-filter-value', batch([feedEv({ filters: { period: 1 } })]), {
      fallback: 'track-event-invalid',
    }),
    fx('feed-invalid-page-index', batch([feedEv({ pageIndex: 10001 })]), {
      fallback: 'track-event-invalid',
    }),
    fx(
      'feed-invalid-seen-ids',
      batch([feedEv({ seenIds: Array.from({ length: 251 }, (_, i) => i + 1) })]),
      {
        fallback: 'track-event-invalid',
      }
    ),
    // Ranking: no rate reading outranks an unported action; a sampled session outranks an invalid event.
    fx(
      'feed-sampled-beats-invalid',
      batch([
        feedEv({ sessionKey: 'tab-0' }),
        k.action({ type: 'Tip_Click', details: { toUserId: 'x' } }),
      ]),
      { feedSampleRate: 0.25, fallback: 'track-feed-sampled' }
    ),
    fx('event-points-beat-feed-rate', batch([feedEv({}), k.impression]), {
      now: IN_WINDOW,
      feedSampleRate: null,
      fallback: 'track-impression-event-points',
    }),
  ];
}

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
    trackBatch: trackBatchVectors(),
    trackBatchSinks: trackBatchSinkVectors(),
  };
}

// What beacon-go copies for the impression and feed sinks (internal/beacon/trackbatch_sinks.go,
// pinned by TestTrackBatchSinkConstants), and the zod schemas of every event kind it parses as JSON
// Schema (pinned field by field by TestTrackBatchSchemas), so a field added on the Node side fails a
// Go test instead of being silently stripped or refused.
function trackBatchSinkVectors() {
  const schema = (s: z.ZodType) => {
    const { $schema: _, ...rest } = z.toJSONSchema(s, {
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>;
    return rest;
  };
  const keys = [
    '',
    'a',
    'k1',
    'session-key-0123456789abcdef',
    'é',
    '😀',
    '\ud800',
    'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  ];
  const rates = ['', '0', '0.1', '1', '2', '-0.5', 'abc', '1e-3', ' 0.25 ', 'Infinity', '0x1'];
  return {
    impressionEntityTypes: [...IMPRESSION_ENTITY_TYPES],
    impressionSurfaces: [...IMPRESSION_SURFACES],
    impressionEntitiesMax: IMPRESSION_ENTITIES_MAX,
    feedEventTypes: [...FEED_EVENT_TYPES],
    feedEventFeeds: [...FEED_EVENT_FEEDS],
    feedEventIndexMax: FEED_EVENT_INDEX_MAX,
    pointEntityTypes: [...POINT_ENTITY_TYPES],
    scoredEvents: SCORED_EVENTS,
    feedEventsSampleRateFlag: FEED_EVENTS_SAMPLE_RATE_FLAG,
    hashToUnit: keys.map((k) => ({ in: k, out: hashToUnit(k) })),
    parseSampleRate: rates.map((r) => ({ in: r, out: parseSampleRate(r) })),
    schemas: {
      search: schema(trackSearchSchema),
      action: schema(trackActionSchema),
      impression: schema(trackImpressionSchema),
      feed: schema(trackFeedSchema),
    },
  };
}

// The constants beacon-go's track-batch action arms copy (internal/beacon/trackbatch_arms.go,
// pinned by TestTrackBatchConstants), the arm list, and the tracker's actor-meta-free types.
function trackBatchVectors() {
  const re = (r: RegExp) => {
    if (r.flags) throw new Error(`regex ${r} has flags beacon-go does not reproduce`);
    return r.source;
  };
  return {
    trackBatchMax: TRACK_BATCH_MAX,
    freeformMaxChars: TRACK_FREEFORM_MAX_CHARS,
    actionTypes: trackActionSchema.options.map((o) => o.shape.type.value).sort(),
    actorMetaFree: [...ACTOR_META_FREE_ACTION_TYPES].sort(),
    enums: {
      trackedReasons: [...trackedReasons],
      userMenuItemIds: [...USER_MENU_ITEM_IDS],
      userMenuGroupIds: [...USER_MENU_GROUP_IDS],
      userMenuHeaderGroup: [USER_MENU_HEADER_GROUP],
      pushPromptActions: [...PUSH_PROMPT_ACTIONS],
      pushPromptSurfaces: [...PUSH_PROMPT_SURFACES],
      pushPromptVariants: [...PUSH_PROMPT_VARIANTS],
      experimentSurfaces: [...EXPERIMENT_SURFACES],
      hatTurfClientActions: [...HAT_TURF_CLIENT_ACTIONS],
      hatTurfEvents: [...HAT_TURF_EVENTS],
      appStoreActions: [...APP_STORE_ACTIONS],
      appStoreQueryLengthBuckets: [...APP_STORE_QUERY_LENGTH_BUCKETS],
      appSurfaces: [...APP_SURFACES],
      listingSorts: [...listingSortSchema.options],
      marketplaceCategories: [...MARKETPLACE_CATEGORIES],
      appSubmitFailureReasons: [...APP_SUBMIT_FAILURE_REASONS],
      appErrorStages: [...APP_ERROR_STAGES],
      appSessionHosts: [...APP_SESSION_HOSTS],
    },
    patterns: {
      appStoreListingId: re(APP_STORE_LISTING_ID_RE),
      appBlockId: re(APP_TELEMETRY_APP_BLOCK_ID_RE),
    },
    numbers: {
      appStorePositionMax: APP_STORE_POSITION_MAX,
      appSessionMaxDurationMs: APP_SESSION_MAX_DURATION_MS,
      appSessionMaxCount: APP_SESSION_MAX_COUNT,
    },
  };
}

async function main() {
  const next = await nextModules();
  for (const dir of ENDPOINTS) {
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
        target: fx.target ?? ROUTES[fx.endpoint],
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
      ...(fx.endpoint === 'track-batch'
        ? {
            sinks: fx.sinks ?? { impressions: true, feed: true },
            feedSampleRate: fx.feedSampleRate === undefined ? 0 : fx.feedSampleRate,
            now: fx.now ?? GOLDEN_NOW_MS,
          }
        : {}),
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
  const counts = ENDPOINTS.map((d) => `${d}: ${readdirSync(join(HERE, d)).length}`);
  console.log(`wrote ${counts.join(', ')} fixtures and vectors.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
