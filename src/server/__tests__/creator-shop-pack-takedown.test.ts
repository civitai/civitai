import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The takedown call site that decides *which* holdings a pack takedown revokes.
 *
 * This is where the worst defect in the whole review lived: an empty claim-key
 * list read as "no scope" and revoked every member cosmetic from every owner.
 * Nothing covered it, in either direction — `revokeCosmeticsFromUsers` has its
 * own unit test, but the caller that computes the scope had none.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: {
    shopItemFindUnique: vi.fn(),
    shopItemUpdate: vi.fn(),
    shopItemUpdateMany: vi.fn(),
    shopItemFindFirst: vi.fn(),
    sectionItemDeleteMany: vi.fn(),
    packMemberFindMany: vi.fn(),
    purchaseFindMany: vi.fn(),
    purchaseUpdate: vi.fn(),
    userCosmeticFindMany: vi.fn(),
    userFindUnique: vi.fn(),
    revokeCosmeticsFromUsers: vi.fn(),
    removePlacementsByCosmetic: vi.fn(),
    refundMultiAccountTransaction: vi.fn(),
    createBuzzTransaction: vi.fn(),
    refundTransaction: vi.fn(),
    createNotification: vi.fn(),
    logToAxiom: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    cosmeticShopItem: { findUnique: mocks.shopItemFindUnique, findFirst: mocks.shopItemFindFirst },
    cosmeticShopItemCosmetic: { findMany: mocks.packMemberFindMany },
    userCosmeticShopPurchases: { findMany: mocks.purchaseFindMany },
    userCosmetic: { findMany: mocks.userCosmeticFindMany },
    user: { findUnique: mocks.userFindUnique },
  },
  dbWrite: {
    cosmeticShopItem: {
      findUnique: mocks.shopItemFindUnique,
      update: mocks.shopItemUpdate,
      updateMany: mocks.shopItemUpdateMany,
    },
    cosmeticShopSectionItem: { deleteMany: mocks.sectionItemDeleteMany },
    userCosmeticShopPurchases: { findMany: mocks.purchaseFindMany, update: mocks.purchaseUpdate },
    userCosmetic: { findMany: mocks.userCosmeticFindMany },
  },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: mocks.createBuzzTransaction,
  refundMultiAccountTransaction: mocks.refundMultiAccountTransaction,
  refundTransaction: mocks.refundTransaction,
}));
vi.mock('~/server/services/cosmetic.service', () => ({
  revokeCosmeticsFromUsers: mocks.revokeCosmeticsFromUsers,
  validateStickerCosmetic: vi.fn(),
  isStickerSlugAvailable: vi.fn(),
}));
vi.mock('~/server/services/placement-moderation.service', () => ({
  removePlacementsByCosmetic: mocks.removePlacementsByCosmetic,
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mocks.createNotification,
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mocks.logToAxiom }));
vi.mock('~/server/services/user-preferences.service', () => ({
  getBlockedPairIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('~/server/redis/caches', () => ({ refreshOwnedStickerCache: vi.fn() }));

const { takedownCosmeticShopItem } = await import('~/server/services/creator-shop.service');

const PACK_ID = 8001;
const MEMBER_A = 2001;
const MEMBER_B = 2002;
const PACK_BUYER = 3001;
const OTHER_OWNER = 3002;
const MODERATOR = 9;

const packRow = {
  id: PACK_ID,
  cosmeticId: null,
  title: 'Starter pack',
  meta: {},
  addedById: 4001,
  cosmetic: null,
};

const purchase = (id: string, userId = PACK_BUYER, unitAmount = 5000) => ({
  userId,
  buzzTransactionId: id,
  unitAmount,
  meta: { payouts: [{ userId: 4001, amount: 3500, color: 'yellow', transactionId: 'p1' }] },
});

const revokeArgs = () => mocks.revokeCosmeticsFromUsers.mock.calls[0]?.[0];

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.shopItemFindUnique.mockResolvedValue(packRow);
  mocks.shopItemUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
    id: PACK_ID,
    ...data,
  }));
  mocks.packMemberFindMany.mockResolvedValue([{ cosmeticId: MEMBER_A }, { cosmeticId: MEMBER_B }]);
  mocks.purchaseFindMany.mockResolvedValue([]);
  mocks.userCosmeticFindMany.mockResolvedValue([]);
  mocks.userFindUnique.mockResolvedValue({ settings: {} });
  mocks.shopItemFindFirst.mockResolvedValue(null);
  mocks.shopItemUpdateMany.mockResolvedValue({ count: 0 });
  mocks.revokeCosmeticsFromUsers.mockResolvedValue({ revoked: 0 });
  mocks.removePlacementsByCosmetic.mockResolvedValue({
    considered: 0,
    settled: 0,
    failed: [],
    takenDown: 0,
    hasMore: false,
  });
  mocks.refundMultiAccountTransaction.mockResolvedValue({
    refundedTransactions: [{ accountType: 'yellow', amount: 5000 }],
  });
  mocks.createBuzzTransaction.mockResolvedValue({ transactionId: 'tx' });
  mocks.logToAxiom.mockResolvedValue(undefined);
});

describe('takedownCosmeticShopItem — pack scoping', () => {
  // The critical bug: an empty claim list is not an absent one. These owners
  // exist and hold the members by other routes — bought individually, granted on
  // approval, or via another pack. A fixture with no owners cannot fail here,
  // which is exactly how the bug survived: the danger is that they get stripped.
  const ownersByOtherRoutes = [{ userId: PACK_BUYER }, { userId: OTHER_OWNER }];

  it('revokes NOTHING when the pack never sold, even though the members have owners', async () => {
    mocks.userCosmeticFindMany.mockResolvedValue(ownersByOtherRoutes);
    await takedownCosmeticShopItem({ id: PACK_ID, reason: 'test', moderatorId: MODERATOR });
    const args = revokeArgs();
    // Either not called at all, or called with a scope that can match nothing.
    expect(args === undefined || args.claimKeys?.length === 0).toBe(true);
  });

  it('revokes NOTHING when every purchase was already refunded', async () => {
    // Driven through the service's own `refunded: false` filter rather than by
    // handing it an empty array — otherwise this asserts the mock, not the code.
    mocks.purchaseFindMany.mockImplementation(({ where }: { where: { refunded: boolean } }) =>
      where.refunded === false ? [] : [purchase('already-refunded')]
    );
    mocks.userCosmeticFindMany.mockResolvedValue(ownersByOtherRoutes);
    await takedownCosmeticShopItem({ id: PACK_ID, reason: 'test', moderatorId: MODERATOR });
    const args = revokeArgs();
    expect(args === undefined || args.claimKeys?.length === 0).toBe(true);
  });

  // Not tidiness: unscoped, this query pulls every holder of every member
  // cosmetic into memory, which for a popular member is a production hazard in
  // its own right.
  it('does not scan every holder of every member when the pack never sold', async () => {
    mocks.userCosmeticFindMany.mockResolvedValue(ownersByOtherRoutes);
    await takedownCosmeticShopItem({ id: PACK_ID, reason: 'test', moderatorId: MODERATOR });
    const ownerQueries = mocks.userCosmeticFindMany.mock.calls.filter(
      (call) => call[0]?.where?.cosmeticId
    );
    // Pinned both ways: today the guard skips the query entirely, so the loop
    // below runs zero times. Without this, a future change that always runs it
    // would silently turn this test into a no-op.
    expect(ownerQueries).toHaveLength(0);
    for (const [query] of ownerQueries) expect(query.where.claimKey).toBeDefined();
  });

  it('scopes the revoke to this pack purchases claim keys', async () => {
    mocks.purchaseFindMany.mockResolvedValue([
      purchase('pack-tx-1'),
      purchase('pack-tx-2', OTHER_OWNER),
    ]);
    mocks.userCosmeticFindMany.mockResolvedValue([{ userId: PACK_BUYER }, { userId: OTHER_OWNER }]);
    await takedownCosmeticShopItem({ id: PACK_ID, reason: 'test', moderatorId: MODERATOR });
    expect(revokeArgs()?.claimKeys).toEqual(['pack-tx-1', 'pack-tx-2']);
    expect(revokeArgs()?.cosmeticIds).toEqual([MEMBER_A, MEMBER_B]);
  });

  it('looks up owners with the same claim scope it revokes with', async () => {
    mocks.purchaseFindMany.mockResolvedValue([purchase('pack-tx-1')]);
    mocks.userCosmeticFindMany.mockResolvedValue([{ userId: PACK_BUYER }]);
    await takedownCosmeticShopItem({ id: PACK_ID, reason: 'test', moderatorId: MODERATOR });
    // A wider lookup than the revoke would report owners who keep their items.
    const ownerQuery = mocks.userCosmeticFindMany.mock.calls.at(-1)?.[0];
    expect(ownerQuery?.where?.claimKey).toEqual({ in: ['pack-tx-1'] });
  });

  // The placement sweep deliberately does NOT inherit the revoke's scope, and it
  // was written the other way first. A pack's claim keys miss every holding
  // obtained another way — the maker's own creator grant above all — so a scoped
  // sweep leaves the abusive artwork up on everything its author placed it on,
  // which is the one outcome the feature exists to prevent. The cost, accepted:
  // someone holding the same sticker inside the pack and standalone loses all of
  // their placements of it.
  const sweepArgs = () => mocks.removePlacementsByCosmetic.mock.calls[0]?.[0];

  it('sweeps placements of every member, not only the pack buyers', async () => {
    mocks.purchaseFindMany.mockResolvedValue([
      purchase('pack-tx-1'),
      purchase('pack-tx-2', OTHER_OWNER),
    ]);
    mocks.userCosmeticFindMany.mockResolvedValue([{ userId: PACK_BUYER }, { userId: OTHER_OWNER }]);
    await takedownCosmeticShopItem({ id: PACK_ID, reason: 'test', moderatorId: MODERATOR });
    expect(sweepArgs()).not.toHaveProperty('placerIds');
    expect(sweepArgs()?.cosmeticIds).toEqual([MEMBER_A, MEMBER_B]);
  });

  // A pack that never sold revokes from nobody — but its members' artwork is
  // still taken down, so the placements still come off.
  it('still sweeps when the pack never sold and nothing was revoked', async () => {
    mocks.userCosmeticFindMany.mockResolvedValue([{ userId: PACK_BUYER }, { userId: OTHER_OWNER }]);
    await takedownCosmeticShopItem({ id: PACK_ID, reason: 'test', moderatorId: MODERATOR });
    expect(sweepArgs()?.cosmeticIds).toEqual([MEMBER_A, MEMBER_B]);
  });

  it('a single-item takedown is still unscoped', async () => {
    mocks.shopItemFindUnique.mockResolvedValue({
      ...packRow,
      cosmeticId: MEMBER_A,
      cosmetic: { createdById: 4001, creator: { username: 'someone' } },
    });
    mocks.purchaseFindMany.mockResolvedValue([purchase('single-tx')]);
    mocks.userCosmeticFindMany.mockResolvedValue([{ userId: PACK_BUYER }]);
    await takedownCosmeticShopItem({ id: PACK_ID, reason: 'test', moderatorId: MODERATOR });
    expect(revokeArgs()?.claimKeys).toBeUndefined();
    expect(revokeArgs()?.cosmeticIds).toEqual([MEMBER_A]);
  });
});
