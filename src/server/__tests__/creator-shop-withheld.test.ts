import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { CosmeticShopItemHistoryEntry } from '~/server/schema/cosmetic-shop.schema';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as NotificationService from '~/server/services/notification.service';

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createBuzzTransaction: vi.fn(),
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: vi.fn(),
}));

const { isListingDisplayable } = await import('~/server/services/creator-shop.data');
const { getWithheldCosmeticIds } = await import('~/server/services/creator-shop-withheld');
const { equipCosmetic } = await import('~/server/services/user.service');
const { equipCosmeticToEntity } = await import('~/server/services/cosmetic.service');
const {
  reviewCreatorShopItem,
  setCreatorShopItemListed,
  unarchiveCreatorShopItem,
  updateCreatorShopItem,
} = await import('~/server/services/creator-shop.service');
const { cosmeticEntityCaches, userCosmeticCache } = await import('~/server/redis/caches');

const CREATOR = 11;
const BUYER = 12;
const RESELLER = 13;
const MOD = 99;
const COSMETIC = 7;
const OTHER_COSMETIC = 8;
const IMAGE = 501;
const IN_REVIEW = 'This item is in review and cannot be equipped';

const at = (day: number) => `2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const submitted = (): CosmeticShopItemHistoryEntry => ({
  at: at(1),
  userId: CREATOR,
  kind: 'submitted',
  status: 'PendingReview',
});
const reviewed = (action: string, day: number): CosmeticShopItemHistoryEntry => ({
  at: at(day),
  userId: MOD,
  kind: 'reviewed',
  action,
  status: action === 'approve' ? 'Published' : 'RequestedChanges',
});
const edited = (field: string, day: number): CosmeticShopItemHistoryEntry => ({
  at: at(day),
  userId: CREATOR,
  kind: 'edited',
  status: 'PendingReview',
  changes: [{ field, from: 'a', to: 'b' }],
});

type Listing = {
  status: string;
  history?: CosmeticShopItemHistoryEntry[];
  rejectionReason?: string | null;
  lastApprovedAmount?: number;
  takedown?: boolean;
  displayApproved?: boolean;
};
const metaOf = ({ history, lastApprovedAmount, takedown, displayApproved }: Listing) => ({
  purchases: 0,
  ...(history ? { history } : {}),
  ...(lastApprovedAmount ? { lastApprovedAmount } : {}),
  ...(takedown ? { takedown: { reason: 'tos', moderatorId: MOD, at: at(9) } } : {}),
  ...(displayApproved !== undefined ? { displayApproved } : {}),
});
const displayable = (listing: Listing) =>
  isListingDisplayable({
    status: listing.status as never,
    meta: metaOf(listing),
    rejectionReason: listing.rejectionReason ?? null,
  });

const SENT_BACK: Listing = {
  status: 'RequestedChanges',
  history: [
    submitted(),
    reviewed('approve', 2),
    reviewed('revert', 2),
    reviewed('request-changes', 3),
  ],
  rejectionReason: 'Visual quality',
  lastApprovedAmount: 500,
};
const RELISTED: Listing = {
  status: 'PendingReview',
  history: [submitted(), reviewed('approve', 2)],
};
const LIVE: Listing = { status: 'Published', history: [submitted(), reviewed('approve', 2)] };

describe('whether a listing can be shown by its holders', () => {
  it.each<[string, Listing]>([
    ['sent back for changes after approval', SENT_BACK],
    ['rejected', { status: 'Rejected', history: [submitted(), reviewed('reject', 2)] }],
    [
      'unpublished by a moderator',
      {
        status: 'PendingReview',
        history: [submitted(), reviewed('approve', 2), reviewed('revert', 3)],
      },
    ],
    ['never reviewed', { status: 'PendingReview', history: [submitted()] }],
    [
      'artwork swapped after a price edit put it back in review',
      {
        status: 'PendingReview',
        history: [submitted(), reviewed('approve', 2), edited('price', 3), edited('artwork', 4)],
      },
    ],
    [
      'taken down',
      { status: 'Archived', history: [submitted(), reviewed('approve', 2)], takedown: true },
    ],
    [
      'sent back before the history existed',
      { status: 'RequestedChanges', rejectionReason: 'Off-brand', lastApprovedAmount: 500 },
    ],
    [
      'its recorded verdict says so, though the capped history has lost it',
      { status: 'PendingReview', lastApprovedAmount: 500, displayApproved: false },
    ],
  ])('withheld when %s', (_, listing) => {
    expect(displayable(listing)).toBe(false);
  });

  it.each<[string, Listing]>([
    ['live', LIVE],
    ['relisted or restored from the archive', RELISTED],
    [
      'back in review for a large price edit',
      {
        status: 'PendingReview',
        history: [submitted(), reviewed('approve', 2), edited('price', 3)],
      },
    ],
    [
      'archived after approval',
      { status: 'Archived', history: [submitted(), reviewed('approve', 2)] },
    ],
    [
      'its art was fixed before it was approved',
      {
        status: 'Archived',
        history: [
          submitted(),
          reviewed('request-changes', 2),
          edited('artwork', 3),
          reviewed('approve', 4),
        ],
      },
    ],
    [
      'approved before the history existed, then archived',
      { status: 'Archived', lastApprovedAmount: 500 },
    ],
  ])('shown when %s', (_, listing) => {
    expect(displayable(listing)).toBe(true);
  });
});

describe('which cosmetics are withheld', () => {
  const row = (addedById: number, listing: Listing) => ({
    cosmeticId: COSMETIC,
    addedById,
    status: listing.status,
    rejectionReason: listing.rejectionReason ?? null,
    meta: metaOf(listing),
    cosmetic: { createdById: CREATOR },
  });

  it("reads only the creator's own listing, never a reseller's", async () => {
    dbMock.dbRead.cosmeticShopItem.findMany.mockResolvedValueOnce([
      row(CREATOR, LIVE),
      row(RESELLER, SENT_BACK),
    ]);
    expect(await getWithheldCosmeticIds([COSMETIC])).toEqual(new Set());

    dbMock.dbRead.cosmeticShopItem.findMany.mockResolvedValueOnce([row(RESELLER, SENT_BACK)]);
    expect(await getWithheldCosmeticIds([COSMETIC])).toEqual(new Set());

    dbMock.dbRead.cosmeticShopItem.findMany.mockResolvedValueOnce([row(CREATOR, SENT_BACK)]);
    expect(await getWithheldCosmeticIds([COSMETIC])).toEqual(new Set([COSMETIC]));
  });
});

function listingRow(listing: Listing) {
  return {
    id: 42,
    cosmeticId: COSMETIC,
    addedById: CREATOR,
    status: listing.status,
    rejectionReason: listing.rejectionReason ?? null,
    unitAmount: 500,
    title: 'Gilded Aurora',
    description: 'A ring of light',
    availableQuantity: null,
    meta: metaOf(listing),
    cosmetic: {
      id: COSMETIC,
      createdById: CREATOR,
      type: 'ProfileDecoration',
      data: { url: 'art' },
      creator: { username: 'creator' },
    },
    _count: { purchases: 0 },
  };
}
let storedListing: ReturnType<typeof listingRow>;
const listingsIn =
  (rows: () => ReturnType<typeof listingRow>[]) =>
  ({ where }: { where: { cosmeticId: { in: number[] } } }) =>
    Promise.resolve(where.cosmeticId.in.includes(COSMETIC) ? rows() : []);

beforeEach(() => {
  storedListing = listingRow(SENT_BACK);
  dbMock.dbWrite.cosmeticShopItem.findMany
    .mockReset()
    .mockImplementation(listingsIn(() => [storedListing]));
  // The replica lags the verdict just written: it still has the item live.
  dbMock.dbRead.cosmeticShopItem.findMany
    .mockReset()
    .mockImplementation(listingsIn(() => [listingRow(LIVE)]));
  dbMock.dbRead.cosmeticShopItem.findUnique.mockReset().mockImplementation(() => storedListing);
  dbMock.dbWrite.cosmeticShopItem.findUnique.mockReset().mockImplementation(() => storedListing);
  dbMock.dbWrite.cosmeticShopItem.update
    .mockReset()
    .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      storedListing = { ...storedListing, ...data } as typeof storedListing;
      return storedListing;
    });
  for (const method of ['updateMany', 'update', 'upsert', 'createMany'] as const)
    dbMock.dbWrite.userCosmetic[method].mockReset().mockResolvedValue({ count: 1 });
  dbMock.dbWrite.userCosmetic.findMany.mockReset().mockResolvedValue([]);
});

describe('equipping', () => {
  const owned = (type: string) => [
    { obtainedAt: new Date(), cosmetic: { type, data: { url: 'art' } } },
  ];

  it('refuses a withheld cosmetic and leaves what is worn alone', async () => {
    dbMock.dbRead.userCosmetic.findMany.mockResolvedValue(owned('ProfileDecoration'));

    await expect(equipCosmetic({ userId: CREATOR, cosmeticId: COSMETIC })).rejects.toThrow(
      IN_REVIEW
    );
    expect(dbMock.dbWrite.userCosmetic.updateMany).not.toHaveBeenCalled();
  });

  it('equips a relisted item that was approved unchanged', async () => {
    storedListing = listingRow(RELISTED);
    dbMock.dbRead.userCosmetic.findMany.mockResolvedValue(owned('ProfileDecoration'));

    await equipCosmetic({ userId: CREATOR, cosmeticId: COSMETIC });

    expect(dbMock.dbWrite.userCosmetic.updateMany).toHaveBeenCalledWith({
      where: { userId: CREATOR, cosmeticId: { in: [COSMETIC] } },
      data: { equippedAt: expect.any(Date) },
    });
  });

  it('refuses to place a withheld content decoration', async () => {
    dbMock.dbWrite.userCosmetic.findFirst.mockResolvedValue({
      obtainedAt: new Date(),
      equippedToId: null,
      equippedToType: null,
      forId: null,
      forType: null,
      data: null,
      cosmetic: { type: 'ContentDecoration', data: { cssFrame: 'red' } },
    });

    await expect(
      equipCosmeticToEntity({
        userId: CREATOR,
        cosmeticId: COSMETIC,
        claimKey: 'creator-shop',
        equippedToId: IMAGE,
        equippedToType: 'Image',
      })
    ).rejects.toThrow(IN_REVIEW);
    expect(dbMock.dbWrite.userCosmetic.updateMany).not.toHaveBeenCalled();
  });
});

describe('withholding takes the cosmetic off everyone', () => {
  const wearers = [
    { userId: BUYER, equippedToId: null, equippedToType: null, cosmetic: { data: {} } },
    { userId: CREATOR, equippedToId: IMAGE, equippedToType: 'Image', cosmetic: { data: {} } },
  ];
  const unequipAll = {
    where: {
      cosmeticId: COSMETIC,
      OR: [{ equippedAt: { not: null } }, { equippedToId: { not: null } }],
    },
    data: { equippedAt: null, equippedToId: null, equippedToType: null },
  };

  beforeEach(() => {
    storedListing = listingRow(LIVE);
    dbMock.dbWrite.userCosmetic.findMany.mockResolvedValue(wearers);
  });

  it.each(['request-changes', 'reject', 'revert'])(
    '%s unequips worn and placed copies and refreshes what shows them',
    async (action) => {
      const refreshWorn = vi.spyOn(userCosmeticCache, 'refresh');
      const refreshFrames = vi.spyOn(cosmeticEntityCaches.Image, 'refresh');

      await reviewCreatorShopItem({ reviewerId: MOD, id: 42, action: action as never });

      expect(dbMock.dbWrite.userCosmetic.updateMany).toHaveBeenCalledWith(unequipAll);
      expect(refreshWorn).toHaveBeenCalledWith([BUYER, CREATOR]);
      expect(refreshFrames).toHaveBeenCalledWith([IMAGE]);
    }
  );

  it('re-approval grants without putting it back on anyone', async () => {
    await reviewCreatorShopItem({ reviewerId: MOD, id: 42, action: 'request-changes' });
    expect(dbMock.dbWrite.userCosmetic.updateMany).toHaveBeenCalledTimes(1);
    dbMock.dbWrite.userCosmetic.updateMany.mockClear();

    await reviewCreatorShopItem({ reviewerId: MOD, id: 42, action: 'approve' });

    const [grant] = dbMock.dbWrite.userCosmetic.createMany.mock.calls.at(-1)!;
    expect(grant.data).toEqual([expect.not.objectContaining({ equippedAt: expect.anything() })]);
    expect(grant.data[0]).not.toHaveProperty('equippedToId');
    for (const method of ['updateMany', 'update', 'upsert'] as const)
      expect(dbMock.dbWrite.userCosmetic[method]).not.toHaveBeenCalled();
  });

  it('an edit to what holders see, after approval, unequips it', async () => {
    storedListing = listingRow(RELISTED);

    await updateCreatorShopItem({ id: 42, userId: CREATOR, name: 'Gilded Aurora II' });

    expect(dbMock.dbWrite.userCosmetic.updateMany).toHaveBeenCalledWith(unequipAll);
  });

  it('a price edit leaves it on', async () => {
    storedListing = listingRow(RELISTED);

    await updateCreatorShopItem({ id: 42, userId: CREATOR, price: 520 });

    expect(dbMock.dbWrite.userCosmetic.updateMany).not.toHaveBeenCalled();
  });
});

describe('a verdict outlives the capped history', () => {
  it('a resubmit records the withheld verdict, so trimming the log does not lift it', async () => {
    const { history: _, ...legacy } = SENT_BACK;
    storedListing = listingRow({ ...legacy, history: [reviewed('request-changes', 3)] });

    await updateCreatorShopItem({ id: 42, userId: CREATOR, price: 520 });
    storedListing = { ...storedListing, meta: { ...storedListing.meta, history: [] } };
    dbMock.dbRead.userCosmetic.findMany.mockResolvedValue([
      { obtainedAt: new Date(), cosmetic: { type: 'ProfileDecoration', data: { url: 'art' } } },
    ]);

    expect(storedListing.meta).toMatchObject({ displayApproved: false });
    await expect(equipCosmetic({ userId: CREATOR, cosmeticId: COSMETIC })).rejects.toThrow(
      IN_REVIEW
    );
  });

  const legacySentBack: Listing = {
    status: 'RequestedChanges',
    rejectionReason: 'Off-brand',
    lastApprovedAmount: 500,
  };
  it.each([
    [
      'relisting it',
      () => setCreatorShopItemListed({ id: 42, userId: CREATOR, listed: true }),
      legacySentBack,
    ],
    [
      'a moderator restoring it',
      () => unarchiveCreatorShopItem({ id: 42, userId: MOD, isModerator: true }),
      { ...legacySentBack, status: 'Archived' },
    ],
  ])('%s clears the reason but keeps a sent-back item withheld', async (_, act, listing) => {
    storedListing = listingRow(listing);
    dbMock.dbRead.userCosmetic.findMany.mockResolvedValue([
      { obtainedAt: new Date(), cosmetic: { type: 'ProfileDecoration', data: { url: 'art' } } },
    ]);

    await act();

    expect(storedListing).toMatchObject({ status: 'PendingReview', rejectionReason: null });
    await expect(equipCosmetic({ userId: CREATOR, cosmeticId: COSMETIC })).rejects.toThrow(
      IN_REVIEW
    );
  });
});

describe('equipped cosmetics shown to other users', () => {
  it('leave out a withheld cosmetic still worn from before withholding unequipped it', async () => {
    dbMock.dbRead.cosmeticShopItem.findMany.mockImplementation(listingsIn(() => [storedListing]));
    dbMock.dbRead.userCosmetic.findMany.mockResolvedValue([
      { userId: BUYER, cosmeticId: COSMETIC, data: null },
      { userId: BUYER, cosmeticId: OTHER_COSMETIC, data: null },
    ]);

    const worn = await userCosmeticCache.fetch([BUYER]);

    expect(worn[BUYER].cosmetics.map((c) => c.cosmeticId)).toEqual([OTHER_COSMETIC]);
  });
});

describe('a verdict landing while an equip is in flight', () => {
  type Worn = { equippedAt: Date | null; equippedToId: number | null; equippedToType: unknown };
  // The creator's one copy, written through the same calls the services make.
  let held: Worn;
  type Where = {
    userId?: number;
    cosmeticId?: number | { in: number[] };
    equippedAt?: { not: null };
    OR?: Where[];
  };
  const matches = (where: Where): boolean =>
    (where.userId === undefined || where.userId === CREATOR) &&
    (where.cosmeticId === undefined ||
      (typeof where.cosmeticId === 'number'
        ? where.cosmeticId === COSMETIC
        : where.cosmeticId.in.includes(COSMETIC))) &&
    (where.equippedAt === undefined || held.equippedAt !== null) &&
    (where.OR === undefined || where.OR.some((w) => matches(w)));
  const nothingWorn: Worn = { equippedAt: null, equippedToId: null, equippedToType: null };

  beforeEach(() => {
    storedListing = listingRow(LIVE);
    held = { ...nothingWorn };
    dbMock.dbWrite.userCosmetic.updateMany.mockImplementation(
      ({ where, data }: { where: Where; data: Partial<Worn> }) => {
        if (!matches(where)) return { count: 0 };
        held = { ...held, ...data };
        return { count: 1 };
      }
    );
    dbMock.dbWrite.userCosmetic.findMany.mockImplementation(({ where }: { where: Where }) =>
      held.equippedAt || held.equippedToId
        ? [{ userId: CREATOR, ...held, cosmeticId: COSMETIC, claimKey: 'creator-shop' }].filter(
            () => matches(where)
          )
        : []
    );
    // The equip's own withheld check reads the item still live; the moderator's request-changes
    // commits, and sweeps, right after it.
    dbMock.dbWrite.cosmeticShopItem.findMany.mockImplementationOnce(async (args) => {
      const beforeVerdict = await listingsIn(() => [storedListing])(args);
      await reviewCreatorShopItem({ reviewerId: MOD, id: 42, action: 'request-changes' });
      return beforeVerdict;
    });
  });

  it('a worn equip ends unequipped', async () => {
    dbMock.dbRead.userCosmetic.findMany.mockResolvedValue([
      { obtainedAt: new Date(), cosmetic: { type: 'ProfileDecoration', data: { url: 'art' } } },
    ]);

    const outcome = await equipCosmetic({ userId: CREATOR, cosmeticId: COSMETIC }).then(
      () => 'equipped',
      (e: Error) => e.message
    );

    expect(storedListing.status).toBe('RequestedChanges');
    expect(held).toEqual(nothingWorn);
    expect(outcome).toBe(IN_REVIEW);
  });

  it('a content placement ends unplaced', async () => {
    dbMock.dbWrite.userCosmetic.findFirst.mockResolvedValue({
      obtainedAt: new Date(),
      equippedToId: null,
      equippedToType: null,
      forId: null,
      forType: null,
      data: null,
      cosmetic: { type: 'ContentDecoration', data: { cssFrame: 'red' } },
    });
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ userId: CREATOR });

    const outcome = await equipCosmeticToEntity({
      userId: CREATOR,
      cosmeticId: COSMETIC,
      claimKey: 'creator-shop',
      equippedToId: IMAGE,
      equippedToType: 'Image',
    }).then(
      () => 'placed',
      (e: Error) => e.message
    );

    expect(storedListing.status).toBe('RequestedChanges');
    expect(held).toEqual(nothingWorn);
    expect(outcome).toBe(IN_REVIEW);
  });
});

describe('a verdict landing while a creator edit is in flight', () => {
  it('keeps the verdict, and the item stays withheld', async () => {
    storedListing = listingRow(RELISTED);
    // The edit reads the item still in review; the moderator's request-changes commits right after.
    // Hooked on both clients so the test does not depend on which one the edit reads.
    let verdictLanded = false;
    const readThenVerdict = async () => {
      const beforeVerdict = storedListing;
      if (!verdictLanded) {
        verdictLanded = true;
        await reviewCreatorShopItem({
          reviewerId: MOD,
          id: 42,
          action: 'request-changes',
          rejectionReason: 'Visual quality',
        });
      }
      return beforeVerdict;
    };
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockImplementationOnce(readThenVerdict);
    dbMock.dbRead.cosmeticShopItem.findUnique.mockImplementationOnce(readThenVerdict);
    const verdict = expect.objectContaining({ kind: 'reviewed', action: 'request-changes' });

    const outcome = await updateCreatorShopItem({ id: 42, userId: CREATOR, price: 520 }).then(
      () => 'saved',
      (e: Error) => e.message
    );

    expect(storedListing).toMatchObject({
      status: 'RequestedChanges',
      rejectionReason: 'Visual quality',
      meta: { displayApproved: false, history: expect.arrayContaining([verdict]) },
    });
    expect(outcome).toMatch(/changed while you were editing/);
  });

  it('a sale landing mid-edit is kept, and does not refuse the edit', async () => {
    storedListing = listingRow(LIVE);
    // The edit reads the item at no sales; a buyer's sale bumps the counter right after.
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockImplementationOnce(() => {
      const beforeSale = storedListing;
      storedListing = { ...storedListing, meta: { ...storedListing.meta, purchases: 1 } };
      return beforeSale;
    });

    await updateCreatorShopItem({ id: 42, userId: CREATOR, price: 520 });

    expect(storedListing).toMatchObject({ unitAmount: 520, meta: { purchases: 1 } });
  });
});
