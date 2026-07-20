import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DEPLOY-GATE (generic, all app-blocks) on the AppListing-backed unified store
 * (`app-listing.service`, the twin read path):
 *
 *   - listAvailableListings — the keyset SQL must EXCLUDE an ONSITE
 *     (block-backed) listing whose backing AppBlock has never SUCCESSFULLY
 *     deployed (`current_version_deployed_at IS NULL`), while leaving OFFSITE
 *     (external-link, no AppBlock/deploy) listings UNAFFECTED (discriminate on
 *     `kind`, never on appBlockId nullness).
 *   - getListingDetail — an ONSITE listing whose backing block has never
 *     deployed is treated as MISSING (returns null); a deployed one is shown; a
 *     re-deploying one (timestamp still set) is shown; an OFFSITE listing (no
 *     backing AppBlock) is shown (exempt).
 *
 * No DB in unit tests: mock `dbRead.$queryRaw` (keyset id page — capture the
 * SQL) + `dbRead.appListing.findFirst/findMany` (hydration — return seeded rows).
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

import { getListingDetail, listAvailableListings } from '../app-listing.service';

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

/** A hydrated OFFSITE (external-link) listing row — NO backing AppBlock. */
function offsiteRow(over: Record<string, unknown> = {}) {
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

const ONSITE_DEPLOY_GATE =
  /al\.kind <> 'onsite' OR ab\.current_version_deployed_at IS NOT NULL/i;

describe('listAvailableListings — DEPLOY-GATE WHERE clause', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockReset();
    mockDbRead.$queryRaw.mockResolvedValue([]);
    mockDbRead.appListing.findMany.mockReset();
    mockDbRead.appListing.findMany.mockResolvedValue([]);
  });

  it('JOINs app_blocks and gates ONSITE rows on a non-null deploy timestamp', async () => {
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 });
    const sql = capturedSql();
    expect(sql).toMatch(/LEFT JOIN app_blocks ab ON ab\.id = al\.app_block_id/i);
    expect(sql).toMatch(ONSITE_DEPLOY_GATE);
  });
});

describe('getListingDetail — DEPLOY-GATE (app-layer)', () => {
  beforeEach(() => {
    mockDbRead.appListing.findFirst.mockReset();
  });

  it('HIDES (null) an ONSITE listing whose backing block has NEVER deployed', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({
      ...onsiteRow({ appBlock: { currentVersionDeployedAt: null, manifest: {} } }),
      status: 'approved',
    });
    expect(await getListingDetail({ slug: 'cool-app' })).toBeNull();
  });

  it('SHOWS a deployed ONSITE listing', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...onsiteRow(), status: 'approved' });
    const detail = await getListingDetail({ slug: 'cool-app' });
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe('apl_1');
  });

  it('SHOWS a RE-DEPLOYING ONSITE listing (timestamp stays set during a rebuild)', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({
      ...onsiteRow({
        appBlock: {
          currentVersionDeployedAt: new Date('2025-06-01T00:00:00Z'),
          manifest: { name: 'Cool App' },
        },
      }),
      status: 'approved',
    });
    expect(await getListingDetail({ slug: 'cool-app' })).not.toBeNull();
  });

  it('SHOWS an OFFSITE listing (no backing AppBlock/deploy — exempt)', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...offsiteRow(), status: 'approved' });
    const detail = await getListingDetail({ slug: 'ext-app' });
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe('apl_2');
  });
});
