import type * as PromClient from '~/server/prom/client';
import type * as RedisCaches from '~/server/redis/caches';
import type * as CosmeticPackService from '~/server/services/cosmetic-pack.service';
import { Prisma } from '@prisma/client';
import { BuzzApiError } from '@civitai/buzz';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A shop purchase whose external transaction id the ledger has seen before
// (a resent idempotency key, or two requests with the same one). This request
// moved no Buzz, so it must not grant, pay out or refund, and the client must
// not be told "nothing happened" (a 4xx), which would have it retry with a
// fresh key.

const { mocks } = vi.hoisted(() => ({
  mocks: {
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
    purchaseCosmeticPack: vi.fn(),
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
vi.mock('~/server/services/cosmetic-pack.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticPackService>()),
  getPackMembers: vi.fn(async () => []),
  purchaseCosmeticPack: mocks.purchaseCosmeticPack,
}));

import { purchaseCosmeticShopItem } from '../cosmetic-shop.service';
import { PURCHASE_STATE_UNKNOWN_MESSAGE } from '../shop-purchase-charge';
import { dbMock } from '~/__tests__/mocks/db.mock';

const fwd =
  (fn: (...a: unknown[]) => unknown) =>
  (...args: unknown[]) =>
    fn(...args);
dbMock.dbRead.cosmeticShopItem.findUnique.mockImplementation(fwd(mocks.shopItemFindUnique));
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
const KEY = '33333333-3333-4333-8333-333333333333';

const row = {
  id: SHOP_ITEM_ID,
  status: 'Published',
  listed: true,
  cosmeticId: 7,
  availableQuantity: null,
  availableFrom: null,
  availableTo: null,
  unitAmount: PRICE,
  title: 'A frame',
  // Paid to someone, so a payout that wrongly runs is visible.
  meta: { paidToUserIds: [500] },
  addedById: 999,
  cosmetic: { type: 'ContentDecoration', createdById: null, data: {} },
  _count: { purchases: 0 },
};

const legs = (...duplicate: (boolean | undefined)[]) => ({
  transactionIds: duplicate.map((d, i) => ({
    transactionId: `tx-${i}`,
    accountType: 'yellow',
    amount: PRICE / duplicate.length,
    ...(d === undefined ? {} : { duplicate: d }),
  })),
  totalAmount: PRICE,
  transactionCount: duplicate.length,
});

const purchase = () =>
  purchaseCosmeticShopItem({
    userId: BUYER_ID,
    shopItemId: SHOP_ITEM_ID,
    idempotencyKey: KEY,
    buzzType: 'yellow',
  });

const nothingGrantedPaidOrRefunded = () => {
  expect(mocks.purchasesCreate).not.toHaveBeenCalled();
  expect(mocks.userCosmeticCreate).not.toHaveBeenCalled();
  expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
  expect(mocks.refundMultiTx).not.toHaveBeenCalled();
};

// Not a 4xx: the client keeps its key for anything else.
const expectStateUnknown = async (p: Promise<unknown>) => {
  const error = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
    message: PURCHASE_STATE_UNKNOWN_MESSAGE,
  });
};

describe('purchaseCosmeticShopItem with a previously used transaction id', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.shopItemFindUnique.mockResolvedValue(row);
    mocks.userCosmeticFindFirst.mockResolvedValue(null);
    mocks.purchasesFindUnique.mockResolvedValue(null);
    mocks.getBlockedPairIds.mockResolvedValue([]);
    mocks.userCosmeticCreate.mockImplementation(async ({ data }) => data);
    mocks.createBuzzTransaction.mockResolvedValue({ transactionId: 'payout' });
    mocks.refundMultiTx.mockResolvedValue({});
  });

  it('grants and pays out when the ledger reports every leg as new (control)', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false));

    await purchase();

    expect(mocks.userCosmeticCreate).toHaveBeenCalledTimes(1);
    expect(mocks.createBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.refundMultiTx).not.toHaveBeenCalled();
  });

  it('a charge whose legs are all duplicates grants, pays and refunds nothing', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(true));

    await expectStateUnknown(purchase());
    nothingGrantedPaidOrRefunded();
  });

  it('a charge with any duplicate leg grants, pays and refunds nothing', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false, true));

    await expectStateUnknown(purchase());
    nothingGrantedPaidOrRefunded();
  });

  it('a ledger 409 on the charge is reported as unknown, not as a refusal', async () => {
    mocks.createMultiTx.mockRejectedValue(new BuzzApiError(409, 'Conflict'));

    await expectStateUnknown(purchase());
    nothingGrantedPaidOrRefunded();
  });

  it('another request with the same key recorded the purchase first: no refund of its charge', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false));
    mocks.purchasesCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );

    await expectStateUnknown(purchase());
    expect(mocks.refundMultiTx).not.toHaveBeenCalled();
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
  });

  it('any other grant failure still refunds this charge (control)', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false));
    mocks.purchasesCreate.mockRejectedValue(new Error('db down'));

    await expect(purchase()).rejects.toThrow('Failed to purchase cosmetic');
    expect(mocks.refundMultiTx).toHaveBeenCalledTimes(1);
    expect(mocks.refundMultiTx.mock.calls[0][0].externalTransactionIdPrefix).toContain(KEY);
  });

  it("passes the buyer's key through to a pack purchase", async () => {
    mocks.shopItemFindUnique.mockResolvedValue({ ...row, cosmeticId: null, cosmetic: null });
    mocks.purchaseCosmeticPack.mockResolvedValue({});

    await purchaseCosmeticShopItem({
      userId: BUYER_ID,
      shopItemId: SHOP_ITEM_ID,
      idempotencyKey: KEY,
      buzzType: 'yellow',
      packsEnabled: true,
    });

    expect(mocks.purchaseCosmeticPack).toHaveBeenCalledWith(
      expect.objectContaining({ userId: BUYER_ID, idempotencyKey: KEY })
    );
  });

  it('a refund that fails after a charge is reported as unknown', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false));
    mocks.purchasesCreate.mockRejectedValue(new Error('db down'));
    mocks.refundMultiTx.mockRejectedValue(new Error('ledger down'));

    await expectStateUnknown(purchase());
  });
});
