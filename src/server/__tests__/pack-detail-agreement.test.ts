import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';

/**
 * The quote and the charge, against the same fixture.
 *
 * `getPackDetail` computes every number the buyer sees and the button gates on,
 * and had no coverage at all. Sharing `computePackAmountDue` guarantees the two
 * apply the same *rule* — it does not guarantee they are handed the same
 * *inputs*, and both defects found in this area (a replica-lagged ownership read,
 * and a lister the client couldn't identify) lived in the inputs and the shape.
 */

const packMemberFindMany = vi.fn();
const shopItemFindUnique = vi.fn();
const shopItemFindMany = vi.fn();
const componentGroupBy = vi.fn();
const ownedFindMany = vi.fn();
const spend = vi.fn();

vi.mock('~/server/db/client', () => ({
  dbRead: {
    cosmeticShopItem: {
      findUnique: (...a: unknown[]) => shopItemFindUnique(...a),
      findMany: (...a: unknown[]) => shopItemFindMany(...a),
    },
    cosmeticShopItemCosmetic: { findMany: (...a: unknown[]) => packMemberFindMany(...a) },
    userCosmeticShopPurchaseCosmetic: { groupBy: (...a: unknown[]) => componentGroupBy(...a) },
    userCosmetic: { findMany: (...a: unknown[]) => ownedFindMany(...a) },
  },
  dbWrite: {
    userCosmetic: { findMany: (...a: unknown[]) => ownedFindMany(...a) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRaw: vi.fn(),
        userCosmetic: {
          findMany: (...a: unknown[]) => ownedFindMany(...a),
          createMany: vi.fn(),
        },
        userCosmeticShopPurchases: { create: vi.fn() },
        userCosmeticShopPurchaseCosmetic: { createMany: vi.fn() },
        cosmeticShopItem: { update: vi.fn() },
      }),
    userCosmeticShopPurchases: { update: vi.fn() },
  },
}));
vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction: (...a: unknown[]) => spend(...a),
  createBuzzTransaction: vi.fn().mockResolvedValue({ transactionId: 'tx' }),
  refundMultiAccountTransaction: vi.fn(),
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getBlockedPairIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('~/server/redis/caches', () => ({ refreshOwnedStickerCache: vi.fn() }));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));

const { getPackDetail } = await import('~/server/services/creator-shop-pack.service');
const { getPackMembers, purchaseCosmeticPack } = await import(
  '~/server/services/cosmetic-pack.service'
);

const PACK_ID = 6001;
const LISTER = 701;
const BUYER = 702;
const OTHER_CREATOR = 703;
const OWN_MEMBER = 4001;
const FOREIGN_MEMBER = 4002;
const RESELLER = 704;
const RESALE_PRICE = 4400;
const PRICE = 8800;

const memberRows = [
  { cosmeticId: OWN_MEMBER, floorAmount: 2600, index: 0 },
  { cosmeticId: FOREIGN_MEMBER, floorAmount: 3100, index: 1 },
];

const cosmeticFor = (id: number) => ({
  id,
  name: id === OWN_MEMBER ? 'Own badge' : 'Foreign badge',
  type: CosmeticType.Badge,
  data: { url: 'img' },
  createdById: id === OWN_MEMBER ? LISTER : OTHER_CREATOR,
  creator: { username: id === OWN_MEMBER ? 'lister' : 'other' },
});

beforeEach(() => {
  vi.clearAllMocks();
  shopItemFindUnique.mockResolvedValue({
    id: PACK_ID,
    cosmeticId: null,
    title: 'A pack',
    description: null,
    unitAmount: PRICE,
    status: CosmeticShopItemStatus.Published,
    listed: true,
    availableQuantity: null,
    meta: { purchases: 0 },
    addedById: LISTER,
    members: memberRows.map(({ cosmeticId, floorAmount }) => ({ cosmeticId, floorAmount })),
  });
  packMemberFindMany.mockResolvedValue(
    memberRows.map((row) => ({ ...row, cosmetic: cosmeticFor(row.cosmeticId) }))
  );
  shopItemFindMany.mockResolvedValue([
    ...memberRows.map((row) => ({
      id: 9000 + row.cosmeticId,
      cosmeticId: row.cosmeticId,
      unitAmount: row.floorAmount,
      meta: { purchases: 0 },
      addedById: cosmeticFor(row.cosmeticId).createdById,
      availableQuantity: null,
      availableFrom: null,
      availableTo: null,
      _count: { purchases: 0 },
      cosmetic: cosmeticFor(row.cosmeticId),
    })),
    // A second listing of the foreign member, pricier and listed by someone
    // else. With one listing each, "pick the highest-priced" is a no-op in both
    // resolvers and the suite cannot show they pick the SAME one — which is what
    // decides the reseller payout and the block check.
    {
      id: 9500,
      cosmeticId: FOREIGN_MEMBER,
      unitAmount: RESALE_PRICE,
      meta: { purchases: 0, sellerShare: 20 },
      addedById: RESELLER,
      availableQuantity: null,
      availableFrom: null,
      availableTo: null,
      _count: { purchases: 0 },
      cosmetic: cosmeticFor(FOREIGN_MEMBER),
    },
  ]);
  componentGroupBy.mockResolvedValue([]);
  ownedFindMany.mockResolvedValue([]);
  spend.mockImplementation(({ amount }: { amount: number }) => ({
    transactionCount: 1,
    transactionIds: [{ accountType: 'yellow', amount }],
  }));
});

const charge = async (userId: number) => {
  const members = await getPackMembers(PACK_ID);
  await purchaseCosmeticPack({
    userId,
    shopItem: {
      id: PACK_ID,
      title: 'A pack',
      unitAmount: PRICE,
      addedById: LISTER,
      meta: { purchases: 0 },
      // The build-time count, as the caller passes (`meta.packMemberCount`) —
      // NOT `members.length`, which is the tautology the real code avoids.
      memberCount: memberRows.length,
    },
    members,
    stickersEnabled: true,
  });
  return spend.mock.calls[0]?.[0]?.amount as number;
};

describe('getPackDetail agrees with what the purchase charges', () => {
  it('quotes the full price to a buyer who owns nothing', async () => {
    const detail = await getPackDetail({ shopItemId: PACK_ID, userId: BUYER });
    expect(detail.amountDue).toBe(PRICE);
    expect(await charge(BUYER)).toBe(detail.amountDue);
  });

  it('quotes the discounted price to a buyer who owns a lister member', async () => {
    ownedFindMany.mockResolvedValue([{ cosmeticId: OWN_MEMBER }]);
    const detail = await getPackDetail({ shopItemId: PACK_ID, userId: BUYER });
    expect(detail.discount).toBeGreaterThan(0);
    expect(detail.amountDue).toBeLessThan(PRICE);
    expect(await charge(BUYER)).toBe(detail.amountDue);
  });

  it('marks the lister as such, and the purchase refuses them', async () => {
    const detail = await getPackDetail({ shopItemId: PACK_ID, userId: LISTER });
    expect(detail.isPackCreator).toBe(true);
    await expect(charge(LISTER)).rejects.toThrow(/your own pack/i);
    expect(spend).not.toHaveBeenCalled();
  });

  it('does not mark an ordinary buyer as the lister', async () => {
    const detail = await getPackDetail({ shopItemId: PACK_ID, userId: BUYER });
    expect(detail.isPackCreator).toBe(false);
  });

  it('quotes the full price to an anonymous viewer rather than a free one', async () => {
    const detail = await getPackDetail({ shopItemId: PACK_ID });
    expect(detail.amountDue).toBe(PRICE);
    expect(detail.isPackCreator).toBe(false);
  });

  it('reports a member with no live listing, which is the state the purchase refuses', async () => {
    shopItemFindMany.mockResolvedValue([]);
    const detail = await getPackDetail({ shopItemId: PACK_ID, userId: BUYER });
    expect(detail.unavailableCount).toBe(memberRows.length);
    await expect(charge(BUYER)).rejects.toThrow(/no longer available/i);
  });

  it('both resolvers land on the same listing when a member has several', async () => {
    const detail = await getPackDetail({ shopItemId: PACK_ID, userId: BUYER });
    // The detail quotes the snapshot, so the resale price shows as today's price
    // rather than as what this pack charges.
    const foreign = detail.members.find((m) => m.cosmeticId === FOREIGN_MEMBER);
    expect(foreign?.currentListPrice).toBe(RESALE_PRICE);
    expect(foreign?.listPrice).toBe(3100);

    const members = await getPackMembers(PACK_ID);
    const purchaseSide = members.find((m) => m.cosmeticId === FOREIGN_MEMBER);
    // Same row on both sides: the pricier listing, hence its lister and terms.
    expect(purchaseSide?.addedById).toBe(RESELLER);
    expect(purchaseSide?.listingMeta.sellerShare).toBe(20);
  });

  // Whenever a member cannot be resolved, the purchase refuses — so the detail
  // must never quote a price for a pack that can't be bought. The all-missing
  // case is easy; the partial one is where a lower quote could leak out.
  it('refuses a partially unavailable pack rather than quoting the survivors', async () => {
    shopItemFindMany.mockResolvedValue([
      {
        id: 9000 + OWN_MEMBER,
        cosmeticId: OWN_MEMBER,
        unitAmount: 2600,
        meta: { purchases: 0 },
        addedById: LISTER,
        availableQuantity: null,
        availableFrom: null,
        availableTo: null,
        _count: { purchases: 0 },
        cosmetic: cosmeticFor(OWN_MEMBER),
      },
    ]);
    const detail = await getPackDetail({ shopItemId: PACK_ID, userId: BUYER });
    expect(detail.unavailableCount).toBe(1);
    await expect(charge(BUYER)).rejects.toThrow(/no longer available/i);
  });
});
