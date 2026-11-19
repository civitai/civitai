import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getStoreVisibleOffsiteDestination` — the ONLY source of a `/apps/go/<listingId>` redirect
 * target, exercised against the REAL service function (the visit-service suite fakes it).
 *
 * Pinned: an on-site listing, a non-https / missing URL, a listing the viewer's audience floor
 * does not admit, a non-approved one and a dark store surface all yield null; a valid off-site
 * listing yields exactly its STORED url. Each refusal is paired with a positive control on the
 * same fixture so a null cannot come from a harness that never resolves anything.
 *
 * Same seam as `app-listing-visibility.store-and.test.ts`: the canonical shared DB mock from the
 * global test setup (no per-file mock of the DB client — see docs/testing/shared-module-mocks.md),
 * with the `appListing` delegate and `$queryRaw` (the guarded level read) faked per case.
 */
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (src: string) => src }));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600, sm: 180 } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache:
    () =>
    async (sql: unknown): Promise<unknown[]> =>
      dbMock.dbRead.$queryRaw(sql),
  bustCacheTag: vi.fn(async () => undefined),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  getStoreVisibleListingSummary,
  getStoreVisibleOffsiteDestination,
} from '../app-listing.service';
import type { AppListingVisibility } from '~/shared/utils/app-listing-visibility';

const listing = dbMock.dbRead.appListing;
let seededVisibility: AppListingVisibility | null = 'public';

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'apl_go',
    kind: 'offsite',
    slug: 'go-app',
    name: 'Go App',
    tagline: 't',
    description: 'body',
    category: null,
    contentRating: null,
    externalUrl: 'https://example.com/app',
    connectClientId: null,
    connectRequestedScopes: null,
    appBlockId: null,
    status: 'approved',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    icon: null,
    cover: null,
    user: { id: 7, username: 'dev', image: null },
    appBlock: null,
    ...over,
  };
}

const isLevelRead = (stmt: unknown) =>
  typeof (stmt as { sql?: unknown })?.sql === 'string' &&
  (stmt as { sql: string }).sql.includes('SELECT "visibility" FROM "app_listings"');

const OPEN = { redCapable: false, scope: 'full' as const, viewerBrowsingLevel: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  seededVisibility = 'public';
  listing.findFirst.mockImplementation(async () => row());
  dbMock.dbRead.$queryRaw.mockImplementation(async (stmt: unknown) =>
    isLevelRead(stmt) ? [{ visibility: seededVisibility }] : []
  );
});

describe('getStoreVisibleOffsiteDestination', () => {
  it('a visible OFF-SITE listing yields its STORED url, looked up by id', async () => {
    await expect(
      getStoreVisibleOffsiteDestination('apl_go', { ...OPEN, floor: 'public' })
    ).resolves.toEqual({ id: 'apl_go', url: 'https://example.com/app' });
    const where = (listing.findFirst.mock.calls[0]?.[0] as { where?: Record<string, unknown> })
      ?.where;
    expect(where).toMatchObject({ id: 'apl_go', revisionOfId: null });
    expect(where).not.toHaveProperty('slug');
  });

  it('an ON-SITE listing yields null — though the same row passes the visibility gate', async () => {
    listing.findFirst.mockImplementation(async () =>
      row({
        kind: 'onsite',
        appBlockId: 'apb_1',
        externalUrl: null,
        appBlock: { currentVersionDeployedAt: new Date('2026-01-02') },
      })
    );
    // POSITIVE CONTROL: the gate itself admits this row, so the null below comes from the
    // off-site checks. With no URL, the https check ALSO refuses it — measured: removing the
    // `kind !== 'offsite'` check leaves this case green. The next case is the one that
    // isolates the kind check (it went red under that mutation).
    await expect(
      getStoreVisibleListingSummary({ id: 'apl_go' }, { ...OPEN, floor: 'public' })
    ).resolves.not.toBeNull();
    await expect(
      getStoreVisibleOffsiteDestination('apl_go', { ...OPEN, floor: 'public' })
    ).resolves.toBeNull();
  });

  it('an on-site row that still carries an https externalUrl is refused by KIND, not by URL', async () => {
    // The URL check alone cannot refuse this one: only the kind check can.
    listing.findFirst.mockImplementation(async () =>
      row({
        kind: 'onsite',
        appBlockId: 'apb_1',
        externalUrl: 'https://example.com/app',
        appBlock: { currentVersionDeployedAt: new Date('2026-01-02') },
      })
    );
    await expect(
      getStoreVisibleListingSummary({ id: 'apl_go' }, { ...OPEN, floor: 'public' })
    ).resolves.not.toBeNull();
    await expect(
      getStoreVisibleOffsiteDestination('apl_go', { ...OPEN, floor: 'public' })
    ).resolves.toBeNull();
  });

  it.each([
    ['an http:// URL', 'http://example.com/app'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['no URL', null],
  ])('%s yields null', async (_label, externalUrl) => {
    listing.findFirst.mockImplementation(async () => row({ externalUrl }));
    await expect(
      getStoreVisibleOffsiteDestination('apl_go', { ...OPEN, floor: 'public' })
    ).resolves.toBeNull();
  });

  it('a listing whose audience level the viewer floor does not admit yields null', async () => {
    seededVisibility = 'moderators';
    await expect(
      getStoreVisibleOffsiteDestination('apl_go', { ...OPEN, floor: 'public' })
    ).resolves.toBeNull();
    // POSITIVE CONTROL: the same row resolves for a floor that admits it.
    await expect(
      getStoreVisibleOffsiteDestination('apl_go', { ...OPEN, floor: 'moderators' })
    ).resolves.toEqual({ id: 'apl_go', url: 'https://example.com/app' });
  });

  it('a non-approved listing yields null', async () => {
    seededVisibility = null;
    listing.findFirst.mockImplementation(async () => row({ status: 'draft' }));
    await expect(
      getStoreVisibleOffsiteDestination('apl_go', { ...OPEN, floor: 'public' })
    ).resolves.toBeNull();
  });

  it('a dark store surface yields null without reading the row', async () => {
    await expect(
      getStoreVisibleOffsiteDestination('apl_go', { ...OPEN, scope: 'none', floor: 'moderators' })
    ).resolves.toBeNull();
    expect(listing.findFirst).not.toHaveBeenCalled();
  });

  it('a missing listing yields null', async () => {
    listing.findFirst.mockImplementation(async () => null);
    await expect(
      getStoreVisibleOffsiteDestination('apl_missing', { ...OPEN, floor: 'public' })
    ).resolves.toBeNull();
  });
});
