import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as PlacementQueries from '@civitai/db-queries/placement';
import type * as PlacementModeration from '~/server/services/placement-moderation.service';
import type * as PlacementSpaceService from '~/server/services/placement-space.service';
import type { ResolvedPlacementSpace } from '~/server/services/placement-space.service';

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
vi.mock('@civitai/db-queries/placement', async (importOriginal) => {
  const actual = await importOriginal<typeof PlacementQueries>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
// `reservedFreeSlots` stays real: it is one of the in-transaction counts under test.
const { resolveSpace } = vi.hoisted(() => ({ resolveSpace: vi.fn() }));
vi.mock('~/server/services/placement-space.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementSpaceService>()),
  resolvePlacementSpaceFor: resolveSpace,
}));
vi.mock('~/server/services/placement-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementModeration>()),
  assertCanPlace: vi.fn(async () => undefined),
}));

import * as queries from '@civitai/db-queries/placement';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';
import {
  createFreePlacement,
  getFreePlacementAllowance,
  hasUsedFreePlacementOn,
} from '~/server/services/free-placement.service';
import { FREE_PLACEMENTS_PER_DAY, freePlacementDayStart } from '~/shared/utils/placement';

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);
const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));

const OWNER = 6101;
const PLACER = 6202;
const TARGET = 6303;

const SPACE = {
  ownerId: OWNER,
  ownerUsername: 'creator',
  mode: 'review',
  setPrice: 100,
  price: 100,
  cap: 500,
  ownerShare: 1,
  declineFee: 1,
  declineFeeRate: 0.1,
  hostDeclineFeePercent: null,
  setFreeSlots: 4,
  freeSlots: 4,
  freeSlotCap: 4,
  freeSlotsRemaining: 4,
  settings: {},
} satisfies ResolvedPlacementSpace;

/**
 * The claim's transaction client, distinct from `dbWrite`, so a count that moved off `tx` — onto
 * Kysely or onto the global client — is visible as a count `tx` never received.
 */
const tx = {
  $executeRaw: vi.fn(async () => 0),
  $executeRawUnsafe: vi.fn(async () => 0),
  placement: {
    count: vi.fn(async (_args: { where: Record<string, unknown> }) => 0),
    create: vi.fn(async () => ({ id: 1 })),
  },
};

const claim = () =>
  createFreePlacement({
    surface: 'sticker',
    targetType: 'image',
    targetId: TARGET,
    placerId: PLACER,
    data: { cosmeticId: 5 },
  });

beforeEach(() => {
  resetSharedMocks();
  vi.clearAllMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  resolveSpace.mockResolvedValue({ ...SPACE });
  tx.placement.count.mockReset().mockResolvedValue(0);
  tx.placement.create.mockReset().mockResolvedValue({ id: 1 });
  dbMock.dbWrite.$transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) =>
    fn(tx)
  );
});

describe('the free-placement claim under kysely-placement-reads', () => {
  // The three counts the claim decides on are taken under its advisory locks. Read on any other
  // connection they would be outside the lock — a listing again — so they stay on `tx` whatever
  // the flag says.
  it.each([false, true])(
    'flag %s: every count the claim decides on runs on the transaction client',
    async (on) => {
      flag.mockResolvedValue(on);
      await claim();

      const wheres = tx.placement.count.mock.calls.map(([args]) => args.where);
      // The daily allowance, the pending cap, never-twice-here and the reserved slots.
      expect(wheres).toEqual([
        { placerId: PLACER, free: true, createdAt: { gte: freePlacementDayStart() } },
        { surface: 'sticker', ownerId: OWNER, placerId: PLACER, status: 'pending' },
        { placerId: PLACER, free: true, surface: 'sticker', targetType: 'image', targetId: TARGET },
        {
          surface: 'sticker',
          targetType: 'image',
          targetId: TARGET,
          free: true,
          status: { in: ['pending', 'approved'] },
        },
      ]);
      expect(tx.placement.create).toHaveBeenCalledTimes(1);
      expect(dbMock.dbWrite.placement.count).not.toHaveBeenCalled();
      expect(dbMock.dbRead.placement.count).not.toHaveBeenCalled();
      for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
    }
  );

  it('flag on: a placer who has used the day is refused on the in-lock count, whatever Kysely says', async () => {
    flag.mockResolvedValue(true);
    tx.placement.count.mockImplementation(async ({ where }) =>
      where.createdAt ? FREE_PLACEMENTS_PER_DAY : 0
    );
    q.countPlacements.mockResolvedValue(0);

    await expect(claim()).rejects.toThrow(/used your free placement for today/);
    expect(tx.placement.create).not.toHaveBeenCalled();
  });
});

describe('the free-placement display counts under kysely-placement-reads', () => {
  it('OFF: the allowance counts through Prisma on the replica only', async () => {
    dbMock.dbRead.placement.count.mockResolvedValue(1);
    await expect(getFreePlacementAllowance({ placerId: PLACER })).resolves.toMatchObject({
      used: 1,
      remaining: Math.max(FREE_PLACEMENTS_PER_DAY - 1, 0),
    });
    expect(q.countPlacements).not.toHaveBeenCalled();
  });

  it('ON: the same allowance, through Kysely on the replica, since UTC midnight', async () => {
    dbMock.dbRead.placement.count.mockResolvedValue(1);
    const off = await getFreePlacementAllowance({ placerId: PLACER });
    const prismaWhere = dbMock.dbRead.placement.count.mock.calls[0][0].where;
    dbMock.dbRead.placement.count.mockClear();
    flag.mockResolvedValue(true);
    q.countPlacements.mockResolvedValue(1);

    await expect(getFreePlacementAllowance({ placerId: PLACER })).resolves.toEqual(off);
    expect(dbMock.dbRead.placement.count).not.toHaveBeenCalled();
    expect(q.countPlacements.mock.calls[0][0]).toBe(kyselyRead);
    expect(kyselyRead).not.toBe(kyselyWrite);
    // Twin guard: the Kysely count gets the predicate the Prisma count got, which is the daily one.
    expect(q.countPlacements.mock.calls[0][1]).toEqual(prismaWhere);
    expect(prismaWhere).toEqual({
      placerId: PLACER,
      free: true,
      createdAt: { gte: freePlacementDayStart() },
    });
  });

  it.each([
    [0, false],
    [1, true],
  ])('ON: %i free rows here reads as used=%s, as on Prisma', async (count, used) => {
    const input = {
      placerId: PLACER,
      surface: 'sticker',
      targetType: 'image',
      targetId: TARGET,
    } as const;
    dbMock.dbRead.placement.count.mockResolvedValue(count);
    await expect(hasUsedFreePlacementOn(input)).resolves.toBe(used);
    const prismaWhere = dbMock.dbRead.placement.count.mock.calls[0][0].where;
    flag.mockResolvedValue(true);
    q.countPlacements.mockResolvedValue(count);
    await expect(hasUsedFreePlacementOn(input)).resolves.toBe(used);
    expect(q.countPlacements.mock.calls[0][0]).toBe(kyselyRead);
    expect(q.countPlacements.mock.calls[0][1]).toEqual(prismaWhere);
    expect(prismaWhere).toEqual({ ...input, free: true });
  });
});
