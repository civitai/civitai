import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Prisma client is stale in this worktree (CI regenerates), so
 * Prisma.PrismaClientKnownRequestError isn't constructible. We
 * duck-type the error shape — same as the service does at runtime.
 */
class FakePrismaKnownError extends Error {
  code: string;
  clientVersion: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.clientVersion = 'test';
  }
}

/**
 * Coverage for the buzz-attribution service. The interesting surface is:
 *   - rate-card application against each scope
 *   - self-purchase wash (publisher == purchaser → voided + 0 share)
 *   - idempotency via P2002 unique-violation handling
 *   - missing-app guard
 *   - void path for refunds
 *
 * Prisma + logger are mocked at the module boundary so the test stays
 * in-process and deterministic.
 */

const { mockDbRead, mockDbWrite, mockLog } = vi.hoisted(() => ({
  mockDbRead: {
    oauthClient: { findUnique: vi.fn() },
    blockBuzzAttribution: { findUnique: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn() },
    blockGoodPurchase: { groupBy: vi.fn() },
  },
  mockDbWrite: {
    blockBuzzAttribution: {
      create: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
    },
  },
  mockLog: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: mockDbWrite,
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: unknown[]) => {
    mockLog(...args);
    return Promise.resolve(null);
  },
}));

import {
  AttributionAppMissingError,
  emptyGoodsSales,
  emptyRevenue,
  getGoodsSalesForOwner,
  getRevenueForOwner,
  isMissingGoodsTableError,
  unreadableGoodsSales,
  recordAttribution,
  REFUND_WINDOWS_DAYS,
  voidAttributionsForPayment,
} from '../buzz-attribution.service';
import type { BlockAttribution } from '~/server/schema/blocks/attribution.schema';
import { ACTIVE_RATE_CARD } from '../rate-card';

const APP_ID = 'app_test';
const APP_BLOCK_ID = 'apb_test';
const APP_OWNER_USER_ID = 999;
const PURCHASER_ID = 100;

function fakeAttribution(over: Partial<BlockAttribution> = {}): BlockAttribution {
  return {
    appId: APP_ID,
    appBlockId: APP_BLOCK_ID,
    blockInstanceId: 'mbi_test123',
    scope: 'per_model_install',
    ...over,
  };
}

beforeEach(() => {
  mockDbRead.oauthClient.findUnique.mockReset();
  mockDbRead.blockBuzzAttribution.findUnique.mockReset();
  mockDbWrite.blockBuzzAttribution.create.mockReset();
  mockDbWrite.blockBuzzAttribution.updateMany.mockReset();
  mockDbWrite.blockBuzzAttribution.findMany.mockReset();
  // findMany defaults to "no paid_out rows" so existing void tests that
  // don't set it up exercise the no-clawback path.
  mockDbWrite.blockBuzzAttribution.findMany.mockResolvedValue([]);
  mockLog.mockReset();

  mockDbRead.oauthClient.findUnique.mockResolvedValue({
    id: APP_ID,
    userId: APP_OWNER_USER_ID,
  });
  // Default create echoes back what the caller supplied (the service
  // selects a subset of columns; we return the same subset).
  mockDbWrite.blockBuzzAttribution.create.mockImplementation(async ({ data, select }: any) => {
    // Clawback writes (voidAttributionsForPayment) pass no `select` —
    // just echo the row back. recordAttribution passes a select subset.
    if (!select) return { ...data };
    const result: any = {};
    for (const k of Object.keys(select)) result[k] = data[k] ?? null;
    return result;
  });
});

describe('recordAttribution', () => {
  it('writes a pending row with publisher share for a per_model_install purchase', async () => {
    const result = await recordAttribution({
      userId: PURCHASER_ID,
      buzzAmount: 5000,
      usdAmountCents: 1000,
      providerFeeCents: 50,
      paymentProvider: 'stripe',
      paymentTransactionId: 'pi_abc',
      buzzTransactionId: 'bt_abc',
      attribution: fakeAttribution(),
    });

    expect(result.written).toBe(true);
    expect(mockDbWrite.blockBuzzAttribution.create).toHaveBeenCalledOnce();
    const dataArg = mockDbWrite.blockBuzzAttribution.create.mock.calls[0][0].data;

    expect(dataArg.userId).toBe(PURCHASER_ID);
    expect(dataArg.appOwnerUserId).toBe(APP_OWNER_USER_ID);
    expect(dataArg.appId).toBe(APP_ID);
    expect(dataArg.status).toBe('pending');
    expect(dataArg.voidedReason).toBeNull();
    expect(dataArg.providerFeeCents).toBe(50);
    // net 950 * 15% per_model_install = 142.5 → floor 142. The active card
    // (V2→V3→V4) has carried per_model_install at 15% verbatim, so the math
    // is version-stable; only the stamped version label tracks ACTIVE.
    expect(dataArg.appOwnerShareCents).toBe(142);
    expect(dataArg.platformShareCents).toBe(808);
    expect(dataArg.providerFeeCents + dataArg.platformShareCents + dataArg.appOwnerShareCents).toBe(
      1000
    );
    // Pin to the active card's version rather than a literal so this doesn't
    // go stale every time ACTIVE_RATE_CARD advances (it was stale at 'v2'
    // through the V3 bump).
    expect(dataArg.rateCardVersion).toBe(ACTIVE_RATE_CARD.version);
    expect(dataArg.id).toMatch(/^bba_/);
  });

  it('writes a voided self-purchase row with zero publisher share', async () => {
    const result = await recordAttribution({
      userId: APP_OWNER_USER_ID, // purchaser IS the app owner
      buzzAmount: 5000,
      usdAmountCents: 1000,
      providerFeeCents: 50,
      paymentProvider: 'stripe',
      paymentTransactionId: 'pi_self',
      attribution: fakeAttribution({ scope: 'viewer_personal' }),
    });

    expect(result.written).toBe(true);
    const dataArg = mockDbWrite.blockBuzzAttribution.create.mock.calls[0][0].data;
    expect(dataArg.status).toBe('voided');
    expect(dataArg.voidedReason).toBe('self_purchase');
    expect(dataArg.voidedAt).toBeInstanceOf(Date);
    expect(dataArg.appOwnerShareCents).toBe(0);
    expect(dataArg.platformShareCents).toBe(950);
    // Civitai still keeps 100% (minus fee) — the row exists for audit.
    expect(dataArg.providerFeeCents + dataArg.platformShareCents).toBe(1000);
  });

  it('respects scope when calculating the share (viewer_personal earns more)', async () => {
    await recordAttribution({
      userId: PURCHASER_ID,
      buzzAmount: 5000,
      usdAmountCents: 1000,
      providerFeeCents: 50,
      paymentProvider: 'stripe',
      paymentTransactionId: 'pi_viewer',
      attribution: fakeAttribution({ scope: 'viewer_personal' }),
    });
    const dataArg = mockDbWrite.blockBuzzAttribution.create.mock.calls[0][0].data;
    // net 950 * 25% = 237 (Math.floor)
    expect(dataArg.appOwnerShareCents).toBe(237);
    expect(dataArg.platformShareCents).toBe(713);
  });

  it('zeroes publisher share for platform_default scope', async () => {
    await recordAttribution({
      userId: PURCHASER_ID,
      buzzAmount: 5000,
      usdAmountCents: 1000,
      providerFeeCents: 50,
      paymentProvider: 'stripe',
      paymentTransactionId: 'pi_default',
      attribution: fakeAttribution({ scope: 'platform_default' }),
    });
    const dataArg = mockDbWrite.blockBuzzAttribution.create.mock.calls[0][0].data;
    expect(dataArg.appOwnerShareCents).toBe(0);
    expect(dataArg.status).toBe('pending');
  });

  it('returns the existing row on duplicate write (idempotency via P2002)', async () => {
    const existingRow = {
      id: 'bba_existing',
      status: 'pending' as const,
      appOwnerShareCents: 190,
      platformShareCents: 760,
      providerFeeCents: 50,
      rateCardVersion: 'v1',
      voidedReason: null,
    };
    mockDbWrite.blockBuzzAttribution.create.mockRejectedValueOnce(
      new FakePrismaKnownError('Unique constraint failed', 'P2002')
    );
    mockDbRead.blockBuzzAttribution.findUnique.mockResolvedValueOnce(existingRow);

    const result = await recordAttribution({
      userId: PURCHASER_ID,
      buzzAmount: 5000,
      usdAmountCents: 1000,
      providerFeeCents: 50,
      paymentProvider: 'stripe',
      paymentTransactionId: 'pi_dupe',
      attribution: fakeAttribution(),
    });

    expect(result.written).toBe(false);
    expect(result.row.id).toBe('bba_existing');
    expect(mockDbRead.blockBuzzAttribution.findUnique).toHaveBeenCalledWith({
      where: {
        paymentTransactionId_appBlockId: {
          paymentTransactionId: 'pi_dupe',
          appBlockId: APP_BLOCK_ID,
        },
      },
      select: expect.any(Object),
    });
  });

  it('rethrows non-unique-constraint Prisma errors', async () => {
    const otherErr = new FakePrismaKnownError('something else', 'P2003');
    mockDbWrite.blockBuzzAttribution.create.mockRejectedValueOnce(otherErr);

    await expect(
      recordAttribution({
        userId: PURCHASER_ID,
        buzzAmount: 5000,
        usdAmountCents: 1000,
        providerFeeCents: 50,
        paymentProvider: 'stripe',
        paymentTransactionId: 'pi_xx',
        attribution: fakeAttribution(),
      })
    ).rejects.toBe(otherErr);
  });

  it('throws AttributionAppMissingError when the OauthClient is gone', async () => {
    mockDbRead.oauthClient.findUnique.mockResolvedValueOnce(null);
    await expect(
      recordAttribution({
        userId: PURCHASER_ID,
        buzzAmount: 5000,
        usdAmountCents: 1000,
        providerFeeCents: 50,
        paymentProvider: 'stripe',
        paymentTransactionId: 'pi_missing',
        attribution: fakeAttribution({ appId: 'app_deleted' }),
      })
    ).rejects.toBeInstanceOf(AttributionAppMissingError);
    expect(mockDbWrite.blockBuzzAttribution.create).not.toHaveBeenCalled();
  });

  it('flows buzzTransactionId + modelId through to the row', async () => {
    await recordAttribution({
      userId: PURCHASER_ID,
      buzzAmount: 5000,
      usdAmountCents: 500,
      providerFeeCents: 0,
      paymentProvider: 'paddle',
      paymentTransactionId: 'paddle_tx_1',
      buzzTransactionId: 'buzz_tx_99',
      attribution: fakeAttribution({ modelId: 12345 }),
    });
    const dataArg = mockDbWrite.blockBuzzAttribution.create.mock.calls[0][0].data;
    expect(dataArg.buzzTransactionId).toBe('buzz_tx_99');
    expect(dataArg.modelId).toBe(12345);
    expect(dataArg.paymentProvider).toBe('paddle');
  });

  it('writes an audit log line on every successful attribution', async () => {
    await recordAttribution({
      userId: PURCHASER_ID,
      buzzAmount: 5000,
      usdAmountCents: 1000,
      providerFeeCents: 50,
      paymentProvider: 'stripe',
      paymentTransactionId: 'pi_audit',
      attribution: fakeAttribution(),
    });
    const audit = mockLog.mock.calls.find((c) => c[0]?.message?.startsWith('attribution written'));
    expect(audit).toBeTruthy();
    expect(audit?.[0].name).toBe('block-buzz-attribution');
    expect(audit?.[0].type).toBe('info');
  });
});

describe('voidAttributionsForPayment', () => {
  it('voids matching pending/confirmed/paid_out rows with a refund reason', async () => {
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 1 });
    const count = await voidAttributionsForPayment({
      paymentProvider: 'stripe',
      paymentTransactionId: 'pi_refund',
      reason: 'refund',
    });
    expect(count).toBe(1);
    const args = mockDbWrite.blockBuzzAttribution.updateMany.mock.calls[0][0];
    expect(args.where.paymentProvider).toBe('stripe');
    expect(args.where.paymentTransactionId).toBe('pi_refund');
    expect(args.where.status.in).toEqual(['pending', 'confirmed', 'paid_out']);
    expect(args.data.status).toBe('voided');
    expect(args.data.voidedReason).toBe('refund');
    expect(args.data.voidedAt).toBeInstanceOf(Date);
  });

  it('returns 0 (no log) when nothing matched', async () => {
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 0 });
    const count = await voidAttributionsForPayment({
      paymentProvider: 'paddle',
      paymentTransactionId: 'paddle_unknown',
      reason: 'chargeback',
    });
    expect(count).toBe(0);
    const audit = mockLog.mock.calls.find((c) => c[0]?.message?.startsWith('voided'));
    expect(audit).toBeUndefined();
  });

  it('writes NO clawback row when only pending/confirmed rows are voided', async () => {
    // No paid_out rows → findMany returns [] (default) → no clawback.
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 2 });
    const count = await voidAttributionsForPayment({
      paymentProvider: 'stripe',
      paymentTransactionId: 'pi_pre_payout',
      reason: 'refund',
    });
    expect(count).toBe(2);
    expect(mockDbWrite.blockBuzzAttribution.create).not.toHaveBeenCalled();
  });

  it('writes exactly one negative clawback row when a paid_out row is voided', async () => {
    mockDbWrite.blockBuzzAttribution.findMany.mockResolvedValueOnce([
      {
        appOwnerShareCents: 190,
        appOwnerUserId: APP_OWNER_USER_ID,
        userId: PURCHASER_ID,
        buzzType: 'yellow',
        appId: APP_ID,
        appBlockId: APP_BLOCK_ID,
        blockInstanceId: 'mbi_test123',
        scope: 'per_model_install',
        modelId: null,
        rateCardVersion: 'v1',
      },
    ]);
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 1 });

    const count = await voidAttributionsForPayment({
      paymentProvider: 'stripe',
      paymentTransactionId: 'pi_paid',
      reason: 'refund',
    });

    expect(count).toBe(1);
    expect(mockDbWrite.blockBuzzAttribution.create).toHaveBeenCalledOnce();
    const clawback = mockDbWrite.blockBuzzAttribution.create.mock.calls[0][0].data;

    expect(clawback.entryType).toBe('clawback');
    expect(clawback.status).toBe('confirmed');
    expect(clawback.appOwnerShareCents).toBe(-190);
    expect(clawback.usdAmountCents).toBe(-190);
    expect(clawback.platformShareCents).toBe(0);
    expect(clawback.providerFeeCents).toBe(0);
    expect(clawback.voidedReason).toBeNull();
    expect(clawback.appOwnerUserId).toBe(APP_OWNER_USER_ID);
    expect(clawback.appBlockId).toBe(APP_BLOCK_ID);
    // Synthetic tx id so it doesn't collide with the original UNIQUE.
    expect(clawback.paymentTransactionId).toBe('pi_paid:clawback');
    expect(clawback.id).toMatch(/^bba_/);

    // Conservation: fee + platform + owner == usd (all on the clawback row).
    expect(
      clawback.providerFeeCents + clawback.platformShareCents + clawback.appOwnerShareCents
    ).toBe(clawback.usdAmountCents);
  });

  it('dedupes a double-refund (P2002 on the synthetic clawback key) to one clawback', async () => {
    mockDbWrite.blockBuzzAttribution.findMany.mockResolvedValueOnce([
      {
        appOwnerShareCents: 100,
        appOwnerUserId: APP_OWNER_USER_ID,
        userId: PURCHASER_ID,
        buzzType: 'yellow',
        appId: APP_ID,
        appBlockId: APP_BLOCK_ID,
        blockInstanceId: 'mbi_test123',
        scope: 'per_model_install',
        modelId: null,
        rateCardVersion: 'v1',
      },
    ]);
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 0 });
    // The clawback insert collides with the one written by the first refund.
    mockDbWrite.blockBuzzAttribution.create.mockRejectedValueOnce(
      new FakePrismaKnownError('Unique constraint failed', 'P2002')
    );

    // Should not throw — P2002 is swallowed.
    const count = await voidAttributionsForPayment({
      paymentProvider: 'stripe',
      paymentTransactionId: 'pi_paid',
      reason: 'refund',
    });

    expect(count).toBe(0);
    // Attempted once; the duplicate was skipped rather than retried.
    expect(mockDbWrite.blockBuzzAttribution.create).toHaveBeenCalledOnce();
  });

  it('mixed batch: clawbacks only the paid_out rows', async () => {
    // findMany only ever returns paid_out rows; a confirmed row that gets
    // voided is NOT in this list, so it gets no clawback.
    mockDbWrite.blockBuzzAttribution.findMany.mockResolvedValueOnce([
      {
        appOwnerShareCents: 50,
        appOwnerUserId: APP_OWNER_USER_ID,
        userId: PURCHASER_ID,
        buzzType: 'yellow',
        appId: APP_ID,
        appBlockId: 'apb_paid',
        blockInstanceId: 'mbi_paid',
        scope: 'viewer_personal',
        modelId: null,
        rateCardVersion: 'v2',
      },
    ]);
    // 2 rows voided total (1 paid_out + 1 confirmed), but only 1 clawback.
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 2 });

    const count = await voidAttributionsForPayment({
      paymentProvider: 'stripe',
      paymentTransactionId: 'pi_mixed',
      reason: 'chargeback',
    });

    expect(count).toBe(2);
    expect(mockDbWrite.blockBuzzAttribution.create).toHaveBeenCalledOnce();
    const clawback = mockDbWrite.blockBuzzAttribution.create.mock.calls[0][0].data;
    expect(clawback.appBlockId).toBe('apb_paid');
    expect(clawback.appOwnerShareCents).toBe(-50);
  });
});

describe('REFUND_WINDOWS_DAYS', () => {
  it('exposes the per-provider refund windows', () => {
    expect(REFUND_WINDOWS_DAYS.stripe).toBeGreaterThan(REFUND_WINDOWS_DAYS.paddle);
    expect(REFUND_WINDOWS_DAYS.paddle).toBeGreaterThan(REFUND_WINDOWS_DAYS.nowpayments);
  });
});

/**
 * The fabricated-zero discriminator. `emptyRevenue()` is the dark-flag
 * placeholder; `getRevenueForOwner` is the real measurement. Both can return
 * every bucket at 0, so the ONLY thing a client can branch on is `unavailable`.
 * This describe is the authority for the real function's behaviour — the router
 * test mocks `emptyRevenue` at the module boundary and therefore cannot prove it.
 */
describe('emptyRevenue (placeholder vs measurement discriminator)', () => {
  it('flags the dark-flag placeholder as notEntitled', () => {
    expect(emptyRevenue().unavailable).toBe('notEntitled');
  });

  it('still zeroes every bucket (the placeholder shape is unchanged otherwise)', () => {
    const empty = emptyRevenue();
    expect(empty.summary.pending).toEqual({ count: 0, grossCents: 0, shareCents: 0 });
    expect(empty.summary.confirmed).toEqual({ count: 0, grossCents: 0, shareCents: 0 });
    expect(empty.summary.paidOut).toEqual({ count: 0, grossCents: 0, shareCents: 0 });
    expect(empty.summary.voided).toEqual({ count: 0, grossCents: 0 });
    expect(empty.topApps).toEqual([]);
    expect(empty.recentAttributions).toEqual([]);
    // The goods rail is a bucket too, and this test's name claims EVERY bucket.
    // Without this line the dark-flag payload could grow a non-zero sales figure
    // and the assertion that is supposed to notice would still pass.
    expect(empty.goods).toStrictEqual({
      sales: {
        count: 0,
        grossBuzz: 0,
        shareBuzz: 0,
        shareUsdCents: 0,
        grossUsdCents: 0,
        blueGrossBuzz: 0,
      },
      refunded: { count: 0, grossBuzz: 0 },
    });
  });

  it('DISCRIMINATOR: a genuinely-measured all-zero result is NOT flagged', async () => {
    // Every aggregate legitimately returns nothing — a real measurement of "this
    // publisher has earned nothing yet". It must stay unflagged, or the fix hides
    // a dashboard the publisher is entitled to see.
    mockDbRead.blockBuzzAttribution.aggregate.mockReset();
    mockDbRead.blockBuzzAttribution.aggregate.mockResolvedValue({
      _count: 0,
      _sum: { usdAmountCents: null, appOwnerShareCents: null },
    });
    mockDbRead.blockBuzzAttribution.groupBy.mockReset();
    mockDbRead.blockBuzzAttribution.groupBy.mockResolvedValue([]);

    const measured = await getRevenueForOwner({ ownerUserId: APP_OWNER_USER_ID });
    const placeholder = emptyRevenue();

    // Precondition: the buckets really are identical, so nothing else could tell
    // these two apart. If this assertion ever fails the discriminator has stopped
    // being the only signal and this test is no longer proving what it claims.
    expect(measured.summary).toEqual(placeholder.summary);
    expect(measured.topApps).toEqual(placeholder.topApps);

    // The measured payload carries no discriminator at all; the placeholder does.
    expect('unavailable' in measured).toBe(false);
    expect(placeholder.unavailable).toBe('notEntitled');
  });
});

/**
 * The digital-goods bridge.
 *
 * THE DEFECT THIS COVERS, concretely: a settled sale — price 10 Buzz, owner
 * share 7, `status='paid'`, a ledger transaction id in `payouts`, the entitlement
 * granted — and the owner's revenue page reported $0.00, because every figure on
 * it was a SUM over `block_buzz_attribution` and this rail writes no row there.
 * `getGoodsSalesForOwner` is the read that makes the sale visible.
 *
 * Fixtures are pairwise distinct AND distinct from every constant the assertions
 * name, so an aggregate that read the wrong `_sum` field, the wrong status bucket
 * or the wrong row count cannot land on a right-looking number by coincidence.
 */
describe('getGoodsSalesForOwner — the goods → earnings bridge', () => {
  const GOODS_OWNER = 4242;

  /**
   * Three status buckets, as the DB would group them. `pending` carries LARGE,
   * unmistakable figures precisely so that leaking it anywhere into the result is
   * obvious rather than plausible.
   */
  const THREE_BUCKETS = [
    {
      status: 'paid',
      _count: 3,
      _sum: { priceBuzz: 430, appOwnerShareBuzz: 301, bluePaidBuzz: 115 },
    },
    {
      status: 'refunded',
      _count: 2,
      _sum: { priceBuzz: 60, appOwnerShareBuzz: 42, bluePaidBuzz: 17 },
    },
    {
      status: 'pending',
      _count: 5,
      _sum: { priceBuzz: 999, appOwnerShareBuzz: 700, bluePaidBuzz: 888 },
    },
  ];

  beforeEach(() => {
    mockDbRead.blockGoodPurchase.groupBy.mockReset();
  });

  it('sums the PAID bucket, in Buzz, with USD derived from the total', async () => {
    mockDbRead.blockGoodPurchase.groupBy.mockResolvedValue(THREE_BUCKETS);

    const result = await getGoodsSalesForOwner({ ownerUserId: GOODS_OWNER });

    expect(result.sales.count).toBe(3);
    expect(result.sales.grossBuzz).toBe(430);
    expect(result.sales.shareBuzz).toBe(301);
    // 1,000 Buzz = $1 → 430 Buzz = 43c, 301 Buzz = 30c (floored). Both literals
    // differ from every Buzz figure above, so a conversion that was skipped
    // entirely (cents === Buzz) fails here rather than passing on a coincidence.
    expect(result.sales.grossUsdCents).toBe(43);
    expect(result.sales.shareUsdCents).toBe(30);
    // Blue comes from the PAID bucket, and 115 is distinct from every other
    // fixture figure — so reading it off the wrong bucket (17, 888) or off the
    // wrong column (430, 301) fails here.
    expect(result.sales.blueGrossBuzz).toBe(115);
    // A real measurement carries no discriminator at all.
    expect('unavailable' in result).toBe(false);
  });

  it('selects exactly the three columns it sums, and counts rows', async () => {
    // 🔴 THE ARGUMENT, NOT JUST THE FILTER. Dropping `appOwnerShareBuzz: true`
    // from `_sum` is the single most damaging silent mutation available here:
    // production then reads `undefined`, the `?? 0` fallback turns it into 0, and
    // the owner's share renders as 0 Buzz — the invisible-revenue bug this whole
    // segment exists to fix, one layer down. Every other test in this file mocks
    // the row shape, so none of them can see it.
    //
    // `_count: true` (a boolean, not a field selection) is what makes `_count` a
    // plain number rather than a count-object; selecting fields instead would make
    // the sale count an object and render it as one.
    mockDbRead.blockGoodPurchase.groupBy.mockResolvedValue([]);

    await getGoodsSalesForOwner({ ownerUserId: GOODS_OWNER });

    const args = mockDbRead.blockGoodPurchase.groupBy.mock.calls[0]?.[0] as {
      _sum: Record<string, boolean>;
      _count: boolean;
    };
    expect(args._sum).toStrictEqual({
      priceBuzz: true,
      appOwnerShareBuzz: true,
      bluePaidBuzz: true,
    });
    expect(args._count).toBe(true);
  });

  it('EXCLUDES reversed/refunded rows from earnings, and reports them as the exclusion', async () => {
    mockDbRead.blockGoodPurchase.groupBy.mockResolvedValue(THREE_BUCKETS);

    const result = await getGoodsSalesForOwner({ ownerUserId: GOODS_OWNER });

    // A refund reverses the buyer's debit and normally claws the owner's payout
    // back, so counting one as earnings credits the owner for money that went
    // back. (The same status also covers a charge reversed before any entitlement
    // existed — no sale at all — which is why the renderer must not call these
    // "sales".)
    expect(result.refunded).toStrictEqual({ count: 2, grossBuzz: 60 });
    // 🔴 POSITIVE assertions on the paid totals, not just `not.toBe` — the
    // negatives below cannot distinguish "excluded correctly" from "produced some
    // third wrong number", so the exact sums carry the claim and the negatives pin
    // the specific additive mutation.
    expect(result.sales.count).toBe(3);
    expect(result.sales.grossBuzz).toBe(430);
    expect(result.sales.shareBuzz).toBe(301);
    expect(result.sales.grossBuzz).not.toBe(430 + 60);
    expect(result.sales.shareBuzz).not.toBe(301 + 42);
    // The refunded bucket must not contribute blue either.
    expect(result.sales.blueGrossBuzz).toBe(115);
  });

  it('EXCLUDES pending rows entirely — from both buckets', async () => {
    mockDbRead.blockGoodPurchase.groupBy.mockResolvedValue(THREE_BUCKETS);

    const result = await getGoodsSalesForOwner({ ownerUserId: GOODS_OWNER });

    // `pending` is the reconciliation record for a charge whose outcome is
    // unknown. It is neither money the owner has nor money they are owed, so it
    // must appear nowhere — not as a sale, and not as an exclusion either.
    //
    // 🔴 THE EXACT SUMS ARE WHAT CARRY THIS. The `JSON.stringify` check below
    // catches only a SUBSTITUTION leak: an ADDITIVE one is invisible to it, since
    // 430 + 999 = 1429 contains neither "999" nor "700". So the sums are pinned
    // first, and the stringify is a cheap second net for a pending figure
    // surfacing somewhere nobody thought to assert.
    expect(result.sales.grossBuzz).toBe(430);
    expect(result.sales.shareBuzz).toBe(301);
    expect(result.sales.grossBuzz).not.toBe(430 + 999);
    expect(result.sales.shareBuzz).not.toBe(301 + 700);
    expect(result.refunded.grossBuzz).toBe(60);
    expect(result.refunded.grossBuzz).not.toBe(60 + 999);

    const flat = JSON.stringify(result);
    expect(flat).not.toContain('999');
    expect(flat).not.toContain('888');
    expect(flat).not.toContain('700');

    // Counts: 3 paid + 2 refunded. Pinned separately because their sum (5) equals
    // the pending count, so the total alone could pass for the wrong reason.
    expect(result.sales.count).toBe(3);
    expect(result.refunded.count).toBe(2);
  });

  it('a sub-cent share renders as 0 cents, never rounded up', async () => {
    // The smallest realistic shape: a 10-Buzz good, owner share 7. 7 Buzz is 0.7c.
    mockDbRead.blockGoodPurchase.groupBy.mockResolvedValue([
      {
        status: 'paid',
        _count: 1,
        _sum: { priceBuzz: 10, appOwnerShareBuzz: 7, bluePaidBuzz: 0 },
      },
    ]);

    const result = await getGoodsSalesForOwner({ ownerUserId: GOODS_OWNER });

    // 🔴 The Buzz figure is the one that must be non-zero. This is why the panel
    // leads with Buzz: a cents-only line would read $0.00 for this exact row.
    expect(result.sales.shareBuzz).toBe(7);
    // FLOOR, not round: rounding 0.7c to 1c over-states what the owner earned.
    // This fixture is what kills a `Math.round` mutant — 7 → 0 under floor, 1
    // under round — which the 301-Buzz fixture above cannot see (30 either way).
    expect(result.sales.shareUsdCents).toBe(0);
    // Gross is 1c exactly, so the two differ: a result that copied one field into
    // the other would fail here.
    expect(result.sales.grossUsdCents).toBe(1);
  });

  it('a statusless result (no sales at all) is a measured zero, not a crash', async () => {
    mockDbRead.blockGoodPurchase.groupBy.mockResolvedValue([]);

    const result = await getGoodsSalesForOwner({ ownerUserId: GOODS_OWNER });

    expect(result).toStrictEqual(emptyGoodsSales());
    // A measured zero carries NO discriminator — that is the whole contract the
    // renderer branches on.
    expect('unavailable' in result).toBe(false);
  });

  it('a present bucket with NULL sums falls back to zero rather than NaN', async () => {
    // Prisma returns `null` sums when no row contributes to a group. Nothing else
    // in this file produces that shape, so without this the `?? 0` fallbacks are
    // unexercised and `|| 0` / `!` survive as mutations — and a NaN reaching
    // `buzzSpendToUsdCents` would render "$NaN" on a money page.
    mockDbRead.blockGoodPurchase.groupBy.mockResolvedValue([
      {
        status: 'paid',
        _count: 0,
        _sum: { priceBuzz: null, appOwnerShareBuzz: null, bluePaidBuzz: null },
      },
    ]);

    const result = await getGoodsSalesForOwner({ ownerUserId: GOODS_OWNER });

    expect(result.sales).toStrictEqual({
      count: 0,
      grossBuzz: 0,
      shareBuzz: 0,
      shareUsdCents: 0,
      grossUsdCents: 0,
      blueGrossBuzz: 0,
    });
  });

  it('scopes by owner, app and date range — and dates filter created_at', async () => {
    mockDbRead.blockGoodPurchase.groupBy.mockResolvedValue([]);
    const from = new Date('2026-09-01T00:00:00.000Z');
    const to = new Date('2026-09-30T00:00:00.000Z');

    await getGoodsSalesForOwner({ ownerUserId: GOODS_OWNER, appBlockId: 'apb_goods', from, to });

    const args = mockDbRead.blockGoodPurchase.groupBy.mock.calls[0]?.[0] as {
      by: string[];
      where: Record<string, unknown>;
    };
    expect(args.by).toStrictEqual(['status']);
    // 🔴 `appOwnerUserId` IS the authorization. There is no ownership probe
    // anywhere in this path: a caller asking about an app they do not own gets a
    // zero-row aggregate because of this clause and nothing else. Pinned whole, so
    // dropping or renaming it fails rather than silently widening the read.
    //
    // ⚠️ `toStrictEqual`, NOT `toEqual`. Measured: `toEqual` treats
    // `{a:1, b:undefined}` as equal to `{a:1}`, so the sibling test below could not
    // have caught the clause being passed as an explicit `undefined` — the very
    // thing its comment claimed to pin.
    expect(args.where).toStrictEqual({
      appOwnerUserId: GOODS_OWNER,
      appBlockId: 'apb_goods',
      // `created_at` — this table has no `attributed_at`, because there is no
      // attribution row. A range applied to the wrong column would silently
      // report the wrong period.
      createdAt: { gte: from, lte: to },
    });
  });

  it('omits the app and date clauses when not asked for them', async () => {
    mockDbRead.blockGoodPurchase.groupBy.mockResolvedValue([]);

    await getGoodsSalesForOwner({ ownerUserId: GOODS_OWNER });

    const args = mockDbRead.blockGoodPurchase.groupBy.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    // `toStrictEqual` is load-bearing here: under `toEqual` an `appBlockId:
    // undefined` key compares equal to its absence, so the spread-vs-bare-key
    // mutation this test exists for survived.
    expect(args.where).toStrictEqual({ appOwnerUserId: GOODS_OWNER });
  });

  it('isMissingGoodsTableError matches ONLY a missing table — it fails closed', () => {
    // 🔴 THIS PREDICATE IS WHAT BOUNDS THE ROUTER'S DEGRADATION, so its NEGATIVE
    // cases carry the safety property, not its positive ones. A version that
    // returned true for anything unclassifiable would report every bug in the
    // aggregate to the owner as "sales could not be loaded" — the invisible-revenue
    // defect this change fixes, re-entering through the error path.
    //
    // Positive: the two codes that genuinely mean the table is absent.
    expect(isMissingGoodsTableError({ code: 'P2021' })).toBe(true);
    expect(isMissingGoodsTableError({ code: '42P01' })).toBe(true);
    expect(
      isMissingGoodsTableError(Object.assign(new Error('no such table'), { code: 'P2021' }))
    ).toBe(true);

    // Negative: everything else, including the shapes that are easy to get wrong.
    // A BARE `P2010`/`P2009` — a code with no message naming a missing relation — is
    // not matched: on its own it is an unclassified query failure, and swallowing it
    // would start hiding genuine query bugs. (A `P2010` whose MESSAGE does name the
    // missing relation IS matched; that is the raw-path shape, pinned in the
    // message-path test below.)
    expect(isMissingGoodsTableError({ code: 'P2010' })).toBe(false);
    expect(isMissingGoodsTableError({ code: 'P2009' })).toBe(false);
    expect(isMissingGoodsTableError(new TypeError('cannot read _sum'))).toBe(false);
    // 🔴 THIS ASSERTION USED TO READ `.toBe(false)` FOR A NAMED RELATION, AND THAT
    // PINNED THE DEFECT. The predicate was code-only, so an error carrying the
    // SQLSTATE in its MESSAGE — which Prisma produces on some driver paths — was
    // rejected, the router's `.catch` rethrew, and `Promise.all` 500'd both revenue
    // pages. The message path is now matched; see the dedicated test below for the
    // full direction set, including the column-error nuance it must NOT swallow.
    expect(
      isMissingGoodsTableError(new Error('relation "block_good_purchase" does not exist'))
    ).toBe(true);
    // The relation still has to be NAMED. "relation does not exist" with no object
    // named is not a Postgres message shape, and matching bare prose is how a
    // predicate starts swallowing unrelated failures.
    expect(isMissingGoodsTableError(new Error('relation does not exist'))).toBe(false);
    expect(isMissingGoodsTableError({ code: 42101 })).toBe(false);
    expect(isMissingGoodsTableError(undefined)).toBe(false);
    expect(isMissingGoodsTableError(null)).toBe(false);
    expect(isMissingGoodsTableError('P2021')).toBe(false);
  });

  it('isMissingGoodsTableError matches the MESSAGE path, and still refuses a column error', () => {
    // 🔴 REGRESSION TEST FOR A 500 ON BOTH REVENUE PAGES. The goods predicate used
    // to open-code a code-only check that began `if (!('code' in error)) return
    // false`, so every error below whose SQLSTATE lives only in the message was
    // rejected on the first line. The router catches ONLY this predicate, so a
    // rejection means rethrow → `Promise.all` rejects → `getMyRevenue` 500s → the
    // owner loses the card-purchase figures too, which were readable. It now
    // delegates to `isMissingTableError` in `app-access.service.ts`, whose docblock
    // records the measurement: "a check on P2021 alone let a raw-path failure
    // through in local testing".
    //
    // Prisma wraps the driver error and leaves `code` unclassified on some paths, so
    // these are the shapes that actually reach the catch.
    expect(
      isMissingGoodsTableError(new Error('relation "block_good_purchase" does not exist'))
    ).toBe(true);
    expect(isMissingGoodsTableError(new Error('table "block_good_purchase" does not exist'))).toBe(
      true
    );
    expect(
      isMissingGoodsTableError(
        new Error('ERROR: relation "block_good_purchase" does not exist (SQLSTATE 42P01)')
      )
    ).toBe(true);
    // The raw-query wrap: a `P2010` code whose message carries both the SQLSTATE and
    // the named relation. The table is genuinely absent here, so degrading is right.
    expect(
      isMissingGoodsTableError(
        Object.assign(
          new Error(
            'Raw query failed. Code: `42P01`. Message: `relation "block_good_purchase" does not exist`'
          ),
          { code: 'P2010' }
        )
      )
    ).toBe(true);

    // 🔴 AND THE NUANCE THAT MUST SURVIVE THE WIDENING: a COLUMN error is a
    // HALF-APPLIED manual migration, not an absent table — and this repo applies the
    // goods migration BY HAND per environment, so it is the likely half-failure.
    // Swallowing it would degrade a genuinely broken schema to a permanent, polite
    // "sales could not be loaded" — the invisible-revenue defect this rail's bounded
    // catch exists to prevent. The substring "does not exist" appears in both, which
    // is exactly why the shared predicate refuses any message mentioning a column.
    expect(
      isMissingGoodsTableError(
        new Error('column "x" of relation "block_good_purchase" does not exist')
      )
    ).toBe(false);
    expect(isMissingGoodsTableError(new Error('column "displayed" does not exist'))).toBe(false);
  });

  it('the UNREADABLE bucket is zeros PLUS a discriminator, never bare zeros', async () => {
    // 🔴 `block_good_purchase` is applied by hand per environment, so the read can
    // fail against a database that lacks it. The router catches that and returns
    // this shape. It must be distinguishable from a genuine zero, or the page
    // reports "no sales" for a rail nobody read — the fabricated zero the
    // payload-level discriminator exists to prevent.
    const unreadable = unreadableGoodsSales();
    const measured = emptyGoodsSales();

    // Precondition: the figures really are identical, so nothing but the
    // discriminator could tell them apart. If this ever fails, the test below has
    // stopped proving what it claims.
    expect(unreadable.sales).toStrictEqual(measured.sales);
    expect(unreadable.refunded).toStrictEqual(measured.refunded);

    expect(unreadable.unavailable).toBe('unreadable');
    expect('unavailable' in measured).toBe(false);
  });
});
