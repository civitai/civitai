import { Prisma } from '@prisma/client';
import { BuzzApiError } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

// Pack purchases honour the buyer's idempotency key and handle a previously
// used transaction id the same way single purchases do: no grant, no payout,
// no refund, and a non-4xx outcome so the client keeps its key.

const spend = vi.fn();
const pay = vi.fn();
const refund = vi.fn();
const purchaseCreate = vi.fn();
const createManyUserCosmetic = vi.fn();

dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({
    $executeRaw: vi.fn(),
    userCosmetic: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: (...a: unknown[]) => createManyUserCosmetic(...a),
    },
    userCosmeticShopPurchases: { create: (...a: unknown[]) => purchaseCreate(...a) },
    userCosmeticShopPurchaseCosmetic: { createMany: vi.fn() },
    cosmeticShopItem: { update: vi.fn() },
  })
);

vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction: (...a: unknown[]) => spend(...a),
  createBuzzTransaction: (...a: unknown[]) => pay(...a),
  refundMultiAccountTransaction: (...a: unknown[]) => refund(...a),
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getBlockedPairIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('~/server/redis/caches', () => ({ refreshOwnedStickerCache: vi.fn() }));

const { purchaseCosmeticPack } = await import('~/server/services/cosmetic-pack.service');
const { PURCHASE_STATE_UNKNOWN_MESSAGE } = await import('~/server/services/shop-purchase-charge');

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

const BUYER = 901;
const PACK_CREATOR = 902;
const PRICE = 3000;
const KEY = '44444444-4444-4444-8444-444444444444';

const member = {
  cosmeticId: 1001,
  type: CosmeticType.Badge,
  data: {},
  createdById: PACK_CREATOR,
  listingId: 5001,
  listingMeta: { purchases: 0, acceptsBlueBuzz: false },
  addedById: PACK_CREATOR,
  availableQuantity: null,
  availableFrom: null,
  availableTo: null,
  soldCount: 0,
  floorAmount: 1700,
};

const buy = (idempotencyKey?: string) =>
  purchaseCosmeticPack({
    userId: BUYER,
    idempotencyKey,
    shopItem: {
      id: 7001,
      title: 'A pack',
      unitAmount: PRICE,
      addedById: PACK_CREATOR,
      meta: { purchases: 0 },
      memberCount: 1,
    },
    members: [member],
    buzzType: 'yellow',
  });

const legs = (duplicate?: boolean) => ({
  transactionIds: [
    {
      transactionId: 'tx-0',
      accountType: 'yellow',
      amount: PRICE,
      ...(duplicate === undefined ? {} : { duplicate }),
    },
  ],
  totalAmount: PRICE,
  transactionCount: 1,
});

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

describe('purchaseCosmeticPack with an idempotency key', () => {
  beforeEach(() => {
    for (const fn of [spend, pay, refund, purchaseCreate, createManyUserCosmetic]) fn.mockReset();
    loggingMock.logToAxiom.mockReset();
    dbMock.dbWrite.userCosmetic.findMany.mockResolvedValue([]);
    dbMock.dbWrite.userCosmeticShopPurchases.findUnique.mockReset();
    dbMock.dbWrite.userCosmeticShopPurchases.findUnique.mockResolvedValue(null);
    pay.mockResolvedValue({ transactionId: 'payout' });
    refund.mockResolvedValue({ totalRefunded: PRICE });
  });

  it("charges under the buyer's key", async () => {
    spend.mockResolvedValue(legs(false));

    await buy(KEY);

    expect(spend).toHaveBeenCalledTimes(1);
    expect(spend.mock.calls[0][0].externalTransactionIdPrefix).toBe(
      `cosmetic-pack-${BUYER}-7001-${KEY}`
    );
    // Never auto-resent after a failure that may have landed.
    const opts = spend.mock.calls[0][1] as { shouldRetry?: (e: unknown) => boolean } | undefined;
    expect(opts?.shouldRetry?.(new BuzzApiError(502, 'Bad Gateway'))).toBe(false);
    expect(opts?.shouldRetry?.(connectionRefused())).toBe(true);
    // Positive control for the "pays nothing" assertions below.
    expect(createManyUserCosmetic).toHaveBeenCalled();
    expect(pay).toHaveBeenCalled();
  });

  it('refuses a replay of a key already recorded, before any charge', async () => {
    dbMock.dbWrite.userCosmeticShopPurchases.findUnique.mockResolvedValue({
      buzzTransactionId: `cosmetic-pack-${BUYER}-7001-${KEY}`,
    });

    await expect(buy(KEY)).rejects.toThrow('This purchase has already been completed');
    expect(spend).not.toHaveBeenCalled();
  });

  it('a duplicate-leg charge grants, pays and refunds nothing', async () => {
    spend.mockResolvedValue(legs(true));

    await expectStateUnknown(buy(KEY));
    expect(stateUnknownLogs()).toEqual([
      expect.objectContaining({ userId: BUYER, shopItemId: 7001, amount: PRICE }),
    ]);
    expect(purchaseCreate).not.toHaveBeenCalled();
    expect(createManyUserCosmetic).not.toHaveBeenCalled();
    expect(pay).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
  });

  it('a ledger 409 on the charge is reported as unknown, not as a refusal', async () => {
    spend.mockRejectedValue(ledgerError(409, 'BAD_REQUEST'));

    await expectStateUnknown(buy(KEY));
    expect(refund).not.toHaveBeenCalled();
    expect(stateUnknownLogged()).toBe(true);
  });

  it('a ledger 400 decline stays a refusal', async () => {
    spend.mockRejectedValue(ledgerError(400, 'BAD_REQUEST'));

    await expect(buy(KEY)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(stateUnknownLogged()).toBe(false);
    expect(refund).not.toHaveBeenCalled();
  });

  it('another request with the same key recorded the purchase first: no refund of its charge', async () => {
    spend.mockResolvedValue(legs(false));
    purchaseCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );

    await expectStateUnknown(buy(KEY));
    expect(refund).not.toHaveBeenCalled();
  });

  it('without a client key, a unique violation still refunds this charge', async () => {
    spend.mockResolvedValue(legs(false));
    purchaseCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );

    await expect(buy()).rejects.toThrow('Failed to purchase pack');
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it('a refund that does not cover the charge is reported as unknown', async () => {
    spend.mockResolvedValue(legs(false));
    purchaseCreate.mockRejectedValue(new Error('db down'));
    refund.mockResolvedValue({ totalRefunded: 0 });

    await expectStateUnknown(buy(KEY));
    expect(refund.mock.calls[0][1]).toMatchObject({ retries: 0, timeoutMs: 10_000 });
  });

  it('a refund the ledger already holds (409) counts as refunded: a refusal', async () => {
    spend.mockResolvedValue(legs(false));
    purchaseCreate.mockRejectedValue(new Error('db down'));
    refund.mockRejectedValue(ledgerError(409, 'BAD_REQUEST'));

    await expect(buy(KEY)).rejects.toThrow('Failed to purchase pack');
    expect(stateUnknownLogged()).toBe(false);
  });

  it('a refund that fails after a charge is reported as unknown', async () => {
    spend.mockResolvedValue(legs(false));
    purchaseCreate.mockRejectedValue(new Error('db down'));
    refund.mockRejectedValue(new Error('ledger down'));

    await expectStateUnknown(buy(KEY));
    // Three attempts, then "state unknown".
    expect(refund).toHaveBeenCalledTimes(3);
  });

  it('without a key, still charges under a fresh random id (control)', async () => {
    spend.mockResolvedValue(legs(false));

    await buy();

    expect(spend.mock.calls[0][0].externalTransactionIdPrefix).toMatch(
      new RegExp(String.raw`^cosmetic-pack-${BUYER}-7001-[0-9a-f-]{36}$`)
    );
    expect(dbMock.dbWrite.userCosmeticShopPurchases.findUnique).not.toHaveBeenCalled();
  });
});
