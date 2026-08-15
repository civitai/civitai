import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    shopItemFindUnique: vi.fn(),
    shopItemFindMany: vi.fn(),
    userFindUnique: vi.fn(),
    queryRaw: vi.fn(),
    resaleFindUnique: vi.fn(),
    resaleFindMany: vi.fn(),
    resaleAggregate: vi.fn(),
    resaleCreate: vi.fn(),
    resaleDeleteMany: vi.fn(),
    resaleUpdateMany: vi.fn(),
    shopItemUpdate: vi.fn(),
    shopItemFindFirst: vi.fn(),
    shopItemUpdateMany: vi.fn(),
    packMemberFindMany: vi.fn(),
    cosmeticUpdate: vi.fn(),
    transaction: vi.fn(),
    createNotification: vi.fn(),
    getBlockedPairIds: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    cosmeticShopItem: {
      findUnique: mocks.shopItemFindUnique,
      findMany: mocks.shopItemFindMany,
      // Withdrawing an item also runs the pack delist cascade.
      findFirst: mocks.shopItemFindFirst,
    },
    cosmeticShopItemCosmetic: { findMany: mocks.packMemberFindMany },
    user: { findUnique: mocks.userFindUnique },
    userCosmeticShopItemResale: {
      findUnique: mocks.resaleFindUnique,
      findMany: mocks.resaleFindMany,
      aggregate: mocks.resaleAggregate,
    },
    $queryRaw: mocks.queryRaw,
  },
  dbWrite: {
    userCosmeticShopItemResale: {
      create: mocks.resaleCreate,
      deleteMany: mocks.resaleDeleteMany,
      updateMany: mocks.resaleUpdateMany,
    },
    cosmeticShopItem: { update: mocks.shopItemUpdate, updateMany: mocks.shopItemUpdateMany },
    cosmetic: { update: mocks.cosmeticUpdate },
    $transaction: mocks.transaction,
  },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/creator-program.service', () => ({
  hasValidCreatorMembership: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mocks.createNotification,
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getBlockedPairIds: mocks.getBlockedPairIds,
}));

import {
  addResoldItem,
  archiveCreatorShopItem,
  getCreatorShop,
  getCreatorShopResaleStats,
  getResoldItemsForManage,
  getShopItemResellers,
  removeResoldItem,
  reorderResoldItems,
  setCreatorShopItemListed,
  unarchiveCreatorShopItem,
  updateCreatorShopItem,
} from '../creator-shop.service';

const RESELLER_ID = 200;
const CREATOR_ID = 11;
const SHOP_ITEM_ID = 42;

const sellableItem = (sellerShare = 20) => ({
  id: SHOP_ITEM_ID,
  status: 'Published',
  listed: true,
  addedById: CREATOR_ID,
  meta: { sellableByOthers: true, sellerShare },
});

const shopItemRow = (id: number) => ({
  id,
  unitAmount: 1000,
  meta: { sellableByOthers: true, sellerShare: 0 },
  cosmetic: { id: id * 10, name: `Cosmetic ${id}`, type: 'Badge', data: {} },
  addedBy: { id: CREATOR_ID, username: 'creator', image: null },
});

describe('listing someone else’s item records the terms it was listed under', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.getBlockedPairIds.mockResolvedValue([]);
    mocks.shopItemFindUnique.mockResolvedValue(sellableItem());
    mocks.resaleFindUnique.mockResolvedValue(null);
    mocks.resaleAggregate.mockResolvedValue({ _max: { index: 1 } });
  });

  it('writes one row carrying the share on offer right now', async () => {
    await addResoldItem({ userId: RESELLER_ID, shopItemId: SHOP_ITEM_ID });

    expect(mocks.resaleCreate).toHaveBeenCalledWith({
      data: { userId: RESELLER_ID, shopItemId: SHOP_ITEM_ID, sellerShare: 20, index: 2 },
    });
  });

  it('appends past the last index rather than counting rows', async () => {
    // Removing a listing leaves a gap, so a row count would collide with an
    // index that is still in use.
    mocks.resaleAggregate.mockResolvedValue({ _max: { index: 2 } });

    await addResoldItem({ userId: RESELLER_ID, shopItemId: SHOP_ITEM_ID });

    expect(mocks.resaleCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ index: 3 }) })
    );
  });

  it('starts at zero for a creator with no listings', async () => {
    mocks.resaleAggregate.mockResolvedValue({ _max: { index: null } });

    await addResoldItem({ userId: RESELLER_ID, shopItemId: SHOP_ITEM_ID });

    expect(mocks.resaleCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ index: 0 }) })
    );
  });

  it('refuses a second listing of the same item', async () => {
    mocks.resaleFindUnique.mockResolvedValue({ shopItemId: SHOP_ITEM_ID });

    await expect(addResoldItem({ userId: RESELLER_ID, shopItemId: SHOP_ITEM_ID })).rejects.toThrow(
      'already reselling'
    );
    expect(mocks.resaleCreate).not.toHaveBeenCalled();
  });

  it('refuses an item its creator has not opened for resale', async () => {
    mocks.shopItemFindUnique.mockResolvedValue({
      ...sellableItem(),
      meta: { sellableByOthers: false },
    });

    await expect(addResoldItem({ userId: RESELLER_ID, shopItemId: SHOP_ITEM_ID })).rejects.toThrow(
      'not available for other creators to sell'
    );
    expect(mocks.resaleCreate).not.toHaveBeenCalled();
  });

  // Existing listings outlive a delisting, so a NEW one must not be creatable
  // during it — otherwise anyone could undo a delist by adding the item, and a
  // row would exist that was never a live agreement.
  it('refuses an item the creator currently has off sale', async () => {
    mocks.shopItemFindUnique.mockResolvedValue({ ...sellableItem(), listed: false });

    await expect(addResoldItem({ userId: RESELLER_ID, shopItemId: SHOP_ITEM_ID })).rejects.toThrow(
      'not currently for sale'
    );
    expect(mocks.resaleCreate).not.toHaveBeenCalled();
  });

  // Relisting has to re-agree to today's terms — otherwise dropping and
  // re-adding an item would be a way to keep a share that no longer exists.
  it('deletes the row (and its terms with it) when the listing is removed', async () => {
    await removeResoldItem({ userId: RESELLER_ID, shopItemId: SHOP_ITEM_ID });

    expect(mocks.resaleDeleteMany).toHaveBeenCalledWith({
      where: { userId: RESELLER_ID, shopItemId: SHOP_ITEM_ID },
    });
  });

  // Reordering is scoped to the caller's own rows, so a crafted list of someone
  // else's listings can't be reshuffled — and it never touches `sellerShare`.
  it('reordering only writes index, and only on the caller’s rows', async () => {
    mocks.transaction.mockResolvedValue([]);

    await reorderResoldItems({ userId: RESELLER_ID, shopItemIds: [7, SHOP_ITEM_ID] });

    expect(mocks.resaleUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { userId: RESELLER_ID, shopItemId: 7 },
      data: { index: 0 },
    });
    expect(mocks.resaleUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { userId: RESELLER_ID, shopItemId: SHOP_ITEM_ID },
      data: { index: 1 },
    });
  });
});

describe('getResoldItemsForManage reports the grandfathered share', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.getBlockedPairIds.mockResolvedValue([]);
  });

  it('shows what the reseller listed under, not what the creator dropped it to', async () => {
    mocks.resaleFindMany.mockResolvedValue([
      { sellerShare: 50, shopItem: shopItemRow(SHOP_ITEM_ID) },
    ]);

    const items = await getResoldItemsForManage({ userId: RESELLER_ID });

    expect(items).toEqual([expect.objectContaining({ id: SHOP_ITEM_ID, sellerShare: 50 })]);
    expect(mocks.resaleFindMany.mock.calls[0][0].orderBy).toEqual([
      { index: 'asc' },
      { shopItemId: 'asc' },
    ]);
  });
});

describe('getShopItemResellers', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.getBlockedPairIds.mockResolvedValue([]);
    mocks.shopItemFindUnique.mockResolvedValue({
      id: SHOP_ITEM_ID,
      cosmeticId: 1,
      unitAmount: 1000,
      status: 'Published',
      meta: {},
      addedById: CREATOR_ID,
      cosmetic: { id: 1, createdById: CREATOR_ID, type: 'Badge', data: {} },
      _count: { purchases: 0 },
    });
  });

  // The whole point of the table: one indexed read by shopItemId, instead of
  // scanning every user's settings blob for the id.
  it('reads the resellers of one item by shopItemId', async () => {
    mocks.resaleFindMany.mockResolvedValue([
      {
        sellerShare: 20,
        createdAt: new Date('2026-01-01'),
        user: { id: RESELLER_ID, username: 'reseller', image: null, deletedAt: null },
      },
    ]);

    const resellers = await getShopItemResellers({ shopItemId: SHOP_ITEM_ID, userId: CREATOR_ID });

    expect(mocks.resaleFindMany.mock.calls[0][0].where).toEqual({ shopItemId: SHOP_ITEM_ID });
    expect(resellers).toEqual([
      {
        user: { id: RESELLER_ID, username: 'reseller', image: null },
        sellerShare: 20,
        listedAt: new Date('2026-01-01'),
      },
    ]);
  });

  it('hides deleted accounts', async () => {
    mocks.resaleFindMany.mockResolvedValue([
      {
        sellerShare: 20,
        createdAt: new Date('2026-01-01'),
        user: { id: RESELLER_ID, username: 'gone', image: null, deletedAt: new Date() },
      },
    ]);

    expect(await getShopItemResellers({ shopItemId: SHOP_ITEM_ID, userId: CREATOR_ID })).toEqual(
      []
    );
  });

  // Most creators have no `user.image` at all — the avatar lives on the
  // `profilePicture` relation, and the decorations, nameplate and badges live on
  // equipped `cosmetics`. UserAvatar falls back to `image` only when the
  // relation is absent, so a select missing either renders a bare placeholder
  // for nearly every reseller, which is what shipped.
  it('selects everything UserAvatar draws, not just user.image', async () => {
    mocks.resaleFindMany.mockResolvedValue([]);

    await getShopItemResellers({ shopItemId: SHOP_ITEM_ID, userId: CREATOR_ID });

    const userSelect = mocks.resaleFindMany.mock.calls[0][0].select.user.select;
    expect(userSelect.profilePicture).toBeTruthy();
    expect(userSelect.cosmetics).toBeTruthy();
  });

  it('refuses to tell a stranger who resells someone else’s item', async () => {
    await expect(getShopItemResellers({ shopItemId: SHOP_ITEM_ID, userId: 999 })).rejects.toThrow();
    expect(mocks.resaleFindMany).not.toHaveBeenCalled();
  });
});

describe('the owner can change an item’s resale terms after publishing', () => {
  const ownedItem = (meta: Record<string, unknown>) => ({
    id: SHOP_ITEM_ID,
    cosmeticId: 1,
    unitAmount: 1000,
    status: 'Published',
    meta,
    addedById: CREATOR_ID,
    cosmetic: { id: 1, createdById: CREATOR_ID, type: 'Badge', data: {} },
    _count: { purchases: 4 },
  });
  const savedMeta = () => mocks.shopItemUpdate.mock.calls.at(-1)?.[0].data.meta;
  const update = (input: Record<string, unknown>, userId = CREATOR_ID) =>
    updateCreatorShopItem({ id: SHOP_ITEM_ID, userId, ...input });

  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.getBlockedPairIds.mockResolvedValue([]);
    mocks.shopItemFindUnique.mockResolvedValue(
      ownedItem({ sellableByOthers: true, sellerShare: 50, purchases: 4 })
    );
    mocks.shopItemUpdate.mockResolvedValue({});
  });

  it('writes the new share and leaves the rest of meta alone', async () => {
    await update({ sellerShare: 10 });

    expect(savedMeta()).toMatchObject({ sellableByOthers: true, sellerShare: 10, purchases: 4 });
  });

  // The bait-and-switch guard lives on the listing rows, so the edit must not
  // touch them — every existing reseller keeps the 50% they listed under.
  it('never rewrites an existing reseller’s row', async () => {
    await update({ sellerShare: 0 });

    expect(mocks.resaleUpdateMany).not.toHaveBeenCalled();
    expect(mocks.resaleCreate).not.toHaveBeenCalled();
    expect(mocks.resaleDeleteMany).not.toHaveBeenCalled();
  });

  // Mirrors submit: no resale, no share. Otherwise switching the toggle off and
  // back on would quietly restore a share the creator had retired.
  it('zeroes the share when resale is switched off', async () => {
    await update({ sellableByOthers: false });

    expect(savedMeta()).toMatchObject({ sellableByOthers: false, sellerShare: 0 });
  });

  it('keeps resale on when only the share is sent', async () => {
    await update({ sellerShare: 25 });

    expect(savedMeta()).toMatchObject({ sellableByOthers: true, sellerShare: 25 });
  });

  it('leaves resale terms untouched when the edit does not mention them', async () => {
    await update({ availableQuantity: 20 });

    expect(savedMeta()).toMatchObject({ sellableByOthers: true, sellerShare: 50 });
  });

  // A payment term, not content: a live item stays live rather than dropping out
  // of the shop into the review queue.
  it('does not push a published item back into review', async () => {
    await update({ sellerShare: 10 });

    expect(mocks.shopItemUpdate.mock.calls[0][0].data.status).toBe('Published');
    expect(mocks.cosmeticUpdate).not.toHaveBeenCalled();
  });

  it('refuses a cross-lister editing the original creator’s terms', async () => {
    mocks.shopItemFindUnique.mockResolvedValue({
      ...ownedItem({ sellableByOthers: true, sellerShare: 50 }),
      // Listed by someone else; the cosmetic still belongs to CREATOR_ID.
      addedById: RESELLER_ID,
    });

    await expect(update({ sellerShare: 0 }, RESELLER_ID)).rejects.toThrow(
      'only change price and quantity'
    );
    expect(mocks.shopItemUpdate).not.toHaveBeenCalled();
  });
});

describe('getCreatorShopResaleStats', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
  });

  it('returns the aggregate row', async () => {
    mocks.queryRaw.mockResolvedValue([{ resellers: 3, resoldItems: 2, reselling: 5 }]);

    expect(await getCreatorShopResaleStats({ userId: CREATOR_ID })).toEqual({
      resellers: 3,
      resoldItems: 2,
      reselling: 5,
    });
  });

  // An aggregate over no rows still returns a row, but the stat cards render
  // whatever comes back — never let that be undefined.
  it('falls back to zeroes rather than undefined when the query returns nothing', async () => {
    mocks.queryRaw.mockResolvedValue([]);

    expect(await getCreatorShopResaleStats({ userId: CREATOR_ID })).toEqual({
      resellers: 0,
      resoldItems: 0,
      reselling: 0,
    });
  });
});

describe('getCreatorShop resold section', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.getBlockedPairIds.mockResolvedValue([]);
    mocks.shopItemFindMany.mockResolvedValue([]);
    mocks.queryRaw.mockResolvedValue([{ count: 0 }]);
    mocks.userFindUnique.mockResolvedValue({ settings: { creatorShop: { enabled: true } } });
  });

  // The resold query is the second findMany in the Promise.all.
  const resoldWhere = () => mocks.shopItemFindMany.mock.calls[1][0].where;

  // The listing row is the permission, so a withdrawn `sellableByOthers` no
  // longer has to be re-checked — it can't strip an existing reseller.
  it('selects by the reseller’s own listings, not by the item’s current terms', async () => {
    mocks.resaleFindMany.mockResolvedValue([{ shopItemId: SHOP_ITEM_ID, sellerShare: 20 }]);

    await getCreatorShop({ userId: RESELLER_ID, viewerId: RESELLER_ID });

    expect(resoldWhere().id).toEqual({ in: [SHOP_ITEM_ID] });
    expect(resoldWhere().meta).toBeUndefined();
  });

  it('reports the grandfathered share to the buyer, so checkout matches the payout', async () => {
    mocks.resaleFindMany.mockResolvedValue([{ shopItemId: SHOP_ITEM_ID, sellerShare: 50 }]);
    mocks.shopItemFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([shopItemRow(SHOP_ITEM_ID)]);

    const { resold } = await getCreatorShop({ userId: RESELLER_ID, viewerId: RESELLER_ID });

    expect(resold).toEqual([
      expect.objectContaining({ meta: expect.objectContaining({ sellerShare: 50 }) }),
    ]);
  });

  // Withdrawal ends the listings outright, so the storefront only ever has to
  // ask whether the item is on sale — a delisted one has nothing left to show.
  it('still requires the item to be live', async () => {
    mocks.resaleFindMany.mockResolvedValue([{ shopItemId: SHOP_ITEM_ID, sellerShare: 20 }]);

    await getCreatorShop({ userId: RESELLER_ID, viewerId: RESELLER_ID });

    expect(resoldWhere().status).toBe('Published');
    expect(resoldWhere().listed).toBe(true);
  });

  // Preview is a moderator design aid with no resale rows behind it, so it must
  // keep showing only what's genuinely on offer.
  it('preview still requires a live, resellable item', async () => {
    mocks.resaleFindMany.mockResolvedValue([]);

    await getCreatorShop({ userId: RESELLER_ID, viewerId: RESELLER_ID, preview: true });

    expect(resoldWhere().status).toBe('Published');
    expect(resoldWhere().listed).toBe(true);
    expect(resoldWhere().meta).toEqual({ path: ['sellableByOthers'], equals: true });
  });
});

describe('withdrawing an item ends its resale listings', () => {
  const ownedItem = (over: Record<string, unknown> = {}) => ({
    id: SHOP_ITEM_ID,
    cosmeticId: 1,
    unitAmount: 1000,
    status: 'Published',
    title: 'Golden Laurel',
    meta: { sellableByOthers: true, sellerShare: 20 },
    addedById: CREATOR_ID,
    cosmetic: { id: 1, createdById: CREATOR_ID, type: 'Badge', data: {} },
    _count: { purchases: 0 },
    ...over,
  });
  const savedData = () => mocks.shopItemUpdate.mock.calls.at(-1)?.[0].data;

  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.getBlockedPairIds.mockResolvedValue([]);
    mocks.shopItemFindUnique.mockResolvedValue(ownedItem());
    mocks.shopItemUpdate.mockResolvedValue({});
    mocks.resaleFindMany.mockResolvedValue([
      { userId: RESELLER_ID, user: { username: 'reseller' } },
    ]);
    mocks.userFindUnique.mockResolvedValue({ settings: { creatorShop: {} } });
    // The pack delist cascade archiving runs alongside this: no other listing
    // of the cosmetic survives, and no pack bundles it.
    mocks.shopItemFindFirst.mockResolvedValue(null);
    mocks.packMemberFindMany.mockResolvedValue([]);
    mocks.shopItemUpdateMany.mockResolvedValue({ count: 0 });
  });

  it('deletes every listing when the item is delisted', async () => {
    await setCreatorShopItemListed({ id: SHOP_ITEM_ID, userId: CREATOR_ID, listed: false });

    expect(mocks.resaleDeleteMany).toHaveBeenCalledWith({ where: { shopItemId: SHOP_ITEM_ID } });
  });

  it('deletes every listing when the item is archived', async () => {
    await archiveCreatorShopItem({ id: SHOP_ITEM_ID, userId: CREATOR_ID });

    expect(mocks.resaleDeleteMany).toHaveBeenCalledWith({ where: { shopItemId: SHOP_ITEM_ID } });
  });

  // Their shop just lost a card; they find out from us, not by noticing.
  it('notifies each creator who was reselling it', async () => {
    await setCreatorShopItemListed({ id: SHOP_ITEM_ID, userId: CREATOR_ID, listed: false });

    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'creator-shop-resale-ended',
        userId: RESELLER_ID,
        details: { title: 'Golden Laurel', username: 'reseller' },
      })
    );
  });

  // One undeliverable notification shouldn't cost the other resellers theirs,
  // nor fail a withdrawal whose listings are already gone.
  it('still notifies the rest when one notification fails', async () => {
    mocks.resaleFindMany.mockResolvedValue([
      { userId: RESELLER_ID, user: { username: 'reseller' } },
      { userId: RESELLER_ID + 1, user: { username: 'other' } },
    ]);
    mocks.createNotification.mockRejectedValueOnce(new Error('nope'));

    await expect(
      setCreatorShopItemListed({ id: SHOP_ITEM_ID, userId: CREATOR_ID, listed: false })
    ).resolves.toBeDefined();

    expect(mocks.createNotification).toHaveBeenCalledTimes(2);
  });

  it('skips the notification pass when nobody was reselling it', async () => {
    mocks.resaleFindMany.mockResolvedValue([]);

    await archiveCreatorShopItem({ id: SHOP_ITEM_ID, userId: CREATOR_ID });

    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  // The guardrail that makes ending the listings fair: withdraw → re-list can't
  // be a one-click way to clear your resellers and re-offer at a worse share.
  it('sends the item back to review when it is re-listed', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(ownedItem({ listed: false }));

    await setCreatorShopItemListed({ id: SHOP_ITEM_ID, userId: CREATOR_ID, listed: true });

    expect(savedData()).toMatchObject({
      listed: true,
      status: 'PendingReview',
      rejectionReason: null,
      reviewedById: null,
      reviewedAt: null,
    });
    // Nothing to end — re-listing takes nothing away from anyone.
    expect(mocks.resaleDeleteMany).not.toHaveBeenCalled();
  });

  it('sends the item back to review when it is restored from the archive', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(ownedItem({ status: 'Archived' }));

    await unarchiveCreatorShopItem({ id: SHOP_ITEM_ID, userId: CREATOR_ID });

    expect(savedData()).toMatchObject({ status: 'PendingReview', archivedAt: null });
  });

  it('delisting leaves the status alone — only re-listing re-enters review', async () => {
    await setCreatorShopItemListed({ id: SHOP_ITEM_ID, userId: CREATOR_ID, listed: false });

    expect(savedData()).toEqual({ listed: false });
  });
});
