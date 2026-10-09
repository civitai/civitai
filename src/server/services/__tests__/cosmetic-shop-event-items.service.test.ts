import type * as PromClient from '~/server/prom/client';
import type * as RedisCaches from '~/server/redis/caches';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => {
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
  return { mocks };
});

// A stand-in for the registered birthday event, built from the same constants
// the real definition uses; only the team lookup is faked.
vi.mock('~/server/events', async () => {
  const c = await import('~/shared/constants/birthday2026.constants');
  return {
    events: [
      {
        name: c.BIRTHDAY_2026_EVENT,
        startDate: c.BIRTHDAY_2026_STARTS_AT,
        endDate: c.BIRTHDAY_2026_ENDS_AT,
        featureFlag: 'birthday2026',
        previewFrom: c.BIRTHDAY_2026_PREVIEW_FROM,
        teams: [...c.BIRTHDAY_2026_TEAMS],
        getUserTeam: (userId: number, opts?: { strict?: boolean }) =>
          mocks.getUserTeam(userId, opts) as Promise<string>,
      },
    ],
  };
});
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
vi.mock('~/server/flipt/tester-segment', async () => {
  return (await import('~/test-utils/testerFlagFake')).testerFlagModule;
});

import { getShopSectionsWithItems, purchaseCosmeticShopItem } from '../cosmetic-shop.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  installShopPurchaseClaimFake,
  shopPurchaseClaimFake,
} from '~/test-utils/shopPurchaseClaimFake';
import { soldCountsFake } from '~/test-utils/soldCountsFake';
import {
  BIRTHDAY_2026_ENDS_AT,
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_PREVIEW_FROM,
  BIRTHDAY_2026_STARTS_AT,
  BIRTHDAY_2026_TEAMS,
} from '~/shared/constants/birthday2026.constants';
import { testerFlag } from '~/test-utils/testerFlagFake';

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
let claims = shopPurchaseClaimFake();
dbMock.dbWrite.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
  claims.rollbackOnThrow(() =>
    fn({
      userCosmeticShopPurchases: { create: mocks.purchasesCreate },
      userCosmetic: { create: mocks.userCosmeticCreate },
      cosmeticShopPurchaseClaim: claims.txDelegate,
    })
  )
);
beforeEach(() => {
  claims = installShopPurchaseClaimFake();
});

const BUYER_ID = 1;
const SHOP_ITEM_ID = 42;
const PRICE = 1500;
const DURING_EVENT = new Date(BIRTHDAY_2026_STARTS_AT.getTime() + 24 * 60 * 60 * 1000);
// The end is exclusive: the first instant of ENDS_AT is already after the event.
const AFTER_EVENT = BIRTHDAY_2026_ENDS_AT;
const [, BLUE_TEAM, PINK_TEAM] = BIRTHDAY_2026_TEAMS;
const UNREGISTERED_EVENT = 'not-a-registered-event';
const MS = 1;

const hatData = (team: unknown, event: string = BIRTHDAY_2026_EVENT) => ({
  type: 'hat',
  event,
  ...(team === undefined ? {} : { team }),
  design: 'cone',
  url: 'hat.png',
});

const hatRow = ({
  team = PINK_TEAM as unknown,
  event = BIRTHDAY_2026_EVENT as string,
  meta = {} as object,
} = {}) => ({
  id: SHOP_ITEM_ID,
  status: 'Published',
  listed: true,
  cosmeticId: 7,
  availableQuantity: null,
  availableFrom: null,
  availableTo: null,
  unitAmount: PRICE,
  title: 'Cone Party Hat',
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

afterEach(() => {
  vi.useRealTimers();
});

describe('buying an event-gated item (team hat)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DURING_EVENT);
    testerFlag.reset({ public: true });
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.shopItemFindUnique.mockResolvedValue(hatRow());
    mocks.getUserTeam.mockResolvedValue(PINK_TEAM);
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
    mocks.getUserTeam.mockResolvedValue(BLUE_TEAM);

    await expect(purchase()).rejects.toThrow("You can only buy this in your own team's colour");
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  // The default lookup falls back to the computed team when sysRedis is
  // degraded, which is wrong for anyone assigned a team by hand. Purchase must
  // ask for the strict lookup and refuse when it fails.
  it('asks for the strict team lookup', async () => {
    await purchase();
    expect(mocks.getUserTeam).toHaveBeenCalledWith(BUYER_ID, { strict: true });
  });

  it('refuses, before any charge, when the team lookup fails', async () => {
    mocks.getUserTeam.mockRejectedValue(new Error('sysRedis down'));

    await expect(purchase()).rejects.toThrow("We couldn't confirm your team. Please try again.");
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  it('sells an event item without a team to any team', async () => {
    // Built by hand: `hatRow({ team: undefined })` would take the default team.
    const row = hatRow();
    mocks.shopItemFindUnique.mockResolvedValue({
      ...row,
      cosmetic: { ...row.cosmetic, data: hatData(undefined) },
    });
    mocks.getUserTeam.mockResolvedValue(BLUE_TEAM);

    await purchase();
    expect(mocks.createMultiTx).toHaveBeenCalledTimes(1);
  });

  it('refuses a team that is not a string', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(hatRow({ team: 5 }));

    await expect(purchase()).rejects.toThrow('This item is not available');
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
    expect(first).toMatch(/^cosmetic-purchase-v2-1-42-/);
    expect(second).toMatch(/^cosmetic-purchase-v2-1-42-/);
    expect(second).not.toBe(first);
  });

  it('refuses from the first instant of the end (end is exclusive)', async () => {
    vi.setSystemTime(AFTER_EVENT);

    await expect(purchase()).rejects.toThrow('This item is not available');
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  it('sells in the last instant before the end', async () => {
    vi.setSystemTime(new Date(BIRTHDAY_2026_ENDS_AT.getTime() - MS));

    await purchase();
    expect(mocks.createMultiTx).toHaveBeenCalledTimes(1);
  });

  it('refuses before the event starts', async () => {
    vi.setSystemTime(new Date(BIRTHDAY_2026_STARTS_AT.getTime() - MS));

    await expect(purchase()).rejects.toThrow('This item is not available');
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  it('sells from the first instant of the start (start is inclusive)', async () => {
    vi.setSystemTime(BIRTHDAY_2026_STARTS_AT);

    await purchase();
    expect(mocks.createMultiTx).toHaveBeenCalledTimes(1);
  });

  it('refuses an item naming an event that is not registered', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(hatRow({ event: UNREGISTERED_EVENT }));

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
const TEAMLESS = 5;

const listedIds = async (args: Parameters<typeof getShopSectionsWithItems>[0]) =>
  (await getShopSectionsWithItems(args)).map((s) => ({
    section: s.id,
    items: s.items.map((i) => i.shopItem.id),
  }));

describe('the shop lists event-gated items per viewer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DURING_EVENT);
    testerFlag.reset({ public: true });
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.getBlockedPairIds.mockResolvedValue([]);
    mocks.getUserTeam.mockResolvedValue(PINK_TEAM);
    dbMock.dbRead.$queryRaw.mockImplementation(soldCountsFake({}));
    mocks.sectionFindMany.mockResolvedValue([
      section(10, [
        listedItem(PINK, hatData(PINK_TEAM)),
        listedItem(BLUE, hatData(BLUE_TEAM)),
        listedItem(UNKNOWN_EVENT, hatData(PINK_TEAM, UNREGISTERED_EVENT)),
        listedItem(ORDINARY, { url: 'frame.png' }),
        listedItem(TEAMLESS, hatData(undefined)),
      ]),
      section(20, [listedItem(BLUE + 10, hatData(BLUE_TEAM))]),
    ]);
  });

  it("a signed-in viewer sees only their own team's colour, and a section left empty disappears", async () => {
    expect(await listedIds({ userId: BUYER_ID })).toEqual([
      { section: 10, items: [PINK, ORDINARY, TEAMLESS] },
    ]);
    // One team lookup per event per request, not one per item.
    expect(mocks.getUserTeam).toHaveBeenCalledTimes(1);
  });

  it('an anonymous viewer sees every colour, but not items of an unregistered event', async () => {
    expect(await listedIds({})).toEqual([
      { section: 10, items: [PINK, BLUE, ORDINARY, TEAMLESS] },
      { section: 20, items: [BLUE + 10] },
    ]);
    expect(mocks.getUserTeam).not.toHaveBeenCalled();
  });

  it('hides event items once the event has ended, and the sections they emptied', async () => {
    vi.setSystemTime(AFTER_EVENT);

    expect(await listedIds({})).toEqual([{ section: 10, items: [ORDINARY] }]);
  });

  it('a moderator sees everything unfiltered', async () => {
    expect(await listedIds({ userId: BUYER_ID, isModerator: true })).toEqual([
      { section: 10, items: [PINK, BLUE, UNKNOWN_EVENT, ORDINARY, TEAMLESS] },
      { section: 20, items: [BLUE + 10] },
    ]);
  });
});

// Justin, 2026-10-09: before launch the event, the shop's hats included, is for testers and
// moderators only (the `birthday2026` flag). See event-access.test.ts for the rule.
describe('before launch, behind the flag', () => {
  const PREVIEW = new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() + 24 * 60 * 60 * 1000);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(PREVIEW);
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.shopItemFindUnique.mockResolvedValue(hatRow());
    mocks.getUserTeam.mockResolvedValue(PINK_TEAM);
    mocks.userCosmeticFindFirst.mockResolvedValue(null);
    mocks.userCosmeticCreate.mockImplementation(async ({ data }) => data);
    mocks.createMultiTx.mockImplementation(async ({ fromAccountTypes }) =>
      chargeResponse(fromAccountTypes[0])
    );
    mocks.getBlockedPairIds.mockResolvedValue([]);
    dbMock.dbRead.$queryRaw.mockImplementation(soldCountsFake({}));
    mocks.sectionFindMany.mockResolvedValue([section(10, [listedItem(PINK, hatData(PINK_TEAM))])]);
  });

  it('sells a hat to a tester during the preview', async () => {
    testerFlag.reset({ testers: [BUYER_ID] });
    await purchase();
    expect(mocks.userCosmeticCreate).toHaveBeenCalledTimes(1);
  });

  it('refuses everyone else before any charge, and the tester once it is armed', async () => {
    testerFlag.reset({ testers: [] });
    await expect(purchase()).rejects.toThrow('This item is not available');
    testerFlag.reset({ public: true, testers: [BUYER_ID] });
    await expect(purchase()).rejects.toThrow('This item is not available');
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  it('lists the hats to a tester and to nobody else, signed out included', async () => {
    testerFlag.reset({ testers: [BUYER_ID] });
    expect(await listedIds({ userId: BUYER_ID })).toEqual([{ section: 10, items: [PINK] }]);
    expect(await listedIds({ userId: BUYER_ID + 1 })).toEqual([]);
    expect(await listedIds({})).toEqual([]);
  });
});
