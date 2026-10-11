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
    listMultiTx: vi.fn(),
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
  getMultiAccountTransactionsByPrefix: mocks.listMultiTx,
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
import { PURCHASE_STATE_UNKNOWN_MESSAGE } from '../shop-purchase-charge';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
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
    // Money under a seeded claim's prefix: an earlier attempt charged.
    mocks.listMultiTx.mockResolvedValue([{ transactionId: 'earlier', amount: PRICE }]);
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

  // A retry of a purchase that charged before the end: the event's window is a
  // sale window, checked when the claim was made. The team, paid-Buzz-only and
  // registration rules still apply, and a claim nothing was charged under
  // vouches for nothing.
  describe('a retry of a pending claim after the end', () => {
    const KEY = '55555555-5555-4555-8555-555555555555';
    const TX = `cosmetic-purchase-v2-${BUYER_ID}-${SHOP_ITEM_ID}-${KEY}`;
    const retry = (payWith?: 'default' | 'blue-first') =>
      purchaseCosmeticShopItem({
        userId: BUYER_ID,
        shopItemId: SHOP_ITEM_ID,
        idempotencyKey: KEY,
        payWith,
        buzzType: 'green',
      });
    const expectUnknown = async (p: Promise<unknown>) => {
      await expect(p).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: PURCHASE_STATE_UNKNOWN_MESSAGE,
      });
      const reasons = loggingMock.logToAxiom.mock.calls
        .map(([arg]) => arg as Record<string, unknown>)
        .filter((arg) => arg.name === 'shop-purchase-state-unknown')
        .map((arg) => arg.reason);
      expect(reasons).toEqual(['refused while a claim is pending']);
      expect(mocks.createMultiTx).not.toHaveBeenCalled();
      expect(claims.rows.get(TX)).toMatchObject({ status: 'pending', attempts: 1 });
    };

    beforeEach(() => {
      loggingMock.logToAxiom.mockReset();
      claims.rows.set(TX, {
        transactionId: TX,
        userId: BUYER_ID,
        shopItemId: SHOP_ITEM_ID,
        amount: PRICE,
        attempts: 1,
        status: 'pending',
      });
      vi.setSystemTime(AFTER_EVENT);
    });

    it('resumes a claim that was charged', async () => {
      await retry();
      expect(mocks.createMultiTx.mock.calls[0][0].externalTransactionIdPrefix).toBe(TX);
      expect(claims.rows.get(TX)?.status).toBe('paid');
    });

    it('a claim nothing was charged under is unknown, and not charged', async () => {
      mocks.listMultiTx.mockResolvedValue([]);
      await expectUnknown(retry());
    });

    it("another team's colour is still unknown, and not charged", async () => {
      mocks.getUserTeam.mockResolvedValue(BLUE_TEAM);
      await expectUnknown(retry());
    });

    it('Blue Buzz is still unknown, and not charged', async () => {
      await expectUnknown(retry('blue-first'));
    });

    it('an event that is no longer registered is still unknown, and not charged', async () => {
      mocks.shopItemFindUnique.mockResolvedValue(hatRow({ event: UNREGISTERED_EVENT }));
      await expectUnknown(retry());
    });

    // Teamless, so nothing after the event lookup would refuse it either.
    it('a teamless item of an event no longer registered is still unknown, and not charged', async () => {
      const row = hatRow({ event: UNREGISTERED_EVENT });
      mocks.shopItemFindUnique.mockResolvedValue({
        ...row,
        cosmetic: { ...row.cosmetic, data: hatData(undefined, UNREGISTERED_EVENT) },
      });
      await expectUnknown(retry());
    });

    // The flag is the kill switch: a retry does not outlive it.
    it('with the flag off for the buyer, still unknown, and not charged', async () => {
      testerFlag.reset({ testers: [] });
      await expectUnknown(retry());
    });
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

  // Justin, 2026-10-09: hats are bought only on the event page. The shop (and the homepage blocks
  // that read it) lists no event item to anyone, moderators included, while the event runs or
  // after. The items stay in a published section: the event page's shelf reads them from there.
  it.each([
    ['a signed-in viewer', { userId: BUYER_ID }],
    ['an anonymous viewer', {}],
    ['a moderator', { userId: BUYER_ID, isModerator: true }],
  ])(
    'the full shop lists %s no event items, and drops the sections they emptied',
    async (_, args) => {
      expect(await listedIds(args)).toEqual([{ section: 10, items: [ORDINARY] }]);
      expect(mocks.getUserTeam).not.toHaveBeenCalled();
    }
  );

  // The event page's shelf: only that event's items, still per viewer, empty sections dropped.
  it("asked for one event, lists a signed-in viewer only their own team's colour", async () => {
    expect(await listedIds({ userId: BUYER_ID, event: BIRTHDAY_2026_EVENT })).toEqual([
      { section: 10, items: [PINK, TEAMLESS] },
    ]);
    // One team lookup per event per request, not one per item.
    expect(mocks.getUserTeam).toHaveBeenCalledTimes(1);
    expect(await listedIds({ event: UNREGISTERED_EVENT })).toEqual([]);
  });

  it('asked for one event, lists an anonymous viewer every colour', async () => {
    expect(await listedIds({ event: BIRTHDAY_2026_EVENT })).toEqual([
      { section: 10, items: [PINK, BLUE, TEAMLESS] },
      { section: 20, items: [BLUE + 10] },
    ]);
    expect(mocks.getUserTeam).not.toHaveBeenCalled();
  });

  it('asked for one event, lists nothing once the event has ended', async () => {
    vi.setSystemTime(AFTER_EVENT);
    expect(await listedIds({ event: BIRTHDAY_2026_EVENT })).toEqual([]);
  });

  // A community-hub section is kept in the shop even when empty (its feed is queried separately),
  // so asking for one event's items must drop it by name, not by emptiness.
  // The full shop shows a moderator every colour; the event page's shelf is their own team's.
  it('asked for one event, a moderator sees their own colour only', async () => {
    expect(
      await listedIds({ userId: BUYER_ID, isModerator: true, event: BIRTHDAY_2026_EVENT })
    ).toEqual([{ section: 10, items: [PINK, TEAMLESS] }]);
  });

  it('asked for one event, leaves out the community hub; the full shop keeps it', async () => {
    mocks.sectionFindMany.mockResolvedValue([
      section(10, [listedItem(PINK, hatData(PINK_TEAM))]),
      { ...section(30, []), meta: { communityHub: true } },
    ]);
    expect(await listedIds({ userId: BUYER_ID, event: BIRTHDAY_2026_EVENT })).toEqual([
      { section: 10, items: [PINK] },
    ]);
    expect(await listedIds({ userId: BUYER_ID })).toEqual([{ section: 30, items: [] }]);
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

  // A moderator plays the preview without being a tester (as the page and purchase already allow),
  // so their event shelf must not come back empty.
  it('asked for one event, lists a moderator their own colour during the preview', async () => {
    testerFlag.reset({ testers: [] });
    mocks.sectionFindMany.mockResolvedValue([
      section(10, [listedItem(PINK, hatData(PINK_TEAM)), listedItem(BLUE, hatData(BLUE_TEAM))]),
    ]);
    expect(
      await listedIds({ userId: BUYER_ID, isModerator: true, event: BIRTHDAY_2026_EVENT })
    ).toEqual([{ section: 10, items: [PINK] }]);
    // The same viewer without the moderator flag sees nothing: the preview is closed to them.
    expect(await listedIds({ userId: BUYER_ID, event: BIRTHDAY_2026_EVENT })).toEqual([]);
  });

  it('asked for one event, lists the hats to a tester and to nobody else, signed out included', async () => {
    testerFlag.reset({ testers: [BUYER_ID] });
    const shelf = (userId?: number) => listedIds({ userId, event: BIRTHDAY_2026_EVENT });
    expect(await shelf(BUYER_ID)).toEqual([{ section: 10, items: [PINK] }]);
    expect(await shelf(BUYER_ID + 1)).toEqual([]);
    expect(await shelf()).toEqual([]);
  });
});
