/**
 * A creator's own copy of a shop item is granted on approval and was never taken back, so an
 * item later sent back for changes stayed in their inventory and could be equipped, and an
 * equipped one rendered for everyone. A creator-made cosmetic is now withheld from holders unless
 * its listing is live, or a moderator last approved it and nothing anyone sees has changed since.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { CosmeticShopItemHistoryEntry } from '~/server/schema/cosmetic-shop.schema';

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));

const { isListingDisplayable } = await import('~/server/services/creator-shop.data');
const { equipCosmetic } = await import('~/server/services/user.service');
const { equipCosmeticToEntity } = await import('~/server/services/cosmetic.service');
const { reviewCreatorShopItem, updateCreatorShopItem } = await import(
  '~/server/services/creator-shop.service'
);
const { userCosmeticCache } = await import('~/server/redis/caches');

const CREATOR = 11;
const BUYER = 12;
const MOD = 99;
const COSMETIC = 7;
const OTHER_COSMETIC = 8;

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
};
const displayable = ({
  status,
  history,
  rejectionReason = null,
  lastApprovedAmount,
  takedown,
}: Listing) =>
  isListingDisplayable({
    status: status as never,
    meta: {
      purchases: 0,
      ...(history ? { history } : {}),
      ...(lastApprovedAmount ? { lastApprovedAmount } : {}),
      ...(takedown ? { takedown: { reason: 'tos', moderatorId: MOD, at: at(9) } } : {}),
    },
    rejectionReason,
  });

// The reported item: approved, unpublished by a moderator, then sent back for visual quality.
const SENT_BACK = {
  status: 'RequestedChanges',
  history: [submitted(), reviewed('approve', 2), reviewed('revert', 2), reviewed('request-changes', 3)],
  rejectionReason: 'Visual quality',
  lastApprovedAmount: 500,
};
const RELISTED = { status: 'PendingReview', history: [submitted(), reviewed('approve', 2)] };

describe('whether a listing can be shown by its holders', () => {
  it.each([
    ['sent back for changes after approval', SENT_BACK],
    ['rejected', { status: 'Rejected', history: [submitted(), reviewed('reject', 2)] }],
    ['unpublished by a moderator', { status: 'PendingReview', history: [submitted(), reviewed('approve', 2), reviewed('revert', 3)] }],
    ['never reviewed', { status: 'PendingReview', history: [submitted()] }],
    [
      'artwork swapped after a price edit put it back in review',
      {
        status: 'PendingReview',
        history: [submitted(), reviewed('approve', 2), edited('price', 3), edited('artwork', 4)],
      },
    ],
    ['taken down', { status: 'Archived', history: [submitted(), reviewed('approve', 2)], takedown: true }],
    ['sent back before the history existed', { status: 'RequestedChanges', rejectionReason: 'Off-brand', lastApprovedAmount: 500 }],
  ])('withheld when %s', (_, listing) => {
    expect(displayable(listing)).toBe(false);
  });

  it.each([
    ['live', { status: 'Published', history: [submitted(), reviewed('approve', 2)] }],
    ['relisted or restored from the archive', RELISTED],
    [
      'back in review for a large price edit',
      { status: 'PendingReview', history: [submitted(), reviewed('approve', 2), edited('price', 3)] },
    ],
    ['archived after approval', { status: 'Archived', history: [submitted(), reviewed('approve', 2)] }],
    ['approved before the history existed, then archived', { status: 'Archived', lastApprovedAmount: 500 }],
  ])('shown when %s', (_, listing) => {
    expect(displayable(listing)).toBe(true);
  });
});

// What the database holds for the creator's own listing, as the review and edit paths leave it.
let stored: ReturnType<typeof listingRow>;
function listingRow({ status, history, rejectionReason = null, lastApprovedAmount }: Listing) {
  return {
    id: 42,
    cosmeticId: COSMETIC,
    addedById: CREATOR,
    status,
    rejectionReason,
    unitAmount: 500,
    title: 'Gilded Aurora',
    description: 'A ring of light',
    availableQuantity: null,
    meta: { history, ...(lastApprovedAmount ? { lastApprovedAmount } : {}) },
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
const listingsFor = ({ where }: { where: { cosmeticId: { in: number[] } } }) =>
  Promise.resolve(where.cosmeticId.in.includes(COSMETIC) ? [stored] : []);

beforeEach(() => {
  stored = listingRow(SENT_BACK);
  for (const db of [dbMock.dbRead, dbMock.dbWrite])
    db.cosmeticShopItem.findMany.mockReset().mockImplementation(listingsFor);
  dbMock.dbRead.cosmeticShopItem.findUnique.mockReset().mockImplementation(() => stored);
  dbMock.dbWrite.cosmeticShopItem.update
    .mockReset()
    .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      stored = { ...stored, ...data } as typeof stored;
      return stored;
    });
  dbMock.dbWrite.userCosmetic.updateMany.mockReset().mockResolvedValue({ count: 1 });
  dbMock.dbWrite.userCosmetic.findMany.mockReset().mockResolvedValue([]);
});

describe('equipping', () => {
  const owned = (type: string) => [
    { obtainedAt: new Date(), cosmetic: { type, data: { url: 'art' } } },
  ];

  it('refuses a withheld cosmetic and leaves what is worn alone', async () => {
    dbMock.dbRead.userCosmetic.findMany.mockResolvedValue(owned('ProfileDecoration'));

    await expect(equipCosmetic({ userId: CREATOR, cosmeticId: COSMETIC })).rejects.toThrow(
      'This item is in review and cannot be equipped'
    );
    expect(dbMock.dbWrite.userCosmetic.updateMany).not.toHaveBeenCalled();
  });

  it('equips a relisted item that was approved unchanged', async () => {
    stored = listingRow(RELISTED);
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
        equippedToId: 501,
        equippedToType: 'Image',
      })
    ).rejects.toThrow('This item is in review and cannot be equipped');
    expect(dbMock.dbWrite.userCosmetic.updateMany).not.toHaveBeenCalled();
  });
});

describe('withholding takes the cosmetic off everyone', () => {
  const wearers = [
    { userId: BUYER, equippedToId: null, equippedToType: null, cosmetic: { data: {} } },
    { userId: CREATOR, equippedToId: 501, equippedToType: 'Image', cosmetic: { data: {} } },
  ];
  const unequipAll = {
    where: {
      cosmeticId: COSMETIC,
      OR: [{ equippedAt: { not: null } }, { equippedToId: { not: null } }],
    },
    data: { equippedAt: null, equippedToId: null, equippedToType: null },
  };

  beforeEach(() => {
    stored = listingRow({ status: 'Published', history: [submitted(), reviewed('approve', 2)] });
    dbMock.dbWrite.userCosmetic.findMany.mockResolvedValue(wearers);
  });

  it('a request for changes unequips worn and placed copies', async () => {
    await reviewCreatorShopItem({
      reviewerId: MOD,
      id: 42,
      action: 'request-changes',
      rejectionReason: 'Visual quality',
    });

    expect(dbMock.dbWrite.userCosmetic.updateMany).toHaveBeenCalledWith(unequipAll);
  });

  it('re-approval does not put it back on anyone', async () => {
    await reviewCreatorShopItem({ reviewerId: MOD, id: 42, action: 'request-changes' });
    dbMock.dbWrite.userCosmetic.updateMany.mockClear();

    await reviewCreatorShopItem({ reviewerId: MOD, id: 42, action: 'approve' });

    expect(dbMock.dbWrite.userCosmetic.updateMany).not.toHaveBeenCalled();
  });

  it('an edit to what holders see, after approval, unequips it', async () => {
    stored = listingRow(RELISTED);

    await updateCreatorShopItem({ id: 42, userId: CREATOR, name: 'Gilded Aurora II' });

    expect(dbMock.dbWrite.userCosmetic.updateMany).toHaveBeenCalledWith(unequipAll);
  });

  it('a price edit leaves it on', async () => {
    stored = listingRow(RELISTED);

    await updateCreatorShopItem({ id: 42, userId: CREATOR, price: 520 });

    expect(dbMock.dbWrite.userCosmetic.updateMany).not.toHaveBeenCalled();
  });
});

describe('equipped cosmetics shown to other users', () => {
  it('leave out a withheld cosmetic still worn from before withholding unequipped it', async () => {
    dbMock.dbRead.userCosmetic.findMany.mockResolvedValue([
      { userId: BUYER, cosmeticId: COSMETIC, data: null },
      { userId: BUYER, cosmeticId: OTHER_COSMETIC, data: null },
    ]);

    const worn = await userCosmeticCache.fetch([BUYER]);

    expect(worn[BUYER].cosmetics.map((c) => c.cosmeticId)).toEqual([OTHER_COSMETIC]);
  });
});
