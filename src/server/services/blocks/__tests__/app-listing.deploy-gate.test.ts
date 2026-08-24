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
    // App Listing COLLABORATORS: `getAppListingDetail` now hydrates the PUBLIC BYLINE
    // (accepted + displayed collaborators) alongside the listing. Both reads go through
    // `safeCollaboratorQuery`, which swallows ONLY the missing-TABLE error — so an
    // absent mock surfaces as a TypeError instead of being silently absorbed. Empty
    // here: these suites assert the pre-collaborator projection, which must be
    // byte-identical when an app has no seats.
    appCollaborator: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    appListing: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      // The MANUAL-APPLY `source_repo_url` column is read through its OWN guarded
      // `findUnique` (app-listing-source-repo.service) — never via
      // `listingHydrateSelect`, which the public /apps GRID shares. Mocked here so the
      // seam is exercised; `null` = "no source repo set", the default for these rows.
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ sourceRepoUrl: null })),
    },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (src: string) => src }));
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
    // `updatedAt` is a NOT-NULL Prisma column on every real row; the detail
    // projection reads it for the header's "Updated:" meta line. Fixed value so
    // the projection's ISO output is deterministic.
    updatedAt: new Date('2026-03-04T05:06:07.000Z'),
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
    // `updatedAt` is a NOT-NULL Prisma column on every real row; the detail
    // projection reads it for the header's "Updated:" meta line. Fixed value so
    // the projection's ISO output is deterministic.
    updatedAt: new Date('2026-03-04T05:06:07.000Z'),
    appBlock: null,
    screenshots: [],
    ...over,
  };
}

const ONSITE_DEPLOY_GATE = /al\.kind <> 'onsite' OR ab\.current_version_deployed_at IS NOT NULL/i;

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
    expect(await getListingDetail({ slug: 'cool-app' }, { scope: 'full' })).toBeNull();
  });

  it('SHOWS a deployed ONSITE listing', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...onsiteRow(), status: 'approved' });
    const detail = await getListingDetail({ slug: 'cool-app' }, { scope: 'full' });
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
    expect(await getListingDetail({ slug: 'cool-app' }, { scope: 'full' })).not.toBeNull();
  });

  it('SHOWS an OFFSITE listing (no backing AppBlock/deploy — exempt)', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...offsiteRow(), status: 'approved' });
    const detail = await getListingDetail({ slug: 'ext-app' }, { scope: 'full' });
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe('apl_2');
  });
});

// ---------------------------------------------------------------------------
// SOURCE REPOSITORY — the manual-apply column, END TO END through the PUBLIC read
// ---------------------------------------------------------------------------

describe('🔴 getListingDetail degrades rather than 500ing when source_repo_url is UNAPPLIED', () => {
  beforeEach(() => {
    mockDbRead.appListing.findFirst.mockReset();
    mockDbRead.appListing.findUnique.mockReset();
  });

  it('POSITIVE CONTROL: it serves the column when the migration IS applied', async () => {
    // Without this, a read hardcoded to `null` would satisfy the degradation case below
    // and the guard would look tested while providing nothing.
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...onsiteRow(), status: 'approved' });
    mockDbRead.appListing.findUnique.mockResolvedValueOnce({
      sourceRepoUrl: 'https://github.com/civitai/cool-app',
    });
    const detail = await getListingDetail({ slug: 'cool-app' }, { scope: 'full' });
    expect(detail?.sourceRepoUrl).toBe('https://github.com/civitai/cool-app');
  });

  it('the WHOLE public detail read still succeeds, with the field null, on P2022', async () => {
    // The failure mode this prevents: `sourceRepoUrl: true` inside `listingHydrateSelect`
    // makes the missing column throw for the ENTIRE query, so /apps/<slug> 500s from the
    // moment the code deploys until a human runs the SQL. Here the column is read
    // separately and its absence costs exactly one field.
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...onsiteRow(), status: 'approved' });
    mockDbRead.appListing.findUnique.mockRejectedValueOnce(
      Object.assign(new Error('The column `source_repo_url` does not exist'), { code: 'P2022' })
    );

    const detail = await getListingDetail({ slug: 'cool-app' }, { scope: 'full' });

    expect(detail).not.toBeNull();
    expect(detail?.sourceRepoUrl).toBeNull();
    // Everything else still projects — the degradation is ONE field, not the page.
    expect(detail?.slug).toBe('cool-app');
    expect(detail?.name).toBe('Cool App');
    expect(detail?.screenshots).toBeDefined();
    expect(detail?.kindData.kind).toBe('onsite');
  });

  it('🔴 a NON-column error still propagates — a dead database must not read as "no repo"', async () => {
    // The guard is narrow on purpose. Swallowing a connection failure here would turn a
    // real outage into a quietly missing field, which is the opposite of the point.
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...onsiteRow(), status: 'approved' });
    const boom = Object.assign(new Error('Can’t reach database server'), { code: 'P1001' });
    mockDbRead.appListing.findUnique.mockRejectedValueOnce(boom);

    await expect(getListingDetail({ slug: 'cool-app' }, { scope: 'full' })).rejects.toBe(boom);
  });

  it('the guarded read asks for THAT COLUMN ONLY, keyed on the row being projected', async () => {
    mockDbRead.appListing.findFirst.mockResolvedValueOnce({ ...onsiteRow(), status: 'approved' });
    mockDbRead.appListing.findUnique.mockResolvedValueOnce({ sourceRepoUrl: null });
    await getListingDetail({ slug: 'cool-app' }, { scope: 'full' });
    expect(mockDbRead.appListing.findUnique).toHaveBeenCalledWith({
      where: { id: 'apl_1' },
      select: { sourceRepoUrl: true },
    });
  });

  it('🔴 the LIST path never touches the column at all', async () => {
    // The grid does not render a Source row, and the column is manual-apply — so the
    // hot list read must not acquire a dependency on it, either through the shared
    // select or through a per-row guarded probe (which would be an N+1).
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ id: 'apl_1', sort_key: 'k' }]);
    mockDbRead.appListing.findMany.mockResolvedValueOnce([onsiteRow()]);
    await listAvailableListings({ kind: 'all', sort: 'newest', limit: 20 });
    expect(mockDbRead.appListing.findUnique).not.toHaveBeenCalled();
    const select = (
      mockDbRead.appListing.findMany.mock.calls.at(-1)?.[0] as {
        select?: Record<string, unknown>;
      }
    )?.select;
    expect(select).toBeDefined();
    expect(select).not.toHaveProperty('sourceRepoUrl');
  });
});
