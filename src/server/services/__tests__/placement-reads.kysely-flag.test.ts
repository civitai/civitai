import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as PlacementQueries from '@civitai/db-queries/placement';

// The Kysely/Prisma switch. FLIPT_FEATURE_FLAGS stays real, so the key asserted below is the one
// production evaluates.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every placement query stubbed: their SQL is pinned in packages/civitai-db-queries/src/
// placement.db.test.ts; their rows against Prisma's are compared in the opt-in (not in CI)
// placement-reads.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/placement', async (importOriginal) => {
  const actual = await importOriginal<typeof PlacementQueries>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});

import * as queries from '@civitai/db-queries/placement';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { resolvePlacementSpaceFor } from '~/server/services/placement-space.service';
import {
  getPendingPlacementCounts,
  placementPriceRange,
} from '~/server/services/placement.service';
import { getCapTier } from '~/server/services/subscriptions.service';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);

// Pairwise-distinct, and distinct from every count and price below.
const OWNER = 7101;
const IMAGE = 7202;
const POST = 7303;
const MODEL = 7404;
const CHAPTER_POST = 7505;
const STORYLINE = 7606;
// Past the 25k band (gold: price cap 2500, free-slot cap 8), so the score and tier reads move the
// answer: with neither, the cap is 100 and the free-slot cap 1.
const SCORE = 26_000;
const RESERVED = 2;

const goldSubscription = (overrides: { status?: string; metadata?: object } = {}) => ({
  id: `sub-${overrides.status ?? 'active'}`,
  status: overrides.status ?? 'active',
  cancelAtPeriodEnd: false,
  cancelAt: null,
  canceledAt: null,
  currentPeriodStart: new Date('2026-10-01T00:00:00Z'),
  currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
  createdAt: new Date('2026-10-01T00:00:00Z'),
  endedAt: null,
  metadata: overrides.metadata ?? {},
  buzzType: 'yellow',
  product: {
    id: 'prod-gold',
    name: 'Gold',
    description: null,
    metadata: { tier: 'gold' },
    provider: 'Civitai',
    active: true,
  },
  price: {
    id: 'price-gold',
    unitAmount: 5000,
    interval: 'month',
    intervalCount: 1,
    currency: 'usd',
    active: true,
  },
});

const USER_SPACE = { entityType: 'user', mode: 'review', price: 900, freeSlots: 5, settings: {} };

/** The same facts, armed on both paths, so a difference in the answer is the port's. */
function givenBothPaths({
  subscriptions = [goldSubscription()],
  score = SCORE as number | null,
} = {}) {
  // Prisma (flag off)
  dbMock.dbWrite.image.findUnique.mockResolvedValue({
    id: IMAGE,
    userId: OWNER,
    postId: POST,
    type: 'video',
    user: { username: 'creator' },
  });
  dbMock.dbWrite.model.findUnique.mockResolvedValue({
    userId: OWNER,
    user: { username: 'creator' },
  });
  dbMock.dbWrite.placementSpace.findMany.mockResolvedValue([USER_SPACE]);
  dbMock.dbRead.placement.count.mockResolvedValue(RESERVED);
  dbMock.dbRead.$queryRaw.mockResolvedValue([{ score }]);
  dbMock.dbWrite.customerSubscription.findMany.mockResolvedValue(subscriptions);
  // Kysely (flag on)
  q.getImagePlacementTarget.mockResolvedValue({
    id: IMAGE,
    userId: OWNER,
    postId: POST,
    type: 'video',
    username: 'creator',
  } as never);
  q.getModelPlacementTarget.mockResolvedValue({ userId: OWNER, username: 'creator' } as never);
  q.listPlacementSpacesFor.mockResolvedValue([USER_SPACE] as never);
  q.countPlacements.mockResolvedValue(RESERVED);
  q.getUserPlacementScore.mockResolvedValue([{ score }] as never);
  q.listUserSubscriptionRows.mockResolvedValue(subscriptions as never);
}

const givenChapter = ({ removed = false, status = 'Ongoing' } = {}) => {
  const removedAt = removed ? new Date('2026-10-02T00:00:00Z') : null;
  dbMock.dbWrite.storylineChapter.findUnique.mockResolvedValue({
    removedAt,
    storyline: {
      id: STORYLINE,
      userId: OWNER,
      status,
      tosViolation: false,
      user: { username: 'creator' },
    },
  });
  q.getChapterPlacementTarget.mockResolvedValue({
    removedAt,
    storylineId: STORYLINE,
    storylineUserId: OWNER,
    storylineStatus: status,
    storylineTosViolation: false,
    username: 'creator',
  } as never);
};

/** Every Prisma read the family makes, so an ON run can be shown to make none of them. */
const prismaReads = () => [
  dbMock.dbWrite.image.findUnique,
  dbMock.dbWrite.model.findUnique,
  dbMock.dbWrite.storylineChapter.findUnique,
  dbMock.dbWrite.placementSpace.findMany,
  dbMock.dbRead.placement.count,
  dbMock.dbRead.placement.groupBy,
  dbMock.dbRead.$queryRaw,
  dbMock.dbWrite.customerSubscription.findMany,
];
const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));

const expectNoPrismaRead = () => {
  for (const read of prismaReads()) expect(read).not.toHaveBeenCalled();
};
const expectNoKyselyRead = () => {
  for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
};

beforeEach(() => {
  resetSharedMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
});

it('control: the read/write identity checks below can tell the two Kysely clients apart', () => {
  expect(kyselyRead).not.toBe(kyselyWrite);
});

describe('resolvePlacementSpaceFor', () => {
  const imageSpace = () =>
    resolvePlacementSpaceFor({ surface: 'sticker', targetType: 'image', targetId: IMAGE });

  it('evaluates the flag by key, with no entity or context', async () => {
    givenBothPaths();
    await imageSpace();
    expect(flag).toHaveBeenCalledWith(FLIPT_FEATURE_FLAGS.KYSELY_PLACEMENT_READS);
    // Every evaluation is by key alone, and of a key this path is known to read: the placement
    // reads' own flag, and `kysely-hot-reads-5`, which `getPlacementConfig` evaluates for its
    // KeyValue read. Any other key, or any entity/context argument, fails here.
    const KNOWN_KEYS = ['kysely-placement-reads', 'kysely-hot-reads-5'];
    for (const call of flag.mock.calls) {
      expect(call).toHaveLength(1);
      expect(KNOWN_KEYS).toContain(call[0]);
    }
  });

  it('OFF: resolves an image space through Prisma only', async () => {
    givenBothPaths();
    const space = await imageSpace();
    expect(space).toMatchObject({
      ownerId: OWNER,
      ownerUsername: 'creator',
      setPrice: 900,
      price: 900,
      cap: 2500,
      freeSlotCap: 8,
      freeSlots: 5,
      freeSlotsRemaining: 5 - RESERVED,
    });
    expect(dbMock.dbWrite.image.findUnique).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.placement.count).toHaveBeenCalledTimes(1);
    expectNoKyselyRead();
  });

  it('ON: resolves the same image space through Kysely only, each read on its own database', async () => {
    givenBothPaths();
    const off = await imageSpace();
    const prismaReservedWhere = dbMock.dbRead.placement.count.mock.calls[0][0].where;
    vi.clearAllMocks();
    flag.mockResolvedValue(true);

    await expect(imageSpace()).resolves.toEqual(off);
    expectNoPrismaRead();

    // The owner lookup, the space rows and the cap tier decide what a placement may charge, so
    // they read the primary as the Prisma path does; the reserved count is display-only.
    expect(q.getImagePlacementTarget).toHaveBeenCalledWith(kyselyWrite, IMAGE);
    expect(q.getImagePlacementTarget.mock.calls[0][0]).toBe(kyselyWrite);
    expect(q.listPlacementSpacesFor.mock.calls[0][0]).toBe(kyselyWrite);
    expect(q.listPlacementSpacesFor.mock.calls[0][1]).toEqual({
      surface: 'sticker',
      levels: [
        { entityType: 'image', entityId: IMAGE },
        { entityType: 'post', entityId: POST },
        { entityType: 'user', entityId: OWNER },
      ],
    });
    expect(q.listUserSubscriptionRows.mock.calls[0][0]).toBe(kyselyWrite);
    expect(q.getUserPlacementScore.mock.calls[0][0]).toBe(kyselyRead);
    expect(q.countPlacements.mock.calls[0][0]).toBe(kyselyRead);
    // The reserved count's twin guard: the Kysely count gets the very predicate the Prisma count
    // got, and that predicate is the reserved-slot one (pinned literally, so neither side can
    // drift with the other).
    expect(q.countPlacements.mock.calls[0][1]).toEqual(prismaReservedWhere);
    expect(prismaReservedWhere).toEqual({
      surface: 'sticker',
      targetType: 'image',
      targetId: IMAGE,
      free: true,
      status: { in: ['pending', 'approved'] },
    });
  });

  it('ON: a missing image is refused exactly as on Prisma', async () => {
    givenBothPaths();
    dbMock.dbWrite.image.findUnique.mockResolvedValue(null);
    q.getImagePlacementTarget.mockResolvedValue(undefined);
    await expect(imageSpace()).rejects.toThrow(/that image no longer exists/);
    flag.mockResolvedValue(true);
    await expect(imageSpace()).rejects.toThrow(/that image no longer exists/);
  });

  it('ON: resolves a model space to the same answer, on the primary', async () => {
    givenBothPaths();
    const modelSpace = () =>
      resolvePlacementSpaceFor({
        surface: 'galleryPromotion',
        targetType: 'model',
        targetId: MODEL,
      });
    const off = await modelSpace();
    expect(off).toMatchObject({ ownerId: OWNER, ownerUsername: 'creator' });
    flag.mockResolvedValue(true);

    await expect(modelSpace()).resolves.toEqual(off);
    expect(q.getModelPlacementTarget.mock.calls[0]).toEqual([kyselyWrite, MODEL]);
    expect(q.getModelPlacementTarget.mock.calls[0][0]).toBe(kyselyWrite);
  });

  it('ON: resolves a storyline chapter to its storyline creator and closes a completed one, as Prisma does', async () => {
    givenBothPaths();
    givenChapter({ status: 'Complete' });
    const chapterSpace = () =>
      resolvePlacementSpaceFor({
        surface: 'storyline',
        targetType: 'post',
        targetId: CHAPTER_POST,
      });
    const off = await chapterSpace();
    expect(off).toMatchObject({ ownerId: OWNER, storylineId: STORYLINE, mode: 'off' });
    flag.mockResolvedValue(true);

    await expect(chapterSpace()).resolves.toEqual(off);
    expect(q.getChapterPlacementTarget.mock.calls[0]).toEqual([kyselyWrite, CHAPTER_POST]);
    expect(q.getChapterPlacementTarget.mock.calls[0][0]).toBe(kyselyWrite);
    expect(q.listPlacementSpacesFor.mock.calls[0][1]).toEqual({
      surface: 'storyline',
      levels: [
        { entityType: 'storyline', entityId: STORYLINE },
        { entityType: 'user', entityId: OWNER },
      ],
    });
  });

  it('ON: an ongoing chapter stays open, so the Complete case above is not the mapping hardcoding off', async () => {
    givenBothPaths();
    givenChapter({ status: 'Ongoing' });
    flag.mockResolvedValue(true);
    const space = await resolvePlacementSpaceFor({
      surface: 'storyline',
      targetType: 'post',
      targetId: CHAPTER_POST,
    });
    expect(space.mode).not.toBe('off');
  });

  it('ON: a removed chapter is refused as not a chapter, as on Prisma', async () => {
    givenBothPaths();
    givenChapter({ removed: true });
    const chapterSpace = () =>
      resolvePlacementSpaceFor({
        surface: 'storyline',
        targetType: 'post',
        targetId: CHAPTER_POST,
      });
    await expect(chapterSpace()).rejects.toThrow(STORYLINE_REFUSALS.notAChapter);
    flag.mockResolvedValue(true);
    await expect(chapterSpace()).rejects.toThrow(STORYLINE_REFUSALS.notAChapter);
  });
});

describe('placementPriceRange', () => {
  it('ON: prices from the same score and tier as Prisma, score on the replica', async () => {
    givenBothPaths();
    const off = await placementPriceRange(OWNER, 'sticker');
    expect(off).toMatchObject({ max: 2500, freeSlotCap: 8, score: SCORE, tier: 'gold' });
    vi.clearAllMocks();
    flag.mockResolvedValue(true);

    await expect(placementPriceRange(OWNER, 'sticker')).resolves.toEqual(off);
    expect(q.getUserPlacementScore.mock.calls[0]).toEqual([kyselyRead, OWNER]);
    expect(q.getUserPlacementScore.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('ON: an unknown user (no row) and a user with no score both price at score 0, as on Prisma', async () => {
    for (const rows of [[], [{ score: null }]]) {
      givenBothPaths({ subscriptions: [] });
      dbMock.dbRead.$queryRaw.mockResolvedValue(rows);
      q.getUserPlacementScore.mockResolvedValue(rows as never);
      flag.mockResolvedValue(false);
      const off = await placementPriceRange(OWNER, 'sticker');
      flag.mockResolvedValue(true);
      await expect(placementPriceRange(OWNER, 'sticker')).resolves.toEqual(off);
      expect(off).toMatchObject({ score: 0, tier: 'free', max: 100 });
    }
  });
});

describe('getCapTier', () => {
  it('useKysely: reads the subscriptions from the primary and keeps every filter the Prisma path applies', async () => {
    const rows = [
      goldSubscription({ status: 'past_due' }), // bad state: buys no cap
      goldSubscription({ metadata: { renewalEmailSent: true } }), // no longer counts
      {
        ...goldSubscription(),
        id: 'sub-bronze',
        product: { ...goldSubscription().product, metadata: { tier: 'bronze' } },
      },
    ];
    givenBothPaths({ subscriptions: rows });
    const off = await getCapTier(OWNER);
    expect(off).toBe('bronze');

    await expect(getCapTier(OWNER, { useKysely: true })).resolves.toBe(off);
    expect(q.listUserSubscriptionRows.mock.calls[0][0]).toBe(kyselyWrite);
    expect(q.listUserSubscriptionRows.mock.calls[0][1]).toEqual({
      userId: OWNER,
      excludedStatuses: ['canceled', 'incomplete_expired', 'past_due', 'unpaid'],
    });
  });

  it('useKysely: a good-standing gold subscription is gold, so the case above is not the port answering bronze', async () => {
    givenBothPaths();
    await expect(getCapTier(OWNER, { useKysely: true })).resolves.toBe('gold');
  });
});

describe('getPendingPlacementCounts', () => {
  it('OFF: counts from the Prisma groupBy only', async () => {
    dbMock.dbRead.placement.groupBy.mockResolvedValue([
      { surface: 'sticker', _count: { _all: 3 } },
      { surface: 'remixGallery', _count: { _all: 4 } },
    ]);
    await expect(getPendingPlacementCounts({ ownerId: OWNER })).resolves.toEqual({
      sticker: 3,
      remix: 4,
    });
    expectNoKyselyRead();
  });

  it('ON: the same badge counts from Kysely on the replica', async () => {
    flag.mockResolvedValue(true);
    q.countPendingPlacementsBySurface.mockResolvedValue([
      { surface: 'sticker', count: 3 },
      { surface: 'remixGallery', count: 4 },
    ]);
    await expect(getPendingPlacementCounts({ ownerId: OWNER })).resolves.toEqual({
      sticker: 3,
      remix: 4,
    });
    expect(q.countPendingPlacementsBySurface.mock.calls[0]).toEqual([kyselyRead, OWNER]);
    expect(q.countPendingPlacementsBySurface.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.placement.groupBy).not.toHaveBeenCalled();
  });

  it('ON: a surface with no pending rows reads 0', async () => {
    flag.mockResolvedValue(true);
    q.countPendingPlacementsBySurface.mockResolvedValue([{ surface: 'remixGallery', count: 4 }]);
    await expect(getPendingPlacementCounts({ ownerId: OWNER })).resolves.toEqual({
      sticker: 0,
      remix: 4,
    });
  });
});
