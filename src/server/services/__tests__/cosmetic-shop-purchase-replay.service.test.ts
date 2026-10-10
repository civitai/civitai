import type * as PromClient from '~/server/prom/client';
import type * as RedisCaches from '~/server/redis/caches';
import type * as CosmeticPackService from '~/server/services/cosmetic-pack.service';
import { Prisma } from '@prisma/client';
import { BuzzApiError } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

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
    purchasesCreate: vi.fn(),
    purchasesUpdate: vi.fn(),
    userCosmeticCreate: vi.fn(),
    createBuzzTransaction: vi.fn(),
    createMultiTx: vi.fn(),
    refundMultiTx: vi.fn(),
    listMultiTx: vi.fn(),
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
  getMultiAccountTransactionsByPrefix: mocks.listMultiTx,
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
}));
vi.mock('~/server/services/image-entity.service', () => ({
  createEntityImages: vi.fn(),
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
import { PURCHASE_STATE_UNKNOWN_MESSAGE, runPurchaseChecks } from '../shop-purchase-charge';
import { refreshOwnedStickerCache } from '~/server/redis/caches';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  installShopPurchaseClaimFake,
  shopPurchaseClaimFake,
} from '~/test-utils/shopPurchaseClaimFake';

const fwd =
  (fn: (...a: unknown[]) => unknown) =>
  (...args: unknown[]) =>
    fn(...args);
dbMock.dbRead.cosmeticShopItem.findUnique.mockImplementation(fwd(mocks.shopItemFindUnique));
dbMock.dbWrite.cosmeticShopItem.update.mockImplementation(fwd(mocks.shopItemUpdate));
dbMock.dbWrite.userCosmetic.findFirst.mockImplementation(fwd(mocks.userCosmeticFindFirst));
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

// The shape the real buzz client hands back: buzz.service's mapError wraps the
// ledger's status in a TRPCError and keeps the BuzzApiError as `cause`.
const ledgerError = (status: number, code: 'BAD_REQUEST' | 'INTERNAL_SERVER_ERROR') =>
  new TRPCError({ code, message: 'ledger', cause: new BuzzApiError(status, 'ledger') });
const stateUnknownLogs = () =>
  loggingMock.logToAxiom.mock.calls
    .map(([arg]) => arg as Record<string, unknown>)
    .filter((arg) => arg.name === 'shop-purchase-state-unknown');
const stateUnknownLogged = () => stateUnknownLogs().length > 0;
const connectionRefused = () =>
  Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

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

const TX = `cosmetic-purchase-v2-${BUYER_ID}-${SHOP_ITEM_ID}-${KEY}`;
// A leg the ledger lists under the prefix: an earlier attempt charged.
const earlierLeg = {
  transactionId: 'earlier',
  externalTransactionId: `${TX}Yellow`,
  accountType: 'yellow',
  accountId: BUYER_ID,
  amount: PRICE,
};
// A claim an earlier attempt with this key left behind.
// An object, so a field can be overridden without a default parameter
// swallowing an explicit undefined.
const seedClaim = (
  status: string,
  overrides: { amount?: number; userId?: number; shopItemId?: number; attempts?: number } = {}
) =>
  claims.rows.set(TX, {
    transactionId: TX,
    userId: BUYER_ID,
    shopItemId: SHOP_ITEM_ID,
    amount: PRICE,
    attempts: 1,
    status,
    ...overrides,
  });

// An object, so "no key" can be said: a default parameter would replace undefined.
const purchase = (
  {
    idempotencyKey,
    expectedUnitAmount,
    payWith,
    stickersEnabled,
    packsEnabled = true,
  }: {
    idempotencyKey?: string;
    expectedUnitAmount?: number;
    payWith?: 'default' | 'blue-first';
    stickersEnabled?: boolean;
    packsEnabled?: boolean;
  } = { idempotencyKey: KEY }
) =>
  purchaseCosmeticShopItem({
    userId: BUYER_ID,
    shopItemId: SHOP_ITEM_ID,
    idempotencyKey,
    expectedUnitAmount,
    payWith,
    stickersEnabled,
    buzzType: 'yellow',
    packsEnabled,
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
    loggingMock.logToAxiom.mockReset();
    mocks.shopItemFindUnique.mockResolvedValue(row);
    mocks.userCosmeticFindFirst.mockResolvedValue(null);
    claims = installShopPurchaseClaimFake();
    mocks.getBlockedPairIds.mockResolvedValue([]);
    mocks.userCosmeticCreate.mockImplementation(async ({ data }) => data);
    mocks.createBuzzTransaction.mockResolvedValue({ transactionId: 'payout' });
    mocks.refundMultiTx.mockResolvedValue({ totalRefunded: PRICE });
    // A seeded pending claim stands for an earlier attempt that charged, unless
    // a test says the ledger has nothing under it.
    mocks.listMultiTx.mockResolvedValue([earlierLeg]);
  });

  it('grants and pays out when the ledger reports every leg as new (control)', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false));

    await purchase();

    expect(mocks.userCosmeticCreate).toHaveBeenCalledTimes(1);
    expect(mocks.createBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.refundMultiTx).not.toHaveBeenCalled();
    expect(mocks.createMultiTx.mock.calls[0][0].externalTransactionIdPrefix).toBe(TX);
    expect(claims.rows.get(TX)?.status).toBe('paid');
  });

  it('claims the purchase before any money moves', async () => {
    mocks.createMultiTx.mockImplementation(async () => {
      expect(claims.rows.get(TX)).toMatchObject({ status: 'pending', amount: PRICE });
      return legs(false);
    });

    await purchase();
    expect(mocks.createMultiTx).toHaveBeenCalledTimes(1);
  });

  it('refuses a replay of a key already paid, before any charge', async () => {
    seedClaim('paid');

    await expect(purchase()).rejects.toThrow('This purchase has already been completed');
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  it('refuses a replay of a refunded key, before any charge', async () => {
    seedClaim('refunded');

    await expect(purchase()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  it('a replay of a key whose refund is unconfirmed is unknown, and not charged', async () => {
    seedClaim('refunding');

    await expectStateUnknown(purchase());
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
    // Answered from the claim's own status, which is what reconciliation reads.
    expect(stateUnknownLogs()).toEqual([
      expect.objectContaining({ reason: 'retry of a refunding claim' }),
    ]);
  });

  // The lost-response recovery: an earlier attempt charged and its reply never
  // arrived. Its claim is still pending, so the retry's duplicate legs are that
  // attempt's money.
  for (const [what, overrides] of [
    ['another buyer', { userId: BUYER_ID + 1 }],
    ['another item', { shopItemId: SHOP_ITEM_ID + 1 }],
  ] as const) {
    it(`refuses a claim recorded for ${what}, before any charge`, async () => {
      seedClaim('pending', overrides);

      await expect(purchase()).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'This purchase is not available',
      });
      expect(mocks.createMultiTx).not.toHaveBeenCalled();
    });
  }

  it('a claim deleted between the insert and the read is refused, not charged', async () => {
    seedClaim('pending');
    // Absent when first looked up, present for the insert, gone again for the read.
    dbMock.dbWrite.cosmeticShopPurchaseClaim.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(purchase()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  it('a retry counts itself on the claim', async () => {
    seedClaim('pending');
    mocks.createMultiTx.mockResolvedValue(legs(true));

    await purchase();
    expect(claims.rows.get(TX)?.attempts).toBe(2);
  });

  it('a claim settled between the read and the resume is unknown, and not charged', async () => {
    seedClaim('pending');
    dbMock.dbWrite.cosmeticShopPurchaseClaim.updateMany.mockResolvedValueOnce({ count: 0 });

    await expectStateUnknown(purchase());
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
  });

  it('a claim recreated at another amount between the read and the resume is not resumed', async () => {
    seedClaim('pending');
    dbMock.dbWrite.cosmeticShopPurchaseClaim.updateMany.mockImplementationOnce((async (
      args: Parameters<typeof claims.delegate.updateMany>[0]
    ) => {
      claims.rows.get(TX)!.amount = PRICE - 1;
      return claims.delegate.updateMany(args);
    }) as never);

    await expectStateUnknown(purchase());
    expect(mocks.createMultiTx).not.toHaveBeenCalled();
    expect(claims.rows.get(TX)?.attempts).toBe(1);
  });

  it('a retry of a pending claim grants against the earlier charge', async () => {
    seedClaim('pending');
    mocks.createMultiTx.mockResolvedValue(legs(true));

    await purchase();

    expect(mocks.userCosmeticCreate).toHaveBeenCalledTimes(1);
    expect(mocks.refundMultiTx).not.toHaveBeenCalled();
    expect(claims.rows.get(TX)?.status).toBe('paid');
  });

  it('a retry of a pending claim charges, records and pays out the claimed amount', async () => {
    seedClaim('pending', { amount: PRICE - 500 });
    mocks.createMultiTx.mockResolvedValue(legs(false));

    await purchase();

    expect(mocks.createMultiTx.mock.calls[0][0].amount).toBe(PRICE - 500);
    expect(mocks.purchasesCreate.mock.calls[0][0].data.unitAmount).toBe(PRICE - 500);
    expect(mocks.createBuzzTransaction.mock.calls[0][0].amount).toBe(PRICE - 500);
    expect(mocks.createBuzzTransaction.mock.calls[0][0].details.originalAmount).toBe(PRICE - 500);
    expect(mocks.purchasesUpdate.mock.calls[0][0].data.meta.platformCut).toBe(0);
  });

  // The duplicate legs and the refund are both measured against the claim, not
  // against today's price.
  const singleLeg = (amount: number, duplicate: boolean) => ({
    transactionIds: [{ transactionId: 'tx-0', accountType: 'yellow', amount, duplicate }],
    totalAmount: amount,
    transactionCount: 1,
  });

  it('a retry grants when the earlier charge covers the claimed amount, below today’s price', async () => {
    seedClaim('pending', { amount: PRICE - 500 });
    mocks.createMultiTx.mockResolvedValue(singleLeg(PRICE - 500, true));

    await purchase();
    expect(mocks.userCosmeticCreate).toHaveBeenCalledTimes(1);
  });

  it('a retry is unknown when the earlier charge falls short of the claimed amount, above today’s price', async () => {
    seedClaim('pending', { amount: PRICE + 500 });
    mocks.createMultiTx.mockResolvedValue(singleLeg(PRICE, true));

    await expectStateUnknown(purchase());
    nothingGrantedPaidOrRefunded();
  });

  it('a refund of exactly the claimed amount is a refusal', async () => {
    seedClaim('pending', { amount: PRICE - 500 });
    mocks.createMultiTx.mockResolvedValue(singleLeg(PRICE - 500, false));
    mocks.purchasesCreate.mockRejectedValue(new Error('db down'));
    mocks.refundMultiTx.mockResolvedValue({ totalRefunded: PRICE - 500 });

    await expect(purchase()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Failed to purchase cosmetic',
    });
    expect(claims.rows.get(TX)?.status).toBe('refunded');
  });

  it('a retry of a pending claim with mixed legs is unknown', async () => {
    seedClaim('pending');
    mocks.createMultiTx.mockResolvedValue({
      // The duplicate leg alone covers the claim; the new one is money moved now.
      transactionIds: [
        { transactionId: 'tx-new', accountType: 'blue', amount: 500, duplicate: false },
        { transactionId: 'tx-dup', accountType: 'yellow', amount: PRICE, duplicate: true },
      ],
      totalAmount: PRICE + 500,
      transactionCount: 2,
    });

    await expectStateUnknown(purchase());
    nothingGrantedPaidOrRefunded();
    expect(claims.rows.get(TX)?.status).toBe('pending');
  });

  it('another attempt granted the claim while this one charged: no second grant, no refund', async () => {
    seedClaim('pending');
    mocks.createMultiTx.mockImplementation(async () => {
      claims.rows.get(TX)!.status = 'paid';
      return legs(true);
    });

    await expect(purchase()).rejects.toThrow('This purchase has already been completed');
    nothingGrantedPaidOrRefunded();
  });

  it('a charge whose legs are all duplicates grants, pays and refunds nothing', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(true));

    await expectStateUnknown(purchase());
    nothingGrantedPaidOrRefunded();
    // One structured event, with what reconciliation needs to find the charge.
    expect(stateUnknownLogs()).toEqual([
      expect.objectContaining({
        type: 'error',
        userId: BUYER_ID,
        shopItemId: SHOP_ITEM_ID,
        amount: PRICE,
        transactionId: expect.stringContaining(KEY),
      }),
    ]);
  });

  it('a charge with any duplicate leg grants, pays and refunds nothing', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false, true));

    await expectStateUnknown(purchase());
    nothingGrantedPaidOrRefunded();
  });

  it('a ledger 409 on the charge is reported as unknown, not as a refusal', async () => {
    mocks.createMultiTx.mockRejectedValue(ledgerError(409, 'BAD_REQUEST'));

    await expectStateUnknown(purchase());
    nothingGrantedPaidOrRefunded();
    expect(stateUnknownLogged()).toBe(true);
  });

  // Ordinary declines (insufficient funds, wrong account, limits) are ledger
  // 400s. They must stay refusals: no "state unknown", no error log.
  it('a ledger 400 decline stays a refusal', async () => {
    mocks.createMultiTx.mockRejectedValue(ledgerError(400, 'BAD_REQUEST'));

    await expect(purchase()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(stateUnknownLogged()).toBe(false);
    nothingGrantedPaidOrRefunded();
    // Nothing reached the ledger, so the key is free again.
    expect(claims.rows.has(TX)).toBe(false);
  });

  // The other request may have charged, so this decline is not an answer for the
  // key: a 4xx would have the client drop the key that finds that charge.
  it('a decline after another request resumed the claim keeps it for that request, as unknown', async () => {
    mocks.createMultiTx.mockImplementation(async () => {
      // A second request with this key resumed the claim and may be charging.
      claims.rows.get(TX)!.attempts = 2;
      throw ledgerError(400, 'BAD_REQUEST');
    });

    await expectStateUnknown(purchase());
    expect(claims.rows.get(TX)?.status).toBe('pending');
    expect(stateUnknownLogs()).toEqual([
      expect.objectContaining({ reason: 'declined while the claim is pending' }),
    ]);
  });

  it('a decline on a resumed claim is unknown: the earlier attempt may have charged', async () => {
    seedClaim('pending');
    mocks.createMultiTx.mockRejectedValue(ledgerError(400, 'BAD_REQUEST'));

    await expectStateUnknown(purchase());
    expect(claims.rows.get(TX)).toMatchObject({ status: 'pending', attempts: 2 });
  });

  it('a decline is still a refusal when the claim cannot be released', async () => {
    mocks.createMultiTx.mockRejectedValue(ledgerError(400, 'BAD_REQUEST'));
    dbMock.dbWrite.cosmeticShopPurchaseClaim.deleteMany.mockRejectedValueOnce(new Error('db down'));

    await expect(purchase()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(claims.rows.get(TX)?.status).toBe('pending');
  });

  // These may have charged: the claim must stay for the retry to resume.
  for (const [what, failure] of [
    ['an error with no ledger status', () => new TypeError('fetch failed')],
    ['a ledger 408', () => ledgerError(408, 'INTERNAL_SERVER_ERROR')],
    ['a ledger 500', () => ledgerError(500, 'INTERNAL_SERVER_ERROR')],
    ['a ledger 503', () => ledgerError(503, 'INTERNAL_SERVER_ERROR')],
  ] as const) {
    it(`a charge failing with ${what} keeps the claim pending`, async () => {
      mocks.createMultiTx.mockRejectedValue(failure());

      const rejection = await purchase().then(
        () => null,
        (e: unknown) => e
      );
      // Never a refusal: that tells the client nothing was charged.
      expect(rejection).not.toBeNull();
      expect(rejection instanceof TRPCError && rejection.code === 'BAD_REQUEST').toBe(false);
      expect(claims.rows.get(TX)?.status).toBe('pending');
    });
  }

  it('a late decline never deletes a claim that is no longer pending', async () => {
    mocks.createMultiTx.mockImplementation(async () => {
      claims.rows.get(TX)!.status = 'paid';
      throw ledgerError(400, 'BAD_REQUEST');
    });

    await expect(purchase()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This purchase has already been completed',
    });
    expect(claims.rows.get(TX)?.status).toBe('paid');
  });

  // buzz.service maps these to a 500, so the client keeps its key; the claim is
  // freed anyway because nothing reached the ledger.
  for (const status of [402, 422]) {
    it(`a ledger ${status} decline frees the key`, async () => {
      mocks.createMultiTx.mockRejectedValue(ledgerError(status, 'INTERNAL_SERVER_ERROR'));

      await expect(purchase()).rejects.toMatchObject({ cause: { status } });
      expect(claims.rows.has(TX)).toBe(false);
    });
  }

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

  it('without a client key, a unique violation still refunds this charge', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false));
    mocks.purchasesCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );

    await expect(purchase({})).rejects.toThrow('Failed to purchase cosmetic');
    expect(mocks.refundMultiTx).toHaveBeenCalledTimes(1);
  });

  it('a charge is never auto-resent after a failure that may have landed', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false));

    await purchase();

    const opts = mocks.createMultiTx.mock.calls[0][1] as
      | { shouldRetry?: (e: unknown) => boolean }
      | undefined;
    // A gateway 5xx may have landed; only a connection that never opened may be resent.
    // The client calls the predicate with the raw error, before it is mapped.
    expect(opts?.shouldRetry?.(new BuzzApiError(502, 'Bad Gateway'))).toBe(false);
    expect(opts?.shouldRetry?.(connectionRefused())).toBe(true);
  });

  // Refunded, so nothing is charged: a refusal lets the client mint a new key
  // instead of replaying the refunded one.
  it('any other grant failure refunds this charge and is a refusal (control)', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false));
    mocks.purchasesCreate.mockRejectedValue(new Error('db down'));

    await expect(purchase()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Failed to purchase cosmetic',
    });
    expect(mocks.refundMultiTx).toHaveBeenCalledTimes(1);
    expect(mocks.refundMultiTx.mock.calls[0][0].externalTransactionIdPrefix).toBe(TX);
    expect(claims.rows.get(TX)?.status).toBe('refunded');
  });

  it('the claim is refunding before the refund is sent', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false));
    mocks.purchasesCreate.mockRejectedValue(new Error('db down'));
    mocks.refundMultiTx.mockImplementation(async () => {
      expect(claims.rows.get(TX)?.status).toBe('refunding');
      return { totalRefunded: PRICE };
    });

    await expect(purchase()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.refundMultiTx).toHaveBeenCalledTimes(1);
  });

  it('a claim another attempt left refunding, met on the refund path, is unknown: no refund', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false));
    mocks.purchasesCreate.mockRejectedValue(new Error('db down'));
    dbMock.dbWrite.cosmeticShopPurchaseClaim.updateMany.mockImplementation((async (
      args: Parameters<typeof claims.delegate.updateMany>[0]
    ) => {
      claims.rows.get(TX)!.status = 'refunding';
      return claims.delegate.updateMany(args);
    }) as never);

    await expectStateUnknown(purchase());
    expect(mocks.refundMultiTx).not.toHaveBeenCalled();
  });

  it('a claim that could not be marked refunding is unknown, and nothing is refunded', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false));
    mocks.purchasesCreate.mockRejectedValue(new Error('db down'));
    dbMock.dbWrite.cosmeticShopPurchaseClaim.updateMany.mockRejectedValueOnce(new Error('db down'));

    await expectStateUnknown(purchase());
    expect(mocks.refundMultiTx).not.toHaveBeenCalled();
  });

  it('a refund that landed but could not be recorded is still a refusal', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false));
    mocks.purchasesCreate.mockRejectedValue(new Error('db down'));
    dbMock.dbWrite.cosmeticShopPurchaseClaim.update.mockRejectedValueOnce(new Error('db down'));

    await expect(purchase()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Failed to purchase cosmetic',
    });
    expect(mocks.refundMultiTx).toHaveBeenCalledTimes(1);
    // Left refunding: a retry is answered unknown rather than charged.
    expect(claims.rows.get(TX)?.status).toBe('refunding');
  });

  it('marks the claim paid before writing the purchase', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false));
    mocks.purchasesCreate.mockImplementation(async () => {
      expect(claims.rows.get(TX)?.status).toBe('paid');
    });

    await purchase();
    expect(mocks.purchasesCreate).toHaveBeenCalledTimes(1);
  });

  it('another attempt settled the claim before this one could refund: no refund', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false));
    mocks.purchasesCreate.mockRejectedValue(new Error('db down'));
    dbMock.dbWrite.cosmeticShopPurchaseClaim.updateMany.mockImplementation((async (
      args: Parameters<typeof claims.delegate.updateMany>[0]
    ) => {
      claims.rows.get(TX)!.status = 'paid';
      return claims.delegate.updateMany(args);
    }) as never);

    await expect(purchase()).rejects.toThrow('This purchase has already been completed');
    expect(mocks.refundMultiTx).not.toHaveBeenCalled();
  });

  // The grant committed, so the buyer has the cosmetic; a later step failing
  // must not take their money back.
  it('a failure after the grant committed never refunds', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false));
    vi.mocked(refreshOwnedStickerCache).mockRejectedValueOnce(new Error('redis down'));

    await expect(purchase()).rejects.toThrow('This purchase has already been completed');
    expect(mocks.userCosmeticCreate).toHaveBeenCalledTimes(1);
    expect(mocks.refundMultiTx).not.toHaveBeenCalled();
    expect(claims.rows.get(TX)?.status).toBe('paid');
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

  it('a refund is sent once, resent by the client only when the connection never opened', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false));
    mocks.purchasesCreate.mockRejectedValue(new Error('db down'));

    await expect(purchase()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.refundMultiTx).toHaveBeenCalledTimes(1);
    const opts = mocks.refundMultiTx.mock.calls[0][1] as {
      retries?: number;
      timeoutMs?: number;
      shouldRetry?: (e: unknown) => boolean;
    };
    expect(opts).toMatchObject({ retries: 1, timeoutMs: 10_000 });
    expect(opts.shouldRetry?.(new BuzzApiError(503, 'Service Unavailable'))).toBe(false);
    expect(opts.shouldRetry?.(connectionRefused())).toBe(true);
  });

  it('a refund names the claim it reverses', async () => {
    mocks.createMultiTx.mockResolvedValue(legs(false));
    mocks.purchasesCreate.mockRejectedValue(new Error('db down'));

    await expect(purchase()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.refundMultiTx.mock.calls[0][0].details).toEqual({ claim: TX });
  });

  // Every refund outcome short of "the whole amount is back" is left to
  // reconciliation: one attempt, then "state unknown" and the event.
  for (const [outcome, settle] of [
    ['a ledger 5xx', (m: Mock) => m.mockRejectedValue(ledgerError(503, 'INTERNAL_SERVER_ERROR'))],
    ['a 409', (m: Mock) => m.mockRejectedValue(ledgerError(409, 'BAD_REQUEST'))],
    [
      'a timeout',
      (m: Mock) =>
        m.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError')),
    ],
    ['a short total', (m: Mock) => m.mockResolvedValue({ totalRefunded: PRICE - 1 })],
    ['a response with no total', (m: Mock) => m.mockResolvedValue({})],
    ['an empty response', (m: Mock) => m.mockResolvedValue(undefined)],
  ] as const) {
    it(`a refund ending in ${outcome} is not retried and is reported as unknown`, async () => {
      mocks.createMultiTx.mockResolvedValue(legs(false));
      mocks.purchasesCreate.mockRejectedValue(new Error('db down'));
      settle(mocks.refundMultiTx);

      await expectStateUnknown(purchase());
      expect(mocks.refundMultiTx).toHaveBeenCalledTimes(1);
      expect(stateUnknownLogs()).toHaveLength(1);
      // Never back to pending: a retry would read the reversed legs as its own.
      expect(claims.rows.get(TX)?.status).toBe('refunding');
    });
  }

  // Claim first: a retry of a purchase that may already be charged is answered
  // from its claim, not refused by what changed since the first attempt.
  describe('a retry is answered from its claim before the purchase checks', () => {
    const pastWindow = { availableTo: new Date('2020-01-01T00:00:00Z') };
    const soldOut = { availableQuantity: 1, _count: { purchases: 1 } };

    for (const [what, change, refusal] of [
      ['after the sale window closed', pastWindow, 'This cosmetic is no longer available'],
      ['after the item sold out', soldOut, 'This cosmetic is out of stock'],
      [
        'after a price change',
        { unitAmount: PRICE + 100 },
        `The price changed to ${PRICE + 100} Buzz. Check the new price and try again.`,
      ],
    ] as const) {
      it(`resumes a pending claim ${what}, at the claimed amount`, async () => {
        mocks.shopItemFindUnique.mockResolvedValue({ ...row, ...change });
        seedClaim('pending', { amount: PRICE - 500 });
        mocks.createMultiTx.mockResolvedValue(legs(false));

        await purchase({ idempotencyKey: KEY, expectedUnitAmount: PRICE - 500 });

        expect(mocks.createMultiTx.mock.calls[0][0].amount).toBe(PRICE - 500);
        expect(claims.rows.get(TX)?.status).toBe('paid');
      });

      // Control: the same change still refuses a new purchase.
      it(`refuses a new purchase ${what}, claiming nothing`, async () => {
        mocks.shopItemFindUnique.mockResolvedValue({ ...row, ...change });

        await expect(
          purchase({ idempotencyKey: KEY, expectedUnitAmount: PRICE })
        ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: refusal });
        expect(dbMock.dbWrite.cosmeticShopPurchaseClaim.create).not.toHaveBeenCalled();
        expect(mocks.createMultiTx).not.toHaveBeenCalled();
      });

      // The parked claim: two requests with one key were both declined, so the
      // claim stayed pending with nothing charged under it. It vouches for
      // nothing, so it is held to today's state like a new purchase.
      it(`a pending claim nothing was charged under is unknown ${what}, and not charged`, async () => {
        mocks.shopItemFindUnique.mockResolvedValue({ ...row, ...change });
        seedClaim('pending', { amount: PRICE });
        mocks.listMultiTx.mockResolvedValue([]);

        await expectStateUnknown(purchase({ idempotencyKey: KEY, expectedUnitAmount: PRICE }));
        expect(mocks.listMultiTx).toHaveBeenCalledWith(TX);
        nothingGrantedPaidOrRefunded();
        expect(mocks.createMultiTx).not.toHaveBeenCalled();
        expect(claims.rows.get(TX)).toMatchObject({ status: 'pending', attempts: 1 });
        expect(stateUnknownLogs()).toEqual([
          expect.objectContaining({ reason: 'refused while a claim is pending' }),
        ]);
      });
    }

    it('a claim parked by two declined requests is not redeemed after a price rise', async () => {
      // Two requests with one key, both declined: the second resumed the claim
      // while the first was charging, so neither may release it.
      mocks.createMultiTx.mockImplementationOnce(async () => {
        claims.rows.get(TX)!.attempts = 2;
        throw ledgerError(400, 'BAD_REQUEST');
      });
      await expectStateUnknown(purchase({ idempotencyKey: KEY, expectedUnitAmount: PRICE }));
      expect(claims.rows.get(TX)).toMatchObject({ status: 'pending', amount: PRICE });

      // Later, at a higher price, with nothing charged under the claim.
      mocks.shopItemFindUnique.mockResolvedValue({ ...row, unitAmount: PRICE + 100 });
      mocks.listMultiTx.mockResolvedValue([]);
      mocks.createMultiTx.mockClear();
      await expectStateUnknown(purchase({ idempotencyKey: KEY, expectedUnitAmount: PRICE }));
      expect(mocks.createMultiTx).not.toHaveBeenCalled();
      expect(mocks.userCosmeticCreate).not.toHaveBeenCalled();
    });

    // Two requests with one key in flight together: the second finds the claim
    // before the first's charge lands. Nothing has changed, so it resumes.
    it('a concurrent resume with nothing charged yet still completes', async () => {
      seedClaim('pending');
      mocks.listMultiTx.mockResolvedValue([]);
      mocks.createMultiTx.mockResolvedValue(legs(false));

      await purchase({ idempotencyKey: KEY, expectedUnitAmount: PRICE });
      expect(mocks.createMultiTx.mock.calls[0][0].amount).toBe(PRICE);
      expect(claims.rows.get(TX)).toMatchObject({ status: 'paid', attempts: 2 });
    });

    it('a retry whose ledger read fails is unknown, and not charged', async () => {
      seedClaim('pending', { amount: PRICE - 500 });
      mocks.listMultiTx.mockRejectedValue(new Error('ledger down'));

      await expectStateUnknown(purchase());
      expect(mocks.createMultiTx).not.toHaveBeenCalled();
      expect(claims.rows.get(TX)?.attempts).toBe(1);
      // The reconciliation record names the claim, at its claimed amount.
      expect(stateUnknownLogs()).toEqual([
        expect.objectContaining({
          reason: 'ledger read failed on resume',
          transactionId: TX,
          userId: BUYER_ID,
          shopItemId: SHOP_ITEM_ID,
          amount: PRICE - 500,
          error: 'ledger down',
        }),
      ]);
    });

    it('a settled claim is answered without reading the ledger', async () => {
      seedClaim('paid');
      mocks.listMultiTx.mockRejectedValue(new Error('ledger down'));

      await expect(purchase()).rejects.toThrow('This purchase has already been completed');
      expect(mocks.listMultiTx).not.toHaveBeenCalled();
    });

    // The claim's own amount is held to today's price, so omitting the
    // confirmed price does not let an uncharged claim keep an old one.
    it('an uncharged claim at an old price is unknown with no confirmed price sent, and not charged', async () => {
      seedClaim('pending', { amount: PRICE - 500 });
      mocks.listMultiTx.mockResolvedValue([]);

      await expectStateUnknown(purchase({ idempotencyKey: KEY }));
      expect(mocks.listMultiTx).toHaveBeenCalledTimes(1);
      expect(mocks.createMultiTx).not.toHaveBeenCalled();
    });

    // The retry path relies on this: ANY failure of a check while a claim is
    // pending (a refusal, or a bug that throws) answers state unknown, never a
    // 4xx that would have the client drop its key.
    it('runPurchaseChecks turns any throw into state unknown while a claim is pending', async () => {
      const pending = {
        userId: BUYER_ID,
        shopItemId: SHOP_ITEM_ID,
        transactionId: TX,
        amount: PRICE,
      };
      const crash = new TypeError("Cannot read properties of undefined (reading 'teams')");

      await expectStateUnknown(runPurchaseChecks(pending, async () => Promise.reject(crash)));
      await expect(runPurchaseChecks(null, async () => Promise.reject(crash))).rejects.toBe(crash);
    });

    it('a new purchase does not read the ledger', async () => {
      mocks.createMultiTx.mockResolvedValue(legs(false));

      await purchase();
      expect(mocks.listMultiTx).not.toHaveBeenCalled();
    });

    // Each check that still applies on a retry answers state unknown while a
    // claim is pending, and refuses a new purchase outright.
    for (const [what, setup, refusal] of [
      [
        'unpublished',
        () => mocks.shopItemFindUnique.mockResolvedValue({ ...row, status: 'Draft' }),
        'This cosmetic is not available',
      ],
      [
        "the buyer's own cosmetic",
        () =>
          mocks.shopItemFindUnique.mockResolvedValue({
            ...row,
            cosmetic: { ...row.cosmetic, createdById: BUYER_ID },
          }),
        'You already own this cosmetic',
      ],
      [
        'a block with the creator',
        () => {
          mocks.shopItemFindUnique.mockResolvedValue({
            ...row,
            cosmetic: { ...row.cosmetic, createdById: 77 },
          });
          mocks.getBlockedPairIds.mockResolvedValue([77]);
        },
        'This cosmetic is not available',
      ],
      [
        'a sticker with stickers off',
        () =>
          mocks.shopItemFindUnique.mockResolvedValue({
            ...row,
            cosmetic: { ...row.cosmetic, type: 'Sticker' },
          }),
        'This cosmetic is not available',
      ],
      [
        'unlimited uses of a sticker already held',
        () => {
          mocks.shopItemFindUnique.mockResolvedValue({
            ...row,
            cosmetic: { ...row.cosmetic, type: 'Sticker' },
          });
          mocks.userCosmeticFindFirst.mockResolvedValue({ claimKey: 'k' });
        },
        'You already have unlimited uses of this sticker',
      ],
    ] as const) {
      const stickersEnabled = what !== 'a sticker with stickers off';
      it(`${what}: unknown on a retry, not charged`, async () => {
        setup();
        seedClaim('pending');

        await expectStateUnknown(purchase({ idempotencyKey: KEY, stickersEnabled }));
        expect(mocks.createMultiTx).not.toHaveBeenCalled();
        // The record keeps why the retry was refused.
        expect(stateUnknownLogs()).toEqual([
          expect.objectContaining({ reason: 'refused while a claim is pending', error: refusal }),
        ]);
      });

      it(`${what}: refused as a new purchase (control)`, async () => {
        setup();

        await expect(purchase({ idempotencyKey: KEY, stickersEnabled })).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: refusal,
        });
      });
    }

    it('packs switched off: unknown on a pack retry, refused when new', async () => {
      const PACK_TX = `cosmetic-pack-v2-${BUYER_ID}-${SHOP_ITEM_ID}-${KEY}`;
      mocks.shopItemFindUnique.mockResolvedValue({ ...row, cosmeticId: null, cosmetic: null });
      claims.rows.set(PACK_TX, {
        transactionId: PACK_TX,
        userId: BUYER_ID,
        shopItemId: SHOP_ITEM_ID,
        amount: PRICE,
        attempts: 1,
        status: 'pending',
      });
      await expectStateUnknown(purchase({ idempotencyKey: KEY, packsEnabled: false }));
      expect(mocks.purchaseCosmeticPack).not.toHaveBeenCalled();

      claims.rows.clear();
      await expect(purchase({ idempotencyKey: KEY, packsEnabled: false })).rejects.toThrow(
        'This pack is not available'
      );
    });

    it('Blue Buzz on an item that takes none: unknown on a retry, refused when new', async () => {
      seedClaim('pending');
      await expectStateUnknown(purchase({ idempotencyKey: KEY, payWith: 'blue-first' }));
      expect(mocks.createMultiTx).not.toHaveBeenCalled();

      claims.rows.clear();
      await expect(purchase({ idempotencyKey: KEY, payWith: 'blue-first' })).rejects.toThrow(
        'This item does not accept Blue Buzz'
      );
    });

    it('a paid claim of an item now sold out is answered as completed', async () => {
      mocks.shopItemFindUnique.mockResolvedValue({ ...row, ...soldOut });
      seedClaim('paid');

      await expect(purchase()).rejects.toThrow('This purchase has already been completed');
    });

    it('a paid claim of an item since delisted is answered as completed, not unknown', async () => {
      mocks.shopItemFindUnique.mockResolvedValue({ ...row, listed: false });
      seedClaim('paid');

      await expect(purchase()).rejects.toThrow('This purchase has already been completed');
      expect(stateUnknownLogged()).toBe(false);
    });

    it('a retry confirming an amount other than its claim is unknown, and not charged', async () => {
      seedClaim('pending', { amount: PRICE - 500 });

      await expectStateUnknown(purchase({ idempotencyKey: KEY, expectedUnitAmount: PRICE }));
      expect(mocks.createMultiTx).not.toHaveBeenCalled();
      // Not counted as an attempt: it charged nothing.
      expect(claims.rows.get(TX)?.attempts).toBe(1);
      expect(stateUnknownLogs()).toEqual([
        expect.objectContaining({
          reason: 'expected amount differs from the claim',
          transactionId: TX,
          amount: PRICE - 500,
        }),
      ]);
    });

    // A kill switch or a block still wins, but a 4xx would have the client drop
    // the key that finds a charge the earlier attempt may have made.
    it('a refusal of a retry with a pending claim is unknown, and not charged', async () => {
      mocks.shopItemFindUnique.mockResolvedValue({ ...row, listed: false });
      seedClaim('pending');

      await expectStateUnknown(purchase());
      expect(mocks.createMultiTx).not.toHaveBeenCalled();
      expect(claims.rows.get(TX)).toMatchObject({ status: 'pending', attempts: 1 });
      expect(stateUnknownLogs()).toEqual([
        expect.objectContaining({ reason: 'refused while a claim is pending' }),
      ]);
    });

    it('the same refusal of a new purchase is a plain refusal (control)', async () => {
      mocks.shopItemFindUnique.mockResolvedValue({ ...row, listed: false });

      await expect(purchase()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(stateUnknownLogged()).toBe(false);
    });

    // Resuming could charge again for something a different purchase already
    // granted, so that claim is settled by hand.
    it('a retry for a single-purchase cosmetic the buyer now owns is unknown, and not charged', async () => {
      mocks.shopItemFindUnique.mockResolvedValue({
        ...row,
        cosmetic: { ...row.cosmetic, type: 'ProfileDecoration' },
      });
      mocks.userCosmeticFindFirst.mockResolvedValue({ userId: BUYER_ID, cosmeticId: 7 });
      seedClaim('pending');

      await expectStateUnknown(purchase());
      expect(mocks.createMultiTx).not.toHaveBeenCalled();
      expect(stateUnknownLogs()).toEqual([
        expect.objectContaining({ reason: 'refused while a claim is pending' }),
      ]);
    });

    // Two requests with one key, the other inserting its claim between this
    // one's lookup and its insert. Each charge must be at an amount the request
    // making it confirmed.
    const claimedConcurrentlyAt = (amount: number) =>
      dbMock.dbWrite.cosmeticShopPurchaseClaim.create.mockImplementationOnce((async (
        args: Parameters<typeof claims.delegate.create>[0]
      ) => {
        seedClaim('pending', { amount });
        return claims.delegate.create(args);
      }) as never);

    it('a concurrent claim at another amount is unknown, and not charged by this request', async () => {
      claimedConcurrentlyAt(PRICE - 500);

      await expectStateUnknown(purchase({ idempotencyKey: KEY, expectedUnitAmount: PRICE }));
      expect(dbMock.dbWrite.cosmeticShopPurchaseClaim.create).toHaveBeenCalledTimes(1);
      expect(mocks.createMultiTx).not.toHaveBeenCalled();
      expect(claims.rows.get(TX)).toMatchObject({ amount: PRICE - 500, attempts: 1 });
    });

    it('a concurrent claim at the confirmed amount is resumed (control)', async () => {
      claimedConcurrentlyAt(PRICE);
      mocks.createMultiTx.mockResolvedValue(legs(false));

      await purchase({ idempotencyKey: KEY, expectedUnitAmount: PRICE });
      expect(mocks.createMultiTx.mock.calls[0][0].amount).toBe(PRICE);
      expect(claims.rows.get(TX)).toMatchObject({ status: 'paid', attempts: 2 });
    });

    const PACK_TX = `cosmetic-pack-v2-${BUYER_ID}-${SHOP_ITEM_ID}-${KEY}`;
    const pack = { ...row, cosmeticId: null, cosmetic: null };

    it('a pack retry past the listing’s sale window reaches the pack purchase', async () => {
      mocks.shopItemFindUnique.mockResolvedValue({ ...pack, ...pastWindow });
      claims.rows.set(PACK_TX, {
        transactionId: PACK_TX,
        userId: BUYER_ID,
        shopItemId: SHOP_ITEM_ID,
        amount: PRICE,
        attempts: 1,
        status: 'pending',
      });
      mocks.purchaseCosmeticPack.mockResolvedValue({});

      // A discounted amount due, unlike the listing's price.
      await purchase({ idempotencyKey: KEY, expectedUnitAmount: PRICE - 500 });
      expect(mocks.purchaseCosmeticPack).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: KEY, expectedAmount: PRICE - 500 })
      );
      // The claim the listing was judged on is the one the pack is judged on:
      // passed down, not read a second time.
      expect(mocks.purchaseCosmeticPack.mock.calls[0][0].start).toMatchObject({
        transactionId: PACK_TX,
        chargedBefore: true,
        existingClaim: expect.objectContaining({ status: 'pending' }),
      });
      expect(dbMock.dbWrite.cosmeticShopPurchaseClaim.findUnique).toHaveBeenCalledTimes(1);
    });

    it('a new pack purchase past the listing’s sale window is refused (control)', async () => {
      mocks.shopItemFindUnique.mockResolvedValue({ ...pack, ...pastWindow });

      await expect(purchase()).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'This pack is no longer available',
      });
      expect(mocks.purchaseCosmeticPack).not.toHaveBeenCalled();
    });
  });
});
