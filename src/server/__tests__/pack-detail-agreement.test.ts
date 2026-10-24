import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { shopPurchaseClaimFake } from '~/test-utils/shopPurchaseClaimFake';

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

const claims = shopPurchaseClaimFake();

vi.mock('~/server/db/client', () => ({
  dbRead: {
    cosmeticShopItem: {
      findUnique: (...a: unknown[]) => shopItemFindUnique(...a),
      findMany: (...a: unknown[]) => shopItemFindMany(...a),
    },
    cosmeticShopItemCosmetic: { findMany: (...a: unknown[]) => packMemberFindMany(...a) },
    userCosmeticShopPurchaseCosmetic: { groupBy: (...a: unknown[]) => componentGroupBy(...a) },
    userCosmetic: { findMany: (...a: unknown[]) => ownedFindMany(...a) },
    userCosmeticShopItemResale: { findMany: vi.fn().mockResolvedValue([]) },
  },
  dbWrite: {
    userCosmetic: { findMany: (...a: unknown[]) => ownedFindMany(...a) },
    cosmeticShopPurchaseClaim: {
      create: (...a: Parameters<typeof claims.delegate.create>) => claims.delegate.create(...a),
    },
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
        cosmeticShopPurchaseClaim: claims.txDelegate,
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
const { getPackDetail } = await import('~/server/services/creator-shop-pack.service');
const { getPackMembers, purchaseCosmeticPack } = await import(
  '~/server/services/cosmetic-pack.service'
);
const { purchaseCosmeticShopItem } = await import('~/server/services/cosmetic-shop.service');
const { getPackPurchaseBlockers } = await import(
  '~/components/CosmeticShop/pack-purchase-blockers'
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
    meta: { purchases: 0, packMemberCount: memberRows.length },
    addedById: LISTER,
    members: memberRows.map(({ cosmeticId, floorAmount }) => ({ cosmeticId, floorAmount })),
    _count: { purchases: 0 },
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
    // The only thing pinning the `!== packCreatorId` half of
    // isSelfAuthoredPackMember: without it the lister's own members read as
    // self-authored and their quote drops by that much, silently.
    expect(detail.amountDue).toBe(PRICE);
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

/**
 * `meta.purchases` and the `UserCosmeticShopPurchase` rows are two live answers
 * to "how many sold", and they disagree on 47 of 1,902 prod listings. The rows
 * are the one the sold-out gate, the quantity floor, the delete guard and the
 * MostPopular sort have always used; the counter is bumped outside the purchase
 * transaction, so a concurrent buy loses an increment and a rolled-back buy
 * keeps one.
 *
 * TO WHOEVER IS ABOUT TO DELETE THIS: the fixture is prod item 74, "Fairy Pony
 * (Limited Edition)" — quantity 20, counter 0, twenty purchase rows. Reading the
 * counter renders "20 remaining" on a sold-out pack behind a buy button that
 * throws. Putting `packMeta.purchases` back is what these assertions exist to
 * catch, so if one fails, the read moved back to the counter.
 */
describe('the sold count is the purchase rows, not the meta counter', () => {
  const soldOutWithStaleCounter = () =>
    shopItemFindUnique.mockResolvedValue({
      id: PACK_ID,
      cosmeticId: null,
      title: 'A pack',
      description: null,
      unitAmount: PRICE,
      status: CosmeticShopItemStatus.Published,
      listed: true,
      availableQuantity: 20,
      // The two disagree, and by more than an off-by-one: a fixture where they
      // agree passes under either derivation and tests nothing.
      meta: { purchases: 0, packMemberCount: memberRows.length },
      addedById: LISTER,
      members: memberRows.map(({ cosmeticId, floorAmount }) => ({ cosmeticId, floorAmount })),
      _count: { purchases: 20 },
    });

  it('reports the row count when the counter understates it', async () => {
    soldOutWithStaleCounter();
    const detail = await getPackDetail({ shopItemId: PACK_ID, userId: BUYER });
    expect(detail.meta.purchases).toBe(20);
  });

  /**
   * This select is hand-written rather than the shared `cosmeticShopItemSelect`,
   * so the `_count` line has to be repeated here — and nothing else can see it
   * go missing. Prisma mocks ignore `select` and every fixture hand-writes
   * `_count`, so deleting the line leaves the whole suite green and throws on
   * every pack page in production.
   *
   * TO WHOEVER IS ABOUT TO DELETE THIS: it asserts the query the code built, not
   * a mock's shape, and it is the only thing holding that line in place.
   */
  it('asks the database for the count rather than relying on the fixture', async () => {
    soldOutWithStaleCounter();
    await getPackDetail({ shopItemId: PACK_ID, userId: BUYER });
    expect(shopItemFindUnique.mock.calls[0][0].select._count).toEqual({
      select: { purchases: true },
    });
  });

  it('reports the row count when the counter overstates it', async () => {
    shopItemFindUnique.mockResolvedValue({
      id: PACK_ID,
      cosmeticId: null,
      title: 'A pack',
      description: null,
      unitAmount: PRICE,
      status: CosmeticShopItemStatus.Published,
      listed: true,
      availableQuantity: 20,
      meta: { purchases: 13, packMemberCount: memberRows.length },
      addedById: LISTER,
      members: memberRows.map(({ cosmeticId, floorAmount }) => ({ cosmeticId, floorAmount })),
      _count: { purchases: 4 },
    });
    const detail = await getPackDetail({ shopItemId: PACK_ID, userId: BUYER });
    expect(detail.meta.purchases).toBe(4);
  });
});

/**
 * Deleting a member Cosmetic cascades its join row away, so the pack's own rows
 * shrink with it and only `meta.packMemberCount` still says what was sold. Each
 * case drives the shop entry point, `purchaseCosmeticShopItem`, because the
 * caller is where the build-time count is read.
 */
describe('a pack that lost members since it was built', () => {
  const lostMembers = ({
    survivors,
    packMemberCount,
  }: {
    survivors: typeof memberRows;
    packMemberCount: number | undefined;
  }) => {
    shopItemFindUnique.mockResolvedValue({
      id: PACK_ID,
      cosmeticId: null,
      cosmetic: null,
      title: 'A pack',
      description: null,
      unitAmount: PRICE,
      status: CosmeticShopItemStatus.Published,
      listed: true,
      availableQuantity: null,
      availableFrom: null,
      availableTo: null,
      meta: packMemberCount === undefined ? { purchases: 0 } : { purchases: 0, packMemberCount },
      addedById: LISTER,
      members: survivors.map(({ cosmeticId, floorAmount }) => ({ cosmeticId, floorAmount })),
      _count: { purchases: 0, members: survivors.length },
    });
    packMemberFindMany.mockResolvedValue(
      survivors.map((row) => ({ ...row, cosmetic: cosmeticFor(row.cosmeticId) }))
    );
  };
  const buy = () =>
    purchaseCosmeticShopItem({
      userId: BUYER,
      shopItemId: PACK_ID,
      packsEnabled: true,
      stickersEnabled: true,
    });
  const foreignOnly = memberRows.filter((m) => m.cosmeticId === FOREIGN_MEMBER);

  // 868m87aqu. With the count gone the old caller fell back to the join rows,
  // which agree with the shrunken pack: the buyer was charged the full PRICE for
  // one member of two.
  it('refuses a short pack with no recorded count instead of charging full price', async () => {
    lostMembers({ survivors: foreignOnly, packMemberCount: undefined });
    await expect(buy()).rejects.toThrow(/^This pack contains an item that is no longer available$/);
    expect(spend).not.toHaveBeenCalled();
  });

  it('refuses a short pack against its recorded count', async () => {
    lostMembers({ survivors: foreignOnly, packMemberCount: memberRows.length });
    await expect(buy()).rejects.toThrow(/^This pack contains an item that is no longer available$/);
    expect(spend).not.toHaveBeenCalled();
  });

  // The positive control for the two above: the same entry point, fixture and
  // buyer do reach the charge when nothing is missing.
  it('charges a whole pack through the same entry point', async () => {
    lostMembers({ survivors: memberRows, packMemberCount: memberRows.length });
    await buy();
    expect(spend).toHaveBeenCalledTimes(1);
    expect(spend.mock.calls[0][0].amount).toBe(PRICE);
  });

  // 868m87ay0, and its partial form: the detail counted the missing members
  // from the join rows too, so it reported none missing and the button stayed
  // priced and enabled on a purchase the server refuses.
  it.each([
    { name: 'an emptied pack', survivors: [] as typeof memberRows, missing: memberRows.length },
    { name: 'a partly emptied pack', survivors: foreignOnly, missing: 1 },
  ])('blocks purchase of $name in the detail, as the purchase refuses it', async (c) => {
    lostMembers({ survivors: c.survivors, packMemberCount: memberRows.length });
    const detail = await getPackDetail({ shopItemId: PACK_ID, userId: BUYER });
    expect(detail.unavailableCount).toBe(c.missing);
    expect(getPackPurchaseBlockers(detail)).toMatchObject({ unavailable: true, blocked: true });
    await expect(buy()).rejects.toThrow(/^This pack contains an item that is no longer available$/);
    expect(spend).not.toHaveBeenCalled();
  });

  it('blocks purchase of a pack with no recorded count in the detail too', async () => {
    lostMembers({ survivors: memberRows, packMemberCount: undefined });
    const detail = await getPackDetail({ shopItemId: PACK_ID, userId: BUYER });
    expect(getPackPurchaseBlockers(detail).blocked).toBe(true);
    await expect(buy()).rejects.toThrow(/^This pack contains an item that is no longer available$/);
    expect(spend).not.toHaveBeenCalled();
  });

  // TO WHOEVER IS SIMPLIFYING packMembersMissing TO `count - deliverable`: a
  // recorded count BELOW what resolves is a stale meta write-back (the purchases
  // bump re-writes meta it read before a concurrent membership edit). It must
  // refuse like a short pack; a one-sided difference goes negative and sells it.
  it('refuses a pack that resolves more members than it recorded', async () => {
    lostMembers({ survivors: memberRows, packMemberCount: 1 });
    const detail = await getPackDetail({ shopItemId: PACK_ID, userId: BUYER });
    expect(detail.unavailableCount).toBe(1);
    expect(getPackPurchaseBlockers(detail).blocked).toBe(true);
    await expect(buy()).rejects.toThrow(/^This pack contains an item that is no longer available$/);
    expect(spend).not.toHaveBeenCalled();
  });

  it('leaves purchase of a whole pack unblocked', async () => {
    lostMembers({ survivors: memberRows, packMemberCount: memberRows.length });
    const detail = await getPackDetail({ shopItemId: PACK_ID, userId: BUYER });
    expect(detail.unavailableCount).toBe(0);
    expect(getPackPurchaseBlockers(detail).blocked).toBe(false);
  });
});
