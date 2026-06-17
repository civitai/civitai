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
    blockBuzzAttribution: { findUnique: vi.fn() },
  },
  mockDbWrite: {
    blockBuzzAttribution: {
      create: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
    },
    blockAttributionPayout: {
      create: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    // Per-owner advisory lock taken at the top of mintPayoutForOwner's txn.
    // No-op in the unit harness (no real DB / concurrency) — the lock's
    // serialization behavior needs an integration test (noted in the PR).
    $executeRaw: vi.fn().mockResolvedValue(0),
    // Interactive transaction: run the callback against the same mock
    // (no real isolation needed in these unit tests).
    $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(mockDbWrite)),
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
  mintPayoutForOwner,
  recordAttribution,
  REFUND_WINDOWS_DAYS,
  revertPayoutMint,
  voidAttributionsForPayment,
} from '../buzz-attribution.service';
import type { BlockAttribution } from '~/server/schema/blocks/attribution.schema';

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
  mockDbWrite.blockBuzzAttribution.aggregate.mockReset();
  mockDbWrite.blockAttributionPayout.create.mockReset();
  mockDbWrite.blockAttributionPayout.findUnique.mockReset();
  mockDbWrite.blockAttributionPayout.delete.mockReset();
  mockDbWrite.$executeRaw.mockClear();
  mockDbWrite.$executeRaw.mockResolvedValue(0);
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
  mockDbWrite.blockBuzzAttribution.create.mockImplementation(
    async ({ data, select }: any) => {
      // Clawback writes (voidAttributionsForPayment) pass no `select` —
      // just echo the row back. recordAttribution passes a select subset.
      if (!select) return { ...data };
      const result: any = {};
      for (const k of Object.keys(select)) result[k] = data[k] ?? null;
      return result;
    }
  );
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
    // net 950 * 15% (v2 per_model_install) = 142.5 → floor 142
    expect(dataArg.appOwnerShareCents).toBe(142);
    expect(dataArg.platformShareCents).toBe(808);
    expect(
      dataArg.providerFeeCents + dataArg.platformShareCents + dataArg.appOwnerShareCents
    ).toBe(1000);
    expect(dataArg.rateCardVersion).toBe('v2');
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

describe('mintPayoutForOwner', () => {
  const PERIOD = '2026-W22';

  it('mints, writes the ledger, and flips rows when net is positive', async () => {
    mockDbWrite.blockBuzzAttribution.aggregate.mockResolvedValueOnce({
      _sum: { appOwnerShareCents: 1500 },
      _count: 7,
    });
    mockDbWrite.blockAttributionPayout.create.mockResolvedValueOnce({});
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 7 });

    const result = await mintPayoutForOwner({
      appOwnerUserId: APP_OWNER_USER_ID,
      periodKey: PERIOD,
    });

    expect(result).toMatchObject({
      minted: true,
      totalCents: 1500,
      rowCount: 7,
    });
    if (result.minted) expect(result.payoutId).toMatch(/^bba_payout_/);

    // Ledger row written with the right shape.
    const ledger = mockDbWrite.blockAttributionPayout.create.mock.calls[0][0].data;
    expect(ledger.appOwnerUserId).toBe(APP_OWNER_USER_ID);
    expect(ledger.periodKey).toBe(PERIOD);
    expect(ledger.totalCents).toBe(1500);
    expect(ledger.rowCount).toBe(7);
    expect(ledger.id).toMatch(/^bba_payout_/);

    // Contributing confirmed rows flipped to paid_out with the payout id.
    const flip = mockDbWrite.blockBuzzAttribution.updateMany.mock.calls[0][0];
    expect(flip.where).toEqual({ appOwnerUserId: APP_OWNER_USER_ID, status: 'confirmed' });
    expect(flip.data.status).toBe('paid_out');
    expect(flip.data.payoutId).toBe(ledger.id);
    expect(flip.data.paidOutAt).toBeInstanceOf(Date);
  });

  it('takes a per-owner advisory lock at the top of the txn (serializes concurrent mints)', async () => {
    mockDbWrite.blockBuzzAttribution.aggregate.mockResolvedValueOnce({
      _sum: { appOwnerShareCents: 1500 },
      _count: 7,
    });
    mockDbWrite.blockAttributionPayout.create.mockResolvedValueOnce({});
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 7 });

    await mintPayoutForOwner({ appOwnerUserId: APP_OWNER_USER_ID, periodKey: PERIOD });

    // The advisory lock is acquired (the $executeRaw call) BEFORE the aggregate.
    expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockDbWrite.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockDbWrite.blockBuzzAttribution.aggregate.mock.invocationCallOrder[0]
    );
  });

  it('the LOSING concurrent attempt re-aggregates net 0 → minted:false (no double-claim)', async () => {
    // Models the loser: after the winner committed (rows already paid_out), the
    // loser acquires the lock, re-aggregates confirmed rows, sees 0 → carries
    // forward without minting or flipping. This is the property the advisory
    // lock guarantees in prod; here we assert the net<=0 branch handles it.
    mockDbWrite.blockBuzzAttribution.aggregate.mockResolvedValueOnce({
      _sum: { appOwnerShareCents: 0 },
      _count: 0,
    });

    const result = await mintPayoutForOwner({
      appOwnerUserId: APP_OWNER_USER_ID,
      periodKey: PERIOD,
    });

    expect(result).toEqual({ minted: false, carriedForwardCents: 0, rowCount: 0 });
    expect(mockDbWrite.blockAttributionPayout.create).not.toHaveBeenCalled();
    expect(mockDbWrite.blockBuzzAttribution.updateMany).not.toHaveBeenCalled();
  });

  it('DEFENSE-IN-DEPTH: a 0-flip after a positive aggregate deletes the ledger row and returns minted:false', async () => {
    // Aggregate saw a positive net and minted a ledger row, but the flip
    // somehow touched 0 rows (would be a double-pay if reported payable). The
    // guard must delete the just-created ledger row and return not-minted.
    mockDbWrite.blockBuzzAttribution.aggregate.mockResolvedValueOnce({
      _sum: { appOwnerShareCents: 1500 },
      _count: 7,
    });
    mockDbWrite.blockAttributionPayout.create.mockResolvedValueOnce({});
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 0 });
    mockDbWrite.blockAttributionPayout.delete.mockResolvedValueOnce({});

    const result = await mintPayoutForOwner({
      appOwnerUserId: APP_OWNER_USER_ID,
      periodKey: PERIOD,
    });

    expect(result).toEqual({ minted: false, carriedForwardCents: 0, rowCount: 0 });
    // The ledger row created moments earlier was deleted in the same txn.
    expect(mockDbWrite.blockAttributionPayout.delete).toHaveBeenCalledWith({
      where: { id: expect.stringMatching(/^bba_payout_/) },
    });
  });

  it('is idempotent on P2002 — no second flip, no throw', async () => {
    mockDbWrite.blockBuzzAttribution.aggregate.mockResolvedValueOnce({
      _sum: { appOwnerShareCents: 1500 },
      _count: 7,
    });
    mockDbWrite.blockAttributionPayout.create.mockRejectedValueOnce(
      new FakePrismaKnownError('Unique constraint failed', 'P2002')
    );

    const result = await mintPayoutForOwner({
      appOwnerUserId: APP_OWNER_USER_ID,
      periodKey: PERIOD,
    });

    expect(result).toEqual({ minted: false, alreadyPaid: true });
    // The contributing rows were NOT flipped a second time.
    expect(mockDbWrite.blockBuzzAttribution.updateMany).not.toHaveBeenCalled();
  });

  it('carries forward (no mint, no flip) when net <= 0', async () => {
    mockDbWrite.blockBuzzAttribution.aggregate.mockResolvedValueOnce({
      _sum: { appOwnerShareCents: -200 },
      _count: 3,
    });

    const result = await mintPayoutForOwner({
      appOwnerUserId: APP_OWNER_USER_ID,
      periodKey: PERIOD,
    });

    expect(result).toEqual({ minted: false, carriedForwardCents: -200, rowCount: 3 });
    expect(mockDbWrite.blockAttributionPayout.create).not.toHaveBeenCalled();
    expect(mockDbWrite.blockBuzzAttribution.updateMany).not.toHaveBeenCalled();
  });

  it('carries forward when net is exactly zero', async () => {
    mockDbWrite.blockBuzzAttribution.aggregate.mockResolvedValueOnce({
      _sum: { appOwnerShareCents: 0 },
      _count: 4,
    });
    const result = await mintPayoutForOwner({
      appOwnerUserId: APP_OWNER_USER_ID,
      periodKey: PERIOD,
    });
    expect(result).toEqual({ minted: false, carriedForwardCents: 0, rowCount: 4 });
    expect(mockDbWrite.blockAttributionPayout.create).not.toHaveBeenCalled();
  });

  it('nets negative clawbacks against positives in the aggregate net', async () => {
    // The aggregate sums confirmed rows; the service trusts the DB sum
    // (positives + negative clawbacks). Here the net comes back at 800
    // (e.g. 1000 positive - 200 clawback) and is minted as such.
    mockDbWrite.blockBuzzAttribution.aggregate.mockResolvedValueOnce({
      _sum: { appOwnerShareCents: 800 },
      _count: 5,
    });
    mockDbWrite.blockAttributionPayout.create.mockResolvedValueOnce({});
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 5 });

    const result = await mintPayoutForOwner({
      appOwnerUserId: APP_OWNER_USER_ID,
      periodKey: PERIOD,
    });

    expect(result).toMatchObject({ minted: true, totalCents: 800, rowCount: 5 });
    const ledger = mockDbWrite.blockAttributionPayout.create.mock.calls[0][0].data;
    expect(ledger.totalCents).toBe(800);
    // The aggregate query only ever reads confirmed rows.
    const aggWhere = mockDbWrite.blockBuzzAttribution.aggregate.mock.calls[0][0].where;
    expect(aggWhere).toEqual({ appOwnerUserId: APP_OWNER_USER_ID, status: 'confirmed' });
  });
});

describe('revertPayoutMint', () => {
  const PAYOUT_ID = 'bba_payout_TEST';

  it('un-flips paid_out rows → confirmed and deletes the ledger row', async () => {
    mockDbWrite.blockAttributionPayout.findUnique.mockResolvedValueOnce({
      id: PAYOUT_ID,
      appOwnerUserId: APP_OWNER_USER_ID,
    });
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 4 });
    mockDbWrite.blockAttributionPayout.delete.mockResolvedValueOnce({});

    const result = await revertPayoutMint({
      payoutId: PAYOUT_ID,
      appOwnerUserId: APP_OWNER_USER_ID,
    });

    expect(result).toEqual({ reverted: 4, ledgerDeleted: true });

    // Rows un-flipped: scoped by payoutId, paid_out → confirmed, linkage cleared.
    const flip = mockDbWrite.blockBuzzAttribution.updateMany.mock.calls[0][0];
    expect(flip.where).toEqual({ payoutId: PAYOUT_ID, status: 'paid_out' });
    expect(flip.data).toEqual({ status: 'confirmed', paidOutAt: null, payoutId: null });

    // Ledger row deleted by id.
    expect(mockDbWrite.blockAttributionPayout.delete).toHaveBeenCalledWith({
      where: { id: PAYOUT_ID },
    });
  });

  it('is idempotent when the ledger row is already gone (un-flips stragglers, no delete)', async () => {
    mockDbWrite.blockAttributionPayout.findUnique.mockResolvedValueOnce(null);
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await revertPayoutMint({
      payoutId: PAYOUT_ID,
      appOwnerUserId: APP_OWNER_USER_ID,
    });

    expect(result).toEqual({ reverted: 0, ledgerDeleted: false });
    expect(mockDbWrite.blockAttributionPayout.delete).not.toHaveBeenCalled();
  });

  it('refuses to revert a payout that belongs to a different owner', async () => {
    mockDbWrite.blockAttributionPayout.findUnique.mockResolvedValueOnce({
      id: PAYOUT_ID,
      appOwnerUserId: 12345, // not APP_OWNER_USER_ID
    });

    await expect(
      revertPayoutMint({ payoutId: PAYOUT_ID, appOwnerUserId: APP_OWNER_USER_ID })
    ).rejects.toThrow(/owner/);

    // Nothing touched on a foreign payout.
    expect(mockDbWrite.blockBuzzAttribution.updateMany).not.toHaveBeenCalled();
    expect(mockDbWrite.blockAttributionPayout.delete).not.toHaveBeenCalled();
  });
});

describe('REFUND_WINDOWS_DAYS', () => {
  it('exposes the per-provider refund windows', () => {
    expect(REFUND_WINDOWS_DAYS.stripe).toBeGreaterThan(REFUND_WINDOWS_DAYS.paddle);
    expect(REFUND_WINDOWS_DAYS.paddle).toBeGreaterThan(REFUND_WINDOWS_DAYS.nowpayments);
  });
});
