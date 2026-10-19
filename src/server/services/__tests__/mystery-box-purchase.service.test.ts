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
import { ITEM_HOLDER_BUSY_MESSAGE, ITEM_HOLDER_LOCK_CLASS } from '../item-holder-lock';
import { modelQueryError, rawQueryError } from '~/test-utils/prismaLockTimeout';
import { PURCHASE_STATE_UNKNOWN_MESSAGE } from '../shop-purchase-charge';
import { PURCHASE_ALREADY_COMPLETED_MESSAGE } from '~/shared/constants/cosmetic-shop.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  installShopPurchaseClaimFake,
  type shopPurchaseClaimFake,
} from '~/test-utils/shopPurchaseClaimFake';

const BUYER_ID = 1;
const SHOP_ITEM_ID = 42;
// Another listing selling the same box (a re-priced or event-page copy).
const SECOND_LISTING_ID = 43;
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
  /** BoxOpening rows: what each user has drawn from a box. */
  drawn: { userId: number; boxDefinitionId: number; rewardDefinitionId: number }[];
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

const lockTimeout = () => rawQueryError('55P03');

type ContentWhere = {
  boxDefinitionId: number;
  enabled: boolean;
  reward?: { type: { not?: string; equals?: string } | string };
};
type ContentSelect = {
  id?: boolean;
  tierId?: boolean;
  rewardDefinitionId?: boolean;
  reward?: {
    select: {
      type?: boolean;
      cosmeticId?: boolean;
      cosmetic?: { select: { data?: boolean } };
    };
  };
};
const matchesContent = (where: ContentWhere) => (c: Content) => {
  if (c.boxDefinitionId !== where.boxDefinitionId || c.enabled !== where.enabled) return false;
  const type = where.reward?.type;
  if (type === undefined) return true;
  if (typeof type === 'string') return c.reward.type === type;
  if (type.not !== undefined) return c.reward.type !== type.not;
  return c.reward.type === type.equals;
};

const makeTx = (onLock: () => Promise<void>) => ({
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join('?').includes('pg_advisory_xact_lock')) {
      world.log.push(`lock:${values.join(',')}`);
      await onLock();
    }
    return 1;
  },
  boxContent: {
    // Projects `select` the way Prisma does, so a field the service forgets to select is missing here
    // too rather than handed over whole.
    findMany: async ({ where, select }: { where: ContentWhere; select: ContentSelect }) => {
      world.log.push('read:contents');
      const reward = select.reward?.select;
      return world.contents.filter(matchesContent(where)).map((c) => ({
        ...(select.id ? { id: c.id } : {}),
        ...(select.tierId ? { tierId: c.tierId } : {}),
        ...(select.rewardDefinitionId ? { rewardDefinitionId: c.rewardDefinitionId } : {}),
        ...(reward
          ? {
              reward: {
                ...(reward.type ? { type: c.reward.type } : {}),
                ...(reward.cosmeticId ? { cosmeticId: c.reward.cosmeticId } : {}),
                ...(reward.cosmetic?.select?.data
                  ? { cosmetic: c.reward.cosmetic && { data: c.reward.cosmetic.data } }
                  : {}),
              },
            }
          : {}),
      }));
    },
    count: async ({ where }: { where: ContentWhere }) =>
      world.contents.filter(matchesContent(where)).length,
  },
  userCosmetic: {
    findMany: async ({ where }: { where: { userId: number; cosmeticId: { in: number[] } } }) =>
      world.owned.filter(
        (o) => o.userId === where.userId && where.cosmeticId.in.includes(o.cosmeticId)
      ),
  },
  boxOpening: {
    findMany: async ({ where }: { where: { userId: number; boxDefinitionId: number } }) =>
      world.drawn.filter(
        (d) => d.userId === where.userId && d.boxDefinitionId === where.boxDefinitionId
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
    findMany: async ({ where }: { where: { itemDefinitionId?: number } }) =>
      where.itemDefinitionId === BOX_ID ? [{ id: SHOP_ITEM_ID }, { id: SECOND_LISTING_ID }] : [],
  },
  cosmeticShopPurchaseClaim: {
    ...claims.txDelegate,
    findUnique: async (args: Parameters<typeof claims.txDelegate.findUnique>[0]) => {
      world.log.push('claim:read');
      return claims.txDelegate.findUnique(args);
    },
    create: async (args: Parameters<typeof claims.txDelegate.create>[0]) => {
      world.log.push('claim:create');
      return claims.txDelegate.create(args);
    },
    updateMany: async (args: Parameters<typeof claims.txDelegate.updateMany>[0]) => {
      world.log.push(`claim:${args.data.status ?? 'update'}`);
      const result = await claims.txDelegate.updateMany(args);
      // The shared fake applies status and attempts only; carry the activity stamp too.
      const stamp = (args.data as { updatedAt?: Date }).updatedAt;
      const row = claims.rows.get(args.where.transactionId);
      if (result.count && stamp && row) Object.assign(row, { updatedAt: stamp });
      return result;
    },
    count: async ({
      where,
    }: {
      where: {
        userId: number;
        status: string;
        shopItemId: { in: number[] };
        transactionId: { not: string };
        updatedAt: { gte: Date };
      };
    }) => {
      world.log.push('read:pending');
      return [...claims.rows.values()].filter(
        (c) =>
          c.userId === where.userId &&
          c.status === where.status &&
          where.shopItemId.in.includes(c.shopItemId) &&
          c.transactionId !== where.transactionId.not &&
          // The fake stamps no updatedAt on create; an unstamped claim was made just now.
          ((c as { updatedAt?: Date }).updatedAt ?? new Date()) >= where.updatedAt.gte
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
  isModerator,
}: {
  /** null: no key sent. */
  idempotencyKey?: string | null;
  expectedVersion?: number;
  /** null: no confirmed price sent. */
  expectedUnitAmount?: number | null;
  isModerator?: boolean;
  payWith?: 'default' | 'blue-first';
  mysteryBoxEnabled?: boolean;
  countryCode?: string | null;
} = {}) =>
  purchaseCosmeticShopItem({
    userId: BUYER_ID,
    shopItemId: SHOP_ITEM_ID,
    isModerator,
    idempotencyKey: idempotencyKey ?? undefined,
    expectedUnitAmount: expectedUnitAmount ?? undefined,
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
  world = { contents: [hat(1), hat(2)], owned: [], drawn: [], items: [], purchases: [], log: [] };
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
      world.log.push('end');
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
      // The same-key claim is read under the lock, where nothing else can create one.
      'claim:read',
      'read:contents',
      'read:held',
      'read:pending',
      // Written and committed before the lock is released, so a waiting purchase counts it.
      'claim:create',
      'end',
      lock,
      'claim:paid',
      'grant:item',
      'end',
    ]);
  });

  // On a second pooled connection, a claim written while same-user waiters hold the rest of the
  // pool waits for a connection that only the lock holder can free.
  it('writes the claim on the lock-holding transaction, not a second connection', async () => {
    await buy();
    expect(dbMock.dbWrite.cosmeticShopPurchaseClaim.create).not.toHaveBeenCalled();
    expect(claims.rows.get(txId(KEY_A))?.status).toBe('paid');
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

    // A creator's pack isn't sold until its sale pays the creator; approval alone doesn't open it.
    it("a creator's mystery pack, even approved", async () => {
      dbMock.dbWrite.itemDefinition.findUnique.mockResolvedValue({ ...boxRow, sellerId: 10 });
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

  it('stops counting a pending purchase once it is old enough to be stuck', async () => {
    world.contents = [hat(1)];
    claims.rows.set(txId(KEY_B), {
      transactionId: txId(KEY_B),
      userId: BUYER_ID,
      shopItemId: SHOP_ITEM_ID,
      amount: PRICE,
      attempts: 1,
      status: 'pending',
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    } as never);
    await buy();
    expect(world.items).toHaveLength(1);
  });

  // Idle for 20 minutes, then pressed again in one tab while another tab buys: the resumed claim is
  // being charged now, so it must still count against the last thing left.
  it('counts an old claim that is being resumed right now', async () => {
    world.contents = [hat(1)];
    claims.rows.set(txId(KEY_A), {
      transactionId: txId(KEY_A),
      userId: BUYER_ID,
      shopItemId: SHOP_ITEM_ID,
      amount: PRICE,
      attempts: 1,
      status: 'pending',
      updatedAt: new Date(Date.now() - 20 * 60 * 1000),
    } as never);
    let second: Promise<unknown> | undefined;
    mocks.createMultiTx.mockImplementationOnce(async () => {
      second = buy({ idempotencyKey: KEY_B });
      await second.catch(() => undefined);
      return legs();
    });
    await buy({ idempotencyKey: KEY_A });
    await expect(second).rejects.toThrow('unopened boxes already cover');
    expect(world.items).toHaveLength(1);
  });

  // The second request read no claim and no held box before the first claimed, then reached the
  // lock after the first's box existed. It must be answered from the first's claim, not refused
  // because that box now covers the last thing left.
  it('answers a same-key double submit on the last thing left from the first claim', async () => {
    world.contents = [hat(1)];
    await buy();
    dbMock.dbWrite.item.findFirst.mockResolvedValueOnce(null);
    dbMock.dbWrite.cosmeticShopPurchaseClaim.findUnique.mockResolvedValueOnce(null);

    await expect(buy()).rejects.toThrow(PURCHASE_ALREADY_COMPLETED_MESSAGE);
    expect(world.items).toHaveLength(1);
    expect(mocks.createMultiTx).toHaveBeenCalledTimes(1);
    expect(mocks.refundMultiTx).not.toHaveBeenCalled();
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

  it('counts a reward drawn from this box before as gone, even after it was taken away', async () => {
    // Hat 1 was drawn and its UserCosmetic removed since; hat 2 is owned.
    world.drawn = [{ userId: BUYER_ID, boxDefinitionId: BOX_ID, rewardDefinitionId: 101 }];
    world.owned = [{ userId: BUYER_ID, cosmeticId: 1002 }];

    await expect(buy()).rejects.toThrow("You've collected everything in this box");
    nothingClaimedOrCharged();
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
    expect(mocks.assertEventPurchasable).toHaveBeenCalledTimes(1);
    nothingClaimedOrCharged();
  });

  it('sells an event box from the buyer’s own team when only the other team’s are owned', async () => {
    dbMock.dbWrite.itemDefinition.findUnique.mockResolvedValue({
      ...boxRow,
      params: { event: 'birthday2026' },
    });
    mocks.getEventBuyerTeam.mockResolvedValue('red');
    world.contents = [hat(1, { team: 'blue' }), hat(2, { team: 'red' })];

    await buy();

    expect(world.items).toHaveLength(1);
    expect(mocks.assertEventPurchasable).toHaveBeenCalledTimes(1);
  });

  it('refuses an event box the event gate refuses, before any claim', async () => {
    dbMock.dbWrite.itemDefinition.findUnique.mockResolvedValue({
      ...boxRow,
      params: { event: 'birthday2026' },
    });
    mocks.assertEventPurchasable.mockRejectedValue(new Error('This item is not available'));
    await expect(buy()).rejects.toThrow('This item is not available');
    nothingClaimedOrCharged();
  });

  it('refuses an event box when the buyer’s team cannot be confirmed, before any claim', async () => {
    dbMock.dbWrite.itemDefinition.findUnique.mockResolvedValue({
      ...boxRow,
      params: { event: 'birthday2026' },
    });
    mocks.getEventBuyerTeam.mockRejectedValue(new Error("We couldn't confirm your team."));
    await expect(buy()).rejects.toThrow("couldn't confirm your team");
    nothingClaimedOrCharged();
  });

  it('sells to a buyer outside the blocked countries', async () => {
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue({ value: ['BE'] });
    await buy({ countryCode: 'US' });
    expect(world.items).toHaveLength(1);
  });

  describe('refuses a listing outside its stock or sale window, before any claim', () => {
    it('out of stock', async () => {
      dbMock.dbRead.cosmeticShopItem.findUnique.mockResolvedValue({
        ...listing,
        availableQuantity: 3,
        _count: { purchases: 3 },
      });
      await expect(buy()).rejects.toThrow('out of stock');
      nothingClaimedOrCharged();
    });

    it('not open yet', async () => {
      dbMock.dbRead.cosmeticShopItem.findUnique.mockResolvedValue({
        ...listing,
        availableFrom: new Date(Date.now() + 60_000),
      });
      await expect(buy()).rejects.toThrow('not available yet');
      nothingClaimedOrCharged();
    });

    it('closed', async () => {
      dbMock.dbRead.cosmeticShopItem.findUnique.mockResolvedValue({
        ...listing,
        availableTo: new Date(Date.now() - 60_000),
      });
      await expect(buy()).rejects.toThrow('no longer available');
      nothingClaimedOrCharged();
    });
  });

  describe('resuming a pending claim of its own', () => {
    const seedOwnClaim = () =>
      claims.rows.set(txId(KEY_A), {
        transactionId: txId(KEY_A),
        userId: BUYER_ID,
        shopItemId: SHOP_ITEM_ID,
        amount: PRICE,
        attempts: 1,
        status: 'pending',
      });
    const duplicateLegs = () => ({
      ...legs(),
      transactionIds: legs().transactionIds.map((l) => ({ ...l, duplicate: true })),
    });

    // Not counted as a competing purchase: with one thing left, that would refuse it forever.
    it('sells on a retry whose earlier attempt claimed but charged nothing', async () => {
      world.contents = [hat(1)];
      seedOwnClaim();
      await buy();
      expect(world.items).toHaveLength(1);
      expect(claims.rows.get(txId(KEY_A))?.status).toBe('paid');
    });

    // Paid already: today's state must not strand the buyer with a charge and no box.
    it('grants a charged claim even when nothing is left for the buyer now', async () => {
      seedOwnClaim();
      mocks.listMultiTx.mockResolvedValue([{ amount: PRICE }]);
      mocks.createMultiTx.mockResolvedValue(duplicateLegs());
      world.owned = [
        { userId: BUYER_ID, cosmeticId: 1001 },
        { userId: BUYER_ID, cosmeticId: 1002 },
      ];
      await buy();
      expect(world.items).toHaveLength(1);
      expect(mocks.refundMultiTx).not.toHaveBeenCalled();
    });

    it('grants a charged claim after the listing sold out and changed price', async () => {
      seedOwnClaim();
      mocks.listMultiTx.mockResolvedValue([{ amount: PRICE }]);
      mocks.createMultiTx.mockResolvedValue(duplicateLegs());
      dbMock.dbRead.cosmeticShopItem.findUnique.mockResolvedValue({
        ...listing,
        unitAmount: PRICE + 100,
        availableQuantity: 1,
        _count: { purchases: 1 },
      });
      await buy();
      expect(world.items).toHaveLength(1);
      expect(mocks.createMultiTx.mock.calls[0][0].amount).toBe(PRICE);
      // Recorded at what was charged, which payouts and refunds read.
      expect(world.purchases[0].unitAmount).toBe(PRICE);
    });
  });

  // A request with the same key recorded it first and owns the charge's prefix.
  it('answers a grant that loses to a same-key request as state unknown, without refunding', async () => {
    world.items.push({
      id: 7n,
      itemDefinitionId: BOX_ID,
      holderId: 2,
      sourceKey: txId(KEY_A),
      quantity: 1,
    });
    await expect(buy()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PURCHASE_STATE_UNKNOWN_MESSAGE,
    });
    expect(mocks.refundMultiTx).not.toHaveBeenCalled();
  });

  it('refunds when the box grant itself fails', async () => {
    const tx = makeTx(async () => undefined);
    dbMock.dbWrite.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) =>
      claims.rollbackOnThrow(() =>
        fn({
          ...tx,
          item: {
            ...tx.item,
            create: async () => {
              throw new Error('db down');
            },
          },
        })
      )
    );
    await expect(buy()).rejects.toThrow('Failed to purchase box');
    expect(mocks.refundMultiTx).toHaveBeenCalledTimes(1);
    expect(claims.rows.get(txId(KEY_A))?.status).toBe('refunded');
  });

  it('answers a holder lock that times out before the charge as busy, charging nothing', async () => {
    const tx = makeTx(async () => {
      throw lockTimeout();
    });
    dbMock.dbWrite.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) =>
      claims.rollbackOnThrow(() => fn(tx))
    );
    await expect(buy()).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: ITEM_HOLDER_BUSY_MESSAGE,
    });
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  it.each([
    [
      'times out answers busy',
      '55P03',
      { code: 'TOO_MANY_REQUESTS', message: ITEM_HOLDER_BUSY_MESSAGE },
    ],
    [
      'fails with another Postgres code is not answered as busy',
      '40P01',
      { name: 'PrismaClientUnknownRequestError' },
    ],
  ])('a model query in the claim that %s, charging nothing', async (_label, code, expected) => {
    const tx = makeTx(async () => undefined);
    dbMock.dbWrite.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) =>
      claims.rollbackOnThrow(() =>
        fn({
          ...tx,
          cosmeticShopItem: {
            findMany: async () => {
              throw modelQueryError(code);
            },
          },
        })
      )
    );
    await expect(buy()).rejects.toMatchObject(expected);
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  describe('pending purchases across every listing of the box', () => {
    const seedPending = (shopItemId: number) =>
      claims.rows.set(txId(KEY_B), {
        transactionId: txId(KEY_B),
        userId: BUYER_ID,
        shopItemId,
        amount: PRICE,
        attempts: 1,
        status: 'pending',
      });

    it('counts one made through a second listing of the same box', async () => {
      world.contents = [hat(1)];
      seedPending(SECOND_LISTING_ID);
      await expect(buy()).rejects.toThrow('unopened boxes already cover');
      expect(mocks.createMultiTx).not.toHaveBeenCalled();
    });

    it('does not count one on a listing of another box (control)', async () => {
      world.contents = [hat(1)];
      seedPending(99);
      await buy();
      expect(world.items).toHaveLength(1);
    });
  });

  describe('the event gate for an event box', () => {
    beforeEach(() => {
      dbMock.dbWrite.itemDefinition.findUnique.mockResolvedValue({
        ...boxRow,
        params: { event: 'birthday2026' },
      });
    });

    it('is asked as a new purchase, with the buyer moderator status', async () => {
      await buy({ isModerator: true });
      expect(mocks.assertEventPurchasable).toHaveBeenCalledWith(
        expect.objectContaining({ isModerator: true, resumingClaim: false })
      );
    });

    // The event may have ended since the claim was charged; its window was checked then.
    it('is asked as a resumed claim when the claim was charged', async () => {
      mocks.assertEventPurchasable.mockImplementation(
        async ({ resumingClaim }: { resumingClaim?: boolean }) => {
          if (!resumingClaim) throw new Error('This item is not available');
        }
      );
      claims.rows.set(txId(KEY_A), {
        transactionId: txId(KEY_A),
        userId: BUYER_ID,
        shopItemId: SHOP_ITEM_ID,
        amount: PRICE,
        attempts: 1,
        status: 'pending',
      });
      mocks.listMultiTx.mockResolvedValue([{ amount: PRICE }]);
      mocks.createMultiTx.mockResolvedValue({
        ...legs(),
        transactionIds: legs().transactionIds.map((l) => ({ ...l, duplicate: true })),
      });
      await buy();
      expect(world.items).toHaveLength(1);
    });
  });

  describe('the price a claim was made at', () => {
    const seedOwnClaim = (amount: number) =>
      claims.rows.set(txId(KEY_A), {
        transactionId: txId(KEY_A),
        userId: BUYER_ID,
        shopItemId: SHOP_ITEM_ID,
        amount,
        attempts: 1,
        status: 'pending',
      });

    it('refuses an uncharged claim at an old price, with no price confirmed, as state unknown', async () => {
      seedOwnClaim(PRICE - 100);
      await expect(buy({ expectedUnitAmount: null })).rejects.toMatchObject({
        message: PURCHASE_STATE_UNKNOWN_MESSAGE,
      });
      expect(mocks.createMultiTx).not.toHaveBeenCalled();
    });

    it('refuses a charged claim whose amount differs from the confirmed one as state unknown', async () => {
      seedOwnClaim(PRICE - 100);
      mocks.listMultiTx.mockResolvedValue([{ amount: PRICE - 100 }]);
      await expect(buy({ expectedUnitAmount: PRICE })).rejects.toMatchObject({
        message: PURCHASE_STATE_UNKNOWN_MESSAGE,
      });
      expect(mocks.createMultiTx).not.toHaveBeenCalled();
      expect(world.items).toHaveLength(0);
    });
  });

  // A refusal while a claim may be charged must not tell the client to drop its key.
  describe('a refusal while resuming an uncharged claim is state unknown at every check', () => {
    const cases: [string, () => void][] = [
      [
        'nothing left',
        () => {
          world.owned = [
            { userId: BUYER_ID, cosmeticId: 1001 },
            { userId: BUYER_ID, cosmeticId: 1002 },
          ];
        },
      ],
      [
        'out of stock',
        () => {
          dbMock.dbRead.cosmeticShopItem.findUnique.mockResolvedValue({
            ...listing,
            availableQuantity: 1,
            _count: { purchases: 1 },
          });
        },
      ],
      [
        'box version changed',
        () => {
          dbMock.dbWrite.itemDefinition.findUnique.mockResolvedValue({
            ...boxRow,
            version: VERSION + 1,
          });
        },
      ],
      [
        'team lookup failed',
        () => {
          dbMock.dbWrite.itemDefinition.findUnique.mockResolvedValue({
            ...boxRow,
            params: { event: 'birthday2026' },
          });
          mocks.getEventBuyerTeam.mockRejectedValue(new Error('We could not confirm your team.'));
        },
      ],
    ];
    for (const [name, arrange] of cases)
      it(name, async () => {
        claims.rows.set(txId(KEY_A), {
          transactionId: txId(KEY_A),
          userId: BUYER_ID,
          shopItemId: SHOP_ITEM_ID,
          amount: PRICE,
          attempts: 1,
          status: 'pending',
        });
        arrange();
        await expect(buy()).rejects.toMatchObject({
          code: 'INTERNAL_SERVER_ERROR',
          message: PURCHASE_STATE_UNKNOWN_MESSAGE,
        });
        expect(mocks.createMultiTx).not.toHaveBeenCalled();
      });
  });

  it('answers the second of two concurrent same-key presses from the first claim', async () => {
    const results = await Promise.allSettled([buy(), buy()]);
    const reasons = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(reasons).toEqual([expect.stringContaining(PURCHASE_ALREADY_COMPLETED_MESSAGE)]);
    expect(world.items).toHaveLength(1);
    expect(mocks.refundMultiTx).not.toHaveBeenCalled();
  });

  // The event may have ended since an uncharged claim was made; nothing vouches for it.
  it('asks the event gate as a new purchase when resuming an uncharged claim', async () => {
    dbMock.dbWrite.itemDefinition.findUnique.mockResolvedValue({
      ...boxRow,
      params: { event: 'birthday2026' },
    });
    mocks.assertEventPurchasable.mockImplementation(
      async ({ resumingClaim }: { resumingClaim?: boolean }) => {
        if (!resumingClaim) throw new Error('This item is not available');
      }
    );
    claims.rows.set(txId(KEY_A), {
      transactionId: txId(KEY_A),
      userId: BUYER_ID,
      shopItemId: SHOP_ITEM_ID,
      amount: PRICE,
      attempts: 1,
      status: 'pending',
    });
    await expect(buy()).rejects.toMatchObject({ message: PURCHASE_STATE_UNKNOWN_MESSAGE });
    expect(mocks.assertEventPurchasable).toHaveBeenCalledWith(
      expect.objectContaining({ resumingClaim: false })
    );
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  describe('without an idempotency key', () => {
    it('sells, under a fresh charge prefix', async () => {
      await buy({ idempotencyKey: null });
      expect(world.items).toHaveLength(1);
      const prefix = mocks.createMultiTx.mock.calls[0][0].externalTransactionIdPrefix as string;
      expect(prefix.startsWith(`item-purchase-v1-${BUYER_ID}-${SHOP_ITEM_ID}-`)).toBe(true);
      expect(world.items[0].sourceKey).toBe(prefix);
    });

    it('sells only one of two concurrent presses when one thing is left', async () => {
      world.contents = [hat(1)];
      const results = await Promise.allSettled([
        buy({ idempotencyKey: null }),
        buy({ idempotencyKey: null }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(mocks.createMultiTx).toHaveBeenCalledTimes(1);
      expect(world.items).toHaveLength(1);
    });

    // No key: nobody else shares this prefix, so a unique violation is this request's own failure
    // and its charge is refunded.
    it('refunds a grant that fails on a unique violation', async () => {
      const tx = makeTx(async () => undefined);
      dbMock.dbWrite.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) =>
        claims.rollbackOnThrow(() =>
          fn({
            ...tx,
            item: {
              ...tx.item,
              create: async () => {
                throw p2002();
              },
            },
          })
        )
      );
      await expect(buy({ idempotencyKey: null })).rejects.toThrow('Failed to purchase box');
      expect(mocks.refundMultiTx).toHaveBeenCalledTimes(1);
    });
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
    // CDN placeholders, not countries.
    expect(isMysteryBoxBlockedIn('XX', ['BE'])).toBe(true);
    expect(isMysteryBoxBlockedIn('T1', ['BE'])).toBe(true);
    expect(isMysteryBoxBlockedIn('XX', [])).toBe(false);
  });

  it('refuses everywhere on a malformed list rather than nowhere', async () => {
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue({ value: 'BE' });
    await expect(getMysteryBoxBlockedRegions()).rejects.toThrow('not available right now');
  });
});
