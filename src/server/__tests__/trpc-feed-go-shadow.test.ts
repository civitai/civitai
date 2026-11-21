import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import superjson from 'superjson';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { instrumentationRegistry } from '@civitai/telemetry/client';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as FliptClient from '~/server/flipt/client';
import { createHash } from 'node:crypto';
import {
  TRAINING_DATA_LISTING_RULES_VERSION,
  trainingDataListingRulesId,
  trainingDataListingSql,
} from '~/server/services/training-data-restricted.service';
import {
  beginFeedGoShadowV1Models,
  captureFeedGoShadowRest,
  finishFeedGoShadow,
  FEED_GO_SHADOW_V1_MODELS_ID_PATH,
  FEED_GO_SHADOW_V1_MODELS_PATH,
  FEED_GO_TRAINING_DATA_SQL_HEADER,
  FEED_GO_PROBE_PATH,
  FEED_GO_SHADOW_INFINITE_PATH,
  FEED_GO_SHADOW_MODEL_GET_ALL_PATH,
  FEED_GO_SHADOW_PATH,
  resetFeedGoShadowForTests,
} from '~/server/trpc/feed-go-shadow';

/**
 * The feed-go shadow sampler wired end to end: the real route (`src/pages/api/trpc/[trpc].ts`,
 * its real adapter), the real server transformer from `~/server/trpc` (where the response is
 * captured), a router with a procedure at the real path, and a fake feed-go listening on
 * loopback. Only the app router, the context and the Flipt read are replaced.
 *
 * What it pins: a sampled request is mirrored to feed-go with the raw input, the forwarded
 * headers and the superjson envelope Node wrote; the user's response is identical with the
 * sampler on or off and never waits on feed-go; nothing is mirrored with the flag off or for
 * another procedure. And the Go-first probe (flag `feed-go-gofirst-probe`): it reaches feed-go
 * BEFORE the handler computes the page, and never runs with the sampler off.
 */

const PAYLOAD = {
  nextCursor: 99,
  items: [{ id: 1, createdAt: new Date('2026-01-02T03:04:05.000Z'), gone: undefined }],
};

const h = vi.hoisted(() => {
  process.env.TRPC_WRITE_DEVALUE = 'true';
  return { writeDevalue: false };
});
vi.mock('~/shared/utils/trpc-union-transformer', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get WRITE_DEVALUE() {
    return h.writeDevalue;
  },
}));
const flag = vi.hoisted(() => ({
  shadow: null as boolean | null,
  infinite: null as boolean | null,
  models: null as boolean | null,
  v1Models: null as boolean | null,
  probe: null as boolean | null,
}));
const handler = vi.hoisted(() => ({
  fail: false,
  infiniteBadRequest: false,
  modelsBadRequest: false,
  // When set, the procedure waits (up to 1s) for feed-go to have received a probe before it
  // computes, and records whether it had: the probe must not depend on the handler finishing.
  awaitProbe: false,
  probeSeen: undefined as boolean | undefined,
  probePath: '',
}));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    isFliptSync: (key: string, ...rest: [string?, Record<string, string>?]) =>
      key === 'feed-go-shadow'
        ? flag.shadow
        : key === 'feed-go-gofirst-probe'
        ? flag.probe
        : key === 'feed-go-shadow-infinite'
        ? flag.infinite
        : key === 'feed-go-shadow-model-getall'
        ? flag.models
        : key === 'feed-go-shadow-v1-models'
        ? flag.v1Models
        : actual.isFliptSync(key, ...rest),
  };
});
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/createContext', () => ({
  createContext: ({ req, res }: { req: NextApiRequest; res: NextApiResponse }) => ({
    req,
    res,
    user: undefined,
    acceptableOrigin: true,
    features: { canViewNsfw: false },
    tokenScope: TokenScope.Full,
    cache: { edgeTTL: 0, browserTTL: 0, staleWhileRevalidate: 0, canCache: false, skip: false },
  }),
}));
vi.mock('~/server/routers', async () => {
  const { router, publicProcedure } = await import('~/server/trpc');
  return {
    appRouter: router({
      image: router({
        getImagesAsPostsInfinite: publicProcedure.query(async () => {
          if (handler.awaitProbe) {
            const start = Date.now();
            const seen = () => feedGo.received.some((p) => p.path === handler.probePath);
            while (!seen() && Date.now() - start < 1000) await new Promise((r) => setTimeout(r, 5));
            handler.probeSeen = seen();
          }
          if (handler.fail) throw new Error('handler failed');
          return PAYLOAD;
        }),
        getInfinite: publicProcedure.query(async () => {
          if (handler.infiniteBadRequest) {
            const { TRPCError } = await import('@trpc/server');
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'bad cursor' });
          }
          return PAYLOAD;
        }),
      }),
      model: router({
        getAll: publicProcedure.query(async () => {
          if (handler.modelsBadRequest) {
            const { TRPCError } = await import('@trpc/server');
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid cursor' });
          }
          return PAYLOAD;
        }),
      }),
    }),
  };
});

type Received = {
  path: string;
  body: { input: string; headers: Record<string, string>; node?: unknown; startedAt?: number };
};

/** The fake feed-go: records each POST, answers `status`, optionally holding until released. */
const feedGo = {
  received: [] as Received[],
  status: 202,
  hold: undefined as Promise<void> | undefined,
  onReceived: undefined as (() => void) | undefined,
};

let app: http.Server | undefined;
let fake: http.Server | undefined;
let baseUrl = '';
let fakeBase = '';

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      feedGo.received.push({ path: req.url ?? '', body: JSON.parse(raw) });
      feedGo.onReceived?.();
      if (feedGo.hold) await feedGo.hold;
      res.statusCode = feedGo.status;
      res.end();
    });
  });
  await new Promise<void>((r) => fake!.listen(0, '127.0.0.1', r));
  fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  const route = (await import('~/pages/api/trpc/[trpc]')).default as NextApiHandler;
  app = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    (req as unknown as NextApiRequest).query = {
      ...Object.fromEntries(url.searchParams),
      trpc: decodeURIComponent(url.pathname.replace('/api/trpc/', '')),
    };
    void route(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  });
  await new Promise<void>((r) => app!.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (app) await new Promise((r) => app!.close(r));
  if (fake) await new Promise((r) => fake!.close(r));
  delete process.env.FEED_GO_SHADOW_URL;
  delete process.env.FEED_GO_SHADOW_SAMPLE_RATE;
  delete process.env.FEED_GO_SHADOW_TIMEOUT_MS;
  delete process.env.FEED_GO_SHADOW_MAX_IN_FLIGHT;
  delete process.env.FEED_GO_GOFIRST_PROBE_SAMPLE_RATE;
  resetFeedGoShadowForTests();
});

function configure(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetFeedGoShadowForTests();
}

beforeEach(() => {
  feedGo.received = [];
  feedGo.status = 202;
  feedGo.hold = undefined;
  feedGo.onReceived = undefined;
  flag.shadow = true;
  flag.probe = false;
  flag.infinite = false;
  flag.models = false;
  flag.v1Models = false;
  handler.fail = false;
  handler.awaitProbe = false;
  handler.probeSeen = undefined;
  handler.probePath = FEED_GO_PROBE_PATH;
  handler.infiniteBadRequest = false;
  handler.modelsBadRequest = false;
  h.writeDevalue = false;
  configure({
    FEED_GO_SHADOW_URL: fakeBase,
    FEED_GO_SHADOW_SAMPLE_RATE: '1',
    FEED_GO_SHADOW_TIMEOUT_MS: '2000',
    FEED_GO_SHADOW_MAX_IN_FLIGHT: undefined,
    FEED_GO_GOFIRST_PROBE_SAMPLE_RATE: undefined,
  });
});

const INPUT = JSON.stringify(superjson.serialize({ modelId: 7, limit: 50, cursor: undefined }));

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}/api/trpc/${path}?input=${encodeURIComponent(INPUT)}`, {
    headers,
  });
  return { status: res.status, text: await res.text() };
}

/** Resolves once feed-go has received `n` posts, or after `ms` (then the count is asserted). */
async function receivedWithin(n: number, ms = 1000) {
  const start = Date.now();
  while (feedGo.received.length < n && Date.now() - start < ms)
    await new Promise((r) => setTimeout(r, 10));
  return feedGo.received;
}

async function outcomeCounts(endpoint = 'as-posts'): Promise<Record<string, number>> {
  const metric = instrumentationRegistry.getSingleMetric(
    'civitai_app_feed_go_shadow_samples_total'
  );
  if (!metric) return {};
  const { values } = await metric.get();
  // This route's series only: the REST route's (feed_endpoint v1-images) are seeded at 0 too.
  return Object.fromEntries(
    values
      .filter((v) => v.labels.feed_endpoint === endpoint)
      .map((v) => [String(v.labels.outcome), v.value])
  );
}

const SUPERJSON_PAYLOAD = JSON.parse(JSON.stringify(superjson.serialize(PAYLOAD)));
const PROCEDURE = 'image.getImagesAsPostsInfinite';

describe('feed-go shadow, end to end', () => {
  it('mirrors a sampled request: raw input, forwarded headers, the envelope Node wrote', async () => {
    const served = await get(PROCEDURE, {
      cookie: '_ga=1; __Secure-civ-token=hdr.payload.sig; theme=dark',
      'cf-ipcountry': 'DE',
      'user-agent': 'Mozilla/5.0',
      authorization: 'Bearer some-api-key',
    });
    expect(served.status).toBe(200);
    expect(JSON.parse(served.text).result.data).toEqual(SUPERJSON_PAYLOAD);

    const [post] = await receivedWithin(1);
    expect(post.path).toBe(FEED_GO_SHADOW_PATH);
    expect(post.body.input).toBe(INPUT);
    expect(post.body.node).toEqual(SUPERJSON_PAYLOAD);
    expect(post.body.headers).toEqual({
      host: new URL(baseUrl).host,
      cookie: '__Secure-civ-token=hdr.payload.sig',
      'cf-ipcountry': 'DE',
      authorization: 'present',
    });
    expect(JSON.stringify(post.body)).not.toContain('some-api-key');
    expect(feedGo.received).toHaveLength(1);
  });

  it('the user response is byte-identical with the sampler off', async () => {
    const on = await get(PROCEDURE);
    await receivedWithin(1);
    flag.shadow = false;
    resetFeedGoShadowForTests();
    const off = await get(PROCEDURE);
    expect(off).toEqual(on);
  });

  it('flag off: nothing is mirrored (the case above proves the same request IS when on)', async () => {
    flag.shadow = false;
    resetFeedGoShadowForTests();
    expect((await get(PROCEDURE)).status).toBe(200);
    expect(await receivedWithin(1, 200)).toHaveLength(0);
  });

  it('no FEED_GO_SHADOW_URL: nothing is mirrored', async () => {
    configure({ FEED_GO_SHADOW_URL: undefined });
    expect((await get(PROCEDURE)).status).toBe(200);
    expect(await receivedWithin(1, 200)).toHaveLength(0);
  });

  it('another procedure is never mirrored', async () => {
    expect((await get('image.getInfinite')).status).toBe(200);
    expect(await receivedWithin(1, 200)).toHaveLength(0);
  });

  it('a devalue response is mirrored as the superjson envelope of the same payload', async () => {
    h.writeDevalue = true;
    const served = await get(PROCEDURE, { 'x-client': 'web', 'x-client-version': '5.0.2081' });
    // Positive control: the user really got devalue (a string payload, not `{ json }`).
    expect(typeof JSON.parse(served.text).result.data).toBe('string');
    const [post] = await receivedWithin(1);
    expect(post.body.node).toEqual(SUPERJSON_PAYLOAD);
  });

  it('the user response never waits on feed-go', async () => {
    let release!: () => void;
    feedGo.hold = new Promise<void>((r) => (release = r));
    const before = await outcomeCounts();
    const served = await get(PROCEDURE);
    // The user has the full response while feed-go has not answered (it may not even have
    // received the POST yet: the send is queued after the response).
    expect(served.status).toBe(200);
    await receivedWithin(1);
    expect((await outcomeCounts()).sent ?? 0).toBe(before.sent ?? 0);
    release();
    const start = Date.now();
    while (((await outcomeCounts()).sent ?? 0) === (before.sent ?? 0) && Date.now() - start < 1000)
      await new Promise((r) => setTimeout(r, 10));
    expect((await outcomeCounts()).sent).toBe((before.sent ?? 0) + 1);
  });

  it('feed-go answering 500 is counted as rejected, the user still gets 200', async () => {
    feedGo.status = 500;
    const before = await outcomeCounts();
    expect((await get(PROCEDURE)).status).toBe(200);
    await receivedWithin(1);
    const start = Date.now();
    while (
      ((await outcomeCounts()).rejected ?? 0) === (before.rejected ?? 0) &&
      Date.now() - start < 1000
    )
      await new Promise((r) => setTimeout(r, 10));
    expect((await outcomeCounts()).rejected).toBe((before.rejected ?? 0) + 1);
  });

  it('a failing handler frees its in-flight slot through the route (the next request is sampled)', async () => {
    // One slot: if the route did not finish the failed request's sample, the next one would be
    // dropped as overload and never reach feed-go.
    configure({ FEED_GO_SHADOW_MAX_IN_FLIGHT: '1' });
    const before = await outcomeCounts();
    handler.fail = true;
    expect((await get(PROCEDURE)).status).not.toBe(200);
    const start = Date.now();
    while (
      ((await outcomeCounts()).skipped_status ?? 0) === (before.skipped_status ?? 0) &&
      Date.now() - start < 1000
    )
      await new Promise((r) => setTimeout(r, 10));
    expect((await outcomeCounts()).skipped_status).toBe((before.skipped_status ?? 0) + 1);
    handler.fail = false;
    expect((await get(PROCEDURE)).status).toBe(200);
    expect(await receivedWithin(1)).toHaveLength(1);
    expect((await outcomeCounts()).dropped_overload ?? 0).toBe(before.dropped_overload ?? 0);
  });

  it('feed-go timing out is counted as timeout', async () => {
    configure({ FEED_GO_SHADOW_TIMEOUT_MS: '50' });
    let release!: () => void;
    feedGo.hold = new Promise<void>((r) => (release = r));
    const before = await outcomeCounts();
    expect((await get(PROCEDURE)).status).toBe(200);
    const start = Date.now();
    while (
      ((await outcomeCounts()).timeout ?? 0) === (before.timeout ?? 0) &&
      Date.now() - start < 1000
    )
      await new Promise((r) => setTimeout(r, 10));
    release();
    expect((await outcomeCounts()).timeout).toBe((before.timeout ?? 0) + 1);
  });

  // `endpoint` is a reserved scrape target label: the scraper's own value would overwrite ours.
  it('labels the endpoint as feed_endpoint, never endpoint', async () => {
    for (const name of [
      'civitai_app_feed_go_shadow_samples_total',
      'civitai_app_feed_go_shadow_encode_seconds_total',
      'civitai_app_feed_go_shadow_encode_bytes_total',
    ]) {
      const metric = instrumentationRegistry.getSingleMetric(name);
      expect(metric, name).toBeDefined();
      const { values } = await metric!.get();
      expect(values.map((v) => v.labels.feed_endpoint).sort(), name).toEqual(
        expect.arrayContaining([
          'as-posts',
          'v1-images',
          'infinite',
          'model-getall',
          'v1-models',
          'v1-models-id',
          'model-associated',
        ])
      );
      for (const v of values) expect(Object.keys(v.labels), name).not.toContain('endpoint');
    }
  });
});

describe('feed-go Go-first probe, end to end', () => {
  function probeOn() {
    flag.probe = true;
    configure({ FEED_GO_GOFIRST_PROBE_SAMPLE_RATE: '1' });
  }

  it('reaches feed-go BEFORE the handler computes the page', async () => {
    probeOn();
    handler.awaitProbe = true;
    const before = Date.now();
    const served = await get(PROCEDURE, { cookie: '__Secure-civ-token=hdr.payload.sig' });
    expect(served.status).toBe(200);
    // The handler, while computing, already saw the probe at feed-go.
    expect(handler.probeSeen).toBe(true);

    const received = await receivedWithin(2);
    expect(received.map((p) => p.path)).toEqual([FEED_GO_PROBE_PATH, FEED_GO_SHADOW_PATH]);
    const probe = received[0].body;
    expect(probe.input).toBe(INPUT);
    expect(probe.headers).toEqual({
      host: new URL(baseUrl).host,
      cookie: '__Secure-civ-token=hdr.payload.sig',
    });
    expect(probe.node).toBeUndefined();
    // The request's start, on the epoch clock, taken before the handler ran.
    expect(typeof probe.startedAt).toBe('number');
    expect(probe.startedAt!).toBeGreaterThanOrEqual(before - 5);
    expect(probe.startedAt!).toBeLessThanOrEqual(Date.now());
  });

  it('control: the same wait reads false for a post that only comes after the response', async () => {
    // Same wait, aimed at the shadow sample, which is posted only after the response: the
    // handler must NOT see it. So a probe moved after the response would read false above.
    handler.awaitProbe = true;
    handler.probePath = FEED_GO_SHADOW_PATH;
    expect((await get(PROCEDURE)).status).toBe(200);
    expect(handler.probeSeen).toBe(false);
    expect((await receivedWithin(1)).map((p) => p.path)).toEqual([FEED_GO_SHADOW_PATH]);
  });

  it('the sampler off: no probe either', async () => {
    probeOn();
    flag.shadow = false;
    resetFeedGoShadowForTests();
    expect((await get(PROCEDURE)).status).toBe(200);
    expect(await receivedWithin(1, 200)).toHaveLength(0);
  });

  it('the probe flag off: only the shadow sample is posted', async () => {
    configure({ FEED_GO_GOFIRST_PROBE_SAMPLE_RATE: '1' });
    expect((await get(PROCEDURE)).status).toBe(200);
    await receivedWithin(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(feedGo.received.map((p) => p.path)).toEqual([FEED_GO_SHADOW_PATH]);
  });

  it('the user response is identical with the probe on', async () => {
    const off = await get(PROCEDURE);
    await receivedWithin(1);
    probeOn();
    const on = await get(PROCEDURE);
    expect(on).toEqual(off);
    // Drain this request's probe and shadow posts, so they cannot land in the next test.
    expect(await receivedWithin(3)).toHaveLength(3);
  });
});

describe('feed-go shadow, image.getInfinite end to end', () => {
  const INFINITE = 'image.getInfinite';

  it('flag on: one POST to its own compare path with the raw input and the envelope Node wrote', async () => {
    flag.shadow = false; // the gallery flag plays no part
    flag.infinite = true;
    resetFeedGoShadowForTests();
    const served = await get(INFINITE, {
      cookie: '__Secure-civ-token=hdr.payload.sig; theme=dark',
    });
    expect(served.status).toBe(200);
    expect(JSON.parse(served.text).result.data).toEqual(SUPERJSON_PAYLOAD);
    const posts = await receivedWithin(1);
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe(FEED_GO_SHADOW_INFINITE_PATH);
    expect(posts[0].body.input).toBe(INPUT);
    expect(posts[0].body.node).toEqual(SUPERJSON_PAYLOAD);
    expect(posts[0].body.headers).toEqual({
      host: new URL(baseUrl).host,
      cookie: '__Secure-civ-token=hdr.payload.sig',
    });
    // Exactly one: nothing more arrives (the gallery procedure was not asked).
    expect(await receivedWithin(2, 200)).toHaveLength(1);
  });

  it('a 4xx answer is not mirrored, and is counted as skipped_status under its endpoint', async () => {
    flag.infinite = true;
    resetFeedGoShadowForTests();
    handler.infiniteBadRequest = true;
    const before = await outcomeCounts('infinite');
    const served = await get(INFINITE);
    expect(served.status).toBe(400);
    const start = Date.now();
    while (
      ((await outcomeCounts('infinite')).skipped_status ?? 0) === (before.skipped_status ?? 0) &&
      Date.now() - start < 1000
    )
      await new Promise((r) => setTimeout(r, 10));
    expect((await outcomeCounts('infinite')).skipped_status).toBe((before.skipped_status ?? 0) + 1);
    expect(await receivedWithin(1, 200)).toHaveLength(0);
  });

  it('flag off: nothing is mirrored (the first case proves the same request IS when on)', async () => {
    flag.infinite = false;
    resetFeedGoShadowForTests();
    expect((await get(INFINITE)).status).toBe(200);
    expect(await receivedWithin(1, 200)).toHaveLength(0);
  });
});

describe('feed-go shadow, model.getAll end to end', () => {
  const MODELS = 'model.getAll';

  it('flag on: one POST to its own compare path with the raw input and the envelope Node wrote', async () => {
    flag.shadow = false; // the gallery flag plays no part
    flag.models = true;
    resetFeedGoShadowForTests();
    const served = await get(MODELS, {
      cookie: '__Secure-civ-token=hdr.payload.sig; theme=dark',
    });
    expect(served.status).toBe(200);
    expect(JSON.parse(served.text).result.data).toEqual(SUPERJSON_PAYLOAD);
    const posts = await receivedWithin(1);
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe(FEED_GO_SHADOW_MODEL_GET_ALL_PATH);
    expect(posts[0].body.input).toBe(INPUT);
    expect(posts[0].body.node).toEqual(SUPERJSON_PAYLOAD);
    expect(posts[0].body.headers).toEqual({
      host: new URL(baseUrl).host,
      cookie: '__Secure-civ-token=hdr.payload.sig',
    });
    // Exactly one: nothing more arrives (the gallery procedure was not asked).
    expect(await receivedWithin(2, 200)).toHaveLength(1);
  });

  it('a 4xx answer is not mirrored, and is counted as skipped_status under its endpoint', async () => {
    flag.models = true;
    resetFeedGoShadowForTests();
    handler.modelsBadRequest = true;
    const before = await outcomeCounts('model-getall');
    const served = await get(MODELS);
    expect(served.status).toBe(400);
    const start = Date.now();
    while (
      ((await outcomeCounts('model-getall')).skipped_status ?? 0) ===
        (before.skipped_status ?? 0) &&
      Date.now() - start < 1000
    )
      await new Promise((r) => setTimeout(r, 10));
    expect((await outcomeCounts('model-getall')).skipped_status).toBe(
      (before.skipped_status ?? 0) + 1
    );
    expect(await receivedWithin(1, 200)).toHaveLength(0);
  });

  it('flag off: nothing is mirrored (the first case proves the same request IS when on)', async () => {
    flag.models = false;
    resetFeedGoShadowForTests();
    expect((await get(MODELS)).status).toBe(200);
    expect(await receivedWithin(1, 200)).toHaveLength(0);
  });
});

// The module-level sampler as the model routes use it (getInstance's wiring, not a test harness):
// every model sample carries this build's Training Data rule set, the statement's SHA-256 and the
// decision's version, which feed-go requires before it lists a Training Data file.
describe('feed-go shadow: /api/v1/models samples carry the Training Data rule set', () => {
  const expected = `${createHash('sha256')
    .update(trainingDataListingSql([]).text)
    .digest('hex')};rules=${TRAINING_DATA_LISTING_RULES_VERSION}`;

  it.each([
    ['list', '/api/v1/models?limit=1', FEED_GO_SHADOW_V1_MODELS_PATH],
    ['id', '/api/v1/models/42', FEED_GO_SHADOW_V1_MODELS_ID_PATH],
  ] as const)('the %s route', async (kind, url, path) => {
    flag.v1Models = true;
    resetFeedGoShadowForTests();
    const sample = beginFeedGoShadowV1Models(
      { method: 'GET', url, headers: { host: 'site.example.test' }, query: {} },
      kind
    );
    expect(sample, 'sampled').toBeDefined();
    captureFeedGoShadowRest(sample!, kind === 'list' ? { items: [], metadata: {} } : { id: 42 });
    finishFeedGoShadow(sample!, 200);
    const received = await receivedWithin(1);
    expect(received.map((r) => r.path)).toEqual([path]);
    expect(received[0].body.headers[FEED_GO_TRAINING_DATA_SQL_HEADER]).toBe(expected);
    expect(trainingDataListingRulesId()).toBe(expected);
  });
});
