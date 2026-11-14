import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as PrefixRefund from '~/server/services/buzz-prefix-refund';
import type * as UserPreferences from '~/server/services/user-preferences.service';
import type * as Caches from '~/server/redis/caches';
import { createFakeBuzzLedger } from './buzz-ledger.fake';
import { settle } from './charge-lock.fake';

/**
 * A sticker top-up whose charge or grant ends with an unknown outcome must charge once and grant
 * once across the buyer's retries under one key, and say "may have gone through" whenever it
 * cannot tell. The grant is one upsert onto a single row, so what stops a second grant is a Redis
 * claim per charge; with Redis unreachable nothing is granted (fail closed).
 */

const { buzz, prefixRefund, getBlockedPairIds, refreshOwnedStickerCache } = vi.hoisted(() => ({
  buzz: {
    createMultiAccountBuzzTransaction: vi.fn(),
    refundMultiAccountTransaction: vi.fn(),
    getMultiAccountTransactionsByPrefix: vi.fn(),
    getTransactionByExternalId: vi.fn(),
    createBuzzTransaction: vi.fn(),
  },
  prefixRefund: { getPrefixRefundState: vi.fn() },
  getBlockedPairIds: vi.fn(),
  refreshOwnedStickerCache: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  ...buzz,
}));
vi.mock('~/server/services/buzz-prefix-refund', async (importOriginal) => ({
  ...(await importOriginal<typeof PrefixRefund>()),
  ...prefixRefund,
}));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  getBlockedPairIds,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  refreshOwnedStickerCache,
}));

import { dbMock, redisMock } from '~/__tests__/mocks';

const { purchaseStickerUses } = await import('~/server/services/sticker.service');

// Literal: the user-facing contract.
const PAYMENT_OUTCOME_UNKNOWN_MESSAGE =
  "We couldn't confirm whether your Buzz payment went through. Trying this same action again from this page is safe. If you reloaded or left the page, check your Buzz balance and transactions first.";
const PAYMENT_REFUNDED_MESSAGE = 'The payment for this attempt was refunded. Please try again.';
// Distinct ids and amounts, so no assertion can read one for another.
const BUYER = 7;
const CREATOR = 99;
const COSMETIC_ID = 12;
const PRICE_PER_USE = 25;
const QUANTITY = 10;
const AMOUNT = PRICE_PER_USE * QUANTITY;
const KEY = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER_KEY = '0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b';
const PREFIX = `sticker-topup-k-${BUYER}-${COSMETIC_ID}-${KEY}`;
const CLAIM = `sticker-topup-grant:${PREFIX}`;

let ledger: ReturnType<typeof createFakeBuzzLedger>;
let redis: Map<string, string>;
let redisDown: boolean;
let grants: number;
let topUpRow: number;

const buy = (idempotencyKey?: string) =>
  purchaseStickerUses({
    userId: BUYER,
    cosmeticId: COSMETIC_ID,
    quantity: QUANTITY,
    stickersEnabled: true,
    idempotencyKey,
  } as Parameters<typeof purchaseStickerUses>[0]);

/** The buyer's charges: the creator's payouts come from the bank (account 0). */
const buyerCharges = () => ledger.charges().filter((c) => c.fromAccountId === BUYER);
const payouts = () => ledger.charges().filter((c) => c.fromAccountId === 0);

beforeEach(() => {
  vi.clearAllMocks();
  getBlockedPairIds.mockResolvedValue([]);
  refreshOwnedStickerCache.mockResolvedValue(undefined);
  dbMock.dbWrite.cosmetic.findUnique.mockResolvedValue({
    id: COSMETIC_ID,
    name: 'party cat',
    type: 'Sticker',
    createdById: CREATOR,
    data: { slug: 'party_cat', url: 'img', uses: 100, pricePerUse: PRICE_PER_USE },
  } as never);
  dbMock.dbWrite.cosmeticShopItem.findFirst.mockResolvedValue({
    id: 3,
    cosmeticId: COSMETIC_ID,
    meta: {},
    addedById: CREATOR,
  } as never);
  dbMock.dbWrite.userCosmetic.findMany.mockImplementation((async () => [
    { remaining: topUpRow },
  ]) as never);

  grants = 0;
  topUpRow = 0;
  // The grant: the one upsert onto the buyer's top-up row.
  dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) => {
    if (!strings.join('').includes('INSERT INTO "UserCosmetic"')) return [];
    grants++;
    topUpRow += QUANTITY;
    return [{ remaining: topUpRow }];
  }) as never);

  // A Redis with SET NX/EX, GET and the delete-if-value script; `redisDown` fails every call.
  redis = new Map();
  redisDown = false;
  const down = () => {
    if (redisDown) throw new Error('redis unavailable');
  };
  redisMock.sysRedis.set.mockImplementation((async (
    key: string,
    value: string,
    opts?: { NX?: boolean }
  ) => {
    down();
    if (opts?.NX && redis.has(key)) return null;
    redis.set(key, value);
    return 'OK';
  }) as never);
  redisMock.sysRedis.get.mockImplementation((async (key: string) => {
    down();
    return redis.get(key) ?? null;
  }) as never);
  redisMock.sysRedis.eval.mockImplementation((async (
    _script: string,
    { keys, arguments: args }: { keys: string[]; arguments: string[] }
  ) => {
    down();
    if (redis.get(keys[0]) !== args[0]) return 0;
    redis.delete(keys[0]);
    return 1;
  }) as never);

  for (const fn of [...Object.values(buzz), ...Object.values(prefixRefund)]) fn.mockReset();
  ledger = createFakeBuzzLedger();
  buzz.createMultiAccountBuzzTransaction.mockImplementation(async (input) => {
    const result = await ledger.createMultiAccountBuzzTransaction(input);
    return { ...result, transactionCount: result.transactionIds.length };
  });
  buzz.refundMultiAccountTransaction.mockImplementation(ledger.refundMultiAccountTransaction);
  buzz.getMultiAccountTransactionsByPrefix.mockImplementation(
    ledger.getMultiAccountTransactionsByPrefix
  );
  buzz.getTransactionByExternalId.mockImplementation(ledger.getTransactionByExternalId);
  buzz.createBuzzTransaction.mockImplementation(ledger.createBuzzTransaction);
  prefixRefund.getPrefixRefundState.mockImplementation(ledger.getPrefixRefundState);
});

describe('a keyed sticker top-up across an unknown outcome', () => {
  it('a retry with the same key after an unanswered charge charges once and grants once', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await expect(buy(KEY)).rejects.toMatchObject({ message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE });
    ledger.clearFaults();
    expect(grants).toBe(0);

    const result = await buy(KEY);

    expect(buyerCharges()).toHaveLength(1);
    expect(buyerCharges()[0].amount).toBe(AMOUNT);
    expect(grants).toBe(1);
    expect(result).toMatchObject({ quantity: QUANTITY, amount: AMOUNT, remaining: QUANTITY });
  });

  it('a retry after the grant committed (response lost) answers success and grants nothing more', async () => {
    await buy(KEY);

    const again = await buy(KEY);

    expect(buyerCharges()).toHaveLength(1);
    expect(grants).toBe(1);
    expect(again).toMatchObject({ quantity: QUANTITY, amount: AMOUNT, remaining: QUANTITY });
    // The creator is paid by the request that granted, once, under ids outside the charge's
    // prefix (which the ledger lists and refunds by `startsWith`).
    expect(payouts().map((p) => p.externalTransactionId)).toEqual([
      `sticker-topup-payout-k-${BUYER}-${COSMETIC_ID}-${KEY}:sell:${CREATOR}:yellow`,
    ]);
  });

  it('answers "may have gone through" when the resend also fails, and grants nothing', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('fail-before-commit');

    const error = await buy(KEY).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect((error as Error).message).toBe(PAYMENT_OUTCOME_UNKNOWN_MESSAGE);
    expect(grants).toBe(0);
    expect(ledger.refunds()).toHaveLength(0);
    expect(redis.size).toBe(0);
  });

  it('two requests with one key in flight: one charge, one grant', async () => {
    ledger.queueFault('hang');
    const first = buy(KEY);
    while (!ledger.isHung()) await settle();
    const second = buy(KEY);
    await second;
    ledger.releaseHung();
    await first;

    expect(buyerCharges()).toHaveLength(1);
    expect(grants).toBe(1);
    expect(payouts()).toHaveLength(1);
  });

  it('files the charge under the buyer, the sticker and the key, and claims it in Redis for at least a day', async () => {
    await buy(KEY);

    expect(buyerCharges().map((c) => c.externalTransactionId)).toEqual([`${PREFIX}-0`]);
    const claim = redisMock.sysRedis.set.mock.calls.find(([key]) => key === CLAIM);
    expect(claim?.[2]).toMatchObject({ NX: true });
    expect((claim?.[2] as { EX: number }).EX).toBeGreaterThanOrEqual(24 * 60 * 60);
    expect(redis.get(CLAIM)).toBe('granted');
  });

  it('a new top-up (a new key) charges and grants again', async () => {
    await buy(KEY);
    await buy(OTHER_KEY);

    expect(buyerCharges()).toHaveLength(2);
    expect(grants).toBe(2);
  });

  it('a claim held by a request that has not marked it granted is "may have gone through", no second grant', async () => {
    redis.set(CLAIM, 'another-request-token');

    await expect(buy(KEY)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE,
    });
    expect(grants).toBe(0);
    expect(ledger.refunds()).toHaveLength(0);
  });
});

describe('a keyed sticker top-up with Redis unreachable', () => {
  it('fails closed: charged, nothing granted, "may have gone through"; a later retry grants once', async () => {
    redisDown = true;

    await expect(buy(KEY)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE,
    });
    expect(grants).toBe(0);
    expect(ledger.refunds()).toHaveLength(0);

    redisDown = false;
    await buy(KEY);

    expect(buyerCharges()).toHaveLength(1);
    expect(grants).toBe(1);
  });

  it('a claim that cannot be read after another request took it is "may have gone through"', async () => {
    redis.set(CLAIM, 'granted');
    redisMock.sysRedis.get.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(buy(KEY)).rejects.toMatchObject({ message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE });
    expect(grants).toBe(0);
  });
});

describe('a keyed sticker top-up whose grant fails after the claim', () => {
  // Claim, then grant: the grant failed with the claim held, so the charge is refunded, the claim
  // released, and the retry is refused as refunded (the client starts a new top-up).
  it('refunds the charge, releases the claim, and refuses the retry as refunded', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('write failed'));

    await expect(buy(KEY)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Failed to buy sticker uses',
    });
    expect(ledger.refunds()).toHaveLength(1);
    expect(redis.has(CLAIM)).toBe(false);

    await expect(buy(KEY)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: PAYMENT_REFUNDED_MESSAGE,
    });
    expect(grants).toBe(0);
    expect(buyerCharges()).toHaveLength(1);
  });

  // The refund failed too: the charge is held and unrefunded, so the claim is released and the
  // retry under the key grants on it (once).
  it('a refund that fails too is "may have gone through", and the retry completes the grant once', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('write failed'));
    buzz.refundMultiAccountTransaction.mockRejectedValue(new Error('buzz down'));

    await expect(buy(KEY)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE,
    });
    expect(ledger.refunds()).toHaveLength(0);
    expect(redis.has(CLAIM)).toBe(false);

    await buy(KEY);

    expect(buyerCharges()).toHaveLength(1);
    expect(grants).toBe(1);
  });

  // Grant, then mark: the grant committed and marking the claim failed. This request answers
  // success; the claim keeps its token, so a retry is "may have gone through", never a second grant.
  it('a claim that cannot be marked granted after the grant: success now, and no second grant on retry', async () => {
    const set = redisMock.sysRedis.set.getMockImplementation()!;
    redisMock.sysRedis.set.mockImplementation((async (...args: Parameters<typeof set>) => {
      if (args[1] === 'granted') throw new Error('redis unavailable');
      return set(...args);
    }) as never);

    await expect(buy(KEY)).resolves.toMatchObject({ quantity: QUANTITY, remaining: QUANTITY });
    expect(grants).toBe(1);
    expect(redis.get(CLAIM)).not.toBe('granted');

    await expect(buy(KEY)).rejects.toMatchObject({ message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE });
    expect(grants).toBe(1);
    expect(buyerCharges()).toHaveLength(1);
  });
});

describe('a sticker top-up without a key', () => {
  it('is charged under a new prefix per call and takes no Redis claim, as before', async () => {
    await buy();
    await buy();

    const ids = buyerCharges().map((c) => c.externalTransactionId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids)
      expect(id).toMatch(new RegExp(`^sticker-topup-${BUYER}-${COSMETIC_ID}-[0-9a-f-]{36}-0$`));
    expect(grants).toBe(2);
    expect(buzz.getMultiAccountTransactionsByPrefix).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.set).not.toHaveBeenCalled();
  });
});
