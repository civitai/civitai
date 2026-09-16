import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * THE TRANSPORT SEAM of GET /api/v1/blocks/collections?period=…
 *
 * `collections-period.test.ts` doubles `getWindowedCollectionRanking` itself, so every
 * assertion in it is about what the ENDPOINT does with a ranking result. That left the
 * step between the endpoint and ClickHouse — the only step that actually failed in
 * production — with no coverage at all: the whole suite was green while every live
 * `period=Month` request rendered the app's "ranking isn't available right now" note.
 *
 * 🔴 SO THE DOUBLE HERE IS ONE LEVEL DEEPER, AND THAT IS THE POINT. The REAL
 * `getWindowedCollectionRanking` runs; only the ClickHouse CLIENT is doubled, with the
 * exact error production threw:
 *
 *     ClickHouse query failed: Socket hang up after 3 retries
 *
 * `@clickhouse/client` 0.2.10 raises that when every pooled keep-alive socket it tries
 * has been idle past `keep_alive.socket_ttl` — measured at ~341 throws per hour against
 * the production deployment on 2026-09-11, and the single live `period=Month` request
 * in that day's ingress access log (21:58:27Z) is one of them.
 *
 * 🔴 AND THE REQUEST IS THE LITERAL PRODUCTION QUERY STRING, parsed the way the server
 * parses it, rather than a hand-built object. The whole defect class here is "the state
 * a test constructs is not the state a request produces", so the shape is taken from
 * the wire: `sort=Most+Followers` (the raw enum spelling the app sends) rather than the
 * `sort=popular` alias every other test in this directory uses.
 */

const PRODUCTION_QUERY_STRING = 'mode=public&sort=Most+Followers&period=Month&limit=24';

/** The verbatim message `@clickhouse/client` 0.2.10 throws on an exhausted socket pool. */
const SOCKET_HANG_UP = 'ClickHouse query failed: Socket hang up after 3 retries';

function createMocks(query: Record<string, unknown>) {
  const req = {
    method: 'GET',
    query,
    headers: {},
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as Record<string, unknown>;
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader() {
      /* not asserted here */
    },
    end() {
      return res;
    },
    _status: () => statusCode,
    _json: () => payload,
  };
  return { req, res };
}

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => (req: any, res: any) => {
    req.blockClaims = claimsBox.claims;
    return handler(req, res);
  },
  parseSubjectUserId: (sub: string): number | null => (sub === 'anon' ? null : 42),
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: any) => h }));

const {
  mockGetAll,
  mockItemCount,
  mockHydrate,
  mockFollowed,
  mockRate,
  mockMaturity,
  mockFallbackCovers,
  mockPlayableSample,
  mockChQuery,
  mockRecordSource,
} = vi.hoisted(() => ({
  mockGetAll: vi.fn(),
  mockItemCount: vi.fn(),
  mockHydrate: vi.fn(),
  mockFollowed: vi.fn(),
  mockRate: vi.fn(),
  mockMaturity: vi.fn(),
  mockFallbackCovers: vi.fn(),
  mockPlayableSample: vi.fn(),
  mockChQuery: vi.fn(),
  mockRecordSource: vi.fn(),
}));

vi.mock('~/server/services/collection.service', () => ({
  getAllCollections: mockGetAll,
  getCollectionItemCount: mockItemCount,
  getUserCollectionsWithPermissions: vi.fn(),
}));
vi.mock('~/server/services/blocks/block-collections.service', () => ({
  hydrateBlockSubject: mockHydrate,
  getFollowedCollectionIds: mockFollowed,
  getFallbackCoverImages: mockFallbackCovers,
  getCollectionPlayableSample: mockPlayableSample,
  toCoverFields: () => ({ coverImageUrl: null }),
  collectionWithinCeiling: () => true,
}));
/**
 * 🔴 THE ONLY DOUBLE ON THE RANKING PATH. `block-collection-popularity.service` is NOT
 * mocked — its retry loop, its window arithmetic and its degrade reason are the code
 * under test. Stubbing it is what made the shipped suite blind to this.
 */
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: mockChQuery } }));
vi.mock('~/server/prom/block-collection-ranking.metrics', () => ({
  recordBlockCollectionRankingSource: mockRecordSource,
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: mockRate,
}));
vi.mock('~/server/utils/block-catalog-maturity', () => ({
  resolveCatalogBrowsingLevel: mockMaturity,
}));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => ({}),
  isRegionRestricted: () => false,
}));

import handler from '~/pages/api/v1/blocks/collections/index';
import {
  CH_RANKING_MAX_ATTEMPTS,
  CH_RANKING_RETRY_BUDGET_MS,
} from '~/server/services/blocks/block-collection-popularity.service';

/**
 * Ranked ids ClickHouse would return, in rank order.
 *
 * Deliberately NOT id-ascending and NOT id-descending: the `getAllCollections` double
 * below returns rows in id-DESC order, so an endpoint that served Postgres' order
 * instead of the rank order would produce a visibly different list rather than the same
 * one by coincidence.
 */
const RANKED = [903, 901, 902];

async function run(queryString = PRODUCTION_QUERY_STRING) {
  const query = Object.fromEntries(new URLSearchParams(queryString));
  const { req, res } = createMocks(query);
  await handler(req as never, res as never);
  return { status: res._status(), body: res._json() as any };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 🔴 `mockReset`, not `clearAllMocks`, for the ClickHouse double — and the difference
  // is not hygiene, it is correctness. `clearAllMocks` empties `mock.calls` but leaves
  // the `…Once` QUEUE intact, so a test whose subject stops asking before the queue is
  // drained leaks its unconsumed entries into the next test. Measured at the pre-change
  // base, where exactly that happens (one ask instead of two): the leftover
  // `mockResolvedValueOnce` fired in a LATER test and made a degraded path report
  // `source: 'clickhouse'`. Every test here queues its own asks from empty.
  mockChQuery.mockReset();
  claimsBox.claims = {
    sub: 'user:42',
    scopes: ['collections:read:self'],
    blockInstanceId: 'bki_test',
    maxBrowsingLevel: 31,
    ctx: {},
  } as unknown as BlockTokenClaims;
  mockRate.mockResolvedValue({ allowed: true });
  mockMaturity.mockReturnValue({ browsingLevel: 31, isSfwCeiling: false });
  mockHydrate.mockResolvedValue({ id: 42, username: 'mod' });
  mockFollowed.mockResolvedValue(new Set<number>());
  mockFallbackCovers.mockResolvedValue(new Map());
  mockPlayableSample.mockResolvedValue(new Map());
  mockItemCount.mockResolvedValue([]);
  mockGetAll.mockImplementation(async ({ input }: any) => {
    const rows = [901, 902, 903]
      .map((id) => ({
        id,
        name: `C${id}`,
        description: null,
        read: 'Public',
        nsfwLevel: 1,
        userId: 1,
        user: { id: 1, username: 'a' },
        image: null,
      }))
      .sort((a, b) => b.id - a.id);
    const filtered =
      input.ids && input.ids.length > 0 ? rows.filter((c) => input.ids.includes(c.id)) : rows;
    return filtered.slice(0, input.limit);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a keep-alive socket drop must not cost the request its ranking', () => {
  it('serves the ClickHouse ranking after one Socket-hang-up, for the real production request', async () => {
    mockChQuery
      .mockRejectedValueOnce(new Error(SOCKET_HANG_UP))
      .mockResolvedValueOnce(RANKED.map((id) => ({ id })));

    const { status, body } = await run();

    expect(status).toBe(200);
    // The three claims that separate a served ranking from the degraded grid the app
    // renders its "ranking isn't available right now" note over.
    expect(body.source).toBe('clickhouse');
    expect(body.sourceReason).toBeUndefined();
    expect(body.items.map((i: any) => i.id)).toEqual(RANKED);
    // And it cost exactly one extra ask — not a loop.
    expect(mockChQuery).toHaveBeenCalledTimes(2);
  });

  it('records the ClickHouse source on the metric, with no reason', async () => {
    mockChQuery
      .mockRejectedValueOnce(new Error(SOCKET_HANG_UP))
      .mockResolvedValueOnce(RANKED.map((id) => ({ id })));

    await run();

    expect(mockRecordSource).toHaveBeenCalledWith({
      period: 'Month',
      source: 'clickhouse',
      reason: undefined,
    });
  });

  it('still degrades — and says why — when the retry fails too', async () => {
    mockChQuery.mockRejectedValue(new Error(SOCKET_HANG_UP));

    const { body } = await run();

    expect(body.source).toBe('postgres');
    expect(body.sourceReason).toBe('clickhouse-error');
    // Bounded: the loop is a retry, not a spin.
    expect(mockChQuery).toHaveBeenCalledTimes(CH_RANKING_MAX_ATTEMPTS);
    expect(mockRecordSource).toHaveBeenCalledWith({
      period: 'Month',
      source: 'postgres',
      reason: 'clickhouse-error',
    });
  });

  it('does NOT retry a failure that already spent the budget — a hang must not be doubled', async () => {
    // 🔴 The clock, not an attempt counter, is what separates the two failure modes.
    // `Date.now` is stubbed rather than the timers faked so that `windowStartDate`'s
    // `new Date()` keeps producing a real window literal — the retry decision is the
    // only thing under this stub.
    //
    // The service reads the clock once before the first attempt and once after each
    // failure; the second reading overshoots the budget, so the loop must stop with one
    // attempt spent.
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(
      (() => {
        let call = 0;
        return () => (call++ === 0 ? realNow : realNow + CH_RANKING_RETRY_BUDGET_MS + 1);
      })()
    );
    mockChQuery.mockRejectedValue(new Error('ClickHouse query failed: Timeout error'));

    const { body } = await run();

    expect(mockChQuery).toHaveBeenCalledTimes(1);
    expect(body.source).toBe('postgres');
    expect(body.sourceReason).toBe('clickhouse-error');
  });
});
