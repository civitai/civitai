import { Prisma } from '@prisma/client';
import { BuzzApiError } from '@civitai/buzz';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  installShopPurchaseClaimFake,
  shopPurchaseClaimFake,
} from '~/test-utils/shopPurchaseClaimFake';

// Pack purchases honour the buyer's idempotency key and handle a previously
// used transaction id the same way single purchases do: no grant, no payout,
// no refund, and a non-4xx outcome so the client keeps its key.

const spend = vi.fn();
const pay = vi.fn();
const refund = vi.fn();
const purchaseCreate = vi.fn();
const createManyUserCosmetic = vi.fn();
const createManyComponents = vi.fn();
let claims = shopPurchaseClaimFake();

dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
  claims.rollbackOnThrow(() =>
    fn({
      $executeRaw: vi.fn(),
      userCosmetic: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: (...a: unknown[]) => createManyUserCosmetic(...a),
      },
      userCosmeticShopPurchases: { create: (...a: unknown[]) => purchaseCreate(...a) },
      userCosmeticShopPurchaseCosmetic: {
        createMany: (...a: unknown[]) => createManyComponents(...a),
      },
      cosmeticShopItem: { update: vi.fn() },
      cosmeticShopPurchaseClaim: claims.txDelegate,
    })
  )
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

const buy = (idempotencyKey?: string, expectedAmount?: number) =>
  purchaseCosmeticPack({
    userId: BUYER,
    idempotencyKey,
    expectedAmount,
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

const TX = `cosmetic-pack-v2-${BUYER}-7001-${KEY}`;
// A claim an earlier attempt with this key left behind.
const seedClaim = (status: string, { amount = PRICE }: { amount?: number } = {}) =>
  claims.rows.set(TX, {
    transactionId: TX,
    userId: BUYER,
    shopItemId: 7001,
    amount,
    attempts: 1,
    status,
  });

const legs = (duplicate?: boolean, amount = PRICE) => ({
  transactionIds: [
    {
      transactionId: 'tx-0',
      accountType: 'yellow',
      amount,
      ...(duplicate === undefined ? {} : { duplicate }),
    },
  ],
  totalAmount: amount,
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
    for (const fn of [
      spend,
      pay,
      refund,
      purchaseCreate,
      createManyUserCosmetic,
      createManyComponents,
    ])
      fn.mockReset();
    loggingMock.logToAxiom.mockReset();
    claims = installShopPurchaseClaimFake();
    dbMock.dbWrite.userCosmetic.findMany.mockResolvedValue([]);
    pay.mockResolvedValue({ transactionId: 'payout' });
    refund.mockResolvedValue({ totalRefunded: PRICE });
  });

  it("charges under the buyer's key, claimed first and marked paid", async () => {
    spend.mockImplementation(async () => {
      // Claimed before any money moves.
      expect(claims.rows.get(TX)).toMatchObject({ status: 'pending', amount: PRICE });
      return legs(false);
    });

    await buy(KEY);

    expect(spend).toHaveBeenCalledTimes(1);
    expect(spend.mock.calls[0][0].externalTransactionIdPrefix).toBe(TX);
    expect(claims.rows.get(TX)?.status).toBe('paid');
    // Never auto-resent after a failure that may have landed.
    const opts = spend.mock.calls[0][1] as { shouldRetry?: (e: unknown) => boolean } | undefined;
    expect(opts?.shouldRetry?.(new BuzzApiError(502, 'Bad Gateway'))).toBe(false);
    expect(opts?.shouldRetry?.(connectionRefused())).toBe(true);
    // Positive control for the "pays nothing" assertions below.
    expect(createManyUserCosmetic).toHaveBeenCalled();
    expect(pay).toHaveBeenCalled();
  });

  // The button showed a number; a pack re-priced or re-discounted since must
  // refuse rather than charge another one.
  it('refuses when the amount due moved since the button rendered, before any claim', async () => {
    await expect(buy(KEY, PRICE - 1)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: `The price changed to ${PRICE} Buzz. Check the new price and try again.`,
    });
    expect(spend).not.toHaveBeenCalled();
    expect(claims.rows.size).toBe(0);
  });

  it('charges when the amount due matches the button (control)', async () => {
    spend.mockResolvedValue(legs(false));

    await buy(KEY, PRICE);
    expect(spend).toHaveBeenCalledTimes(1);
  });

  it('refuses a replay of a key already paid, before any charge', async () => {
    seedClaim('paid');

    await expect(buy(KEY)).rejects.toThrow('This purchase has already been completed');
    expect(spend).not.toHaveBeenCalled();
  });

  it('refuses a replay of a refunded key, before any charge', async () => {
    seedClaim('refunded');

    await expect(buy(KEY)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(spend).not.toHaveBeenCalled();
  });

  it('a replay of a key whose refund is unconfirmed is unknown, and not charged', async () => {
    seedClaim('refunding');

    await expectStateUnknown(buy(KEY));
    expect(spend).not.toHaveBeenCalled();
    expect(stateUnknownLogs()).toEqual([
      expect.objectContaining({ reason: 'retry of a refunding claim' }),
    ]);
  });

  // The lost-response recovery: an earlier attempt charged and its reply never
  // arrived. Its claim is still pending, so the retry's duplicate legs are that
  // attempt's money.
  it('a retry of a pending claim grants against the earlier charge', async () => {
    seedClaim('pending');
    spend.mockResolvedValue(legs(true));

    await buy(KEY);

    expect(createManyUserCosmetic).toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
    expect(claims.rows.get(TX)?.status).toBe('paid');
  });

  it('a retry of a pending claim charges the claimed amount, not today’s price', async () => {
    seedClaim('pending', { amount: PRICE - 500 });
    spend.mockResolvedValue(legs(false, PRICE - 500));

    await buy(KEY);

    expect(spend.mock.calls[0][0].amount).toBe(PRICE - 500);
  });

  it('a retry of a pending claim records and pays out of the claimed amount', async () => {
    // Far below today's price, so a payout computed from today's price cannot fit in it.
    const claimed = 1000;
    seedClaim('pending', { amount: claimed });
    spend.mockResolvedValue(legs(false, claimed));

    await buy(KEY);

    expect(purchaseCreate.mock.calls[0][0].data.unitAmount).toBe(claimed);
    const paidOut = pay.mock.calls.reduce((sum, [p]) => sum + (p as { amount: number }).amount, 0);
    expect(paidOut).toBeGreaterThan(0);
    expect(paidOut).toBeLessThanOrEqual(claimed);
    // What each member is credited with, which a takedown reverses.
    const attributed = (
      createManyComponents.mock.calls[0][0] as { data: { unitAmount: number }[] }
    ).data.reduce((sum, c) => sum + c.unitAmount, 0);
    expect(attributed).toBeGreaterThan(0);
    expect(attributed).toBeLessThanOrEqual(claimed);
  });

  it('marks the claim paid before writing the purchase', async () => {
    spend.mockResolvedValue(legs(false));
    purchaseCreate.mockImplementation(async () => {
      expect(claims.rows.get(TX)?.status).toBe('paid');
    });

    await buy(KEY);
    expect(purchaseCreate).toHaveBeenCalledTimes(1);
  });

  it('a retry of a pending claim whose duplicate legs fall short of it is unknown', async () => {
    seedClaim('pending');
    spend.mockResolvedValue(legs(true, PRICE - 1));

    await expectStateUnknown(buy(KEY));
    expect(createManyUserCosmetic).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
    expect(claims.rows.get(TX)?.status).toBe('pending');
  });

  it('a retry of a pending claim with mixed legs is unknown', async () => {
    seedClaim('pending');
    spend.mockResolvedValue({
      // The duplicate leg alone covers the claim; the new one is money moved now.
      transactionIds: [
        { transactionId: 'tx-new', accountType: 'blue', amount: 500, duplicate: false },
        { transactionId: 'tx-dup', accountType: 'yellow', amount: PRICE, duplicate: true },
      ],
      totalAmount: PRICE + 500,
      transactionCount: 2,
    });

    await expectStateUnknown(buy(KEY));
    expect(createManyUserCosmetic).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
    expect(claims.rows.get(TX)?.status).toBe('pending');
  });

  it('another attempt granted the claim while this one charged: no second grant, no refund', async () => {
    seedClaim('pending');
    spend.mockImplementation(async () => {
      claims.rows.get(TX)!.status = 'paid';
      return legs(true);
    });

    await expect(buy(KEY)).rejects.toThrow('This purchase has already been completed');
    expect(purchaseCreate).not.toHaveBeenCalled();
    expect(createManyUserCosmetic).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
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

  it('a ledger 400 decline stays a refusal and frees the key', async () => {
    spend.mockRejectedValue(ledgerError(400, 'BAD_REQUEST'));

    await expect(buy(KEY)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(stateUnknownLogged()).toBe(false);
    expect(refund).not.toHaveBeenCalled();
    expect(claims.rows.has(TX)).toBe(false);
  });

  it('a decline after another request resumed the claim keeps it for that request', async () => {
    spend.mockImplementation(async () => {
      claims.rows.get(TX)!.attempts = 2;
      throw ledgerError(400, 'BAD_REQUEST');
    });

    await expect(buy(KEY)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(claims.rows.get(TX)?.status).toBe('pending');
  });

  it('another attempt settled the claim before this one could refund: no refund', async () => {
    spend.mockResolvedValue(legs(false));
    purchaseCreate.mockRejectedValue(new Error('db down'));
    dbMock.dbWrite.cosmeticShopPurchaseClaim.updateMany.mockImplementation((async (
      args: Parameters<typeof claims.delegate.updateMany>[0]
    ) => {
      claims.rows.get(TX)!.status = 'paid';
      return claims.delegate.updateMany(args);
    }) as never);

    await expect(buy(KEY)).rejects.toThrow('This purchase has already been completed');
    expect(refund).not.toHaveBeenCalled();
  });

  it('a decline on a resumed claim keeps it: the earlier attempt may have charged', async () => {
    seedClaim('pending');
    spend.mockRejectedValue(ledgerError(400, 'BAD_REQUEST'));

    await expect(buy(KEY)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(claims.rows.get(TX)?.status).toBe('pending');
  });

  it('a charge whose outcome is unknown leaves the claim pending for a retry', async () => {
    spend.mockRejectedValue(ledgerError(503, 'INTERNAL_SERVER_ERROR'));

    await expect(buy(KEY)).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(claims.rows.get(TX)?.status).toBe('pending');
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

  it('a refund is sent once, resent by the client only when the connection never opened', async () => {
    spend.mockResolvedValue(legs(false));
    purchaseCreate.mockRejectedValue(new Error('db down'));

    await expect(buy(KEY)).rejects.toThrow('Failed to purchase pack');
    expect(refund).toHaveBeenCalledTimes(1);
    expect(claims.rows.get(TX)?.status).toBe('refunded');
    const opts = refund.mock.calls[0][1] as {
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
      spend.mockResolvedValue(legs(false));
      purchaseCreate.mockRejectedValue(new Error('db down'));
      settle(refund);

      await expectStateUnknown(buy(KEY));
      expect(refund).toHaveBeenCalledTimes(1);
      expect(stateUnknownLogs()).toHaveLength(1);
      // Never back to pending: a retry would read the reversed legs as its own.
      expect(claims.rows.get(TX)?.status).toBe('refunding');
    });
  }

  it('the claim is refunding before the refund is sent', async () => {
    spend.mockResolvedValue(legs(false));
    purchaseCreate.mockRejectedValue(new Error('db down'));
    refund.mockImplementation(async () => {
      expect(claims.rows.get(TX)?.status).toBe('refunding');
      return { totalRefunded: PRICE };
    });

    await expect(buy(KEY)).rejects.toThrow('Failed to purchase pack');
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it('without a key, still charges under a fresh random id (control)', async () => {
    spend.mockResolvedValue(legs(false));

    await buy();

    const prefix = spend.mock.calls[0][0].externalTransactionIdPrefix as string;
    expect(prefix).toMatch(new RegExp(String.raw`^cosmetic-pack-v2-${BUYER}-7001-[0-9a-f-]{36}$`));
    expect(claims.rows.get(prefix)?.status).toBe('paid');
  });
});
