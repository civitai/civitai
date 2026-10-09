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
const purchase = ({ idempotencyKey }: { idempotencyKey?: string } = { idempotencyKey: KEY }) =>
  purchaseCosmeticShopItem({
    userId: BUYER_ID,
    shopItemId: SHOP_ITEM_ID,
    idempotencyKey,
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
    loggingMock.logToAxiom.mockReset();
    mocks.shopItemFindUnique.mockResolvedValue(row);
    mocks.userCosmeticFindFirst.mockResolvedValue(null);
    claims = installShopPurchaseClaimFake();
    mocks.getBlockedPairIds.mockResolvedValue([]);
    mocks.userCosmeticCreate.mockImplementation(async ({ data }) => data);
    mocks.createBuzzTransaction.mockResolvedValue({ transactionId: 'payout' });
    mocks.refundMultiTx.mockResolvedValue({ totalRefunded: PRICE });
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
    dbMock.dbWrite.cosmeticShopPurchaseClaim.findUnique.mockResolvedValueOnce(null);

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

  it('a decline after another request resumed the claim keeps it for that request', async () => {
    mocks.createMultiTx.mockImplementation(async () => {
      // A second request with this key resumed the claim and may be charging.
      claims.rows.get(TX)!.attempts = 2;
      throw ledgerError(400, 'BAD_REQUEST');
    });

    await expect(purchase()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(claims.rows.get(TX)?.status).toBe('pending');
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

    await expect(purchase()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
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
});
