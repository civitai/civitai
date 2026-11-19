import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as PlacementQueries from '@civitai/db-queries/placement';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';

// Any flag read on these paths answers false, without a Flipt client.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every placement query stubbed: their SQL is pinned in packages/civitai-db-queries/src/
// placement.db.test.ts; their rows, against a real database, in placement-reads.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/placement', async (importOriginal) => {
  const actual = await importOriginal<typeof PlacementQueries>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
// `getPlacementConfig`'s KeyValue read: no stored row, so the compiled defaults apply. Its rows,
// against a real database, are pinned in hot-reads-5.kysely-parity.test.ts.
const { getKeyValue } = vi.hoisted(() => ({ getKeyValue: vi.fn() }));
vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5>()),
  getKeyValue,
}));

import * as queries from '@civitai/db-queries/placement';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';
import { resolvePlacementSpaceFor } from '~/server/services/placement-space.service';
import {
  getPendingPlacementCounts,
  placementPriceRange,
} from '~/server/services/placement.service';
import { getCapTier, getCapTierViaKysely } from '~/server/services/subscriptions.service';
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

/** The rows each Kysely read returns. */
function givenRows({ subscriptions = [goldSubscription()], score = SCORE as number | null } = {}) {
  q.getImagePlacementTarget.mockResolvedValue({
    id: IMAGE,
    userId: OWNER,
    postId: POST,
    type: 'video',
    username: 'creator',
  } as never);
  q.getModelPlacementTarget.mockResolvedValue({ userId: OWNER, username: 'creator' } as never);
  q.listPlacementSpacesFor.mockResolvedValue([USER_SPACE] as never);
  q.countPlacements.mockImplementation(async (_db, where) => ('data' in where ? 0 : RESERVED));
  q.getUserPlacementScore.mockResolvedValue([{ score }] as never);
  q.listUserSubscriptionRows.mockResolvedValue(subscriptions as never);
  // getCapTier's Prisma read, which only a non-placement caller makes (the getCapTier cases).
  dbMock.dbWrite.customerSubscription.findMany.mockResolvedValue(subscriptions);
}

const givenChapter = ({ removed = false, status = 'Ongoing' } = {}) => {
  const removedAt = removed ? new Date('2026-10-02T00:00:00Z') : null;
  q.getChapterPlacementTarget.mockResolvedValue({
    removedAt,
    storylineId: STORYLINE,
    storylineUserId: OWNER,
    storylineStatus: status,
    storylineTosViolation: false,
    username: 'creator',
  } as never);
};

/** Every Prisma read the family used to make, so a run can be shown to make none of them. */
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

beforeEach(() => {
  resetSharedMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  getKeyValue.mockReset().mockResolvedValue(undefined);
});

it('control: the read/write identity checks below can tell the two Kysely clients apart', () => {
  expect(kyselyRead).not.toBe(kyselyWrite);
});

describe('resolvePlacementSpaceFor', () => {
  const imageSpace = () =>
    resolvePlacementSpaceFor({ surface: 'sticker', targetType: 'image', targetId: IMAGE });

  it('the config is read through Kysely on the replica', async () => {
    givenRows();
    await imageSpace();
    expect(getKeyValue.mock.calls).toEqual([[kyselyRead, 'placement:config']]);
    expect(getKeyValue.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.keyValue.findUnique).not.toHaveBeenCalled();
  });

  it('resolves an image space through Kysely only, each read on its own database', async () => {
    givenRows();
    await expect(imageSpace()).resolves.toMatchObject({
      ownerId: OWNER,
      ownerUsername: 'creator',
      mode: 'review',
      setPrice: 900,
      price: 900,
      cap: 2500,
      freeSlotCap: 8,
      freeSlots: 5,
      freeSlotsRemaining: 5 - RESERVED,
    });
    expectNoPrismaRead();

    // The owner lookup, the space rows and the cap tier decide what a placement may charge, so
    // they read the primary; the reserved count is display-only.
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
    // The reserved-slot predicate, the one the claim's in-lock count takes.
    expect(q.countPlacements.mock.calls[0][1]).toEqual({
      surface: 'sticker',
      targetType: 'image',
      targetId: IMAGE,
      free: true,
      status: { in: ['pending', 'approved'] },
    });
  });

  it('a missing image is refused', async () => {
    givenRows();
    q.getImagePlacementTarget.mockResolvedValue(undefined);
    await expect(imageSpace()).rejects.toThrow(/that image no longer exists/);
  });

  it('resolves a model space on the primary', async () => {
    givenRows();
    await expect(
      resolvePlacementSpaceFor({
        surface: 'galleryPromotion',
        targetType: 'model',
        targetId: MODEL,
      })
    ).resolves.toMatchObject({ ownerId: OWNER, ownerUsername: 'creator' });
    expect(q.getModelPlacementTarget.mock.calls[0]).toEqual([kyselyWrite, MODEL]);
    expect(q.getModelPlacementTarget.mock.calls[0][0]).toBe(kyselyWrite);
    expectNoPrismaRead();
  });

  it('a missing model is refused', async () => {
    givenRows();
    q.getModelPlacementTarget.mockResolvedValue(undefined);
    await expect(
      resolvePlacementSpaceFor({
        surface: 'galleryPromotion',
        targetType: 'model',
        targetId: MODEL,
      })
    ).rejects.toThrow(/that model no longer exists/);
  });

  const chapterSpace = () =>
    resolvePlacementSpaceFor({
      surface: 'storyline',
      targetType: 'post',
      targetId: CHAPTER_POST,
    });

  it('resolves a storyline chapter to its storyline creator and closes a completed one', async () => {
    givenRows();
    givenChapter({ status: 'Complete' });
    await expect(chapterSpace()).resolves.toMatchObject({
      ownerId: OWNER,
      ownerUsername: 'creator',
      storylineId: STORYLINE,
      mode: 'off',
    });
    expect(q.getChapterPlacementTarget.mock.calls[0]).toEqual([kyselyWrite, CHAPTER_POST]);
    expect(q.getChapterPlacementTarget.mock.calls[0][0]).toBe(kyselyWrite);
    expect(q.listPlacementSpacesFor.mock.calls[0][1]).toEqual({
      surface: 'storyline',
      levels: [
        { entityType: 'storyline', entityId: STORYLINE },
        { entityType: 'user', entityId: OWNER },
      ],
    });
    expectNoPrismaRead();
  });

  it('an ongoing chapter stays open, so the Complete case above is not the mapping hardcoding off', async () => {
    givenRows();
    givenChapter({ status: 'Ongoing' });
    const space = await chapterSpace();
    expect(space.mode).not.toBe('off');
  });

  it('a removed chapter is refused as not a chapter', async () => {
    givenRows();
    givenChapter({ removed: true });
    await expect(chapterSpace()).rejects.toThrow(STORYLINE_REFUSALS.notAChapter);
  });

  it('a post that is not a chapter is refused as not a chapter', async () => {
    givenRows();
    q.getChapterPlacementTarget.mockResolvedValue(undefined);
    await expect(chapterSpace()).rejects.toThrow(STORYLINE_REFUSALS.notAChapter);
  });
});

describe('placementPriceRange', () => {
  it('prices from the Kysely score (on the replica) and tier (on the primary)', async () => {
    givenRows();
    await expect(placementPriceRange(OWNER, 'sticker')).resolves.toMatchObject({
      max: 2500,
      freeSlotCap: 8,
      score: SCORE,
      tier: 'gold',
    });
    expect(q.getUserPlacementScore.mock.calls[0]).toEqual([kyselyRead, OWNER]);
    expect(q.getUserPlacementScore.mock.calls[0][0]).toBe(kyselyRead);
    expect(q.listUserSubscriptionRows.mock.calls[0][0]).toBe(kyselyWrite);
    expectNoPrismaRead();
  });

  it('an unknown user (no row) and a user with no score both price at score 0', async () => {
    for (const rows of [[], [{ score: null }]]) {
      givenRows({ subscriptions: [] });
      q.getUserPlacementScore.mockResolvedValue(rows as never);
      await expect(placementPriceRange(OWNER, 'sticker')).resolves.toMatchObject({
        score: 0,
        tier: 'free',
        max: 100,
      });
    }
  });
});

describe('getCapTierViaKysely (the placement path) and getCapTier', () => {
  const rows = () => [
    goldSubscription({ status: 'past_due' }), // bad state: buys no cap
    goldSubscription({ metadata: { renewalEmailSent: true } }), // no longer counts
    {
      ...goldSubscription(),
      id: 'sub-bronze',
      product: { ...goldSubscription().product, metadata: { tier: 'bronze' } },
    },
  ];

  it('reads the subscriptions from the primary and keeps every filter getCapTier applies', async () => {
    givenRows({ subscriptions: rows() });
    await expect(getCapTier(OWNER)).resolves.toBe('bronze');
    expect(q.listUserSubscriptionRows).not.toHaveBeenCalled();

    await expect(getCapTierViaKysely(OWNER)).resolves.toBe('bronze');
    expect(q.listUserSubscriptionRows.mock.calls[0][0]).toBe(kyselyWrite);
    expect(q.listUserSubscriptionRows.mock.calls[0][1]).toEqual({
      userId: OWNER,
      excludedStatuses: ['canceled', 'incomplete_expired', 'past_due', 'unpaid'],
    });
  });

  it('a good-standing gold subscription is gold, so the case above is not the port answering bronze', async () => {
    givenRows();
    await expect(getCapTierViaKysely(OWNER)).resolves.toBe('gold');
  });
});

describe('getPendingPlacementCounts', () => {
  it('the badge counts from Kysely on the replica', async () => {
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

  it('a surface with no pending rows reads 0', async () => {
    q.countPendingPlacementsBySurface.mockResolvedValue([{ surface: 'remixGallery', count: 4 }]);
    await expect(getPendingPlacementCounts({ ownerId: OWNER })).resolves.toEqual({
      sticker: 0,
      remix: 4,
    });
  });
});
