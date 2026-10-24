import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';
import type * as PopularityService from '~/server/services/blocks/block-collection-popularity.service';

/**
 * `period` coverage for GET /api/v1/blocks/collections.
 *
 * Four things are pinned here and nothing else belongs in this file:
 *
 *  1. THE NO-CHANGE PROOF. A request with no `period` must produce the response it
 *     produced before this parameter existed — same keys, same order, same source
 *     query shape — and must not touch ClickHouse at all.
 *  2. WINDOW SELECTION. Each period reaches the ranking service as itself, and the
 *     order ClickHouse returns is the order the endpoint serves.
 *  3. THE LEAK GUARD. A private or non-Image collection ranked FIRST by ClickHouse
 *     must not surface. This is the one with teeth, so the `getAllCollections`
 *     double below is a REAL filter over `privacy` / `types` rather than a canned
 *     row list — a stub that returned rows regardless of the predicate would pass
 *     this test while the endpoint leaked.
 *  4. THE DEGRADED PATHS. `clickhouse === undefined`, a failing query and an empty
 *     window each fall back to the all-time Postgres ordering and SAY SO. An empty
 *     grid is never an acceptable answer to any of them.
 */

function createMocks({
  method = 'GET',
  query = {},
}: { method?: string; query?: Record<string, unknown> } = {}) {
  const req = {
    method,
    query,
    headers: {},
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as Record<string, unknown>;
  let statusCode = 200;
  let payload: unknown;
  const headers: Record<string, string> = {};
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    end() {
      return res;
    },
    _status: () => statusCode,
    _json: () => payload,
    _headers: () => headers,
  };
  return { req, res };
}

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

class ForbiddenError extends Error {
  readonly status = 403 as const;
}

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => (req: any, res: any) => {
    req.blockClaims = claimsBox.claims;
    return handler(req, res);
  },
  parseSubjectUserId: (sub: string): number | null => {
    if (sub === 'anon') return null;
    if (!/^user:\d+$/.test(sub)) throw new ForbiddenError('malformed sub claim');
    return Number.parseInt(sub.slice('user:'.length), 10);
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: any) => h }));

const {
  mockGetAll,
  mockItemCount,
  mockUserCollections,
  mockHydrate,
  mockFollowed,
  mockRate,
  mockMaturity,
  mockFallbackCovers,
  mockPlayableSample,
  mockRanking,
} = vi.hoisted(() => ({
  mockGetAll: vi.fn(),
  mockItemCount: vi.fn(),
  mockUserCollections: vi.fn(),
  mockHydrate: vi.fn(),
  mockFollowed: vi.fn(),
  mockRate: vi.fn(),
  mockMaturity: vi.fn(),
  mockFallbackCovers: vi.fn(),
  mockPlayableSample: vi.fn(),
  mockRanking: vi.fn(),
}));

vi.mock('~/server/services/collection.service', () => ({
  getAllCollections: mockGetAll,
  getCollectionItemCount: mockItemCount,
  getUserCollectionsWithPermissions: mockUserCollections,
}));
vi.mock('~/server/services/blocks/block-collections.service', () => ({
  hydrateBlockSubject: mockHydrate,
  getFollowedCollectionIds: mockFollowed,
  getFallbackCoverImages: mockFallbackCovers,
  getCollectionPlayableSample: mockPlayableSample,
  toCoverFields: (img: any) => {
    const coverImageUrl = img?.url ? `edge:${img.url}` : null;
    if (coverImageUrl === null) return { coverImageUrl: null };
    return { coverImageUrl, coverNsfwLevel: img?.nsfwLevel ?? 0 };
  },
  collectionWithinCeiling: (nsfwLevel: number, level: number) =>
    !nsfwLevel || (nsfwLevel & level) !== 0,
}));
/**
 * 🔴 ONLY the ranking call is doubled. `isWindowedPeriod` stays REAL — it is the
 * predicate that decides which periods ClickHouse may serve, i.e. the rule under
 * test. Stubbing it would let the double decide the answer.
 */
vi.mock('~/server/services/blocks/block-collection-popularity.service', async (importOriginal) => {
  const actual = await importOriginal<typeof PopularityService>();
  return { ...actual, getWindowedCollectionRanking: mockRanking };
});
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
import { CollectionSort } from '~/server/common/enums';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

type Fixture = {
  id: number;
  read: 'Public' | 'Private' | 'Unlisted';
  type: 'Image' | 'Model' | 'Post' | 'Article';
  nsfwLevel?: number;
};

/**
 * The collection table this suite's `getAllCollections` double reads.
 *
 * The shape is taken from the live population measured on the production replica
 * 2026-09-11: over the Month window's top 1,000 ranked ids, 100% were `Public` but
 * only 81 were `Image` — 914 were `Model`. So the interesting reject here is a
 * TYPE reject, and the fixture leads with one, with a private collection alongside
 * it because ClickHouse cannot tell them apart either.
 */
const TABLE: Fixture[] = [
  { id: 500, read: 'Private', type: 'Image' },
  { id: 501, read: 'Public', type: 'Model' },
  { id: 502, read: 'Public', type: 'Image' },
  { id: 503, read: 'Unlisted', type: 'Image' },
  { id: 504, read: 'Public', type: 'Article' },
  { id: 505, read: 'Public', type: 'Image' },
  { id: 506, read: 'Public', type: 'Image' },
  { id: 507, read: 'Public', type: 'Image' },
];

/**
 * A FAITHFUL double for `getAllCollections`: it applies `ids`, `privacy` and
 * `types` exactly as the real service's `where` clause does, including the
 * `ids && ids.length > 0` branch that turns an EMPTY id array into "no filter at
 * all". That last detail is load-bearing — it is what makes the empty-slice guard
 * in the endpoint observable from a test instead of being a comment.
 */
function installCollectionsDouble(table: Fixture[] = TABLE) {
  mockGetAll.mockImplementation(async ({ input }: any) => {
    const { ids, privacy, types, limit, cursor } = input;
    let rows = table.slice();
    if (ids && ids.length > 0) rows = rows.filter((c) => ids.includes(c.id));
    if (privacy && privacy.length > 0) rows = rows.filter((c) => privacy.includes(c.read));
    if (types && types.length > 0) rows = rows.filter((c) => types.includes(c.type));
    if (cursor) rows = rows.filter((c) => c.id <= cursor);
    // The real service orders id-monotonically for both of its sorts; the
    // ClickHouse path re-projects onto rank order, so this only has to be STABLE
    // and deliberately NOT rank order — a handler that forgot to re-project would
    // then visibly serve the wrong order.
    rows.sort((a, b) => b.id - a.id);
    return rows.slice(0, limit).map((c) => ({
      id: c.id,
      name: `C${c.id}`,
      description: null,
      read: c.read,
      nsfwLevel: c.nsfwLevel ?? 1,
      userId: 1,
      user: { id: 1, username: 'a' },
      image: null,
    }));
  });
}

function fakeClaims(over: Partial<BlockTokenClaims> = {}): BlockTokenClaims {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
    iat: 0,
    exp: 0,
    jti: 'jti',
    blockId: 'blk',
    appId: 'app',
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_test',
    ctx: {},
    scopes: ['collections:read:self'],
    maxBrowsingLevel: 3,
    ...over,
  } as BlockTokenClaims;
}

const ids = (body: any) => body.items.map((i: any) => i.id);

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims();
  mockRate.mockResolvedValue({ allowed: true });
  mockMaturity.mockReturnValue({ browsingLevel: 3, isSfwCeiling: true });
  mockHydrate.mockResolvedValue({ id: 42, username: 'mod', isModerator: false });
  mockFollowed.mockResolvedValue(new Set<number>());
  mockFallbackCovers.mockResolvedValue(new Map());
  mockPlayableSample.mockResolvedValue(new Map());
  mockItemCount.mockResolvedValue([]);
  installCollectionsDouble();
  mockRanking.mockResolvedValue({ ids: [], source: 'clickhouse' });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE NO-CHANGE PROOF
// ─────────────────────────────────────────────────────────────────────────────

describe('an unspecified period behaves exactly as before the parameter existed', () => {
  it('emits NO period/source/sourceReason keys — the body has the pre-existing shape', async () => {
    const { req, res } = createMocks({ query: { mode: 'public', sort: 'popular', limit: '2' } });
    await handler(req as never, res as never);
    expect(res._status()).toBe(200);
    const body = res._json() as any;
    // A literal key list, not a derived one: this is the contract an existing
    // caller depends on, so it is written out rather than computed from the code.
    expect(Object.keys(body).sort()).toEqual(['items', 'nextCursor']);
    expect(body).not.toHaveProperty('period');
    expect(body).not.toHaveProperty('source');
    expect(body).not.toHaveProperty('sourceReason');
  });

  it('never consults ClickHouse', async () => {
    const { req, res } = createMocks({ query: { mode: 'public', sort: 'popular' } });
    await handler(req as never, res as never);
    expect(mockRanking).not.toHaveBeenCalled();
  });

  it('queries Postgres with the pre-existing shape: keyset cursor, requested sort, no id list', async () => {
    const { req, res } = createMocks({
      query: { mode: 'public', sort: 'popular', limit: '3', cursor: '507' },
    });
    await handler(req as never, res as never);
    const input = mockGetAll.mock.calls[0][0].input;
    expect(input.ids).toBeUndefined();
    expect(input.cursor).toBe(507);
    expect(input.sort).toBe(CollectionSort.MostContributors);
    // The unchanged over-fetch: limit * 4 + 1.
    expect(input.limit).toBe(3 * 4 + 1);
  });

  it('serves the Postgres order and the keyset cursor, not a ranking', async () => {
    const { req, res } = createMocks({ query: { mode: 'public', sort: 'popular', limit: '2' } });
    await handler(req as never, res as never);
    const body = res._json() as any;
    // The double returns Public+Image rows id-DESC: 507, 506, 505, 502.
    expect(ids(body)).toEqual([507, 506]);
    // Keyset: the first UNCONSUMED row's id, inclusive.
    expect(body.nextCursor).toBe(505);
  });

  it('mode=mine with no period is equally untouched', async () => {
    mockUserCollections.mockResolvedValue([
      { id: 9, name: 'mine', description: null, read: 'Public', userId: 42, image: null },
    ]);
    const { req, res } = createMocks({ query: { mode: 'mine' } });
    await handler(req as never, res as never);
    expect(Object.keys(res._json() as any).sort()).toEqual(['items', 'nextCursor']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. WINDOW SELECTION
// ─────────────────────────────────────────────────────────────────────────────

describe('period selects the window and ClickHouse orders the page', () => {
  it.each([MetricTimeframe.Day, MetricTimeframe.Week, MetricTimeframe.Month, MetricTimeframe.Year])(
    '%s is passed through to the ranking service as itself',
    async (period) => {
      mockRanking.mockResolvedValueOnce({ ids: [505], source: 'clickhouse' });
      const { req, res } = createMocks({ query: { mode: 'public', sort: 'popular', period } });
      await handler(req as never, res as never);
      expect(mockRanking).toHaveBeenCalledWith({ period });
      const body = res._json() as any;
      expect(body.period).toBe(period);
      expect(body.source).toBe('clickhouse');
      expect(body).not.toHaveProperty('sourceReason');
    }
  );

  it('serves the RANK order, not the order Postgres returned the rows in', async () => {
    // The double returns id-DESC (507, 506, 505). ClickHouse ranks the reverse.
    mockRanking.mockResolvedValueOnce({ ids: [505, 506, 507], source: 'clickhouse' });
    const { req, res } = createMocks({
      query: { mode: 'public', sort: 'popular', period: MetricTimeframe.Month, limit: '3' },
    });
    await handler(req as never, res as never);
    expect(ids(res._json())).toEqual([505, 506, 507]);
  });

  it('hydrates by id and does NOT ask Postgres for the expensive contributor ordering', async () => {
    mockRanking.mockResolvedValueOnce({ ids: [505, 506], source: 'clickhouse' });
    const { req, res } = createMocks({
      query: { mode: 'public', sort: 'popular', period: MetricTimeframe.Week },
    });
    await handler(req as never, res as never);
    const input = mockGetAll.mock.calls[0][0].input;
    expect(input.ids).toEqual([505, 506]);
    expect(input.cursor).toBeUndefined();
    // 🔴 The COST pin. `MostContributors` makes the service order by
    // `contributors._count` — a LEFT JOIN + GROUP BY over a table with no index on
    // `collectionId`. On this path that work is discarded by the rank re-projection,
    // so asking for it would be pure waste on the discovery front door.
    expect(input.sort).toBe(CollectionSort.Newest);
    expect(input.privacy).toEqual(['Public']);
    expect(input.types).toEqual(['Image']);
  });

  it('caps the playable-sample budget at the POSTGRES over-fetch, in RANK order', async () => {
    // 🔴 The cost pin for the wider hydrate. The sample's price scales with the id
    // count (~400 ms for 97), and this path hydrates up to 1,000 ids rather than
    // `limit * 4 + 1`. Handing every survivor to the sample would make it the most
    // expensive query on the new path — silently, and only on whichever window
    // survives filtering best.
    const many = Array.from({ length: 60 }, (_, i) => 600 + i);
    installCollectionsDouble(
      many.map((id) => ({ id, read: 'Public' as const, type: 'Image' as const }))
    );
    // Ranked in an order the double will NOT return them in (it sorts id-DESC).
    mockRanking.mockResolvedValueOnce({ ids: many, source: 'clickhouse' });
    const { req, res } = createMocks({
      query: { mode: 'public', sort: 'popular', period: MetricTimeframe.Month, limit: '2' },
    });
    await handler(req as never, res as never);
    const sampled = mockPlayableSample.mock.calls[0][0] as number[];
    // limit 2 → the Postgres over-fetch is 2 * 4 + 1 = 9, so 60 survivors are
    // trimmed to the 9 the walk could possibly reach…
    expect(sampled).toHaveLength(9);
    // …and they are the top NINE BY RANK, not the nine Postgres happened to return
    // first. Ordering the cap by the double's id-DESC output would have sampled
    // 659…651 and left the actual page-1 collections unjudged.
    expect(sampled).toEqual(many.slice(0, 9));
  });

  it('AllTime keeps the Postgres source and says so', async () => {
    const { req, res } = createMocks({
      query: { mode: 'public', sort: 'popular', period: MetricTimeframe.AllTime },
    });
    await handler(req as never, res as never);
    const body = res._json() as any;
    expect(mockRanking).not.toHaveBeenCalled();
    expect(body.source).toBe('postgres');
    expect(body.sourceReason).toBe('all-time-served-from-postgres');
    expect(mockGetAll.mock.calls[0][0].input.sort).toBe(CollectionSort.MostContributors);
  });

  it('a period on a NON-popularity sort is ignored, and the response says which source served it', async () => {
    const { req, res } = createMocks({
      query: { mode: 'public', sort: 'newest', period: MetricTimeframe.Week },
    });
    await handler(req as never, res as never);
    const body = res._json() as any;
    expect(mockRanking).not.toHaveBeenCalled();
    expect(body.source).toBe('postgres');
    expect(body.sourceReason).toBe('period-ignored-for-non-popularity-sort');
    expect(mockGetAll.mock.calls[0][0].input.sort).toBe(CollectionSort.Newest);
  });

  it('a period on mode=mine is ignored, and the response says so', async () => {
    mockUserCollections.mockResolvedValue([
      { id: 9, name: 'mine', description: null, read: 'Public', userId: 42, image: null },
    ]);
    const { req, res } = createMocks({
      query: { mode: 'mine', sort: 'popular', period: MetricTimeframe.Month },
    });
    await handler(req as never, res as never);
    const body = res._json() as any;
    expect(mockRanking).not.toHaveBeenCalled();
    expect(body.sourceReason).toBe('period-ignored-outside-public-discovery');
    expect(ids(body)).toEqual([9]);
  });

  it('rejects a period outside the five MetricTimeframe values', async () => {
    const { req, res } = createMocks({
      query: { mode: 'public', sort: 'popular', period: 'Fortnight' },
    });
    await handler(req as never, res as never);
    expect(res._status()).toBe(400);
    expect((res._json() as any).details.fieldErrors).toHaveProperty('period');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE LEAK GUARD
// ─────────────────────────────────────────────────────────────────────────────

describe('no private and no non-Image collection can reach the response via ClickHouse', () => {
  it('drops a PRIVATE collection that ClickHouse ranked FIRST', async () => {
    // 500 is Private, 503 is Unlisted. ClickHouse has no idea and ranks them top.
    mockRanking.mockResolvedValueOnce({ ids: [500, 503, 505, 506], source: 'clickhouse' });
    const { req, res } = createMocks({
      query: { mode: 'public', sort: 'popular', period: MetricTimeframe.Month, limit: '10' },
    });
    await handler(req as never, res as never);
    const body = res._json() as any;
    expect(ids(body)).toEqual([505, 506]);
    expect(ids(body)).not.toContain(500);
    expect(ids(body)).not.toContain(503);
  });

  it('drops a MODEL / ARTICLE collection that ClickHouse ranked first', async () => {
    // The dominant live reject: 914 of the top 1,000 ranked ids are Model collections.
    mockRanking.mockResolvedValueOnce({ ids: [501, 504, 507], source: 'clickhouse' });
    const { req, res } = createMocks({
      query: { mode: 'public', sort: 'popular', period: MetricTimeframe.Month, limit: '10' },
    });
    await handler(req as never, res as never);
    expect(ids(res._json())).toEqual([507]);
  });

  it('asks Postgres for the Public+Image predicates over exactly the ranked ids', async () => {
    mockRanking.mockResolvedValueOnce({ ids: [500, 501, 502], source: 'clickhouse' });
    const { req, res } = createMocks({
      query: { mode: 'public', sort: 'popular', period: MetricTimeframe.Day },
    });
    await handler(req as never, res as never);
    const input = mockGetAll.mock.calls[0][0].input;
    expect(input.privacy).toEqual(['Public']);
    expect(input.types).toEqual(['Image']);
    expect(input.ids).toEqual([500, 501, 502]);
  });

  it('a rejected id still ADVANCES the cursor — the feed cannot loop on it', async () => {
    // limit 1: the page fills on 505, having walked past the two rejects before it.
    mockRanking.mockResolvedValueOnce({ ids: [500, 501, 505, 506], source: 'clickhouse' });
    const { req, res } = createMocks({
      query: { mode: 'public', sort: 'popular', period: MetricTimeframe.Month, limit: '1' },
    });
    await handler(req as never, res as never);
    const body = res._json() as any;
    expect(ids(body)).toEqual([505]);
    // Three ranked ids consumed (500, 501, 505) → the next page starts at offset 3.
    expect(body.nextCursor).toBe(3);
  });

  it('a page that filters to EMPTY still advances, rather than terminating the feed', async () => {
    // 🔴 THE SHAPE THAT MATTERS IS A *PARTIAL* SLICE. At limit 1 the hydrate window
    // is 1 * 24 + 1 = 25 ids, so a 40-deep ranking whose first 25 entries are all
    // rejects produces an empty page with 15 ranked ids still to come. If the
    // cursor did not advance past the rejects the feed would re-serve the same
    // dead window forever; if it terminated instead, the 15 remaining ids —
    // including every showable one — would be unreachable.
    const deadIds = Array.from({ length: 30 }, (_, i) => 9000 + i); // absent from TABLE
    mockRanking.mockResolvedValueOnce({
      ids: [...deadIds, 505, 506, 507, 502, 500, 501, 503, 504, 9100, 9101],
      source: 'clickhouse',
    });
    const { req, res } = createMocks({
      query: { mode: 'public', sort: 'popular', period: MetricTimeframe.Month, limit: '1' },
    });
    await handler(req as never, res as never);
    const body = res._json() as any;
    expect(body.items).toEqual([]);
    // The whole 25-id slice was walked and more leaderboard remains → a cursor.
    expect(body.nextCursor).toBe(25);

    // …and following it reaches the showable collections that sat behind the wall.
    const next = createMocks({
      query: {
        mode: 'public',
        sort: 'popular',
        period: MetricTimeframe.Month,
        limit: '1',
        cursor: '25',
      },
    });
    mockRanking.mockResolvedValueOnce({
      ids: [...deadIds, 505, 506, 507, 502, 500, 501, 503, 504, 9100, 9101],
      source: 'clickhouse',
    });
    await handler(next.req as never, next.res as never);
    expect(ids(next.res._json())).toEqual([505]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PAGINATION AND THE DEGRADED PATHS
// ─────────────────────────────────────────────────────────────────────────────

describe('offset pagination over the bounded leaderboard', () => {
  it('the cursor is an OFFSET into the ranking, and resumes past what was shown', async () => {
    mockRanking.mockResolvedValue({ ids: [505, 506, 507, 502], source: 'clickhouse' });
    const first = createMocks({
      query: { mode: 'public', sort: 'popular', period: MetricTimeframe.Month, limit: '2' },
    });
    await handler(first.req as never, first.res as never);
    const page1 = first.res._json() as any;
    expect(ids(page1)).toEqual([505, 506]);
    expect(page1.nextCursor).toBe(2);

    const second = createMocks({
      query: {
        mode: 'public',
        sort: 'popular',
        period: MetricTimeframe.Month,
        limit: '2',
        cursor: String(page1.nextCursor),
      },
    });
    await handler(second.req as never, second.res as never);
    const page2 = second.res._json() as any;
    // No overlap with page 1 and no gap.
    expect(ids(page2)).toEqual([507, 502]);
    expect(page2.nextCursor).toBeUndefined();
  });

  it('exhausting the leaderboard emits NO cursor', async () => {
    mockRanking.mockResolvedValueOnce({ ids: [505, 506], source: 'clickhouse' });
    const { req, res } = createMocks({
      query: { mode: 'public', sort: 'popular', period: MetricTimeframe.Month, limit: '10' },
    });
    await handler(req as never, res as never);
    const body = res._json() as any;
    // 🔴 THE LAST THREE ASSERTIONS ARE NOT DECORATION. An absent `nextCursor` is
    // ALSO what the untouched Postgres walk emits when its source is exhausted, so
    // this test passed against the pre-`period` endpoint — measured, it was the one
    // vacuous guard in this file. Pinning the source and the id-list hydrate is
    // what makes it a claim about the ClickHouse path rather than about "no cursor".
    expect(body.nextCursor).toBeUndefined();
    expect(body.source).toBe('clickhouse');
    expect(ids(body)).toEqual([505, 506]);
    expect(mockGetAll.mock.calls[0][0].input.ids).toEqual([505, 506]);
  });

  it('a cursor past the end of the leaderboard is an empty page, NOT the whole catalogue', async () => {
    // 🔴 The guard this pins: an empty id array reaches `getAllCollections` as
    // "no id filter", which would return every public Image collection under a
    // popularity feed's banner. The endpoint must short-circuit instead.
    mockRanking.mockResolvedValueOnce({ ids: [505, 506], source: 'clickhouse' });
    const { req, res } = createMocks({
      query: {
        mode: 'public',
        sort: 'popular',
        period: MetricTimeframe.Month,
        limit: '5',
        cursor: '99',
      },
    });
    await handler(req as never, res as never);
    const body = res._json() as any;
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeUndefined();
    expect(body.source).toBe('clickhouse');
    expect(mockGetAll).not.toHaveBeenCalled();
  });
});

describe('degraded sources still serve collections, and say why', () => {
  it.each([['clickhouse-disabled' as const], ['clickhouse-error' as const]])(
    '%s falls back to the all-time Postgres ordering with a stated reason',
    async (reason) => {
      mockRanking.mockResolvedValueOnce({ ids: null, source: 'unavailable', reason });
      const { req, res } = createMocks({
        query: { mode: 'public', sort: 'popular', period: MetricTimeframe.Month, limit: '2' },
      });
      await handler(req as never, res as never);
      const body = res._json() as any;
      expect(body.source).toBe('postgres');
      expect(body.sourceReason).toBe(reason);
      // 🔴 NOT AN EMPTY GRID. The viewer still gets collections, ordered all-time.
      expect(ids(body)).toEqual([507, 506]);
      const input = mockGetAll.mock.calls[0][0].input;
      expect(input.ids).toBeUndefined();
      expect(input.sort).toBe(CollectionSort.MostContributors);
    }
  );

  it('an empty window degrades too, under its OWN reason', async () => {
    // Separable from unavailability on purpose: an empty window is far more often
    // the daily aggregate not having sealed yet than a real zero.
    mockRanking.mockResolvedValueOnce({ ids: [], source: 'clickhouse' });
    const { req, res } = createMocks({
      query: { mode: 'public', sort: 'popular', period: MetricTimeframe.Day, limit: '2' },
    });
    await handler(req as never, res as never);
    const body = res._json() as any;
    expect(body.source).toBe('postgres');
    expect(body.sourceReason).toBe('empty-window');
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('the three degrade reasons are all DISTINCT — one cannot be read as another', async () => {
    const reasons = new Set<string>();
    for (const r of [
      { ids: null, source: 'unavailable', reason: 'clickhouse-disabled' },
      { ids: null, source: 'unavailable', reason: 'clickhouse-error' },
      { ids: [], source: 'clickhouse' },
    ]) {
      mockRanking.mockResolvedValueOnce(r as never);
      const { req, res } = createMocks({
        query: { mode: 'public', sort: 'popular', period: MetricTimeframe.Month },
      });
      await handler(req as never, res as never);
      reasons.add((res._json() as any).sourceReason);
    }
    expect(reasons.size).toBe(3);
  });
});
