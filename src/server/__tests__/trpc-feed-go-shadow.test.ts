import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import superjson from 'superjson';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { instrumentationRegistry } from '@civitai/telemetry/client';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as FliptClient from '~/server/flipt/client';
import { FEED_GO_SHADOW_PATH, resetFeedGoShadowForTests } from '~/server/trpc/feed-go-shadow';

/**
 * The feed-go shadow sampler wired end to end: the real route (`src/pages/api/trpc/[trpc].ts`,
 * its real adapter), the real server transformer from `~/server/trpc` (where the response is
 * captured), a router with a procedure at the real path, and a fake feed-go listening on
 * loopback. Only the app router, the context and the Flipt read are replaced.
 *
 * What it pins: a sampled request is mirrored to feed-go with the raw input, the forwarded
 * headers and the superjson envelope Node wrote; the user's response is identical with the
 * sampler on or off and never waits on feed-go; nothing is mirrored with the flag off or for
 * another procedure.
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
const flag = vi.hoisted(() => ({ shadow: null as boolean | null }));
const handler = vi.hoisted(() => ({ fail: false }));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    isFliptSync: (key: string, ...rest: [string?, Record<string, string>?]) =>
      key === 'feed-go-shadow' ? flag.shadow : actual.isFliptSync(key, ...rest),
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
        getImagesAsPostsInfinite: publicProcedure.query(() => {
          if (handler.fail) throw new Error('handler failed');
          return PAYLOAD;
        }),
        getInfinite: publicProcedure.query(() => PAYLOAD),
      }),
    }),
  };
});

type Received = {
  path: string;
  body: { input: string; headers: Record<string, string>; node: unknown };
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
  handler.fail = false;
  h.writeDevalue = false;
  configure({
    FEED_GO_SHADOW_URL: fakeBase,
    FEED_GO_SHADOW_SAMPLE_RATE: '1',
    FEED_GO_SHADOW_TIMEOUT_MS: '2000',
    FEED_GO_SHADOW_MAX_IN_FLIGHT: undefined,
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

async function outcomeCounts(): Promise<Record<string, number>> {
  const metric = instrumentationRegistry.getSingleMetric(
    'civitai_app_feed_go_shadow_samples_total'
  );
  if (!metric) return {};
  const { values } = await metric.get();
  return Object.fromEntries(values.map((v) => [String(v.labels.outcome), v.value]));
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
});
