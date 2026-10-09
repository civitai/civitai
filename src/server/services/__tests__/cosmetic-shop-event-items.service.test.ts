import type * as PromClient from '~/server/prom/client';
import type * as RedisCaches from '~/server/redis/caches';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks, birthday } = vi.hoisted(() => {
  const mocks = {
    shopItemFindUnique: vi.fn(),
    shopItemUpdate: vi.fn(),
    userCosmeticFindFirst: vi.fn(),
    purchasesFindUnique: vi.fn(),
    purchasesCreate: vi.fn(),
    purchasesUpdate: vi.fn(),
    userCosmeticCreate: vi.fn(),
    createBuzzTransaction: vi.fn(),
    createMultiTx: vi.fn(),
    refundMultiTx: vi.fn(),
    getBlockedPairIds: vi.fn(),
    sectionFindMany: vi.fn(),
    getUserTeam: vi.fn(),
  };
  // A stand-in for the registered event the hats name. Dates are set per test.
  const birthday = {
    name: 'birthday2026',
    startDate: new Date('2026-11-11T00:00:00Z'),
    endDate: new Date('2026-11-25T00:00:00Z'),
    teams: ['Yellow', 'Blue', 'Pink', 'Green'],
    getUserTeam: (userId: number) => mocks.getUserTeam(userId) as Promise<string>,
  };
  return { mocks, birthday };
});

vi.mock('~/server/events', () => ({ events: [birthday] }));
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
  dbReadFallbackCounter: { inc: vi.fn() },
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  refreshOwnedStickerCache: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: mocks.createBuzzTransaction,
  createMultiAccountBuzzTransaction: mocks.createMultiTx,
  refundMultiAccountTransaction: mocks.refundMultiTx,
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  createEntityImages: vi.fn(),
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getBlockedPairIds: mocks.getBlockedPairIds,
}));

import { getShopSectionsWithItems, purchaseCosmeticShopItem } from '../cosmetic-shop.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { soldCountsFake } from '~/test-utils/soldCountsFake';

const fwd =
  (fn: (...a: unknown[]) => unknown) =>
  (...args: unknown[]) =>
    fn(...args);
dbMock.dbRead.cosmeticShopItem.findUnique.mockImplementation(fwd(mocks.shopItemFindUnique));
dbMock.dbRead.cosmeticShopSection.findMany.mockImplementation(fwd(mocks.sectionFindMany));
dbMock.dbWrite.cosmeticShopItem.update.mockImplementation(fwd(mocks.shopItemUpdate));
dbMock.dbWrite.userCosmetic.findFirst.mockImplementation(fwd(mocks.userCosmeticFindFirst));
dbMock.dbWrite.userCosmeticShopPurchases.findUnique.mockImplementation(
  fwd(mocks.purchasesFindUnique)
);
dbMock.dbWrite.userCosmeticShopPurchases.update.mockImplementation(fwd(mocks.purchasesUpdate));
dbMock.dbWrite.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
  fn({
    userCosmeticShopPurchases: { create: mocks.purchasesCreate },
    userCosmetic: { create: mocks.userCosmeticCreate },
  })
);

const BUYER_ID = 1;
const SHOP_ITEM_ID = 42;
const PRICE = 1500;
const DURING_EVENT = new Date('2026-11-15T12:00:00Z');
const AFTER_EVENT = new Date('2026-11-26T00:00:00Z');

const hatData = (team: string, event = 'birthday2026') => ({
  type: 'hat',
  event,
  team,
  design: 'cone',
  url: 'hat.png',
});

const hatRow = ({ team = 'Pink', event = 'birthday2026', meta = {} as object } = {}) => ({
  id: SHOP_ITEM_ID,
  status: 'Published',
  listed: true,
  cosmeticId: 7,
  availableQuantity: null,
  availableFrom: null,
  availableTo: null,
  unitAmount: PRICE,
  title: 'Cone Party Hat - Pink',
  meta,
  addedById: 999,
  cosmetic: { type: 'ContentDecoration', createdById: null, data: hatData(team, event) },
  _count: { purchases: 0 },
});

const chargeResponse = (accountType: string) => ({
  transactionIds: [{ transactionId: 'tx-0', accountType, amount: PRICE }],
  totalAmount: PRICE,
  transactionCount: 1,
});

const purchase = (
  over: { payWith?: 'default' | 'blue-first'; buzzType?: 'yellow' | 'green' } = {}
) =>
  purchaseCosmeticShopItem({
    userId: BUYER_ID,
    shopItemId: SHOP_ITEM_ID,
    payWith: over.payWith,
    buzzType: over.buzzType ?? 'green',
  });

describe('buying an event-gated item (team hat)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DURING_EVENT);
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.shopItemFindUnique.mockResolvedValue(hatRow());
    mocks.getUserTeam.mockResolvedValue('Pink');
    mocks.userCosmeticFindFirst.mockResolvedValue(null);
    mocks.userCosmeticCreate.mockImplementation(async ({ data }) => data);
    mocks.createMultiTx.mockImplementation(async ({ fromAccountTypes }) =>
      chargeResponse(fromAccountTypes[0])
    );
    mocks.getBlockedPairIds.mockResolvedValue([]);
  });

  it("buying your own team's colour charges only the domain currency and grants the hat", async () => {
    await purchase({ buzzType: 'green' });

    expect(mocks.createMultiTx).toHaveBeenCalledTimes(1);
    expect(mocks.createMultiTx.mock.calls[0][0]).toMatchObject({
      fromAccountId: BUYER_ID,
      fromAccountTypes: ['green'],
      amount: PRICE,
    });
    expect(mocks.userCosmeticCreate).toHaveBeenCalledTimes(1);
    expect(mocks.userCosmeticCreate.mock.calls[0][0].data).toMatchObject({
      userId: BUYER_ID,
      cosmeticId: 7,
    });
  });

  it("refuses another team's colour before any charge", async () => {
    mocks.getUserTeam.mockResolvedValue('Blue');

    await expect(purchase()).rejects.toThrow("You can only buy this in your own team's colour");
    expect(mocks.getUserTeam).toHaveBeenCalledWith(BUYER_ID);
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  // Justin's call: hats are paid Buzz only. The per-item acceptsBlueBuzz opt-in
  // must not reopen Blue for an event item, which is why it is set here.
  it('refuses Blue Buzz even when the listing accepts Blue', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(hatRow({ meta: { acceptsBlueBuzz: true } }));

    await expect(purchase({ payWith: 'blue-first' })).rejects.toThrow(
      "This item can't be bought with Blue Buzz"
    );
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  it('a repeat purchase of a hat already owned charges again and grants a second copy', async () => {
    await purchase();
    // From here the buyer owns one; ownership must not block the second.
    mocks.userCosmeticFindFirst.mockResolvedValue({ userId: BUYER_ID, cosmeticId: 7 });
    await purchase();

    expect(mocks.createMultiTx).toHaveBeenCalledTimes(2);
    expect(mocks.userCosmeticCreate).toHaveBeenCalledTimes(2);
    const [first, second] = mocks.userCosmeticCreate.mock.calls.map(([arg]) => arg.data.claimKey);
    expect(first).toMatch(/^cosmetic-purchase-1-42-/);
    expect(second).toMatch(/^cosmetic-purchase-1-42-/);
    expect(second).not.toBe(first);
  });

  it('refuses once the event has ended, whatever the listing window says', async () => {
    vi.setSystemTime(AFTER_EVENT);

    await expect(purchase()).rejects.toThrow('This item is not available');
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  it('refuses an item naming an event that is not registered', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(hatRow({ event: 'birthday2025' }));

    await expect(purchase()).rejects.toThrow('This item is not available');
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  it("refuses an item whose team is not one of the event's teams, even if the buyer's team matches it", async () => {
    mocks.shopItemFindUnique.mockResolvedValue(hatRow({ team: 'Purple' }));
    mocks.getUserTeam.mockResolvedValue('Purple');

    await expect(purchase()).rejects.toThrow('This item is not available');
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });
});

const listedItem = (id: number, data: unknown) => ({
  createdAt: new Date(),
  shopItem: {
    id,
    title: `item ${id}`,
    unitAmount: PRICE,
    addedById: 999,
    cosmetic: { id: id + 100, createdById: null, data },
    meta: {},
  },
});

const section = (id: number, items: ReturnType<typeof listedItem>[]) => ({
  id,
  title: `section ${id}`,
  description: null,
  placement: id,
  meta: {},
  image: null,
  _count: { items: items.length },
  items,
});

const PINK = 1;
const BLUE = 2;
const UNKNOWN_EVENT = 3;
const ORDINARY = 4;

const listedIds = async (args: Parameters<typeof getShopSectionsWithItems>[0]) =>
  (await getShopSectionsWithItems(args)).map((s) => ({
    section: s.id,
    items: s.items.map((i) => i.shopItem.id),
  }));

describe('the shop lists event-gated items per viewer', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.getBlockedPairIds.mockResolvedValue([]);
    mocks.getUserTeam.mockResolvedValue('Pink');
    dbMock.dbRead.$queryRaw.mockImplementation(soldCountsFake({}));
    mocks.sectionFindMany.mockResolvedValue([
      section(10, [
        listedItem(PINK, hatData('Pink')),
        listedItem(BLUE, hatData('Blue')),
        listedItem(UNKNOWN_EVENT, hatData('Pink', 'birthday2025')),
        listedItem(ORDINARY, { url: 'frame.png' }),
      ]),
      section(20, [listedItem(BLUE + 10, hatData('Blue'))]),
    ]);
  });

  it("a signed-in viewer sees only their own team's colour, and a section left empty disappears", async () => {
    expect(await listedIds({ userId: BUYER_ID })).toEqual([
      { section: 10, items: [PINK, ORDINARY] },
    ]);
    // One team lookup per event per request, not one per item.
    expect(mocks.getUserTeam).toHaveBeenCalledTimes(1);
  });

  it('an anonymous viewer sees every colour, but not items of an unregistered event', async () => {
    expect(await listedIds({})).toEqual([
      { section: 10, items: [PINK, BLUE, ORDINARY] },
      { section: 20, items: [BLUE + 10] },
    ]);
    expect(mocks.getUserTeam).not.toHaveBeenCalled();
  });

  it('a moderator sees everything unfiltered', async () => {
    expect(await listedIds({ userId: BUYER_ID, isModerator: true })).toEqual([
      { section: 10, items: [PINK, BLUE, UNKNOWN_EVENT, ORDINARY] },
      { section: 20, items: [BLUE + 10] },
    ]);
  });
});
