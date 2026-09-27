import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BuzzService from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';

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

const { mockCreateMulti, mockCreateSingle, mockRefundMulti, mockRefundTransaction } = vi.hoisted(
  () => ({
    mockCreateMulti: vi.fn(async (_input: Record<string, unknown>) => ({
      transactionIds: [{ transactionId: 'buy-y', accountType: 'yellow', amount: 1000 }],
      totalAmount: 1000,
      transactionCount: 1,
    })),
    mockCreateSingle: vi.fn(async (_input: Record<string, unknown>) => ({
      transactionId: 'pay-1',
      remainingBalance: null as number | null,
    })),
    mockRefundMulti: vi.fn(async (_input: Record<string, unknown>) => ({
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
    })),
    mockRefundTransaction: vi.fn(async (_transactionId: string, _description?: string) => ({
      ok: true,
    })),
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

/** The happy-path DB shape: nothing owned, nothing purchased, writes succeed. */
function stubCleanDb() {
  dbMock.dbRead.blockGoodEntitlement.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.blockGoodPurchase.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.blockGoodPurchase.create.mockResolvedValue({});
  dbMock.dbWrite.blockGoodPurchase.update.mockResolvedValue({});
  dbMock.dbWrite.blockGoodEntitlement.upsert.mockResolvedValue({
    goodId: GOOD_ID,
    kind: 'good',
    payload: { slots: 5 },
    grantedAt: new Date('2026-09-27T00:00:00.000Z'),
  });
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

    const row = dbMock.dbWrite.blockGoodPurchase.create.mock.calls[0][0].data;
    expect(row.bluePaidBuzz).toBe(400);
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
    expect(result).toMatchObject({ ok: false, status: 409, code: 'already_owned' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.blockGoodPurchase.create).not.toHaveBeenCalled();
  });

  it('ALLOWS re-buying after a REVOKED entitlement', async () => {
    dbMock.dbRead.blockGoodEntitlement.findUnique.mockResolvedValue({
      goodId: GOOD_ID,
      kind: 'good',
      payload: {},
      grantedAt: new Date(),
      revokedAt: new Date(),
    });
    const result = await purchaseBlockGood(purchaseInput());
    expect(result.ok).toBe(true);
  });

  it('REFUSES the app owner buying their own good', async () => {
    const result = await purchaseBlockGood(purchaseInput({ buyerUserId: OWNER }));
    expect(result).toMatchObject({ ok: false, status: 400, code: 'self_purchase' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
  });

  it('REFUSES when expectedPriceBuzz disagrees with the server price', async () => {
    const result = await purchaseBlockGood(purchaseInput({ expectedPriceBuzz: 999 }));
    expect(result).toMatchObject({ ok: false, status: 409, code: 'price_changed' });
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
    expect(result).toMatchObject({ ok: false, status: 400, code: 'price_over_cap' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
  });

  it('REPLAYS a purchase already recorded under the deterministic key, without charging again', async () => {
    dbMock.dbWrite.blockGoodPurchase.findUnique.mockResolvedValue({ id: 'bgp_EXISTING' });
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 409, code: 'duplicate' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
  });

  it('returns a clean 400 — never a 500 — when the buyer cannot afford it', async () => {
    mockCreateMulti.mockRejectedValueOnce(new Error('Insufficient funds'));
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 400, code: 'insufficient_funds' });
    expect(result.ok).toBe(false);
    // 🔴 The driver's own text must NOT reach the response body.
    expect((result as { error: string }).error).not.toContain('Insufficient funds');
    expect(dbMock.dbWrite.blockGoodPurchase.create).not.toHaveBeenCalled();
  });

  it('refuses when the charge reports no transactions at all', async () => {
    mockCreateMulti.mockResolvedValueOnce({
      transactionIds: [],
      totalAmount: 0,
      transactionCount: 0,
    } as never);
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 400, code: 'charge_failed' });
    expect(mockCreateSingle).not.toHaveBeenCalled();
  });

  it('REFUNDS the buyer when the ledger write fails after the charge', async () => {
    dbMock.dbWrite.$transaction.mockRejectedValueOnce(new Error('db down'));
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(mockRefundMulti).toHaveBeenCalledWith(
      expect.objectContaining({
        externalTransactionIdPrefix: `block-good:${APP_BLOCK_ID}:${GOOD_ID}:${BUYER}`,
      })
    );
    expect(mockCreateSingle).not.toHaveBeenCalled();
  });

  it('reports a DUPLICATE (and refunds) when a concurrent attempt won the unique key', async () => {
    dbMock.dbWrite.$transaction.mockRejectedValueOnce(
      Object.assign(new Error('unique'), {
        code: 'P2002',
      })
    );
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 409, code: 'duplicate' });
    expect(mockRefundMulti).toHaveBeenCalledTimes(1);
  });

  it('still completes the purchase when the owner PAYOUT fails', async () => {
    // The viewer paid; withholding the entitlement because the credit leg failed
    // would take their money and give nothing. The obligation is visible as an
    // empty `payouts` on the row.
    mockCreateSingle.mockRejectedValueOnce(new Error('bank unavailable'));
    const result = await purchaseBlockGood(purchaseInput());
    expect(result.ok).toBe(true);
    expect(dbMock.dbWrite.blockGoodPurchase.update).not.toHaveBeenCalled();
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
