import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Store Listings (W13) — P2a unified store READ PATH tests.
 *
 * Covers the public-allowlist projections + query building for
 * `app-listing.service` (the `AppListing`-backed twin of the AppBlock
 * marketplace read path). We do NOT hit a DB — `dbRead.$queryRaw` (the keyset
 * id page) and `dbRead.appListing.findMany/findFirst` (the hydration) are mocked
 * so we can assert both the projected wire SHAPE (no internal-field leaks) and
 * the SQL the service builds (approved-only, kind/category filters, sort +
 * keyset). `getEdgeUrl` is mocked to identity so URL fields echo the stored key.
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    appListing: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
// getEdgeUrl → identity so URL fields assert against the stored key.
vi.mock('~/client-utils/cf-images-utils', () => ({ getEdgeUrl: (src: string) => src }));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600 } }));
// queryCache → passthrough to the mocked $queryRaw (no Redis in unit tests).
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache:
    () =>
    async (sql: unknown): Promise<unknown[]> =>
      mockDbRead.$queryRaw(sql),
}));

import {
  decodeListingCursor,
  encodeListingCursor,
  getListingDetail,
  listAvailableListings,
  projectListingCard,
  projectListingDetail,
  recommendRollup,
  resolveOffsiteSubKind,
} from '../app-listing.service';
import { listAppListingsSchema } from '~/server/schema/blocks/app-listing-read.schema';

const SEP = String.fromCharCode(31);

/** Reconstruct the SQL string Prisma received (single Prisma.Sql arg). */
function capturedSql(): string {
  const last = mockDbRead.$queryRaw.mock.calls.at(-1);
  const first = last?.[0] as { sql?: unknown } | undefined;
  return first && typeof first.sql === 'string' ? first.sql : '';
}

/** The bound parameter values of the last $queryRaw call. */
function capturedValues(): unknown[] {
  const last = mockDbRead.$queryRaw.mock.calls.at(-1);
  const first = last?.[0] as { values?: unknown[] } | undefined;
  return first?.values ?? [];
}

/** A fully-hydrated onsite listing row (as `listingHydrateSelect` returns). */
function hydratedRow(over: Record<string, unknown> = {}) {
  return {
    id: 'apl_1',
    kind: 'onsite',
    slug: 'cool-app',
    name: 'Cool App',
    tagline: 'Does cool things',
    description: '# Cool app\n\nbody',
    category: 'utility',
    contentRating: 'pg',
    externalUrl: null,
    connectClientId: null,
    appBlockId: 'ab_1',
    icon: { url: 'icon-key' },
    cover: { url: 'cover-key' },
    user: { id: 7, username: 'dev', image: 'avatar-key' },
    metric: { thumbsUpCount: 9, thumbsDownCount: 1 },
    appBlock: {
      manifest: {
        name: 'Cool App',
        page: { path: '/run' },
        // internal fields that must NEVER reach a public DTO:
        trustTier: 'internal',
        iframe: { src: 'https://cool.internal.example/', sandbox: 'allow-scripts' },
        scopes: ['ai:write:budgeted'],
        settings: { apiKey: 'super-secret' },
      },
    },
    screenshots: [{ caption: 'first shot', image: { url: 'shot-0' } }],
    ...over,
  };
}

describe('recommendRollup', () => {
  it('computes counts + pct from the metric rollup', () => {
    expect(recommendRollup({ thumbsUpCount: 9, thumbsDownCount: 1 })).toEqual({
      recommendedCount: 9,
      notRecommendedCount: 1,
      recommendPct: 0.9,
    });
  });

  it('returns 0/0/null when the metric row is absent (P5-populated)', () => {
    expect(recommendRollup(null)).toEqual({
      recommendedCount: 0,
      notRecommendedCount: 0,
      recommendPct: null,
    });
    expect(recommendRollup(undefined)).toEqual({
      recommendedCount: 0,
      notRecommendedCount: 0,
      recommendPct: null,
    });
  });

  it('recommendPct is null (not 0) when there are zero reviews', () => {
    expect(recommendRollup({ thumbsUpCount: 0, thumbsDownCount: 0 }).recommendPct).toBeNull();
  });
});

describe('resolveOffsiteSubKind', () => {
  it('connect when a connect client is set, external-link otherwise', () => {
    expect(resolveOffsiteSubKind('oauth_123')).toBe('connect');
    expect(resolveOffsiteSubKind(null)).toBe('external-link');
    expect(resolveOffsiteSubKind(undefined)).toBe('external-link');
  });
});

describe('cursor encode/decode', () => {
  it('round-trips a 2-field cursor (non-top-rated sorts)', () => {
    const c = encodeListingCursor('0000000005', 'apl_9');
    expect(decodeListingCursor(c)).toEqual({
      cursorSortKey: '0000000005',
      cursorId: 'apl_9',
      cursorMean: null,
    });
  });

  it('round-trips a 3-field cursor with a pinned mean (top-rated)', () => {
    const c = encodeListingCursor('000000900', 'apl_2', 0.72);
    expect(decodeListingCursor(c)).toEqual({
      cursorSortKey: '000000900',
      cursorId: 'apl_2',
      cursorMean: 0.72,
    });
  });

  it('a malformed / empty cursor decodes to first-page (fail-open)', () => {
    expect(decodeListingCursor(undefined)).toEqual({
      cursorSortKey: null,
      cursorId: null,
      cursorMean: null,
    });
    expect(decodeListingCursor('not a real cursor!!!')).toEqual({
      cursorSortKey: null,
      cursorId: null,
      cursorMean: null,
    });
  });

  it('drops an out-of-[0,1] mean (crafted overflow guard) but keeps the keyset', () => {
    // A mean like 1e300 would flow into `round(score * SCALE)::bigint` and
    // overflow int8 (→ Postgres "bigint out of range" → 500). It is dropped to
    // null so the caller falls back to the freshly-computed global mean.
    const huge = encodeListingCursor('000000900', 'apl_2', 1e300);
    expect(decodeListingCursor(huge)).toEqual({
      cursorSortKey: '000000900',
      cursorId: 'apl_2',
      cursorMean: null,
    });
    // Large-negative mean, encoded raw (also out of range → dropped).
    const neg = Buffer.from(`000000900${SEP}apl_2${SEP}-1e300`, 'utf8').toString('base64url');
    expect(decodeListingCursor(neg).cursorMean).toBeNull();
    // A boundary in-range mean (0 and 1) is KEPT.
    expect(decodeListingCursor(encodeListingCursor('k', 'id', 0)).cursorMean).toBe(0);
    expect(decodeListingCursor(encodeListingCursor('k', 'id', 1)).cursorMean).toBe(1);
  });
});

describe('projectListingCard — public allowlist (no internal leaks)', () => {
  it('projects the exact public card allowlist', () => {
    const card = projectListingCard(hydratedRow() as never);
    expect(Object.keys(card).sort()).toEqual(
      [
        'category',
        'contentRating',
        'coverUrl',
        'creator',
        'iconUrl',
        'id',
        'kind',
        'kindData',
        'name',
        'recommend',
        'reviewCount',
        'slug',
        'tagline',
      ].sort()
    );
    expect(card).not.toHaveProperty('status');
    expect(card).not.toHaveProperty('description'); // detail-only
  });

  it('never leaks internal AppBlock manifest fields onto the card', () => {
    const card = projectListingCard(hydratedRow() as never);
    const serialized = JSON.stringify(card);
    for (const secret of ['trustTier', 'internal.example', 'super-secret', 'allow-scripts']) {
      expect(serialized, `card leaked "${secret}"`).not.toContain(secret);
    }
  });

  it('projects icon/cover URLs, creator chip, recommend rollup + reviewCount', () => {
    const card = projectListingCard(hydratedRow() as never);
    expect(card.iconUrl).toBe('icon-key');
    expect(card.coverUrl).toBe('cover-key');
    expect(card.creator).toEqual({ id: 7, username: 'dev', image: 'avatar-key' });
    expect(card.recommend).toEqual({
      recommendedCount: 9,
      notRecommendedCount: 1,
      recommendPct: 0.9,
    });
    expect(card.reviewCount).toBe(10);
  });

  it('onsite kindData carries appBlockId + hasPage (Open) when the manifest declares a page', () => {
    const card = projectListingCard(hydratedRow() as never);
    expect(card.kindData).toEqual({ kind: 'onsite', appBlockId: 'ab_1', hasPage: true });
  });

  it('onsite hasPage=false (Install) when the manifest declares no page', () => {
    const row = hydratedRow({ appBlock: { manifest: { name: 'X', targets: [] } } });
    const card = projectListingCard(row as never);
    expect(card.kindData).toEqual({ kind: 'onsite', appBlockId: 'ab_1', hasPage: false });
  });

  it('coverUrl falls back to the first screenshot when there is no cover', () => {
    const row = hydratedRow({ cover: null });
    expect(projectListingCard(row as never).coverUrl).toBe('shot-0');
  });

  it('coverUrl is null when there is no cover and no screenshot', () => {
    const row = hydratedRow({ cover: null, screenshots: [] });
    expect(projectListingCard(row as never).coverUrl).toBeNull();
  });

  it('recommend rollup is 0/0/null when the metric row is absent', () => {
    const row = hydratedRow({ metric: null });
    const card = projectListingCard(row as never);
    expect(card.recommend).toEqual({
      recommendedCount: 0,
      notRecommendedCount: 0,
      recommendPct: null,
    });
    expect(card.reviewCount).toBe(0);
  });

  it('offsite connect card: subKind=connect + externalUrl passthrough', () => {
    const row = hydratedRow({
      kind: 'offsite',
      appBlockId: null,
      appBlock: null,
      connectClientId: 'oauth_abc',
      externalUrl: null,
    });
    const card = projectListingCard(row as never);
    expect(card.kind).toBe('offsite');
    expect(card.kindData).toEqual({ kind: 'offsite', subKind: 'connect', externalUrl: null });
  });

  it('offsite external-link card: subKind=external-link + externalUrl', () => {
    const row = hydratedRow({
      kind: 'offsite',
      appBlockId: null,
      appBlock: null,
      connectClientId: null,
      externalUrl: 'https://ext.example/app',
    });
    const card = projectListingCard(row as never);
    expect(card.kindData).toEqual({
      kind: 'offsite',
      subKind: 'external-link',
      externalUrl: 'https://ext.example/app',
    });
  });

  it('a vanished owner yields a null creator chip (no crash)', () => {
    const row = hydratedRow({ user: null });
    expect(projectListingCard(row as never).creator).toBeNull();
  });
});

describe('projectListingDetail — public allowlist + gallery', () => {
  it('projects the detail allowlist incl. description + screenshots', () => {
    const detail = projectListingDetail(hydratedRow() as never);
    expect(Object.keys(detail).sort()).toEqual(
      [
        'category',
        'contentRating',
        'coverUrl',
        'creator',
        'description',
        'iconUrl',
        'id',
        'kind',
        'kindData',
        'name',
        'recommend',
        'reviewCount',
        'screenshots',
        'slug',
        'tagline',
      ].sort()
    );
    expect(detail).not.toHaveProperty('status');
    expect(detail.description).toBe('# Cool app\n\nbody');
  });

  it('onsite detail kindData carries appBlockId, hasPage + the computed liveUrl', () => {
    const detail = projectListingDetail(hydratedRow() as never);
    expect(detail.kindData).toEqual({
      kind: 'onsite',
      appBlockId: 'ab_1',
      hasPage: true,
      liveUrl: 'https://cool-app.civit.ai',
    });
  });

  it('offsite connect detail exposes the PUBLIC connectClientId (never a secret)', () => {
    const row = hydratedRow({
      kind: 'offsite',
      appBlockId: null,
      appBlock: null,
      connectClientId: 'oauth_abc',
      externalUrl: null,
    });
    const detail = projectListingDetail(row as never);
    expect(detail.kindData).toEqual({
      kind: 'offsite',
      subKind: 'connect',
      externalUrl: null,
      connectClientId: 'oauth_abc',
    });
  });

  it('offsite external-link detail has a null connectClientId', () => {
    const row = hydratedRow({
      kind: 'offsite',
      appBlockId: null,
      appBlock: null,
      connectClientId: null,
      externalUrl: 'https://ext.example/app',
    });
    const detail = projectListingDetail(row as never);
    expect(detail.kindData).toMatchObject({
      kind: 'offsite',
      subKind: 'external-link',
      connectClientId: null,
    });
  });

  it('the gallery excludes screenshots whose backing Image is gone (null image)', () => {
    const row = hydratedRow({
      screenshots: [
        { caption: 'a', image: { url: 's0' } },
        { caption: 'b', image: null },
        { caption: 'c', image: { url: 's2' } },
      ],
    });
    const detail = projectListingDetail(row as never);
    expect(detail.screenshots).toEqual([
      { url: 's0', caption: 'a' },
      { url: 's2', caption: 'c' },
    ]);
  });

  it('never leaks internal manifest fields onto the detail', () => {
    const serialized = JSON.stringify(projectListingDetail(hydratedRow() as never));
    for (const secret of ['trustTier', 'internal.example', 'super-secret']) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe('listAvailableListings — query building + pagination', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockClear();
    mockDbRead.appListing.findMany.mockClear();
    mockDbRead.$queryRaw.mockResolvedValue([]);
    mockDbRead.appListing.findMany.mockResolvedValue([]);
  });

  it('SQL hard-filters status = approved (draft/pending/rejected never returned)', async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 });
    expect(capturedSql()).toMatch(/al\.status\s*=\s*'approved'/);
  });

  it('SQL excludes SHADOW revision drafts (revision_of_id IS NULL) — defense in depth', async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 });
    expect(capturedSql()).toMatch(/al\.revision_of_id\s+IS\s+NULL/i);
  });

  it('kind filter binds the requested kind (onsite)', async () => {
    await listAvailableListings({ kind: 'onsite', sort: 'newest', limit: 20 });
    expect(capturedSql()).toMatch(/al\.kind\s*=/);
    expect(capturedValues()).toContain('onsite');
  });

  it("kind='all' does not bind a kind (the filter is a no-op)", async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 });
    expect(capturedValues()).not.toContain('onsite');
    expect(capturedValues()).not.toContain('offsite');
  });

  it('category filter binds the requested category', async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', category: 'games', limit: 20 });
    expect(capturedSql()).toMatch(/al\.category\s*=/);
    expect(capturedValues()).toContain('games');
  });

  it('maturity gate hides r/x when not red-capable', async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 }, { redCapable: false });
    expect(capturedSql()).toMatch(/content_rating.*NOT IN \('r', 'x'\)/i);
  });

  it('maturity gate is a no-op (TRUE) on a red-capable host', async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 }, { redCapable: true });
    expect(capturedSql()).not.toMatch(/content_rating.*NOT IN/i);
  });

  it('sort=popular orders by install count DESC (no Bayesian fragment)', async () => {
    await listAvailableListings({ kind: 'all', sort: 'popular', limit: 20 });
    const sql = capturedSql();
    expect(sql).toMatch(/lpad\(COALESCE\(m\.install_count/i);
    expect(sql).toMatch(/ORDER BY\s+sort_key\s+DESC/i);
    expect(sql).not.toMatch(/lpad\(round\(/i);
  });

  it('sort=newest orders by created_at DESC', async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 });
    const sql = capturedSql();
    expect(sql).toMatch(/to_char\(al\.created_at/i);
    expect(sql).toMatch(/ORDER BY\s+sort_key\s+DESC/i);
  });

  it('sort=name orders by LOWER(name) ASC and resumes the keyset with `>`', async () => {
    await listAvailableListings({ kind: 'all', sort: 'name', limit: 20 });
    const sql = capturedSql();
    expect(sql).toMatch(/LOWER\(al\.name\)/i);
    expect(sql).toMatch(/ORDER BY\s+sort_key\s+ASC/i);
    expect(sql).toMatch(/,\s*al\.id\)\s*>\s*\(/);
  });

  it('sort=top-rated emits the Bayesian recommend key in SELECT + keyset WHERE (no drift)', async () => {
    await listAvailableListings({ kind: 'all', sort: 'top-rated', limit: 20 });
    const sql = capturedSql();
    // The Bayesian fragment appears in the SELECT (AS sort_key) AND the keyset.
    const occurrences = sql.match(/lpad\(round\(/gi)?.length ?? 0;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(sql).toMatch(/ORDER BY\s+sort_key\s+DESC/i);
    expect(sql).toMatch(/,\s*al\.id\)\s*<\s*\(/); // DESC keyset resumes with `<`
    // Regression guard: lpad length args MUST be cast to ::int (bigint has no overload).
    expect(sql).toMatch(/lpad\(round\([\s\S]*?::int,\s*'0'\)/i);
  });

  it('returns both kinds and preserves the keyset order across hydration', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      { id: 'apl_a', sort_key: 'k2' },
      { id: 'apl_b', sort_key: 'k1' },
    ]);
    // findMany returns the rows OUT OF ORDER — the service must re-apply the id order.
    mockDbRead.appListing.findMany.mockResolvedValueOnce([
      hydratedRow({ id: 'apl_b', kind: 'offsite', appBlockId: null, appBlock: null, connectClientId: 'oc_1', slug: 'b-app' }),
      hydratedRow({ id: 'apl_a', kind: 'onsite', slug: 'a-app' }),
    ]);
    const { items } = await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 });
    expect(items.map((i) => i.id)).toEqual(['apl_a', 'apl_b']);
    expect(items.map((i) => i.kind)).toEqual(['onsite', 'offsite']);
  });

  it('emits nextCursor only when a full page+1 is returned (pagination contract)', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      { id: 'apl_0', sort_key: '20260101000000000000' },
      { id: 'apl_1', sort_key: '20260101000000000001' },
      { id: 'apl_2', sort_key: '20260101000000000002' }, // the +1 (dropped)
    ]);
    mockDbRead.appListing.findMany.mockResolvedValueOnce([
      hydratedRow({ id: 'apl_0', slug: 's0' }),
      hydratedRow({ id: 'apl_1', slug: 's1' }),
    ]);
    const { items, nextCursor } = await listAvailableListings({
      kind: 'all',
      sort: 'newest',
      limit: 2,
    });
    expect(items).toHaveLength(2);
    expect(nextCursor).toBeDefined();
    // The cursor is the LAST returned row's (sortKey, id) — carries the sort key,
    // not just the id, so a paged scan over tied sort values is stable.
    const decoded = Buffer.from(nextCursor as string, 'base64url').toString('utf8');
    expect(decoded).toBe(`20260101000000000001${SEP}apl_1`);
  });

  it('no nextCursor when the result fits in one page', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ id: 'apl_0', sort_key: 'k0' }]);
    mockDbRead.appListing.findMany.mockResolvedValueOnce([hydratedRow({ id: 'apl_0' })]);
    const { nextCursor } = await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 });
    expect(nextCursor).toBeUndefined();
  });

  it('sort=top-rated page 1 reads + PINS the global recommend mean into nextCursor', async () => {
    // Call 1 = getGlobalRecommendMean (via queryCache → $queryRaw): mean 0.8.
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ mean: 0.8 }]);
    // Call 2 = the id page (limit+1 so nextCursor is emitted).
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      { id: 'apl_0', sort_key: '000000800' },
      { id: 'apl_1', sort_key: '000000790' },
      { id: 'apl_2', sort_key: '000000780' },
    ]);
    mockDbRead.appListing.findMany.mockResolvedValueOnce([
      hydratedRow({ id: 'apl_0' }),
      hydratedRow({ id: 'apl_1' }),
    ]);
    const { nextCursor } = await listAvailableListings({ kind: 'all', sort: 'top-rated', limit: 2 });
    const decoded = Buffer.from(nextCursor as string, 'base64url').toString('utf8');
    expect(decoded).toBe(`000000790${SEP}apl_1${SEP}0.8`);
  });

  it('sort=top-rated with a pinned-mean cursor REUSES it (no global-mean re-read)', async () => {
    const cursor = Buffer.from(`000000250${SEP}apl_5${SEP}0.25`, 'utf8').toString('base64url');
    // ONLY the id-page query is queued — if the service re-read the mean it would
    // consume this and the id page would get [].
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ id: 'apl_9', sort_key: '000000240' }]);
    mockDbRead.appListing.findMany.mockResolvedValueOnce([hydratedRow({ id: 'apl_9' })]);
    const { items } = await listAvailableListings({
      kind: 'all',
      sort: 'top-rated',
      cursor,
      limit: 20,
    });
    expect(items).toHaveLength(1);
    // Exactly ONE $queryRaw (the id page) — the mean re-read was skipped.
    expect(mockDbRead.$queryRaw).toHaveBeenCalledTimes(1);
    // The pinned mean 0.25 is bound into the Bayesian key (C*m term).
    expect(capturedValues()).toContain(0.25);
  });

  it('sort=top-rated with a crafted out-of-range mean cursor does NOT 500', async () => {
    // The mean is dropped by decode (clamp), so the service re-reads the global
    // mean (call 1) then runs the id page (call 2) — nothing overflows the bigint
    // sort key. Assert the call resolves rather than throws.
    const crafted = encodeListingCursor('000000900', 'apl_2', 1e300);
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ mean: 0.8 }]); // global mean re-read
    mockDbRead.$queryRaw.mockResolvedValueOnce([]); // empty id page
    await expect(
      listAvailableListings({ kind: 'all', sort: 'top-rated', cursor: crafted, limit: 20 })
    ).resolves.toEqual({ items: [], nextCursor: undefined });
    // The huge mean never reached the SQL params (it was dropped); the safe 0.8
    // fallback is what got bound into the Bayesian key.
    expect(capturedValues()).not.toContain(1e300);
    expect(capturedValues()).toContain(0.8);

    // Also large-negative, via a raw-built cursor.
    const neg = Buffer.from(`000000900${SEP}apl_2${SEP}-1e300`, 'utf8').toString('base64url');
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ mean: 0.5 }]);
    mockDbRead.$queryRaw.mockResolvedValueOnce([]);
    await expect(
      listAvailableListings({ kind: 'all', sort: 'top-rated', cursor: neg, limit: 20 })
    ).resolves.toEqual({ items: [], nextCursor: undefined });
    expect(capturedValues()).not.toContain(-1e300);
  });

  it('sort=name bounds the sort key so a long-name nextCursor stays paginable (≤128)', async () => {
    // The name sort key is `left(LOWER(al.name), 64)` — proven in the SQL — so the
    // key encoded into the cursor is ≤64 chars and the cursor stays under the
    // `cursor: z.string().max(128)` cap even for very long names.
    await listAvailableListings({ kind: 'all', sort: 'name', limit: 20 });
    expect(capturedSql()).toMatch(/left\(LOWER\(al\.name\),\s*64\)/i);

    // A page whose last row carries the MAX (64-char) truncated key + a realistic
    // id: the emitted nextCursor must be ≤128 and round-trip, and a follow-up call
    // with it must succeed (pagination survives a >65-char name).
    const key64 = 'z'.repeat(64); // what left(lower(name),64) yields for a long name
    const longId = 'apl_' + 'c'.repeat(24); // cuid-length id
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      { id: 'apl_prev', sort_key: 'a'.repeat(64) },
      { id: longId, sort_key: key64 },
      { id: 'apl_plus1', sort_key: 'z'.repeat(64) }, // the +1 (dropped → nextCursor)
    ]);
    mockDbRead.appListing.findMany.mockResolvedValueOnce([
      hydratedRow({ id: 'apl_prev', slug: 's-prev' }),
      hydratedRow({ id: longId, slug: 's-long' }),
    ]);
    const { nextCursor } = await listAvailableListings({ kind: 'all', sort: 'name', limit: 2 });
    expect(nextCursor).toBeDefined();
    expect((nextCursor as string).length).toBeLessThanOrEqual(128);
    // The schema cap must accept it (proves pagination doesn't halt).
    expect(listAppListingsSchema.shape.cursor.parse(nextCursor)).toBe(nextCursor);
    const decoded = decodeListingCursor(nextCursor);
    expect(decoded.cursorSortKey).toBe(key64);
    expect(decoded.cursorId).toBe(longId);

    // Follow-up page 2 with that cursor resolves (keyset accepted).
    mockDbRead.$queryRaw.mockResolvedValueOnce([]);
    await expect(
      listAvailableListings({ kind: 'all', sort: 'name', cursor: nextCursor, limit: 2 })
    ).resolves.toEqual({ items: [], nextCursor: undefined });
  });

  it('returns an empty page (no hydration) when the keyset query is empty', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([]);
    const { items, nextCursor } = await listAvailableListings({
      kind: 'all',
      sort: 'newest',
      limit: 20,
    });
    expect(items).toEqual([]);
    expect(nextCursor).toBeUndefined();
    expect(mockDbRead.appListing.findMany).not.toHaveBeenCalled();
  });

  it('the list projection carries no internal-field leaks end-to-end', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ id: 'apl_0', sort_key: 'k0' }]);
    mockDbRead.appListing.findMany.mockResolvedValueOnce([hydratedRow({ id: 'apl_0' })]);
    const { items } = await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 });
    const serialized = JSON.stringify(items);
    for (const secret of ['trustTier', 'internal.example', 'super-secret', 'status']) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe('getListingDetail — approved-only + maturity gate', () => {
  beforeEach(() => {
    mockDbRead.appListing.findFirst.mockReset();
  });

  it('returns the projected detail for an approved listing (by slug)', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...hydratedRow(), status: 'approved' });
    const detail = await getListingDetail({ slug: 'cool-app' });
    expect(detail?.id).toBe('apl_1');
    // Looked up by slug.
    const where = (mockDbRead.appListing.findFirst.mock.calls.at(-1)?.[0] as { where?: unknown })
      ?.where;
    // Includes the shadow-exclusion guard (defense-in-depth).
    expect(where).toEqual({ slug: 'cool-app', revisionOfId: null });
  });

  it('looks up by id when id is provided', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...hydratedRow(), status: 'approved' });
    await getListingDetail({ id: 'apl_1' });
    const where = (mockDbRead.appListing.findFirst.mock.calls.at(-1)?.[0] as { where?: unknown })
      ?.where;
    expect(where).toEqual({ id: 'apl_1', revisionOfId: null });
  });

  it('the WHERE excludes SHADOW revision drafts (revisionOfId: null) for BOTH selectors', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...hydratedRow(), status: 'approved' });
    await getListingDetail({ slug: 'cool-app' });
    const bySlug = (mockDbRead.appListing.findFirst.mock.calls.at(-1)?.[0] as { where?: { revisionOfId?: unknown } })?.where;
    expect(bySlug?.revisionOfId).toBeNull();
  });

  it('returns null for a missing listing', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce(null);
    expect(await getListingDetail({ slug: 'nope' })).toBeNull();
  });

  it('returns null (no query) when NEITHER slug nor id is provided (enumeration guard)', async () => {
    // The zod .refine guards the tRPC boundary, but the service is exported —
    // `findFirst({ slug: undefined })` would return an arbitrary approved row.
    expect(await getListingDetail({} as never)).toBeNull();
    expect(mockDbRead.appListing.findFirst).not.toHaveBeenCalled();
  });

  it('returns null (no query) when BOTH slug and id are provided (ambiguous)', async () => {
    expect(await getListingDetail({ slug: 'cool-app', id: 'apl_1' } as never)).toBeNull();
    expect(mockDbRead.appListing.findFirst).not.toHaveBeenCalled();
  });

  it.each(['draft', 'pending', 'rejected'])('returns null for a %s listing', async (status) => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...hydratedRow(), status });
    expect(await getListingDetail({ slug: 'cool-app' })).toBeNull();
  });

  it('hides a mature (x) listing off a non-red host', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({
      ...hydratedRow({ contentRating: 'x' }),
      status: 'approved',
    });
    expect(await getListingDetail({ slug: 'cool-app' }, { redCapable: false })).toBeNull();
  });

  it('shows a mature (x) listing on a red-capable host', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({
      ...hydratedRow({ contentRating: 'x' }),
      status: 'approved',
    });
    const detail = await getListingDetail({ slug: 'cool-app' }, { redCapable: true });
    expect(detail?.contentRating).toBe('x');
  });
});
