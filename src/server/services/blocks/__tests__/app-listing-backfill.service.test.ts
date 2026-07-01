import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * App Store Listings (W13 P0) — backfill service.
 *
 * Verifies the pure AppBlock→AppListing mapping (manifest name/description
 * extraction, contentRating derivation, slug=blockId, owner resolution, the
 * #2821 external-link → off-site mapping) and the backfill invariants
 * (idempotency, no-owner guard, dryRun, P2002 tolerance).
 *
 * No DB: dbRead/dbWrite are mocked and we capture create() args. newAppListingId
 * is stubbed deterministic so assertions don't depend on the ULID.
 */

const { mockDb, ids } = vi.hoisted(() => ({
  mockDb: {
    appBlock: { findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []) },
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (args: { data: { id: string } }) => ({ id: args.data.id })),
    },
  },
  ids: { n: 0 },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => `apl_test_${++ids.n}`,
}));

type Ab = {
  id: string;
  blockId: string;
  manifest: unknown;
  contentRating: string;
  category: string | null;
  featured: boolean;
  featuredOrder: number | null;
  externalUrl: string | null;
  app: { userId: number } | null;
};

const onsite: Ab = {
  id: 'ab_1',
  blockId: 'cool-app',
  manifest: { name: 'Cool App', description: 'A cool app' },
  contentRating: 'pg',
  category: 'utility',
  featured: true,
  featuredOrder: 2,
  externalUrl: null,
  app: { userId: 42 },
};

const offsite: Ab = {
  id: 'ab_2',
  blockId: 'ext-app',
  manifest: { name: 'Ext App' },
  contentRating: 'g',
  category: null,
  featured: false,
  featuredOrder: null,
  externalUrl: 'https://ext.example.com/launch',
  app: { userId: 7 },
};

const noName: Ab = {
  id: 'ab_3',
  blockId: 'slug-only',
  manifest: {},
  contentRating: 'r',
  category: 'other',
  featured: false,
  featuredOrder: null,
  externalUrl: null,
  app: { userId: 9 },
};

function createArg(callIdx: number) {
  return (mockDb.appListing.create.mock.calls[callIdx][0] as { data: Record<string, unknown> }).data;
}

describe('backfillAppListings — mapping', () => {
  beforeEach(() => {
    ids.n = 0;
    mockDb.appBlock.findMany.mockReset().mockResolvedValue([]);
    mockDb.appListing.findUnique.mockReset().mockResolvedValue(null);
    mockDb.appListing.create
      .mockReset()
      .mockImplementation(async (args: { data: { id: string } }) => ({ id: args.data.id }));
  });

  it('maps an on-site AppBlock: slug=blockId, kind=onsite, name/description from manifest, contentRating derived, owner from app.userId', async () => {
    mockDb.appBlock.findMany.mockResolvedValue([onsite]);
    const { backfillAppListings } = await import('../app-listing-backfill.service');
    const res = await backfillAppListings();

    expect(res.created).toBe(1);
    expect(res.skipped).toBe(0);
    expect(res.byKind).toEqual({ onsite: 1, offsite: 0 });
    expect(mockDb.appListing.create).toHaveBeenCalledTimes(1);

    const data = createArg(0);
    expect(data).toMatchObject({
      id: 'apl_test_1',
      kind: 'onsite',
      slug: 'cool-app',
      name: 'Cool App',
      description: 'A cool app',
      status: 'approved',
      contentRating: 'pg',
      category: 'utility',
      featured: true,
      featuredOrder: 2,
      appBlockId: 'ab_1',
      externalUrl: null,
      connectClientId: null,
      userId: 42,
      iconId: null,
      coverId: null,
    });
  });

  it('maps the #2821 external-link AppBlock → off-site listing (externalUrl copied, no connectClientId)', async () => {
    mockDb.appBlock.findMany.mockResolvedValue([offsite]);
    const { backfillAppListings } = await import('../app-listing-backfill.service');
    const res = await backfillAppListings();

    expect(res.byKind).toEqual({ onsite: 0, offsite: 1 });
    const data = createArg(0);
    expect(data).toMatchObject({
      kind: 'offsite',
      slug: 'ext-app',
      externalUrl: 'https://ext.example.com/launch',
      connectClientId: null,
      appBlockId: 'ab_2',
      userId: 7,
      contentRating: 'g',
    });
  });

  it('falls back to slug for name and null description when manifest lacks them', async () => {
    mockDb.appBlock.findMany.mockResolvedValue([noName]);
    const { backfillAppListings } = await import('../app-listing-backfill.service');
    await backfillAppListings();
    const data = createArg(0);
    expect(data.name).toBe('slug-only');
    expect(data.description).toBeNull();
    expect(data.contentRating).toBe('r');
  });

  it('leaves assets NULL (no mandatory-asset enforcement in P0)', async () => {
    mockDb.appBlock.findMany.mockResolvedValue([onsite]);
    const { backfillAppListings } = await import('../app-listing-backfill.service');
    await backfillAppListings();
    const data = createArg(0);
    expect(data.iconId).toBeNull();
    expect(data.coverId).toBeNull();
  });
});

describe('backfillAppListings — invariants', () => {
  beforeEach(() => {
    ids.n = 0;
    mockDb.appBlock.findMany.mockReset().mockResolvedValue([]);
    mockDb.appListing.findUnique.mockReset().mockResolvedValue(null);
    mockDb.appListing.create
      .mockReset()
      .mockImplementation(async (args: { data: { id: string } }) => ({ id: args.data.id }));
  });

  it('is idempotent on appBlockId — an existing listing is skipped, not duplicated', async () => {
    mockDb.appBlock.findMany.mockResolvedValue([onsite, offsite]);
    // ab_1 already has a listing; ab_2 does not.
    mockDb.appListing.findUnique.mockImplementation(
      async (args: { where: { appBlockId: string } }) =>
        args.where.appBlockId === 'ab_1' ? { id: 'apl_existing' } : null
    );
    const { backfillAppListings } = await import('../app-listing-backfill.service');
    const res = await backfillAppListings();

    expect(res.created).toBe(1);
    expect(res.skipped).toBe(1);
    expect(mockDb.appListing.create).toHaveBeenCalledTimes(1);
    // Only the not-yet-listed ab_2 got created.
    expect(createArg(0).appBlockId).toBe('ab_2');
  });

  it('a full re-run (everything already listed) creates nothing', async () => {
    mockDb.appBlock.findMany.mockResolvedValue([onsite, offsite]);
    mockDb.appListing.findUnique.mockResolvedValue({ id: 'apl_existing' });
    const { backfillAppListings } = await import('../app-listing-backfill.service');
    const res = await backfillAppListings();
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(2);
    expect(mockDb.appListing.create).not.toHaveBeenCalled();
  });

  it('skips an AppBlock with no resolvable owner (no listing created)', async () => {
    const noOwner: Ab = { ...onsite, id: 'ab_noowner', app: null };
    mockDb.appBlock.findMany.mockResolvedValue([noOwner]);
    const { backfillAppListings } = await import('../app-listing-backfill.service');
    const res = await backfillAppListings();
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(mockDb.appListing.create).not.toHaveBeenCalled();
  });

  it('dryRun computes the plan but writes nothing', async () => {
    mockDb.appBlock.findMany.mockResolvedValue([onsite, offsite]);
    const { backfillAppListings } = await import('../app-listing-backfill.service');
    const res = await backfillAppListings({ dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.created).toBe(2);
    expect(res.byKind).toEqual({ onsite: 1, offsite: 1 });
    expect(res.createdIds).toEqual([]);
    expect(mockDb.appListing.create).not.toHaveBeenCalled();
  });

  it('tolerates a P2002 (concurrent create) — counts it as skipped, not an error', async () => {
    mockDb.appBlock.findMany.mockResolvedValue([onsite]);
    mockDb.appListing.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );
    const { backfillAppListings } = await import('../app-listing-backfill.service');
    const res = await backfillAppListings();
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
  });

  it('isolates a non-P2002 row error — collects it in failed[] and continues the batch', async () => {
    // Two rows: ab_1 throws a non-P2002 (e.g. a content_rating CHECK / FK
    // violation on a legacy block); ab_2 must still be created. One poison row
    // must NOT abort the whole batch (per-row isolation).
    mockDb.appBlock.findMany.mockResolvedValue([onsite, offsite]);
    mockDb.appListing.create
      .mockRejectedValueOnce(new Error('content_rating check violation'))
      .mockImplementation(async (args: { data: { id: string } }) => ({ id: args.data.id }));
    const { backfillAppListings } = await import('../app-listing-backfill.service');
    const res = await backfillAppListings();

    expect(res.created).toBe(1);
    expect(res.skipped).toBe(0);
    expect(res.failed).toEqual([{ appBlockId: 'ab_1', error: 'content_rating check violation' }]);
    // The second row was still created despite the first failing.
    expect(createArg(1).appBlockId).toBe('ab_2');
  });

  it('mapAppBlockToListing throws on a null owner (misuse outside the guarded path)', async () => {
    const { mapAppBlockToListing } = await import('../app-listing-backfill.service');
    const noOwner: Ab = { ...onsite, id: 'ab_noowner', app: null };
    expect(() => mapAppBlockToListing(noOwner)).toThrow(/no resolvable owner/);
  });

  it('forwards the limit to findMany (take)', async () => {
    mockDb.appBlock.findMany.mockResolvedValue([]);
    const { backfillAppListings } = await import('../app-listing-backfill.service');
    await backfillAppListings({ limit: 5 });
    const arg = mockDb.appBlock.findMany.mock.calls[0][0] as { take?: number; where: unknown };
    expect(arg.take).toBe(5);
    expect(arg.where).toEqual({ status: 'approved' });
  });
});

describe('pure mappers', () => {
  it('resolveListingName prefers manifest.name, falls back to blockId', async () => {
    const { resolveListingName } = await import('../app-listing-backfill.service');
    expect(resolveListingName({ name: 'Foo' }, 'slug')).toBe('Foo');
    expect(resolveListingName({ name: '  ' }, 'slug')).toBe('slug');
    expect(resolveListingName({}, 'slug')).toBe('slug');
    expect(resolveListingName(null, 'slug')).toBe('slug');
    expect(resolveListingName({ name: 123 }, 'slug')).toBe('slug');
  });

  it('resolveListingDescription returns the string or null', async () => {
    const { resolveListingDescription } = await import('../app-listing-backfill.service');
    expect(resolveListingDescription({ description: 'hi' })).toBe('hi');
    expect(resolveListingDescription({ description: '' })).toBeNull();
    expect(resolveListingDescription({})).toBeNull();
    expect(resolveListingDescription(null)).toBeNull();
  });

  it('mapAppBlockToListing sets kind from externalUrl presence', async () => {
    const { mapAppBlockToListing } = await import('../app-listing-backfill.service');
    expect(mapAppBlockToListing(onsite).kind).toBe('onsite');
    expect(mapAppBlockToListing(offsite).kind).toBe('offsite');
  });
});
