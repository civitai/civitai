import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type * as DbHelpers from '~/server/db/db-helpers';
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
  enforce: vi.fn(),
  hydrateQuery: vi.fn(),
  hydrateObserved: new Error('hydrate query observed'),
  // When set, the production hydrate runs through getAllImagesUncaptured to the raw query.
  realHydrate: false,
  rawQuery: vi.fn(),
}));

vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbHelpers>()),
  queryWithTimeout: (...args: unknown[]) => h.rawQuery(...args),
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
vi.mock('~/server/flipt/tester-segment', async () => {
  return (await import('~/test-utils/testerFlagFake')).testerFlagModule;
});
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
    // Records the exact query getAllImagesUncaptured would receive, then stops before Postgres.
    feedHydrateQuery: ((input, ids) => {
      const query = actual.feedHydrateQuery(input, ids);
      h.hydrateQuery(query);
      if (h.realHydrate) return query;
      throw h.hydrateObserved;
    }) as typeof actual.feedHydrateQuery,
    // The real paging, mapping and counting. The production hydrate closure runs up to the
    // query it would load (above); the rows themselves come from h.hydrate.
    serveFromFeed: ((input, deps) =>
      actual.serveFromFeed(input, {
        ...deps,
        hydrate: async (ids: number[]) => {
          if (h.realHydrate) return deps.hydrate(ids);
          await deps.hydrate(ids).catch((e: unknown) => {
            if (e !== h.hydrateObserved) throw e;
          });
          return h.hydrate(ids);
        },
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
  enforceBlockedBrowsingTags: (...args: unknown[]) => h.enforce(...args),
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
import {
  eventDecorationEntityCaches,
  imageMetaCache,
  imageResourcesCache,
  tagIdsForImagesCache,
} from '~/server/redis/caches';
import {
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_PREVIEW_FROM,
} from '~/shared/constants/birthday2026.constants';
import { testerFlag } from '~/test-utils/testerFlagFake';

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
    h.enforce.mockImplementation(async () => ({ emptyResult: false }));
    h.realHydrate = false;
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
      expect(res.body.message).toBe(
        'This cursor can no longer be continued; start again without it'
      );
      expect(h.fetchFeedPrimary).not.toHaveBeenCalled();
      expect(h.meiliSearch).not.toHaveBeenCalled();
    });

    const outage: Array<[string, () => void]> = [
      [
        'timeout',
        () =>
          h.fetchFeedPrimary.mockRejectedValue(
            Object.assign(new Error('slow'), { name: 'TimeoutError' })
          ),
      ],
      ['fetch error', () => h.fetchFeedPrimary.mockRejectedValue(new Error('refused'))],
      ['hydrate:error', () => h.hydrate.mockRejectedValue(new Error('db down'))],
      ...[500, 502, 599].map((status): [string, () => void] => [
        `status:${status}`,
        () => h.fetchFeedPrimary.mockResolvedValue({ status, ms: 3, ids: [] }),
      ]),
    ];
    it.each(outage)('is a retryable 503 on %s', async (_reason, arrange) => {
      arrange();
      const res = await get({ cursor: 'feed:17:5' });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('2');
      expect(h.meiliSearch).not.toHaveBeenCalled();
    });

    it.each([400, 404, 499])(
      'is a 400 when the feed service refuses the query (status:%i)',
      async (status) => {
        h.fetchFeedPrimary.mockResolvedValue({ status, ms: 3, ids: [] });
        const res = await get({ cursor: 'feed:17:5' });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe('This cursor cannot be continued with these filters');
        expect(h.meiliSearch).not.toHaveBeenCalled();
      }
    );

    it('steps past a page whose every row was filtered out at hydrate (hydrate:empty)', async () => {
      h.fetchFeedPrimary.mockResolvedValue({ status: 200, ms: 3, ids: [9, 5], nextCursor: '18|3' });
      h.hydrate.mockResolvedValue([]);
      const res = await get({ cursor: 'feed:17:5' });
      expect(res.statusCode).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.metadata.nextCursor).toBe('feed:18:3');
      expect(h.meiliSearch).not.toHaveBeenCalled();
    });

    it('ends the scroll with an empty 200 when that filtered-out page was the last one', async () => {
      h.fetchFeedPrimary.mockResolvedValue({ status: 200, ms: 3, ids: [9, 5] });
      h.hydrate.mockResolvedValue([]);
      const res = await get({ cursor: 'feed:17:5' });
      expect(res.statusCode).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.metadata.nextCursor).toBeUndefined();
      expect(res.body.metadata.nextPage).toBeUndefined();
      expect(h.meiliSearch).not.toHaveBeenCalled();
    });

    it('is a retryable 503, never a skipped page, when the hydrate query hits the statement timeout', async () => {
      h.realHydrate = true;
      h.rawQuery.mockRejectedValue(
        Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
      );
      const res = await get({ cursor: 'feed:17:5' });
      expect(h.rawQuery).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('2');
      expect(h.meiliSearch).not.toHaveBeenCalled();
      expect(await counted()).toEqual([
        { outcome: 'error', reason: 'hydrate:error', route: 'rest', value: 1 },
      ]);
    });

    it('is a 400 when the request changed to a shape the feed cannot serve [pre-change code 400d every feed: cursor]', async () => {
      const res = await get({ cursor: 'feed:17:5', requiringMeta: 'true' });
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toBe('This cursor cannot be continued with these filters');
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

  describe('what a served page is filtered and hydrated with', () => {
    it('runs browsing-tag enforcement on the request before asking the feed', async () => {
      await get({ tags: '5,6', limit: '10' });
      expect(h.enforce).toHaveBeenCalledTimes(1);
      expect(h.enforce).toHaveBeenCalledWith(
        expect.objectContaining({ tags: [5, 6], limit: 10, browsingLevel: 1 }),
        { id: undefined, isModerator: undefined }
      );
    });

    it('answers an enforcement-emptied request with an empty 200 and no feed call', async () => {
      h.enforce.mockResolvedValue({ emptyResult: true });
      const res = await get({ tags: '5' });
      expect(res.statusCode).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.metadata.nextCursor).toBeUndefined();
      expect(h.fetchFeedPrimary).not.toHaveBeenCalled();
      expect(h.meiliSearch).not.toHaveBeenCalled();
    });

    it('hydrates with the enforced tags, the maturity filters and the resolved creator', async () => {
      dbMock.dbRead.user.findUnique.mockResolvedValue({ id: 7 });
      h.enforce.mockImplementation(
        async (input: { tags?: number[]; excludedTagIds?: number[] }) => {
          input.tags = [5];
          input.excludedTagIds = [99];
          return { emptyResult: false };
        }
      );
      await get({ tags: '5,6', username: 'someone', browsingLevel: '3' });
      expect(h.hydrateQuery).toHaveBeenCalledTimes(1);
      const query = h.hydrateQuery.mock.calls[0][0];
      expect(query).toMatchObject({
        ids: [9, 5],
        limit: 2,
        period: 'AllTime',
        tags: [5],
        excludedTagIds: [99],
        disableMinor: true,
        disablePoi: true,
        browsingLevel: 3,
        userId: 7,
      });
      expect(query).not.toHaveProperty('cursor');
    });

    it('falls back for limit=0, which the feed would serve as a full page', async () => {
      const res = await get({ limit: '0' });
      expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([900]);
      expect(h.fetchFeedPrimary).not.toHaveBeenCalled();
      expect(await counted()).toEqual([
        { outcome: 'unmapped', reason: 'limit:0', route: 'rest', value: 1 },
      ]);
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
    expect(h.record).toHaveBeenCalledTimes(1);
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

/** The second argument each per-image cache's fetch was called with, per call. */
function cacheFetchOptions() {
  const spies = {
    imageResources: vi.spyOn(imageResourcesCache, 'fetch').mockResolvedValue({}),
    tagIds: vi.spyOn(tagIdsForImagesCache, 'fetch').mockResolvedValue({}),
    imageMeta: vi.spyOn(imageMetaCache, 'fetch').mockResolvedValue({}),
  };
  const options = (name: keyof typeof spies) => spies[name].mock.calls.map((call) => call[1]);
  return { spies, options };
}
const rawRow = (id: number) => ({
  ...row(id),
  userId: 11,
  type: 'image',
  metadata: null,
  meta: null,
  hideMeta: false,
  hasMeta: false,
  publishedAt: new Date(FEED_CREATED_AT),
});

describe('per-image caches on a REST feed continuation page read through without writing back', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.restFlagOn.mockReturnValue(true);
    h.websiteFlagOn.mockReturnValue(false);
    h.available.mockReturnValue(true);
    h.fetchFeedPrimary.mockResolvedValue({ status: 200, ms: 3, ids: [9, 5], nextCursor: '17|5' });
    h.meiliSearch.mockResolvedValue(MEILI_PAGE);
    h.enforce.mockImplementation(async () => ({ emptyResult: false }));
    h.rawQuery.mockReset();
    h.rawQuery.mockResolvedValue({ rows: [rawRow(9), rawRow(5)] });
    h.realHydrate = true;
  });
  afterEach(() => {
    h.realHydrate = false;
    vi.restoreAllMocks();
  });

  it('passes writeBack:false to image-resources, tag-ids and image-meta on a feed: cursor page', async () => {
    const { options } = cacheFetchOptions();
    const res = await get({ cursor: 'feed:17:5', withMeta: 'true' });
    expect(res.statusCode).toBe(200);
    expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([9, 5]);
    expect(options('imageResources')).toEqual([{ writeBack: false }]);
    expect(options('tagIds')).toEqual([{ writeBack: false }]);
    expect(options('imageMeta')).toEqual([{ writeBack: false }]);
  });

  it('keeps writing back on a feed-served first page', async () => {
    const { options } = cacheFetchOptions();
    const res = await get({ withMeta: 'true' });
    expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([9, 5]);
    expect(h.fetchFeedPrimary).toHaveBeenCalledTimes(1);
    for (const name of ['imageResources', 'tagIds', 'imageMeta'] as const) {
      expect(options(name)).toHaveLength(1);
      expect(options(name)[0]?.writeBack).not.toBe(false);
    }
  });

  it('[invariant on the pre-change code] keeps writing back image-meta when the search path serves', async () => {
    h.restFlagOn.mockReturnValue(false);
    const { options } = cacheFetchOptions();
    const res = await get({ withMeta: 'true' });
    expect(res.body.items.map((i: { id: number }) => i.id)).toEqual([900]);
    expect(h.fetchFeedPrimary).not.toHaveBeenCalled();
    expect(options('imageMeta')).toHaveLength(1);
    expect(options('imageMeta')[0]?.writeBack).not.toBe(false);
  });

  it('[invariant on the pre-change code] the website feed hydrate keeps writing back', async () => {
    h.websiteFlagOn.mockReturnValue(true);
    const { options } = cacheFetchOptions();
    const r = await getAllImagesIndex({
      sort: 'Newest',
      period: 'Week',
      browsingLevel: 1,
      limit: 100,
      include: ['tagIds'],
      includeBaseModel: true,
      user: { id: 42, isModerator: false },
    } as unknown as Parameters<typeof getAllImagesIndex>[0]);
    expect(r.source).toBe('feed');
    expect(options('imageResources')).toHaveLength(1);
    expect(options('tagIds')).toHaveLength(1);
    for (const opts of [...options('imageResources'), ...options('tagIds')])
      expect(opts?.writeBack).not.toBe(false);
  });
});

describe('getAllImagesIndex (the website feed) beside the REST branch', () => {
  it('falls back to the search path, counted as hydrate:error, when the hydrate query times out', async () => {
    h.websiteFlagOn.mockReturnValue(true);
    h.available.mockReturnValue(true);
    h.counted.length = 0;
    h.realHydrate = true;
    h.fetchFeedPrimary.mockResolvedValue({ status: 200, ms: 3, ids: [9, 5], nextCursor: '17|5' });
    h.rawQuery.mockReset();
    h.rawQuery.mockRejectedValue(
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    );
    const r = await getAllImagesIndex(request(undefined));
    h.realHydrate = false;
    expect(h.rawQuery).toHaveBeenCalledTimes(1);
    expect(r.source).not.toBe('feed');
    expect(await counted()).toEqual([
      { outcome: 'error', reason: 'hydrate:error', route: 'website', value: 1 },
    ]);
  });

  it('[invariant on the pre-change code] answers an unknown username with NOT_FOUND', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue(null);
    dbMock.dbWrite.user.findUnique.mockResolvedValue(null);
    await expect(
      getAllImagesIndex({ ...request(undefined), username: 'ghost' } as Parameters<
        typeof getAllImagesIndex
      >[0])
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.fetchFeedPrimary).not.toHaveBeenCalled();
  });

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

// The website image feed is served by the feed service, which hydrates its rows through the same
// query as the database path. Before launch the birthday decorations on those rows must reach only
// a viewer the `birthday2026` flag is on for, so the viewer has to survive the hydrate query.
describe('event decorations on a feed-served website page before launch', () => {
  const VIEWER = { id: 42, isModerator: false };
  const HAT = { type: 'hat', event: BIRTHDAY_2026_EVENT, url: 'hat.png', team: 'Blue' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() + 24 * 60 * 60 * 1000));
    h.websiteFlagOn.mockReturnValue(true);
    h.available.mockReturnValue(true);
    h.fetchFeedPrimary.mockResolvedValue({ status: 200, ms: 3, ids: [9, 5], nextCursor: '17|5' });
    h.enforce.mockImplementation(async () => ({ emptyResult: false }));
    h.rawQuery.mockReset();
    h.rawQuery.mockResolvedValue({ rows: [rawRow(9), rawRow(5)] });
    h.realHydrate = true;
    cacheFetchOptions();
    vi.spyOn(eventDecorationEntityCaches.Image, 'fetch').mockResolvedValue({
      9: {
        id: 1,
        name: 'Party Hat',
        type: 'ContentDecoration',
        source: 'Purchase',
        data: HAT,
        claimKey: 'tx',
      },
    } as never);
  });
  afterEach(() => {
    h.realHydrate = false;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const page = () =>
    getAllImagesIndex({
      sort: 'Newest',
      period: 'Week',
      browsingLevel: 1,
      limit: 100,
      include: ['tagIds'],
      user: VIEWER,
      // What image.getInfinite passes (image.controller.ts).
      eventDecorationViewer: VIEWER,
    } as unknown as Parameters<typeof getAllImagesIndex>[0]);
  const hats = (r: Awaited<ReturnType<typeof page>>) =>
    Object.fromEntries(
      (r.items as { id: number; eventDecoration?: { data?: unknown } | null }[]).map((i) => [
        i.id,
        i.eventDecoration?.data ?? null,
      ])
    );

  it('shows the hat to a viewer the flag is on for', async () => {
    testerFlag.reset({ testers: [VIEWER.id] });
    const r = await page();
    expect(r.source).toBe('feed');
    expect(hats(r)).toEqual({ 9: HAT, 5: null });
  });

  it('shows no hat to a viewer the flag is off for', async () => {
    testerFlag.reset({ testers: [] });
    const r = await page();
    expect(r.source).toBe('feed');
    expect(hats(r)).toEqual({ 9: null, 5: null });
  });
});
