import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BuzzApiError } from '@civitai/buzz';

import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BuzzService from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { BLOCK_GOOD_MAX_PRICE_BUZZ } from '~/shared/constants/block-goods.constants';

/**
 * App Blocks DIGITAL GOODS — the purchase / entitlement / refund rail.
 *
 * 🔴 WHAT KIND OF COVERAGE THIS IS. Everything here is a BEHAVIOUR SPEC for new
 * code or an INVARIANT GUARD; none of it is regression coverage, because there
 * is no prior behaviour to regress — the module did not exist. Where a test
 * pins something that would otherwise be easy to get wrong later (the FIN-1
 * server-derivation, the recorded-payout reversal, the conservation of the
 * split) it says so on the test.
 *
 * `buzz.service` is spread from the original and only the four money calls are
 * replaced, so a rename in that module fails loudly here instead of silently
 * widening the mock.
 */

type CreateMultiResult = {
  transactionIds: { transactionId: string; accountType: string; amount: number }[];
  totalAmount: number;
  transactionCount: number;
};
type CreateSingleResult = { transactionId: string; remainingBalance: number | null };
type RefundMultiResult = {
  refundedTransactions: {
    originalTransactionId: string;
    refundTransactionId: string;
    accountType: string;
    amount: number;
    originalExternalTransactionId: string;
  }[];
  totalRefunded: number;
  externalTransactionIdPrefix: string;
};

const { mockCreateMulti, mockCreateSingle, mockRefundMulti, mockRefundTransaction } = vi.hoisted(
  () => ({
    // `vi.fn<T>()` rather than named-but-unused parameters: the ARGUMENT TYPES are
    // what make `mock.calls[i][0]` indexable, and naming them only to ignore them
    // trips the unused-vars rule.
    mockCreateMulti: vi.fn<(input: Record<string, unknown>) => Promise<CreateMultiResult>>(
      async () => ({
        transactionIds: [{ transactionId: 'buy-y', accountType: 'yellow', amount: 1000 }],
        totalAmount: 1000,
        transactionCount: 1,
      })
    ),
    mockCreateSingle: vi.fn<(input: Record<string, unknown>) => Promise<CreateSingleResult>>(
      async () => ({ transactionId: 'pay-1', remainingBalance: null as number | null })
    ),
    mockRefundMulti: vi.fn<(input: Record<string, unknown>) => Promise<RefundMultiResult>>(
      async () => ({
        refundedTransactions: [
          {
            originalTransactionId: 'buy-y',
            refundTransactionId: 'ref-1',
            accountType: 'yellow',
            amount: 1000,
            originalExternalTransactionId: 'x',
          },
        ],
        totalRefunded: 1000,
        externalTransactionIdPrefix: 'x',
      })
    ),
    mockRefundTransaction: vi.fn<
      (transactionId: string, description?: string) => Promise<{ ok: boolean }>
    >(async () => ({ ok: true })),
  })
);

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createMultiAccountBuzzTransaction: mockCreateMulti,
  createBuzzTransaction: mockCreateSingle,
  refundMultiAccountTransaction: mockRefundMulti,
  refundTransaction: mockRefundTransaction,
}));

import {
  blockGoodPurchaseKey,
  listBlockGoodEntitlements,
  purchaseBlockGood,
  readRecordedPayouts,
  refundBlockGoodPurchase,
  resolveBlockGoodForPurchase,
  type ResolvedBlockGood,
} from '~/server/services/blocks/block-goods.service';

const BUYER = 42;
const OWNER = 77;
const APP_BLOCK_ID = 'apb_TESTBLOCK';
const APP_ID = 'appblk-test';
const GOOD_ID = 'extra-slots';
const PRICE = 1000;

const GOOD = {
  id: GOOD_ID,
  title: 'Extra slots',
  priceBuzz: PRICE,
  kind: 'good' as const,
  payload: { slots: 5 },
};

const RESOLVED: ResolvedBlockGood = {
  appId: APP_ID,
  appOwnerUserId: OWNER,
  manifestVersion: '1.4.0',
  good: GOOD,
};

function purchaseInput(overrides: Partial<Parameters<typeof purchaseBlockGood>[0]> = {}) {
  return {
    buyerUserId: BUYER,
    appBlockId: APP_BLOCK_ID,
    blockInstanceId: 'bki_1',
    goodId: GOOD_ID,
    resolved: RESOLVED,
    payWith: ['blue', 'yellow'] as const,
    ...overrides,
  } as Parameters<typeof purchaseBlockGood>[0];
}

/**
 * The happy-path DB shape: nothing owned, the claim insert succeeds, the settle
 * writes succeed.
 *
 * 🔴 The entitlement stub's payload is deliberately DISTINGUISHABLE from the
 * manifest declaration (`rowOnly: true`). With the two byte-identical, a mutant
 * that built the response entitlement from `resolved.good` instead of the
 * PERSISTED row would be invisible on both `kind` and `payload`.
 */
function stubCleanDb() {
  dbMock.dbRead.blockGoodEntitlement.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.blockGoodPurchase.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.blockGoodPurchase.create.mockResolvedValue({});
  dbMock.dbWrite.blockGoodPurchase.update.mockResolvedValue({});
  dbMock.dbWrite.blockGoodPurchase.deleteMany.mockResolvedValue({ count: 1 });
  dbMock.dbWrite.blockGoodEntitlement.upsert.mockResolvedValue({
    goodId: GOOD_ID,
    kind: 'good',
    payload: { slots: 5, rowOnly: true },
    grantedAt: new Date('2026-09-27T00:00:00.000Z'),
  });
}

/** A P2002 shaped the way `isUniqueViolation` detects it (by code, not class). */
function uniqueViolation() {
  return Object.assign(new Error('unique constraint'), { code: 'P2002' });
}

/**
 * The REAL error class the Buzz client throws, so `getBuzzApiStatus` can read a
 * status off it. A hand-rolled `{ status }` object would not be recognised, and
 * the test would then pass for the wrong reason — every case would look UNKNOWN.
 */
function buzzApiError(status: number, statusText: string) {
  return new BuzzApiError(status, statusText);
}

beforeEach(() => {
  vi.clearAllMocks();
  stubCleanDb();
});

describe('resolveBlockGoodForPurchase — FIN-1 server derivation', () => {
  it('derives app, OWNER, manifest version and PRICE from the AppBlock row', () => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({
      appId: APP_ID,
      status: 'approved',
      version: '1.4.0',
      manifest: { goods: [{ id: GOOD_ID, title: 'Extra slots', priceBuzz: PRICE }] },
      app: { userId: OWNER },
    });
    return expect(
      resolveBlockGoodForPurchase({ appBlockId: APP_BLOCK_ID, goodId: GOOD_ID })
    ).resolves.toEqual({
      appId: APP_ID,
      appOwnerUserId: OWNER,
      manifestVersion: '1.4.0',
      good: expect.objectContaining({ id: GOOD_ID, priceBuzz: PRICE }),
    });
  });

  it('refuses an app that is not APPROVED', async () => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({
      appId: APP_ID,
      status: 'pending',
      version: '1.4.0',
      manifest: { goods: [{ id: GOOD_ID, title: 'Extra slots', priceBuzz: PRICE }] },
      app: { userId: OWNER },
    });
    await expect(
      resolveBlockGoodForPurchase({ appBlockId: APP_BLOCK_ID, goodId: GOOD_ID })
    ).resolves.toBeNull();
  });

  it('refuses an app with no resolvable owner', async () => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({
      appId: APP_ID,
      status: 'approved',
      version: '1.4.0',
      manifest: { goods: [{ id: GOOD_ID, title: 'Extra slots', priceBuzz: PRICE }] },
      app: null,
    });
    await expect(
      resolveBlockGoodForPurchase({ appBlockId: APP_BLOCK_ID, goodId: GOOD_ID })
    ).resolves.toBeNull();
  });

  it('refuses a good the approved manifest does not declare', async () => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({
      appId: APP_ID,
      status: 'approved',
      version: '1.4.0',
      manifest: { goods: [{ id: 'something-else', title: 'Other', priceBuzz: 300 }] },
      app: { userId: OWNER },
    });
    await expect(
      resolveBlockGoodForPurchase({ appBlockId: APP_BLOCK_ID, goodId: GOOD_ID })
    ).resolves.toBeNull();
  });

  it('refuses a missing AppBlock row entirely', async () => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue(null);
    await expect(
      resolveBlockGoodForPurchase({ appBlockId: APP_BLOCK_ID, goodId: GOOD_ID })
    ).resolves.toBeNull();
  });
});

describe('blockGoodPurchaseKey — the ledger anchor', () => {
  it('is deterministic in (app, good, buyer) and carries nothing else', () => {
    // 🔴 THE PROPERTY THE WHOLE LEDGER-BACKED DEDUPE RESTS ON. If this string
    // ever gains a random or per-attempt component, a retry after the Redis
    // sentinel expires charges a second time.
    const a = blockGoodPurchaseKey({
      appBlockId: APP_BLOCK_ID,
      goodId: GOOD_ID,
      buyerUserId: BUYER,
    });
    const b = blockGoodPurchaseKey({
      appBlockId: APP_BLOCK_ID,
      goodId: GOOD_ID,
      buyerUserId: BUYER,
    });
    expect(a).toBe(b);
    expect(a).toBe(`block-good:${APP_BLOCK_ID}:${GOOD_ID}:${BUYER}`);
  });

  it('gives a RE-PURCHASE its own key, so a refunded good can be bought again', () => {
    // 🔴 THE DEFECT THIS EXISTS FOR. Without the supersedes segment the second
    // purchase of a refunded good derives the SAME key as the first, collides
    // on the Buzz ledger and on the UNIQUE `buzz_transaction_id`, and the
    // viewer is told the purchase is already complete — forever.
    const first = blockGoodPurchaseKey({
      appBlockId: APP_BLOCK_ID,
      goodId: GOOD_ID,
      buyerUserId: BUYER,
    });
    const second = blockGoodPurchaseKey({
      appBlockId: APP_BLOCK_ID,
      goodId: GOOD_ID,
      buyerUserId: BUYER,
      supersedesPurchaseId: 'bgp_FIRST',
    });
    expect(second).not.toBe(first);
    // …and it is still deterministic WITHIN that generation, which is what
    // keeps the ledger dedupe working for a retry of the re-purchase.
    expect(
      blockGoodPurchaseKey({
        appBlockId: APP_BLOCK_ID,
        goodId: GOOD_ID,
        buyerUserId: BUYER,
        supersedesPurchaseId: 'bgp_FIRST',
      })
    ).toBe(second);
    // A THIRD generation differs again.
    expect(
      blockGoodPurchaseKey({
        appBlockId: APP_BLOCK_ID,
        goodId: GOOD_ID,
        buyerUserId: BUYER,
        supersedesPurchaseId: 'bgp_SECOND',
      })
    ).not.toBe(second);
  });

  it('separates a different buyer, a different good and a different app', () => {
    const base = blockGoodPurchaseKey({
      appBlockId: APP_BLOCK_ID,
      goodId: GOOD_ID,
      buyerUserId: BUYER,
    });
    const variants = [
      blockGoodPurchaseKey({ appBlockId: APP_BLOCK_ID, goodId: GOOD_ID, buyerUserId: 43 }),
      blockGoodPurchaseKey({ appBlockId: APP_BLOCK_ID, goodId: 'other', buyerUserId: BUYER }),
      blockGoodPurchaseKey({ appBlockId: 'apb_OTHER', goodId: GOOD_ID, buyerUserId: BUYER }),
    ];
    expect(new Set([base, ...variants]).size).toBe(4);
  });
});

describe('purchaseBlockGood — the money path', () => {
  it('charges the buyer, grants the entitlement and pays the owner 70%', async () => {
    const result = await purchaseBlockGood(purchaseInput());
    expect(result.ok).toBe(true);

    // The DEBIT: the buyer, the server price, under the deterministic key.
    expect(mockCreateMulti).toHaveBeenCalledTimes(1);
    expect(mockCreateMulti).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAccountId: BUYER,
        toAccountId: 0,
        amount: PRICE,
        type: TransactionType.Purchase,
        externalTransactionIdPrefix: `block-good:${APP_BLOCK_ID}:${GOOD_ID}:${BUYER}`,
      })
    );

    // The CREDIT: the owner, 70% of 1000 = 700, as a Sell from the bank.
    expect(mockCreateSingle).toHaveBeenCalledTimes(1);
    expect(mockCreateSingle).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAccountId: 0,
        toAccountId: OWNER,
        amount: 700,
        type: TransactionType.Sell,
      })
    );

    // The LEDGER ROW carries the split, and the two shares sum to the price —
    // the same invariant the database CHECK enforces.
    const row = dbMock.dbWrite.blockGoodPurchase.create.mock.calls[0][0].data;
    expect(row.priceBuzz).toBe(PRICE);
    expect(row.appOwnerShareBuzz).toBe(700);
    expect(row.platformShareBuzz).toBe(300);
    expect(row.appOwnerShareBuzz + row.platformShareBuzz).toBe(row.priceBuzz);
    // 🔴 `payouts` is written EXPLICITLY as an empty ARRAY, not left to the
    // column default: the migration's `jsonb_typeof(payouts) = 'array'` CHECK
    // rejects a JSON string, and Prisma carries a `Json` field's default as a
    // string. Leaving it out makes every insert depend on how the client
    // applies that default.
    expect(row.payouts).toEqual([]);
    // 🔴 The UNIQUE column the whole claim-then-charge ordering rests on. Without
    // this, a mutant writing a fresh ULID here would leave the index no longer
    // holding the deterministic key — the claim would stop serialising attempts
    // and the pre-charge replay could never hit — with every other assertion
    // green, because the CHARGE's prefix is a different write.
    expect(row.buzzTransactionId).toBe(`block-good:${APP_BLOCK_ID}:${GOOD_ID}:${BUYER}`);
    // The row is CLAIMED, not born paid: `pending` until the charge settles.
    expect(row.status).toBe('pending');
    expect(row.bluePaidBuzz).toBe(0);

    // …and the SETTLE flips it, carrying the colour split the charge reported.
    expect(dbMock.dbWrite.blockGoodPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: row.id },
        data: { status: 'paid', bluePaidBuzz: 0 },
      })
    );

    // The returned entitlement comes from the PERSISTED row, not from the
    // manifest declaration — the stub's payload carries a marker the manifest
    // cannot produce, so the two sources are separable.
    expect((result as { entitlement: { payload: unknown } }).entitlement.payload).toEqual({
      slots: 5,
      rowOnly: true,
    });
  });

  it('CLAIMS the row before charging — the ordering the safety argument rests on', async () => {
    // 🔴 Invariant guard on the ORDER itself. With charge-then-claim, two
    // concurrent attempts both charge under the deterministic prefix and the
    // loser's prefix-wide rollback reverses the WINNER's charge. The insert
    // happening first is what makes the database serialise them instead.
    const order: string[] = [];
    dbMock.dbWrite.blockGoodPurchase.create.mockImplementation(async () => {
      order.push('claim');
      return {};
    });
    mockCreateMulti.mockImplementationOnce(async () => {
      order.push('charge');
      return {
        transactionIds: [{ transactionId: 'buy-y', accountType: 'yellow', amount: PRICE }],
        totalAmount: PRICE,
        transactionCount: 1,
      };
    });
    await purchaseBlockGood(purchaseInput());
    expect(order).toEqual(['claim', 'charge']);
  });

  it('records the OWNER resolved at write time, not a client value', async () => {
    await purchaseBlockGood(purchaseInput());
    const row = dbMock.dbWrite.blockGoodPurchase.create.mock.calls[0][0].data;
    expect(row.appOwnerUserId).toBe(OWNER);
    expect(row.userId).toBe(BUYER);
    expect(row.appId).toBe(APP_ID);
    expect(row.manifestVersion).toBe('1.4.0');
  });

  it('snapshots the MANIFEST payload and kind onto the entitlement', async () => {
    await purchaseBlockGood(purchaseInput());
    const upsert = dbMock.dbWrite.blockGoodEntitlement.upsert.mock.calls[0][0];
    expect(upsert.create.payload).toEqual({ slots: 5 });
    expect(upsert.create.kind).toBe('good');
    expect(upsert.where).toEqual({
      userId_appBlockId_goodId: { userId: BUYER, appBlockId: APP_BLOCK_ID, goodId: GOOD_ID },
    });
  });

  it('carries an app_unlock good through as an ORDINARY entitlement (nothing branches on it)', async () => {
    // D4 — the paid-app unlock is expressible today and inert today. This is an
    // INVARIANT GUARD on the data model, not coverage of any behaviour.
    dbMock.dbWrite.blockGoodEntitlement.upsert.mockResolvedValue({
      goodId: 'unlock',
      kind: 'app_unlock',
      payload: {},
      grantedAt: new Date('2026-09-27T00:00:00.000Z'),
    });
    const result = await purchaseBlockGood(
      purchaseInput({
        goodId: 'unlock',
        resolved: {
          ...RESOLVED,
          good: { ...GOOD, id: 'unlock', kind: 'app_unlock', payload: {} },
        },
      })
    );
    expect(result.ok).toBe(true);
    expect(dbMock.dbWrite.blockGoodEntitlement.upsert.mock.calls[0][0].create.kind).toBe(
      'app_unlock'
    );
    // The charge and payout are identical to any other good.
    expect(mockCreateSingle).toHaveBeenCalledWith(expect.objectContaining({ amount: 700 }));
  });

  it('splits the OWNER payout across colours in proportion to what the buyer paid in blue', async () => {
    mockCreateMulti.mockResolvedValueOnce({
      transactionIds: [
        { transactionId: 'buy-b', accountType: 'blue', amount: 400 },
        { transactionId: 'buy-y', accountType: 'yellow', amount: 600 },
      ],
      totalAmount: PRICE,
      transactionCount: 2,
    } as never);

    await purchaseBlockGood(purchaseInput());

    // owner share 700, blue leg floor(700*400/1000) = 280, yellow leg 420.
    expect(mockCreateSingle).toHaveBeenCalledTimes(2);
    const legs = mockCreateSingle.mock.calls.map((c) => {
      const arg = c[0] as { amount: number; toAccountType: string; externalTransactionId: string };
      return { amount: arg.amount, color: arg.toAccountType };
    });
    expect(legs).toEqual([
      { amount: 280, color: 'blue' },
      { amount: 420, color: 'yellow' },
    ]);
    expect(legs[0].amount + legs[1].amount).toBe(700);

    // The external ids differ per colour — a collision here would silently drop
    // one of the two legs as a duplicate.
    const ids = mockCreateSingle.mock.calls.map(
      (c) => (c[0] as { externalTransactionId: string }).externalTransactionId
    );
    expect(new Set(ids).size).toBe(2);

    // 🔴 `bluePaidBuzz` is the ONE figure that needs the charge's answer, so it is
    // written by the SETTLE, not by the claim — the claim row starts it at 0.
    expect(dbMock.dbWrite.blockGoodPurchase.create.mock.calls[0][0].data.bluePaidBuzz).toBe(0);
    expect(dbMock.dbWrite.blockGoodPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'paid', bluePaidBuzz: 400 } })
    );
  });

  it('RECORDS what was actually paid, per colour, with the ledger transaction id', async () => {
    mockCreateSingle
      .mockResolvedValueOnce({ transactionId: 'pay-blue', remainingBalance: null } as never)
      .mockResolvedValueOnce({ transactionId: 'pay-yellow', remainingBalance: null } as never);
    mockCreateMulti.mockResolvedValueOnce({
      transactionIds: [
        { transactionId: 'buy-b', accountType: 'blue', amount: 400 },
        { transactionId: 'buy-y', accountType: 'yellow', amount: 600 },
      ],
      totalAmount: PRICE,
      transactionCount: 2,
    } as never);

    await purchaseBlockGood(purchaseInput());

    expect(dbMock.dbWrite.blockGoodPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          payouts: [
            { userId: OWNER, amount: 280, color: 'blue', transactionId: 'pay-blue' },
            { userId: OWNER, amount: 420, color: 'yellow', transactionId: 'pay-yellow' },
          ],
        },
      })
    );
  });

  it('REFUSES a buyer who already owns the good, before any money moves', async () => {
    dbMock.dbRead.blockGoodEntitlement.findUnique.mockResolvedValue({
      goodId: GOOD_ID,
      kind: 'good',
      payload: {},
      grantedAt: new Date(),
      revokedAt: null,
    });
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 409, reason: 'already_owned' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.blockGoodPurchase.create).not.toHaveBeenCalled();
  });

  it('ALLOWS re-buying after a REVOKED entitlement, under a DIFFERENT ledger key', async () => {
    dbMock.dbRead.blockGoodEntitlement.findUnique.mockResolvedValue({
      goodId: GOOD_ID,
      kind: 'good',
      payload: {},
      grantedAt: new Date(),
      revokedAt: new Date('2026-09-20T00:00:00.000Z'),
      purchaseId: 'bgp_FIRST',
    });
    const result = await purchaseBlockGood(purchaseInput());
    expect(result.ok).toBe(true);

    // 🔴 The whole point: the re-purchase must NOT reuse the first purchase's
    // external id, or the Buzz ledger refuses the charge and the UNIQUE
    // `buzz_transaction_id` refuses the row. The looked-up id BEFORE the charge
    // must be the new key too, or the pre-charge replay check finds the
    // original row and 409s.
    const firstKey = `block-good:${APP_BLOCK_ID}:${GOOD_ID}:${BUYER}`;
    const chargeKey = (mockCreateMulti.mock.calls[0][0] as { externalTransactionIdPrefix: string })
      .externalTransactionIdPrefix;
    expect(chargeKey).not.toBe(firstKey);
    expect(chargeKey).toBe(`${firstKey}:after:bgp_FIRST`);
    expect(dbMock.dbWrite.blockGoodPurchase.create.mock.calls[0][0].data.buzzTransactionId).toBe(
      chargeKey
    );
  });

  it('uses the BASE key on a first purchase — the supersedes segment is not always on', () => {
    // Negative control for the case above: if the segment were appended
    // unconditionally, the assertion there would pass while every first
    // purchase carried a meaningless `:after:undefined` tail.
    return purchaseBlockGood(purchaseInput()).then(() => {
      expect(
        (mockCreateMulti.mock.calls[0][0] as { externalTransactionIdPrefix: string })
          .externalTransactionIdPrefix
      ).toBe(`block-good:${APP_BLOCK_ID}:${GOOD_ID}:${BUYER}`);
    });
  });

  it('does NOT re-key when the entitlement exists and is NOT revoked', async () => {
    // That case is refused as already-owned before any key is derived; this
    // pins that the re-key is driven by `revokedAt`, not by the row existing.
    dbMock.dbRead.blockGoodEntitlement.findUnique.mockResolvedValue({
      goodId: GOOD_ID,
      kind: 'good',
      payload: {},
      grantedAt: new Date(),
      revokedAt: null,
      purchaseId: 'bgp_FIRST',
    });
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, reason: 'already_owned' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
  });

  it('REFUSES the app owner buying their own good', async () => {
    const result = await purchaseBlockGood(purchaseInput({ buyerUserId: OWNER }));
    expect(result).toMatchObject({ ok: false, status: 400, reason: 'self_purchase' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
  });

  it('REFUSES when expectedPriceBuzz disagrees with the server price', async () => {
    const result = await purchaseBlockGood(purchaseInput({ expectedPriceBuzz: 999 }));
    expect(result).toMatchObject({ ok: false, status: 409, reason: 'price_changed' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
  });

  it('charges the SERVER price, never the client expectation, when they agree', async () => {
    // 🔴 FIN-1. `expectedPriceBuzz` may only cause a refusal; it can never be
    // the number charged. A mutant that passes it to the charge survives a test
    // that only ever sends a matching value, so the assertion names the SOURCE.
    await purchaseBlockGood(purchaseInput({ expectedPriceBuzz: PRICE }));
    expect(mockCreateMulti).toHaveBeenCalledWith(
      expect.objectContaining({ amount: RESOLVED.good.priceBuzz })
    );
  });

  it('REFUSES a good priced over the hard cap even if the manifest was approved with it', async () => {
    const result = await purchaseBlockGood(
      purchaseInput({
        resolved: { ...RESOLVED, good: { ...GOOD, priceBuzz: 10_000_000 } },
      })
    );
    expect(result).toMatchObject({ ok: false, status: 400, reason: 'price_over_cap' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
  });

  it('REFUSES as a duplicate when another attempt already SETTLED this purchase, without charging', async () => {
    dbMock.dbWrite.blockGoodPurchase.create.mockRejectedValueOnce(uniqueViolation());
    dbMock.dbWrite.blockGoodPurchase.findUnique.mockResolvedValue({ status: 'paid' });
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 409, reason: 'duplicate' });
    // 🔴 NOTHING is charged and — critically — NOTHING is rolled back. The money
    // under this key belongs to the attempt that won the claim; a prefix-wide
    // reversal here is exactly the defect claim-then-charge exists to prevent.
    expect(mockCreateMulti).not.toHaveBeenCalled();
    expect(mockRefundMulti).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.blockGoodPurchase.deleteMany).not.toHaveBeenCalled();
  });

  it('reports PENDING_RECONCILIATION when the winning claim has not settled', async () => {
    // Telling the viewer "already completed" would be a lie, and telling them to
    // retry sends them into a permanent wall — the key is taken by a charge whose
    // outcome nobody knows yet.
    dbMock.dbWrite.blockGoodPurchase.create.mockRejectedValueOnce(uniqueViolation());
    dbMock.dbWrite.blockGoodPurchase.findUnique.mockResolvedValue({ status: 'pending' });
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 409, reason: 'pending_reconciliation' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
    expect(mockRefundMulti).not.toHaveBeenCalled();
  });

  it('500s on a claim write failure that is NOT a unique violation', async () => {
    dbMock.dbWrite.blockGoodPurchase.create.mockRejectedValueOnce(new Error('db down'));
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 500, reason: 'charge_failed' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
  });

  it('returns a clean 400 and RELEASES the claim when the ledger REFUSES the debit (400)', async () => {
    mockCreateMulti.mockRejectedValueOnce(buzzApiError(400, 'Insufficient funds'));
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 400, reason: 'insufficient_funds' });
    // 🔴 The driver's own text must NOT reach the response body.
    expect((result as { error: string }).error).not.toContain('Insufficient funds');
    // The claim is released — guarded on `pending`, so it can never remove a
    // settled purchase — because we KNOW no money moved and a genuine retry (once
    // the viewer tops up) must be able to buy this good.
    expect(dbMock.dbWrite.blockGoodPurchase.deleteMany).toHaveBeenCalledWith({
      where: { id: expect.any(String), status: 'pending' },
    });
    expect(mockRefundMulti).not.toHaveBeenCalled();
    expect(mockCreateSingle).not.toHaveBeenCalled();
  });

  it('🔴 does NOT call an UNKNOWN charge outcome "insufficient funds", and KEEPS the claim', async () => {
    // The defect this exists for: the Buzz client throws on ANY non-2xx and on a
    // network failure, and `mapError` collapses 401/403/408/429 and every 5xx into
    // one INTERNAL_SERVER_ERROR. Reporting that as a 400 told the viewer they were
    // broke after a debit that may have committed — AND, because the endpoint
    // refunds the daily-cap reservation on a 4xx, gave back the ceiling for Buzz
    // that DID move. A 5xx keeps the reservation.
    mockCreateMulti.mockRejectedValueOnce(buzzApiError(504, 'Gateway Timeout'));
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 503, reason: 'charge_unknown' });
    // 🔴 The `pending` row SURVIVES: it is the only record that a debit may exist.
    expect(dbMock.dbWrite.blockGoodPurchase.deleteMany).not.toHaveBeenCalled();
    // And nothing is reversed — we cannot know what to reverse.
    expect(mockRefundMulti).not.toHaveBeenCalled();
  });

  it('treats a throw with NO recognisable buzz status as UNKNOWN, not as a refusal', async () => {
    // A raw `fetch` failure or an abort never reaches `mapError` at all, so
    // `getBuzzApiStatus` returns undefined. Fail-safe means UNKNOWN, not 400.
    mockCreateMulti.mockRejectedValueOnce(new Error('socket hang up'));
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 503, reason: 'charge_unknown' });
    expect(dbMock.dbWrite.blockGoodPurchase.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses when the charge reports no transactions at all, reversing and releasing', async () => {
    mockCreateMulti.mockResolvedValueOnce({
      transactionIds: [],
      totalAmount: 0,
      transactionCount: 0,
    } as never);
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 400, reason: 'charge_failed' });
    expect(mockCreateSingle).not.toHaveBeenCalled();
    expect(mockRefundMulti).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.blockGoodPurchase.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('🔴 refuses a PARTIAL debit rather than recording it as a full-price sale', async () => {
    // `transactionCount` alone does not say the whole price was taken. Recording
    // a short debit as a full sale pays the owner 70% of Buzz the viewer never
    // spent — the fixture total (600) is distinct from the price (1000) and from
    // both shares (700/300), so it cannot pass by coincidence.
    mockCreateMulti.mockResolvedValueOnce({
      transactionIds: [{ transactionId: 'buy-y', accountType: 'yellow', amount: 600 }],
      totalAmount: 600,
      transactionCount: 1,
    } as never);
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 400, reason: 'charge_failed' });
    expect(mockCreateSingle).not.toHaveBeenCalled();
    expect(mockRefundMulti).toHaveBeenCalledTimes(1);
  });

  it('accepts a price at EXACTLY the hard cap', async () => {
    // Boundary control for the over-cap refusal: a `>=` mutant would make a good
    // a moderator approved at the ceiling permanently unbuyable.
    mockCreateMulti.mockResolvedValueOnce({
      transactionIds: [
        {
          transactionId: 'buy-y',
          accountType: 'yellow',
          amount: BLOCK_GOOD_MAX_PRICE_BUZZ,
        },
      ],
      totalAmount: BLOCK_GOOD_MAX_PRICE_BUZZ,
      transactionCount: 1,
    } as never);
    const result = await purchaseBlockGood(
      purchaseInput({
        resolved: { ...RESOLVED, good: { ...GOOD, priceBuzz: BLOCK_GOOD_MAX_PRICE_BUZZ } },
      })
    );
    expect(result.ok).toBe(true);
  });

  it('REVERSES the charge and RELEASES the claim when the settle fails', async () => {
    dbMock.dbWrite.$transaction.mockRejectedValueOnce(new Error('db down'));
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 500, reason: 'charge_failed' });
    // Safe as a PREFIX-wide reversal only because this attempt holds the claim
    // exclusively — which is the property the claim-before-charge order buys.
    expect(mockRefundMulti).toHaveBeenCalledWith(
      expect.objectContaining({
        externalTransactionIdPrefix: `block-good:${APP_BLOCK_ID}:${GOOD_ID}:${BUYER}`,
      })
    );
    expect(dbMock.dbWrite.blockGoodPurchase.deleteMany).toHaveBeenCalledTimes(1);
    expect(mockCreateSingle).not.toHaveBeenCalled();
  });

  it('RE-GRANTS a revoked entitlement — clearing revokedAt, revokeReason and grantedAt', async () => {
    // 🔴 The `update` branch nothing asserted. Dropping `revokedAt: null` from it
    // leaves a viewer who was refunded and re-bought CHARGED, the owner PAID, and
    // the entitlement still revoked — so the read returns nothing they own, and a
    // third attempt is refused forever. Money in, nothing out.
    dbMock.dbRead.blockGoodEntitlement.findUnique.mockResolvedValue({
      goodId: GOOD_ID,
      kind: 'good',
      payload: {},
      grantedAt: new Date('2026-09-01T00:00:00.000Z'),
      revokedAt: new Date('2026-09-20T00:00:00.000Z'),
      purchaseId: 'bgp_FIRST',
    });
    await purchaseBlockGood(purchaseInput());
    const upsert = dbMock.dbWrite.blockGoodEntitlement.upsert.mock.calls[0][0];
    expect(upsert.update).toEqual(
      expect.objectContaining({
        revokedAt: null,
        revokeReason: null,
        grantedAt: expect.any(Date),
        purchaseId: expect.any(String),
        kind: 'good',
      })
    );
    // …and it repoints at the NEW purchase, not the refunded one.
    expect(upsert.update.purchaseId).not.toBe('bgp_FIRST');
  });

  it('still completes the purchase when the owner PAYOUT fails', async () => {
    // The viewer paid; withholding the entitlement because the credit leg failed
    // would take their money and give nothing. The obligation is visible as an
    // empty `payouts` on the row.
    // `withRetries` re-attempts the whole payout block, so reject every attempt.
    mockCreateSingle.mockRejectedValue(new Error('bank unavailable'));
    const result = await purchaseBlockGood(purchaseInput());
    expect(result.ok).toBe(true);
    // The SETTLE update fires (that is what makes the purchase real); the PAYOUT
    // update does not, so `payouts` stays `[]` — which is exactly the set a
    // re-runner would select. Asserted by the data shape, not the call count, so
    // a mutant writing an OPTIMISTIC payout before the credit lands is caught:
    // that row would claw back Buzz the owner never received.
    const updates = dbMock.dbWrite.blockGoodPurchase.update.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data
    );
    expect(updates).toEqual([{ status: 'paid', bluePaidBuzz: 0 }]);
    expect(updates.some((d) => 'payouts' in d)).toBe(false);
    expect(dbMock.dbWrite.blockGoodPurchase.create.mock.calls[0][0].data.payouts).toEqual([]);
  });

  it('records a NULL block instance rather than failing when it is unresolvable', async () => {
    const result = await purchaseBlockGood(purchaseInput({ blockInstanceId: null }));
    expect(result.ok).toBe(true);
    expect(
      dbMock.dbWrite.blockGoodPurchase.create.mock.calls[0][0].data.blockInstanceId
    ).toBeNull();
  });
});

describe('listBlockGoodEntitlements — visible only to the owning app', () => {
  it('scopes the query to the CALLING app and the viewer, and excludes revoked rows', async () => {
    dbMock.dbRead.blockGoodEntitlement.findMany.mockResolvedValue([
      {
        goodId: GOOD_ID,
        kind: 'good',
        payload: { slots: 5 },
        grantedAt: new Date('2026-09-27T00:00:00.000Z'),
      },
    ]);
    const rows = await listBlockGoodEntitlements({ userId: BUYER, appBlockId: APP_BLOCK_ID });
    expect(dbMock.dbRead.blockGoodEntitlement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: BUYER, appBlockId: APP_BLOCK_ID, revokedAt: null },
      })
    );
    expect(rows).toEqual([
      {
        goodId: GOOD_ID,
        kind: 'good',
        payload: { slots: 5 },
        grantedAt: '2026-09-27T00:00:00.000Z',
      },
    ]);
  });

  it('asks for a DIFFERENT app id when a different app calls', async () => {
    // The scoping is in the query, so the only way an app sees another app's
    // entitlements is if this argument stops reaching the `where`.
    await listBlockGoodEntitlements({ userId: BUYER, appBlockId: 'apb_OTHERAPP' });
    expect(dbMock.dbRead.blockGoodEntitlement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ appBlockId: 'apb_OTHERAPP' }),
      })
    );
  });
});

describe('refundBlockGoodPurchase — reverses the RECORDED payout', () => {
  const RECORDED = [
    { userId: OWNER, amount: 280, color: 'blue', transactionId: 'pay-blue' },
    { userId: OWNER, amount: 420, color: 'yellow', transactionId: 'pay-yellow' },
  ];

  function stubPurchase(overrides: Record<string, unknown> = {}) {
    dbMock.dbWrite.blockGoodPurchase.findUnique.mockResolvedValue({
      id: 'bgp_1',
      status: 'paid',
      userId: BUYER,
      appBlockId: APP_BLOCK_ID,
      goodId: GOOD_ID,
      priceBuzz: PRICE,
      buzzTransactionId: `block-good:${APP_BLOCK_ID}:${GOOD_ID}:${BUYER}`,
      payouts: RECORDED,
      ...overrides,
    });
  }

  it('refunds the buyer and reverses EXACTLY the recorded payout transactions', async () => {
    stubPurchase();
    const result = await refundBlockGoodPurchase({ purchaseId: 'bgp_1', reason: 'takedown' });

    expect(result).toMatchObject({ refunded: true, clawedBackBuzz: 700, failures: [] });
    expect(mockRefundMulti).toHaveBeenCalledWith(
      expect.objectContaining({
        externalTransactionIdPrefix: `block-good:${APP_BLOCK_ID}:${GOOD_ID}:${BUYER}`,
      })
    );
    expect(mockRefundTransaction.mock.calls.map((c) => c[0])).toEqual(['pay-blue', 'pay-yellow']);
  });

  it('does NOT re-derive the split — a payout that differs from 70/30 is reversed as recorded', async () => {
    // 🔴 THE POINT OF THE `payouts` COLUMN. These amounts (500 + 100) are NOT
    // `computeBlockGoodSplit(1000)`, so a re-deriving implementation would claw
    // back 700 and the assertion below would see the wrong total. The fixture
    // values are deliberately distinct from 700, 300 and 1000.
    stubPurchase({
      payouts: [
        { userId: OWNER, amount: 500, color: 'yellow', transactionId: 'legacy-a' },
        { userId: OWNER, amount: 100, color: 'blue', transactionId: 'legacy-b' },
      ],
    });
    const result = await refundBlockGoodPurchase({ purchaseId: 'bgp_1', reason: 'chargeback' });
    expect(result).toMatchObject({ refunded: true, clawedBackBuzz: 600 });
    expect(mockRefundTransaction.mock.calls.map((c) => c[0])).toEqual(['legacy-a', 'legacy-b']);
  });

  it('REVOKES the entitlement and marks the purchase refunded', async () => {
    stubPurchase();
    await refundBlockGoodPurchase({ purchaseId: 'bgp_1', reason: 'takedown' });
    expect(dbMock.dbWrite.blockGoodPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'bgp_1' },
        data: expect.objectContaining({ status: 'refunded', refundReason: 'takedown' }),
      })
    );
    expect(dbMock.dbWrite.blockGoodEntitlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { purchaseId: 'bgp_1', revokedAt: null },
        data: expect.objectContaining({ revokeReason: 'takedown' }),
      })
    );
  });

  it('REPORTS a payout with no recorded transaction id instead of guessing at it', async () => {
    stubPurchase({ payouts: [{ userId: OWNER, amount: 700, color: 'yellow' }] });
    const result = await refundBlockGoodPurchase({ purchaseId: 'bgp_1', reason: 'takedown' });
    expect(result).toMatchObject({ refunded: true, clawedBackBuzz: 0 });
    expect((result as { failures: string[] }).failures[0]).toContain('no recorded transaction id');
    expect(mockRefundTransaction).not.toHaveBeenCalled();
  });

  it('🔴 ABORTS when the BUYER refund fails — it must not record a refund that did not happen', async () => {
    // The worst outcome this function can produce, and it was reachable: marking
    // the row `refunded` after a failed buyer refund loses the viewer the item
    // AND the money, asserts in the record that they were repaid, and then
    // `already_refunded` refuses every retry — so the failure closes its own
    // remediation path.
    stubPurchase();
    mockRefundMulti.mockRejectedValueOnce(new Error('ledger unavailable'));
    const result = await refundBlockGoodPurchase({ purchaseId: 'bgp_1', reason: 'takedown' });
    expect(result).toEqual({ refunded: false, reason: 'buyer_refund_failed' });
    // The purchase stays `paid` and the entitlement stays granted — a state a
    // retry can act on.
    expect(dbMock.dbWrite.blockGoodPurchase.update).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.blockGoodEntitlement.updateMany).not.toHaveBeenCalled();
    // And the owner is NOT clawed back for a refund the viewer never received.
    expect(mockRefundTransaction).not.toHaveBeenCalled();
  });

  it('reports a failed clawback rather than claiming the money came back', async () => {
    stubPurchase();
    mockRefundTransaction.mockRejectedValueOnce(new Error('ledger down'));
    const result = await refundBlockGoodPurchase({ purchaseId: 'bgp_1', reason: 'takedown' });
    expect(result).toMatchObject({ refunded: true, clawedBackBuzz: 420 });
    expect((result as { failures: string[] }).failures).toHaveLength(1);
  });

  it('refuses a purchase that is already refunded, and one that does not exist', async () => {
    stubPurchase({ status: 'refunded' });
    await expect(
      refundBlockGoodPurchase({ purchaseId: 'bgp_1', reason: 'again' })
    ).resolves.toEqual({ refunded: false, reason: 'already_refunded' });

    dbMock.dbWrite.blockGoodPurchase.findUnique.mockResolvedValue(null);
    await expect(refundBlockGoodPurchase({ purchaseId: 'nope', reason: 'x' })).resolves.toEqual({
      refunded: false,
      reason: 'not_found',
    });
    expect(mockRefundMulti).not.toHaveBeenCalled();
  });
});

describe('readRecordedPayouts — narrowing the JSON column', () => {
  it('keeps well-formed entries and drops anything it cannot trust', () => {
    expect(
      readRecordedPayouts([
        { userId: 1, amount: 10, color: 'blue', transactionId: 't' },
        { userId: 2, amount: 20, color: 'yellow' },
        { userId: 'three', amount: 30, color: 'yellow' },
        { userId: 4, amount: '40', color: 'yellow' },
        { userId: 5, amount: 50 },
        null,
        'nope',
      ])
    ).toEqual([
      { userId: 1, amount: 10, color: 'blue', transactionId: 't' },
      { userId: 2, amount: 20, color: 'yellow' },
    ]);
  });

  it('returns an empty list for a non-array value', () => {
    for (const value of [null, undefined, {}, 'x', 7]) {
      expect(readRecordedPayouts(value)).toEqual([]);
    }
  });
});
