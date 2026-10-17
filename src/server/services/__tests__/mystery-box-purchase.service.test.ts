import type * as PromClient from '~/server/prom/client';
import type * as RedisCaches from '~/server/redis/caches';
import type * as CosmeticPackService from '~/server/services/cosmetic-pack.service';
import type * as EventShopItem from '~/server/events/event-shop-item';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Buying a mystery box: the shop's claim-first purchase, granting one held box `Item`. The
// refusals all come before the claim, and the "is anything left for you" check and the claim
// happen under the buyer's item-holder lock, so two purchases cannot both take the last thing.

const { mocks } = vi.hoisted(() => ({
  mocks: {
    createMultiTx: vi.fn(),
    refundMultiTx: vi.fn(),
    listMultiTx: vi.fn(),
    purchaseCosmeticPack: vi.fn(),
    assertEventPurchasable: vi.fn(),
    getEventBuyerTeam: vi.fn(),
  },
}));

vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
  dbReadFallbackCounter: { inc: vi.fn() },
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  refreshOwnedStickerCache: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createMultiAccountBuzzTransaction: mocks.createMultiTx,
  refundMultiAccountTransaction: mocks.refundMultiTx,
  getMultiAccountTransactionsByPrefix: mocks.listMultiTx,
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  createEntityImages: vi.fn(),
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
}));
vi.mock('~/server/services/cosmetic-pack.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticPackService>()),
  getPackMembers: vi.fn(async () => []),
  purchaseCosmeticPack: mocks.purchaseCosmeticPack,
}));
vi.mock('~/server/events/event-shop-item', async (importOriginal) => ({
  ...(await importOriginal<typeof EventShopItem>()),
  assertEventShopItemPurchasable: mocks.assertEventPurchasable,
  getEventBuyerTeam: mocks.getEventBuyerTeam,
}));

import { purchaseCosmeticShopItem } from '../cosmetic-shop.service';
import {
  getBoxPoolForUser,
  getMysteryBoxBlockedRegions,
  isMysteryBoxBlockedIn,
  MYSTERY_BOX_BLOCKED_REGIONS_KEY,
} from '../mystery-box.service';
import { ITEM_HOLDER_LOCK_CLASS } from '../item-holder-lock';
import { PURCHASE_STATE_UNKNOWN_MESSAGE } from '../shop-purchase-charge';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  installShopPurchaseClaimFake,
  type shopPurchaseClaimFake,
} from '~/test-utils/shopPurchaseClaimFake';

const BUYER_ID = 1;
const SHOP_ITEM_ID = 42;
const BOX_ID = 9;
const PRICE = 500;
const VERSION = 3;
const KEY_A = '11111111-1111-4111-8111-111111111111';
const KEY_B = '22222222-2222-4222-8222-222222222222';
const txId = (key: string) => `item-purchase-v1-${BUYER_ID}-${SHOP_ITEM_ID}-${key}`;

const listing = {
  id: SHOP_ITEM_ID,
  status: 'Published',
  // Box listings are unlisted by design.
  listed: false,
  cosmeticId: null,
  itemDefinitionId: BOX_ID,
  availableQuantity: null,
  availableFrom: null,
  availableTo: null,
  unitAmount: PRICE,
  title: 'Birthday box',
  meta: {},
  addedById: 999,
  cosmetic: null,
  _count: { purchases: 0 },
};
const boxRow = { id: BOX_ID, type: 'box', status: 'published', version: VERSION, params: {} };

type Content = {
  id: number;
  boxDefinitionId: number;
  tierId: number;
  rewardDefinitionId: number;
  enabled: boolean;
  reward: { type: string; cosmeticId: number | null; cosmetic: { data: unknown } | null };
};
const hat = (id: number, data: unknown = {}, overrides: Partial<Content> = {}): Content => ({
  id,
  boxDefinitionId: BOX_ID,
  tierId: 1,
  rewardDefinitionId: 100 + id,
  enabled: true,
  reward: { type: 'cosmetic', cosmeticId: 1000 + id, cosmetic: { data } },
  ...overrides,
});

type ItemRow = {
  id: bigint;
  itemDefinitionId: number;
  holderId: number;
  sourceKey: string;
  quantity: number;
};

let world: {
  contents: Content[];
  owned: { userId: number; cosmeticId: number }[];
  items: ItemRow[];
  purchases: Record<string, unknown>[];
  log: string[];
};
let claims: ReturnType<typeof shopPurchaseClaimFake>;
let lockTail: Promise<void>;

// One holder lock, as Postgres would hold it: a second taker waits until the first transaction ends.
const acquireLock = () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const prev = lockTail;
  lockTail = prev.then(() => held);
  return prev.then(() => release);
};

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

const makeTx = (onLock: () => Promise<void>) => ({
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join('?').includes('pg_advisory_xact_lock')) {
      world.log.push(`lock:${values.join(',')}`);
      await onLock();
    }
    return 1;
  },
  boxContent: {
    findMany: async ({ where }: { where: { boxDefinitionId: number; enabled: boolean } }) => {
      world.log.push('read:contents');
      return world.contents.filter(
        (c) => c.boxDefinitionId === where.boxDefinitionId && c.enabled === where.enabled
      );
    },
    count: async ({ where }: { where: { boxDefinitionId: number; enabled: boolean } }) =>
      world.contents.filter(
        (c) =>
          c.boxDefinitionId === where.boxDefinitionId &&
          c.enabled === where.enabled &&
          c.reward.type !== 'cosmetic'
      ).length,
  },
  userCosmetic: {
    findMany: async ({ where }: { where: { userId: number; cosmeticId: { in: number[] } } }) =>
      world.owned.filter(
        (o) => o.userId === where.userId && where.cosmeticId.in.includes(o.cosmeticId)
      ),
  },
  item: {
    aggregate: async ({ where }: { where: { holderId: number; itemDefinitionId: number } }) => {
      world.log.push('read:held');
      const rows = world.items.filter(
        (i) => i.holderId === where.holderId && i.itemDefinitionId === where.itemDefinitionId
      );
      return { _sum: { quantity: rows.length ? rows.reduce((s, i) => s + i.quantity, 0) : null } };
    },
    create: async ({ data }: { data: Omit<ItemRow, 'id' | 'quantity'> }) => {
      if (world.items.some((i) => i.sourceKey === data.sourceKey)) throw p2002();
      const row = { ...data, id: BigInt(world.items.length + 1), quantity: 1 };
      world.items.push(row);
      world.log.push('grant:item');
      return row;
    },
  },
  cosmeticShopItem: {
    findMany: async () => [{ id: SHOP_ITEM_ID }],
  },
  cosmeticShopPurchaseClaim: {
    ...claims.txDelegate,
    updateMany: async (args: Parameters<typeof claims.txDelegate.updateMany>[0]) => {
      world.log.push(`claim:${args.data.status ?? 'update'}`);
      return claims.txDelegate.updateMany(args);
    },
    count: async ({
      where,
    }: {
      where: {
        userId: number;
        status: string;
        shopItemId: { in: number[] };
        transactionId: { not: string };
      };
    }) => {
      world.log.push('read:pending');
      return [...claims.rows.values()].filter(
        (c) =>
          c.userId === where.userId &&
          c.status === where.status &&
          where.shopItemId.in.includes(c.shopItemId) &&
          c.transactionId !== where.transactionId.not
      ).length;
    },
  },
  userCosmeticShopPurchases: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      world.purchases.push(data);
      return data;
    },
  },
});

const legs = () => ({
  transactionIds: [{ transactionId: 'tx-0', accountType: 'yellow', amount: PRICE }],
  totalAmount: PRICE,
  transactionCount: 1,
});

const buy = ({
  idempotencyKey = KEY_A,
  expectedVersion = VERSION,
  expectedUnitAmount = PRICE,
  payWith,
  mysteryBoxEnabled = true,
  countryCode = 'US',
}: {
  idempotencyKey?: string;
  expectedVersion?: number;
  expectedUnitAmount?: number;
  payWith?: 'default' | 'blue-first';
  mysteryBoxEnabled?: boolean;
  countryCode?: string | null;
} = {}) =>
  purchaseCosmeticShopItem({
    userId: BUYER_ID,
    shopItemId: SHOP_ITEM_ID,
    idempotencyKey,
    expectedUnitAmount,
    expectedVersion,
    payWith,
    buzzType: 'yellow',
    packsEnabled: true,
    mysteryBoxEnabled,
    countryCode,
  });

const nothingClaimedOrCharged = () => {
  expect(claims.rows.size).toBe(0);
  expect(mocks.createMultiTx).not.toHaveBeenCalled();
  expect(world.items).toHaveLength(0);
};

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  world = { contents: [hat(1), hat(2)], owned: [], items: [], purchases: [], log: [] };
  lockTail = Promise.resolve();
  claims = installShopPurchaseClaimFake();

  dbMock.dbRead.cosmeticShopItem.findUnique.mockReset();
  dbMock.dbRead.cosmeticShopItem.findUnique.mockResolvedValue(listing);
  dbMock.dbWrite.itemDefinition.findUnique.mockReset();
  dbMock.dbWrite.itemDefinition.findUnique.mockResolvedValue(boxRow);
  dbMock.dbRead.keyValue.findUnique.mockReset();
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.item.findFirst.mockReset();
  dbMock.dbWrite.item.findFirst.mockImplementation(
    async ({ where }: { where: { sourceKey: string; holderId: number } }) =>
      world.items.find((i) => i.sourceKey === where.sourceKey && i.holderId === where.holderId) ??
      null
  );
  dbMock.dbWrite.$transaction.mockReset();
  // No claim rollback here: the fake's journal is one per fake, and the concurrent tests run two
  // transactions at once. The grant-failure test installs its own transaction with rollback.
  dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    let release: (() => void) | undefined;
    const tx = makeTx(async () => {
      release = await acquireLock();
    });
    try {
      return await fn(tx);
    } finally {
      release?.();
    }
  });

  mocks.createMultiTx.mockResolvedValue(legs());
  mocks.refundMultiTx.mockResolvedValue({ totalRefunded: PRICE });
  mocks.listMultiTx.mockResolvedValue([]);
  mocks.assertEventPurchasable.mockResolvedValue(undefined);
  mocks.getEventBuyerTeam.mockResolvedValue(undefined);
});

describe('buying a mystery box', () => {
  it('grants one held box keyed on the claim, with a purchase row naming no cosmetic', async () => {
    const result = await buy();

    expect(result).toEqual({ kind: 'box', boxItemId: '1', boxDefinitionId: BOX_ID });
    expect(world.items).toEqual([
      expect.objectContaining({
        itemDefinitionId: BOX_ID,
        holderId: BUYER_ID,
        sourceKey: txId(KEY_A),
      }),
    ]);
    expect(world.purchases).toEqual([
      expect.objectContaining({
        cosmeticId: null,
        shopItemId: SHOP_ITEM_ID,
        buzzTransactionId: txId(KEY_A),
        unitAmount: PRICE,
      }),
    ]);
    expect(mocks.createMultiTx).toHaveBeenCalledTimes(1);
    expect(mocks.createMultiTx.mock.calls[0][0]).toMatchObject({
      fromAccountTypes: ['yellow'],
      amount: PRICE,
      externalTransactionIdPrefix: txId(KEY_A),
    });
    expect(claims.rows.get(txId(KEY_A))?.status).toBe('paid');
  });

  it('branches on itemDefinitionId before the pack branch', async () => {
    await buy();
    expect(mocks.purchaseCosmeticPack).not.toHaveBeenCalled();
    expect(world.items).toHaveLength(1);
  });

  it('still sends a listing with no cosmetic and no item definition to the pack branch (control)', async () => {
    dbMock.dbRead.cosmeticShopItem.findUnique.mockResolvedValue({
      ...listing,
      itemDefinitionId: null,
      listed: true,
    });
    mocks.purchaseCosmeticPack.mockResolvedValue({ pack: true });

    await buy();

    expect(mocks.purchaseCosmeticPack).toHaveBeenCalledTimes(1);
    expect(world.items).toHaveLength(0);
  });

  it('takes the holder lock before reading what is left, and before marking the claim paid', async () => {
    await buy();

    const lock = `lock:${ITEM_HOLDER_LOCK_CLASS},${BUYER_ID}`;
    expect(world.log).toEqual([
      lock,
      'read:contents',
      'read:held',
      'read:pending',
      lock,
      'claim:paid',
      'grant:item',
    ]);
  });

  it('answers a replay of a completed purchase with the same box, charging once', async () => {
    const first = await buy();
    const second = await buy();

    expect(second).toEqual(first);
    expect(mocks.createMultiTx).toHaveBeenCalledTimes(1);
    expect(world.items).toHaveLength(1);
  });

  describe('refuses before any claim or charge', () => {
    const refused = async (p: Promise<unknown>, message: string | RegExp) => {
      await expect(p).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(p).rejects.toThrow(message);
      nothingClaimedOrCharged();
    };

    it('while the flag is off', () => refused(buy({ mysteryBoxEnabled: false }), 'not available'));

    it('a listing that is not published', async () => {
      dbMock.dbRead.cosmeticShopItem.findUnique.mockResolvedValue({ ...listing, status: 'Draft' });
      await refused(buy(), 'not available');
    });

    it('a box definition that is not published', async () => {
      dbMock.dbWrite.itemDefinition.findUnique.mockResolvedValue({ ...boxRow, status: 'draft' });
      await refused(buy(), 'not available');
    });

    it('an item definition that is not a box', async () => {
      dbMock.dbWrite.itemDefinition.findUnique.mockResolvedValue({ ...boxRow, type: 'cosmetic' });
      await refused(buy(), 'not available');
    });

    it('a buyer in a blocked country', async () => {
      dbMock.dbRead.keyValue.findUnique.mockResolvedValue({ value: ['be', 'NL'] });
      await refused(buy({ countryCode: 'BE' }), 'not available in your region');
    });

    it('Blue Buzz', () => refused(buy({ payWith: 'blue-first' }), 'Blue Buzz'));

    it('a box version the buyer was not shown', () =>
      refused(buy({ expectedVersion: VERSION - 1 }), 'contents changed'));

    it('no box version at all', async () => {
      await refused(
        purchaseCosmeticShopItem({
          userId: BUYER_ID,
          shopItemId: SHOP_ITEM_ID,
          idempotencyKey: KEY_A,
          expectedUnitAmount: PRICE,
          buzzType: 'yellow',
          mysteryBoxEnabled: true,
          countryCode: 'US',
        }),
        'contents changed'
      );
    });

    it('a changed price', () => refused(buy({ expectedUnitAmount: PRICE - 1 }), 'price changed'));

    it('a box holding anything but cosmetics', async () => {
      world.contents.push(
        hat(3, {}, { reward: { type: 'box', cosmeticId: null, cosmetic: null } })
      );
      await refused(buy(), 'not available');
    });

    it('a box the buyer owns everything in', async () => {
      world.owned = [
        { userId: BUYER_ID, cosmeticId: 1001 },
        { userId: BUYER_ID, cosmeticId: 1002 },
      ];
      await refused(buy(), "You've collected everything in this box");
    });

    it('a box whose remaining contents the buyer already holds unopened boxes for', async () => {
      world.owned = [{ userId: BUYER_ID, cosmeticId: 1001 }];
      world.items.push({
        id: 1n,
        itemDefinitionId: BOX_ID,
        holderId: BUYER_ID,
        sourceKey: 'earlier',
        quantity: 1,
      });
      await expect(buy()).rejects.toThrow('unopened boxes already cover');
      expect(claims.rows.size).toBe(0);
      expect(mocks.createMultiTx).not.toHaveBeenCalled();
    });
  });

  it('sells while something is left beyond the boxes held (control for the held count)', async () => {
    world.items.push({
      id: 1n,
      itemDefinitionId: BOX_ID,
      holderId: BUYER_ID,
      sourceKey: 'earlier',
      quantity: 1,
    });
    await buy();
    expect(world.items).toHaveLength(2);
  });

  it('counts another pending purchase of this box against what is left', async () => {
    world.contents = [hat(1)];
    claims.rows.set(txId(KEY_B), {
      transactionId: txId(KEY_B),
      userId: BUYER_ID,
      shopItemId: SHOP_ITEM_ID,
      amount: PRICE,
      attempts: 1,
      status: 'pending',
    });
    await expect(buy()).rejects.toThrow('unopened boxes already cover');
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  it('sells only one of two concurrent purchases when one thing is left', async () => {
    world.contents = [hat(1)];
    const results = await Promise.allSettled([
      buy({ idempotencyKey: KEY_A }),
      buy({ idempotencyKey: KEY_B }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(mocks.createMultiTx).toHaveBeenCalledTimes(1);
    expect(world.items).toHaveLength(1);
  });

  it('sells both of two concurrent purchases when two things are left (control)', async () => {
    const results = await Promise.allSettled([
      buy({ idempotencyKey: KEY_A }),
      buy({ idempotencyKey: KEY_B }),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(world.items).toHaveLength(2);
  });

  it('draws the availability from the buyer’s team in an event box', async () => {
    dbMock.dbWrite.itemDefinition.findUnique.mockResolvedValue({
      ...boxRow,
      params: { event: 'birthday2026' },
    });
    mocks.getEventBuyerTeam.mockResolvedValue('red');
    world.contents = [hat(1, { team: 'blue' }), hat(2, { team: 'red' })];
    world.owned = [{ userId: BUYER_ID, cosmeticId: 1002 }];

    await expect(buy()).rejects.toThrow("You've collected everything in this box");
    expect(mocks.assertEventPurchasable).toHaveBeenCalledWith(
      expect.objectContaining({ userId: BUYER_ID, data: { event: 'birthday2026' } })
    );
    expect(mocks.getEventBuyerTeam).toHaveBeenCalledWith('birthday2026', BUYER_ID);
    nothingClaimedOrCharged();
  });

  it('refunds and refuses when the grant fails', async () => {
    const tx = makeTx(async () => undefined);
    dbMock.dbWrite.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) =>
      claims.rollbackOnThrow(() =>
        fn({
          ...tx,
          userCosmeticShopPurchases: {
            create: async () => {
              throw new Error('db down');
            },
          },
        })
      )
    );

    await expect(buy()).rejects.toThrow('Failed to purchase box');
    expect(mocks.refundMultiTx).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: txId(KEY_A) }),
      expect.anything()
    );
    expect(claims.rows.get(txId(KEY_A))?.status).toBe('refunded');
    expect(world.items).toHaveLength(0);
  });

  it('answers a refusal while resuming a pending claim as state unknown, not a 4xx', async () => {
    claims.rows.set(txId(KEY_A), {
      transactionId: txId(KEY_A),
      userId: BUYER_ID,
      shopItemId: SHOP_ITEM_ID,
      amount: PRICE,
      attempts: 1,
      status: 'pending',
    });
    mocks.listMultiTx.mockResolvedValue([{ amount: PRICE }]);

    await expect(buy({ mysteryBoxEnabled: false })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PURCHASE_STATE_UNKNOWN_MESSAGE,
    });
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });
});

describe('getBoxPoolForUser', () => {
  const pool = (team?: string) =>
    getBoxPoolForUser(makeTx(async () => undefined) as never, {
      boxDefinitionId: BOX_ID,
      userId: BUYER_ID,
      team,
    });

  it('leaves out disabled contents, owned cosmetics and other teams’ cosmetics', async () => {
    world.contents = [
      hat(1, { team: 'red' }),
      hat(2, { team: 'blue' }),
      hat(3),
      hat(4, {}, { enabled: false }),
      hat(5, { team: 'red' }),
    ];
    world.owned = [{ userId: BUYER_ID, cosmeticId: 1005 }];

    expect((await pool('red')).map((e) => e.contentId)).toEqual([1, 3]);
  });

  it('gives a buyer with no team no team cosmetic', async () => {
    world.contents = [hat(1, { team: 'red' }), hat(2)];
    expect((await pool()).map((e) => e.contentId)).toEqual([2]);
  });
});

describe('the mystery box region block', () => {
  it('blocks nobody when the list is empty or absent', async () => {
    expect(isMysteryBoxBlockedIn('BE', await getMysteryBoxBlockedRegions())).toBe(false);
    expect(isMysteryBoxBlockedIn(null, [])).toBe(false);
  });

  it('reads the KeyValue row and matches country codes case-insensitively', async () => {
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue({ value: ['be', ' NL '] });
    const blocked = await getMysteryBoxBlockedRegions();
    expect(dbMock.dbRead.keyValue.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: MYSTERY_BOX_BLOCKED_REGIONS_KEY } })
    );
    expect(isMysteryBoxBlockedIn('BE', blocked)).toBe(true);
    expect(isMysteryBoxBlockedIn('nl', blocked)).toBe(true);
    expect(isMysteryBoxBlockedIn('US', blocked)).toBe(false);
  });

  it('blocks an unknown country whenever any country is blocked', () => {
    expect(isMysteryBoxBlockedIn(null, ['BE'])).toBe(true);
  });

  it('refuses everywhere on a malformed list rather than nowhere', async () => {
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue({ value: 'BE' });
    await expect(getMysteryBoxBlockedRegions()).rejects.toThrow('not available right now');
  });
});
