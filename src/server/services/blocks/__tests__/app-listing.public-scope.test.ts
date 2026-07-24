import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * External-before-onsite GA (Phase 1) — the STORE-SCOPE kind gate on the
 * AppListing-backed unified store read path (`app-listing.service`).
 *
 *   - listingPublicVisibilityFilter — the pure SQL drift-guard: `full` → TRUE,
 *     `public-external` → `al.kind = 'offsite'` (BOTH sub-kinds), `none` → FALSE.
 *   - listAvailableListings — under `public-external` the keyset WHERE carries the
 *     offsite-only predicate; under `full` it carries TRUE (unchanged).
 *   - getListingDetail — under `public-external` an ONSITE listing is treated as
 *     MISSING (null), while an OFFSITE listing (either sub-kind, incl. a `connect`
 *     listing with a `connectClientId`) is shown; `full` imposes no kind gate.
 *
 * No DB in unit tests: mock `dbRead.$queryRaw` (keyset id page — capture the SQL) +
 * `dbRead.appListing.findFirst/findMany` (hydration — return seeded rows).
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
vi.mock('~/client-utils/cf-images-utils', () => ({ getEdgeUrl: (src: string) => src }));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600 } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache:
    () =>
    async (sql: unknown): Promise<unknown[]> =>
      mockDbRead.$queryRaw(sql),
}));

import {
  getListingDetail,
  listAvailableListings,
  listingPublicVisibilityFilter,
} from '../app-listing.service';

/** Reconstruct the SQL string Prisma received (single Prisma.Sql arg). */
function capturedSql(): string {
  const last = mockDbRead.$queryRaw.mock.calls.at(-1);
  const first = last?.[0] as { sql?: unknown } | undefined;
  return first && typeof first.sql === 'string' ? first.sql : '';
}

/** A hydrated ONSITE listing row (as `listingHydrateSelect` returns). */
function onsiteRow(over: Record<string, unknown> = {}) {
  return {
    id: 'apl_1',
    kind: 'onsite',
    slug: 'cool-app',
    name: 'Cool App',
    tagline: 't',
    description: 'body',
    category: 'utility',
    contentRating: 'pg',
    externalUrl: null,
    connectClientId: null,
    appBlockId: 'ab_1',
    icon: null,
    cover: null,
    user: { id: 7, username: 'dev', image: null },
    metric: null,
    appBlock: {
      currentVersionDeployedAt: new Date('2026-01-01T00:00:00Z'),
      manifest: { name: 'Cool App', page: { path: '/run' } },
    },
    screenshots: [],
    ...over,
  };
}

/** A hydrated OFFSITE external-link listing row — NO backing AppBlock. */
function offsiteExternalRow(over: Record<string, unknown> = {}) {
  return {
    id: 'apl_2',
    kind: 'offsite',
    slug: 'ext-app',
    name: 'Ext App',
    tagline: 't',
    description: 'body',
    category: 'utility',
    contentRating: 'pg',
    externalUrl: 'https://example.com/ext',
    connectClientId: null,
    appBlockId: null,
    icon: null,
    cover: null,
    user: { id: 7, username: 'dev', image: null },
    metric: null,
    appBlock: null,
    screenshots: [],
    ...over,
  };
}

/** A hydrated OFFSITE CONNECT listing row (links an OAuth client) — still offsite. */
function offsiteConnectRow(over: Record<string, unknown> = {}) {
  return offsiteExternalRow({
    id: 'apl_3',
    slug: 'connect-app',
    name: 'Connect App',
    externalUrl: null,
    connectClientId: 'oauthclient_abc',
    ...over,
  });
}

describe('listingPublicVisibilityFilter — SQL drift-guard', () => {
  it('full → TRUE (no kind restriction, byte-identical to today)', () => {
    expect(listingPublicVisibilityFilter('full').sql).toBe('TRUE');
  });

  it("public-external → al.kind = 'offsite' (both sub-kinds; NOT gated on connect_client_id)", () => {
    const sql = listingPublicVisibilityFilter('public-external').sql;
    expect(sql).toBe("al.kind = 'offsite'");
    // 🔴 the merged model: the gate is kind='offsite', NEVER connect_client_id.
    expect(sql).not.toMatch(/connect_client_id/i);
  });

  it('none → FALSE (fail-closed defense-in-depth)', () => {
    expect(listingPublicVisibilityFilter('none').sql).toBe('FALSE');
  });
});

describe('listAvailableListings — STORE-SCOPE kind gate in the keyset WHERE', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockReset();
    mockDbRead.$queryRaw.mockResolvedValue([]);
    mockDbRead.appListing.findMany.mockReset();
    mockDbRead.appListing.findMany.mockResolvedValue([]);
  });

  it("public-external → WHERE carries al.kind = 'offsite'", async () => {
    await listAvailableListings(
      { kind: 'all', sort: 'newest', limit: 20 },
      { scope: 'public-external' }
    );
    expect(capturedSql()).toMatch(/al\.kind = 'offsite'/i);
  });

  it('full → WHERE carries the TRUE predicate (no offsite narrowing)', async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 }, { scope: 'full' });
    const sql = capturedSql();
    // The TRUE predicate is ANDed; the offsite-only clause must NOT appear.
    expect(sql).not.toMatch(/al\.kind = 'offsite'/i);
  });

  it('no scope passed → defaults to full (offsite clause absent — back-compat)', async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 });
    expect(capturedSql()).not.toMatch(/al\.kind = 'offsite'/i);
  });
});

describe('getListingDetail — STORE-SCOPE kind gate (app-layer)', () => {
  beforeEach(() => {
    mockDbRead.appListing.findFirst.mockReset();
  });

  it('public-external → HIDES (null) an ONSITE listing even by a crafted id/slug', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...onsiteRow(), status: 'approved' });
    expect(await getListingDetail({ slug: 'cool-app' }, { scope: 'public-external' })).toBeNull();
  });

  it('public-external → SHOWS an OFFSITE external-link listing', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({
      ...offsiteExternalRow(),
      status: 'approved',
    });
    const detail = await getListingDetail({ slug: 'ext-app' }, { scope: 'public-external' });
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe('apl_2');
  });

  it('public-external → SHOWS an OFFSITE CONNECT listing (offsite = both sub-kinds)', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({
      ...offsiteConnectRow(),
      status: 'approved',
    });
    const detail = await getListingDetail({ slug: 'connect-app' }, { scope: 'public-external' });
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe('apl_3');
  });

  it('full → SHOWS an ONSITE listing (no kind gate — unchanged)', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...onsiteRow(), status: 'approved' });
    const detail = await getListingDetail({ slug: 'cool-app' }, { scope: 'full' });
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe('apl_1');
  });

  it('default scope (none passed) → full: ONSITE shown (back-compat)', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...onsiteRow(), status: 'approved' });
    expect(await getListingDetail({ slug: 'cool-app' })).not.toBeNull();
  });
});
