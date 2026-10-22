import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { CosmeticShopItemHistoryEntry } from '~/server/schema/cosmetic-shop.schema';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as CreatorShopLabels from '~/server/services/creator-shop-labels.service';
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
// The label store's own behaviour is covered on real Postgres in creator-shop-labels.behavior.test.ts.
vi.mock('~/server/services/creator-shop-labels.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorShopLabels>()),
  recordShopVerdict: vi.fn(async () => true),
  excludeDeletedShopListing: vi.fn(async () => true),
}));

const { isListingDisplayable } = await import('~/server/services/creator-shop.data');
const { getWithheldCosmeticIds } = await import('~/server/services/creator-shop-withheld');
const { equipCosmetic } = await import('~/server/services/user.service');
const { equipCosmeticToEntity } = await import('~/server/services/cosmetic.service');
const { CosmeticFlag } = await import('~/shared/constants/cosmetic-flags.constants');
const { excludeDeletedShopListing, recordShopVerdict } = await import(
  '~/server/services/creator-shop-labels.service'
);
const { deleteCosmeticShopItem } = await import('~/server/services/cosmetic-shop.service');
const {
  deleteCreatorShopItem,
  reviewCreatorShopItem,
  setCreatorShopItemListed,
  unarchiveCreatorShopItem,
  updateCreatorShopItem,
} = await import('~/server/services/creator-shop.service');
const { cosmeticCache, cosmeticEntityCaches, userCosmeticCache } = await import(
  '~/server/redis/caches'
);

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

  it('records the label inside the verdict, and sweeps after both commit', async () => {
    const order: string[] = [];
    vi.mocked(recordShopVerdict).mockClear();
    vi.mocked(recordShopVerdict).mockImplementationOnce(async () => {
      order.push('label');
      return true;
    });
    const write = dbMock.dbWrite.cosmeticShopItem.update.getMockImplementation()!;
    dbMock.dbWrite.cosmeticShopItem.update.mockImplementationOnce(async (...args: never[]) => {
      order.push('verdict');
      return write(...args);
    });
    dbMock.dbWrite.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => {
      const result = await fn(dbMock.dbWrite);
      order.push('commit');
      return result;
    });
    dbMock.dbWrite.userCosmetic.updateMany.mockImplementationOnce(async () => {
      order.push('sweep');
      return { count: wearers.length };
    });

    await reviewCreatorShopItem({ reviewerId: MOD, id: 42, action: 'request-changes' });

    expect(order).toEqual(['verdict', 'label', 'commit', 'sweep']);
    expect(recordShopVerdict).toHaveBeenCalledTimes(1);
    expect(recordShopVerdict).toHaveBeenCalledWith(
      dbMock.dbWrite,
      42,
      expect.objectContaining({ action: 'request-changes', moderatorId: MOD })
    );
  });

  // The search document shows what the user wears, not what is placed on their content, and the
  // users index re-pulls an existing user only when their id is queued.
  it('queues the search documents of the users who were wearing it, and only them', async () => {
    const { usersSearchIndex } = await import('~/server/search-index/users.search-index');
    const queue = vi.spyOn(usersSearchIndex, 'queueUpdate').mockResolvedValue();
    onTestFinished(() => queue.mockRestore());

    await reviewCreatorShopItem({ reviewerId: MOD, id: 42, action: 'reject' });

    expect(queue.mock.calls.flatMap(([items]) => items.map((x) => x.id))).toEqual([BUYER]);
  });

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

describe('decorations placed on content, shown to other users', () => {
  const CREATOR_IMAGE = IMAGE;
  const BUYER_IMAGE = IMAGE + 1;
  const SHOP_FRAME_IMAGE = IMAGE + 2;
  // Placed before withholding existed, so no sweep took them off: the creator's own image and a
  // buyer's (withheld is per cosmetic, not per holder), beside a shop frame with no creator.
  const placed = () =>
    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      { cosmeticId: COSMETIC, equippedToId: CREATOR_IMAGE, userData: null, createdById: CREATOR },
      { cosmeticId: COSMETIC, equippedToId: BUYER_IMAGE, userData: null, createdById: CREATOR },
      {
        cosmeticId: OTHER_COSMETIC,
        equippedToId: SHOP_FRAME_IMAGE,
        userData: null,
        createdById: null,
      },
    ] as never);
  const frame = (id: number) => ({ id, name: 'Frame', type: 'ContentDecoration', data: {} });

  let fetchCosmetics: typeof cosmeticCache.fetch;
  beforeEach(() => {
    fetchCosmetics = cosmeticCache.fetch;
    cosmeticCache.fetch = (async () => ({
      [COSMETIC]: frame(COSMETIC),
      [OTHER_COSMETIC]: frame(OTHER_COSMETIC),
    })) as never;
    dbMock.dbWrite.$queryRaw.mockReset();
  });
  afterEach(() => {
    cosmeticCache.fetch = fetchCosmetics;
  });

  it("leave out a withheld cosmetic, on the creator's content and a buyer's", async () => {
    placed();

    const frames = await cosmeticEntityCaches.Image.fetch([
      CREATOR_IMAGE,
      BUYER_IMAGE,
      SHOP_FRAME_IMAGE,
    ]);

    expect(Object.keys(frames).map(Number)).toEqual([SHOP_FRAME_IMAGE]);
  });

  it('keep a published one', async () => {
    storedListing = listingRow(LIVE);
    placed();

    const frames = await cosmeticEntityCaches.Image.fetch([
      CREATOR_IMAGE,
      BUYER_IMAGE,
      SHOP_FRAME_IMAGE,
    ]);

    expect(Object.keys(frames).map(Number).sort()).toEqual([
      CREATOR_IMAGE,
      BUYER_IMAGE,
      SHOP_FRAME_IMAGE,
    ]);
    expect(frames[CREATOR_IMAGE]).not.toHaveProperty('createdById');
  });
});

describe('a verdict landing while an equip is in flight', () => {
  type Worn = { equippedAt: Date | null; equippedToId: number | null; equippedToType: unknown };
  // The creator's one copy, written through the same calls the services make.
  let held: Worn;
  let wasWorn: boolean;
  type Where = Record<string, unknown> & { OR?: Where[] };
  const isSet = (value: unknown, condition: unknown) =>
    condition === null
      ? value === null
      : typeof condition === 'object' && condition !== null && 'not' in condition
      ? value !== null
      : value === condition;
  // Fails closed: a where-shape this fake does not model throws rather than quietly matching.
  const matches = (where: Where): boolean =>
    Object.entries(where).every(([key, condition]) => {
      switch (key) {
        case 'userId':
          return condition === CREATOR;
        case 'cosmeticId':
          return typeof condition === 'number'
            ? condition === COSMETIC
            : (condition as { in: number[] }).in.includes(COSMETIC);
        case 'claimKey':
          return condition === 'creator-shop';
        case 'equippedAt':
        case 'equippedToId':
        case 'equippedToType':
          return isSet(held[key], condition);
        case 'OR':
          return (condition as Where[]).some(matches);
        case 'cosmetic': // the type filter: the one row is of the type being equipped
          return true;
        default:
          throw new Error(`UserCosmetic fake does not model where.${key}`);
      }
    });
  const nothingWorn: Worn = { equippedAt: null, equippedToId: null, equippedToType: null };
  // Runs the moderator's request-changes, and its sweep, at a chosen point inside the equip.
  const verdict = () =>
    reviewCreatorShopItem({ reviewerId: MOD, id: 42, action: 'request-changes' });
  let aroundEquipWrite: { before?: () => Promise<unknown>; after?: () => Promise<unknown> };

  beforeEach(() => {
    storedListing = listingRow(LIVE);
    held = { ...nothingWorn };
    wasWorn = false;
    aroundEquipWrite = {};
    dbMock.dbWrite.userCosmetic.updateMany.mockImplementation(
      async ({ where, data }: { where: Where; data: Partial<Worn> }) => {
        const equipWrite = data.equippedAt instanceof Date;
        const hook = equipWrite ? aroundEquipWrite : {};
        aroundEquipWrite = equipWrite ? {} : aroundEquipWrite;
        await hook.before?.();
        const count = matches(where) ? 1 : 0;
        if (count) held = { ...held, ...data };
        wasWorn ||= held.equippedAt !== null;
        await hook.after?.();
        return { count };
      }
    );
    dbMock.dbWrite.userCosmetic.findMany.mockImplementation(({ where }: { where: Where }) =>
      [
        {
          userId: CREATOR,
          ...held,
          cosmeticId: COSMETIC,
          claimKey: 'creator-shop',
          cosmetic: { data: {} },
        },
      ].filter(() => matches(where))
    );
  });

  // The verdict commits and sweeps after the equip's withheld check, but before its write: the sweep
  // finds nothing, so only a re-check after the write can take it back off.
  it('a worn equip ends unequipped', async () => {
    aroundEquipWrite.before = verdict;
    dbMock.dbRead.userCosmetic.findMany.mockResolvedValue([
      { obtainedAt: new Date(), cosmetic: { type: 'ProfileDecoration', data: { url: 'art' } } },
    ]);

    const outcome = await equipCosmetic({ userId: CREATOR, cosmeticId: COSMETIC }).then(
      () => 'equipped',
      (e: Error) => e.message
    );

    expect(storedListing.status).toBe('RequestedChanges');
    expect(wasWorn).toBe(true);
    expect(held).toEqual(nothingWorn);
    expect(outcome).toBe(IN_REVIEW);
  });

  const placeOnImage = (from: { equippedToId: number | null; equippedToType: string | null }) => {
    dbMock.dbWrite.userCosmetic.findFirst.mockResolvedValue({
      obtainedAt: new Date(),
      ...from,
      forId: null,
      forType: null,
      data: null,
      cosmetic: { type: 'ContentDecoration', data: { cssFrame: 'red' } },
    });
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ userId: CREATOR });
    return equipCosmeticToEntity({
      userId: CREATOR,
      cosmeticId: COSMETIC,
      claimKey: 'creator-shop',
      equippedToId: IMAGE,
      equippedToType: 'Image',
    }).then(
      () => 'placed',
      (e: Error) => e.message
    );
  };

  it('a content placement ends unplaced', async () => {
    aroundEquipWrite.before = verdict;

    const outcome = await placeOnImage({ equippedToId: null, equippedToType: null });

    expect(storedListing.status).toBe('RequestedChanges');
    expect(wasWorn).toBe(true);
    expect(held).toEqual(nothingWorn);
    expect(outcome).toBe(IN_REVIEW);
  });

  // The verdict lands after the move: its sweep finds the cosmetic only where it moved to, so the
  // entity it moved off is left for the equip itself to refresh.
  it('a refused move refreshes both the entity it left and the one it reached', async () => {
    const LEFT = IMAGE + 1;
    held = { equippedAt: new Date(), equippedToId: LEFT, equippedToType: 'Image' };
    aroundEquipWrite.after = verdict;
    const refreshFrames = vi.spyOn(cosmeticEntityCaches.Image, 'refresh');

    const outcome = await placeOnImage({ equippedToId: LEFT, equippedToType: 'Image' });

    expect(held).toEqual(nothingWorn);
    expect(outcome).toBe(IN_REVIEW);
    const refreshed = refreshFrames.mock.calls.flatMap(([ids]) => ids);
    expect(refreshed).toEqual(expect.arrayContaining([LEFT, IMAGE]));
  });
});

describe('a creator edit racing another write to the item', () => {
  const conflict = /changed while you were editing/;
  const edit = () =>
    updateCreatorShopItem({ id: 42, userId: CREATOR, price: 520 }).then(
      () => 'saved',
      (e: Error) => e.message
    );
  /** The edit's own read returns the row as it stands, then `land` commits before the edit writes. */
  const landAfterRead = (land: () => unknown) => {
    let landed = false;
    const readThenLand = async () => {
      const beforeLanding = storedListing;
      if (!landed) {
        landed = true;
        await land();
      }
      return beforeLanding;
    };
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockImplementationOnce(readThenLand);
    // Main read the replica here; hooked too so the race is the same whichever client is read.
    dbMock.dbRead.cosmeticShopItem.findUnique.mockImplementationOnce(readThenLand);
  };
  const verdictEntry = expect.objectContaining({ kind: 'reviewed', action: 'request-changes' });

  it('keeps a verdict that landed mid-edit, and the item stays withheld', async () => {
    storedListing = listingRow(RELISTED);
    landAfterRead(() =>
      reviewCreatorShopItem({
        reviewerId: MOD,
        id: 42,
        action: 'request-changes',
        rejectionReason: 'Visual quality',
      })
    );

    const outcome = await edit();

    expect(storedListing).toMatchObject({
      status: 'RequestedChanges',
      rejectionReason: 'Visual quality',
      meta: { displayApproved: false, history: expect.arrayContaining([verdictEntry]) },
    });
    expect(outcome).toMatch(conflict);
  });

  it('keeps another edit that landed mid-edit without moving the status', async () => {
    storedListing = listingRow(RELISTED);
    const otherEdit = edited('name', 5);
    landAfterRead(() => {
      const meta = storedListing.meta;
      storedListing = {
        ...storedListing,
        meta: { ...meta, history: [...meta.history!, otherEdit] },
      };
    });

    const outcome = await edit();

    expect(storedListing.meta.history).toContainEqual(otherEdit);
    expect(outcome).toMatch(conflict);
  });

  // A mock cannot hold a lock, so this pins that the compare reads the row only after locking it.
  it('locks the row before comparing it', async () => {
    storedListing = listingRow(RELISTED);
    dbMock.dbWrite.$queryRaw.mockClear();
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockClear();

    await edit();

    const [lockSql] = dbMock.dbWrite.$queryRaw.mock.calls[0] as [TemplateStringsArray];
    expect(lockSql.join('?')).toMatch(/FROM "CosmeticShopItem" WHERE id = \? FOR NO KEY UPDATE/);
    const [lockedAt] = dbMock.dbWrite.$queryRaw.mock.invocationCallOrder;
    expect(lockedAt).toBeLessThan(
      dbMock.dbWrite.cosmeticShopItem.findUnique.mock.invocationCallOrder.at(-1)!
    );
  });

  it('an edit just after a verdict reads it, not the lagging replica', async () => {
    storedListing = listingRow(SENT_BACK);
    dbMock.dbRead.cosmeticShopItem.findUnique.mockImplementation(() => listingRow(RELISTED));

    const outcome = await edit();

    expect(outcome).toBe('saved');
    expect(storedListing.meta).toMatchObject({
      displayApproved: false,
      history: expect.arrayContaining([verdictEntry]),
    });
  });

  it('a sale landing mid-edit is kept, and does not refuse the edit', async () => {
    storedListing = listingRow(LIVE);
    landAfterRead(() => {
      storedListing = { ...storedListing, meta: { ...storedListing.meta, purchases: 1 } };
    });

    const outcome = await edit();

    expect(outcome).toBe('saved');
    expect(storedListing).toMatchObject({ unitAmount: 520, meta: { purchases: 1 } });
  });
});

describe('a moderator deleting a listing', () => {
  const SYSTEM_COSMETIC = 900;
  type CosmeticRow = { id: number; createdById: number | null; flags: number };
  let cosmetics: CosmeticRow[];
  let deleted: boolean;

  beforeEach(() => {
    deleted = false;
    cosmetics = [
      { id: COSMETIC, createdById: CREATOR, flags: 0 },
      { id: SYSTEM_COSMETIC, createdById: null, flags: 0 },
    ];
    const listings = listingsIn(() => (deleted ? [] : [storedListing]));
    dbMock.dbWrite.cosmeticShopItem.findMany.mockImplementation(listings);
    dbMock.dbRead.cosmeticShopItem.findMany.mockImplementation(listings);
    dbMock.dbWrite.cosmeticShopItem.delete.mockImplementation(() => {
      deleted = true;
      return storedListing;
    });
    // The one raw write this path makes: OR a bit into one cosmetic's flags.
    dbMock.dbWrite.$executeRaw.mockImplementation(
      (sql: TemplateStringsArray, bit: number, id: number) => {
        expect(sql.join('?')).toMatch(
          /UPDATE "Cosmetic" SET flags = flags \| \?::int WHERE id = \?/
        );
        const row = cosmetics.find((c) => c.id === id);
        if (row) row.flags |= bit;
        return row ? 1 : 0;
      }
    );
    const cosmeticRows = ({ where }: { where: Record<string, unknown> }) =>
      cosmetics.filter((row) =>
        Object.entries(where).every(([key, condition]) => {
          if (key === 'id') return (condition as { in: number[] }).in.includes(row.id);
          if (key === 'createdById') return row.createdById !== null; // `{ not: null }`
          throw new Error(`Cosmetic fake does not model where.${key}`);
        })
      );
    dbMock.dbWrite.cosmetic.findMany.mockImplementation(cosmeticRows);
    dbMock.dbRead.cosmetic.findMany.mockImplementation(cosmeticRows);
    dbMock.dbRead.user.findUnique.mockResolvedValue({ settings: {} });
    dbMock.dbRead.userCosmetic.findMany.mockResolvedValue([
      { obtainedAt: new Date(), cosmetic: { type: 'ProfileDecoration', data: { url: 'art' } } },
    ]);
  });

  it('keeps the cosmetic of a deleted sent-back listing withheld', async () => {
    storedListing = listingRow(SENT_BACK);

    await deleteCreatorShopItem({ id: 42, userId: MOD, isModerator: true });

    expect(deleted).toBe(true);
    await expect(equipCosmetic({ userId: CREATOR, cosmeticId: COSMETIC })).rejects.toThrow(
      IN_REVIEW
    );
    expect(await getWithheldCosmeticIds([COSMETIC])).toEqual(new Set([COSMETIC]));
  });

  it('leaves the cosmetic of a deleted approved listing wearable', async () => {
    storedListing = listingRow(LIVE);

    await deleteCreatorShopItem({ id: 42, userId: MOD, isModerator: true });

    expect(deleted).toBe(true);
    await equipCosmetic({ userId: CREATOR, cosmeticId: COSMETIC });
    expect(cosmetics.find((c) => c.id === COSMETIC)?.flags).toBe(0);
  });

  it.each([
    ['the creator shop', () => deleteCreatorShopItem({ id: 42, userId: MOD, isModerator: true })],
    ['the official shop', () => deleteCosmeticShopItem({ id: 42 })],
  ])('takes a listing deleted from %s out of training in the delete', async (_label, remove) => {
    storedListing = listingRow(LIVE);
    dbMock.dbRead.cosmeticShopItem.findUniqueOrThrow.mockResolvedValue({
      id: 42,
      _count: { purchases: 0 },
    });
    const order: string[] = [];
    vi.mocked(excludeDeletedShopListing).mockClear();
    vi.mocked(excludeDeletedShopListing).mockImplementationOnce(async () => {
      order.push('exclude');
      return true;
    });
    const write = dbMock.dbWrite.cosmeticShopItem.delete.getMockImplementation()!;
    dbMock.dbWrite.cosmeticShopItem.delete.mockImplementationOnce((...args: never[]) => {
      order.push('delete');
      return write(...args);
    });
    dbMock.dbWrite.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => {
      order.push('begin');
      const result = await fn(dbMock.dbWrite);
      order.push('commit');
      return result;
    });

    await remove();

    expect(order).toEqual(['begin', 'delete', 'exclude', 'commit']);
    expect(excludeDeletedShopListing).toHaveBeenCalledTimes(1);
    expect(excludeDeletedShopListing).toHaveBeenCalledWith(dbMock.dbWrite, 42);
  });

  it('never withholds a cosmetic no creator made, whatever its flags say', async () => {
    deleted = true;
    cosmetics = cosmetics.map((c) => ({ ...c, flags: CosmeticFlag.Withheld }));

    expect(await getWithheldCosmeticIds([SYSTEM_COSMETIC, COSMETIC])).toEqual(new Set([COSMETIC]));
  });
});
