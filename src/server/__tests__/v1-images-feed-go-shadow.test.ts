import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { instrumentationRegistry } from '@civitai/telemetry/client';
import type * as FliptClient from '~/server/flipt/client';
import { resetFeedGoShadowForTests } from '~/server/trpc/feed-go-shadow';

/**
 * The feed-go shadow wired through the REAL `GET /api/v1/images` handler
 * (`src/pages/api/v1/images/index.ts`): with `feed-go-shadow-v1-images` on, every 200 the handler
 * writes, the early-return ones included, is captured and POSTed to feed-go; a 4xx and an API-key
 * request are not; and every request is counted by shape class. The unit suite
 * (`src/server/trpc/__tests__/feed-go-shadow.test.ts`) drives the sampler alone and cannot see a
 * handler that writes a 200 without capturing it. Only the search, the gallery gates, the session
 * and the Flipt read are replaced; `fetch` is stubbed, so nothing leaves the process.
 */

const h = vi.hoisted(() => ({
  withheld: false,
  items: [] as Array<Record<string, unknown>>,
}));

vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    isFliptSync: (key: string, ...rest: [string?, Record<string, string>?]) =>
      key === 'feed-go-shadow-v1-images' ? true : actual.isFliptSync(key, ...rest),
  };
});
vi.mock('~/server/services/image-search.service', () => ({
  runImageSearch: async () => ({ items: h.items, nextCursor: undefined }),
  withoutHeldImages: async (items: unknown[]) => items,
}));
vi.mock('~/server/services/model.service', () => ({
  isModelGalleryWithheld: async () => h.withheld,
  getHeldGalleryLevel: async () => undefined,
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: async () => null,
}));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => ({ countryCode: 'US', regionCode: null, fullLocationCode: 'US' }),
  isRegionRestricted: () => false,
}));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PublicEndpoint: (fn: unknown) => fn,
}));

import handler from '~/pages/api/v1/images/index';

const SHADOW_BASE = 'http://feed-go.test:9090';
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
  async () => new Response(null, { status: 202 })
);

type MockRes = {
  statusCode: number;
  headersSent: boolean;
  body: unknown;
  setHeader: () => MockRes;
  getHeader: () => undefined;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
  end: () => MockRes;
};

function call(query: Record<string, string>, headers: Record<string, string> = {}) {
  const search = new URLSearchParams(query).toString();
  const req = {
    method: 'GET',
    url: `/api/v1/images${search ? `?${search}` : ''}`,
    headers: { host: 'civitai.com', ...headers },
    query,
  } as unknown as NextApiRequest;
  const res: MockRes = {
    statusCode: 200,
    headersSent: false,
    body: undefined,
    setHeader: () => res,
    getHeader: () => undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      res.headersSent = true;
      return res;
    },
    end() {
      res.headersSent = true;
      return res;
    },
  };
  return { req, res };
}

async function serve(query: Record<string, string>, headers?: Record<string, string>) {
  const { req, res } = call(query, headers);
  await (handler as unknown as (q: NextApiRequest, r: unknown) => Promise<void>)(req, res);
  // The sampler POSTs from setImmediate after the handler: let it run and settle.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return res;
}

function posts() {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    body: JSON.parse(String(init.body)) as {
      input: string;
      path: string;
      node: unknown;
    },
  }));
}

async function shapeCounts(): Promise<Record<string, number>> {
  const metric = instrumentationRegistry.getSingleMetric('civitai_app_feed_go_v1_shape_total');
  if (!metric) return {};
  const { values } = await metric.get();
  return Object.fromEntries(values.map((v) => [String(v.labels.class), v.value]));
}

beforeEach(() => {
  process.env.FEED_GO_SHADOW_URL = SHADOW_BASE;
  process.env.FEED_GO_SHADOW_SAMPLE_RATE = '1';
  process.env.FEED_GO_SHADOW_MAX_PER_SECOND = '1000';
  resetFeedGoShadowForTests();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  h.withheld = false;
  h.items = [];
});

afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.FEED_GO_SHADOW_URL;
  delete process.env.FEED_GO_SHADOW_SAMPLE_RATE;
  delete process.env.FEED_GO_SHADOW_MAX_PER_SECOND;
  resetFeedGoShadowForTests();
});

describe('GET /api/v1/images → feed-go shadow, through the handler', () => {
  it('posts one sample for a 200 page, carrying the body the handler wrote', async () => {
    h.items = [{ id: 11, createdAt: new Date('2024-03-01T10:00:00.000Z'), tags: undefined }];
    const res = await serve({ modelVersionId: '9', limit: '2' });
    expect(res.statusCode).toBe(200);
    const sent = posts();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${SHADOW_BASE}/internal/shadow/api/v1/images`);
    expect(sent[0].body.input).toBe('modelVersionId=9&limit=2');
    expect(sent[0].body.path).toBe('/api/v1/images');
    // What res.json wrote, as JSON: a Date as its ISO string, the undefined member dropped.
    expect(sent[0].body.node).toEqual({
      items: [{ id: 11, createdAt: '2024-03-01T10:00:00.000Z' }],
      metadata: {},
    });
    expect(sent[0].body.node).toEqual(JSON.parse(JSON.stringify(res.body)));
  });

  it('posts the early-return withheld-gallery 200 too', async () => {
    h.withheld = true;
    const res = await serve({ modelVersionId: '9' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ items: [], metadata: {} });
    const sent = posts();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.node).toEqual({ items: [], metadata: {} });
  });

  it('posts nothing for a 4xx', async () => {
    const res = await serve({ limit: '999' });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts nothing for an API-key request (bearer header or ?token=)', async () => {
    h.items = [{ id: 11 }];
    const bearer = await serve({ modelVersionId: '9' }, { authorization: 'Bearer KEY-1' });
    const token = await serve({ modelVersionId: '9', token: 'KEY-1' });
    expect([bearer.statusCode, token.statusCode]).toEqual([200, 200]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts each request by shape class, from the parsed query', async () => {
    const before = await shapeCounts();
    await serve({ modelVersionId: '9' });
    await serve({ ids: '1,2' });
    await serve({ imageId: '5' });
    await serve({ limit: '999' });
    const after = await shapeCounts();
    expect((after.ported ?? 0) - (before.ported ?? 0)).toBe(2);
    expect((after.unported_imageId ?? 0) - (before.unported_imageId ?? 0)).toBe(1);
    expect((after.non200 ?? 0) - (before.non200 ?? 0)).toBe(1);
  });
});
