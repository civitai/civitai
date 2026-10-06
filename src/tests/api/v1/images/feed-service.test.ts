import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as FliptClient from '~/server/flipt/client';
import type * as FeedPrimary from '~/server/services/feed-primary.service';
import type * as FeedShadow from '~/server/services/feed-shadow.service';
import type * as ImageService from '~/server/services/image.service';
import type * as Capture from '~/server/services/feed-request-capture.service';
import type * as Blocked from '~/server/services/blocked-browsing-tags.service';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as EdgeUrl from '~/client-utils/edge-url';
import type * as Auth from '~/server/auth/get-server-auth-session';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import type * as Region from '~/server/utils/region-blocking';
import type * as Meili from '~/server/meilisearch/client';
import type * as PromClient from '~/server/prom/client';

const h = vi.hoisted(() => ({
  restFlagOn: vi.fn(() => true),
  websiteFlagOn: vi.fn(() => false),
  flagsAsked: [] as string[],
  available: vi.fn(() => true),
  fetchFeedPrimary: vi.fn(),
  hydrate: vi.fn(),
  mapped: vi.fn(),
  meiliSearch: vi.fn(),
  record: vi.fn(),
  counted: [] as Array<Record<string, string>>,
}));

vi.mock('~/env/server', () => ({
  env: new Proxy(
    { LOGGING: [] as string[], TRPC_ORIGINS: [] as string[] } as Record<string, unknown>,
    {
      get: (target, prop) => {
        if (prop in target) return target[prop as string];
        if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
          return 'https://test:test@localhost:5432/test';
        if (
          typeof prop === 'string' &&
          /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
        )
          return 1;
        return undefined;
      },
    }
  ),
}));
vi.mock('../../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return {
    ...actual,
    registerCounterWithLabels: ((opts: { name: string }) =>
      opts.name === 'feed_primary_requests_total'
        ? { inc: (labels: Record<string, string>) => h.counted.push(labels) }
        : actual.registerCounterWithLabels(
            opts as Parameters<typeof actual.registerCounterWithLabels>[0]
          )) as typeof actual.registerCounterWithLabels,
  };
});

vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    getFliptBoolean: vi.fn(async (flag: string) => {
      h.flagsAsked.push(flag);
      if (flag === 'feed-service-rest-images') return h.restFlagOn();
      if (flag === 'feed-service-primary') return h.websiteFlagOn();
      return false;
    }),
  };
});
vi.mock('~/server/services/feed-primary.service', async (importOriginal) => {
  const actual = await importOriginal<typeof FeedPrimary>();
  return {
    ...actual,
    feedPrimaryAvailable: () => h.available(),
    fetchFeedPrimary: (...args: unknown[]) => h.fetchFeedPrimary(...args),
    // The real paging, mapping and counting; only the Postgres row load is faked.
    serveFromFeed: ((input, deps) =>
      actual.serveFromFeed(input, {
        ...deps,
        hydrate: async (ids: number[]) => h.hydrate(ids),
      })) as typeof actual.serveFromFeed,
  };
});
vi.mock('~/server/services/feed-shadow.service', async (importOriginal) => {
  const actual = await importOriginal<typeof FeedShadow>();
  return {
    ...actual,
    mapSearchInputToFeedQuery: ((...args) => {
      const mapping = actual.mapSearchInputToFeedQuery(...args);
      h.mapped(mapping);
      return mapping;
    }) as typeof actual.mapSearchInputToFeedQuery,
  };
});
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImagesFromFeedSearch: (...args: unknown[]) => h.meiliSearch(...args),
  getAllImages: vi.fn(),
}));
vi.mock('~/server/services/feed-request-capture.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Capture>()),
  feedRequestCapture: () => ({ record: h.record, flush: async () => undefined }),
}));
vi.mock('~/server/services/blocked-browsing-tags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocked>()),
  enforceBlockedBrowsingTags: async () => ({ emptyResult: false }),
}));
vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof Auth>()),
  getServerAuthSession: async () => null,
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlags: () => ({ datapacketRead: false }),
}));
vi.mock('~/server/utils/region-blocking', async (importOriginal) => ({
  ...(await importOriginal<typeof Region>()),
  getRegion: () => 'US',
  isRegionRestricted: () => false,
}));
vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof Meili>()),
  buildSearchActor: () => 'test-actor',
}));
vi.mock('~/client-utils/edge-url', async (importOriginal) => ({
  ...(await importOriginal<typeof EdgeUrl>()),
  getEdgeUrl: (url: string) => `edge/${url}`,
}));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  PublicEndpoint: (handler: unknown) => handler,
}));

import handler from '~/pages/api/v1/images/index';
import { runImageSearch } from '~/server/services/image-search.service';
import {
  getAllImagesIndex,
  getImagesFromFeedServiceForRest,
} from '~/server/services/image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const FEED_CREATED_AT = '2026-01-01T00:00:00.000Z';
const FEED_SORT_AT = '2026-03-01T12:00:00.000Z';
const row = (id: number) => ({
  id,
  url: `uuid-${id}`,
  hash: 'hash',
  width: 512,
  height: 768,
  nsfwLevel: 1,
  type: 'image',
  createdAt: new Date(FEED_CREATED_AT),
  sortAt: new Date(FEED_SORT_AT),
  postId: 3,
  stats: {},
  user: { username: 'maker' },
  baseModel: 'SDXL 1.0',
  modelVersionIds: [],
  tags: [],
});
const MEILI_PAGE = { items: [row(900)], nextCursor: '100|1788000000000' };

type MockResponse = NextApiResponse & {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
};
async function get(query: Record<string, string>) {
  const req = { method: 'GET', headers: {}, query } as unknown as NextApiRequest;
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    headersSent: false,
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    end() {
      return res;
    },
  };
  await handler(req, res as unknown as NextApiResponse);
  return res as unknown as MockResponse;
}

const feedQuery = (call = 0) =>
  new URLSearchParams(h.fetchFeedPrimary.mock.calls[call]?.[0] as string);
const nextPageQuery = (nextPage: string) =>
  Object.fromEntries(new URL(nextPage).searchParams.entries());

/** feed_primary_requests_total increments since the test began, one entry per label set. */
async function counted() {
  const totals = new Map<string, number>();
  for (const labels of h.counted) {
    const key = JSON.stringify(labels);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  return [...totals].map(([key, value]) => ({ ...JSON.parse(key), value }));
}

describe('/api/v1/images served by the feed service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.flagsAsked.length = 0;
    h.restFlagOn.mockReturnValue(true);
    h.websiteFlagOn.mockReturnValue(false);
    h.available.mockReturnValue(true);
    h.fetchFeedPrimary.mockResolvedValue({ status: 200, ms: 3, ids: [9, 5], nextCursor: '17|5' });
    h.hydrate.mockImplementation(async (ids: number[]) => ids.map(row));
    h.meiliSearch.mockResolvedValue(MEILI_PAGE);
    dbMock.dbRead.user.findUnique.mockResolvedValue(null);
    dbMock.dbWrite.user.findUnique.mockResolvedValue(null);
    h.counted.length = 0;
  });

  it('serves the first page from the feed service, in the feed order', async () => {
    const res = await get({});
    expect(res.statusCode).toBe(200);
    expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([9, 5]);
    expect(res.body.metadata.nextCursor).toBe('feed:17:5');
    expect(h.meiliSearch).not.toHaveBeenCalled();
  });

  it('nextPage carries the feed cursor, and following it continues on the feed service', async () => {
    const first = await get({ limit: '2' });
    const next = nextPageQuery(first.body.metadata.nextPage);
    expect(next).toEqual({ limit: '2', cursor: 'feed:17:5' });

    h.fetchFeedPrimary.mockResolvedValueOnce({
      status: 200,
      ms: 3,
      ids: [4],
      nextCursor: undefined,
    });
    const second = await get(next);
    expect(second.statusCode).toBe(200);
    expect(feedQuery(1).get('cursor')).toBe('17|5');
    expect(second.body.items.map((i: { id: number }) => i.id)).toEqual([4]);
    expect(second.body.metadata.nextPage).toBeUndefined();
    expect(h.meiliSearch).not.toHaveBeenCalled();
  });

  it('continues a bare numeric cursor from that offset on the feed service', async () => {
    await get({ cursor: '300' });
    expect(feedQuery().get('offset')).toBe('300');
    expect(h.meiliSearch).not.toHaveBeenCalled();
  });

  it('finishes an offset|sortAt cursor on the search path without mapping it for the feed', async () => {
    const res = await get({ cursor: '200|1788000000000' });
    expect(res.statusCode).toBe(200);
    expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([900]);
    expect(h.mapped).not.toHaveBeenCalled();
    expect(h.fetchFeedPrimary).not.toHaveBeenCalled();
    expect(h.meiliSearch).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: '200|1788000000000' })
    );
    expect(await counted()).toEqual([
      { outcome: 'unmapped', reason: 'cursor:legacy', route: 'rest', value: 1 },
    ]);
  });

  it('ignores ?page= on the feed service, as the search path does, so feed health never decides the page', async () => {
    await get({ limit: '10' });
    await get({ page: '3', limit: '10' });
    expect(h.fetchFeedPrimary).toHaveBeenCalledTimes(2);
    expect(feedQuery(0).get('limit')).toBe('10');
    expect(feedQuery(1).toString()).toBe(feedQuery(0).toString());
    expect(feedQuery(1).get('offset')).toBeNull();
  });

  it('[invariant on the pre-change code and the previous head] ignores ?page= on the fallback too: the search path gets no offset', async () => {
    h.fetchFeedPrimary.mockRejectedValue(
      Object.assign(new Error('slow'), { name: 'TimeoutError' })
    );
    const res = await get({ page: '3', limit: '10' });
    expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([900]);
    const meiliInput = h.meiliSearch.mock.calls[0][0];
    expect(meiliInput).not.toHaveProperty('offset');
    expect(meiliInput.cursor).toBeUndefined();
  });

  describe('falls back to the search path, with the request unchanged, when the feed does not serve', () => {
    const cases: Array<{
      name: string;
      query: Record<string, string>;
      arrange?: () => void;
      asked: boolean;
      series: { outcome: string; reason: string };
    }> = [
      {
        name: 'a shape the feed cannot express',
        query: { requiringMeta: 'true' },
        asked: false,
        series: { outcome: 'unmapped', reason: 'flag:requiringMeta' },
      },
      {
        name: 'an offset past the cap',
        query: { cursor: '25000' },
        asked: false,
        series: { outcome: 'rejected', reason: 'offset>20000' },
      },
      {
        name: 'a feed timeout',
        query: {},
        arrange: () =>
          h.fetchFeedPrimary.mockRejectedValue(
            Object.assign(new Error('slow'), { name: 'TimeoutError' })
          ),
        asked: true,
        series: { outcome: 'timeout', reason: '' },
      },
      {
        name: 'a feed fetch error',
        query: {},
        arrange: () => h.fetchFeedPrimary.mockRejectedValue(new Error('refused')),
        asked: true,
        series: { outcome: 'error', reason: 'fetch' },
      },
      {
        name: 'a non-200 feed answer',
        query: {},
        arrange: () => h.fetchFeedPrimary.mockResolvedValue({ status: 502, ms: 3, ids: [] }),
        asked: true,
        series: { outcome: 'error', reason: 'status:502' },
      },
      {
        name: 'a page whose rows hydrate to nothing',
        query: {},
        arrange: () => h.hydrate.mockResolvedValue([]),
        asked: true,
        series: { outcome: 'error', reason: 'hydrate:empty' },
      },
    ];
    it.each(cases)('$name', async ({ query, arrange, asked, series }) => {
      arrange?.();
      const res = await get(query);
      expect(res.statusCode).toBe(200);
      expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([900]);
      expect(res.body.metadata.nextCursor).toBe('100|1788000000000');
      expect(h.mapped).toHaveBeenCalledTimes(1);
      expect(h.fetchFeedPrimary).toHaveBeenCalledTimes(asked ? 1 : 0);
      expect(h.meiliSearch).toHaveBeenCalledTimes(1);
      const meiliInput = h.meiliSearch.mock.calls[0][0];
      expect(meiliInput.cursor).toBe(query.cursor);
      expect(meiliInput).not.toHaveProperty('offset');
      expect(await counted()).toEqual([{ ...series, route: 'rest', value: 1 }]);
      expect(h.record).not.toHaveBeenCalled();
    });

    it('a cursor the feed cannot parse (unreachable from the endpoint, which 400s it first)', async () => {
      const result = await getImagesFromFeedServiceForRest(
        {
          sort: 'Most Reactions',
          period: 'AllTime',
          browsingLevel: 1,
          limit: 10,
          cursor: '12|x',
        } as unknown as Parameters<typeof getImagesFromFeedServiceForRest>[0],
        {} as Parameters<typeof getImagesFromFeedServiceForRest>[1]
      );
      // `|` alone already routes it away; without one the mapping refuses it.
      expect(result).toBeUndefined();
      const bare = await getImagesFromFeedServiceForRest(
        {
          sort: 'Most Reactions',
          period: 'AllTime',
          browsingLevel: 1,
          limit: 10,
          cursor: 'nope',
        } as unknown as Parameters<typeof getImagesFromFeedServiceForRest>[0],
        {} as Parameters<typeof getImagesFromFeedServiceForRest>[1]
      );
      expect(bare).toBeUndefined();
      expect(h.fetchFeedPrimary).not.toHaveBeenCalled();
      expect(await counted()).toEqual([
        { outcome: 'unmapped', reason: 'cursor:legacy', route: 'rest', value: 1 },
        { outcome: 'rejected', reason: 'cursor:unparsed', route: 'rest', value: 1 },
      ]);
    });

    it('[invariant on the pre-change code] rejects an unreadable cursor at the endpoint before any branch', async () => {
      const res = await get({ cursor: 'nope' });
      expect(res.statusCode).toBe(400);
      expect(h.fetchFeedPrimary).not.toHaveBeenCalled();
      expect(h.meiliSearch).not.toHaveBeenCalled();
    });
  });

  describe('a feed: cursor never restarts the scroll on the search path', () => {
    it('is served by the feed service with the flag off', async () => {
      h.restFlagOn.mockReturnValue(false);
      const res = await get({ cursor: 'feed:17:5' });
      expect(res.statusCode).toBe(200);
      expect(feedQuery().get('cursor')).toBe('17|5');
      expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([9, 5]);
      expect(h.meiliSearch).not.toHaveBeenCalled();
    });

    it('is a 400 when the feed service is not configured [pre-change code 400d every feed: cursor]', async () => {
      h.available.mockReturnValue(false);
      const res = await get({ cursor: 'feed:17:5' });
      expect(res.statusCode).toBe(400);
      expect(h.fetchFeedPrimary).not.toHaveBeenCalled();
      expect(h.meiliSearch).not.toHaveBeenCalled();
    });

    it('is a retryable 503 when the feed service times out', async () => {
      h.fetchFeedPrimary.mockRejectedValue(
        Object.assign(new Error('slow'), { name: 'TimeoutError' })
      );
      const res = await get({ cursor: 'feed:17:5' });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('2');
      expect(h.meiliSearch).not.toHaveBeenCalled();
    });

    it('is a 400 when the request changed to a shape the feed cannot serve [pre-change code 400d every feed: cursor]', async () => {
      const res = await get({ cursor: 'feed:17:5', requiringMeta: 'true' });
      expect(res.statusCode).toBe(400);
      expect(h.meiliSearch).not.toHaveBeenCalled();
    });
  });

  describe('username', () => {
    it('answers an unknown username with an empty 200, not a 404 and not the unscoped feed', async () => {
      const res = await get({ username: 'nobodyhere' });
      expect(res.statusCode).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.metadata.nextCursor).toBeUndefined();
      expect(res.body.metadata.nextPage).toBeUndefined();
      expect(h.fetchFeedPrimary).not.toHaveBeenCalled();
      expect(h.meiliSearch).not.toHaveBeenCalled();
    });

    it('scopes the feed to the creator a username names', async () => {
      dbMock.dbRead.user.findUnique.mockResolvedValue({ id: 7 });
      await get({ username: 'someone' });
      expect(feedQuery().get('userIds')).toBe('7');
    });
  });

  it('reports createdAt as the feed time on a feed-served page, as the search path does', async () => {
    const res = await get({});
    expect(res.body.items.map((i: { createdAt: Date }) => i.createdAt.toISOString())).toEqual([
      FEED_SORT_AT,
      FEED_SORT_AT,
    ]);
  });

  describe('flag gating', () => {
    it('[invariant on the pre-change code] leaves the search path untouched when the flag is off', async () => {
      h.restFlagOn.mockReturnValue(false);
      const res = await get({ limit: '7' });
      expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([900]);
      expect(h.fetchFeedPrimary).not.toHaveBeenCalled();
      expect(h.mapped).not.toHaveBeenCalled();
      expect(h.meiliSearch).toHaveBeenCalledWith(expect.objectContaining({ limit: 7 }));
      expect(h.record).not.toHaveBeenCalled();
    });

    it('asks Flipt for feed-service-rest-images and not for the website flag', async () => {
      await get({});
      expect(h.flagsAsked).toContain('feed-service-rest-images');
      expect(h.flagsAsked).not.toContain('feed-service-primary');
    });

    it('[invariant on the pre-change code] does not consult the flag when no feed service is configured', async () => {
      h.available.mockReturnValue(false);
      const res = await get({});
      expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([900]);
      expect(h.flagsAsked).not.toContain('feed-service-rest-images');
      expect(h.fetchFeedPrimary).not.toHaveBeenCalled();
    });

    it('[invariant on the pre-change code] a caller that does not opt in keeps the search path and refuses feed: cursors', async () => {
      const req = { headers: {} } as unknown as NextApiRequest;
      const search = (cursor?: string) =>
        runImageSearch(
          { limit: 5, cursor, withMeta: false, withTags: false, data: { sort: 'Newest' } },
          { browsingLevel: 1, req }
        );
      expect((await search()).items.map((i) => i.id)).toEqual([900]);
      await expect(search('feed:17:5')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(h.fetchFeedPrimary).not.toHaveBeenCalled();
    });
  });

  it('labels the REST outcomes apart from the website ones', async () => {
    await get({});
    expect(await counted()).toEqual([{ outcome: 'served', reason: '', route: 'rest', value: 1 }]);
  });

  it('captures a feed-served REST request with its call site', async () => {
    await get({});
    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { src: '/api/v1/images' } }),
      expect.objectContaining({
        source: 'getImagesFromSearch',
        filterMode: 'feed',
        resultIds: [9, 5],
      })
    );
  });
});

describe('getAllImagesIndex (the website feed) beside the REST branch', () => {
  const request = (cursor: unknown) =>
    ({
      sort: 'Newest',
      period: 'Week',
      browsingLevel: 1,
      limit: 100,
      include: [],
      user: { id: 42, isModerator: false },
      cursor,
    } as unknown as Parameters<typeof getAllImagesIndex>[0]);

  beforeEach(() => {
    vi.clearAllMocks();
    h.websiteFlagOn.mockReturnValue(true);
    h.available.mockReturnValue(true);
    h.counted.length = 0;
  });

  it('[invariant on the pre-change code] still answers DEEP_OFFSET and CURSOR_UNPARSED with a 400', async () => {
    await expect(getAllImagesIndex(request('30000|1788000000000'))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(getAllImagesIndex(request('feed'))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(h.fetchFeedPrimary).not.toHaveBeenCalled();
  });

  it('counts its outcomes under route=website', async () => {
    await getAllImagesIndex(request('30000|1788000000000')).catch(() => undefined);
    expect(await counted()).toEqual([
      { outcome: 'rejected', reason: 'offset>20000', route: 'website', value: 1 },
    ]);
  });
});
