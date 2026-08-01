import type * as PromClient from '~/server/prom/client';
import type * as RedisCaches from '~/server/redis/caches';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    shopItemFindUnique: vi.fn(),
    shopItemUpdate: vi.fn(),
    userFindUnique: vi.fn(),
    userCosmeticFindFirst: vi.fn(),
    purchasesCreate: vi.fn(),
    userCosmeticCreate: vi.fn(),
    createBuzzTransaction: vi.fn(),
    createMultiTx: vi.fn(),
    refundMultiTx: vi.fn(),
    logToAxiom: vi.fn(),
    getBlockedPairIds: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    cosmeticShopItem: { findUnique: mocks.shopItemFindUnique },
    user: { findUnique: mocks.userFindUnique },
  },
  dbWrite: {
    cosmeticShopItem: { update: mocks.shopItemUpdate },
    userCosmetic: { findFirst: mocks.userCosmeticFindFirst },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        userCosmeticShopPurchases: { create: mocks.purchasesCreate },
        userCosmetic: { create: mocks.userCosmeticCreate },
      }),
  },
}));
// `importOriginal` keeps the rest of the prom surface real — the import graph
// reaches several of its registrars transitively via ~/server/redis/caches.
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
  dbReadFallbackCounter: { inc: vi.fn() },
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mocks.logToAxiom }));
// The post-commit emoji cache bust would reach a Redis that isn't running here,
// and its failure path logs to axiom — which these tests assert stays silent.
// `importOriginal` leaves every other cache export real.
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  refreshOwnedEmojiCache: vi.fn(async () => undefined),
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

import { computeCreatorShopSplit } from '~/server/schema/creator-shop.schema';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { purchaseCosmeticShopItem } from '../cosmetic-shop.service';

const BUYER_ID = 1;
const CREATOR_ID = 100;
const RESELLER_ID = 200;
const SHOP_ITEM_ID = 42;
const PRICE = 10000;

const shopItemRow = ({
  meta = { sellableByOthers: true, sellerShare: 20 },
  createdById = CREATOR_ID as number | null,
  unitAmount = PRICE,
} = {}) => ({
  id: SHOP_ITEM_ID,
  status: 'Published',
  cosmeticId: 7,
  availableQuantity: null,
  availableFrom: null,
  availableTo: null,
  unitAmount,
  title: 'Test Badge',
  meta,
  addedById: createdById,
  cosmetic: { type: 'Badge', createdById },
  _count: { purchases: 0 },
});

// The payout runs inside withRetries + a catch that swallows errors into axiom,
// so a broken payout still "succeeds". Every test therefore asserts the actual
// Sell transactions (recipient + amount), never just the absence of an error.
const sellCalls = () =>
  mocks.createBuzzTransaction.mock.calls
    .map(([arg]) => arg)
    .filter((arg) => arg.type === TransactionType.Sell);

// The buyer's charge, per funding account. Defaults to the whole price in yellow.
const chargeResponse = (charges: { accountType: string; amount: number }[]) => ({
  transactionIds: charges.map((c, i) => ({ transactionId: `tx-${i}`, ...c })),
  totalAmount: charges.reduce((sum, c) => sum + c.amount, 0),
  transactionCount: charges.length,
});

const purchase = (viaShopUserId?: number, payWith?: 'default' | 'blue-first') =>
  purchaseCosmeticShopItem({ userId: BUYER_ID, shopItemId: SHOP_ITEM_ID, viaShopUserId, payWith });

describe('purchaseCosmeticShopItem payouts', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.shopItemFindUnique.mockResolvedValue(shopItemRow());
    mocks.userCosmeticFindFirst.mockResolvedValue(null); // buyer doesn't own it yet
    mocks.userCosmeticCreate.mockResolvedValue({ userId: BUYER_ID, cosmeticId: 7 });
    mocks.createBuzzTransaction.mockResolvedValue({ transactionId: 'tx-1' });
    mocks.createMultiTx.mockResolvedValue(
      chargeResponse([{ accountType: 'yellow', amount: PRICE }])
    );
    mocks.getBlockedPairIds.mockResolvedValue([]);
  });

  it('a block between buyer and creator rejects the purchase before any charge', async () => {
    mocks.getBlockedPairIds.mockResolvedValue([CREATOR_ID]);

    await expect(purchase()).rejects.toThrow('Cosmetic is not available');
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  it('official items (no creator) skip the block lookup entirely', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(shopItemRow({ createdById: null, meta: {} }));

    await purchase();
    expect(mocks.getBlockedPairIds).not.toHaveBeenCalled();
  });

  it('charges the buyer the full price to the bank before paying anyone', async () => {
    await purchase();

    const charge = mocks.createMultiTx.mock.calls[0][0];
    expect(charge).toMatchObject({
      fromAccountId: BUYER_ID,
      fromAccountTypes: ['yellow'],
      toAccountId: 0,
      amount: PRICE,
      type: TransactionType.Purchase,
    });
    expect(charge.externalTransactionIdPrefix).toMatch(
      new RegExp(`^cosmetic-purchase-${BUYER_ID}-${SHOP_ITEM_ID}-`)
    );
  });

  it('own-storefront purchase (shop enabled) pays the creator the full 70% pool: 7000', async () => {
    mocks.userFindUnique.mockResolvedValue({ settings: { creatorShop: { enabled: true } } });

    await purchase(CREATOR_ID);

    expect(mocks.userFindUnique).toHaveBeenCalledWith({
      where: { id: CREATOR_ID },
      select: { settings: true },
    });
    expect(sellCalls()).toEqual([
      expect.objectContaining({
        fromAccountId: 0,
        toAccountId: CREATOR_ID,
        amount: 7000,
        externalTransactionId: expect.stringMatching(`:sell:${CREATOR_ID}:yellow$`),
      }),
    ]);
  });

  it('spoofed own-shop claim (shop NOT enabled) pays the creator only their 50% cut: 5000', async () => {
    mocks.userFindUnique.mockResolvedValue({ settings: { creatorShop: { enabled: false } } });

    await purchase(CREATOR_ID);

    expect(sellCalls()).toEqual([
      expect.objectContaining({ toAccountId: CREATOR_ID, amount: 5000 }),
    ]);
  });

  it('official Civitai shop attribution (-1) is a platform resale: creator gets 5000 only', async () => {
    await purchase(-1);

    // The system user has no shop settings worth consulting.
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expect(sellCalls()).toEqual([
      expect.objectContaining({ toAccountId: CREATOR_ID, amount: 5000 }),
    ]);
  });

  // Every UI surface sends an attribution (-1 or a shop owner id); undefined
  // still reaches us from direct API calls and stale clients. It must pay the
  // platform split — if omitting the field paid the full pool, stripping the
  // attribution would be the spoof.
  it('unattributed purchase of a sellable item falls back to the platform resale split: creator gets 5000 only', async () => {
    await purchase(undefined);

    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expect(sellCalls()).toEqual([
      expect.objectContaining({ toAccountId: CREATOR_ID, amount: 5000 }),
    ]);
  });

  it('unattributed purchase of a NON-sellable item pays the creator the full pool: 7000', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(shopItemRow({ meta: { sellableByOthers: false } }));

    await purchase(undefined);

    expect(sellCalls()).toEqual([
      expect.objectContaining({ toAccountId: CREATOR_ID, amount: 7000 }),
    ]);
  });

  it('verified cross-creator resale splits the pool: creator 5000, reseller 2000, distinct external ids', async () => {
    mocks.userFindUnique.mockResolvedValue({
      settings: { creatorShop: { resoldItemIds: [SHOP_ITEM_ID] } },
    });

    await purchase(RESELLER_ID);

    expect(mocks.userFindUnique).toHaveBeenCalledWith({
      where: { id: RESELLER_ID },
      select: { settings: true },
    });
    const sells = sellCalls();
    expect(sells).toHaveLength(2);
    expect(sells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromAccountId: 0,
          toAccountId: CREATOR_ID,
          amount: 5000,
          externalTransactionId: expect.stringMatching(`:sell:${CREATOR_ID}:yellow$`),
        }),
        expect.objectContaining({
          fromAccountId: 0,
          toAccountId: RESELLER_ID,
          amount: 2000,
          externalTransactionId: expect.stringMatching(`:sell:${RESELLER_ID}:yellow$`),
        }),
      ])
    );
    expect(sells[0].externalTransactionId).not.toBe(sells[1].externalTransactionId);
  });

  it('invalid reseller attribution (item not in their resoldItemIds) pays no seller share: creator 5000 only', async () => {
    mocks.userFindUnique.mockResolvedValue({
      settings: { creatorShop: { resoldItemIds: [999] } },
    });

    await purchase(RESELLER_ID);

    expect(sellCalls()).toEqual([
      expect.objectContaining({ toAccountId: CREATOR_ID, amount: 5000 }),
    ]);
  });

  it('genuine self-resale (buyer resells the item) gets no kickback: creator keeps the full 7000, buyer nothing', async () => {
    mocks.userFindUnique.mockResolvedValue({
      settings: { creatorShop: { resoldItemIds: [SHOP_ITEM_ID] } },
    });

    await purchase(BUYER_ID);

    const sells = sellCalls();
    expect(sells).toEqual([expect.objectContaining({ toAccountId: CREATOR_ID, amount: 7000 })]);
    expect(sells.some((s) => s.toAccountId === BUYER_ID)).toBe(false);
  });

  it('bogus self-attribution (buyer does NOT resell the item) is treated as unattributed: creator 5000 only', async () => {
    mocks.userFindUnique.mockResolvedValue({ settings: { creatorShop: { resoldItemIds: [] } } });

    await purchase(BUYER_ID);

    const sells = sellCalls();
    expect(sells).toEqual([expect.objectContaining({ toAccountId: CREATOR_ID, amount: 5000 })]);
    expect(sells.some((s) => s.toAccountId === BUYER_ID)).toBe(false);
  });

  it('legacy official item (no cosmetic creator) splits the FULL price across meta.paidToUserIds: 5000 each', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(
      shopItemRow({ createdById: null, meta: { paidToUserIds: [11, 22] } })
    );

    await purchase(undefined);

    expect(sellCalls()).toEqual([
      expect.objectContaining({
        toAccountId: 11,
        amount: 5000,
        externalTransactionId: expect.stringMatching(':sell:11:yellow$'),
      }),
      expect.objectContaining({
        toAccountId: 22,
        amount: 5000,
        externalTransactionId: expect.stringMatching(':sell:22:yellow$'),
      }),
    ]);
  });

  it('sellerShare 70 on a platform resale leaves the creator 0 — no zero-amount payout is created', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(
      shopItemRow({ meta: { sellableByOthers: true, sellerShare: 70 } })
    );

    await purchase(undefined);

    expect(sellCalls()).toHaveLength(0);
    // The only transaction is the buyer's charge.
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
    expect(mocks.createMultiTx).toHaveBeenCalledTimes(1);
    // And the payout block didn't silently blow up either.
    expect(mocks.logToAxiom).not.toHaveBeenCalled();
  });

  it('never swallows a payout mis-assertion: successful runs log nothing to axiom', async () => {
    await purchase(undefined);

    expect(mocks.logToAxiom).not.toHaveBeenCalled();
    expect(mocks.refundMultiTx).not.toHaveBeenCalled();
  });
});

describe('purchaseCosmeticShopItem blue buzz payments', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.shopItemFindUnique.mockResolvedValue(
      shopItemRow({ meta: { sellableByOthers: false, acceptsBlueBuzz: true } })
    );
    mocks.userCosmeticFindFirst.mockResolvedValue(null);
    mocks.userCosmeticCreate.mockResolvedValue({ userId: BUYER_ID, cosmeticId: 7 });
    mocks.createBuzzTransaction.mockResolvedValue({ transactionId: 'tx-1' });
    mocks.createMultiTx.mockResolvedValue(chargeResponse([{ accountType: 'blue', amount: PRICE }]));
    mocks.getBlockedPairIds.mockResolvedValue([]);
  });

  it('rejects blue payment for items that do not accept it, before any charge', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(shopItemRow({ meta: { sellableByOthers: false } }));

    await expect(purchase(undefined, 'blue-first')).rejects.toThrow('does not accept Blue Buzz');
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  it('fully-covered blue-first purchase pays the creator the whole pool in blue', async () => {
    await purchase(undefined, 'blue-first');

    expect(mocks.createMultiTx.mock.calls[0][0].fromAccountTypes).toEqual(['blue', 'yellow']);
    expect(sellCalls()).toEqual([
      expect.objectContaining({
        toAccountId: CREATOR_ID,
        toAccountType: 'blue',
        amount: 7000,
        externalTransactionId: expect.stringMatching(`:sell:${CREATOR_ID}:blue$`),
      }),
    ]);
  });

  it('blue-first: drains blue then the domain color, payout pro-rated per color', async () => {
    // Buyer had 6000 blue; the remaining 4000 came from yellow.
    mocks.createMultiTx.mockResolvedValue(
      chargeResponse([
        { accountType: 'blue', amount: 6000 },
        { accountType: 'yellow', amount: 4000 },
      ])
    );

    await purchase(undefined, 'blue-first');

    expect(mocks.createMultiTx.mock.calls[0][0].fromAccountTypes).toEqual(['blue', 'yellow']);
    // Creator pool 7000 → floor(7000 * 6000/10000) = 4200 blue + 2800 yellow.
    expect(sellCalls()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toAccountId: CREATOR_ID, toAccountType: 'blue', amount: 4200 }),
        expect.objectContaining({ toAccountId: CREATOR_ID, toAccountType: 'yellow', amount: 2800 }),
      ])
    );
    expect(sellCalls()).toHaveLength(2);
  });

  it('default payment on a blue-accepting item stays on the domain color', async () => {
    mocks.createMultiTx.mockResolvedValue(
      chargeResponse([{ accountType: 'yellow', amount: PRICE }])
    );

    await purchase(undefined, 'default');

    expect(mocks.createMultiTx.mock.calls[0][0].fromAccountTypes).toEqual(['yellow']);
    expect(sellCalls()).toEqual([
      expect.objectContaining({ toAccountId: CREATOR_ID, toAccountType: 'yellow', amount: 7000 }),
    ]);
  });
});

describe('computeCreatorShopSplit', () => {
  it('price 10000 / share 20 → pool 7000, seller 2000, creator 5000, platform 3000', () => {
    expect(computeCreatorShopSplit(10000, 20)).toEqual({
      creatorPool: 7000,
      sellerAmount: 2000,
      creatorAmount: 5000,
      platformCut: 3000,
    });
  });

  it('defaults to share 0: creator keeps the whole pool', () => {
    expect(computeCreatorShopSplit(10000)).toEqual({
      creatorPool: 7000,
      sellerAmount: 0,
      creatorAmount: 7000,
      platformCut: 3000,
    });
  });

  it('clamps share above 70 down to 70 (seller can never eat into the platform cut)', () => {
    expect(computeCreatorShopSplit(10000, 90)).toEqual({
      creatorPool: 7000,
      sellerAmount: 7000,
      creatorAmount: 0,
      platformCut: 3000,
    });
  });

  it('clamps negative share up to 0', () => {
    expect(computeCreatorShopSplit(10000, -5)).toEqual({
      creatorPool: 7000,
      sellerAmount: 0,
      creatorAmount: 7000,
      platformCut: 3000,
    });
  });

  it('floors on odd prices — remainder goes to the platform, never minted', () => {
    // 999 * 0.7 = 699.3 → 699; 999 * 0.2 = 199.8 → 199
    const split = computeCreatorShopSplit(999, 20);
    expect(split).toEqual({
      creatorPool: 699,
      sellerAmount: 199,
      creatorAmount: 500,
      platformCut: 300,
    });
    expect(split.creatorAmount + split.sellerAmount + split.platformCut).toBeLessThanOrEqual(999);
  });
});
