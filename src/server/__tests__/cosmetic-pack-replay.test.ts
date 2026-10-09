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
const ledgerLegs = vi.fn();
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
  getMultiAccountTransactionsByPrefix: (...a: unknown[]) => ledgerLegs(...a),
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getBlockedPairIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('~/server/redis/caches', () => ({ refreshOwnedStickerCache: vi.fn() }));

const { purchaseCosmeticPack } = await import('~/server/services/cosmetic-pack.service');
const { computePackAmountDue } = await import('~/server/schema/creator-shop.schema');
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

const buy = (
  idempotencyKey?: string,
  {
    expectedAmount,
    members = [member],
    memberCount = members.length,
    payWith,
    start,
  }: {
    expectedAmount?: number;
    members?: (typeof member)[];
    memberCount?: number;
    payWith?: 'default' | 'blue-first';
    start?: Parameters<typeof purchaseCosmeticPack>[0]['start'];
  } = {}
) =>
  purchaseCosmeticPack({
    userId: BUYER,
    idempotencyKey,
    expectedAmount,
    payWith,
    start,
    shopItem: {
      id: 7001,
      title: 'A pack',
      unitAmount: PRICE,
      addedById: PACK_CREATOR,
      meta: { purchases: 0 },
      memberCount,
    },
    members,
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
      ledgerLegs,
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
    // A seeded pending claim stands for an earlier attempt that charged, unless
    // a test says the ledger has nothing under it.
    ledgerLegs.mockResolvedValue([{ transactionId: 'earlier', amount: PRICE }]);
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

  it('a decline after another request resumed the claim keeps it for that request, as unknown', async () => {
    spend.mockImplementation(async () => {
      claims.rows.get(TX)!.attempts = 2;
      throw ledgerError(400, 'BAD_REQUEST');
    });

    await expectStateUnknown(buy(KEY));
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

  it('a decline on a resumed claim keeps it, as unknown: the earlier attempt may have charged', async () => {
    seedClaim('pending');
    spend.mockRejectedValue(ledgerError(400, 'BAD_REQUEST'));

    await expectStateUnknown(buy(KEY));
    expect(claims.rows.get(TX)).toMatchObject({ status: 'pending', attempts: 2 });
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

  it('a refund names the claim it reverses', async () => {
    spend.mockResolvedValue(legs(false));
    purchaseCreate.mockRejectedValue(new Error('db down'));

    await expect(buy(KEY)).rejects.toThrow('Failed to purchase pack');
    expect(refund.mock.calls[0][0].details).toEqual({ claim: TX });
  });

  // The amount due the buyer confirmed, checked atomically with the claim: a
  // request either checks it and then writes the claim at that amount, or meets
  // a claim already written and checks it against that claim's amount.
  describe('the amount the buyer confirmed', () => {
    it('a stale amount is refused before anything is claimed or charged', async () => {
      await expect(buy(KEY, { expectedAmount: PRICE - 1 })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: `The price changed to ${PRICE} Buzz. Check the new price and try again.`,
      });
      // The insert itself, not only the table afterwards.
      expect(dbMock.dbWrite.cosmeticShopPurchaseClaim.create).not.toHaveBeenCalled();
      expect(claims.rows.size).toBe(0);
      expect(spend).not.toHaveBeenCalled();
    });

    it('the current amount is claimed and charged (control)', async () => {
      spend.mockResolvedValue(legs(false));

      await buy(KEY, { expectedAmount: PRICE });
      expect(dbMock.dbWrite.cosmeticShopPurchaseClaim.create).toHaveBeenCalledTimes(1);
      expect(spend.mock.calls[0][0].amount).toBe(PRICE);
    });

    // Two requests with one key, the other inserting its claim between this
    // one's lookup and its insert.
    const claimedConcurrentlyAt = (amount: number) =>
      dbMock.dbWrite.cosmeticShopPurchaseClaim.create.mockImplementationOnce((async (
        args: Parameters<typeof claims.delegate.create>[0]
      ) => {
        seedClaim('pending', { amount });
        return claims.delegate.create(args);
      }) as never);

    it('a concurrent claim at an amount this buyer did not confirm is unknown, and not charged', async () => {
      claimedConcurrentlyAt(PRICE - 500);

      await expectStateUnknown(buy(KEY, { expectedAmount: PRICE }));
      expect(dbMock.dbWrite.cosmeticShopPurchaseClaim.create).toHaveBeenCalledTimes(1);
      expect(spend).not.toHaveBeenCalled();
      expect(claims.rows.get(TX)).toMatchObject({ amount: PRICE - 500, attempts: 1 });
    });

    it('a concurrent claim at the confirmed amount is resumed (control)', async () => {
      claimedConcurrentlyAt(PRICE);
      spend.mockResolvedValue(legs(false));

      await buy(KEY, { expectedAmount: PRICE });
      expect(spend.mock.calls[0][0].amount).toBe(PRICE);
      expect(claims.rows.get(TX)).toMatchObject({ status: 'paid', attempts: 2 });
    });

    it('a retry confirming an amount other than its claim is unknown, and not charged', async () => {
      seedClaim('pending', { amount: PRICE - 500 });

      await expectStateUnknown(buy(KEY, { expectedAmount: PRICE }));
      expect(spend).not.toHaveBeenCalled();
      // Not counted as an attempt: it charged nothing.
      expect(claims.rows.get(TX)?.attempts).toBe(1);
      expect(stateUnknownLogs()).toEqual([
        expect.objectContaining({ reason: 'expected amount differs from the claim' }),
      ]);
    });

    // The amount due, not the pack's list price: owning a member discounts it.
    describe('when the buyer already owns a member', () => {
      const second = { ...member, cosmeticId: 1002, listingId: 5002 };
      const owningFirst = () =>
        dbMock.dbWrite.userCosmetic.findMany.mockResolvedValue([{ cosmeticId: member.cosmeticId }]);
      const { amountDue } = computePackAmountDue({
        packPrice: PRICE,
        members: [member, second].map((m) => ({
          cosmeticId: m.cosmeticId,
          type: m.type,
          listPrice: m.floorAmount,
          isOwn: m.createdById === PACK_CREATOR,
          createdById: m.createdById,
        })),
        ownedCosmeticIds: [member.cosmeticId],
        buyerId: BUYER,
        packCreatorId: PACK_CREATOR,
      });

      it('the fixture discounts (guard)', () => {
        expect(amountDue).toBeGreaterThan(0);
        expect(amountDue).toBeLessThan(PRICE);
      });

      it('the discounted amount confirmed is claimed and charged', async () => {
        owningFirst();
        spend.mockResolvedValue(legs(false, amountDue));

        await buy(KEY, { expectedAmount: amountDue, members: [member, second] });
        expect(claims.rows.get(TX)?.amount).toBe(amountDue);
        expect(spend.mock.calls[0][0].amount).toBe(amountDue);
      });

      it('the list price confirmed is refused before anything is claimed', async () => {
        owningFirst();

        await expect(
          buy(KEY, { expectedAmount: PRICE, members: [member, second] })
        ).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: `The price changed to ${amountDue} Buzz. Check the new price and try again.`,
        });
        expect(dbMock.dbWrite.cosmeticShopPurchaseClaim.create).not.toHaveBeenCalled();
        expect(spend).not.toHaveBeenCalled();
      });
    });
  });

  // A pending claim nothing was charged under (two requests with one key both
  // declined) vouches for nothing: it is held to today's state.
  describe('a pending claim nothing was charged under', () => {
    beforeEach(() => ledgerLegs.mockResolvedValue([]));

    for (const [what, opts] of [
      ['after a member sold out', { members: [{ ...member, availableQuantity: 1, soldCount: 1 }] }],
      [
        'after a member’s sale window closed',
        { members: [{ ...member, availableTo: new Date('2020-01-01T00:00:00Z') }] },
      ],
    ] as const) {
      it(`is unknown ${what}, and not charged`, async () => {
        seedClaim('pending');

        await expectStateUnknown(buy(KEY, { expectedAmount: PRICE, ...opts }));
        expect(ledgerLegs).toHaveBeenCalledWith(TX);
        expect(spend).not.toHaveBeenCalled();
        expect(createManyUserCosmetic).not.toHaveBeenCalled();
        expect(claims.rows.get(TX)).toMatchObject({ status: 'pending', attempts: 1 });
      });
    }

    it('is unknown when the amount due moved from its amount, and not charged', async () => {
      seedClaim('pending', { amount: PRICE - 500 });

      await expectStateUnknown(buy(KEY, { expectedAmount: PRICE - 500 }));
      expect(spend).not.toHaveBeenCalled();
    });

    it('parked by two declined requests, is not redeemed after a member sells out', async () => {
      spend.mockImplementationOnce(async () => {
        claims.rows.get(TX)!.attempts = 2;
        throw ledgerError(400, 'BAD_REQUEST');
      });
      await expectStateUnknown(buy(KEY, { expectedAmount: PRICE }));
      expect(claims.rows.get(TX)?.status).toBe('pending');

      spend.mockClear();
      await expectStateUnknown(
        buy(KEY, {
          expectedAmount: PRICE,
          members: [{ ...member, availableQuantity: 1, soldCount: 1 }],
        })
      );
      expect(spend).not.toHaveBeenCalled();
      expect(createManyUserCosmetic).not.toHaveBeenCalled();
    });

    // Another request with this key still in flight: nothing has landed yet and
    // nothing has changed, so it resumes.
    it('resumes when nothing changed (a concurrent request still in flight)', async () => {
      seedClaim('pending');
      spend.mockResolvedValue(legs(false));

      await buy(KEY, { expectedAmount: PRICE });
      expect(spend.mock.calls[0][0].amount).toBe(PRICE);
      expect(claims.rows.get(TX)).toMatchObject({ status: 'paid', attempts: 2 });
    });
  });

  it('a retry whose ledger read fails is unknown, and not charged', async () => {
    seedClaim('pending');
    ledgerLegs.mockRejectedValue(new Error('ledger down'));

    await expectStateUnknown(buy(KEY));
    expect(spend).not.toHaveBeenCalled();
    expect(stateUnknownLogs()).toEqual([
      expect.objectContaining({ reason: 'ledger read failed on resume' }),
    ]);
  });

  it('a claim the caller already read is not read again', async () => {
    seedClaim('pending');
    spend.mockResolvedValue(legs(true));

    await buy(KEY, {
      start: {
        transactionId: TX,
        existingClaim: claims.rows.get(TX)!,
        pendingClaim: { userId: BUYER, shopItemId: 7001, transactionId: TX, amount: PRICE },
        chargedBefore: true,
      },
    });
    expect(dbMock.dbWrite.cosmeticShopPurchaseClaim.findUnique).not.toHaveBeenCalled();
    expect(ledgerLegs).not.toHaveBeenCalled();
    expect(claims.rows.get(TX)?.status).toBe('paid');
  });

  it('a late decline after another attempt granted the claim is answered as completed', async () => {
    spend.mockImplementation(async () => {
      claims.rows.get(TX)!.status = 'paid';
      throw ledgerError(400, 'BAD_REQUEST');
    });

    await expect(buy(KEY)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This purchase has already been completed',
    });
  });

  // Each check that still applies on a retry answers state unknown while a
  // claim is pending, and refuses a new purchase outright.
  for (const [what, opts, refusal] of [
    [
      'Blue Buzz a member vetoes',
      {
        payWith: 'blue-first' as const,
        members: [{ ...member, listingMeta: { purchases: 0, acceptsBlueBuzz: false } }],
      },
      'This pack does not accept Blue Buzz',
    ],
    [
      'nothing but the buyer’s own work',
      { members: [{ ...member, createdById: BUYER }] },
      "Everything in this pack is your own work, so there's nothing here for you to buy",
    ],
  ] as const) {
    it(`${what}: unknown on a retry, not charged`, async () => {
      seedClaim('pending');

      await expectStateUnknown(buy(KEY, opts));
      expect(spend).not.toHaveBeenCalled();
      expect(stateUnknownLogs()).toEqual([
        expect.objectContaining({ reason: 'refused while a claim is pending' }),
      ]);
    });

    it(`${what}: refused as a new purchase (control)`, async () => {
      await expect(buy(KEY, opts)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: refusal });
    });
  }

  describe('a retry is answered from its claim before the purchase checks', () => {
    const past = new Date('2020-01-01T00:00:00Z');
    for (const [what, changed, refusal] of [
      [
        'a member’s sale window closed',
        { ...member, availableTo: past },
        'This pack contains an item that is no longer available',
      ],
      [
        'a member sold out',
        { ...member, availableQuantity: 1, soldCount: 1 },
        'This pack contains an item that is sold out',
      ],
    ] as const) {
      it(`resumes a pending claim after ${what}, at the claimed amount`, async () => {
        seedClaim('pending', { amount: PRICE - 500 });
        spend.mockResolvedValue(legs(false, PRICE - 500));

        await buy(KEY, { expectedAmount: PRICE - 500, members: [changed] });
        expect(spend.mock.calls[0][0].amount).toBe(PRICE - 500);
        expect(claims.rows.get(TX)?.status).toBe('paid');
      });

      it(`refuses a new purchase after ${what}, claiming nothing (control)`, async () => {
        await expect(buy(KEY, { members: [changed] })).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: refusal,
        });
        expect(dbMock.dbWrite.cosmeticShopPurchaseClaim.create).not.toHaveBeenCalled();
      });
    }

    it('a paid claim of a pack whose member sold out is answered as completed', async () => {
      seedClaim('paid');

      await expect(
        buy(KEY, { members: [{ ...member, availableQuantity: 1, soldCount: 1 }] })
      ).rejects.toThrow('This purchase has already been completed');
    });

    it('a paid claim of a pack since missing a member is answered as completed, not unknown', async () => {
      seedClaim('paid');

      await expect(buy(KEY, { memberCount: 2 })).rejects.toThrow(
        'This purchase has already been completed'
      );
      expect(stateUnknownLogged()).toBe(false);
    });

    // A member missing from the pack still wins, but a 4xx would have the client
    // drop the key that finds a charge the earlier attempt may have made.
    it('a refusal of a retry with a pending claim is unknown, and not charged', async () => {
      seedClaim('pending');

      await expectStateUnknown(buy(KEY, { memberCount: 2 }));
      expect(spend).not.toHaveBeenCalled();
      expect(claims.rows.get(TX)).toMatchObject({ status: 'pending', attempts: 1 });
    });

    it('the same refusal of a new purchase is a plain refusal (control)', async () => {
      await expect(buy(KEY, { memberCount: 2 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(stateUnknownLogged()).toBe(false);
    });

    // Resuming could charge again for what a different purchase already granted,
    // so that claim is settled by hand.
    it('a retry when the buyer now owns everything in the pack is unknown, and not charged', async () => {
      seedClaim('pending');
      dbMock.dbWrite.userCosmetic.findMany.mockResolvedValue([{ cosmeticId: member.cosmeticId }]);

      await expectStateUnknown(buy(KEY));
      expect(spend).not.toHaveBeenCalled();
      expect(stateUnknownLogs()).toEqual([
        expect.objectContaining({ reason: 'refused while a claim is pending' }),
      ]);
    });

    it('a new purchase when the buyer owns everything is a plain refusal (control)', async () => {
      dbMock.dbWrite.userCosmetic.findMany.mockResolvedValue([{ cosmeticId: member.cosmeticId }]);

      await expect(buy(KEY)).rejects.toThrow('You already own everything in this pack');
    });
  });

  it('without a key, still charges under a fresh random id (control)', async () => {
    spend.mockResolvedValue(legs(false));

    await buy();

    const prefix = spend.mock.calls[0][0].externalTransactionIdPrefix as string;
    expect(prefix).toMatch(new RegExp(String.raw`^cosmetic-pack-v2-${BUYER}-7001-[0-9a-f-]{36}$`));
    expect(claims.rows.get(prefix)?.status).toBe('paid');
  });
});
